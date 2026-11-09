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
    /**
     * Tested against `namespace + " " + msg`. Trusted input: a backtracking pattern such as `(a+)+$` runs
     * synchronously and can block the process, so never accept one from an untrusted source.
     */
    regex?: {
        source: string;
        flags?: string;
    };
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
export declare const DEFAULT_QUERY_LIMIT = 1000;
export declare const MAX_QUERY_LIMIT = 10000;
export declare const INVALID_LOG_QUERY_CODE = "ERR_INVALID_LOG_QUERY";
export declare class InvalidLogQueryError extends Error {
    code: string;
    constructor(message: string);
}
export declare function entryCost(entry: LogEntry): number;
/** Validates a query and compiles its regex. Throws InvalidLogQueryError (code ERR_INVALID_LOG_QUERY). */
/** An array of non-empty strings with no holes (`some` and `every` skip holes, so index every position). */
export declare function isTagArray(value: unknown): value is string[];
export declare function normalizeQuery(query: LogQuery | undefined): Required<Pick<LogQuery, "limit" | "order">> & {
    tags: string[];
    regex?: RegExp;
    since?: number;
    until?: number;
    cursor?: number;
};
/**
 * Byte-bounded FIFO of entries. "Bytes" is approximated by UTF-16 code units of the strings plus a fixed
 * per-entry cost, which keeps the accounting O(1) and platform-independent. Newest entries evict oldest.
 * maxBytes 0 disables capture entirely (push is a no-op).
 */
export declare class LogRingBuffer {
    readonly maxBytes: number;
    private entries;
    private head;
    private bytes;
    private nextSeq;
    constructor(maxBytes: number);
    get size(): number;
    get byteSize(): number;
    /** Allocates the next seq without storing anything (used when capture is disabled, so cursors stay monotonic). */
    allocateSeq(): number;
    push(entry: Omit<LogEntry, "seq">): LogEntry;
    clear(): void;
    query(query?: LogQuery): LogQueryResult;
}
