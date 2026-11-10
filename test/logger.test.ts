import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { format } from "node:util";
import Debug from "debug";
import Logger, { createLogger, InvalidLogQueryError, DEFAULT_BUFFER_MAX_BYTES, MAX_QUERY_LIMIT } from "../src/index.js";
import type { LogEntry } from "../src/index.js";

// Capture what `debug` would print instead of writing to stderr.
const printed: string[] = [];
Debug.log = (...args: unknown[]) => {
    printed.push(format(...args));
};

beforeEach(() => {
    printed.length = 0;
    Logger.enable("my-app:*");
});

test("the 0.1.0 string signature throws a migration hint", () => {
    // @ts-expect-error the string signature was removed in 0.2.0
    assert.throws(() => Logger("my-app:x"), /replaced by Logger\({ namespace }\).*0\.2\.0/);
    const root = createLogger();
    // @ts-expect-error the string signature was removed in 0.2.0
    assert.throws(() => root.child("x"), /replaced by child\({ namespace }\)/);
});

test("Logger({ namespace }) requires a namespace and validates options", () => {
    // @ts-expect-error namespace is required
    assert.throws(() => Logger({}), /requires a namespace/);
    assert.throws(() => Logger({ namespace: "" }), /invalid/);
    assert.throws(() => Logger({ namespace: "a", tags: { cid: "" } }), /Logger tags must be/);
});

test("child namespaces concatenate with a colon and tags merge down the chain", () => {
    const root = createLogger();
    assert.equal(root.namespace, undefined);
    assert.deepEqual(root.tags, {});
    const community = root.child({ namespace: "pkc-js:local-community", tags: { publicKey: "PK1" } });
    const update = community.child({ namespace: "update", tags: { cid: "CID1" } });
    const same = update.child({});
    assert.equal(community.namespace, "pkc-js:local-community");
    assert.equal(update.namespace, "pkc-js:local-community:update");
    assert.equal(same.namespace, "pkc-js:local-community:update");
    assert.deepEqual(update.tags, { publicKey: "PK1", cid: "CID1" });
    assert.deepEqual(same.tags, { publicKey: "PK1", cid: "CID1" });
    assert.ok(Object.isFrozen(update.tags));
});

test("a namespace-less root cannot log directly", () => {
    const root = createLogger();
    assert.throws(() => root("x"), /no namespace/);
});

test("disabled namespaces format nothing, capture nothing, notify nobody", () => {
    Logger.disable();
    const root = createLogger();
    const log = root.child({ namespace: "my-app:quiet", tags: { t: "T" } });
    let listened = 0;
    root.addListener(() => listened++);
    // The formatter reads `then` on every object (promise detection), so this getter observes formatting.
    let thenReads = 0;
    const spy = {
        get then() {
            thenReads++;
            return undefined;
        }
    };
    log("hello", spy);
    log.error("hello", spy);
    log.trace("hello", spy);
    assert.equal(root.getLogs().entries.length, 0);
    assert.equal(listened, 0);
    assert.equal(printed.length, 0);
    assert.equal(thenReads, 0);
    // Prove the spy does observe formatting, so the zero above means something.
    Logger.enable("my-app:*");
    log("hello", spy);
    assert.ok(thenReads > 0);
});

test("enabled lines become entries with the level of the method called", () => {
    const root = createLogger();
    const log = root.child({ namespace: "my-app:thing", tags: { publicKey: "PK1" } });
    const before = Date.now();
    log("one", { a: 1 });
    log.error("two");
    log.trace("three");
    const { entries, nextCursor } = root.getLogs();
    assert.equal(entries.length, 3);
    assert.deepEqual(
        entries.map((e) => [e.level, e.msg]),
        [
            ["log", "one {a: 1}"],
            ["error", "two"],
            ["trace", "three"]
        ]
    );
    for (const e of entries) {
        assert.equal(e.namespace, "my-app:thing");
        assert.deepEqual(e.tags, { publicKey: "PK1" });
        assert.ok(e.time >= before && e.time <= Date.now());
    }
    assert.deepEqual(
        entries.map((e) => e.seq),
        [0, 1, 2]
    );
    assert.equal(nextCursor, 2);
});

