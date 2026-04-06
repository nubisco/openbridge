# API Reference

The OpenBridge daemon exposes a REST API and four WebSocket streams, all on port 8581 (configurable via `bridge.port`). The base URL for all REST endpoints is `http://localhost:8581`.

All REST responses are JSON unless noted. All request bodies must be `Content-Type: application/json`.

---

## Health & System

### `GET /api/health`

Returns the daemon's current health status. Use this for uptime monitoring or readiness checks.

**Response:**

```json
{
  "status": "ok",
  "version": "0.1.0",
  "timestamp": "2026-04-05T12:00:00.000Z"
}
```

---

### `GET /api/system`

Returns information about the host machine.

**Response:**

```json
{
  "os": "darwin",
  "arch": "arm64",
  "hostname": "my-mac.local",
  "ip": "192.168.1.10",
  "nodeVersion": "v20.11.0",
  "uptime": 3600
}
```

| Field         | Description                                            |
| ------------- | ------------------------------------------------------ |
| `os`          | Operating system platform (`linux`, `darwin`, `win32`) |
| `arch`        | CPU architecture (`x64`, `arm64`)                      |
| `hostname`    | Machine hostname                                       |
| `ip`          | Primary local IP address                               |
| `nodeVersion` | Node.js version string                                 |
| `uptime`      | Daemon uptime in seconds                               |

---

### `GET /api/qr`

Returns the HomeKit setup URI and pincode. Use the URI to render a QR code or for deep-linking into the Home app.

**Response:**

```json
{
  "setupURI": "X-HM://0098Y4QXZL2031451540",
  "pincode": "031-45-154"
}
```

---

## Plugins

### `GET /api/plugins`

Returns all loaded plugins (native and Homebridge).

**Response:**

```json
{
  "plugins": [
    {
      "id": "my-plugin",
      "manifest": {
        "name": "my-plugin",
        "version": "1.0.0",
        "description": "My plugin",
        "author": "Jane Dev"
      },
      "status": "running",
      "config": { "host": "192.168.1.1" }
    }
  ]
}
```

---

### `GET /api/plugins/:id`

Returns a single plugin by its ID (which equals `manifest.name`).

**Path parameters:**

| Param | Description                    |
| ----- | ------------------------------ |
| `id`  | Plugin name (e.g. `my-plugin`) |

**Response:** A single `PluginInstance` object (same shape as the items in `GET /api/plugins`).

**404** if no plugin with that ID is loaded.

---

### `POST /api/plugins/refresh`

Re-scans the Homebridge plugins directory and updates the plugin list without a full daemon restart. New platform configurations still require a restart to initialize.

**Response:**

```json
{ "ok": true }
```

---

## Accessories

### `GET /api/accessories`

Returns all HomeKit accessories currently registered with the HAP bridge.

**Response:**

```json
{
  "accessories": [
    {
      "uuid": "550e8400-e29b-41d4-a716-446655440000",
      "name": "Living Room Light",
      "services": [
        {
          "uuid": "...",
          "type": "Lightbulb",
          "characteristics": [{ "uuid": "...", "type": "On", "value": true }]
        }
      ]
    }
  ]
}
```

---

### `POST /api/accessories/:uuid/characteristics`

Writes a characteristic value to an accessory. This is how the UI controls devices.

**Path parameters:**

| Param  | Description    |
| ------ | -------------- |
| `uuid` | Accessory UUID |

**Request body:**

```json
{
  "serviceUuid": "service-uuid-here",
  "charUuid": "characteristic-uuid-here",
  "value": true
}
```

**Response:**

```json
{
  "serviceUuid": "service-uuid-here",
  "charUuid": "characteristic-uuid-here",
  "value": true
}
```

---

### `GET /api/accessories/debug`

Returns a lightweight summary of all accessories. Useful for troubleshooting without the full serialized accessory tree.

**Response:**

```json
{
  "count": 4,
  "names": ["Living Room Light", "Kitchen Switch", "Front Door Lock", "Thermostat"]
}
```

---

## Configuration

### `GET /api/config`

Returns the raw config file content as a JSON string. Note: the `content` field is a string (not a parsed object) so the caller controls parsing.

