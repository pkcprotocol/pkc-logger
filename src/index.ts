import Debug from "debug";
import { formatLogArgs } from "./format.js";
import { LogRingBuffer, copyTagRecord, defineTag, InvalidLogQueryError, INVALID_LOG_QUERY_CODE, DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT } from "./ring-buffer.js";
import type { LogEntry, LogLevel, LogQuery, LogQueryResult, Tags } from "./ring-buffer.js";

export type { LogEntry, LogLevel, LogQuery, LogQueryResult, Tags };
export { InvalidLogQueryError, INVALID_LOG_QUERY_CODE, DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT, formatLogArgs };
export type { FormatOptions } from "./format.js";

export const DEFAULT_BUFFER_MAX_BYTES = 4 * 1024 * 1024;

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
    buffer?: { maxBytes?: number };
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

interface RootState {
    buffer: LogRingBuffer;
    // Namespace of the entry recorded when a listener throws or rejects.
    listenerErrorNamespace: string;
    // One registration per listener, as in EventTarget: removing marks it removed, so a delivery already under
    // way skips it, and adding it again creates a new registration that this delivery's snapshot does not hold.
    listeners: Map<LogListener, { listener: LogListener; removed: boolean }>;
    // Listeners currently running. A listener that logs through the same root is not handed its own entries,
    // which would otherwise recurse until the stack overflows and flood the buffer on the way.
    delivering: Set<LogListener>;
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

/** Validates the options and returns a copy of their tags, with undefined values dropped. */
function readChildOptions(options: ChildOptions, what: string): Record<string, string> {
    if (typeof options === "string")
        throw new Error(`${what}(namespace) was replaced by ${what}({ namespace }) in @pkcprotocol/pkc-logger 0.2.0`);
    if (typeof options !== "object" || options === null || Array.isArray(options)) throw new Error(`${what} options must be an object`);
    if (options.namespace !== undefined && (typeof options.namespace !== "string" || options.namespace.length === 0))
        throw new Error(`${what} namespace '${String(options.namespace)}' invalid`);
    if (options.listeners !== undefined && typeof options.listeners !== "boolean") throw new Error(`${what} listeners must be a boolean`);
    return options.tags === undefined ? {} : readTags(options.tags, what);
}

function readTags(tags: unknown, what: string): Record<string, string> {
    const copy = copyTagRecord(tags, true);
    if (!copy) throw new Error(`${what} tags must be a record of non-empty strings, such as { cid: '...' }`);
    return copy;
}

const NO_TAGS: Tags = Object.freeze({});

// What a child needs from its parent to resolve tags live.
interface TagSource {
    /** Changes exactly when this logger's own tags or an ancestor's were replaced. */
    stamp(): number;
    /** The frozen effective record. */
    resolve(): Tags;
}

function mergeTags(inherited: Tags, own: Record<string, string>): Tags {
    const ownKeys = Object.keys(own);
    // Nothing of its own: share the parent's record, so entries of a whole subtree point at one object.
    if (ownKeys.length === 0) return inherited;
    const out: Record<string, string> = {};
    for (const key of Object.keys(inherited)) defineTag(out, key, inherited[key]!);
    for (const key of ownKeys) defineTag(out, key, own[key]!);
    return Object.freeze(out);
}

function sameTags(a: Record<string, string>, b: Record<string, string>): boolean {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    // Values are strings, so a key `b` lacks (undefined, or a name it only inherits) never compares equal.
    for (const key of keys) if (a[key] !== b[key]) return false;
    return true;
}

// Like a browser's EventTarget: a listener's error is reported and delivery goes on. The report is always buffered,
// printed only when its namespace is enabled, and never delivered to a listener, so failing sinks cannot feed each other.
function reportListenerError(root: RootState, error: unknown): void {
    try {
        const namespace = root.listenerErrorNamespace;
        const msg = formatLogArgs(["uncaught error in listener:", error]);
        root.buffer.push({ time: Date.now(), level: "error", namespace, msg, tags: NO_TAGS });
        pickEnabled(namespace, "error")?.("%s", msg);
    } catch {
        // reporting must never break the code that logged
    }
}

function deliver(root: RootState, entry: LogEntry): void {
    if (root.listeners.size === 0) return;
    // Like dispatchEvent: listeners added during this delivery wait for the next entry.
    for (const registration of Array.from(root.listeners.values())) {
        const { listener } = registration;
        if (registration.removed || root.delivering.has(listener)) continue;
        root.delivering.add(listener);
        try {
            const result: unknown = listener(entry);
            // An async listener rejects instead of throwing; catch that too, or Node treats it as an
            // unhandled rejection and (by default) exits the process.
            if (result && typeof (result as PromiseLike<unknown>).then === "function")
                (result as PromiseLike<unknown>).then(undefined, (error: unknown) => reportListenerError(root, error));
        } catch (error) {
            reportListenerError(root, error);
        } finally {
            root.delivering.delete(listener);
        }
    }
}

function removeListener(root: RootState, listener: LogListener): void {
    const registration = root.listeners.get(listener);
    if (!registration) return;
    registration.removed = true;
    root.listeners.delete(listener);
}

function buildLogger(
    root: RootState,
    namespace: string | undefined,
    parent: TagSource | undefined,
    ownTags: Record<string, string>,
    delivers: boolean
): Logger {
    // Tags resolve through the parent chain, so a setTags on an ancestor reaches loggers derived before it.
    // Each logger counts its own setTags calls; the sum up the chain only grows, and it changes exactly when
    // this logger or an ancestor changed. The effective record is cached against that sum: an enabled line
    // costs O(depth) additions, and a setTags elsewhere leaves this logger's record (shared by its entries) alone.
    let own = ownTags;
    let version = 0;
    let cachedStamp = -1;
    let cached: Tags = NO_TAGS;
    const stamp = (): number => (parent ? parent.stamp() + version : version);
    const resolve = (): Tags => {
        const current = stamp();
        if (current !== cachedStamp) {
            cached = mergeTags(parent ? parent.resolve() : NO_TAGS, own);
            cachedStamp = current;
        }
        return cached;
    };

    const emit = (level: LogLevel, args: unknown[]): void => {
        if (namespace === undefined) throw new Error("this logger has no namespace; log through child({ namespace })");
        const d = pickEnabled(namespace, level);
        if (!d) return; // disabled: no formatting, no capture, same cost as before
        const msg = formatLogArgs(args);
        const tags = resolve();
        const entry = root.buffer.push({ time: Date.now(), level, namespace, msg, tags });
        const keys = Object.keys(tags);
        if (keys.length > 0) d("[%s] %s", keys.map((key) => `${key}=${tags[key]}`).join(", "), msg);
        else d("%s", msg);
        if (delivers) deliver(root, entry);
    };

    const logger = ((...args: unknown[]) => emit("log", args)) as Logger;
    logger.error = (...args: unknown[]) => emit("error", args);
    logger.trace = (...args: unknown[]) => emit("trace", args);
    Object.defineProperty(logger, "namespace", { value: namespace, enumerable: true });
    Object.defineProperty(logger, "tags", { get: resolve, enumerable: true });
    logger.setTags = (tags: TagsInput) => {
        const next = readTags(tags, "setTags");
        // Setting the same tags again keeps the cached record, so a caller may refresh on every field change.
        if (sameTags(own, next)) return;
        own = next;
        version++;
    };
    logger.child = (options: ChildOptions) => {
        const childTags = readChildOptions(options, "child");
        const childNamespace = namespace ? (options.namespace ? `${namespace}:${options.namespace}` : namespace) : options.namespace;
        return buildLogger(root, childNamespace, { stamp, resolve }, childTags, delivers && options.listeners !== false);
    };
    logger.getLogs = (query?: LogQuery) => root.buffer.query(query);
    logger.addListener = (listener: LogListener) => {
        if (typeof listener !== "function") throw new Error("listener must be a function");
        let registration = root.listeners.get(listener);
        if (!registration) {
            registration = { listener, removed: false };
            root.listeners.set(listener, registration);
        }
        // Removes only this registration, so a stale unsubscribe called again after a re-add is a no-op.
        const own = registration;
        return () => {
            if (root.listeners.get(listener) === own) removeListener(root, listener);
        };
    };
    logger.removeListener = (listener: LogListener) => removeListener(root, listener);
    return logger;
}

/** Creates a root logger with its own buffer and listener set. */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
    const tags = readChildOptions(options, "createLogger");
    const maxBytes = options.buffer?.maxBytes ?? DEFAULT_BUFFER_MAX_BYTES;
    const root: RootState = {
        buffer: new LogRingBuffer(maxBytes),
        listenerErrorNamespace: options.namespace ? `${options.namespace}:listener` : "pkc-logger:listener",
        listeners: new Map(),
        delivering: new Set(),
    };
    return buildLogger(root, options.namespace, undefined, tags, options.listeners !== false);
}

// Process-default root for code with no instance in scope (CLI commands, tests, packages mid-migration).
// It prints but keeps no buffer; `getLogs` on it is always empty.
const defaultRoot = createLogger({ buffer: { maxBytes: 0 } });

/** A child of the process-default root. `namespace` is required. */
function Logger(options: ChildOptions & { namespace: string }): Logger {
    readChildOptions(options, "Logger"); // for the error message; child() validates and copies again
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