test("the level cascade matches 0.1.0", () => {
    const root = createLogger();
    const log = root.child({ namespace: "my-app:cascade" });
    const levels = () => root.getLogs().entries.map((e) => e.level);

    Logger.enable("my-app:error");
    log("l");
    log.error("e");
    log.trace("t");
    assert.deepEqual(levels(), ["error"]);

    Logger.enable("my-app:cascade");
    log("l");
    log.error("e");
    log.trace("t");
    assert.deepEqual(levels(), ["error", "log", "error"]);

    Logger.enable("my-app:trace");
    log("l");
    log.error("e");
    log.trace("t");
    assert.deepEqual(levels(), ["error", "log", "error", "log", "error", "trace"]);

    Logger.enable("my-app:*,-*:trace");
    log.trace("t");
    assert.deepEqual(levels().length, 6);
});

test("printed lines keep the debug look and show tags in brackets after the namespace", () => {
    const root = createLogger();
    root.child({ namespace: "my-app:print", tags: { publicKey: "PK1", cid: "CID1" } })("hello %s", "there", { n: 1 });
    root.child({ namespace: "my-app:print" })("no tags");
    assert.equal(printed.length, 2);
    assert.match(printed[0]!, /my-app:print \[publicKey=PK1, cid=CID1\] hello there \{n: 1\}/);
    assert.match(printed[1]!, /my-app:print no tags/);
    assert.doesNotMatch(printed[1]!, /\[/);
});

test("a message containing % is printed verbatim", () => {
    const root = createLogger();
    root.child({ namespace: "my-app:pct" })("100%d done %s");
    assert.match(printed[0]!, /my-app:pct 100%d done %s/);
    assert.equal(root.getLogs().entries[0]!.msg, "100%d done %s");
});

test("listeners receive exactly the captured entries, can unsubscribe, and may throw", () => {
    const root = createLogger();
    const log = root.child({ namespace: "my-app:listen" });
    const seen: LogEntry[] = [];
    const off = root.addListener((e) => seen.push(e));
    root.addListener(() => {
        throw new Error("faulty sink");
    });
    log("a");
    Logger.disable();
    log("hidden");
    Logger.enable("my-app:*");
    log("b");
    assert.deepEqual(
        seen.map((e) => e.msg),
        ["a", "b"]
    );
    // the faulty sink's errors are buffered too, but never delivered to a listener
    const entries = root.getLogs().entries;
    assert.deepEqual(entries.filter((e) => e.namespace !== "pkc-logger:listener"), seen);
    assert.equal(entries.filter((e) => e.namespace === "pkc-logger:listener").length, 2);
    off();
    log("c");
    assert.equal(seen.length, 2);
    // a child's addListener registers on the root
    const unsubChild = log.addListener((e) => seen.push(e));
    log("d");
    assert.equal(seen[2]!.msg, "d");
    unsubChild();
});

test("the process-default root prints but keeps no buffer", () => {
    const log = Logger({ namespace: "my-app:default", tags: { x: "X" } });
    const seen: string[] = [];
    const off = Logger.addListener((e) => seen.push(e.msg));
    log("hello");
    off();
    log("after");
    assert.equal(printed.length, 2);
    assert.match(printed[0]!, /my-app:default \[x=X\] hello/);
    assert.deepEqual(seen, ["hello"]);
    assert.deepEqual(log.getLogs().entries, []);
});

test("createLogger defaults to a 4 MiB buffer and 0 disables capture but keeps seq monotonic", () => {
    assert.equal(DEFAULT_BUFFER_MAX_BYTES, 4 * 1024 * 1024);
    const root = createLogger({ buffer: { maxBytes: 0 } });
    const log = root.child({ namespace: "my-app:off" });
    const seen: number[] = [];
    root.addListener((e) => seen.push(e.seq));
    log("a");
    log("b");
    assert.deepEqual(root.getLogs().entries, []);
    assert.deepEqual(seen, [0, 1]);
    assert.throws(() => createLogger({ buffer: { maxBytes: -1 } }), /non-negative/);
});

test("the buffer evicts oldest entries to stay under maxBytes", () => {
    const maxBytes = 2000;
    const root = createLogger({ buffer: { maxBytes } });
    const log = root.child({ namespace: "my-app:evict" });
    for (let i = 0; i < 200; i++) log(`line ${i} ${"x".repeat(50)}`);
    const { entries } = root.getLogs();
    assert.ok(entries.length > 5 && entries.length < 30, `unexpected ${entries.length}`);
    assert.equal(entries[entries.length - 1]!.msg.slice(0, 8), "line 199");
    const bytes = entries.reduce((n, e) => n + 64 + e.msg.length + e.namespace.length, 0);
    assert.ok(bytes <= maxBytes, `${bytes} > ${maxBytes}`);
    // an entry larger than the whole buffer is dropped without evicting what is there
    log("z".repeat(maxBytes));
    assert.equal(root.getLogs().entries[root.getLogs().entries.length - 1]!.msg.slice(0, 8), "line 199");
});

function seed() {
    const root = createLogger();
    const a = root.child({ namespace: "my-app:a", tags: { publicKey: "PK1" } });
    const b = root.child({ namespace: "my-app:b", tags: { publicKey: "PK2", cid: "CID1" } });
    const ab = root.child({ namespace: "my-app:a:b", tags: { publicKey: "PK1", cid: "CID1" } });
    a("alpha one");
    b("beta two");
    ab("gamma three");
    a.error("alpha failed");
    return root;
}

test("query by tags matches exact key and value, AND over the listed keys", () => {
    const root = seed();
    assert.deepEqual(
        root.getLogs({ tags: { publicKey: "PK1" } }).entries.map((e) => e.msg),
        ["alpha one", "gamma three", "alpha failed"]
    );
    assert.deepEqual(
        root.getLogs({ tags: { publicKey: "PK1", cid: "CID1" } }).entries.map((e) => e.msg),
        ["gamma three"]
    );
    assert.deepEqual(root.getLogs({ tags: { publicKey: "PK3" } }), { entries: [] });
    // the same value under another key does not match
    assert.deepEqual(root.getLogs({ tags: { parentCid: "CID1" } }), { entries: [] });
    assert.deepEqual(root.getLogs({ tags: { cid: "PK1" } }), { entries: [] });
    // an empty record is no filter
    assert.equal(root.getLogs({ tags: {} }).entries.length, 4);
    // a name every object inherits is not a tag
    assert.deepEqual(root.getLogs({ tags: { constructor: "Object" } }), { entries: [] });
});

test("query by regex tests namespace and message", () => {
    const root = seed();
    assert.deepEqual(
        root.getLogs({ regex: { source: "failed" } }).entries.map((e) => e.msg),
        ["alpha failed"]
    );
    assert.deepEqual(
        root.getLogs({ regex: { source: "^my-app:a " } }).entries.map((e) => e.msg),
        ["alpha one", "alpha failed"]
    );
    assert.deepEqual(
        root.getLogs({ regex: { source: "BETA", flags: "i" } }).entries.map((e) => e.msg),
        ["beta two"]
    );
    // a global regex keeps no lastIndex state between entries
    assert.equal(root.getLogs({ regex: { source: "a", flags: "g" } }).entries.length, 4);
});

test("query by time range", () => {
    const root = seed();
    const all = root.getLogs().entries;
    const t = all[1]!.time;
    assert.ok(root.getLogs({ since: t }).entries.length >= 3);
    assert.ok(root.getLogs({ until: t }).entries.length >= 2);
    assert.deepEqual(root.getLogs({ since: t + 100_000 }).entries, []);
});

test("cursor walks forward without duplicates or gaps; desc gives a tail", () => {
    const root = createLogger();
    const log = root.child({ namespace: "my-app:walk" });
    for (let i = 0; i < 25; i++) log(`n${i}`);
    const seen: number[] = [];
    let cursor: number | undefined;
    for (;;) {
        const page = root.getLogs({ limit: 10, cursor });
        if (page.entries.length === 0) break;
        seen.push(...page.entries.map((e) => e.seq));
        cursor = page.nextCursor;
    }
    assert.deepEqual(
        seen,
        Array.from({ length: 25 }, (_, i) => i)
    );
    const tail = root.getLogs({ order: "desc", limit: 3 });
    assert.deepEqual(
        tail.entries.map((e) => e.msg),
        ["n24", "n23", "n22"]
    );
    assert.equal(tail.nextCursor, 22);
    assert.deepEqual(
        root.getLogs({ order: "desc", limit: 3, cursor: tail.nextCursor }).entries.map((e) => e.msg),
        ["n21", "n20", "n19"]
    );
});

test("limit defaults to 1000 and is capped at 10000", () => {
    const root = createLogger();
    const log = root.child({ namespace: "my-app:many" });
    for (let i = 0; i < MAX_QUERY_LIMIT + 5; i++) log("m");
    assert.equal(root.getLogs().entries.length, 1000);
    assert.equal(root.getLogs({ limit: 50_000 }).entries.length, MAX_QUERY_LIMIT);
});

test("invalid queries throw ERR_INVALID_LOG_QUERY before scanning", () => {
    const root = seed();
    const bad: Array<[unknown, RegExp]> = [
        [{ regex: { source: "(" } }, /invalid regex/],
        [{ regex: "x" }, /regex must be/],
        [{ tags: "PK1" }, /tags must be/],
        [{ tags: ["PK1"] }, /tags must be/],
        [{ tags: { cid: undefined } }, /tags must be/],
        [{ tags: { cid: null } }, /tags must be/],
        [{ tags: { cid: "" } }, /tags must be/],
        [{ tags: { cid: 1 } }, /tags must be/],
        [{ tags: { "": "CID1" } }, /tags must be/],
        [{ tags: new Map([["cid", "CID1"]]) }, /tags must be/],
        [{ limit: 0 }, /limit must be/],
        [{ limit: 1.5 }, /limit must be/],
        [{ cursor: -1 }, /cursor must be/],
        [{ order: "up" }, /order must be/],
        [{ since: "now" }, /since must be/],
        [{ since: 5, until: 1 }, /since must be <= until/],
        [{ bogus: 1 }, /unknown query field 'bogus'/],
        [[], /query must be an object/]
    ];
    for (const [q, re] of bad) {
        assert.throws(
            () => root.getLogs(q as never),
            (err: unknown) => err instanceof InvalidLogQueryError && (err as InvalidLogQueryError).code === "ERR_INVALID_LOG_QUERY" && re.test((err as Error).message),
            `expected ${re} for ${format("%o", q)}`
        );
    }
});

// --- regression tests (each written to reproduce the bug before its fix) ---

test("a rejecting async listener does not cause an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => unhandled.push(r);
    process.on("unhandledRejection", onUnhandled);
    try {
        const root = createLogger();
        root.addListener(async () => {
            throw new Error("async sink failed");
        });
        root.child({ namespace: "my-app:async" })("hello");
        await new Promise((r) => setTimeout(r, 20));
        assert.deepEqual(unhandled, []);
    } finally {
        process.off("unhandledRejection", onUnhandled);
    }
});

