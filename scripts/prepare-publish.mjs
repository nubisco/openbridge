#!/usr/bin/env node
/**
 * Stages the workspace for `pnpm pack` / `pnpm publish`.
 *
 * Publishing a monorepo needs three things that git does not track:
 *   1. Every publishable package carries the root version, so `openbridge` and
 *      `@nubisco/openbridge-*` release together under one tag.
 *   2. Every tarball carries a LICENSE, since npm only picks up a LICENSE that
 *      sits in the package directory itself.
 *   3. The `openbridge` tarball carries the built dashboard at `ui-dist/`,
 *      which is where the daemon looks for it in the npm layout
 *      (see the uiDist resolution in apps/daemon/src/server.ts).
 *
 * Everything written here is gitignored: run `pnpm build` first, then this.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, cpSync, rmSync } from 'fs'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Packages published to npm, in dependency order. */
const PUBLISHABLE = [
  'packages/logger',
  'packages/core',
  'packages/config',
  'packages/sdk',
  'packages/compatibility-homebridge',
  'apps/daemon',
]

const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
if (!version) throw new Error('Root package.json has no version')

const errors = []

for (const dir of PUBLISHABLE) {
  const pkgDir = join(root, dir)
  const manifestPath = join(pkgDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

  // 1. Sync version to the root version.
  if (manifest.version !== version) {
    manifest.version = version
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  }

  // 2. LICENSE must live inside the package directory for npm to include it.
  copyFileSync(join(root, 'LICENSE'), join(pkgDir, 'LICENSE'))

  // 3. Every published package needs a README; npm renders it as the package page.
  //    The daemon is published as `openbridge` itself, so it gets the root README.
  if (dir === 'apps/daemon') {
    copyFileSync(join(root, 'README.md'), join(pkgDir, 'README.md'))
  } else if (!existsSync(join(pkgDir, 'README.md'))) {
    errors.push(`${dir} has no README.md`)
  }

  // 4. dist/ must exist, otherwise the tarball is empty of code.
  if (!existsSync(join(pkgDir, 'dist'))) {
    errors.push(`${dir}/dist is missing: run \`pnpm build\` first`)
  }
}

// 5. Stage the built dashboard into the daemon package as ui-dist/.
const uiSrc = join(root, 'apps/ui/dist')
const uiDest = join(root, 'apps/daemon/ui-dist')
if (existsSync(uiSrc)) {
  rmSync(uiDest, { recursive: true, force: true })
  cpSync(uiSrc, uiDest, { recursive: true })
} else {
  errors.push('apps/ui/dist is missing: run `pnpm build` first (the dashboard ships inside the openbridge tarball)')
}

if (errors.length) {
  console.error('prepare-publish failed:')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}

console.log(`prepare-publish: staged ${PUBLISHABLE.length} packages at version ${version}`)
