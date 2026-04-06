# Homebridge Compatibility

OpenBridge includes a compatibility shim that lets you run existing Homebridge platform plugins without modification. This page documents what works, what does not work yet, and how to set up a Homebridge plugin from scratch.

---

## What works

| Feature                                                    | Status                                  |
| ---------------------------------------------------------- | --------------------------------------- |
| Platform plugins (`registerPlatform`)                      | Supported                               |
| `registerPlatformAccessories`                              | Supported                               |
| `publishExternalAccessories`                               | Supported                               |
| `configureAccessory` callback                              | Supported                               |
| `config.schema.json` visual forms in the UI                | Supported                               |
| `versionGreaterOrEqual()`                                  | Supported                               |
| User path helpers (`storagePath`, `configPath`, etc.)      | Supported                               |
| `HomebridgeAPI` event emitter (`on('didFinishLaunching')`) | Supported                               |
| Duplicate service subtype auto-assignment                  | Supported (matches Homebridge behavior) |

---

## What does not work yet

| Feature                                          | Status        | Notes                                             |
| ------------------------------------------------ | ------------- | ------------------------------------------------- |
| Accessory plugins (`registerAccessory`)          | Not supported | Only platform plugins work                        |
| Child bridges                                    | Not supported | No separate bridge processes                      |
| Cached accessory restore across restarts         | Not supported | Accessories are re-discovered fresh on each start |
| Dynamic platform `unregisterPlatformAccessories` | Partial       | Logged but no HAP removal yet                     |
| Config editor in Homebridge UI (HOOBS-style)     | N/A           | OpenBridge has its own UI                         |

> **Note on cached accessories:** Many Homebridge plugins call `configureAccessory()` to restore previously paired accessories from a cache. OpenBridge does not maintain this cache yet, so plugins that depend heavily on it may re-register accessories on every restart. In practice this usually works fine, but you may see transient HomeKit "accessory not responding" messages during startup.

---

## How to install a Homebridge plugin

### Step 1 — Install the npm package

Homebridge plugins are installed as npm packages in the dedicated Homebridge plugins directory:

```bash
cd ~/.openbridge/plugins/homebridge
npm install homebridge-shelly-ds9
```

Do not install them globally or in the monorepo. OpenBridge looks for packages specifically in `~/.openbridge/plugins/homebridge/node_modules/`.

### Step 2 — Find the plugin's entry point

```bash
cat ~/.openbridge/plugins/homebridge/node_modules/homebridge-shelly-ds9/package.json \
  | grep '"main"'
# "main": "dist/index.js"
```

The entry point is usually `dist/index.js`. Use the `main` field in `package.json` as the source of truth.

### Step 3 — Determine the platform name

The platform name is what the plugin passes to `registerPlatform()`. You can find it in the plugin's documentation or by searching its source:

```bash
grep -r "registerPlatform" \
  ~/.openbridge/plugins/homebridge/node_modules/homebridge-shelly-ds9/dist/
# api.registerPlatform('ShellyDS9', ShellyPlatform)
```

### Step 4 — Add a `platforms[]` entry to config

```json
{
  "platforms": [
    {
      "platform": "ShellyDS9",
      "plugin": "/Users/me/.openbridge/plugins/homebridge/node_modules/homebridge-shelly-ds9/dist/index.js",
      "name": "Shelly",
      "username": "admin",
      "password": "mysecret"
    }
  ]
}
```

- `platform` — the name string from `registerPlatform()`.
- `plugin` — **absolute path** to the compiled entry file. Use the full path, not a relative one.
- All other fields are forwarded verbatim to the platform constructor as its config object.

### Step 5 — Restart the daemon

```bash
curl -X POST http://localhost:8582/api/daemon/restart
```

Or use the UI: Settings → Restart Daemon.

The plugin will initialize, discover its devices, and register them with the HAP bridge. Accessories typically appear in the Home app within 5–30 seconds depending on the plugin's discovery mechanism.

---

## Refreshing the plugin list

If you install a new Homebridge package while the daemon is running, you can trigger a re-scan without a full restart:

```bash
curl -X POST http://localhost:8582/api/plugins/refresh
```

This re-scans the Homebridge plugins directory and updates the plugin list. New platforms still require a restart to initialize.

---

## `config.schema.json` visual forms

Many Homebridge plugins ship a `config.schema.json` file alongside their compiled code. OpenBridge reads this file and renders a visual form in the UI plugin inspector — you can configure the plugin without hand-editing JSON.

The schema format is standard [JSON Schema draft-07](https://json-schema.org/draft-07/json-schema-validation.html). OpenBridge fetches it via:

```bash
GET /api/marketplace/plugin-schema/:name
# Returns: { schema: { ... } }
```

If the file does not exist, the UI falls back to a raw JSON editor.

---

## Discovery timing

Homebridge plugins typically discover devices using one of two methods:

1. **UDP broadcast / mDNS** — the plugin sends a multicast query and devices respond. Discovery is fast (1–5 seconds) but depends on your network configuration. Multicast must be allowed between OpenBridge and your devices.

2. **HTTP polling / IP scan** — the plugin contacts devices by IP address. Less network-dependent but requires correct IP addresses in config.

If your devices do not appear after a minute, check:

- The plugin's own log output in the UI log panel (filter by plugin name).
- That your firewall allows UDP multicast on the relevant port.
- That the IP addresses and credentials in your `platforms[]` config are correct.

---

## Known gotchas

**Absolute paths are required for `plugin`.**
OpenBridge does not resolve relative paths for the `plugin` field. Always use the full path starting with `/`. The `~` shorthand does not expand in JSON.

**Some plugins assume Homebridge's global npm layout.**
A plugin that calls `require('homebridge')` or tries to import sibling packages by name may fail because the Homebridge shim is not installed globally. Check the plugin's dependencies and install any missing packages in the same `homebridge` directory.

**Platform name must match exactly.**
The `platform` field in config must exactly match the string passed to `registerPlatform()` — case-sensitive. A mismatch means the plugin loads but registers under a different name, and the platform config entry is silently ignored.

**Multiple platforms from the same package.**
If a package registers multiple platforms, add a separate `platforms[]` entry for each one. Each entry gets its own config object.

**Version checks.**
Some plugins call `api.versionGreaterOrEqual('x.y.z')` to gate features. The shim returns `true` for all version checks. If a plugin behaves unexpectedly, this could be the cause.

---

## Related pages

- [Getting Started](/guide/getting-started) — walkthrough of installing your first plugin
- [Config Reference](/guide/config-reference) — `platforms[]` schema in detail
- [Concepts](/guide/concepts) — PlatformAccessory, characteristic, HAP bridge
- [API Reference](/guide/api-reference) — marketplace and plugin API endpoints
