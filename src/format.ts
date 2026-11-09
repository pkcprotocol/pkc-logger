// Cross-platform formatter: turns a log call's arguments into one string at emit time, so a captured
// entry never retains the caller's objects (which would pin memory and show post-mutation state) and
// renders the same way in Node and in a browser. Output has no color escapes.

export interface FormatOptions {
    /** Hard cap on the formatted string's length (UTF-16 code units). Default 16 KiB. */
    maxLength?: number;
    /** Nesting depth before an object collapses to `[Object]` / `[Array]`. Default 4. */
    maxDepth?: number;
    /** Array / Map / Set elements rendered before `... N more`. Default 50. */
    maxArrayLength?: number;
    /** Object keys rendered before `... N more`. Default 50. */
    maxKeys?: number;
    /** Nested string values longer than this are truncated. Default 2000. */
    maxStringLength?: number;
}

const DEFAULTS: Required<FormatOptions> = {
    maxLength: 16 * 1024,
    maxDepth: 4,
    maxArrayLength: 50,
    maxKeys: 50,
    maxStringLength: 2000
};

export const TRUNCATION_MARKER = "…[truncated]";

type Ctx = Required<FormatOptions> & { seen: Set<object> };

function truncateString(s: string, max: number): string {
    return s.length > max ? s.slice(0, max) + TRUNCATION_MARKER : s;
}

function inspectError(err: Error, depth: number, ctx: Ctx): string {
    const head = err.stack && err.stack.includes(err.message) ? err.stack : `${err.name}: ${err.message}${err.stack ? "\n" + err.stack : ""}`;
    // Own enumerable props beyond name/message/stack (e.g. a PKCError's code/details) are worth keeping.
    const extraKeys = Object.keys(err).filter((k) => k !== "name" && k !== "message" && k !== "stack");
    if (extraKeys.length === 0 && !("cause" in err)) return head;
    const extras: Record<string, unknown> = {};
    for (const k of extraKeys) extras[k] = (err as unknown as Record<string, unknown>)[k];
    if ("cause" in err) extras["cause"] = (err as { cause?: unknown }).cause;
    return `${head} ${inspectValue(extras, depth, ctx)}`;
}

function inspectValue(value: unknown, depth: number, ctx: Ctx): string {
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
    if (value === null) return "null";
    const obj = value as object;

    if (obj instanceof Error) return inspectError(obj, depth, ctx);
    if (obj instanceof Date) return isNaN(obj.getTime()) ? "Invalid Date" : obj.toISOString();
    if (obj instanceof RegExp) return obj.toString();
    if (ArrayBuffer.isView(obj)) return `${obj.constructor.name}(${(obj as ArrayBufferView).byteLength})`;
    if (obj instanceof ArrayBuffer) return `ArrayBuffer(${obj.byteLength})`;
    if (typeof (obj as { then?: unknown }).then === "function" && !Array.isArray(obj) && !(obj instanceof Map) && !(obj instanceof Set))
        return "[Promise]";

    if (ctx.seen.has(obj)) return "[Circular]";
    if (depth >= ctx.maxDepth) return Array.isArray(obj) ? "[Array]" : "[Object]";
    ctx.seen.add(obj);
    try {
        if (Array.isArray(obj)) {
            const shown = obj.slice(0, ctx.maxArrayLength).map((v) => inspectValue(v, depth + 1, ctx));
            if (obj.length > ctx.maxArrayLength) shown.push(`... ${obj.length - ctx.maxArrayLength} more`);
            return `[${shown.join(", ")}]`;
        }
        if (obj instanceof Map) {
            const shown: string[] = [];
            let i = 0;
            for (const [k, v] of obj) {
                if (i++ >= ctx.maxArrayLength) break;
                shown.push(`${inspectValue(k, depth + 1, ctx)} => ${inspectValue(v, depth + 1, ctx)}`);
            }
            if (obj.size > ctx.maxArrayLength) shown.push(`... ${obj.size - ctx.maxArrayLength} more`);
            return `Map(${obj.size}) {${shown.join(", ")}}`;
        }
        if (obj instanceof Set) {
            const shown: string[] = [];
            let i = 0;
            for (const v of obj) {
                if (i++ >= ctx.maxArrayLength) break;
                shown.push(inspectValue(v, depth + 1, ctx));
            }
            if (obj.size > ctx.maxArrayLength) shown.push(`... ${obj.size - ctx.maxArrayLength} more`);
            return `Set(${obj.size}) {${shown.join(", ")}}`;
        }
        const keys = Object.keys(obj);
        const shown = keys.slice(0, ctx.maxKeys).map((k) => `${k}: ${inspectValue((obj as Record<string, unknown>)[k], depth + 1, ctx)}`);
        if (keys.length > ctx.maxKeys) shown.push(`... ${keys.length - ctx.maxKeys} more`);
        const ctor = obj.constructor && obj.constructor !== Object && obj.constructor.name ? `${obj.constructor.name} ` : "";
        return `${ctor}{${shown.join(", ")}}`;
    } finally {
        ctx.seen.delete(obj);
    }
}

// The printf subset the `debug` package supports: %s %d %i %f %j %o %O %%. Only applied when the first
// argument is a string, like `debug` and util.format.
function applyPrintf(fmt: string, args: unknown[], ctx: Ctx): { text: string; rest: unknown[] } {
    let i = 0;
    const text = fmt.replace(/%([sdifjoO%])/g, (match, spec: string) => {
        if (spec === "%") return "%";
        if (i >= args.length) return match;
        const arg = args[i++];
        switch (spec) {
            case "s":
                return typeof arg === "string" ? arg : inspectValue(arg, 1, ctx);
            case "d":
            case "i":
                return typeof arg === "bigint" ? `${arg}n` : String(spec === "i" ? Math.trunc(Number(arg)) : Number(arg));
            case "f":
                return String(parseFloat(String(arg)));
            case "j":
                try {
                    return JSON.stringify(arg) ?? String(arg);
                } catch {
                    return "[Circular]";
                }
            default:
                return inspectValue(arg, 1, ctx);
        }
    });
    return { text, rest: args.slice(i) };
}

/** Formats a log call's arguments into one bounded, color-free string. */
export function formatLogArgs(args: unknown[], options: FormatOptions = {}): string {
    const ctx: Ctx = { ...DEFAULTS, ...options, seen: new Set() };
    let parts: string[];
    let rest: unknown[];
    if (typeof args[0] === "string" && args[0].includes("%")) {
        const r = applyPrintf(args[0], args.slice(1), ctx);
        parts = [r.text];
        rest = r.rest;
    } else {
        parts = [];
        rest = args;
    }
    for (const arg of rest) parts.push(inspectValue(arg, 0, ctx));
    const joined = parts.join(" ");
    return joined.length > ctx.maxLength ? joined.slice(0, ctx.maxLength - TRUNCATION_MARKER.length) + TRUNCATION_MARKER : joined;
}
