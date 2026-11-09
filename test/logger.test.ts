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
    assert.throws(() => Logger({ namespace: "a", tags: [""] }), /tags must be/);
});

test("child namespaces concatenate with a colon and tags accumulate, deduplicated", () => {
    const root = createLogger();
    assert.equal(root.namespace, undefined);
    const community = root.child({ namespace: "pkc-js:local-community", tags: ["PK1"] });
    const update = community.child({ namespace: "update", tags: ["PK1", "CID1"] });
    const same = update.child({ tags: ["CID1"] });
    assert.equal(community.namespace, "pkc-js:local-community");
    assert.equal(update.namespace, "pkc-js:local-community:update");
    assert.equal(same.namespace, "pkc-js:local-community:update");
    assert.deepEqual([...update.tags], ["PK1", "CID1"]);
    assert.deepEqual([...same.tags], ["PK1", "CID1"]);
    assert.ok(Object.isFrozen(update.tags));
});

test("a namespace-less root cannot log directly", () => {
    const root = createLogger();
    assert.throws(() => root("x"), /no namespace/);
});

test("disabled namespaces format nothing, capture nothing, notify nobody", () => {
    Logger.disable();
    const root = createLogger();
    const log = root.child({ namespace: "my-app:quiet", tags: ["T"] });
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
    const log = root.child({ namespace: "my-app:thing", tags: ["PK1"] });
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
        assert.deepEqual(e.tags, ["PK1"]);
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
    root.child({ namespace: "my-app:print", tags: ["PK1", "CID1"] })("hello %s", "there", { n: 1 });
    root.child({ namespace: "my-app:print" })("no tags");
    assert.equal(printed.length, 2);
    assert.match(printed[0]!, /my-app:print \[PK1, CID1\] hello there \{n: 1\}/);
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
    const log = Logger({ namespace: "my-app:default", tags: ["X"] });
    const seen: string[] = [];
    const off = Logger.addListener((e) => seen.push(e.msg));
    log("hello");
    off();
    log("after");
    assert.equal(printed.length, 2);
    assert.match(printed[0]!, /my-app:default \[X\] hello/);
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
    const a = root.child({ namespace: "my-app:a", tags: ["PK1"] });
    const b = root.child({ namespace: "my-app:b", tags: ["PK2", "CID1"] });
    const ab = root.child({ namespace: "my-app:a:b", tags: ["PK1", "CID1"] });
    a("alpha one");
    b("beta two");
    ab("gamma three");
    a.error("alpha failed");
    return root;
}

test("query by tags is AND", () => {
    const root = seed();
    assert.deepEqual(
        root.getLogs({ tags: ["PK1"] }).entries.map((e) => e.msg),
        ["alpha one", "gamma three", "alpha failed"]
    );
    assert.deepEqual(
        root.getLogs({ tags: ["PK1", "CID1"] }).entries.map((e) => e.msg),
        ["gamma three"]
    );
    assert.deepEqual(root.getLogs({ tags: ["PK3"] }), { entries: [] });
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
    // global/sticky flags are stripped so matching has no lastIndex state
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
        [{ tags: [1] }, /tags must be/],
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
            `expected ${re} for ${JSON.stringify(q)}`
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
    const log = root.child({ namespace: "my-app:m", tags: ["PK1"] });
    root.addListener((entry) => {
        try {
            (entry.tags as string[]).push("EVIL");
        } catch {
            // frozen: fine
        }
    });
    log("one");
    const [first] = root.getLogs().entries;
    try {
        (first!.tags as string[]).push("EVIL2");
    } catch {
        // frozen: fine
    }
    log("two");
    for (const e of root.getLogs().entries) assert.deepEqual(e.tags, ["PK1"]);
    assert.deepEqual(log.tags, ["PK1"]);
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
    for (let i = 0; i < 100; i++) buf.push({ time: i, level: "log", namespace: "n", msg: "x".repeat(50), tags: [] });
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
