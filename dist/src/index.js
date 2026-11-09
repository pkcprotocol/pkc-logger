import Debug from "debug";
import { formatLogArgs } from "./format.js";
import { LogRingBuffer, isTagArray, InvalidLogQueryError, INVALID_LOG_QUERY_CODE, DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT } from "./ring-buffer.js";
export { InvalidLogQueryError, INVALID_LOG_QUERY_CODE, DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT, formatLogArgs };
export const DEFAULT_BUFFER_MAX_BYTES = 4 * 1024 * 1024;
// `debug` instances are stateless apart from their namespace, so one per namespace process-wide is enough
// (pkc-js's update cycle asks for a logger per comment on hot paths; issue pkc-js#351).
// The cache is never evicted, so namespaces must stay low-cardinality: put per-object identifiers (cid,
// publicKey...) in tags, never in the namespace. pkc-js uses ~250 fixed namespaces.
const debugInstances = new Map();
function getDebug(namespace) {
    let d = debugInstances.get(namespace);
    if (!d) {
        d = Debug(namespace);
        debugInstances.set(namespace, d);
    }
    return d;
}
// The cascade pkc-logger has always used: a line prints under the most specific enabled namespace, and a
// coarser level (log) also prints when only a finer one (trace) is enabled, while errors print under any.
function candidates(namespace, level) {
    const first = namespace.split(":")[0];
    switch (level) {
        case "log":
            return [namespace, first, `${namespace}:trace`, `${first}:trace`];
        case "error":
            return [`${namespace}:error`, `${first}:error`, namespace, first, `${namespace}:trace`, `${first}:trace`];
        case "trace":
            return [`${namespace}:trace`, `${first}:trace`];
    }
}
function pickEnabled(namespace, level) {
    for (const ns of candidates(namespace, level)) {
        const d = getDebug(ns);
        if (d.enabled)
            return d;
    }
    return undefined;
}
function validateChildOptions(options, what) {
    if (typeof options === "string")
        throw new Error(`${what}(namespace) was replaced by ${what}({ namespace }) in @pkcprotocol/pkc-logger 0.2.0`);
    if (typeof options !== "object" || options === null || Array.isArray(options))
        throw new Error(`${what} options must be an object`);
    if (options.namespace !== undefined && (typeof options.namespace !== "string" || options.namespace.length === 0))
        throw new Error(`${what} namespace '${String(options.namespace)}' invalid`);
    if (options.tags !== undefined && !isTagArray(options.tags))
        throw new Error(`${what} tags must be an array of non-empty strings`);
    if (options.listeners !== undefined && typeof options.listeners !== "boolean")
        throw new Error(`${what} listeners must be a boolean`);
}
function mergeTags(parent, extra) {
    if (!extra || extra.length === 0)
        return [...parent];
    const out = [...parent];
    for (const t of extra)
        if (!out.includes(t))
            out.push(t);
    return out;
}
// Like a browser's EventTarget: a listener's error is reported and delivery goes on. The report is always buffered,
// printed only when its namespace is enabled, and never delivered to a listener, so failing sinks cannot feed each other.
function reportListenerError(root, error) {
    try {
        const namespace = root.listenerErrorNamespace;
        const msg = formatLogArgs(["uncaught error in listener:", error]);
        root.buffer.push({ time: Date.now(), level: "error", namespace, msg, tags: Object.freeze([]) });
        pickEnabled(namespace, "error")?.("%s", msg);
    }
    catch {
        // reporting must never break the code that logged
    }
}
function deliver(root, entry) {
    if (root.listeners.size === 0)
        return;
    // Like dispatchEvent: listeners added during this delivery wait for the next entry.
    for (const registration of Array.from(root.listeners.values())) {
        const { listener } = registration;
        if (registration.removed || root.delivering.has(listener))
            continue;
        root.delivering.add(listener);
        try {
            const result = listener(entry);
            // An async listener rejects instead of throwing; catch that too, or Node treats it as an
            // unhandled rejection and (by default) exits the process.
            if (result && typeof result.then === "function")
                result.then(undefined, (error) => reportListenerError(root, error));
        }
        catch (error) {
            reportListenerError(root, error);
        }
        finally {
            root.delivering.delete(listener);
        }
    }
}
function removeListener(root, listener) {
    const registration = root.listeners.get(listener);
    if (!registration)
        return;
    registration.removed = true;
    root.listeners.delete(listener);
}
function buildLogger(root, namespace, ownTags, delivers) {
    // One frozen array shared by this logger and every entry it emits, so no consumer can mutate it.
    const tags = Object.freeze([...ownTags]);
    const emit = (level, args) => {
        if (namespace === undefined)
            throw new Error("this logger has no namespace; log through child({ namespace })");
        const d = pickEnabled(namespace, level);
        if (!d)
            return; // disabled: no formatting, no capture, same cost as before
        const msg = formatLogArgs(args);
        const entry = root.buffer.push({ time: Date.now(), level, namespace, msg, tags });
        if (tags.length > 0)
            d("[%s] %s", tags.join(", "), msg);
        else
            d("%s", msg);
        if (delivers)
            deliver(root, entry);
    };
    const logger = ((...args) => emit("log", args));
    logger.error = (...args) => emit("error", args);
    logger.trace = (...args) => emit("trace", args);
    Object.defineProperty(logger, "namespace", { value: namespace, enumerable: true });
    Object.defineProperty(logger, "tags", { value: tags, enumerable: true });
    logger.child = (options) => {
        validateChildOptions(options, "child");
        const childNamespace = namespace ? (options.namespace ? `${namespace}:${options.namespace}` : namespace) : options.namespace;
        return buildLogger(root, childNamespace, mergeTags(tags, options.tags), delivers && options.listeners !== false);
    };
    logger.getLogs = (query) => root.buffer.query(query);
    logger.addListener = (listener) => {
        if (typeof listener !== "function")
            throw new Error("listener must be a function");
        let registration = root.listeners.get(listener);
        if (!registration) {
            registration = { listener, removed: false };
            root.listeners.set(listener, registration);
        }
        // Removes only this registration, so a stale unsubscribe called again after a re-add is a no-op.
        const own = registration;
        return () => {
            if (root.listeners.get(listener) === own)
                removeListener(root, listener);
        };
    };
    logger.removeListener = (listener) => removeListener(root, listener);
    return logger;
}
/** Creates a root logger with its own buffer and listener set. */
export function createLogger(options = {}) {
    validateChildOptions(options, "createLogger");
    const maxBytes = options.buffer?.maxBytes ?? DEFAULT_BUFFER_MAX_BYTES;
    const root = {
        buffer: new LogRingBuffer(maxBytes),
        listenerErrorNamespace: options.namespace ? `${options.namespace}:listener` : "pkc-logger:listener",
        listeners: new Map(),
        delivering: new Set(),
    };
    return buildLogger(root, options.namespace, mergeTags([], options.tags), options.listeners !== false);
}
// Process-default root for code with no instance in scope (CLI commands, tests, packages mid-migration).
// It prints but keeps no buffer; `getLogs` on it is always empty.
const defaultRoot = createLogger({ buffer: { maxBytes: 0 } });
/** A child of the process-default root. `namespace` is required. */
function Logger(options) {
    validateChildOptions(options, "Logger");
    if (!options.namespace)
        throw new Error("Logger({ namespace }) requires a namespace");
    return defaultRoot.child(options);
}
(function (Logger) {
    Logger.disable = () => {
        Debug.disable();
    };
    Logger.enable = (namespaces) => {
        Debug.enable(namespaces);
    };
    Logger.enabled = (namespaces) => Debug.enabled(namespaces);
    /** Listener on the process-default root. */
    Logger.addListener = (listener) => defaultRoot.addListener(listener);
    Logger.removeListener = (listener) => defaultRoot.removeListener(listener);
})(Logger || (Logger = {}));
export default Logger;
