# @pkcprotocol/pkc-logger

A small logger on top of [`debug`](https://www.npmjs.com/package/debug) that adds what `debug` lacks: root loggers
you own, child loggers that carry **identifier tags** (a community publicKey, a comment cid, a publication
signature), an **in-memory buffer** you can query by tag, regex and time, and **listeners** for your own sinks.
Namespace filtering is still `DEBUG=...`, so nothing changes for the operator.

Works in Node and in the browser (no Node-only imports).

## Quick start

```js
import Logger from "@pkcprotocol/pkc-logger";

const log = Logger({ namespace: "my-app:thing" });
log("this is a log");
log.error("this is an error");
log.trace("this is a trace");
```

```console
$ DEBUG=my-app:* node app.js
  my-app:thing this is a log +0ms
  my-app:thing:error this is an error +0ms
  my-app:thing:trace this is a trace +0ms
```

`Logger({ namespace })` is a child of a **process-default root** that prints but keeps no buffer. It is the right
tool for code that has no instance in scope (a CLI command, a test, a script).

## Roots, children and tags

```js
import { createLogger } from "@pkcprotocol/pkc-logger";

const root = createLogger({ buffer: { maxBytes: 4 * 1024 * 1024 } }); // 4 MiB is the default; 0 disables capture

const community = root.child({ namespace: "pkc-js:local-community", tags: [communityPublicKey] });
const update = community.child({ namespace: "update", tags: [commentCid] });

update("recalculated", { replyCount: 3 });
// prints:  pkc-js:local-community:update [<publicKey>, <cid>] recalculated {replyCount: 3} +2ms
```

- A child's namespace is appended to its parent's with a colon, so existing `DEBUG` patterns keep working.
- Tags are a flat `string[]` of identifiers, accumulated down the chain and deduplicated. They are printed in
  brackets after the namespace, so a plain log file stays greppable by identifier.
- A root created without a namespace cannot log directly; use `child({ namespace })`.

## Levels

`log`, `log.error`, `log.trace` map onto `debug` namespaces exactly as before:

| `DEBUG=` | `log()` | `log.error()` | `log.trace()` |
|---|---|---|---|
| `my-app:*` | printed | printed | printed |
| `my-app:thing` | printed | printed | hidden |
| `my-app:error` | hidden | printed | hidden |
| `my-app:trace` | printed | printed | printed |
| `my-app:*,-*:trace` | printed | printed | hidden |

A line that `DEBUG` hides costs nothing: it is not formatted, not buffered and not passed to listeners.

## Entries, buffer and query

Every printed line is formatted **once, at emit**, into a bounded, color-free string (16 KiB cap, depth and length
caps, cycles collapsed, Errors with their stack) and stored as an entry:

```ts
{ seq: number, time: number, level: "log" | "error" | "trace", namespace: string, msg: string, tags: string[] }
```

Each root keeps a byte-bounded ring buffer of its entries (newest evict oldest). Query it from the root or any child:

```js
const { entries, nextCursor } = root.getLogs({
    tags: [communityPublicKey],          // every listed tag must be present
    regex: { source: "failed", flags: "i" }, // tested against `namespace + " " + msg`
    since: Date.now() - 60_000,          // inclusive, epoch ms
    until: Date.now(),
    limit: 200,                          // default 1000, hard cap 10000
    order: "asc",                        // default; "desc" with a limit is a tail
    cursor: lastSeenSeq                  // resume after (asc) / before (desc) this seq
});
```

An invalid query (bad regex, wrong types, unknown field) throws an `InvalidLogQueryError` with
`code === "ERR_INVALID_LOG_QUERY"` before anything is scanned.

## Listeners

```js
const off = root.addListener((entry) => fileStream.write(JSON.stringify(entry) + "\n"));
// ...
off();
```

Listeners receive the root's enabled entries, including ones the buffer does not keep (buffer disabled with
`maxBytes: 0`, or an entry too large to retain; those never show up in `getLogs()`). Three kinds of entry are not
delivered: entries from loggers created with `listeners: false`, listener-error reports, and entries a listener logs
while it is running (see below). As with `EventTarget`, a listener added or re-added during a delivery starts with the
next entry, and an entry logged from inside a listener reaches the later listeners before the entry being delivered. Entries are frozen, since the same object goes to
every listener and into the buffer. The default root exposes `Logger.addListener` / `Logger.removeListener`.

A listener that throws, or an async listener that rejects, never breaks the code that logged. As with a browser's
`EventTarget`, the error is reported and delivery goes on: pkc-logger records one `error` entry,
`uncaught error in listener: <error>`, on `<root namespace>:listener` (`pkc-logger:listener` for a root without a
namespace). That entry is always buffered, printed only when its namespace is enabled, and never delivered to a listener.
So a sink should let its errors escape rather than catch and log them:

```js
root.addListener(async (entry) => {
    await fetch(url, { method: "POST", body: JSON.stringify(entry) }); // a failure is logged for you
});
```

To log anything else from inside a listener, use a child created with `listeners: false`. Its entries (and its
descendants') go to the buffer and `debug` but never to listeners:

```js
const sinkLog = root.child({ namespace: "my-app:sink", listeners: false });
root.addListener(async (entry) => {
    await appendFile(path, JSON.stringify(entry) + "\n");
    sinkLog("wrote", entry.seq);
});
```

**Do not log from an async listener through an ordinary logger of the same root.** A synchronous listener is never
handed entries it logs while running, but after an `await` pkc-logger cannot tell the listener's own entries from
anyone else's, so each one is delivered back to it and the listener loops forever.

## Static controls

`Logger.enable(namespaces)`, `Logger.disable()`, `Logger.enabled(namespaces)` forward to `debug` and are global.

## Migrating from 0.1.0

- `Logger("my-app:thing")` is now `Logger({ namespace: "my-app:thing" })`. The old call throws with a hint.
- Everything else is additive.
