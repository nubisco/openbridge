---
layout: nubisco
title: OpenBridge
intro: 'Home automation for developers. Local-first, plugin-based and Homebridge-compatible, with no cloud and no gatekeeping.'
---

## Where to start

- [Get started](/guide/getting-started): from zero to a running daemon paired with HomeKit.
- [What is OpenBridge?](/guide/what-is-openbridge): what it is and what it does.
- [Writing a plugin](/guide/creating-a-plugin): the TypeScript SDK and its lifecycle hooks.
- [Ask Claude about your home](/guide/mcp): the Model Context Protocol endpoint.

## Ask Claude about your home

Your devices' readings and history over the Model Context Protocol. Ask how much energy the house used this week or when the gate last opened, with read-only or control access you choose. See [the MCP endpoint](/guide/mcp).

## Local-first

Runs entirely on your network. The HAP bridge is published locally, no cloud relay, no accounts required.

## Plugin system

Clean TypeScript SDK with setup / start / stop lifecycle hooks. One exported object and you're done.

## Homebridge compatible

Drop-in compatibility shim for existing Homebridge platform plugins. Install from npm and configure in seconds.

## Built-in dashboard

Vue 3 UI included, no separate install. Browse plugins, control accessories, stream live logs, edit config.

## Full HTTP API

Everything the UI does, your scripts can do too. REST endpoints plus WebSocket streams for logs and metrics.

## Transparent by design

MIT licensed. No paid tiers, no telemetry, no plugin gatekeeping. Fork it, audit it, ship it.

## Plugin Marketplace

Browse, rate, and discover community plugins at marketplace.openbridge.nubisco.io. Accessible from the dashboard or directly in your browser.
