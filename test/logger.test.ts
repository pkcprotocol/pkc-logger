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
    let toStringCalls = 0;
    const spy = {
        toString() {
            toStringCalls++;
            return "spy";
        }
    };
    log("hello", spy);
    log.error("hello", spy);
    log.trace("hello", spy);
    assert.equal(root.getLogs().entries.length, 0);
    assert.equal(listened, 0);
    assert.equal(printed.length, 0);
    assert.equal(toStringCalls, 0);
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
    assert.deepEqual(root.getLogs().entries, seen);
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
