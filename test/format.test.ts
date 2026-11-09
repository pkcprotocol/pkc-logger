import { test } from "node:test";
import assert from "node:assert/strict";
import { format } from "node:util";
import { formatLogArgs, TRUNCATION_MARKER } from "../src/format.js";

test("joins plain arguments with spaces, strings verbatim at top level", () => {
    assert.equal(formatLogArgs(["hello", "world", 42, true, null, undefined]), "hello world 42 true null undefined");
});

test("renders objects, arrays, Maps and Sets without color escapes", () => {
    const out = formatLogArgs(["ctx", { a: 1, b: [1, "two", { c: null }], m: new Map([["k", 1]]), s: new Set([1, 2]) }]);
    assert.equal(out, 'ctx {a: 1, b: [1, "two", {c: null}], m: Map(1) {"k" => 1}, s: Set(2) {1, 2}}');
    assert.doesNotMatch(out, /\u001b\[/);
});

test("supports the printf subset debug supports", () => {
    assert.equal(formatLogArgs(["%s has %d items (%j) %% %o", "box", 3, { x: 1 }, [1]]), "box has 3 items ({\"x\":1}) % [1]");
    // leftover args are appended, missing args leave the placeholder
    assert.equal(formatLogArgs(["%s and %s", "a"]), "a and %s");
    assert.equal(formatLogArgs(["%s", "a", "extra"]), "a extra");
});

test("Errors keep name, message, stack and own props", () => {
    const err = Object.assign(new Error("boom"), { code: "ERR_X", details: { cid: "Qm1" } });
    const out = formatLogArgs(["failed", err]);
    assert.ok(out.startsWith("failed Error: boom\n"), out);
    assert.match(out, /at .*format\.test/);
    assert.match(out, /\{code: "ERR_X", details: \{cid: "Qm1"\}\}$/);
});

test("Errors with a cause include it", () => {
    const err = Object.assign(new Error("outer"), { cause: new Error("inner") });
    const out = formatLogArgs([err]);
    assert.match(out, /cause: Error: inner/);
});

test("cycles collapse to [Circular]", () => {
    const o: Record<string, unknown> = { name: "x" };
    o["self"] = o;
    assert.equal(formatLogArgs([o]), '{name: "x", self: [Circular]}');
    // the same object twice as siblings is not a cycle
    const shared = { v: 1 };
    assert.equal(formatLogArgs([{ a: shared, b: shared }]), "{a: {v: 1}, b: {v: 1}}");
});

test("depth cap collapses deep nesting", () => {
    const deep = { l1: { l2: { l3: { l4: { l5: 1 } } } } };
    assert.equal(formatLogArgs([deep]), "{l1: {l2: {l3: {l4: [Object]}}}}");
    assert.equal(formatLogArgs([deep], { maxDepth: 2 }), "{l1: {l2: [Object]}}");
});

test("array, key and nested string caps", () => {
    const arr = Array.from({ length: 60 }, (_, i) => i);
    assert.match(formatLogArgs([arr]), /, 49, \.\.\. 10 more\]$/);
    const wide = Object.fromEntries(Array.from({ length: 55 }, (_, i) => [`k${i}`, i]));
    assert.match(formatLogArgs([wide]), /\.\.\. 5 more\}$/);
    const long = "x".repeat(3000);
    const out = formatLogArgs([{ s: long }]);
    assert.ok(out.length < 2200, `nested string not truncated: ${out.length}`);
    assert.ok(out.includes(TRUNCATION_MARKER));
    // a top-level string is not subject to the nested cap, only to the total cap
    assert.equal(formatLogArgs([long]).length, 3000);
});

test("total length cap defaults to 16 KiB and ends with the marker", () => {
    const out = formatLogArgs(["y".repeat(40_000)]);
    assert.equal(out.length, 16 * 1024);
    assert.ok(out.endsWith(TRUNCATION_MARKER));
});

test("special values", () => {
    const out = formatLogArgs([new Uint8Array(5), 10n, Symbol("s"), function named() {}, new Date(0), /re/g, Promise.resolve()]);
    assert.equal(out, "Uint8Array(5) 10n Symbol(s) [Function: named] 1970-01-01T00:00:00.000Z /re/g [Promise]");
});

