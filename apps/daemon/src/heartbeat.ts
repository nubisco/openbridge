/**
 * The anonymous install heartbeat.
 *
 * One POST to the Nubisco downloads host per start, and one every 24 hours
 * while the daemon keeps running, so an install that never restarts still
 * counts as active. It carries a random install id, the version, the platform
 * and the install method, and nothing else: no hostname, no user, no device
 * or plugin. The id is generated once and kept in the data directory, so a
 * reinstall into the same home is the same install and a fresh home is a new
 * one.
 *
 * Fire and forget, by contract: a 4 s timeout, no retry, every error
 * swallowed, nothing queued while offline. The send never delays startup,
 * and `isEnabled` is asked before every send so the setting applies without
 * a restart.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'

export const HEARTBEAT_URL = 'https://downloads.nubisco.io/ping'
export const HEARTBEAT_TIMEOUT_MS = 4_000
export const HEARTBEAT_INTERVAL_MS = 24 * 60 * 60_000
/** The file, in the data directory, that makes an install an install. */
export const INSTALL_FILE = 'install.json'

export type HeartbeatInstallMethod = 'homebrew' | 'npm' | 'docker' | 'script' | 'dmg' | 'appstore' | 'source' | 'other'

export interface Heartbeat {
  product: 'openbridge'
  version: string
  installId: string
  firstRun?: true
  previousVersion?: string
  installMethod?: HeartbeatInstallMethod
  os?: 'darwin' | 'linux' | 'win32'
  arch?: 'arm64' | 'x64'
}

/** What install.json holds. */
interface InstallRecord {
  installId: string
  /** The version that ran last, so the next start can tell it was updated. */
  lastVersion?: string
}

export interface InstallState {
  installId: string
  /** True when install.json did not exist: this is the install's first start. */
  firstRun: boolean
  /** The version that ran before this one, when it is known and differs. */
  previousVersion: string | null
}

/**
 * Read install.json, or create it, and record `version` as the one now
 * running. The record is written before the heartbeat is sent, so a failed
 * send does not turn the next start into a second "first run".
 */
export function recordInstallStart(home: string, version: string): InstallState {
  const path = join(home, INSTALL_FILE)
  let existing: InstallRecord | null = null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<InstallRecord>
    if (typeof raw.installId === 'string' && raw.installId) {
      existing = {
        installId: raw.installId,
        ...(typeof raw.lastVersion === 'string' ? { lastVersion: raw.lastVersion } : {}),
      }
    }
  } catch {
    /* absent or unreadable: a new install either way */
  }

  const record: InstallRecord = { installId: existing?.installId ?? randomUUID(), lastVersion: version }
  try {
    if (!existsSync(home)) mkdirSync(home, { recursive: true })
    // Same permissions as session.key: the id is random, but it is still
    // this install's and nobody else's business.
    writeFileSync(path, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
    try {
      chmodSync(path, 0o600)
    } catch {
      /* non-POSIX volume */
    }
  } catch {
    /* read-only home: the id is used for this run and regenerated next time */
  }

  const previous = existing?.lastVersion
  return {
    installId: record.installId,
    firstRun: existing === null,
    previousVersion: previous && previous !== version ? previous : null,
  }
}

function hostOs(platform: NodeJS.Platform): Heartbeat['os'] | undefined {
  return platform === 'darwin' || platform === 'linux' || platform === 'win32' ? platform : undefined
}

function hostArch(arch: string): Heartbeat['arch'] | undefined {
  return arch === 'arm64' || arch === 'x64' ? arch : undefined
}

/** The body, exactly as the contract lists it, with optional fields omitted rather than null. */
export function buildHeartbeat(
  state: InstallState,
  version: string,
  installMethod: HeartbeatInstallMethod,
  host: { platform: NodeJS.Platform; arch: string } = process,
): Heartbeat {
  return {
    product: 'openbridge',
    version,
    installId: state.installId,
    ...(state.firstRun ? { firstRun: true as const } : {}),
    ...(state.previousVersion ? { previousVersion: state.previousVersion } : {}),
    installMethod,
    ...(hostOs(host.platform) ? { os: hostOs(host.platform) } : {}),
    ...(hostArch(host.arch) ? { arch: hostArch(host.arch) } : {}),
  }
}

/** One POST. Resolves whatever happens: this is the one request that may never fail anything. */
export async function sendHeartbeat(
  body: Heartbeat,
  fetchImpl: typeof fetch = fetch,
  url: string = HEARTBEAT_URL,
): Promise<void> {
  try {
    await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': `openbridge/${body.version}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
    })
  } catch {
    /* offline, timed out, refused: all the same, and none of them ours to report */
  }
}

export interface HeartbeatOptions {
  /** The data directory, where install.json lives. */
  home: string
  version: string
  installMethod: HeartbeatInstallMethod
  /** Asked before every send, so turning the setting off takes effect at once. */
  isEnabled: () => boolean
  fetchImpl?: typeof fetch
  url?: string
  intervalMs?: number
  host?: { platform: NodeJS.Platform; arch: string }
}

/**
 * Start the heartbeat: once now, then daily. Returns a stop function. The
 * timer is unref'd, so it never keeps the process alive.
 *
 * install.json is written even while the heartbeat is off, so that an install
 * which turns it on later still knows its own age and previous version. The
 * first-run flag belongs to the first start, not the first send.
 */
export function startInstallHeartbeat(options: HeartbeatOptions): () => void {
  const { home, version, installMethod, isEnabled, fetchImpl, url, host } = options
  const state = recordInstallStart(home, version)
  const body = buildHeartbeat(state, version, installMethod, host)

  const send = (b: Heartbeat) => {
    if (!isEnabled()) return
    void sendHeartbeat(b, fetchImpl, url)
  }

  // The first send carries firstRun and previousVersion. The daily ones are
  // the same install reporting it is still here, so they carry neither.
  send(body)
  const daily: Heartbeat = buildHeartbeat(
    { ...state, firstRun: false, previousVersion: null },
    version,
    installMethod,
    host,
  )
  const timer = setInterval(() => send(daily), options.intervalMs ?? HEARTBEAT_INTERVAL_MS)
  timer.unref()
  return () => clearInterval(timer)
}