test("mutating a delivered entry does not change the logger's tags or buffered history", () => {
    const root = createLogger();
    const log = root.child({ namespace: "my-app:m", tags: { publicKey: "PK1" } });
    root.addListener((entry) => {
        try {
            (entry.tags as Record<string, string>).evil = "EVIL";
        } catch {
            // frozen: fine
        }
    });
    log("one");
    const [first] = root.getLogs().entries;
    try {
        (first!.tags as Record<string, string>).publicKey = "EVIL2";
    } catch {
        // frozen: fine
    }
    log("two");
    for (const e of root.getLogs().entries) assert.deepEqual(e.tags, { publicKey: "PK1" });
    assert.deepEqual(log.tags, { publicKey: "PK1" });
});

test("query by an until bound returns exactly the entries at or before it", (t) => {
    let now = 1000;
    t.mock.method(Date, "now", () => now);
    const root = createLogger();
    const log = root.child({ namespace: "my-app:time" });
    for (const [time, msg] of [[1000, "before"], [2000, "at"], [3000, "after"]] as const) {
        now = time;
        log(msg);
    }
    assert.deepEqual(root.getLogs({ until: 2000 }).entries.map((e) => e.msg), ["before", "at"]);
});

test("evicted entries are released, not kept until compaction", async () => {
    const { LogRingBuffer } = await import("../src/ring-buffer.js");
    const buf = new LogRingBuffer(2000);
    for (let i = 0; i < 100; i++) buf.push({ time: i, level: "log", namespace: "n", msg: "x".repeat(50), tags: {} });
    const slots = (buf as unknown as { entries: (LogEntry | undefined)[] }).entries;
    const head = (buf as unknown as { head: number }).head;
    assert.ok(head > 0);
    for (let i = 0; i < head; i++) assert.equal(slots[i], undefined, `slot ${i} still holds an evicted entry`);
});