test("class instances show their constructor name", () => {
    class Thing {
        constructor(public id = 7) {}
    }
    assert.equal(formatLogArgs([new Thing()]), "Thing {id: 7}");
});

// --- regression tests (each written to reproduce the bug before its fix) ---

test("a getter that throws does not make formatting throw", () => {
    const obj = {
        ok: 1,
        get boom(): number {
            throw new Error("nope");
        }
    };
    assert.equal(formatLogArgs(["x", obj]), "x {ok: 1, boom: [Getter threw]}");
});

test("an explicit undefined option keeps the default limit", () => {
    const out = formatLogArgs(["a".repeat(20_000)], { maxLength: undefined });
    assert.equal(out.length, 16 * 1024);
});

test("output never exceeds a maxLength shorter than the truncation marker", () => {
    const out = formatLogArgs(["a".repeat(100)], { maxLength: 4 });
    assert.equal(out, TRUNCATION_MARKER.slice(0, 4));
});

test("an Error whose cause is itself prints [Circular]", () => {
    const err = new Error("loop");
    (err as { cause?: unknown }).cause = err;
    const out = formatLogArgs([err]);
    assert.match(out, /cause: \[Circular\]/);
    assert.equal(out.match(/Error: loop/g)!.length, 1);
});

test("%j output is bounded by maxLength and stringify stops early", () => {
    let reads = 0;
    const big = Array.from({ length: 10_000 }, (_, i) => ({
        get v() {
            reads++;
            return i;
        }
    }));
    const out = formatLogArgs(["%j", big], { maxLength: 100 });
    assert.ok(out.length <= 100);
    assert.ok(reads < 10_000, `read ${reads} getters`);
});

test("a shared (non-cyclic) object graph stops rendering once the budget is spent", () => {
    // Each level references the next twice: 2^20 paths to the leaf without a budget.
    let leafReads = 0;
    let node: unknown = {
        get leaf() {
            leafReads++;
            return 1;
        }
    };
    for (let i = 0; i < 20; i++) node = { a: node, b: node };
    const out = formatLogArgs([node], { maxDepth: 25, maxLength: 1000 });
    assert.ok(out.length <= 1000);
    assert.ok(leafReads < 1000, `rendered the leaf ${leafReads} times`);
});

test("the budget does not cut short a nested object that fits", () => {
    let node: unknown = { v: "x".repeat(100) };
    for (let i = 0; i < 3; i++) node = { n: node };
    const out = formatLogArgs([node], { maxLength: 200 });
    assert.equal(out, `{n: {n: {n: {v: "${"x".repeat(100)}"}}}}`);
});

test("%j cut by the budget is marked truncated, not padded with fake nulls", () => {
    const peers = Array.from({ length: 1000 }, (_, i) => ({ id: `peer-${i}`, addr: "10.0.0.1" }));
    const out = formatLogArgs(["peers %j", peers]);
    assert.doesNotMatch(out, /null/);
    assert.ok(out.endsWith(TRUNCATION_MARKER), out.slice(-60));
    assert.ok(out.length <= 16 * 1024);
});

test("%j labels only real cycles [Circular]", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.equal(formatLogArgs(["%j", cyclic]), "[Circular]");
    assert.doesNotMatch(formatLogArgs(["%j", { amount: 10n }]), /Circular/);
    const bad = {
        toJSON() {
            throw new Error("toJSON broke");
        }
    };
    assert.match(formatLogArgs(["%j", bad]), /toJSON broke/);
});

test("printf placeholder output is charged to the budget once", () => {
    const obj = { blob: "x".repeat(1900), more: "y".repeat(1900) };
    const withSpec = formatLogArgs(["state %O", obj, "done"], { maxLength: 6000 });
    assert.ok(withSpec.endsWith(" done"), withSpec.slice(-40));
});

test("numeric placeholders never throw on unconvertible values", () => {
    for (const spec of ["%d", "%i", "%f"]) {
        assert.equal(formatLogArgs([`n ${spec}`, Symbol("x")]), "n NaN");
        assert.equal(formatLogArgs([`n ${spec}`, Object.create(null)]), "n NaN");
    }
});

