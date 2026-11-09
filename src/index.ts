import Debug from "debug";
import { formatLogArgs } from "./format.js";
import { LogRingBuffer, InvalidLogQueryError, INVALID_LOG_QUERY_CODE, DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT } from "./ring-buffer.js";
import type { LogEntry, LogLevel, LogQuery, LogQueryResult } from "./ring-buffer.js";

export type { LogEntry, LogLevel, LogQuery, LogQueryResult };
export { InvalidLogQueryError, INVALID_LOG_QUERY_CODE, DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT, formatLogArgs };
export type { FormatOptions } from "./format.js";

export const DEFAULT_BUFFER_MAX_BYTES = 4 * 1024 * 1024;

/** A returned promise is awaited for rejection only, so an async sink that fails cannot crash the process. */
export type LogListener = (entry: LogEntry) => unknown;

export interface ChildOptions {
    /** Appended to the parent's namespace with a colon; absolute when the parent has none. */
    namespace?: string;
    /** Identifier tags (cid, publicKey, signature...) added to the parent's. */
    tags?: string[];
}

export interface CreateLoggerOptions extends ChildOptions {
    /** `maxBytes` bounds the root's in-memory buffer. Default 4 MiB; 0 disables capture. */
    buffer?: { maxBytes?: number };
}

export interface Logger {
    (...args: unknown[]): void;
    error: (...args: unknown[]) => void;
    trace: (...args: unknown[]) => void;
    readonly namespace: string | undefined;
    readonly tags: readonly string[];
    child(options: ChildOptions): Logger;
    /** Queries the root's buffer. Throws InvalidLogQueryError (code ERR_INVALID_LOG_QUERY) on a bad query. */
    getLogs(query?: LogQuery): LogQueryResult;
    /** Receives every captured entry of the root. Returns the unsubscribe function. */
    addListener(listener: LogListener): () => void;
    removeListener(listener: LogListener): void;
}

interface RootState {
    buffer: LogRingBuffer;
    listeners: Set<LogListener>;
}

// `debug` instances are stateless apart from their namespace, so one per namespace process-wide is enough
// (pkc-js's update cycle asks for a logger per comment on hot paths; issue pkc-js#351).
// The cache is never evicted, so namespaces must stay low-cardinality: put per-object identifiers (cid,
// publicKey...) in tags, never in the namespace. pkc-js uses ~250 fixed namespaces.
const debugInstances = new Map<string, Debug.Debugger>();
function getDebug(namespace: string): Debug.Debugger {
    let d = debugInstances.get(namespace);
    if (!d) {
        d = Debug(namespace);
        debugInstances.set(namespace, d);
    }
    return d;
}

// The cascade pkc-logger has always used: a line prints under the most specific enabled namespace, and a
// coarser level (log) also prints when only a finer one (trace) is enabled, while errors print under any.
function candidates(namespace: string, level: LogLevel): string[] {
    const first = namespace.split(":")[0]!;
    switch (level) {
        case "log":
            return [namespace, first, `${namespace}:trace`, `${first}:trace`];
        case "error":
            return [`${namespace}:error`, `${first}:error`, namespace, first, `${namespace}:trace`, `${first}:trace`];
        case "trace":
            return [`${namespace}:trace`, `${first}:trace`];
    }
}

function pickEnabled(namespace: string, level: LogLevel): Debug.Debugger | undefined {
    for (const ns of candidates(namespace, level)) {
        const d = getDebug(ns);
        if (d.enabled) return d;
    }
    return undefined;
}

function validateChildOptions(options: ChildOptions, what: string): void {
    if (typeof options === "string")
        throw new Error(`${what}(namespace) was replaced by ${what}({ namespace }) in @pkcprotocol/pkc-logger 0.2.0`);
    if (typeof options !== "object" || options === null || Array.isArray(options)) throw new Error(`${what} options must be an object`);
    if (options.namespace !== undefined && (typeof options.namespace !== "string" || options.namespace.length === 0))
        throw new Error(`${what} namespace '${String(options.namespace)}' invalid`);
    if (options.tags !== undefined && (!Array.isArray(options.tags) || options.tags.some((t) => typeof t !== "string" || t.length === 0)))
        throw new Error(`${what} tags must be an array of non-empty strings`);
}