test("a listener that logs through the same root does not receive its own entries", () => {
    const root = createLogger();
    const sinkLog = root.child({ namespace: "my-app:sink" });
    let calls = 0;
    root.addListener((entry) => {
        calls++;
        sinkLog("saw", entry.seq);
    });
    root.child({ namespace: "my-app:app" })("hello");
    assert.equal(calls, 1);
    assert.deepEqual(root.getLogs().entries.map((e) => e.msg), ["hello", "saw 0"]);
});

test("a failing listener is called once and its error is logged once, to no listener", async () => {
    const root = createLogger();
    let asyncCalls = 0;
    let syncCalls = 0;
    const seen: string[] = [];
    root.addListener(async () => {
        asyncCalls++;
        await null;
        throw new Error("async sink down");
    });
    root.addListener(() => {
        syncCalls++;
        throw new Error("sync sink down");
    });
    root.addListener((e) => seen.push(e.msg));
    root.child({ namespace: "my-app:app" })("hello");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(asyncCalls, 1);
    assert.equal(syncCalls, 1);
    assert.deepEqual(seen, ["hello"]);
    const failures = root.getLogs().entries.filter((e) => e.namespace === "pkc-logger:listener");
    assert.equal(failures.length, 2);
    for (const f of failures) {
        assert.equal(f.level, "error");
        assert.match(f.msg, /^uncaught error in listener: /);
    }
    assert.ok(failures.some((f) => f.msg.includes("async sink down")));
    assert.ok(failures.some((f) => f.msg.includes("sync sink down")));
});

