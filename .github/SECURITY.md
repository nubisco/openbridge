# Security Policy

## Supported Versions

Only the latest release of OpenBridge receives security fixes.

| Version | Supported |
| ------- | --------- |
| Latest  | ✅        |
| Older   | ❌        |

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Report vulnerabilities privately via [GitHub Security Advisories](https://github.com/nubisco/openbridge/security/advisories/new). You will receive a response within 5 business days.

When reporting, please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept
- The affected version(s)
- Any suggested mitigations, if known

## Scope

Security concerns most relevant to this project:

- **Remote code execution** via the plugin loader or terminal WebSocket (`/ws/shell`)
- **Unauthorised access** to the HTTP API or HAP bridge when exposed outside the local network
- **HAP pairing data exposure** (`~/.openbridge/persist/`)
- **Dependency vulnerabilities** in the daemon or its npm dependencies

## Out of Scope

- Vulnerabilities in third-party Homebridge plugins loaded by the user
- Issues that require physical access to the device running OpenBridge
- Self-hosted deployments that deliberately expose the daemon to the public internet without authentication

## Disclosure Policy

Once a fix is available, we will:

1. Release a patched version
2. Publish a GitHub Security Advisory with credit to the reporter (unless you prefer to remain anonymous)
3. Note the fix in the CHANGELOG
