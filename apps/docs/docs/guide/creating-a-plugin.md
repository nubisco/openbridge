# Creating a Plugin

Native OpenBridge plugins are TypeScript modules that export a plugin object. They have access to a typed config, a scoped logger, and three lifecycle hooks. This guide walks through building, configuring, and loading a real plugin.

## Quick start

Install the SDK in your plugin project:

```bash
npm install @nubisco/openbridge-sdk
```

Create the entry file:

```typescript
// src/index.ts
import { definePlugin } from '@nubisco/openbridge-sdk'

export default definePlugin({
  manifest: {
    name: 'my-plugin',
    version: '1.0.0',
    description: 'My first OpenBridge plugin',
    author: 'Your Name',
  },

  async setup(ctx) {
    ctx.log.info('Setup complete')
  },

  async start(ctx) {
    ctx.log.info('Started')
  },

  async stop(ctx) {
    ctx.log.info('Stopped')
  },
})
```

`definePlugin()` is a typed pass-through — it returns the object you give it, but TypeScript will catch any shape errors at compile time. Always `export default` your plugin.

---

## A full working example

Here is a realistic plugin that polls a value on an interval, reads config, and cleans up properly on shutdown:

```typescript
// src/index.ts
import { definePlugin } from '@nubisco/openbridge-sdk'

export default definePlugin({
  manifest: {
    name: 'temperature-logger',
    version: '1.0.0',
    description: 'Logs temperature from a local sensor on a configurable interval',
    author: 'Jane Dev',
  },

  async setup(ctx) {
    ctx.log.info('Initializing temperature logger')
    ctx.log.debug('Config received', ctx.config)
  },

  async start(ctx) {
    const host = (ctx.config.host as string) ?? 'localhost'
    const interval = (ctx.config.pollInterval as number) ?? 5000

    ctx.log.info(`Polling ${host} every ${interval}ms`)

    // Store the timer handle so we can cancel it in stop()
    const timer = setInterval(async () => {
      try {
        // Replace this with your actual device call
        const temp = await fetchTemperature(host)
        ctx.log.info(`Temperature: ${temp}°C`)
      } catch (err) {
        ctx.log.error('Failed to read temperature', err)
      }
    }, interval)

    // Attach the timer to the context so stop() can reach it.
    // ctx is a plain object — you can add properties to it.
    ;(ctx as any)._timer = timer
  },

  async stop(ctx) {
    const timer = (ctx as any)._timer
    if (timer) {
      clearInterval(timer)
      ctx.log.info('Polling stopped')
    }
  },
})

async function fetchTemperature(host: string): Promise<number> {
  const res = await fetch(`http://${host}/api/temperature`)
  const data = (await res.json()) as { value: number }
  return data.value
}
```

### What this example demonstrates

- **Accessing config** — `ctx.config` is a plain `Record<string, unknown>`. Cast values to the types you expect.
- **Cleanup in `stop()`** — always cancel timers, close sockets, and flush writes in `stop()`. The daemon waits for `stop()` to resolve before exiting.
- **Error isolation** — catching errors inside the interval means one failed poll does not crash the plugin.

---

## Manifest fields

| Field         | Type     | Required | Description                                                                                                |
| ------------- | -------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `name`        | `string` | **Yes**  | Unique plugin identifier. Must match the `name` in the `plugins[]` config entry. Use lowercase kebab-case. |
| `version`     | `string` | **Yes**  | Semantic version string, e.g. `"1.0.0"`.                                                                   |
| `description` | `string` | No       | One-sentence description shown in the UI.                                                                  |
| `author`      | `string` | No       | Author name or email.                                                                                      |

---

## PluginContext API

Every lifecycle hook (`setup`, `start`, `stop`) receives the same `ctx` object:

```typescript
interface PluginContext {
  config: Record<string, unknown>
  log: PluginLogger
}
```

### `ctx.config`

The `config` object from your plugin's entry in `config.json`. It is a plain object — OpenBridge does not validate its shape (that is up to you). Access it with type assertions or validate it with Zod at runtime.

```typescript
// Simple assertion
const port = (ctx.config.port as number) ?? 3000

// Zod validation (recommended for production plugins)
import { z } from 'zod'

const ConfigSchema = z.object({
  host: z.string().default('localhost'),
  port: z.number().int().min(1).max(65535).default(3000),
})