test("a listener failure is buffered even when its namespace is disabled, under the root's namespace", () => {
    Logger.enable("my-app:app");
    const root = createLogger({ namespace: "my-app" });
    root.addListener(() => {
        throw new Error("down");
    });
    root.child({ namespace: "app" })("hello");
    const failure = root.getLogs().entries.find((e) => e.namespace === "my-app:listener");
    assert.ok(failure, "failure entry missing from the buffer");
    assert.equal(printed.some((l) => l.includes("uncaught error in listener")), false);
});

test("an async sink logging after an await through a listeners:false child is not re-invoked", async () => {
    const root = createLogger();
    const sinkLog = root.child({ namespace: "my-app:sink", listeners: false });
    const MAX = 20; // bound the loop so a regression fails instead of hanging the runner
    let calls = 0;
    root.addListener(async (entry) => {
        calls++;
        await null;
        if (calls < MAX) sinkLog.child({ namespace: "inner" })("wrote", entry.seq);
    });
    root.child({ namespace: "my-app:app" })("hello");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls, 1);
    assert.deepEqual(root.getLogs().entries.map((e) => e.msg), ["hello", "wrote 0"]);
});

test("like EventTarget, listeners added or re-added during delivery wait for the next entry", () => {
    const root = createLogger();
    const log = root.child({ namespace: "my-app:snap" });
    const calls: string[] = [];
    const reAdded = (e: LogEntry) => calls.push(`reAdded ${e.msg}`);
    const added = (e: LogEntry) => calls.push(`added ${e.msg}`);
    root.addListener((e) => {
        if (e.msg !== "one") return;
        root.removeListener(reAdded);
        root.addListener(reAdded);
        root.addListener(added);
    });
    root.addListener(reAdded);
    log("one");
    log("two");
    assert.deepEqual(calls, ["reAdded two", "added two"]);
});

test("like EventTarget, an entry logged inside a listener reaches later listeners first", () => {
    // A nested dispatchEvent runs to completion before the outer one continues; delivery matches that.
    const root = createLogger();
    const sinkLog = root.child({ namespace: "my-app:nested" });
    const order: number[] = [];
    root.addListener((e) => {
        if (e.seq === 0) sinkLog("nested");
    });
    root.addListener((e) => order.push(e.seq));
    root.child({ namespace: "my-app:app" })("outer");
    assert.deepEqual(order, [1, 0]);
});