**Response:**

```json
{
  "content": "{\"bridge\":{\"name\":\"OpenBridge\",\"port\":8581},...}"
}
```

---

### `POST /api/config`

Overwrites the entire config file. The `content` field must be a valid JSON string that passes the config schema validation.

**Request body:**

```json
{
  "content": "{\"bridge\":{\"name\":\"My Bridge\",\"port\":8581,...}}"
}
```

**Response:**

```json
{ "ok": true }
```

---

### `GET /api/config/platform/:name`

Returns the config for a specific platform entry by its `platform` name.

**Path parameters:**

| Param  | Description                      |
| ------ | -------------------------------- |
| `name` | Platform name (e.g. `ShellyDS9`) |

**Response:**

```json
{
  "config": {
    "platform": "ShellyDS9",
    "plugin": "/path/to/dist/index.js",
    "username": "admin"
  }
}
```

**404** if no platform with that name exists in config.

---

### `POST /api/config/platform`

Creates or updates a platform entry in `platforms[]`. If an entry with the same `platform` name already exists, it is replaced.

**Request body:** A platform config object:

```json
{
  "platform": "ShellyDS9",
  "plugin": "/path/to/dist/index.js",
  "username": "admin",
  "password": "secret"
}
```

**Response:**

```json
{ "ok": true }
```

---

### `GET /api/bridge`

Returns the current `bridge` config object.

**Response:**

```json
{
  "name": "OpenBridge",
  "port": 8581,
  "hapPort": 51826,
  "pincode": "031-45-154",
  "username": "AA:BB:CC:DD:EE:FF",
  "logLevel": "info"
}
```

---

### `POST /api/bridge`

Updates one or more fields in the `bridge` config. Partial updates are supported — only the fields you include are changed.

**Request body:**

```json
{
  "name": "My Bridge",
  "logLevel": "debug"
}
```

**Response:**

```json
{ "ok": true }
```

---

## Marketplace

### `GET /api/marketplace/search`

Searches the npm registry for Homebridge plugins.

**Query parameters:**

| Param  | Default | Description                 |
| ------ | ------- | --------------------------- |
| `q`    | `""`    | Search query                |
| `from` | `0`     | Pagination offset           |
| `size` | `20`    | Number of results to return |

**Response:**

```json
{
  "results": [
    {
      "name": "homebridge-shelly-ds9",
      "version": "1.2.3",
      "description": "Homebridge plugin for Shelly DS9",
      "author": "someone",
      "date": "2025-01-01T00:00:00.000Z"
    }
  ],
  "total": 142
}
```

---

### `GET /api/marketplace/installed`

Returns all Homebridge plugins currently installed in `~/.openbridge/plugins/homebridge/node_modules/`.

**Response:**

```json
{
  "plugins": [
    {
      "name": "homebridge-shelly-ds9",
      "version": "1.2.3",
      "path": "/Users/me/.openbridge/plugins/homebridge/node_modules/homebridge-shelly-ds9"
    }
  ]
}
```

---

### `GET /api/marketplace/local`

Returns all native OpenBridge plugins found in the plugins directories.

**Response:**

```json
{
  "plugins": [
    {
      "name": "my-sensor",
      "version": "1.0.0",
      "path": "/Users/me/.openbridge/plugins/openbridge/my-sensor"
    }
  ]
}
```

---

### `GET /api/marketplace/plugin-info/:name`

Returns platform metadata for an installed Homebridge plugin — specifically, the platform names it registers.

**Path parameters:**

| Param  | Description      |
| ------ | ---------------- |
| `name` | npm package name |

**Response:**

```json
{
  "platforms": ["ShellyDS9", "ShellyGen3"]
}
```

---

### `GET /api/marketplace/plugin-schema/:name`

Returns the `config.schema.json` for an installed plugin, if it exists.

**Path parameters:**

| Param  | Description      |
| ------ | ---------------- |
| `name` | npm package name |

**Response:**

```json
{
  "schema": {
    "pluginAlias": "ShellyDS9",
    "pluginType": "platform",
    "schema": {
      "type": "object",
      "properties": { "username": { "type": "string" } }
    }
  }
}
```

