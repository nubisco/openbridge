# Concepts

This page defines the core vocabulary used throughout OpenBridge. Read it before diving into the plugin API or architecture docs — the terms here appear everywhere.

---

## Plugin

A **plugin** is a Node.js module that extends what OpenBridge can do. Plugins connect to physical or virtual devices, expose them to HomeKit, perform background tasks, or integrate third-party services.

OpenBridge supports two kinds of plugins:

### Native plugins

Written specifically for OpenBridge using `@openbridge/sdk`. They export a `Plugin` object with a manifest and three lifecycle hooks (`setup`, `start`, `stop`). The daemon discovers them in `~/.openbridge/plugins/openbridge/` or loads them from explicit paths in `plugins[]` config.

```typescript
import { definePlugin } from '@openbridge/sdk'

export default definePlugin({
  manifest: { name: 'my-plugin', version: '1.0.0' },
  async start(ctx) {
    /* ... */
  },
})
```

### Homebridge plugins

Existing plugins from the Homebridge ecosystem. They use the Homebridge API (`registerPlatform`, `registerPlatformAccessories`) and are loaded through a compatibility shim. They are npm packages installed in `~/.openbridge/plugins/homebridge/node_modules/` and configured via `platforms[]` in config.

See [Homebridge Compatibility](/guide/homebridge-compatibility) for the full picture.

---

## PluginInstance

A **PluginInstance** is the runtime representation of a loaded plugin. The daemon creates one per plugin after loading it from disk. It tracks:

- The plugin's `manifest`
- Its current `status`
- Its resolved `config` (from the `plugins[]` or `platforms[]` entry)
- Any error message if the plugin failed

You see PluginInstances in the UI plugin list and in the `GET /api/plugins` response.

---

## PluginStatus

The status of a plugin at any point in time. Plugins move through these states in order during normal operation:

| Status     | Meaning                                                 |
| ---------- | ------------------------------------------------------- |
| `pending`  | Plugin loaded from disk, waiting for lifecycle to begin |
| `setting`  | `setup()` is currently executing                        |
| `starting` | `start()` is currently executing                        |
| `running`  | `start()` completed — the plugin is active              |
| `stopping` | `stop()` is currently executing                         |
| `stopped`  | `stop()` completed — daemon is shutting down            |
| `error`    | A lifecycle hook threw — plugin is inactive             |

An `error` status does not stop other plugins from running. The daemon logs the full error and continues.

---

## HAP Bridge

The **HAP Bridge** is what Apple HomeKit actually sees and pairs with. It is a virtual device created by hap-nodejs that acts as a gateway for all the accessories managed by OpenBridge.

From HomeKit's perspective, the bridge is a single accessory. The devices your plugins expose appear as accessories "behind" the bridge.

The bridge is identified by:

- Its **name** (`bridge.name` in config) — shown in the Home app
- Its **username** (`bridge.username`) — a MAC address that must be unique per network
- Its **pincode** (`bridge.pincode`) — the 8-digit code used for initial pairing
- Its **HAP port** (`bridge.hapPort`) — the port HomeKit uses to communicate

The bridge advertises itself on the local network via Bonjour/mDNS. You do not need to configure your router for it unless you have strict firewall rules on `hapPort`.

---

## PlatformAccessory

A **PlatformAccessory** is the Homebridge concept for a device exposed to HomeKit. It wraps a hap-nodejs `Accessory` and adds the Homebridge API surface (`addService`, `getService`, `context`, etc.).

In the OpenBridge Homebridge shim, `PlatformAccessory` has one notable behavior: when a plugin calls `addService()` with a service type that already exists on the accessory, it automatically assigns a unique subtype. This matches Homebridge's behavior and prevents HAP errors from duplicate services.

Native OpenBridge plugins work directly with hap-nodejs `Accessory` objects rather than `PlatformAccessory`.

---

## Characteristic

A **Characteristic** is a single property of a HomeKit accessory — the on/off state of a light, the current temperature of a sensor, the brightness percentage of a bulb.

Every Characteristic has:

- A **UUID** defined by the HAP specification
- A **value** of a specific type (bool, int, float, string, TLV8)
- Optional constraints (min, max, step, valid values)
- Handlers for reads (`onGet`) and writes (`onSet`)

When a user controls a device in the Home app, HomeKit sends a characteristic write to OpenBridge. hap-nodejs calls the registered `onSet` handler, which your plugin implements.

Characteristics live inside **Services** (e.g., the `Lightbulb` service contains `On`, `Brightness`, and `Hue` characteristics). Services live inside **Accessories** (e.g., a physical smart bulb).

---

## Logger

Every plugin gets a **scoped logger** — a `PluginLogger` instance created by `@openbridge/logger` with the plugin name as its scope. All output from a plugin's logger is tagged with that name.

Logs are:

- **Buffered** in memory so the UI can show recent history without a database.
- **Streamed** in real time over WebSocket so the UI log panel updates live.
- **Filterable** by plugin name via `GET /api/logs?plugin=my-plugin`.

The `logLevel` in `bridge` config sets the minimum severity that is recorded. Everything below that level is dropped at the source.

---

## Config

OpenBridge uses a single `~/.openbridge/config.json` file. Within it, plugins are configured in two different sections depending on their type:

**`plugins[]`** — for native OpenBridge plugins:

```json
{ "name": "my-plugin", "enabled": true, "config": { "host": "192.168.1.1" } }
```

**`platforms[]`** — for Homebridge platform plugins:

```json
{ "platform": "ShellyDS9", "plugin": "/path/to/dist/index.js" }
```

The distinction matters because Homebridge plugins use a different loading mechanism and a different config shape (platform name + arbitrary fields) versus native plugins (manifest name + typed `config` object).

See [Config Reference](/guide/config-reference) for the full schema.

---

## Marketplace

The **Marketplace** is the plugin discovery surface built into the UI. It has two sides:

**Homebridge marketplace** — searches the npm registry for packages. Any npm package can appear in search results. Installing a package runs `npm install` in `~/.openbridge/plugins/homebridge/`. After installation, you configure it by adding a `platforms[]` entry.

**Local/native marketplace** — scans `~/.openbridge/plugins/openbridge/` for installed native plugins. There is no central registry for native plugins yet; discovery is local.

The marketplace is powered by these API endpoints:

- `GET /api/marketplace/search?q=` — npm registry search
- `GET /api/marketplace/installed` — installed Homebridge packages
- `GET /api/marketplace/local` — installed native plugins
- `POST /api/marketplace/install` — install a package
- `DELETE /api/marketplace/uninstall/:name` — remove a package

---

## Related pages

- [Architecture](/guide/architecture) — how these pieces connect at runtime
- [Plugin API Reference](/guide/plugin-api) — the full type definitions
- [Homebridge Compatibility](/guide/homebridge-compatibility) — Homebridge-specific concepts in detail