function mergeTags(parent: readonly string[], extra: string[] | undefined): string[] {
    if (!extra || extra.length === 0) return [...parent];
    const out = [...parent];
    for (const t of extra) if (!out.includes(t)) out.push(t);
    return out;
}

function buildLogger(root: RootState, namespace: string | undefined, ownTags: readonly string[]): Logger {
    // One frozen array shared by this logger and every entry it emits, so no consumer can mutate it.
    const tags = Object.freeze([...ownTags]);
    const emit = (level: LogLevel, args: unknown[]): void => {
        if (namespace === undefined) throw new Error("this logger has no namespace; log through child({ namespace })");
        const d = pickEnabled(namespace, level);
        if (!d) return; // disabled: no formatting, no capture, same cost as before
        const msg = formatLogArgs(args);
        const entry = root.buffer.push({ time: Date.now(), level, namespace, msg, tags });
        if (tags.length > 0) d("[%s] %s", tags.join(", "), msg);
        else d("%s", msg);
        for (const listener of root.listeners) {
            try {
                const result: unknown = listener(entry);
                // An async listener rejects instead of throwing; swallow that too, or Node treats it as an
                // unhandled rejection and (by default) exits the process.
                if (result && typeof (result as PromiseLike<unknown>).then === "function")
                    (result as PromiseLike<unknown>).then(undefined, () => {});
            } catch {
                // a faulty sink must never break the code that logged
            }
        }
    };

    const logger = ((...args: unknown[]) => emit("log", args)) as Logger;
    logger.error = (...args: unknown[]) => emit("error", args);
    logger.trace = (...args: unknown[]) => emit("trace", args);
    Object.defineProperty(logger, "namespace", { value: namespace, enumerable: true });
    Object.defineProperty(logger, "tags", { value: tags, enumerable: true });
    logger.child = (options: ChildOptions) => {
        validateChildOptions(options, "child");
        const childNamespace = namespace ? (options.namespace ? `${namespace}:${options.namespace}` : namespace) : options.namespace;
        return buildLogger(root, childNamespace, mergeTags(tags, options.tags));
    };
    logger.getLogs = (query?: LogQuery) => root.buffer.query(query);
    logger.addListener = (listener: LogListener) => {
        if (typeof listener !== "function") throw new Error("listener must be a function");
        root.listeners.add(listener);
        return () => root.listeners.delete(listener);
    };
    logger.removeListener = (listener: LogListener) => {
        root.listeners.delete(listener);
    };
    return logger;
}

/** Creates a root logger with its own buffer and listener set. */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
    validateChildOptions(options, "createLogger");
    const maxBytes = options.buffer?.maxBytes ?? DEFAULT_BUFFER_MAX_BYTES;
    const root: RootState = { buffer: new LogRingBuffer(maxBytes), listeners: new Set() };
    return buildLogger(root, options.namespace, mergeTags([], options.tags));
}

// Process-default root for code with no instance in scope (CLI commands, tests, packages mid-migration).
// It prints but keeps no buffer; `getLogs` on it is always empty.
const defaultRoot = createLogger({ buffer: { maxBytes: 0 } });

/** A child of the process-default root. `namespace` is required. */
function Logger(options: ChildOptions & { namespace: string }): Logger {
    validateChildOptions(options, "Logger");
    if (!options.namespace) throw new Error("Logger({ namespace }) requires a namespace");
    return defaultRoot.child(options);
}

namespace Logger {
    export const disable = (): void => {
        Debug.disable();
    };
    export const enable = (namespaces: string): void => {
        Debug.enable(namespaces);
    };
    export const enabled = (namespaces: string): boolean => Debug.enabled(namespaces);
    /** Listener on the process-default root. */
    export const addListener = (listener: LogListener): (() => void) => defaultRoot.addListener(listener);
    export const removeListener = (listener: LogListener): void => defaultRoot.removeListener(listener);
}

export default Logger;