test("a descendant cannot turn listener delivery back on", () => {
    const root = createLogger();
    let calls = 0;
    root.addListener(() => calls++);
    root.child({ namespace: "my-app:quiet", listeners: false }).child({ namespace: "loud", listeners: true })("x");
    assert.equal(calls, 0);
    assert.equal(root.getLogs().entries.length, 1);
});

test("a stale unsubscribe function does not remove a newer subscription", () => {
    const root = createLogger();
    const log = root.child({ namespace: "my-app:unsub" });
    const seen: string[] = [];
    const sink = (e: LogEntry) => seen.push(e.msg);
    const off1 = root.addListener(sink);
    off1();
    root.addListener(sink);
    off1(); // double cleanup of the old subscription
    log("still subscribed");
    assert.deepEqual(seen, ["still subscribed"]);
});

test("the 0.2.0 string[] tags are rejected everywhere, not thrown out of a later log call", () => {
    const root = createLogger();
    // @ts-expect-error tags are a record since 0.3.0
    assert.throws(() => root.child({ namespace: "my-app:array", tags: ["a"] }), /child tags must be/);
    // @ts-expect-error tags are a record since 0.3.0
    assert.throws(() => createLogger({ tags: ["a"] }), /createLogger tags must be/);
    // @ts-expect-error tags are a record since 0.3.0
    assert.throws(() => root.setTags(["a"]), /setTags tags must be/);
    // @ts-expect-error tags are a record since 0.3.0
    assert.throws(() => root.getLogs({ tags: ["a"] }), InvalidLogQueryError);
});

test("null query fields are rejected instead of falling back to defaults", () => {
    const root = createLogger();
    for (const field of ["tags", "limit", "order"])
        assert.throws(() => root.getLogs({ [field]: null } as never), InvalidLogQueryError, `${field}: null was accepted`);
});

test("a regex with duplicate flags is rejected", () => {
    assert.throws(() => createLogger().getLogs({ regex: { source: "a", flags: "gg" } }), InvalidLogQueryError);
    assert.throws(() => createLogger().getLogs({ regex: { source: "a", flags: "ii" } }), InvalidLogQueryError);
    assert.doesNotThrow(() => createLogger().getLogs({ regex: { source: "a", flags: "gi" } }));
});

test("a sticky regex matches only at the start, on every entry", () => {
    const root = createLogger();
    root.child({ namespace: "my-app:sub" })("hello");
    root.child({ namespace: "my-app:other" })("mentions my-app:sub mid-line");
    root.child({ namespace: "my-app:sub" })("again");
    const hits = root.getLogs({ regex: { source: "my-app:sub", flags: "y" } }).entries.map((e) => e.msg);
    assert.deepEqual(hits, ["hello", "again"]);
    const global = root.getLogs({ regex: { source: "my-app:sub", flags: "g" } }).entries.length;
    assert.equal(global, 3);
});

test("query tags are read once, so a changing record cannot skip validation", () => {
    const root = createLogger();
    root.child({ namespace: "my-app:t", tags: { a: "A" } })("x");
    let reads = 0;
    const tags = new Proxy({ a: "A" } as Record<string, string>, {
        get(target, key, receiver) {
            if (key === "a") return reads++ === 0 ? "A" : undefined;
            return Reflect.get(target, key, receiver);
        }
    });
    let result: unknown;
    try {
        result = root.getLogs({ tags }).entries.length;
    } catch (e) {
        result = e;
    }
    assert.equal(result, 1);
});

test("getLogs(null) is rejected", () => {
    assert.throws(() => createLogger().getLogs(null as never), InvalidLogQueryError);
});

// --- keyed, live tags (0.3.0) ---

