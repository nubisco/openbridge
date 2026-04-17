# Contributing

Thanks for contributing to OpenBridge.

## Local Setup

```bash
git clone https://github.com/nubisco/openbridge.git
cd openbridge
pnpm install
```

## Development Commands

```bash
pnpm typecheck      # TypeScript check across all packages
pnpm build          # Build all packages and apps
pnpm lint           # ESLint
pnpm lint:fix       # ESLint with auto-fix
pnpm format         # Prettier
```

To work on a specific package in watch mode:

```bash
pnpm --filter @nubisco/openbridge-daemon dev
pnpm --filter @nubisco/openbridge-ui dev        # Vue dashboard — dev server at :5174
pnpm --filter @nubisco/openbridge-core dev
pnpm --filter @nubisco/openbridge-logger dev
```

**Notes:**

- Minimum supported Node.js version is `20`
- Package manager is `pnpm 9` — do not use npm or yarn
- Run `pnpm build` at least once before starting watch mode so workspace dependencies are resolved

## Contributor License Agreement (CLA)

To keep OpenBridge sustainable and legally consistent, all contributions are made under the Individual CLA:

- See [`docs/CLA-INDIVIDUAL.md`](docs/CLA-INDIVIDUAL.md)
- You retain ownership of your work
- You grant Nubisco rights to use, distribute, and relicense contributions, including for commercial distributions

By opening a pull request, you must explicitly confirm you agree to the CLA in the pull request template.

## Branch and PR Expectations

- Create focused branches (one concern per PR)
- Keep pull requests small and reviewable
- Use Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `ci:`)
- Run typecheck, lint, and build before opening a PR
- Confirm CLA agreement in the PR checklist

## Contribution Workflow

1. Fork and branch from `master`.
2. Implement focused changes and keep commits clear.
3. Run `pnpm typecheck`, `pnpm lint`, and `pnpm build`.
4. Update docs or tests when behaviour or APIs change.
5. Open a pull request and complete the template, including explicit CLA confirmation.
6. Address review feedback and keep scope limited to the original intent.

## Monorepo Structure

```
openbridge/
  apps/
    daemon/     Node.js runtime — plugin loader, Fastify HTTP API, HAP bridge
    ui/         Vue 3 dashboard (private — not published)
    cli/        Command-line interface
    docs/       VitePress documentation site (private — not published)
  packages/
    core/       @nubisco/openbridge-core — plugin types, registry, lifecycle
    logger/     @nubisco/openbridge-logger — structured logging
    config/     @nubisco/openbridge-config — Zod-validated config schema
    sdk/        @nubisco/openbridge-sdk — definePlugin() helper for plugin authors
    compatibility-homebridge/  @nubisco/openbridge-compatibility-homebridge — Homebridge adapter
```

Published npm packages: `openbridge` (daemon), `@nubisco/openbridge-core`, `@nubisco/openbridge-logger`, `@nubisco/openbridge-config`, `@nubisco/openbridge-sdk`, `@nubisco/openbridge-compatibility-homebridge`.

## Writing a Plugin vs. Contributing to Core

If you are **writing a plugin**, you do not need to fork this repo — use the `@nubisco/openbridge-sdk` package directly. See the [Plugin Development guide](apps/docs/docs/guide/creating-a-plugin.md).

If you are **contributing to core** (daemon, packages, UI, docs), follow this guide.

## Adding a New Feature to the Daemon

1. Add types or interfaces to `packages/core` if the change involves the plugin or accessory API.
2. Implement the feature in `apps/daemon/src/`.
3. Expose it via the Fastify HTTP API if appropriate.
4. Update the UI in `apps/ui/src/` to surface it in the dashboard.
5. Document it in `apps/docs/docs/guide/`.

## Coding Style

- TypeScript strict mode throughout — no `any` unless absolutely unavoidable
- 2-space indentation, LF line endings, no semicolons, single quotes
- Vue 3 Composition API with `<script setup>` — no Options API
- Keep plugin lifecycle contracts (`setup / start / stop`) clean and predictable
- Do not import `apps/*` packages from `packages/*` — packages must be self-contained

## Issue Routing

- Use **Bug report** for reproducible defects or regressions
- Use **Feature request** for new behaviour or API additions
- Include a minimal reproduction case in all bug reports (config snippet, plugin code, logs)

## Keep Changes Focused

- Avoid unrelated refactors in the same PR
- Update docs when plugin APIs, HTTP endpoints, config schema, or the dashboard change
- Add or update tests for non-trivial logic changes

## Quality gate

Before committing or pushing, run:

```sh
pnpm run quality:check
```

The local Git hooks are expected to enforce the same gate automatically. Commits must not proceed unless tests, linting, formatting, and type checks all pass.
