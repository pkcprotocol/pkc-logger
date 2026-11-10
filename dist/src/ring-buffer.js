export const DEFAULT_QUERY_LIMIT = 1000;
export const MAX_QUERY_LIMIT = 10000;
export const INVALID_LOG_QUERY_CODE = "ERR_INVALID_LOG_QUERY";
export class InvalidLogQueryError extends Error {
    constructor(message) {
        super(message);
        this.code = INVALID_LOG_QUERY_CODE;
        this.name = "InvalidLogQueryError";
    }
}
// Rough per-entry overhead (seq, time, level, array headers) on top of the strings' code units.
const ENTRY_FIXED_COST = 64;
export function entryCost(entry) {
    let cost = ENTRY_FIXED_COST + entry.msg.length + entry.namespace.length;
    for (const key of Object.keys(entry.tags))
        cost += key.length + entry.tags[key].length;
    return cost;
}
function isNonNegativeInt(v) {
    return typeof v === "number" && Number.isInteger(v) && v >= 0;
}
/**
 * Copies a tag record, reading each value once, so what was validated is what gets used. Returns undefined
 * unless `value` is a plain object whose keys and values are non-empty strings. With `dropUndefined` a key
 * whose value is undefined is left out (a logger's tags); a query passes false, because dropping a filter
 * would silently widen it to the whole buffer.
 */
export function copyTagRecord(value, dropUndefined) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return undefined;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null)
        return undefined; // a Map, a Date, a class instance...
    const out = {};
    for (const key of Object.keys(value)) {
        if (key.length === 0)
            return undefined;
        const v = value[key];
        if (v === undefined && dropUndefined)
            continue;
        if (typeof v !== "string" || v.length === 0)
            return undefined;
        defineTag(out, key, v);
    }
    return out;
}
/** Sets an own property even for a key like `__proto__`, which plain assignment would treat as the prototype. */
export function defineTag(record, key, value) {
    Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
}
/** Validates a query and compiles its regex. Throws InvalidLogQueryError (code ERR_INVALID_LOG_QUERY). */
export function normalizeQuery(query) {
    const q = query === undefined ? {} : query;
    if (typeof q !== "object" || q === null || Array.isArray(q))
        throw new InvalidLogQueryError("query must be an object");
    const known = new Set(["tags", "regex", "since", "until", "limit", "cursor", "order"]);
    for (const k of Object.keys(q))
        if (!known.has(k))
            throw new InvalidLogQueryError(`unknown query field '${k}'`);
    // Defaults apply only to omitted fields; an explicit null is a malformed query, not "no filter".
    // Copied once, then matched from the copy, so the caller's record is never read again.
    const tagRecord = q.tags === undefined ? {} : copyTagRecord(q.tags, false);
    if (!tagRecord)
        throw new InvalidLogQueryError("tags must be a record of non-empty strings, such as { cid: '...' }");
    const tags = Object.entries(tagRecord);
    let regex;
    if (q.regex !== undefined) {
        if (typeof q.regex !== "object" || q.regex === null || typeof q.regex.source !== "string")
            throw new InvalidLogQueryError("regex must be { source: string, flags?: string }");
        if (q.regex.flags !== undefined && typeof q.regex.flags !== "string")
            throw new InvalidLogQueryError("regex.flags must be a string");
        try {
            // Flags are kept as given; matching resets lastIndex, so g and y carry no state between entries.
            regex = new RegExp(q.regex.source, q.regex.flags ?? "");
        }
        catch (e) {
            throw new InvalidLogQueryError(`invalid regex: ${e.message}`);
        }
    }
    for (const field of ["since", "until"]) {
        const v = q[field];
        if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v)))
            throw new InvalidLogQueryError(`${field} must be a finite number`);
    }
    if (q.since !== undefined && q.until !== undefined && q.since > q.until)
        throw new InvalidLogQueryError("since must be <= until");
    let limit = q.limit === undefined ? DEFAULT_QUERY_LIMIT : q.limit;
    if (!isNonNegativeInt(limit) || limit === 0)
        throw new InvalidLogQueryError("limit must be a positive integer");
    if (limit > MAX_QUERY_LIMIT)
        limit = MAX_QUERY_LIMIT;
    if (q.cursor !== undefined && !isNonNegativeInt(q.cursor))
        throw new InvalidLogQueryError("cursor must be a non-negative integer");
    const order = q.order === undefined ? "asc" : q.order;
    if (order !== "asc" && order !== "desc")
        throw new InvalidLogQueryError("order must be 'asc' or 'desc'");
    return { tags, regex, since: q.since, until: q.until, limit, cursor: q.cursor, order };
}
/**
 * Byte-bounded FIFO of entries. "Bytes" is approximated by UTF-16 code units of the strings plus a fixed
 * per-entry cost, which keeps the accounting O(1) and platform-independent. Newest entries evict oldest.
 * maxBytes 0 disables capture entirely (push is a no-op).
 */
