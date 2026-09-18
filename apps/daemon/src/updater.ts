/**
 * Update discovery and installation.
 *
 * Both halves go through npm. The registry is the only place that knows what is
 * actually installable: a git tag can exist while the publish that followed it
 * failed, and offering that version would hand the user an update that cannot
 * complete. npm is also the mechanism, so there are no per-architecture release
 * tarballs to build and keep in step with the code that downloads them.
 */
import { accessSync, constants, existsSync, readFileSync } from 'fs'
import { basename, dirname, join, resolve, sep } from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { APP_VOLUME } from './version.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const PACKAGE_NAME = '@nubisco/openbridge'

/** The installed package root, i.e. the directory holding our package.json. */
export const PACKAGE_ROOT = resolve(__dirname, '..')

/**
 * How OpenBridge was installed, which decides how it replaces itself.
 *
 * Replacing the files of a running Node process is safe: the modules it needs
 * are already resolved and in memory, and the old inode survives until the
 * process lets go of it. So the install is never the hard part. Getting
 * something to run the new code afterwards is, and that is what separates
 * these three.
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
  /** How the daemon gets running again, once the new version is on disk. */
  restart: RestartStrategy | null
  /** Why self-update is unavailable, when it is. */
  blockedBy?: string
}

/**
 * What will be running the new code a second from now.
 *
 * `supervisor` means something outside the daemon restarts it when it exits, so
 * exiting is the whole restart. `spawn` means nothing will, so the daemon has
 * to leave a detached process behind that waits for it to die and starts its
 * replacement. Getting this wrong in the optimistic direction leaves a stopped
 * daemon and someone locked out of their house, so an unrecognised environment
 * gets `spawn` rather than the benefit of the doubt.
 */
export type RestartStrategy = 'supervisor' | 'spawn'

/** Supervisors that restart a service when it exits. */
const SUPERVISORS = ['supervise-daemon', 'systemd', 'runsv', 's6-supervise', 'runit', 'launchd']

/**
 * The name of the process that started this one.
 *
 * Read from `cmdline` first, because `comm` is truncated to fifteen characters
 * by the kernel and OpenRC's `supervise-daemon` lands at sixteen. Comparing the
 * truncated `supervise-daemo` against the real name never matches, which would
 * classify a supervised daemon as unsupervised: it would then leave a process
 * behind to start its replacement while the supervisor started one too, and the
 * second would die on the port the first already holds.
 *
 * The prefix match on the way out covers `comm` when `cmdline` is unreadable,
 * which happens for a parent owned by another user.
 */
function parentProcessName(): string | null {
  try {
    const argv0 = readFileSync(`/proc/${process.ppid}/cmdline`, 'utf8').split('\0')[0]
    if (argv0) return basename(argv0)
  } catch {
    /* no procfs, or unreadable */
  }
  try {
    return readFileSync(`/proc/${process.ppid}/comm`, 'utf8').trim() || null
  } catch {
    return null
  }
}

/**
 * The npm prefix this package is installed under.
 *
 * Derived from where we are actually running rather than from `npm prefix -g`,
 * which reports npm's configured prefix and can name a different tree entirely
 * when the daemon was installed by another user or with a `--prefix` of its
 * own. Updating a copy nobody is running is a convincing no-op.
 */
export function globalPrefix(): string | null {
  // <prefix>/lib/node_modules/@nubisco/openbridge on POSIX, and
  // <prefix>/node_modules/@nubisco/openbridge on Windows.
  const marker = `${sep}node_modules${sep}`
  const at = PACKAGE_ROOT.lastIndexOf(marker)
  if (at === -1) return null
  const modules = PACKAGE_ROOT.slice(0, at)
  return modules.endsWith(`${sep}lib`) ? dirname(modules) : modules
}

