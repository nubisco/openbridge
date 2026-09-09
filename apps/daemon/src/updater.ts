/**
 * Update discovery and installation.
 *
 * Both halves go through npm. The registry is the only place that knows what is
 * actually installable: a git tag can exist while the publish that followed it
 * failed, and offering that version would hand the user an update that cannot
 * complete. npm is also the mechanism, so there are no per-architecture release
 * tarballs to build and keep in step with the code that downloads them.
 */
import { existsSync, readFileSync } from 'fs'
import { dirname, join, resolve, sep } from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { APP_VOLUME } from './version.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const PACKAGE_NAME = '@nubisco/openbridge'

/** The installed package root, i.e. the directory holding our package.json. */
export const PACKAGE_ROOT = resolve(__dirname, '..')

/**
 * How OpenBridge was installed, which decides whether it can replace itself.
 *
 * Self-update is only offered where something is guaranteed to start the daemon
 * again after it exits. In Docker that is the restart policy. A bare npm install
 * has no such guarantee, so it gets the exact command to run instead of a button
 * that would leave the daemon stopped.
 */
export type InstallMethod = 'docker' | 'npm' | 'source'

export interface InstallInfo {
  method: InstallMethod
  /** Whether /api/updates/apply can do the work itself. */
  canSelfUpdate: boolean
  /** Shown to the user when it cannot. */
  command: string
  /** Version range this deployment is pinned to, if any. */
  pinnedTo: string | null
}

/** Where a Docker deployment keeps the app tree, outside the image. */
export const CURRENT_DIR = join(APP_VOLUME, 'current')
export const STAGING_DIR = join(APP_VOLUME, 'staging')
export const PREVIOUS_DIR = join(APP_VOLUME, 'previous')

/**
 * A concrete version pin, as opposed to a range or dist-tag. Compose sets this
 * so a deployment can hold a version deliberately; when it does, self-update is
 * withheld, since a restart would reinstall the pin and silently undo it.
 */
function pinnedVersion(): string | null {
  const spec = process.env.OPENBRIDGE_VERSION_SPEC?.trim()
  if (!spec || spec === 'latest') return null
  return /^\d+\.\d+\.\d+/.test(spec) ? spec : null
}

export function detectInstall(): InstallInfo {
  const pin = pinnedVersion()

  // Docker announces itself: the compose file sets this, and the app tree lives
  // on a volume precisely so it can be replaced without rebuilding an image.
  if (process.env.OPENBRIDGE_INSTALL === 'docker' || PACKAGE_ROOT.startsWith(APP_VOLUME + sep)) {
    return {
      method: 'docker',
      canSelfUpdate: pin === null,
      command: pin
        ? `Update OPENBRIDGE_VERSION_SPEC in docker-compose.yml, then: docker compose up -d --force-recreate`
        : 'docker compose restart openbridge',
      pinnedTo: pin,
    }
  }

  // Under a node_modules means npm or pnpm put it there. Anywhere else means a
  // source checkout being run straight out of dist/.
  if (PACKAGE_ROOT.includes(`${sep}node_modules${sep}`)) {
    return {
      method: 'npm',
      canSelfUpdate: false,
      command: `npm install -g ${PACKAGE_NAME}@latest`,
      pinnedTo: pin,
    }
  }

  return { method: 'source', canSelfUpdate: false, command: 'git pull && pnpm install && pnpm build', pinnedTo: null }
}

/**
 * The newest published version, straight from the registry.
 *
 * One unauthenticated GET against a CDN-backed endpoint, with no rate limit to
 * work around.
 */
export async function fetchLatestVersion(): Promise<string | null> {
  const res = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
    signal: AbortSignal.timeout(8000),
    headers: { Accept: 'application/json', 'User-Agent': 'openbridge-daemon' },
  })
  if (!res.ok) return null
  const body = (await res.json()) as { version?: string }
  return body.version ?? null
}

/** Release notes, from GitHub. Cosmetic: every caller treats failure as absence. */
export async function fetchReleaseNotes(version: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/nubisco/openbridge/releases/tags/v${version}`, {
      signal: AbortSignal.timeout(8000),
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'openbridge-daemon' },
    })
    if (!res.ok) return null
    return ((await res.json()) as { body?: string }).body ?? null
  } catch {
    return null
  }
}

export function releaseUrl(version: string): string {
  return `https://github.com/nubisco/openbridge/releases/tag/v${version}`
}

/** The version installed in a prefix, or null if nothing is installed there. */
export function installedVersionAt(prefix: string): string | null {
  try {
    const pkg = join(prefix, 'node_modules', PACKAGE_NAME, 'package.json')
    return (JSON.parse(readFileSync(pkg, 'utf8')) as { version: string }).version
  } catch {
    return null
  }
}

/**
 * Install a version into an npm prefix.
 *
 * Optional dependencies are skipped deliberately: node-pty is the only one, it
 * needs a C toolchain the runtime image does not carry, and a failed build here
 * would fail the whole update over a feature that already degrades gracefully.
 */
export function npmInstall(prefix: string, version: string, onLine?: (line: string) => void): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [
        npmCliPath(),
        'install',
        '--prefix',
        prefix,
        '--omit=optional',
        '--no-audit',
        '--no-fund',
        `${PACKAGE_NAME}@${version}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'production' } },
    )

    let stderr = ''
    child.stdout?.on('data', (b: Buffer) => onLine?.(b.toString().trim()))
    child.stderr?.on('data', (b: Buffer) => {
      const text = b.toString()
      stderr += text
      onLine?.(text.trim())
    })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0
        ? resolvePromise()
        : reject(
            new Error(
              `npm install exited with ${code}${stderr ? `: ${stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`,
            ),
          ),
    )
  })
}

/**
 * The npm CLI that ships with the running Node.
 *
 * Spawned through process.execPath rather than as `npm`, so an update does not
 * depend on a PATH the daemon may not have inherited from its supervisor.
 */
function npmCliPath(): string {
  const candidates = [
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'index.js'),
  ]
  const found = candidates.find((p) => existsSync(p))
  if (!found) throw new Error('npm was not found next to the running Node, so OpenBridge cannot update itself')
  return found
}
