export type LogLevel = "log" | "error" | "trace";

/** Entries are frozen: the same object is buffered and handed to every listener and query caller. */
export interface LogEntry {
    /** Monotonic per-root sequence number; the query cursor. */
    readonly seq: number;
    /** Unix epoch milliseconds. */
    readonly time: number;
    readonly level: LogLevel;
    readonly namespace: string;
    /** Formatted message, color-free, capped (see format.ts). */
    readonly msg: string;
    /** Identifier tags accumulated down the child chain, deduplicated. */
    readonly tags: readonly string[];
}

export interface LogQuery {
    /** Every listed tag must be present on the entry (AND). */
    tags?: string[];
    /** Tested against `namespace + " " + msg`. */
    regex?: { source: string; flags?: string };
    /** Inclusive lower bound on `time`. */
    since?: number;
    /** Inclusive upper bound on `time`. */
    until?: number;
    /** Max entries returned. Default 1000, hard cap 10000. */
    limit?: number;
    /** Resume after this seq (asc) or before it (desc). */
    cursor?: number;
    /** Default "asc". */
    order?: "asc" | "desc";
}

export interface LogQueryResult {
    entries: LogEntry[];
    /** `seq` of the last returned entry, to pass as `cursor` on the next call. Absent when nothing matched. */
    nextCursor?: number;
}

export const DEFAULT_QUERY_LIMIT = 1000;
export const MAX_QUERY_LIMIT = 10000;
export const INVALID_LOG_QUERY_CODE = "ERR_INVALID_LOG_QUERY";

export class InvalidLogQueryError extends Error {
    code = INVALID_LOG_QUERY_CODE;
    constructor(message: string) {
        super(message);
        this.name = "InvalidLogQueryError";
    }
}

// Rough per-entry overhead (seq, time, level, array headers) on top of the strings' code units.
const ENTRY_FIXED_COST = 64;

export function entryCost(entry: LogEntry): number {
    let cost = ENTRY_FIXED_COST + entry.msg.length + entry.namespace.length;
    for (const t of entry.tags) cost += t.length;
    return cost;
}

function isNonNegativeInt(v: unknown): v is number {
    return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/** Validates a query and compiles its regex. Throws InvalidLogQueryError (code ERR_INVALID_LOG_QUERY). */
export function normalizeQuery(query: LogQuery | undefined): Required<Pick<LogQuery, "limit" | "order">> & {
    tags: string[];
    regex?: RegExp;
    since?: number;
    until?: number;
    cursor?: number;
} {
    const q = query ?? {};
    if (typeof q !== "object" || q === null || Array.isArray(q)) throw new InvalidLogQueryError("query must be an object");
    const known = new Set(["tags", "regex", "since", "until", "limit", "cursor", "order"]);
    for (const k of Object.keys(q)) if (!known.has(k)) throw new InvalidLogQueryError(`unknown query field '${k}'`);

    const tags = q.tags ?? [];
    if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string" || t.length === 0))
        throw new InvalidLogQueryError("tags must be an array of non-empty strings");

    let regex: RegExp | undefined;
    if (q.regex !== undefined) {
        if (typeof q.regex !== "object" || q.regex === null || typeof q.regex.source !== "string")
            throw new InvalidLogQueryError("regex must be { source: string, flags?: string }");
        if (q.regex.flags !== undefined && typeof q.regex.flags !== "string") throw new InvalidLogQueryError("regex.flags must be a string");
        // A sticky or global regex carries lastIndex state across .test() calls; strip them so matching is stateless.
        const flags = (q.regex.flags ?? "").replace(/[gy]/g, "");
        try {
            regex = new RegExp(q.regex.source, flags);
        } catch (e) {
            throw new InvalidLogQueryError(`invalid regex: ${(e as Error).message}`);
        }
    }

    for (const field of ["since", "until"] as const) {
        const v = q[field];
        if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) throw new InvalidLogQueryError(`${field} must be a finite number`);
    }
    if (q.since !== undefined && q.until !== undefined && q.since > q.until) throw new InvalidLogQueryError("since must be <= until");

    let limit = q.limit ?? DEFAULT_QUERY_LIMIT;
    if (!isNonNegativeInt(limit) || limit === 0) throw new InvalidLogQueryError("limit must be a positive integer");
    if (limit > MAX_QUERY_LIMIT) limit = MAX_QUERY_LIMIT;

    if (q.cursor !== undefined && !isNonNegativeInt(q.cursor)) throw new InvalidLogQueryError("cursor must be a non-negative integer");

    const order = q.order ?? "asc";
    if (order !== "asc" && order !== "desc") throw new InvalidLogQueryError("order must be 'asc' or 'desc'");

    return { tags, regex, since: q.since, until: q.until, limit, cursor: q.cursor, order };
}

