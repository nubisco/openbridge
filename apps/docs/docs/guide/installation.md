# Installation

There are three ways to install OpenBridge. Pick one; you do not need the others.

| Method                      | Best for                                                 | Needs Node.js | HomeKit works on |
| --------------------------- | -------------------------------------------------------- | ------------- | ---------------- |
| [Docker](#docker)           | Servers, NAS boxes, always-on machines                   | No            | Linux hosts only |
| [npm](#npm)                 | Desktops, laptops, Raspberry Pi, quick trials            | Yes, 20+      | Linux, macOS     |
| [From source](#from-source) | Contributing to OpenBridge, running an unreleased branch | Yes, 20+      | Linux, macOS     |

If you are unsure: use **Docker** on a machine that is always on, and **npm** everywhere else.

## System requirements

|         | Minimum                            | Notes                                                                                 |
| ------- | ---------------------------------- | ------------------------------------------------------------------------------------- |
| CPU     | 64-bit x86-64 or arm64             | A Raspberry Pi 3B+ is enough. 32-bit ARM is not supported.                            |
| RAM     | ~512 MB free                       | Verified on a 906 MB Raspberry Pi 3B+ running Alpine.                                 |
| Disk    | ~150 MB (npm), ~1 GB (from source) | A global npm install measures about 106 MB including dependencies.                    |
| Node.js | 20 or newer                        | Not needed for Docker. Tested on 20, 22 and 24.                                       |
| OS      | Linux (glibc or musl), macOS       | Windows is untested. Use WSL2 or Docker on a Linux host.                              |
| Network | Wired or Wi-Fi LAN with mDNS       | See [Network requirements](#network-requirements). This is the part people get wrong. |

Building from source needs meaningfully more: roughly 1 GB of free disk, since `node_modules` alone lands around 720 MB.

## Network requirements

OpenBridge speaks to HomeKit over the local network. These apply to every install method.

| Port      | Protocol | Purpose                                      |
| --------- | -------- | -------------------------------------------- |
| **8582**  | TCP      | Dashboard and HTTP API                       |
| **51829** | TCP      | HomeKit accessory protocol (HAP)             |
| **5353**  | UDP      | mDNS / Bonjour, how HomeKit finds the bridge |

Both ports are configurable in `config.json` (`bridge.port` and `bridge.hapPort`).

For pairing to work:

- The device running OpenBridge and your iPhone, iPad or Home hub must be on the **same subnet**. HomeKit discovery is link-local and does not cross routed networks.
- **Client isolation** (also called AP isolation or guest mode) on your Wi-Fi must be off.
- If your phone is on a different VLAN from your smart home devices, you need an mDNS reflector (available in OPNsense, pfSense, UniFi and most managed switches).

::: warning OpenBridge has no authentication by default
The dashboard and the full HTTP API are unauthenticated. Anyone who can reach port 8582 can control your devices, edit your config, and use the built-in terminal.

Do not port-forward it or expose it to the internet. Reach it remotely over a VPN or an overlay network such as Tailscale instead.
:::

## Docker

The recommended method for anything that runs unattended. Images are published to GitHub Container Registry for `linux/amd64` and `linux/arm64`.

::: warning Docker on macOS and Windows will not pair with HomeKit
HomeKit requires the container to share the host's network so it can send and receive mDNS on your LAN. Docker Desktop on macOS and Windows runs containers inside a VM, where `network_mode: host` does not provide real LAN access.

Everything else (the dashboard, the API, plugins) works fine. If you want HomeKit, use Docker on a Linux host, or install [from npm](#npm) instead.
:::

### With Docker Compose

Create `docker-compose.yml`:

```yaml
services:
  openbridge:
    image: ghcr.io/nubisco/openbridge:latest
    pull_policy: always
    container_name: openbridge
    restart: unless-stopped
    # Host networking is required for mDNS discovery, HomeKit advertisement,
    # and direct WebSocket connections to smart devices.
    network_mode: host
    volumes:
      - openbridge-config:/root/.openbridge
      - openbridge-app:/opt/openbridge
    environment:
      TZ: Europe/Lisbon
    healthcheck:
      test: ['CMD', 'wget', '-qO-', 'http://127.0.0.1:8582/api/health']
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s

volumes:
  openbridge-config:
  openbridge-app:
```

Then:

```bash
docker compose up -d
docker compose logs -f
```

Open `http://<host-ip>:8582` in a browser, using the IP address of the machine running Docker.

### With `docker run`

```bash
docker run -d \
  --name openbridge \
  --restart unless-stopped \
  --network host \
  -v openbridge-config:/root/.openbridge \
  -v openbridge-app:/opt/openbridge \
  ghcr.io/nubisco/openbridge:latest
```

### What the volumes hold

| Volume              | Contents                                                                          | Losing it means                                               |
| ------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `/root/.openbridge` | `config.json`, HomeKit pairing data, installed plugins, metrics, session key      | Re-pairing with HomeKit and reconfiguring                     |
| `/opt/openbridge`   | The running copy of the app, so the dashboard can self-update between image pulls | Nothing permanent, it is rebuilt from the image on next start |

Back up `/root/.openbridge`. That is the one that matters.

### Pinning a version

`:latest` tracks every release. To pin:

```yaml
image: ghcr.io/nubisco/openbridge:0.30.0
```

### Upgrading

```bash
docker compose pull
docker compose up -d
```

The entrypoint notices the image is newer than the copy on the volume and refreshes it. Your config and pairing survive.

## npm

```bash
npm install -g @nubisco/openbridge
openbridge
```

Open **http://localhost:8582**. The dashboard is bundled in the package, so there is nothing else to build or serve.

```bash
openbridge --help          # usage
openbridge --version       # print the version
openbridge --port 9000     # run on a different port
```

### Avoid `sudo npm install -g`

If you get `EACCES` errors, the fix is not `sudo`. Installing global packages as root leaves root-owned files in your home directory and causes problems later. Either use a version manager, which is the cleaner option:

```bash
# fnm (https://github.com/Schniz/fnm) or nvm both work
fnm install 22 && fnm use 22
npm install -g @nubisco/openbridge
```

or point npm at a directory you own:

```bash
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.profile
source ~/.profile
npm install -g @nubisco/openbridge
```

### Alpine and other musl systems

Supported on x64 and arm64. OpenBridge's only native dependency, `node-pty`, is an **optional** dependency: if it cannot be built, the install still succeeds and everything works except the dashboard's interactive shell pane.

To enable the shell pane, install a toolchain first:

```bash
apk add build-base python3 linux-headers
npm install -g @nubisco/openbridge
```

### Running as a service

On Linux with systemd, create `/etc/systemd/system/openbridge.service`. Replace `youruser` and the path to `openbridge` (find it with `which openbridge`):

```ini
[Unit]
Description=OpenBridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=youruser
ExecStart=/usr/local/bin/openbridge
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now openbridge
systemctl status openbridge
journalctl -u openbridge -f
```

Run it as a normal user, not root. State is written to that user's home directory, so the service user must match the account you installed under.

### Upgrading and uninstalling

```bash
npm install -g @nubisco/openbridge@latest   # upgrade
npm uninstall -g @nubisco/openbridge        # remove the program
rm -rf ~/.openbridge                        # remove config and pairing data too
```

### Published packages

The daemon is `@nubisco/openbridge`. Plugin authors depend on the libraries directly rather than installing the daemon as a dependency:

| Package                                        | Use                                   |
| ---------------------------------------------- | ------------------------------------- |
| `@nubisco/openbridge`                          | The daemon and CLI (what you install) |
| `@nubisco/openbridge-sdk`                      | `definePlugin()` for plugin authors   |
| `@nubisco/openbridge-core`                     | Plugin types, registry, lifecycle     |
| `@nubisco/openbridge-logger`                   | Structured logger                     |
| `@nubisco/openbridge-config`                   | Zod-validated config schema           |
| `@nubisco/openbridge-compatibility-homebridge` | Homebridge platform plugin adapter    |

All six are released together under one version, from CI, with [npm provenance](https://docs.npmjs.com/generating-provenance-statements) attestations linking each tarball to the commit and workflow run that built it.

## From source

For contributors, or to run an unreleased branch.

**Additional requirements:** pnpm 9, Git, and roughly 1 GB of free disk.

```bash
npm install -g pnpm@9
git clone https://github.com/nubisco/openbridge
cd openbridge
pnpm install
pnpm build
node apps/daemon/dist/index.js
```

`pnpm build` covers the runtime packages and the dashboard. It deliberately excludes the documentation site, which needs more than 1 GB of RAM to build and would otherwise make the whole build fail on small machines. Build the docs separately with `pnpm build:docs`.

See [Getting Started](/guide/getting-started) for the development workflow with hot reload.

## Verifying the install

```bash
curl http://localhost:8582/api/health
```

```json
{ "status": "ok", "version": "0.30.0", "capabilities": { "shell": true, "ui": true } }
```

`capabilities` tells you which optional pieces are present:

- `ui: false` means the bundled dashboard was not found, and the API is serving JSON only.
- `shell: false` means `node-pty` is not installed, so the terminal pane is disabled. Nothing else is affected.

## Where OpenBridge stores data

Everything lives under `~/.openbridge`, in the home directory of the user running the daemon (`/root/.openbridge` in the Docker image):

| Path                          | Contents                                              |
| ----------------------------- | ----------------------------------------------------- |
| `config.json`                 | Your configuration                                    |
| `hap-storage/`                | HomeKit pairing data. Deleting it unpairs the bridge. |
| `plugins/openbridge/`         | Installed OpenBridge plugins                          |
| `plugins/homebridge/`         | Installed Homebridge plugins                          |
| `metrics/`, `energy-history/` | Recorded device metrics                               |
| `session.key`                 | Secret for signing session cookies                    |

The location follows the `HOME` environment variable, so running the daemon under a different `HOME` relocates all of it.

## Environment variables

| Variable                    | Effect                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| `OPENBRIDGE_PORT`           | Dashboard and API port. Same as `--port`.                                                       |
| `OPENBRIDGE_UI_PATH`        | Override where the built dashboard is loaded from.                                              |
| `OPENBRIDGE_SESSION_SECRET` | Fixed secret for signing session cookies. Minimum 16 characters. Generated and stored if unset. |
| `TZ`                        | Timezone, mainly useful in Docker so log timestamps match your locale.                          |

## Troubleshooting

### The bridge does not appear in the Home app

Almost always a network problem rather than an OpenBridge problem. In order of likelihood:

1. Your phone is on a different subnet or VLAN from the bridge. Put them on the same one, or run an mDNS reflector.
2. Wi-Fi client isolation is enabled on your access point. Turn it off.
3. You are running Docker **without** `--network host`, or on Docker Desktop for macOS or Windows. HomeKit cannot work through a bridge network.
4. A firewall is blocking UDP 5353 or TCP 51829.

Confirm the daemon itself is healthy first with `curl http://localhost:8582/api/health`. If that returns `ok`, the problem is on the network side.

### `EADDRINUSE: address already in use`

Something else holds port 8582. Either stop it, or move OpenBridge:

```bash
openbridge --port 9000
```

To make it permanent, set `bridge.port` in `~/.openbridge/config.json`. Values below 1024 are rejected there, since binding them requires root.

### `EACCES` when installing globally

See [Avoid `sudo npm install -g`](#avoid-sudo-npm-install-g).

### The terminal tab in the dashboard does not work

`node-pty` is not installed. Confirm with `curl http://localhost:8582/api/health` and look for `"shell": false`. Install a build toolchain (`build-base python3 linux-headers` on Alpine, `build-essential python3` on Debian and Ubuntu) and reinstall. Everything except the terminal works without it.

### The container reports `unhealthy`

Check that the health check targets the same port the daemon listens on. If you changed `bridge.port`, update the `healthcheck` block too.

### `JavaScript heap out of memory` when building from source

You are building the documentation site on a machine with under 1 GB of RAM. Use `pnpm build`, which excludes it, rather than `pnpm build:all`.

### Unpairing and starting over

Remove the bridge in the Home app first, then:

```bash
rm -rf ~/.openbridge/hap-storage
```

Restart the daemon and pair again. Changing `bridge.username` in `config.json` has the same effect, since HomeKit identifies the bridge by that value.

## Next steps

- [Getting Started](/guide/getting-started) walks through first-run config, HomeKit pairing, and installing a plugin.
- [Configuration Reference](/guide/config-reference) documents every config field.
