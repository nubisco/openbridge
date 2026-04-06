# Config Reference

OpenBridge reads its configuration from a single JSON file. All fields are validated at startup using a Zod schema — invalid config prints a structured error and aborts.

**Default path:** `~/.openbridge/config.json`

You can edit this file by hand, through the UI Settings page, or via the config API endpoints. Changes take effect after a daemon restart.

## Full schema

```json
{
  "bridge": {
    "name": "OpenBridge",
    "port": 8581,
    "hapPort": 51826,
    "pincode": "031-45-154",
    "username": "AA:BB:CC:DD:EE:FF",
    "logLevel": "info"
  },
  "plugins": [
    {
      "name": "my-plugin",
      "path": "/optional/override/path",
      "enabled": true,
      "config": {}
    }
  ],
  "platforms": [
    {
      "platform": "ShellyDS9",
      "plugin": "/Users/me/.openbridge/plugins/homebridge/node_modules/homebridge-shelly-ds9/dist/index.js",
      "anyPlatformConfig": "here"
    }
  ],
  "localPluginSources": []
}
```

---

## `bridge`

The `bridge` object configures both the HTTP server and the HAP bridge that HomeKit sees.

| Field      | Type                                     | Default               | Required | Description                                           |
| ---------- | ---------------------------------------- | --------------------- | -------- | ----------------------------------------------------- |
| `name`     | `string`                                 | `"OpenBridge"`        | No       | Bridge name shown in the Apple Home app               |
| `port`     | `number`                                 | `8581`                | No       | HTTP API and UI port                                  |
| `hapPort`  | `number`                                 | `51826`               | No       | Port hap-nodejs uses for HomeKit communication        |
| `pincode`  | `string`                                 | `"031-45-154"`        | No       | 8-digit PIN for HomeKit pairing. Format: `XXX-XX-XXX` |
| `username` | `string`                                 | `"AA:BB:CC:DD:EE:FF"` | No       | MAC address that uniquely identifies this bridge      |
| `logLevel` | `"debug" \| "info" \| "warn" \| "error"` | `"info"`              | No       | Minimum log severity to record and display            |

**Notes:**

- `hapPort` must be reachable from the device that acts as your Home hub (Apple TV, HomePod, or iPad). If you run OpenBridge behind a firewall, open this port.
- `username` must be unique per bridge on your network. If you run two OpenBridge instances, give each a different `username`. Format is any valid MAC address string.
- Changing `pincode` or `username` after initial pairing requires removing the bridge from the Home app and re-pairing.

---

## `plugins[]`

The `plugins` array configures **native OpenBridge plugins** — those written with `@openbridge/sdk`. Each entry corresponds to one plugin.

| Field     | Type      | Default | Required | Description                                                           |
| --------- | --------- | ------- | -------- | --------------------------------------------------------------------- |
| `name`    | `string`  | —       | **Yes**  | Must exactly match the plugin's `manifest.name`                       |
| `path`    | `string`  | —       | No       | Absolute path to the plugin directory. Overrides auto-discovery       |
| `enabled` | `boolean` | `true`  | No       | Set to `false` to skip loading this plugin without removing the entry |
| `config`  | `object`  | `{}`    | No       | Arbitrary config object passed to the plugin as `ctx.config`          |

**Example:**

```json
{
  "plugins": [
    {
      "name": "my-sensor",
      "enabled": true,
      "config": {
        "host": "192.168.1.42",
        "pollInterval": 10000
      }
    }
  ]
}
```

**Discovery vs. explicit path:**

- If `path` is omitted, the daemon discovers the plugin by scanning `~/.openbridge/plugins/openbridge/` for a subdirectory whose compiled `dist/index.js` exports a plugin with a matching `manifest.name`.
- If `path` is set, that directory is used directly. This is useful for plugins under active development that live outside the plugins directory.

> **Tip:** You do not need a `plugins[]` entry for a plugin to be loaded — discovery is automatic. You only need the entry if you want to pass config values or disable a plugin without removing it from disk.

---

## `platforms[]`

The `platforms` array configures **Homebridge platform plugins**. Each entry maps to one platform that the Homebridge compatibility shim will initialize.

| Field      | Type     | Required | Description                                                               |
| ---------- | -------- | -------- | ------------------------------------------------------------------------- |
| `platform` | `string` | **Yes**  | Platform name — must match what the plugin passes to `registerPlatform()` |
| `plugin`   | `string` | **Yes**  | Absolute path to the plugin's compiled entry file (e.g., `dist/index.js`) |
| _(any)_    | `any`    | No       | All other fields are passed through to the plugin as platform config      |

**Example:**

```json
{
  "platforms": [
    {
      "platform": "ShellyDS9",
      "plugin": "/Users/me/.openbridge/plugins/homebridge/node_modules/homebridge-shelly-ds9/dist/index.js",
      "name": "Shelly",
      "username": "admin",
      "password": "secret"
    }
  ]
}
```

**The `plugin` field:**

This is an OpenBridge addition — Homebridge does not have this field because it resolves plugins globally. In OpenBridge you must point explicitly to the compiled JS file. The path is typically:

```
~/.openbridge/plugins/homebridge/node_modules/<package-name>/dist/index.js
```

Check the `main` field in the package's `package.json` if `dist/index.js` does not exist.

**Per-platform config:**

Every field other than `platform` and `plugin` is forwarded verbatim to the platform's constructor. Refer to each plugin's own documentation for the fields it expects.

---

## `localPluginSources[]`

An array of additional directory paths to scan for native OpenBridge plugins. Each path is scanned the same way as the default `~/.openbridge/plugins/openbridge/` directory.

```json
{
  "localPluginSources": ["/Users/me/dev/my-plugin-workspace/dist", "/Volumes/nas/openbridge-plugins"]
}
```

This is useful for:

- **Development** — point directly to a compiled plugin in your workspace without copying it.
- **Shared plugin collections** — load plugins from a network share or a different machine via SMB/NFS.

---

## Storage paths

OpenBridge uses these paths on disk. All are relative to your home directory:

| Path                                | Purpose                                      |
| ----------------------------------- | -------------------------------------------- |
| `~/.openbridge/config.json`         | Main config file                             |
| `~/.openbridge/plugins/openbridge/` | Native OpenBridge plugins (auto-scanned)     |
| `~/.openbridge/plugins/homebridge/` | Homebridge npm packages (`npm install` here) |
| `~/.openbridge/hap-storage/`        | HAP pairing data — do not delete             |

> **Warning:** Deleting `~/.openbridge/hap-storage/` clears HomeKit pairing data. If you do this, you must remove the bridge from the Apple Home app and re-pair. All your automations and room assignments will be lost.

---

## Editing config via the API

The config API lets you read and write config programmatically:

```bash
# Read current config (returns raw JSON string)
curl http://localhost:8581/api/config

# Overwrite entire config
curl -X POST http://localhost:8581/api/config \
  -H 'Content-Type: application/json' \
  -d '{ "content": "{\"bridge\":{\"name\":\"My Bridge\",\"port\":8581}}" }'

# Read a single platform entry
curl http://localhost:8581/api/config/platform/ShellyDS9

# Upsert a platform entry
curl -X POST http://localhost:8581/api/config/platform \
  -H 'Content-Type: application/json' \
  -d '{ "platform": "ShellyDS9", "plugin": "/path/to/dist/index.js" }'
```

See [API Reference](/guide/api-reference) for the full endpoint documentation.
