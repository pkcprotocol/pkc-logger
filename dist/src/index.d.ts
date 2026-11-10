import { formatLogArgs } from "./format.js";
import { InvalidLogQueryError, INVALID_LOG_QUERY_CODE, DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT } from "./ring-buffer.js";
import type { LogEntry, LogLevel, LogQuery, LogQueryResult, Tags } from "./ring-buffer.js";
export type { LogEntry, LogLevel, LogQuery, LogQueryResult, Tags };
export { InvalidLogQueryError, INVALID_LOG_QUERY_CODE, DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT, formatLogArgs };
export type { FormatOptions } from "./format.js";
export declare const DEFAULT_BUFFER_MAX_BYTES: number;
/** Tags as a caller passes them: a key whose value is undefined is dropped, so optional fields need no branching. */
export type TagsInput = Record<string, string | undefined>;
/** A returned promise is awaited for rejection only, so an async sink that fails cannot crash the process. */
export type LogListener = (entry: LogEntry) => unknown;
export interface ChildOptions {
    /** Appended to the parent's namespace with a colon; absolute when the parent has none. */
    namespace?: string;
    /** This logger's own identifier tags (cid, publicKey, signature...), merged over its ancestors'. */
    tags?: TagsInput;
    /** `false` keeps this logger's entries (and its descendants') out of listeners; they still go to the buffer and `debug`.
     * Use it for logging from inside a listener. A descendant cannot turn delivery back on. */
    listeners?: boolean;
}
export interface CreateLoggerOptions extends ChildOptions {
    /** `maxBytes` bounds the root's in-memory buffer. Default 4 MiB; 0 disables capture. */
    buffer?: {
        maxBytes?: number;
    };
}
export interface Logger {
    (...args: unknown[]): void;
    error: (...args: unknown[]) => void;
    trace: (...args: unknown[]) => void;
    readonly namespace: string | undefined;
    /**
     * Effective tags: every ancestor's merged, then this logger's own, so a key set here shadows an ancestor's.
     * Live: it reflects the latest `setTags` on this logger and on any ancestor. The returned record is frozen.
     */
    readonly tags: Tags;
    /**
     * Replaces this logger's OWN tags (it does not merge). Ancestors are untouched; this logger and every
     * descendant, including ones created before the call, use the new tags from their next line. Pass the whole
     * record built from your own fields, never a spread of `logger.tags`, which would copy ancestor keys down.
     */
    setTags(tags: TagsInput): void;
    child(options: ChildOptions): Logger;
    /** Queries the root's buffer. Throws InvalidLogQueryError (code ERR_INVALID_LOG_QUERY) on a bad query. */
    getLogs(query?: LogQuery): LogQueryResult;
    /**
     * Receives the root's enabled entries, including entries the buffer does not keep, except: entries from loggers
     * created with `listeners: false`, listener-error reports, and entries the listener itself logs while it runs.
     * A listener added during a delivery starts with the next entry. Returns the unsubscribe function.
     */
    addListener(listener: LogListener): () => void;
    removeListener(listener: LogListener): void;
}
/** Creates a root logger with its own buffer and listener set. */
export declare function createLogger(options?: CreateLoggerOptions): Logger;
/** A child of the process-default root. `namespace` is required. */
declare function Logger(options: ChildOptions & {
    namespace: string;
}): Logger;
declare namespace Logger {
    const disable: () => void;
    const enable: (namespaces: string) => void;
    const enabled: (namespaces: string) => boolean;
    /** Listener on the process-default root. */
    const addListener: (listener: LogListener) => (() => void);
    const removeListener: (listener: LogListener) => void;
}
export default Logger;
