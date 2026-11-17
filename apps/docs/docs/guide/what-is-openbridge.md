---
layout: nubisco
title: What is OpenBridge?
intro: 'OpenBridge is a TypeScript-first, local-first home automation bridge.'
---

It runs as a Node.js daemon on your local network and connects smart devices to **Apple Home** through HomeKit. That is the same job Homebridge does, and OpenBridge runs Homebridge platform plugins, so it is a bridge first: Apple Home stays where you control your home.

If you have never used Homebridge: OpenBridge makes devices that do not support HomeKit appear in the Home app on your iPhone, iPad and Mac. Your lights, sensors, switches and cameras show up as HomeKit accessories. OpenBridge itself needs no account and no subscription. Whether a device is reached locally or through its maker's cloud depends on the plugin, and the native `-local-` plugins talk to devices on your own network only.

## Why OpenBridge exists

Homebridge is mature, widely used and well supported, with a large plugin ecosystem and its own web interface. OpenBridge does not replace it. It is a different take on the same job, built around a few choices:

- **TypeScript throughout:** the runtime, the SDK and the plugin API are typed end to end.
- **One package:** the daemon serves its own web interface, so the dashboard, plugin manager, device pages and terminal come with it.
- **A view of the whole home:** a plan of your home in 2D and 3D shows each device's live state where it is, and every device keeps its history on the bridge.
- **You choose what Apple Home sees:** each device has an **Expose to HomeKit** switch, so OpenBridge can read a device without adding it to Apple Home twice. The Matter platform plugin goes further and reads Matter devices you already paired with Apple Home, as a second controller.
- **Homebridge compatibility:** existing Homebridge platform plugins run unchanged, next to native OpenBridge plugins.
- **Local by default:** the daemon sends no telemetry. It contacts the internet only to check for updates and to fetch the plugin catalogue and plugins.

## What OpenBridge does, step by step

When you start the daemon, this is what happens in order:

1. **Config is loaded** from `~/.openbridge/config.json` and validated against a Zod schema. Invalid config aborts startup with a clear error.
2. **Native plugins are discovered:** the daemon scans `~/.openbridge/plugins/openbridge/`, finds each subdirectory that contains a `dist/index.js`, and dynamically imports it.
3. **Homebridge plugins are registered:** installed Homebridge plugins are loaded through the Homebridge compatibility layer, and their saved accessories are restored before discovery starts.
4. **Plugin lifecycle runs:** `setup()` is called on every plugin, then `start()`. Errors in one plugin do not prevent others from starting.
5. **The HAP bridge starts:** hap-nodejs advertises the bridge on your local network over Bonjour (mDNS). Apple Home reads and controls the accessories through it.
6. **The Fastify HTTP server starts** on port 8582. It serves the REST API, the WebSocket streams (updates, metrics, logs and the terminal), and the built Vue 3 UI as static files.
7. **On SIGINT or SIGTERM**, `stop()` is called on every plugin in reverse start order, then the server closes cleanly.

## What OpenBridge is NOT

- **Not a cloud service.** There is no hosted version. You run it yourself.
- **Not a replacement for the Home app.** OpenBridge bridges devices into Apple Home. You still use the Home app for automations and scenes.
- **Not a full Homebridge replacement.** Homebridge accessory plugins (non-platform) and child bridges are not supported yet. See [Homebridge Compatibility](/guide/homebridge-compatibility) for the full list.
- **Not stable for production yet.** The API and plugin format may change between releases. Pin your versions.

## OpenBridge vs Homebridge

Both are bridges into Apple Home that run on your own hardware. Where they differ:

|                            | Homebridge                                | OpenBridge                                      |
| -------------------------- | ----------------------------------------- | ----------------------------------------------- |
| Maturity                   | Years in production, very large user base | Young, the API may still change                 |
| Plugins                    | Platform and accessory plugins            | Homebridge platform plugins, and native plugins |
| Plugin directory           | npm, with a verified-plugin programme     | npm, through the OpenBridge Marketplace         |
| Web interface              | Homebridge UI, a separate package         | Built into the daemon                           |
| Child bridges              | Yes                                       | Not yet                                         |
| Saved accessory restore    | Yes                                       | Yes                                             |
| Plan of your home          | No                                        | 2D and 3D, with live state                      |
| History per device         | Through some plugins                      | Built in, kept on the bridge                    |
| Hide a device from HomeKit | Where the plugin offers it                | A switch on every device                        |
| Assistant access (MCP)     | Not built in                              | Optional                                        |

OpenBridge is not affiliated with or endorsed by the Homebridge project or Apple. Apple, Apple Home and HomeKit are trademarks of Apple Inc.

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

Each package has a single responsibility and can be used independently. Plugin authors only need `@nubisco/openbridge-sdk`, which re-exports the types they care about.

## Plugin Marketplace

The [Openbridge Marketplace](https://marketplace.openbridge.nubisco.io) is the community plugin directory for both Openbridge and Homebridge plugins. It indexes publicly available npm packages and provides a searchable interface with community ratings, reviews, and Q&A.

You can discover plugins directly from the marketplace website, or browse and install them from the **Plugins** tab inside the OpenBridge dashboard. The dashboard fetches its plugin catalog from the marketplace API, so the same directory is available regardless of where you are running OpenBridge.

Plugin installation is always performed directly from npm. The marketplace does not host or distribute plugin code.

## Next steps

- [Getting Started](/guide/getting-started) - install, build, run, pair with HomeKit
- [Concepts](/guide/concepts) - vocabulary: plugins, accessories, characteristics, HAP bridge
- [Creating a Plugin](/guide/creating-a-plugin) - build and load your first native plugin
- [Homebridge Compatibility](/guide/homebridge-compatibility) - run existing Homebridge platform plugins
