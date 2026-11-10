# Changelog

## [0.3.0](https://github.com/pkcprotocol/pkc-logger/compare/v0.2.0...v0.3.0) (2026-11-10)

### ⚠ BREAKING CHANGES

* tags are Record<string, string> everywhere (child,
createLogger, Logger, entry.tags, logger.tags, getLogs). The string[] form
throws. getLogs({ tags }) matches by exact key and value instead of by
value under any key, and printed lines show [key=value] pairs.

### Features

* keyed tags with live setTags through the parent chain ([#7](https://github.com/pkcprotocol/pkc-logger/issues/7)) ([b4e9350](https://github.com/pkcprotocol/pkc-logger/commit/b4e935078a9e1f3980f2083103241a9c35ba5e58)), closes [#6](https://github.com/pkcprotocol/pkc-logger/issues/6)

## [0.2.0](https://github.com/pkcprotocol/pkc-logger/compare/v0.1.2...v0.2.0) (2026-11-09)

### ⚠ BREAKING CHANGES

* Logger("ns") and child("ns") throw; pass { namespace }.
0.1.2 released this change as a patch by mistake.

### Features

* require Logger({ namespace }) instead of the Logger(namespace) string signature ([#4](https://github.com/pkcprotocol/pkc-logger/issues/4)) ([3b85d48](https://github.com/pkcprotocol/pkc-logger/commit/3b85d481031db34bb11ae42302573c34fabb92ca))

## [0.1.2](https://github.com/pkcprotocol/pkc-logger/compare/v0.1.1...v0.1.2) (2026-11-09)

### Features

* roots with tagged child loggers, in-memory buffer, query and listener API ([#2](https://github.com/pkcprotocol/pkc-logger/issues/2)) ([968741e](https://github.com/pkcprotocol/pkc-logger/commit/968741eece1b31f011e2c10cdc8003351a297664)), closes [pkcprotocol/pkc-logger#1](https://github.com/pkcprotocol/pkc-logger/issues/1) [pkcprotocol/pkc-js#493](https://github.com/pkcprotocol/pkc-js/issues/493)

## [0.1.1](https://github.com/pkcprotocol/pkc-logger/compare/v0.1.0...v0.1.1) (2026-11-09)

## 0.1.0 (2026-04-17)

### ⚠ BREAKING CHANGES

* uses new single-issue libp2p interface modules

### Features

* add CI/CD with automated npm publishing and versioning ([9d3291a](https://github.com/pkcprotocol/pkc-logger/commit/9d3291ac99cb603445094478b3cbb85f1d3032c5))
* update to latest libp2p dependencies ([#4](https://github.com/pkcprotocol/pkc-logger/issues/4)) ([7775b9b](https://github.com/pkcprotocol/pkc-logger/commit/7775b9b2a51be5672bdc2640da85cae0510ef6bd))