/** True when this process could actually write the installed package. */
function canReplacePackage(): boolean {
  try {
    accessSync(PACKAGE_ROOT, constants.W_OK)
    accessSync(dirname(PACKAGE_ROOT), constants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Who, if anyone, restarts this process when it exits.
 *
 * Read from the environment rather than configured, because the daemon is
 * started by whatever the host happens to use and nobody is going to tell it
 * which. Each check identifies a supervisor by something only that supervisor
 * sets.
 */
export function detectRestartStrategy(): RestartStrategy {
  // systemd stamps every service it starts with this, and nothing else does.
  if (process.env.INVOCATION_ID) return 'supervisor'
  // A process supervisor as our direct parent, which respawns us on exit.
  const parent = parentProcessName()
  if (parent && SUPERVISORS.some((name) => name === parent || name.startsWith(parent))) return 'supervisor'
  // Docker's restart policy brings the container back, and the compose file
  // sets this marker for the same reason the volume exists.
  if (process.env.OPENBRIDGE_INSTALL === 'docker') return 'supervisor'
  return 'spawn'
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
      restart: 'supervisor',
      ...(pin ? { blockedBy: `pinned to ${pin}` } : {}),
    }
  }

  // Under a node_modules means npm or pnpm put it there. Anywhere else means a
  // source checkout being run straight out of dist/.
  if (PACKAGE_ROOT.includes(`${sep}node_modules${sep}`)) {
    const command = `npm install -g ${PACKAGE_NAME}@latest`
    const restart = detectRestartStrategy()

    // Each of these is a reason the daemon would end up stopped, or would
    // update a copy nobody runs. Naming which one is what turns "it does not
    // work" into something the user can act on.
    let blockedBy: string | null = null
    if (pin) blockedBy = `pinned to ${pin}`
    else if (!globalPrefix()) blockedBy = 'the install prefix could not be determined'
    else if (!canReplacePackage()) blockedBy = `no write access to ${PACKAGE_ROOT}`

    return {
      method: 'npm',
      canSelfUpdate: blockedBy === null,
      command,
      pinnedTo: pin,
      restart,
      ...(blockedBy ? { blockedBy } : {}),
    }
  }

  // A source checkout is somebody's working tree. Replacing it from under them
  // would discard whatever they were doing, which no amount of convenience justifies.
  return {
    method: 'source',
    canSelfUpdate: false,
    command: 'git pull && pnpm install && pnpm build',
    pinnedTo: null,
    restart: null,
    blockedBy: 'running from a source checkout',
  }
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
        // See npmInstallGlobal: a just-published version against a stale
        // packument resolves as ETARGET.
        '--prefer-online',
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
 * Install a version over the running global install.
 *
 * Safe while the daemon is running, which is the whole reason this is possible:
 * every module it needs is already resolved and in memory, and on POSIX the old
 * inode survives until the process releases it. npm writes the new tree and the
 * running process carries on with the old code until something restarts it.
 *
 * The prefix is passed explicitly rather than left to npm's configuration,
 * which can name a different tree than the one this process is running from.
 */
export function npmInstallGlobal(prefix: string, version: string, onLine?: (line: string) => void): Promise<void> {
  return runNpm(
    [
      'install',
      '--global',
      '--prefix',
      prefix,
      '--omit=optional',
      '--no-audit',
      '--no-fund',
      // A version published minutes ago is exactly what an update reaches for,
      // and a cached packument from before it existed makes npm insist it does
      // not. Seen for real: the daemon's own version resolved while one of its
      // workspace dependencies came back ETARGET from the same install.
      '--prefer-online',
      `${PACKAGE_NAME}@${version}`,
    ],
    onLine,
  )
}

/** The version of the package as it exists on disk right now, not as loaded. */
export function versionOnDisk(): string | null {
  try {
    const raw = readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')
    return (JSON.parse(raw) as { version: string }).version
  } catch {
    return null
  }
}

/**
 * Get the daemon running again on the new code.
 *
 * Under a supervisor, exiting is the entire restart: it is watching for exactly
 * that. Without one, the process has to leave something behind that outlives
 * it, because a child started now would race the parent for the listening port
 * and lose.
 *
 * So the `spawn` path starts a detached process whose only job is to wait for
 * this pid to disappear and then start the daemon again. Detached and with its
 * streams closed, so it is not killed along with its parent and does not hold
 * the terminal open. It is written inline rather than shipped as a file because
 * the update it is waiting on is, at that moment, replacing every file in the
 * package it would otherwise be loaded from.
 */
export function restartDaemon(strategy: RestartStrategy, log?: (message: string) => void): void {
  if (strategy === 'spawn') {
    const bin = process.argv[1]
    const waiter = `
      const { spawn } = require('child_process')
      const pid = ${process.pid}
      let waited = 0
      const tick = setInterval(() => {
        let alive = true
        try { process.kill(pid, 0) } catch { alive = false }
        // 30s, then start anyway: a parent that has not exited by now is stuck,
        // and leaving the house without a bridge is the worse outcome.
        if (alive && (waited += 250) < 30000) return
        clearInterval(tick)
        spawn(process.execPath, [${JSON.stringify(bin)}], {
          detached: true,
          stdio: 'ignore',
          env: process.env,
        }).unref()
      }, 250)
    `
    log?.('No supervisor found, so a detached process will start the new version once this one exits')
    spawn(process.execPath, ['-e', waiter], { detached: true, stdio: 'ignore' }).unref()
  }

  // A moment for the HTTP response and the progress socket to flush, so the
  // page says why it is about to go quiet.
  setTimeout(() => process.exit(0), 500)
}

function runNpm(args: string[], onLine?: (line: string) => void): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [npmCliPath(), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'production' },
    })
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
            new Error(`npm exited with ${code}${stderr ? `: ${stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`),
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