export class LogRingBuffer {
    constructor(maxBytes) {
        this.maxBytes = maxBytes;
        this.entries = [];
        this.head = 0; // index of the oldest live entry in `entries`
        this.bytes = 0;
        this.nextSeq = 0;
        if (!isNonNegativeInt(maxBytes))
            throw new Error("buffer.maxBytes must be a non-negative integer");
    }
    get size() {
        return this.entries.length - this.head;
    }
    get byteSize() {
        return this.bytes;
    }
    /** Allocates the next seq without storing anything (used when capture is disabled, so cursors stay monotonic). */
    allocateSeq() {
        return this.nextSeq++;
    }
    push(entry) {
        const full = Object.freeze({ seq: this.nextSeq++, ...entry });
        if (this.maxBytes === 0)
            return full;
        const cost = entryCost(full);
        if (cost > this.maxBytes)
            return full; // never fits; drop rather than evict everything for it
        this.entries.push(full);
        this.bytes += cost;
        while (this.bytes > this.maxBytes) {
            this.bytes -= entryCost(this.entries[this.head]);
            // Release the evicted entry now; compaction only runs once the dead prefix is large.
            this.entries[this.head] = undefined;
            this.head++;
        }
        // Compact once the dead prefix dominates, so memory tracks the live window not the push count.
        if (this.head > 1024 && this.head * 2 > this.entries.length) {
            this.entries = this.entries.slice(this.head);
            this.head = 0;
        }
        return full;
    }
    clear() {
        this.entries = [];
        this.head = 0;
        this.bytes = 0;
    }
    query(query) {
        const q = normalizeQuery(query);
        const matches = (e) => {
            if (q.since !== undefined && e.time < q.since)
                return false;
            if (q.until !== undefined && e.time > q.until)
                return false;
            // An entry's tags are own properties holding strings, so an inherited name can never equal `value`.
            for (const [key, value] of q.tags)
                if (e.tags[key] !== value)
                    return false;
            if (q.regex) {
                q.regex.lastIndex = 0;
                if (!q.regex.test(`${e.namespace} ${e.msg}`))
                    return false;
            }
            return true;
        };
        const out = [];
        if (q.order === "asc") {
            for (let i = this.head; i < this.entries.length && out.length < q.limit; i++) {
                const e = this.entries[i];
                if (q.cursor !== undefined && e.seq <= q.cursor)
                    continue;
                if (matches(e))
                    out.push(e);
            }
        }
        else {
            for (let i = this.entries.length - 1; i >= this.head && out.length < q.limit; i--) {
                const e = this.entries[i];
                if (q.cursor !== undefined && e.seq >= q.cursor)
                    continue;
                if (matches(e))
                    out.push(e);
            }
        }
        return out.length > 0 ? { entries: out, nextCursor: out[out.length - 1].seq } : { entries: out };
    }
}
