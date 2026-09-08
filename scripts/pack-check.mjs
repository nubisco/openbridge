#!/usr/bin/env node
/**
 * Packs every publishable package with `pnpm pack` and asserts the tarballs are sane.
 *
 * The check that matters most: pnpm rewrites `workspace:*` / `workspace:^` to real
 * semver ranges at pack time. npm does not. A tarball that still says `workspace:*`
 * is unusable for everyone who installs it, and the failure is invisible until
 * after publish, so it is asserted here rather than trusted.
 *
 * Run via `pnpm pack:check`, which builds and stages first.
 */
import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const PUBLISHABLE = [
  'packages/logger',
  'packages/core',
  'packages/config',
  'packages/sdk',
  'packages/compatibility-homebridge',
  'apps/daemon',
]

const outDir = mkdtempSync(join(tmpdir(), 'openbridge-pack-'))
const failures = []

for (const dir of PUBLISHABLE) {
  const pkgDir = join(root, dir)
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  const publishedName = manifest.publishConfig?.name ?? manifest.name

  const packOut = execFileSync('pnpm', ['pack', '--pack-destination', outDir], {
    cwd: pkgDir,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
    .toString()
    .trim()

  // pnpm pack prints the tarball path as its last line of stdout.
  const tarPath = packOut.split('\n').pop().trim()
  const entries = execFileSync('tar', ['tzf', tarPath]).toString().trim().split('\n')

  // Read the packed manifest back out of the tarball, not off disk.
  const packed = JSON.parse(execFileSync('tar', ['xzOf', tarPath, 'package/package.json']).toString())

  const problems = []

  if (packed.name !== publishedName) {
    problems.push(`packed name is "${packed.name}", expected "${publishedName}"`)
  }

  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [dep, range] of Object.entries(packed[field] ?? {})) {
      if (String(range).startsWith('workspace:')) {
        problems.push(`${field}.${dep} is still "${range}" (workspace protocol leaked into the tarball)`)
      }
    }
  }

  if (!entries.some((e) => e.startsWith('package/dist/'))) problems.push('no dist/ in tarball')
  if (!entries.includes('package/LICENSE')) problems.push('no LICENSE in tarball')
  if (!entries.includes('package/README.md')) problems.push('no README.md in tarball')

  // Nothing outside the declared allowlist should ride along.
  const stray = entries.filter(
    (e) =>
      e !== 'package/' &&
      !e.startsWith('package/dist/') &&
      !e.startsWith('package/ui-dist/') &&
      !e.startsWith('package/scripts/') &&
      !['package/package.json', 'package/README.md', 'package/LICENSE'].includes(e),
  )
  if (stray.length) problems.push(`unexpected files: ${stray.slice(0, 5).join(', ')}`)

  if (dir === 'apps/daemon' && !entries.some((e) => e.startsWith('package/ui-dist/'))) {
    problems.push('no ui-dist/ in tarball: the dashboard would be missing from a global install')
  }

  const bytes = execFileSync('sh', ['-c', `wc -c < "${tarPath}"`])
    .toString()
    .trim()
  const status = problems.length ? 'FAIL' : 'ok'
  console.log(`${status.padEnd(4)} ${publishedName}@${packed.version}  ${entries.length} files, ${bytes} bytes`)
  for (const p of problems) console.log(`     - ${p}`)
  if (problems.length) failures.push(publishedName)
}

console.log(`\nTarballs written to ${outDir}`)

if (failures.length) {
  console.error(`\npack:check failed for: ${failures.join(', ')}`)
  process.exit(1)
}
rmSync(outDir, { recursive: true, force: true })
console.log('pack:check passed')
