# What is OpenBridge?

OpenBridge is a TypeScript-first, local-first home automation bridge. It runs as a Node.js daemon on your local network and connects smart devices to **Apple HomeKit** — the same job Homebridge does, but with a modern architecture, a built-in UI, and a plugin API designed for developers.

If you have never used Homebridge: OpenBridge makes non-HomeKit devices appear in the Apple Home app on your iPhone, iPad, and Mac. Your lights, sensors, switches, and cameras show up as native HomeKit accessories — no cloud subscription, no third-party accounts, no data leaving your network.

## Why OpenBridge exists

Homebridge is mature and battle-tested, but it carries significant historical weight: a plugin API that predates modern TypeScript idioms, a UI that is a separate optional project, no structured logging pipeline, and a trust model that can feel opaque to developers.

OpenBridge was built from scratch with different defaults:

- **TypeScript everywhere** — the runtime, the SDK, and the plugin API are all typed end-to-end.
- **Built-in UI** — the dashboard, plugin manager, device inspector, and terminal ship with the daemon. There is nothing extra to install.
- **Structured logging** — every plugin gets a scoped logger. Logs are buffered in memory, streamed over WebSocket, and filterable in the UI in real time.
- **Homebridge compatibility** — existing Homebridge platform plugins work with a one-line config entry. You do not need to rewrite your plugin ecosystem.
- **No cloud. Ever** — the daemon runs entirely on your local machine. No telemetry, no accounts, no remote APIs.

## What OpenBridge does, step by step

When you start the daemon, this is what happens in order:

1. **Config is loaded** from `~/.openbridge/config.json` and validated against a Zod schema. Invalid config aborts startup with a clear error.
2. **Native plugins are discovered** — the daemon scans `~/.openbridge/plugins/openbridge/`, finds each subdirectory that contains a `dist/index.js`, and dynamically imports it.
3. **Homebridge plugins are registered** — each entry in `platforms[]` is loaded from its explicit `plugin` path and initialized through the Homebridge compatibility shim.
4. **Plugin lifecycle runs** — `setup()` is called on every plugin, then `start()`. Errors in one plugin do not prevent others from starting.
5. **The HAP bridge starts** — hap-nodejs advertises the bridge on your local network via Bonjour/mDNS. HomeKit devices poll and control accessories through this interface.
6. **The Fastify HTTP server starts** on port 8581. It serves the REST API, all four WebSocket streams, and the built Vue 3 UI as static files.
7. **On SIGINT or SIGTERM**, `stop()` is called on every plugin in reverse start order, then the server closes cleanly.

## What OpenBridge is NOT

- **Not a cloud service.** There is no hosted version. You run it yourself.
- **Not a replacement for Apple's Home app.** OpenBridge bridges devices into HomeKit; you still use the Home app to create automations and scenes.
- **Not a full Homebridge clone.** Homebridge accessory plugins (non-platform) and child bridges are not supported yet. See [Homebridge Compatibility](/guide/homebridge-compatibility) for the full list.
- **Not stable for production yet.** The API and plugin format may change between releases. Pin your versions.

## OpenBridge vs Homebridge

|                           | Homebridge                  | OpenBridge                       |
| ------------------------- | --------------------------- | -------------------------------- |
| Language                  | JavaScript / TypeScript     | TypeScript only                  |
| Plugin API                | HAP-focused, callback-heavy | Lifecycle hooks, typed context   |
| UI                        | Separate optional project   | Built-in, always available       |
| Structured logging        | No                          | Yes — scoped, buffered, streamed |
| WebSocket log stream      | No                          | Yes                              |
| Config validation         | Partial                     | Full Zod schema                  |
| Homebridge plugin support | Native                      | Compatibility shim               |
| Native plugin SDK         | No                          | `@openbridge/sdk`                |
| Child bridges             | Yes                         | Not yet                          |
| Cached accessory restore  | Yes                         | Not yet                          |
| Cloud dependency          | Never                       | Never                            |

## Monorepo structure

```
openbridge/
  apps/
    daemon/     → Fastify HTTP server, plugin lifecycle engine, HAP bridge
    ui/         → Vue 3 dashboard (served by daemon in production)
    cli/        → Command-line interface (openbridge start, init, etc.)
    docs/       → This documentation (VitePress)
  packages/
    core/       → Plugin interface, PluginRegistry, PluginLifecycle
    sdk/        → definePlugin() helper for plugin authors
    config/     → Zod-validated config load/save
    logger/     → Scoped structured logger, in-memory buffer, subscriptions
    compatibility-homebridge/ → Homebridge API shim
```

Each package has a single responsibility and can be used independently. Plugin authors only need `@openbridge/sdk`, which re-exports the types they care about.

## Next steps

- [Getting Started](/guide/getting-started) — install, build, run, pair with HomeKit
- [Concepts](/guide/concepts) — vocabulary: plugins, accessories, characteristics, HAP bridge
- [Creating a Plugin](/guide/creating-a-plugin) — build and load your first native plugin
- [Homebridge Compatibility](/guide/homebridge-compatibility) — run existing Homebridge platform plugins