**404** if the plugin does not ship a schema file.

---

### `POST /api/marketplace/install`

Installs a Homebridge plugin package via npm.

**Request body:**

```json
{
  "package": "homebridge-shelly-ds9"
}
```

**Response:**

```json
{ "ok": true }
```

This runs `npm install <package>` in `~/.openbridge/plugins/homebridge/`. The operation is synchronous — the response returns after installation completes.

---

### `DELETE /api/marketplace/uninstall/:name`

Uninstalls a Homebridge plugin package.

**Path parameters:**

| Param  | Description                |
| ------ | -------------------------- |
| `name` | npm package name to remove |

**Response:**

```json
{ "ok": true }
```

---

## Logs

### `GET /api/logs`

Returns buffered log entries from the in-memory log store.

**Query parameters:**

| Param    | Default | Description                         |
| -------- | ------- | ----------------------------------- |
| `plugin` | _(all)_ | Filter by plugin name               |
| `limit`  | `200`   | Maximum number of entries to return |

**Response:**

```json
{
  "entries": [
    {
      "timestamp": "2026-04-05T12:00:00.000Z",
      "level": "info",
      "plugin": "my-plugin",
      "message": "Plugin started"
    }
  ]
}
```

**`LogEntry` fields:**

| Field       | Type                                     | Description                        |
| ----------- | ---------------------------------------- | ---------------------------------- |
| `timestamp` | `string`                                 | ISO 8601 timestamp                 |
| `level`     | `"debug" \| "info" \| "warn" \| "error"` | Log severity                       |
| `plugin`    | `string`                                 | Plugin name that emitted the entry |
| `message`   | `string`                                 | Log message                        |

---

## Daemon

### `POST /api/daemon/restart`

Restarts the daemon process. All plugins go through their full `stop` → `start` lifecycle.

**Response:**

```json
{ "restarting": true }
```

The connection will drop immediately after this response. The UI reconnects automatically once the daemon is back up (typically within a few seconds).

---

## WebSocket streams

All WebSocket endpoints are at `ws://localhost:8581/ws/*`. Connect using any standard WebSocket client.

### `WS /ws/logs`

Streams live log entries as they are emitted. Each message is a JSON-serialized `LogEntry`:

```json
{
  "timestamp": "2026-04-05T12:00:00.000Z",
  "level": "info",
  "plugin": "my-plugin",
  "message": "Polling device"
}
```

There is no filtering at the WebSocket level — the client receives all entries and filters locally. Use `GET /api/logs?plugin=` for server-side filtering of historical entries.

---

### `WS /ws/metrics`

Streams system and plugin metrics. Messages have a `type` field that distinguishes snapshots from history:

**Snapshot message** (sent on connect and periodically):

```json
{
  "type": "snapshot",
  "data": {
    "uptime": 3600,
    "memory": { "rss": 104857600, "heapUsed": 52428800 },
    "cpu": 0.04
  }
}
```

**History message** (sent on connect to provide initial chart data):

```json
{
  "type": "history",
  "data": [{ "timestamp": "2026-04-05T11:55:00.000Z", "cpu": 0.02, "memory": 50000000 }]
}
```

---

### `WS /ws/terminal`

Streams ANSI-formatted log output suitable for rendering in an xterm.js terminal. Each message is a plain string containing ANSI escape sequences. Read-only — the server ignores any messages sent from the client.

```
[12:00:00] [INFO] [my-plugin] Plugin started\r\n
```

---

### `WS /ws/shell`

An interactive PTY shell. Bidirectional:

- **Client → server:** Send keystrokes as UTF-8 strings.
- **Server → client:** Receive terminal output as UTF-8 strings (with ANSI escape sequences).

This is what the Terminal view in the UI connects to when in shell mode. The shell runs as the same user as the daemon process.

> **Warning:** The shell WebSocket provides full command-line access to the host machine. Never expose port 8581 to an untrusted network without authentication.

---

## Related pages

- [Dashboard UI](/guide/ui) — how the UI uses these endpoints
- [Config Reference](/guide/config-reference) — the config schema behind the config endpoints
- [Homebridge Compatibility](/guide/homebridge-compatibility) — the marketplace endpoints in context