test("a child key shadows an ancestor's same key, and the ancestor's value is absent from the child's entry", () => {
    const root = createLogger();
    const post = root.child({ namespace: "my-app:comment", tags: { publicKey: "PK1", cid: "POST" } });
    const reply = post.child({ namespace: "reply", tags: { cid: "REPLY" } });
    const both = post.child({ namespace: "reply", tags: { replyCid: "REPLY" } });
    assert.deepEqual(reply.tags, { publicKey: "PK1", cid: "REPLY" });
    assert.deepEqual(post.tags, { publicKey: "PK1", cid: "POST" });
    reply("shadowed");
    both("distinct key");
    assert.deepEqual(root.getLogs({ tags: { cid: "POST" } }).entries.map((e) => e.msg), ["distinct key"]);
    assert.deepEqual(root.getLogs({ tags: { cid: "REPLY" } }).entries.map((e) => e.msg), ["shadowed"]);
    assert.match(printed[0]!, /\[publicKey=PK1, cid=REPLY\] shadowed/);
    assert.match(printed[1]!, /\[publicKey=PK1, cid=POST, replyCid=REPLY\] distinct key/);
});

test("setTags reaches the logger and children created before the call; ancestors are untouched", () => {
    const root = createLogger({ tags: { app: "A" } });
    const community = root.child({ namespace: "my-app:community", tags: { publicKey: "PK1" } });
    const helper = community.child({ namespace: "db" });
    const deep = helper.child({ namespace: "query", tags: { table: "comments" } });
    helper("before");
    community.setTags({ publicKey: "PK2" });
    community("renamed");
    helper("after");
    deep("deep");
    assert.deepEqual(community.tags, { app: "A", publicKey: "PK2" });
    assert.deepEqual(helper.tags, { app: "A", publicKey: "PK2" });
    assert.deepEqual(deep.tags, { app: "A", publicKey: "PK2", table: "comments" });
    assert.deepEqual(root.tags, { app: "A" });
    assert.deepEqual(
        root.getLogs().entries.map((e) => [e.msg, e.tags]),
        [
            ["before", { app: "A", publicKey: "PK1" }],
            ["renamed", { app: "A", publicKey: "PK2" }],
            ["after", { app: "A", publicKey: "PK2" }],
            ["deep", { app: "A", publicKey: "PK2", table: "comments" }]
        ]
    );
    assert.match(printed[2]!, /my-app:community:db \[app=A, publicKey=PK2\] after/);
});

test("setTags replaces the own record: an omitted key is gone, an inherited one stays", () => {
    const root = createLogger();
    const parent = root.child({ namespace: "my-app:p", tags: { publicKey: "PK1" } });
    const log = parent.child({ tags: { signature: "SIG", cid: "CID1" } });
    log.setTags({ signature: "SIG" });
    assert.deepEqual(log.tags, { publicKey: "PK1", signature: "SIG" });
    log.setTags({});
    assert.deepEqual(log.tags, { publicKey: "PK1" });
    log("no own tags");
    assert.deepEqual(root.getLogs().entries[0]!.tags, { publicKey: "PK1" });
});

