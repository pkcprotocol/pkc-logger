// Cross-platform formatter: turns a log call's arguments into one string at emit time, so a captured
// entry never retains the caller's objects (which would pin memory and show post-mutation state) and
// renders the same way in Node and in a browser. Output has no color escapes.
const DEFAULTS = {
    maxLength: 16 * 1024,
    maxDepth: 4,
    maxArrayLength: 50,
    maxKeys: 50,
    maxStringLength: 2000
};
export const TRUNCATION_MARKER = "…[truncated]";
const BUDGET_SPENT = "…";
function spent(ctx) {
    return ctx.used >= ctx.maxLength;
}
function charge(ctx, s) {
    ctx.used += s.length;
    return s;
}
// Reads a property without letting a throwing getter (or Proxy trap) escape into the caller's log call.
function readProp(obj, key) {
    try {
        return obj[key];
    }
    catch {
        return GETTER_THREW;
    }
}
const GETTER_THREW = Symbol("getter threw");
function truncateString(s, max) {
    return s.length > max ? s.slice(0, max) + TRUNCATION_MARKER : s;
}
function inspectError(err, depth, ctx) {
    const head = err.stack && err.stack.includes(err.message) ? err.stack : `${err.name}: ${err.message}${err.stack ? "\n" + err.stack : ""}`;
    // Own enumerable props beyond name/message/stack (e.g. a PKCError's code/details) are worth keeping.
    const extraKeys = Object.keys(err).filter((k) => k !== "name" && k !== "message" && k !== "stack");
    // AggregateError keeps its inner errors in a non-enumerable `errors` array; without it the details are lost.
    const inner = extraKeys.includes("errors") ? undefined : readProp(err, "errors");
    if (extraKeys.length === 0 && !("cause" in err) && !Array.isArray(inner))
        return head;
    const extras = {};
    for (const k of extraKeys)
        extras[k] = readProp(err, k);
    if ("cause" in err)
        extras["cause"] = readProp(err, "cause");
    if (Array.isArray(inner))
        extras["errors"] = inner;
    return `${head} ${inspectValue(extras, depth, ctx)}`;
}
function inspectValue(value, depth, ctx) {
    if (value === GETTER_THREW)
        return charge(ctx, "[Getter threw]");
    if (spent(ctx))
        return BUDGET_SPENT;
    let out;
    try {
        out = inspectUncharged(value, depth, ctx);
    }
    catch {
        // A Proxy trap (ownKeys, getPrototypeOf...) or another hostile object; a log call must not throw.
        out = "[Uninspectable]";
    }
    // Containers were already charged through their children (and keys); charging their joined text again
    // would count nested content once per level and cut deep objects short.
    if (typeof value !== "object" || value === null)
        charge(ctx, out);
    else
        ctx.used += 2;
    return out;
}
function inspectUncharged(value, depth, ctx) {
    switch (typeof value) {
        case "string":
            return depth === 0 ? value : JSON.stringify(truncateString(value, ctx.maxStringLength));
        case "number":
            return Object.is(value, -0) ? "-0" : String(value);
        case "bigint":
            return `${value}n`;
        case "boolean":
        case "undefined":
            return String(value);
        case "symbol":
            return value.toString();
        case "function":
            return `[Function: ${value.name || "anonymous"}]`;
    }
    if (value === null)
        return "null";
    const obj = value;
    if (obj instanceof Error) {
        if (ctx.seen.has(obj))
            return "[Circular]";
        ctx.seen.add(obj);
        try {
            return inspectError(obj, depth, ctx);
        }
        finally {
            ctx.seen.delete(obj);
        }
    }
    if (obj instanceof Date)
        return isNaN(obj.getTime()) ? "Invalid Date" : obj.toISOString();
    if (obj instanceof RegExp)
        return obj.toString();
    if (ArrayBuffer.isView(obj))
        return `${obj.constructor.name}(${obj.byteLength})`;
    if (obj instanceof ArrayBuffer)
        return `ArrayBuffer(${obj.byteLength})`;
    if (typeof readProp(obj, "then") === "function" && !Array.isArray(obj) && !(obj instanceof Map) && !(obj instanceof Set))
        return "[Promise]";
    if (ctx.seen.has(obj))
        return "[Circular]";
    if (depth >= ctx.maxDepth)
        return Array.isArray(obj) ? "[Array]" : "[Object]";
    ctx.seen.add(obj);
    try {
        if (Array.isArray(obj)) {
            const shown = [];
            for (const v of obj.slice(0, ctx.maxArrayLength)) {
                if (spent(ctx))
                    break;
                shown.push(inspectValue(v, depth + 1, ctx));
            }
            if (obj.length > ctx.maxArrayLength)
                shown.push(`... ${obj.length - ctx.maxArrayLength} more`);
            return `[${shown.join(", ")}]`;
        }
        if (obj instanceof Map) {
            const shown = [];
            let i = 0;
            for (const [k, v] of obj) {
                if (i++ >= ctx.maxArrayLength || spent(ctx))
                    break;
                shown.push(`${inspectValue(k, depth + 1, ctx)} => ${inspectValue(v, depth + 1, ctx)}`);
            }
            if (obj.size > ctx.maxArrayLength)
                shown.push(`... ${obj.size - ctx.maxArrayLength} more`);
            return `Map(${obj.size}) {${shown.join(", ")}}`;
        }
        if (obj instanceof Set) {
            const shown = [];
            let i = 0;
            for (const v of obj) {
                if (i++ >= ctx.maxArrayLength || spent(ctx))
                    break;
                shown.push(inspectValue(v, depth + 1, ctx));
            }
            if (obj.size > ctx.maxArrayLength)
                shown.push(`... ${obj.size - ctx.maxArrayLength} more`);
            return `Set(${obj.size}) {${shown.join(", ")}}`;
        }
        const keys = Object.keys(obj);
        const shown = [];
        for (const k of keys.slice(0, ctx.maxKeys)) {
            if (spent(ctx))
                break;
            ctx.used += k.length + 2;
            shown.push(`${k}: ${inspectValue(readProp(obj, k), depth + 1, ctx)}`);
        }
        if (keys.length > ctx.maxKeys)
            shown.push(`... ${keys.length - ctx.maxKeys} more`);
        const ctor = obj.constructor && obj.constructor !== Object && obj.constructor.name ? `${obj.constructor.name} ` : "";
        return `${ctor}{${shown.join(", ")}}`;
    }
    finally {
        ctx.seen.delete(obj);
    }
}
// The printf subset the `debug` package supports: %s %d %i %f %j %o %O %%. Only applied when the first
// argument is a string, like `debug` and util.format.
function applyPrintf(fmt, args, ctx) {
    let i = 0;
    const text = fmt.replace(/%([sdifjoO%])/g, (match, spec) => {
        if (spec === "%")
            return "%";
        if (i >= args.length)
            return match;
        const arg = args[i++];
        switch (spec) {
            case "s":
                return typeof arg === "string" ? arg : inspectValue(arg, 1, ctx);
            case "d":
            case "i":
                if (typeof arg === "bigint")
                    return `${arg}n`;
                // Number() throws on a Symbol or an object with no usable valueOf/toString; a log call must not.
                try {
                    // %i is parseInt, as in util.format: "12px" prints 12.
                    return String(spec === "i" ? parseInt(String(arg), 10) : Number(arg));
                }
                catch {
                    return "NaN";
                }
            case "f":
                try {
                    return String(parseFloat(String(arg)));
                }
                catch {
                    return "NaN";
                }
            case "j":
                return charge(ctx, boundedJson(arg, ctx));
            default:
                return inspectValue(arg, 1, ctx);
        }
    });
    return { text, rest: args.slice(i) };
}
// JSON.stringify with the shared budget. Once the approximate output size passes maxLength, the replacer
// emits one sentinel and then undefined for everything after it, so stringify stops descending (and stops
// reading getters). The output is cut at the sentinel and marked truncated: returning undefined alone would
// show up as fake `null`s inside arrays.
const JSON_CUT = "\u0000pkc-logger-cut\u0000";
const JSON_CUT_QUOTED = JSON.stringify(JSON_CUT);
// Thrown out of the replacer when stringify is about to re-enter an object it is still inside.
const JSON_CYCLE = Symbol("pkc-logger-cycle");
function boundedJson(arg, ctx) {
    let size = 0;
    let cut = false;
    // The objects stringify is inside, outermost first. The replacer sees every value stringify is about to
    // serialize (after toJSON, including array indices JSON reads whether enumerable or not), so a cycle is
    // found exactly where stringify would hit it, without walking the value a second time.
    const stack = [];
    const replacer = function (key, value) {
        if (cut)
            return undefined;
        while (stack.length > 0 && stack[stack.length - 1] !== this)
            stack.pop();
        if (typeof value === "object" && value !== null) {
            if (stack.includes(value))
                throw JSON_CYCLE;
            stack.push(value);
        }
        if (ctx.used + size >= ctx.maxLength) {
            cut = true;
            return JSON_CUT;
        }
        // Array indices never appear in the output, so only object keys count.
        if (!Array.isArray(this))
            size += key.length + 3;
        size += 1;
        if (typeof value === "string")
            size += value.length + 2;
        else if (typeof value !== "object" || value === null)
            size += String(value).length;
        return value;
    };
    let out;
    try {
        out = JSON.stringify(arg, replacer) ?? "undefined"; // functions, symbols, undefined: what util.format prints
    }
    catch (e) {
        // Same label util.format uses for a cycle; anything else (BigInt, a throwing toJSON) says what failed.
        if (e === JSON_CYCLE)
            return "[Circular]";
        return `[Unserializable: ${describeError(e)}]`;
    }
    const at = out.indexOf(JSON_CUT_QUOTED);
    return at === -1 ? out : out.slice(0, at) + TRUNCATION_MARKER;
}
// The text of whatever a toJSON threw. It may be anything, including a value whose message or toString throws.
function describeError(e) {
    try {
        return e instanceof Error ? String(e.message) : String(e);
    }
    catch {
        return "error cannot be described";
    }
}
// CSI sequences (colors, cursor moves) and OSC sequences (titles, hyperlinks).
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
/** Formats a log call's arguments into one bounded, color-free string. */
export function formatLogArgs(args, options = {}) {
    // Apply a default for every option left undefined, so `{ maxLength: undefined }` does not disable the limit.
    const ctx = { ...DEFAULTS, seen: new Set(), used: 0 };
    for (const k of Object.keys(DEFAULTS))
        if (options[k] !== undefined)
            ctx[k] = options[k];
    let parts;
    let rest;
    if (typeof args[0] === "string" && args[0].includes("%")) {
        const before = ctx.used;
        const r = applyPrintf(args[0], args.slice(1), ctx);
        parts = [r.text];
        rest = r.rest;
        // Placeholders rendered through inspectValue/boundedJson already charged their text; charge only the
        // rest (literal segments, %s strings, numbers), so nothing counts twice.
        ctx.used = before + Math.max(r.text.length, ctx.used - before);
    }
    else {
        parts = [];
        rest = args;
    }
    for (const arg of rest)
        parts.push(inspectValue(arg, 0, ctx));
    let joined = parts.join(" ");
    // Logged strings may carry terminal colors; entries are documented color-free, so strip them.
    if (joined.includes("\u001b"))
        joined = joined.replace(ANSI_ESCAPE, "");
    if (joined.length <= ctx.maxLength)
        return joined;
    if (ctx.maxLength <= TRUNCATION_MARKER.length)
        return TRUNCATION_MARKER.slice(0, ctx.maxLength);
    return joined.slice(0, ctx.maxLength - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}
