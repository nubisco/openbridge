# Getting Started

This guide walks you from zero to a running OpenBridge daemon, paired with HomeKit, with a Homebridge plugin installed. It takes about ten minutes on a machine that already has Node.js.

## Prerequisites

| Requirement | Minimum version | Check            |
| ----------- | --------------- | ---------------- |
| Node.js     | 20.x            | `node --version` |
| pnpm        | 9.x             | `pnpm --version` |
| Git         | any recent      | `git --version`  |

> **Tip:** Use [nvm](https://github.com/nvm-sh/nvm) or [fnm](https://github.com/Schniz/fnm) to manage Node.js versions. OpenBridge is developed and tested on Node 20 LTS.

pnpm is required — the monorepo uses pnpm workspaces and its lockfile format. Install it if you don't have it:

```bash
npm install -g pnpm@9
```

## Installation from source

OpenBridge is currently distributed as source. Clone the repository and install dependencies:

```bash
git clone https://github.com/nubisco/openbridge
cd openbridge
pnpm install
```

`pnpm install` links all workspace packages together so each app can import from sibling packages without publishing to npm.

## Building

Compile all packages and apps:

```bash
pnpm build
```

This runs `tsc` (or `vite build`) in dependency order across the entire monorepo. The output you care about:

- `apps/daemon/dist/` — the compiled daemon
- `apps/ui/dist/` — the compiled Vue app (the daemon serves this as static files)
- `packages/*/dist/` — compiled shared packages

You must rebuild after any source change when running in production mode. In development mode, the daemon watches for changes automatically.

## Running

### Development mode (recommended while building or authoring plugins)

Open two terminals.

**Terminal 1 — daemon with hot reload:**

```bash
pnpm --filter @nubisco/openbridge-daemon dev
```

This uses `tsx watch` to restart the daemon whenever a source file changes. The API and plugin engine run on **port 8582**.

**Terminal 2 — UI dev server (optional):**

```bash
pnpm --filter @nubisco/openbridge-ui dev
```

This starts Vite's development server on **port 5174** with hot module replacement. The UI at port 5174 proxies API calls to the daemon at 8582, so both need to be running.

> **Tip:** You only need Terminal 2 if you are working on the UI itself. If you just want to use the dashboard, the daemon already serves the built UI at [http://localhost:8582](http://localhost:8582) — no Vite needed.

### Production mode

```bash
pnpm build
node apps/daemon/dist/index.js
```

Open [http://localhost:8582](http://localhost:8582) to access the dashboard.

## First-time config

On first run, OpenBridge creates `~/.openbridge/config.json` if it does not exist. The default looks like this:

```json
{
  "bridge": {
    "name": "OpenBridge",
    "port": 8582,
    "hapPort": 51826,
    "pincode": "031-45-154",
    "username": "AA:BB:CC:DD:EE:FF",
    "logLevel": "info"
  },
  "plugins": [],
  "platforms": [],
  "localPluginSources": []
}
```

**What each field means:**

- `bridge.name` — the name shown in the Apple Home app when you add the bridge.
- `bridge.port` — the HTTP API and UI port. Change this if 8582 is taken.
- `bridge.hapPort` — the port hap-nodejs uses for HomeKit communication. Must be reachable from your phone/Apple TV/HomePod.
- `bridge.pincode` — the 8-digit PIN you enter in the Home app when pairing. Format: `XXX-XX-XXX`.
- `bridge.username` — a MAC address that uniquely identifies this bridge to HomeKit. Change it if you run multiple bridges on the same network.
- `bridge.logLevel` — minimum severity to log: `debug`, `info`, `warn`, or `error`.

You can edit this file by hand or use the Settings page in the UI. Changes take effect after a daemon restart.

## Pairing with HomeKit

Once the daemon is running, your bridge is advertising itself on the local network. Pair it with the Apple Home app:

1. Open the **Home** app on your iPhone or iPad.
2. Tap the **+** button (top right) → **Add Accessory**.
3. Tap **More options** if the bridge does not appear automatically.
4. Either scan the QR code from the dashboard (go to the UI, the QR is on the main dashboard) or enter the PIN manually: `031-45-154` (or whatever you set in config).
5. Follow the prompts. The bridge will appear as a home hub or bridge accessory.

You can also fetch the setup URI programmatically:

```bash
curl http://localhost:8582/api/qr
# { "setupURI": "X-HM://...", "pincode": "031-45-154" }
```

> **Tip:** After pairing, the HAP pairing data is stored in `~/.openbridge/hap-storage/`. Do not delete this directory — if you do, HomeKit will not recognize the bridge and you will need to remove and re-add it in the Home app.

## Installing a Homebridge plugin

OpenBridge can run existing Homebridge platform plugins without modification. Here is the full process using `homebridge-shelly-ds9` as an example:

**Step 1 — Install the npm package into the Homebridge plugins directory:**

```bash
cd ~/.openbridge/plugins/homebridge
npm install homebridge-shelly-ds9
```

This directory is separate from the OpenBridge monorepo. It is the equivalent of Homebridge's global plugin directory.

**Step 2 — Find the plugin's entry point:**

```bash
ls ~/.openbridge/plugins/homebridge/node_modules/homebridge-shelly-ds9/dist/
# index.js
```

The entry file is almost always `dist/index.js`. Check the `main` field in the plugin's `package.json` if it is different.

**Step 3 — Add a `platforms[]` entry to your config:**

```json
{
  "platforms": [
    {
      "platform": "ShellyDS9",
      "plugin": "/Users/me/.openbridge/plugins/homebridge/node_modules/homebridge-shelly-ds9/dist/index.js",
      "anyPlatformConfig": "here"
    }
  ]
}
```

- `platform` must match the name the plugin registers with `registerPlatform()`.
- `plugin` is the **absolute path** to the compiled entry file.
- All other fields are passed through to the plugin as its platform config.

**Step 4 — Restart the daemon:**

```bash
# In the UI → Settings → Restart, or:
curl -X POST http://localhost:8582/api/daemon/restart
```

The plugin will initialize, and its accessories will appear in the Home app within a few seconds.

## Plugin directory structure

Native OpenBridge plugins (written with `@nubisco/openbridge-sdk`) live in a different directory:

```
~/.openbridge/
  config.json
  hap-storage/          ← HAP pairing data (do not delete)
  plugins/
    openbridge/         ← Native plugins
      my-sensor/
        dist/
          index.js      ← Compiled plugin entry (required)
        package.json
    homebridge/         ← Homebridge npm packages
      node_modules/
        homebridge-shelly-ds9/
        homebridge-tplink-smarthome/
```

The daemon scans `plugins/openbridge/` on startup. Each subdirectory that contains `dist/index.js` is treated as a plugin and loaded automatically — no config entry needed for discovery. You still add a `plugins[]` entry in config if you want to pass configuration values to the plugin.

## Next steps

- [Concepts](/guide/concepts) — understand the vocabulary before diving deeper
- [Config Reference](/guide/config-reference) — every config field explained
- [Creating a Plugin](/guide/creating-a-plugin) — build your first native plugin
- [Homebridge Compatibility](/guide/homebridge-compatibility) — what Homebridge features work and what does not
- [Dashboard UI](/guide/ui) — what the web interface can do
