## Example

```JavaScript
import Logger from '@pkcprotocol/pkc-logger'
const log = Logger('my-app:something:something-else')
log('this is a log')
log.error('this is an error')
log.trace('this is a trace')
```

```console
$ DEBUG=my-app:* node dist/test
  my-app:test:something this is a log +0ms
  my-app:test:something:error this is an error +0ms
  my-app:test:something:trace this is a trace +0ms
$ DEBUG=my-app:test:something node dist/test
  my-app:test:something this is a log +0ms
  my-app:test:something this is an error +1ms
$ DEBUG=my-app:test:* node dist/test
  my-app:test:something this is a log +0ms
  my-app:test:something:error this is an error +0ms
  my-app:test:something:trace this is a trace +0ms
$ DEBUG=my-app:error node dist/test
  my-app:error this is an error +0ms
$ DEBUG=my-app:trace node dist/test
  my-app:trace this is a log +0ms
  my-app:trace this is an error +0ms
  my-app:trace this is a trace +3ms
$ DEBUG=my-app:test:something:trace node dist/test
  my-app:test:something:trace this is a log +0ms
  my-app:test:something:trace this is an error +1ms
  my-app:test:something:trace this is a trace +0ms
$ DEBUG=my-app:test:*,-*:trace node dist/test
  my-app:test:something this is a log +0ms
  my-app:test:something:error this is an error +0ms
```
