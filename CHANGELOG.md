# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.0](https://github.com/nubisco/openbridge/releases/tag/v0.1.0) — Initial Release

### Added

#### Core (`@openbridge/core`)

- Plugin type definitions: `IPlugin`, `IPluginManifest`, `IPluginContext`
- Plugin registry with lifecycle management (load, start, stop, reload)
- Plugin loader with file-system resolution and error isolation
- Accessory registry for HAP device tracking

#### Logger (`@openbridge/logger`)

- Structured logger with severity levels (debug, info, warn, error)
- In-memory ring buffer for log retrieval via HTTP API
- Per-plugin log namespacing
- WebSocket broadcast support for live log streaming

#### Config (`@openbridge/config`)

- Zod-validated JSON configuration schema
- Bridge config: name, port, log level
- Plugin config: per-plugin `enabled` flag and arbitrary config payload
- Default config generation and config file resolution (`~/.openbridge/config.json`)

#### SDK (`@openbridge/sdk`)

- `definePlugin()` helper for type-safe plugin authoring
- Full `setup / start / stop` lifecycle with typed context
- Re-exports of core types needed by plugin authors

#### Compatibility — Homebridge (`@openbridge/compatibility-homebridge`)

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

#### Dashboard UI (`@openbridge/ui` — private)

- Accessories view with live HAP state
- Plugins view with per-plugin status, start/stop controls
- Logs view with filtering and live stream
- Config editor with JSON schema validation
- Integrated terminal (xterm + node-pty)
- System metrics panel

#### CLI (`@openbridge/cli` — not yet published)

- `openbridge start` — start the daemon
- `openbridge plugins list` — list loaded plugins
- `openbridge logs` — tail live logs

#### Documentation (`apps/docs`)

- VitePress documentation site
- Guides: Getting Started, Core Concepts, Configuration Reference, Dashboard UI, Homebridge Compatibility
- Plugin development: Creating a Plugin, Plugin API Reference
- Reference: HTTP API, Architecture