test("undefined tag values are dropped: not on the entry, not printed", () => {
    const root = createLogger();
    const log = root.child({ namespace: "my-app:pub", tags: { signature: "SIG", cid: undefined } });
    assert.deepEqual(log.tags, { signature: "SIG" });
    assert.deepEqual(Object.keys(log.tags), ["signature"]);
    log("unpublished");
    log.setTags({ signature: "SIG", cid: "CID1" });
    log("published");
    log.setTags({ signature: undefined, cid: undefined });
    log("cleared");
    assert.deepEqual(
        root.getLogs().entries.map((e) => e.tags),
        [{ signature: "SIG" }, { signature: "SIG", cid: "CID1" }, {}]
    );
    assert.match(printed[0]!, /my-app:pub \[signature=SIG\] unpublished/);
    assert.match(printed[1]!, /my-app:pub \[signature=SIG, cid=CID1\] published/);
    assert.match(printed[2]!, /my-app:pub cleared/);
    assert.doesNotMatch(printed[2]!, /\[/);
});

test("buffered entries keep the tags they were emitted with", () => {
    const root = createLogger();
    const log = root.child({ namespace: "my-app:frozen", tags: { cid: "OLD" } });
    log("one");
    const before = root.getLogs().entries[0]!;
    log.setTags({ cid: "NEW" });
    log("two");
    assert.deepEqual(before.tags, { cid: "OLD" });
    assert.deepEqual(root.getLogs({ tags: { cid: "OLD" } }).entries.map((e) => e.msg), ["one"]);
    assert.deepEqual(root.getLogs({ tags: { cid: "NEW" } }).entries.map((e) => e.msg), ["two"]);
    assert.ok(Object.isFrozen(before.tags));
    assert.ok(Object.isFrozen(log.tags));
});

test("the caller's record is copied, so mutating it later changes nothing", () => {
    const root = createLogger();
    const given: Record<string, string> = { cid: "CID1" };
    const log = root.child({ namespace: "my-app:copy", tags: given });
    given.cid = "EVIL";
    assert.deepEqual(log.tags, { cid: "CID1" });
    const next: Record<string, string> = { cid: "CID2" };
    log.setTags(next);
    next.cid = "EVIL";
    assert.deepEqual(log.tags, { cid: "CID2" });
});

test("a setTags elsewhere leaves an unrelated logger's record the same object", () => {
    const root = createLogger();
    const a = root.child({ namespace: "my-app:a", tags: { cid: "A" } });
    const b = root.child({ namespace: "my-app:b", tags: { cid: "B" } });
    const bChild = b.child({ namespace: "helper" });
    const otherRoot = createLogger().child({ namespace: "my-app:other", tags: { cid: "O" } });
    const [bTags, otherTags] = [b.tags, otherRoot.tags];
    // a logger with no tags of its own shares its parent's record
    assert.equal(bChild.tags, bTags);
    a.setTags({ cid: "A2" });
    assert.equal(b.tags, bTags);
    assert.equal(bChild.tags, bTags);
    assert.equal(otherRoot.tags, otherTags);
    b("x");
    b("y");
    const [x, y] = root.getLogs().entries;
    assert.equal(x!.tags, bTags);
    assert.equal(y!.tags, bTags);
    // setting the same tags again keeps the record too
    b.setTags({ cid: "B" });
    assert.equal(b.tags, bTags);
    b.setTags({ cid: "B2" });
    assert.notEqual(b.tags, bTags);
});

test("a __proto__ key is stored, printed and queried as an ordinary key", () => {
    const root = createLogger();
    const tags = JSON.parse('{"__proto__":"P","cid":"CID1"}') as Record<string, string>;
    const log = root.child({ namespace: "my-app:proto", tags });
    const child = log.child({ tags: { other: "O" } });
    child("hello");
    assert.deepEqual(Object.keys(child.tags), ["__proto__", "cid", "other"]);
    assert.equal(Object.getPrototypeOf(child.tags), Object.prototype);
    assert.match(printed[0]!, /\[__proto__=P, cid=CID1, other=O\] hello/);
    assert.equal(root.getLogs({ tags: JSON.parse('{"__proto__":"P"}') as Record<string, string> }).entries.length, 1);
    assert.equal(root.getLogs({ tags: JSON.parse('{"__proto__":"X"}') as Record<string, string> }).entries.length, 0);
});

test("invalid tags throw from child, createLogger and setTags, and leave the logger unchanged", () => {
    const root = createLogger();
    const log = root.child({ namespace: "my-app:valid", tags: { cid: "CID1" } });
    const bad: unknown[] = ["cid", 1, null, ["a"], { cid: "" }, { cid: 1 }, { cid: null }, { "": "x" }, new Map([["cid", "x"]])];
    for (const tags of bad) {
        const what = format("%o", tags);
        assert.throws(() => root.child({ namespace: "my-app:bad", tags: tags as never }), /child tags must be/, what);
        assert.throws(() => createLogger({ tags: tags as never }), /createLogger tags must be/, what);
        assert.throws(() => log.setTags(tags as never), /setTags tags must be/, what);
    }
    assert.throws(() => log.setTags(undefined as never), /setTags tags must be/);
    assert.deepEqual(log.tags, { cid: "CID1" });
});

test("buffer cost counts tag keys and values", async () => {
    const { entryCost } = await import("../src/ring-buffer.js");
    const base = { seq: 0, time: 0, level: "log", namespace: "n", msg: "m" } as const;
    const bare = entryCost({ ...base, tags: {} });
    assert.equal(entryCost({ ...base, tags: { cid: "12345", parentCid: "1" } }), bare + "cid".length + 5 + "parentCid".length + 1);
});
