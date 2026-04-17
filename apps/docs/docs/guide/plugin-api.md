# Plugin API Reference

This page is the authoritative reference for the `@nubisco/openbridge-sdk` and `@nubisco/openbridge-core` types available to plugin authors. For a tutorial approach, see [Creating a Plugin](/guide/creating-a-plugin).

---

## `definePlugin(plugin)`

The entry point for every native plugin. Import it from `@nubisco/openbridge-sdk`.

```typescript
import { definePlugin } from '@nubisco/openbridge-sdk'

export default definePlugin({ ... })
```

**Signature:**

```typescript
function definePlugin(plugin: Plugin): Plugin
```

`definePlugin` is a typed identity function — it returns exactly what you pass in. Its value is purely ergonomic: TypeScript will check the shape of your plugin object at compile time and give you autocompletion on the lifecycle hooks and manifest fields.

Always `export default` your plugin. The daemon uses the default export when it dynamically imports your module.

---

## `Plugin` interface

```typescript
interface Plugin {
  manifest: PluginManifest
  setup?(ctx: PluginContext): void | Promise<void>
  start?(ctx: PluginContext): void | Promise<void>
  stop?(ctx: PluginContext): void | Promise<void>
}
```

All three lifecycle hooks are optional. A valid plugin only needs a `manifest`.

---

## `PluginManifest` interface

```typescript
interface PluginManifest {
  name: string
  version: string
  description?: string
  author?: string
}
```

| Field         | Type     | Required | Description                                                                                                                             |
| ------------- | -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | `string` | **Yes**  | Unique plugin identifier. Must exactly match the `name` in the `plugins[]` config entry. Use lowercase kebab-case (e.g. `"my-sensor"`). |
| `version`     | `string` | **Yes**  | Semantic version string (e.g. `"1.0.0"`). Displayed in the UI plugin inspector.                                                         |
| `description` | `string` | No       | Short human-readable description. Shown in the plugin list in the UI.                                                                   |
| `author`      | `string` | No       | Author name or contact. Not currently displayed in the UI but available via the API.                                                    |

---

## `PluginContext` interface

```typescript
interface PluginContext {
  config: Record<string, unknown>
  log: PluginLogger
}
```

The same `ctx` instance is passed to `setup`, `start`, and `stop`. You can attach additional state to it between calls (e.g. store a timer handle in `start` and read it in `stop`).

| Property | Type                      | Description                                                                                                    |
| -------- | ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `config` | `Record<string, unknown>` | The `config` object from the plugin's `plugins[]` entry in `config.json`. Empty object if no entry is present. |
| `log`    | `PluginLogger`            | Scoped logger. All output is prefixed with the plugin name.                                                    |

---

## `PluginLogger` interface

```typescript
interface PluginLogger {
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}
```

| Method  | Severity | When to use                                                                                                       |
| ------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `debug` | Lowest   | Detailed internals — polling values, raw responses, state transitions. Only visible when `logLevel` is `"debug"`. |
| `info`  | Normal   | Lifecycle events, successful operations, configuration summaries.                                                 |
| `warn`  | Elevated | Unexpected-but-recoverable situations — a retry, a missing optional value, a slow response.                       |
| `error` | Highest  | Failures that need attention. Caught exceptions, unreachable hosts, bad config values.                            |

All log calls are:

- Printed to the daemon's stdout with a timestamp and level prefix.
- Appended to the in-memory log buffer (capped, newest wins).
- Streamed in real time over the `/ws/logs` WebSocket to the UI.
- Filterable by plugin name via `GET /api/logs?plugin=my-plugin`.

---

## `PluginStatus` enum

Tracked internally by `PluginRegistry`. Visible via the plugins API and the UI.

```typescript
enum PluginStatus {
  Pending = 'pending', // Loaded, waiting for setup
  Setting = 'setting', // setup() in progress
  Starting = 'starting', // start() in progress
  Running = 'running', // start() completed successfully
  Stopping = 'stopping', // stop() in progress
  Stopped = 'stopped', // stop() completed
  Error = 'error', // A lifecycle hook threw
}
```

---

## Lifecycle order

The daemon calls hooks in this order:

| Step | Hook         | Notes                                                                                                                        |
| ---- | ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| 1    | `setup(ctx)` | Called once per plugin, sequentially, in config order. Errors here put the plugin in `Error` status and skip `start`.        |
| 2    | `start(ctx)` | Called after all `setup()` calls complete. Errors here put the plugin in `Error` status.                                     |
| 3    | _(running)_  | The plugin is now in `Running` state.                                                                                        |
| 4    | `stop(ctx)`  | Called on SIGINT/SIGTERM, in **reverse** start order. The daemon waits for each `stop()` to resolve before calling the next. |

---

## Error handling

If a lifecycle hook throws (or returns a rejected Promise), the daemon:

1. Logs the error with full stack trace.
2. Sets the plugin's status to `Error`.
3. Continues loading remaining plugins — one bad plugin does not block others.

For `stop()`: errors are logged but do not prevent the daemon from shutting down. Always resolve cleanly if possible.

**Best practice — wrap your main logic in try/catch:**

```typescript
async start(ctx) {
  try {
    await initialize(ctx.config)
  } catch (err) {
    ctx.log.error('Initialization failed', err)
    // Optionally re-throw to put the plugin in Error state:
    throw err
  }
},
```

---

## Tips for long-running plugins

### Always clean up in `stop()`

The daemon waits for `stop()` before exiting. Uncleared timers and open sockets will delay shutdown and may cause the process to hang.

```typescript
// In start():
const timer = setInterval(() => {
  /* ... */
}, 5000)
const server = net.createServer(/* ... */)

// Attach to ctx so stop() can reach them
;(ctx as any)._timer = timer
;(ctx as any)._server = server

// In stop():
clearInterval((ctx as any)._timer)
await new Promise<void>((resolve) => (ctx as any)._server.close(resolve))
```

### Do not block `setup()` or `start()`

These hooks run sequentially. If your `setup()` takes 30 seconds, every other plugin waits. Move slow initialization into a background task started in `start()`:

```typescript
async start(ctx) {
  // Fire and forget — do not await
  runInBackground(ctx).catch(err => ctx.log.error('Background task failed', err))
},
```

### Handle missing config gracefully

`ctx.config` is whatever the user put in their config file. Validate it and provide sensible defaults rather than crashing:

```typescript
const host = (ctx.config.host as string | undefined) ?? '192.168.1.1'
const timeout = (ctx.config.timeout as number | undefined) ?? 5000
```

### Avoid calling `process.exit()`

Let the daemon manage the process lifetime. If your plugin encounters a fatal error, throw from the lifecycle hook — the daemon will mark you as errored and continue operating.

---

## `PluginInstance` type

This is what the API returns when you query `GET /api/plugins` or `GET /api/plugins/:id`. It is the runtime view of a loaded plugin:

```typescript
interface PluginInstance {
  id: string // Same as manifest.name
  manifest: PluginManifest
  status: PluginStatus
  error?: string // Set if status === 'error'
  config: Record<string, unknown>
}
```

---

## Related pages

- [Creating a Plugin](/guide/creating-a-plugin) — tutorial with working examples
- [Config Reference](/guide/config-reference) — how to configure plugins in `config.json`
- [API Reference](/guide/api-reference) — the `/api/plugins` endpoints