test("an object whose then getter throws is still formatted", () => {
    const obj = {
        a: 1,
        get then(): unknown {
            throw new Error("nope");
        }
    };
    let out = "";
    assert.doesNotThrow(() => (out = formatLogArgs(["x", obj])));
    assert.match(out, /^x \{a: 1, then: /);
});

test("AggregateError shows its inner errors", () => {
    // Not in this project's TS lib, but present in every supported runtime (Node 15+).
    const AggregateErrorCtor = (globalThis as unknown as { AggregateError: new (errors: unknown[], message: string) => Error }).AggregateError;
    const err = new AggregateErrorCtor([new Error("first inner"), new Error("second inner")], "all failed");
    const out = formatLogArgs([err]);
    assert.match(out, /first inner/);
    assert.match(out, /second inner/);
});

test("%j detects cycles without relying on V8's error text", (t) => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    // Firefox and Safari word the cycle error differently from V8.
    const real = JSON.stringify;
    t.mock.method(JSON, "stringify", (...args: Parameters<typeof JSON.stringify>) => {
        try {
            return real(...args);
        } catch (e) {
            throw e instanceof TypeError ? new TypeError("cyclic object value") : e;
        }
    });
    assert.equal(formatLogArgs(["%j", cyclic]), "[Circular]");
});

test("%j prints undefined for values JSON cannot represent, like util.format", () => {
    function handler() {
        return "secret source";
    }
    assert.equal(formatLogArgs(["cb=%j", handler]), "cb=undefined");
    assert.equal(formatLogArgs(["v=%j", { toJSON: () => undefined }]), "v=undefined");
    assert.equal(formatLogArgs(["v=%j", undefined]), "v=undefined");
});

test("%j keeps a toJSON error even when the value also has a cycle", () => {
    const o: Record<string, unknown> = {
        bad: {
            toJSON() {
                throw new Error("toJSON broke");
            }
        }
    };
    o.self = o;
    assert.match(formatLogArgs(["%j", o]), /toJSON broke/);
});

test("%j never throws when a toJSON error cannot be turned into text", () => {
    const thrown = [
        {
            toString() {
                throw new Error("toString broke");
            }
        },
        Object.defineProperty(new Error(), "message", {
            get() {
                throw new Error("message getter broke");
            }
        })
    ];
    for (const t of thrown) {
        const v = {
            toJSON() {
                throw t;
            }
        };
        let out = "";
        assert.doesNotThrow(() => (out = formatLogArgs(["%j", v])));
        assert.match(out, /^\[Unserializable/);
    }
});

test("%j does not walk the whole value again after a toJSON error", () => {
    let reads = 0;
    const o: Record<string, unknown> = {
        bad: {
            toJSON() {
                throw new Error("toJSON broke");
            }
        }
    };
    for (let i = 0; i < 1000; i++)
        Object.defineProperty(o, `k${i}`, {
            enumerable: true,
            get() {
                reads++;
                return i;
            }
        });
    formatLogArgs(["%j", o], { maxLength: 100 });
    assert.equal(reads, 0);
});

test("%j labels a cycle through a non-enumerable array index [Circular]", () => {
    const a: unknown[] = [];
    Object.defineProperty(a, "0", { value: a, enumerable: false });
    assert.equal(formatLogArgs(["%j", a]), "[Circular]");
});

test("%i parses like util.format: leading digits of a string", () => {
    assert.equal(formatLogArgs(["%i", "12px"]), format("%i", "12px"));
    assert.equal(formatLogArgs(["%i", "12px"]), "12");
    assert.equal(formatLogArgs(["%i", 3.9]), "3");
    assert.equal(formatLogArgs(["%i", -3.9]), "-3");
    assert.equal(formatLogArgs(["%i", 5n]), "5n");
});

test("color escapes in logged strings are stripped, so messages are color-free", () => {
    assert.equal(formatLogArgs(["\x1b[31mred\x1b[0m done"]), "red done");
    assert.equal(formatLogArgs(["%s", "\x1b[1;32mok\x1b[22m"]), "ok");
    assert.equal(formatLogArgs([{ s: "\x1b[31mx\x1b[0m" }]).includes("\x1b"), false);
});

test("8-bit CSI color sequences are stripped too", () => {
    assert.equal(formatLogArgs(["\u009b31mred\u009b0m"]), "red");
});
