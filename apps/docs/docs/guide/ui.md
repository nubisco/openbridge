---
layout: nubisco
title: Dashboard UI
intro: 'OpenBridge ships a built-in Vue 3 web interface.'
---

In production, the daemon serves it as static files at [http://localhost:8582](http://localhost:8582). In development, it runs on its own Vite dev server at [http://localhost:5174](http://localhost:5174) and proxies API calls to the daemon.

> **Tip:** You do not need to run the Vite dev server to use the UI. The daemon always serves the last built version of the UI at port 8582. Only start the Vite server if you are making changes to the UI source code.

---

## House

A drawing of your home, floor by floor, with every device where it really is and showing what it is doing now. Once a plan is saved, OpenBridge opens on this page instead of the Dashboard.

**Drawing the plan.** Choose **Start drawing** (or **Edit plan** later). The blueprint fills the page, and what you select, with the devices not on the plan yet, opens in the inspector beside it (under the blueprint on a phone). You draw rooms, not walls: The tools are icons along the top of the blueprint: hover over one (or press and hold on a phone) to see its name.

- **Room**, **Garden**, **Paving** and **Pool:** drag on the grid to draw a rectangle. It snaps to half a metre. A room gets walls on every edge, and an edge two rooms share is one wall. A garden, paving (a terrace, a path, a drive, the deck round a pool) and a pool have no walls. Draw a pool inside its paving. You can change a room's type later in its panel.
- **Rooms within rooms:** draw a room inside another, such as an en-suite inside a bedroom or the house on its garden. A device belongs to the smallest room around it, and moving a room carries the rooms inside it along.
- **L and U shapes:** select a room, choose **Add a wing**, and draw a rectangle along one of its edges. The wing joins the room with no wall between them. Each part has its own corner handles, and a part can be removed from the room's panel.
- **Door** and **Window:** tap a wall. Drag one you placed along the wall to move it (it can go round onto another wall), or drag one of its ends to resize it. Both move in quarter metres, so a door can sit in the middle of any wall. Select a door to flip its hinge or the side it opens into.
- **Radiator:** tap a wall, on the side the radiator hangs, to put one there. Drag it along the wall to move it, drag an end to resize it, and set its width or switch sides in its panel. A heating circuit serving the room runs through its radiators instead of under the floor.
- **Furniture:** pick a table, a cabinet, a kitchen island or a bed, then drag on the plan to draw it to size, or tap to put one of the usual size there. It moves and resizes in quarter metres, and its panel sets its width, depth and height, turns it, or removes it. Furniture is drawn as plain shapes in one quiet tone, so the plan does not impose a style. A light placed on a piece is a lamp standing on it, and a sensor on one sits on top of it.
- **Open wall:** tap a wall between two rooms that has nothing there in real life, such as a kitchen open to the living room. The whole wall the two rooms share is left out, and you can drag its ends to keep part of it standing.
- **Select:** drag a room to move it (its doors, windows, furniture and devices move with it), or drag a corner to resize it.
- **+ Floor** adds a floor above the top one, starting as one room the size of the floor below. The floor below shows as a dashed outline, so you can trace over it.
- **Devices:** drag a device from _Not on the plan yet_ onto the plan, or tap it and then tap where it is. A shutter dropped near a window attaches to that window. For a heating device, tick the rooms its water circuit serves. For a gate, set its width and which way it runs. For a light, say how it is mounted: ceiling, wall, floor lamp, table lamp, or in the pool (the default for a light placed in a pool). For anything else, choose what it is drawn as (a power outlet, TV, fridge, washing machine, dehumidifier, robot vacuum or lawn mower), because the bridge only sees the smart plug or relay.

Nothing is saved until you choose **Save plan**. If the plan was saved from another tab in the meantime, OpenBridge loads that version and asks you to redo your change on top of it.

**What the plan shows.** The house is drawn as a model in natural materials, wood floors, plaster walls, grass and water, filling the page. A light that is on lights its room in its own colour and brightness, the floor and the walls, brightest under the lamp. A table lamp lights less of the room than a ceiling light, and a relay driving a lamp glows in a colour you pick. A light placed in a pool lights the whole pool. Shutters show how far they are open, on their window. Heating circuits run through the rooms they serve (under the floor, or through the room's radiators, which glow while hot water flows), staying inside the house (never across a pool or a garden between wings), coloured from blue to red by water temperature, with moving flow while the pump runs. When the plugin reports the water going out and coming back (`supplyTemperature` and `returnTemperature`), the pipe shades from one to the other along its length. Waves move across a pool while a pump or filter placed in it runs, and the water is still when it is off. Appliances are drawn as what they are, with their power draw while they run: a TV's screen lights up, a washing machine's drum turns. Sensors, dehumidifiers, energy meters, cameras and gates show their reading or state. A device that stopped answering is drawn dimmed, never as off.

**Using it.** The sidebar folds to icons while the House is open, and its toggle opens it again for that visit. Zoom with the mouse wheel or a pinch, and drag to move around. The buttons at the right zoom in and out, fit the house back in view at normal zoom, and turn the house a quarter turn either way (remembered in this browser). Markers that would cover each other are pulled apart, the one further back rising on a longer stem. Switch floors with the floor rail (or the up and down arrow keys), or choose **All floors** to see them stacked. **3D** and **2D** switch between the isometric and the top-down view, and **Temperature** and **Humidity** colour each room by a sensor standing in it, with its reading floating over the room. The devices fade back, and the legend says how many rooms have such a sensor. A heat pump's temperature is its water, so it never colours a room. Tapping a device opens its controls in the inspector, and tapping empty space closes it. A camera shows its live picture there, made only while it is open. Tapping a light or a plain switch also turns it on or off. Anything drawn as an appliance or an outlet never switches on a tap, so a stray tap cannot turn off the fridge. A gate always asks before it moves.

**Rooms are the bridge's rooms.** Each device's room comes from the plan, so the Devices page, the device list (`GET /api/devices`) and the AI agent tools report it too. Agents can read the whole plan with the `house` tool. The plan is stored in `~/.openbridge/house.json`.

---

## Dashboard

The Dashboard gives you an at-a-glance view of the entire system. It is the landing page until a house plan is drawn. Once there is a plan, a small live copy of it sits beside System information and opens the House page.

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
- Service type icon, and the room it is in when it is on the house plan
- A summary of the primary characteristic value (on/off, temperature, etc.)

The table view has a **Room** column. Sort by it to see the devices room by room.

The grid **auto-polls every 5 seconds** via `GET /api/accessories`, so values stay current without a manual refresh.

### Detail panel

Clicking an accessory card opens a detail panel on the right showing all its services and characteristics.

A camera shows its live picture at the top of the panel, or a picture every few seconds when it cannot stream.

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

The Settings page lets you modify the `bridge` section of your config through a form. It is the gear near the bottom of the sidebar, apart from the views above it, because it configures the instance rather than showing it. Personal preferences such as the theme live in the user menu when Platform sign-in is enabled.

The last line of the sidebar shows whether the UI is connected to the daemon.

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

## Notifications

The bell in the sidebar, between Sponsor and Settings, lists what happened while you were away. OpenBridge adds a row when:

- a device has not reported for 10 minutes (or for four of its own reporting intervals, if it reports less often), and again when it answers after such an outage
- a plugin fails to load or stops with an error
- a new version of OpenBridge or of an installed plugin is published (once per version)

Each row opens what it is about: the device, the plugin, or Settings. The badge is the number of rows you have not read yet, counted by the daemon. Rows arrive live in every open tab. From the panel's settings button you can also turn on desktop notifications for this browser.

Rows are kept in `~/.openbridge/notifications.json` (the newest 200), and read state is kept per signed-in person.

Devices that never report telemetry (most Homebridge accessories) cannot be watched this way, so they never produce an offline row.

---

## On a phone

Every page works on a phone. On the House page the floor rail moves under the plan. The sidebar becomes a drawer behind the menu button, tables become cards, page actions fold into a single menu, and inspectors open as a full-height sheet. The desktop layout is unchanged.

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
