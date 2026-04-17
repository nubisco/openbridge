# Dashboard UI

OpenBridge ships a built-in Vue 3 web interface. In production, the daemon serves it as static files at [http://localhost:8582](http://localhost:8582). In development, it runs on its own Vite dev server at [http://localhost:5174](http://localhost:5174) and proxies API calls to the daemon.

> **Tip:** You do not need to run the Vite dev server to use the UI. The daemon always serves the last built version of the UI at port 8582. Only start the Vite server if you are making changes to the UI source code.

---

## Dashboard

The Dashboard is the landing page. It gives you an at-a-glance view of the entire system.

### Plugin status cards

Each loaded plugin appears as a card showing:

- Plugin name and version
- Current status badge (`running`, `error`, `stopped`, etc.)
- Color coding: green for running, red for error, gray for stopped

Clicking a card navigates to the Plugins view with that plugin selected.

### System metrics row

A row of live metrics pulled from `GET /api/system`:

- OS and architecture
- Hostname and IP address
- Node.js version
- Daemon uptime

### Live log panel

The Dashboard includes a real-time log panel that streams entries from `/ws/logs`.

**Features:**

- **Multi-plugin filter** — select one or more plugins to show only their logs. The filter controls are a multi-select dropdown. Selecting no plugins shows all logs.
- **Log level filter** — show only entries at or above a selected severity.
- **Expand mode** — a full-screen toggle that maximizes the log panel, useful for debugging sessions.
- **Auto-scroll** — the panel follows new entries automatically. Scroll up to pause auto-scroll; scroll to the bottom to resume.

---

## Plugins view

The Plugins view lists all loaded plugins with their current status. It is split into a list panel on the left and an inspector panel on the right.

### Plugin list

Each entry shows:

- Plugin name
- Status badge
- Version number

Clicking an entry opens the inspector for that plugin.

### Inspector panel

The inspector has three tabs:

**Overview tab:**

- Manifest details (name, version, description, author)
- Current status
- Restart button — calls `POST /api/daemon/restart` (restarts the whole daemon, not just the plugin)

**Config tab:**

- If the plugin ships a `config.schema.json`, OpenBridge renders a **visual form** with labeled inputs, dropdowns, and toggles based on the schema.
- If no schema is available, a raw **JSON editor** is shown as a fallback.
- A **Save** button writes the updated config via `POST /api/config` and prompts you to restart.

**Logs tab:**

- Live log stream filtered to only this plugin's entries.
- Same expand mode and auto-scroll behavior as the Dashboard log panel.

---

## Accessories (Devices) view

The Accessories view shows all HomeKit accessories currently registered with the HAP bridge.

### Accessory grid

Accessories are displayed as cards in a responsive grid. Each card shows:

- Accessory name
- Service type icon
- A summary of the primary characteristic value (on/off, temperature, etc.)

The grid **auto-polls every 5 seconds** via `GET /api/accessories`, so values stay current without a manual refresh.

### Detail panel

Clicking an accessory card opens a detail panel on the right showing all its services and characteristics.

**Characteristic control:**

- **Boolean characteristics** (On/Off, Active, etc.) are rendered as toggle switches (`NbSwitch` component). Toggling immediately writes the value via `POST /api/accessories/:uuid/characteristics`.
- **Numeric characteristics** are displayed as read-only values (write support for sliders is planned).
- **String characteristics** are displayed as text.

**Device renaming:**
The accessory name shown in the panel can be edited inline. The change is written to the HAP bridge.

> **Tip:** The accessories view reflects the live HAP state. If a plugin has not finished discovering its devices yet, accessories may appear a few seconds after the daemon starts.

---

## Terminal

The Terminal view embeds an [xterm.js](https://xtermjs.org/) terminal emulator connected to one of two WebSocket streams:

**Log stream mode (`/ws/terminal`):**
Shows the daemon's ANSI-formatted log output. This is the same content as the log panel but rendered in a terminal-style font. Read-only.

**Shell mode (`/ws/shell`):**
A full interactive PTY shell — you get a real shell running on the server machine. Type commands, use tab completion, run arbitrary processes.

The terminal uses **JetBrains Mono** loaded from Google Fonts for a clean monospace rendering.

> **Warning:** The shell WebSocket gives full shell access to the machine running OpenBridge. Do not expose port 8582 to untrusted networks.

---

## Settings

The Settings page lets you modify the `bridge` section of your config through a form.

**Editable fields:**

- Bridge name
- HTTP port
- HAP port
- Pincode
- MAC address (username)
- Log level

After saving, the UI shows a banner prompting you to restart the daemon. Bridge identity fields (`pincode`, `username`) require removing and re-pairing the bridge in HomeKit if changed after initial pairing.

**Restart Daemon button:**
Calls `POST /api/daemon/restart`. The daemon process restarts, all plugins go through their full lifecycle again, and the UI reconnects automatically once the daemon is back.

---

## Dev vs. production URL

| Mode           | URL                     | How to start                               |
| -------------- | ----------------------- | ------------------------------------------ |
| Production     | `http://localhost:8582` | `node apps/daemon/dist/index.js`           |
| UI development | `http://localhost:5174` | `pnpm --filter @nubisco/openbridge-ui dev` |

In UI development mode, the Vite server at 5174 proxies `/api/*` and `/ws/*` requests to the daemon at 8582. Both must be running. The daemon does not need to be in dev mode — you can run the compiled daemon while developing the UI.

---

## Related pages

- [Getting Started](/guide/getting-started) — how to run the daemon and open the UI
- [API Reference](/guide/api-reference) — the endpoints the UI uses
- [Architecture](/guide/architecture) — how the UI fits into the overall system