/**
 * Byte-bounded FIFO of entries. "Bytes" is approximated by UTF-16 code units of the strings plus a fixed
 * per-entry cost, which keeps the accounting O(1) and platform-independent. Newest entries evict oldest.
 * maxBytes 0 disables capture entirely (push is a no-op).
 */
export class LogRingBuffer {
    private entries: LogEntry[] = [];
    private head = 0; // index of the oldest live entry in `entries`
    private bytes = 0;
    private nextSeq = 0;

    constructor(public readonly maxBytes: number) {
        if (!isNonNegativeInt(maxBytes)) throw new Error("buffer.maxBytes must be a non-negative integer");
    }

    get size(): number {
        return this.entries.length - this.head;
    }

    get byteSize(): number {
        return this.bytes;
    }

    /** Allocates the next seq without storing anything (used when capture is disabled, so cursors stay monotonic). */
    allocateSeq(): number {
        return this.nextSeq++;
    }

    push(entry: Omit<LogEntry, "seq">): LogEntry {
        const full: LogEntry = Object.freeze({ seq: this.nextSeq++, ...entry });
        if (this.maxBytes === 0) return full;
        const cost = entryCost(full);
        if (cost > this.maxBytes) return full; // never fits; drop rather than evict everything for it
        this.entries.push(full);
        this.bytes += cost;
        while (this.bytes > this.maxBytes) {
            this.bytes -= entryCost(this.entries[this.head]!);
            // Release the evicted entry now; compaction only runs once the dead prefix is large.
            this.entries[this.head] = undefined as unknown as LogEntry;
            this.head++;
        }
        // Compact once the dead prefix dominates, so memory tracks the live window not the push count.
        if (this.head > 1024 && this.head * 2 > this.entries.length) {
            this.entries = this.entries.slice(this.head);
            this.head = 0;
        }
        return full;
    }

    clear(): void {
        this.entries = [];
        this.head = 0;
        this.bytes = 0;
    }

    query(query?: LogQuery): LogQueryResult {
        const q = normalizeQuery(query);
        const matches = (e: LogEntry): boolean => {
            if (q.since !== undefined && e.time < q.since) return false;
            if (q.until !== undefined && e.time > q.until) return false;
            for (const t of q.tags) if (!e.tags.includes(t)) return false;
            if (q.regex && !q.regex.test(`${e.namespace} ${e.msg}`)) return false;
            return true;
        };
        const out: LogEntry[] = [];
        if (q.order === "asc") {
            for (let i = this.head; i < this.entries.length && out.length < q.limit; i++) {
                const e = this.entries[i]!;
                if (q.cursor !== undefined && e.seq <= q.cursor) continue;
                if (matches(e)) out.push(e);
            }
        } else {
            for (let i = this.entries.length - 1; i >= this.head && out.length < q.limit; i--) {
                const e = this.entries[i]!;
                if (q.cursor !== undefined && e.seq >= q.cursor) continue;
                if (matches(e)) out.push(e);
            }
        }
        return out.length > 0 ? { entries: out, nextCursor: out[out.length - 1]!.seq } : { entries: out };
    }
}
