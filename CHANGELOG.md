## [0.9.1](https://github.com/nubisco/openbridge/compare/v0.9.0...v0.9.1) (2026-04-18)


### Bug Fixes

* replace telemetry in plugin inspector with device list ([1a26e4e](https://github.com/nubisco/openbridge/commit/1a26e4e2098d8b41910d73825873ab42fc521fe1))

# [0.9.0](https://github.com/nubisco/openbridge/compare/v0.8.9...v0.9.0) (2026-04-18)


### Features

* show plugin HAP bridge QR code and PIN in plugin inspector ([6b5b585](https://github.com/nubisco/openbridge/commit/6b5b585c7af9e3d5dab6a1d7b4fb3cb9ccc7e108))

## [0.8.9](https://github.com/nubisco/openbridge/compare/v0.8.8...v0.8.9) (2026-04-18)

### Bug Fixes

- add logging to registerHapBridge for diagnostics ([8d861dc](https://github.com/nubisco/openbridge/commit/8d861dc5e095809e75952eee3a334f5f93fa4f0e))

## [0.8.8](https://github.com/nubisco/openbridge/compare/v0.8.7...v0.8.8) (2026-04-18)

### Bug Fixes

- plugin uninstall prunes config.plugins, HAP bridge info for plugins ([8bdf23f](https://github.com/nubisco/openbridge/commit/8bdf23f86945bfac2336094baff58f4e44e528f4))

## [0.8.7](https://github.com/nubisco/openbridge/compare/v0.8.6...v0.8.7) (2026-04-18)

### Bug Fixes

- add path diagnostic logs for native plugin loading from marketplace ([6161821](https://github.com/nubisco/openbridge/commit/6161821fe9838000d9502f9c85672ba1d9adc05c))

## [0.8.6](https://github.com/nubisco/openbridge/compare/v0.8.5...v0.8.6) (2026-04-18)

### Bug Fixes

- add diagnostic logging to marketplace plugin discovery ([a2aefb8](https://github.com/nubisco/openbridge/commit/a2aefb85dfc0e625ebdda40e80984698c6069746))

## [0.8.5](https://github.com/nubisco/openbridge/compare/v0.8.4...v0.8.5) (2026-04-18)

### Bug Fixes

- entrypoint uses build hash to detect Docker image changes ([aa8d4ef](https://github.com/nubisco/openbridge/commit/aa8d4efb07258c303181777422542c8dbbd2873f))

## [0.8.4](https://github.com/nubisco/openbridge/compare/v0.8.3...v0.8.4) (2026-04-18)

### Bug Fixes

- detect @nubisco/ scoped OpenBridge plugins for native badge ([dd9f785](https://github.com/nubisco/openbridge/commit/dd9f785d4145aae0e5660c2f82c55694d50adba7))

## [0.8.3](https://github.com/nubisco/openbridge/compare/v0.8.2...v0.8.3) (2026-04-17)

### Bug Fixes

- disabled plugins now actually stop — applies to both Homebridge platforms and native plugins ([d69b5a1](https://github.com/nubisco/openbridge/commit/d69b5a16ac5df7fd375cae19002bc33d83358fb7))

## [0.8.2](https://github.com/nubisco/openbridge/compare/v0.8.1...v0.8.2) (2026-04-17)

### Bug Fixes

- inject daemon node_modules into NODE_PATH for marketplace native plugins ([a915d87](https://github.com/nubisco/openbridge/commit/a915d870187382cbfc0c71a6d689ad27ee19bd43))

## [0.8.1](https://github.com/nubisco/openbridge/compare/v0.8.0...v0.8.1) (2026-04-17)

### Bug Fixes

- plugin management — native loading, disabled state, removal ([30605d0](https://github.com/nubisco/openbridge/commit/30605d0be4329b873683ca69809a42b9593d5b8b))

# [0.8.0](https://github.com/nubisco/openbridge/compare/v0.7.2...v0.8.0) (2026-04-17)

### Features

- self-update mechanism with progress UI ([267f7c3](https://github.com/nubisco/openbridge/commit/267f7c3b20f1289c8ca11960f89bf6570d9e76db)), closes [#notification](https://github.com/nubisco/openbridge/issues/notification)

## [0.7.2](https://github.com/nubisco/openbridge/compare/v0.7.1...v0.7.2) (2026-04-17)

### Bug Fixes

- revert to QEMU Docker builds, fix energy history date reset ([0c3f934](https://github.com/nubisco/openbridge/commit/0c3f934a6b6fbdc43bdd016fccf471a711e7102e))

### Performance Improvements

- **ci:** use ubuntu-24.04-arm runner for native ARM64 Docker builds ([ba72fcf](https://github.com/nubisco/openbridge/commit/ba72fcf92304006564ba1cf996c0e19c7710d6de))

## [0.7.1](https://github.com/nubisco/openbridge/compare/v0.7.0...v0.7.1) (2026-04-17)

### Performance Improvements

- **ci:** native multi-arch Docker builds with parallel runners ([2ac2f1f](https://github.com/nubisco/openbridge/commit/2ac2f1fb21d751cf0ee8cb461fd30da3b4220bdf))

# [0.7.0](https://github.com/nubisco/openbridge/compare/v0.6.1...v0.7.0) (2026-04-17)

### Features

- rename all packages from @openbridge/_ to @nubisco/openbridge-_ ([daa25d7](https://github.com/nubisco/openbridge/commit/daa25d7ad14bc948bd7dfd0a5394954881241f56))

## [0.6.1](https://github.com/nubisco/openbridge/compare/v0.6.0...v0.6.1) (2026-04-17)

### Bug Fixes

- **ci:** build workspace packages before release, disable hooks in CI ([b628d11](https://github.com/nubisco/openbridge/commit/b628d11503385bd15917fdd9b0fa1234152f866d))

# [0.6.0](https://github.com/nubisco/openbridge/compare/v0.5.0...v0.6.0) (2026-04-16)

### Bug Fixes

- **ci:** build workspace packages before release, disable hooks in CI ([8a467b3](https://github.com/nubisco/openbridge/commit/8a467b36377b8ecaa5166a180ee62d84ab60fafd))
- export DeviceDescriptor from core, regenerate lockfile ([f6b96ef](https://github.com/nubisco/openbridge/commit/f6b96efc3d18f82a346b5170fa83218471f81988))
- include lockfile and package.json changes for CI build ([ceca7f0](https://github.com/nubisco/openbridge/commit/ceca7f001f14b352993e7fe6734e7360f3dfc8ca))

### Features

- native devices view with controls, always-on HAP bridge, light theme ([1442c9a](https://github.com/nubisco/openbridge/commit/1442c9a462bf700621fab90df932de32f550154c))

# [0.5.0](https://github.com/nubisco/openbridge/compare/v0.4.0...v0.5.0) (2026-04-08)

### Features

- **crawler:** fetch GitHub stars + sponsors; expose in plugins API ([af5a511](https://github.com/nubisco/openbridge/commit/af5a5114593231e83d4e6eba2c157a46cfc3ad1d))

# [0.4.0](https://github.com/nubisco/openbridge/compare/v0.3.1...v0.4.0) (2026-04-08)

### Features

- **marketplace-panel:** add Marketplace link per plugin to openbridge ([caf840d](https://github.com/nubisco/openbridge/commit/caf840d14405d5ab9ce0156afafdc01dee46cbd5))

## [0.3.1](https://github.com/nubisco/openbridge/compare/v0.3.0...v0.3.1) (2026-04-08)

### Bug Fixes

- **daemon:** correct version source and update checker ([11c8b24](https://github.com/nubisco/openbridge/commit/11c8b2475066f5bed811fdc38a127fc581273c09))

# [0.3.0](https://github.com/nubisco/openbridge/compare/v0.2.0...v0.3.0) (2026-04-08)

### Features

- **ci:** automate releases via semantic-release and CI chain ([693ac87](https://github.com/nubisco/openbridge/commit/693ac87d5f35c422ec6edefbf52aa9b6cf629e2f))

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.0](https://github.com/nubisco/openbridge/releases/tag/v0.1.0) — Initial Release

### Added

#### Core (`@nubisco/openbridge-core`)

- Plugin type definitions: `IPlugin`, `IPluginManifest`, `IPluginContext`
- Plugin registry with lifecycle management (load, start, stop, reload)
- Plugin loader with file-system resolution and error isolation
- Accessory registry for HAP device tracking

#### Logger (`@nubisco/openbridge-logger`)

- Structured logger with severity levels (debug, info, warn, error)
- In-memory ring buffer for log retrieval via HTTP API
- Per-plugin log namespacing
- WebSocket broadcast support for live log streaming

#### Config (`@nubisco/openbridge-config`)

- Zod-validated JSON configuration schema
- Bridge config: name, port, log level
- Plugin config: per-plugin `enabled` flag and arbitrary config payload
- Default config generation and config file resolution (`~/.openbridge/config.json`)

#### SDK (`@nubisco/openbridge-sdk`)

- `definePlugin()` helper for type-safe plugin authoring
- Full `setup / start / stop` lifecycle with typed context
- Re-exports of core types needed by plugin authors

#### Compatibility — Homebridge (`@nubisco/openbridge-compatibility-homebridge`)

- Drop-in adapter for existing Homebridge `platform` plugins
- Maps Homebridge `PlatformAccessory` and HAP service/characteristic APIs
- Enables running unmodified Homebridge plugins without code changes

#### Daemon (`openbridge`)

- Fastify HTTP server on port 8581
- REST API: plugins, accessories, logs, health
- WebSocket streams: live logs (`/ws/logs`), interactive terminal (`/ws/shell`)
- HAP bridge via hap-nodejs — exposes accessories to Apple Home via local network
- Built-in Vue 3 dashboard served as static files (no separate install)
- Update notification on startup (checks npm registry for newer version)
- Structured startup/shutdown lifecycle with graceful plugin teardown
- Multi-architecture Docker image (linux/amd64, linux/arm64)
- `docker-compose.yml` for NAS and self-hosted deployment

#### Dashboard UI (`@nubisco/openbridge-ui` — private)

- Accessories view with live HAP state
- Plugins view with per-plugin status, start/stop controls
- Logs view with filtering and live stream
- Config editor with JSON schema validation
- Integrated terminal (xterm + node-pty)
- System metrics panel

#### CLI (`@nubisco/openbridge-cli` — not yet published)

- `openbridge start` — start the daemon
- `openbridge plugins list` — list loaded plugins
- `openbridge logs` — tail live logs

#### Documentation (`apps/docs`)

- VitePress documentation site
- Guides: Getting Started, Core Concepts, Configuration Reference, Dashboard UI, Homebridge Compatibility
- Plugin development: Creating a Plugin, Plugin API Reference
- Reference: HTTP API, Architecture