const config = ConfigSchema.parse(ctx.config)
```

### `ctx.log` — PluginLogger

```typescript
interface PluginLogger {
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}
```

Every call is automatically prefixed with the plugin name. Log entries are:

- Printed to the daemon's stdout.
- Buffered in memory (retrievable via `GET /api/logs?plugin=my-plugin`).
- Streamed in real time over WebSocket to the UI log panel.

---

## Lifecycle order

| Hook         | When it is called                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `setup(ctx)` | Once during daemon startup, before `start`. Use for initialization that does not start polling or listening.                   |
| `start(ctx)` | After all plugins have completed `setup`. Use for polling loops, server listeners, or anything that needs to run continuously. |
| `stop(ctx)`  | On graceful shutdown (SIGINT/SIGTERM), in **reverse** start order. Must resolve before the daemon exits.                       |

All hooks are optional. A plugin that only needs `start` and `stop` does not need to define `setup`.

---

## Loading your plugin

### Option 1 — Auto-discovery (recommended)

Compile your plugin to `dist/index.js` and place the directory in `~/.openbridge/plugins/openbridge/`:

```
~/.openbridge/plugins/openbridge/
  temperature-logger/
    dist/
      index.js
    package.json
```

The daemon will find it automatically on next start. No config entry needed for discovery.

If you want to pass config values, add a `plugins[]` entry:

```json
{
  "plugins": [
    {
      "name": "temperature-logger",
      "enabled": true,
      "config": {
        "host": "192.168.1.50",
        "pollInterval": 10000
      }
    }
  ]
}
```

### Option 2 — Explicit path

Use the `path` field to point the daemon at your plugin directory directly. Useful during development when you do not want to copy files:

```json
{
  "plugins": [
    {
      "name": "temperature-logger",
      "path": "/Users/me/dev/temperature-logger",
      "config": {
        "host": "192.168.1.50"
      }
    }
  ]
}
```

### Option 3 — localPluginSources

Add your workspace's output directory to `localPluginSources` in config. The daemon will scan it the same way it scans the default plugins directory:

```json
{
  "localPluginSources": ["/Users/me/dev/my-plugins/dist"]
}
```

---

## Recommended project structure

```
my-plugin/
  src/
    index.ts        ← Plugin entry — must export default
  dist/
    index.js        ← Compiled output (after tsc or esbuild)
  package.json
  tsconfig.json
```

**`package.json` minimum:**

```json
{
  "name": "openbridge-my-plugin",
  "version": "1.0.0",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc"
  },
  "dependencies": {
    "@nubisco/openbridge-sdk": "*"
  },
  "devDependencies": {
    "typescript": "^5.0.0"
  }
}
```

**`tsconfig.json` minimum:**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "node",
    "outDir": "dist",
    "strict": true
  },
  "include": ["src"]
}
```

---

## Testing

OpenBridge does not provide a test runner. Use whatever you prefer. A simple pattern with Vitest:

```typescript
// src/index.test.ts
import { describe, it, expect, vi } from 'vitest'
import plugin from './index.js'

const mockCtx = {
  config: { host: 'localhost', pollInterval: 1000 },
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}

describe('temperature-logger', () => {
  it('starts without throwing', async () => {
    await plugin.setup?.(mockCtx)
    await plugin.start?.(mockCtx)
    await plugin.stop?.(mockCtx)
  })
})
```

---

## Publishing tips

If you want others to use your plugin:

1. **Namespace your package** — use `openbridge-` as a prefix, e.g. `openbridge-temperature-logger`.
2. **Add `"openbridge-plugin"` to your package.json keywords** — this makes it discoverable in the marketplace search.
3. **Ship a `config.schema.json`** alongside `dist/index.js` — the UI uses this to render a visual config form for your plugin. The schema format is the same as Homebridge uses (JSON Schema draft-07).
4. **Pin your `@nubisco/openbridge-sdk` version** in `peerDependencies` so users get a clear error if there is a version mismatch.

## Next steps

- [Plugin API Reference](/guide/plugin-api) — full interface definitions, all fields, all types
- [Config Reference](/guide/config-reference) — how `plugins[]` entries work
- [Architecture](/guide/architecture) — how the plugin lifecycle fits into the overall system
