/**
 * The bell: things that happened to the bridge that a person should hear about.
 *
 * A household bridge produces a great deal of chatter (every poll, every
 * reading) and a handful of events. Only events reach the bell: a device that
 * has stopped answering for long enough to matter, the same device coming
 * back, a plugin that failed, and an update worth installing. Everything else
 * stays in the device timeline and the log, where it already is.
 *
 * Follows "Notifications: Acta's system is the fleet standard" in the
 * workspace AGENTS.md, adapted to a bridge:
 *
 * - Rows are about the house, not about one person, so every row reaches
 *   everybody who signs in. What is per person is whether they have read it.
 * - A write that changes nothing tells nobody. Every row carries a key built
 *   from the thing and the state that justified it, and a key is announced
 *   once, ever. Re-checking for updates every six hours finds the same
 *   version and rings for nobody.
 * - The chasing half (reminder email) does not apply. OpenBridge has no email
 *   channel, and with nothing configured the queue is left alone.
 *
 * Stored as one small JSON file, capped, because the whole history a person
 * scrolls through is a few hundred rows and a database would be heavier than
 * the feature.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { randomUUID } from 'crypto'
import type { DeviceHealth, PluginStatus } from '@nubisco/openbridge-core'

/** Newest rows kept. Older ones fall off the end. */
export const MAX_NOTIFICATIONS = 200

/** Most announced keys remembered, so the file stays bounded too. */
const MAX_ANNOUNCED = 2000

/**
 * How long a device must be silent, continuously, before the bell rings.
 *
 * Ten minutes, set by Jose. Long enough that a router reboot or a slow poll
 * never rings, short enough that a gate that has fallen off the network is
 * noticed the same evening rather than from HomeKit a day later.
 */
export const OFFLINE_AFTER_SECONDS = 10 * 60

/** The person whose read state is kept when sign-in is off. */
export const LOCAL_USER = 'local'

export type NotificationKind =
  | 'device.offline'
  | 'device.online'
  | 'plugin.failed'
  | 'update.openbridge'
  | 'update.plugin'

/** Colour by consequence: warning needs doing, success is relief, info is news. */
export type NotificationVariant = 'warning' | 'success' | 'info'

/** Where a row opens. Null makes the row honestly inert. */
export type NotificationTarget =
  | { kind: 'device'; id: string }
  | { kind: 'plugin'; id: string }
  | { kind: 'settings' }
  | { kind: 'config' }

export interface StoredNotification {
  id: string
  kind: NotificationKind
  title: string
  body: string
  variant: NotificationVariant
  target: NotificationTarget | null
  createdAt: string
}

export interface NotificationView extends StoredNotification {
  read: boolean
}

export interface NotificationInput {
  /** The thing and the state that justified it. Announced at most once. */
  key: string
  kind: NotificationKind
  title: string
  body: string
  variant: NotificationVariant
  target: NotificationTarget | null
}

interface Outage {
  /** When the device last answered, which is when the outage began. */
  since: string
}

interface FileShape {
  notifications: StoredNotification[]
  /** Row ids each person has read. Pruned to rows that still exist. */
  readBy: Record<string, string[]>
  /** Keys already announced, newest last. */
  announced: string[]
  /** Devices currently announced as unreachable. */
  outages: Record<string, Outage>
  /** Plugins currently announced as failed, with the error that was announced. */
  failing: Record<string, string>
}

function empty(): FileShape {
  return { notifications: [], readBy: {}, announced: [], outages: {}, failing: {} }
}

export class NotificationStore {
  private state: FileShape
  private listeners = new Set<(event: { type: 'added' | 'read'; userId?: string }) => void>()

  constructor(
    private readonly path: string,
    private readonly clock: () => number = Date.now,
  ) {
    this.state = this.load()
  }

  /**
   * Add a row, unless its key has been announced before.
   *
   * Returns the row, or null when nothing was written. Never throws: the bell
   * is a report about the bridge, and failing to write one must not take down
   * the thing it reports on.
   */
  add(input: NotificationInput): StoredNotification | null {
    if (this.state.announced.includes(input.key)) return null
    const row: StoredNotification = {
      id: randomUUID(),
      kind: input.kind,
      title: input.title,
      body: input.body,
      variant: input.variant,
      target: input.target,
      createdAt: new Date(this.clock()).toISOString(),
    }
    this.state.notifications.unshift(row)
    this.state.notifications.length = Math.min(this.state.notifications.length, MAX_NOTIFICATIONS)
    this.state.announced.push(input.key)
    if (this.state.announced.length > MAX_ANNOUNCED) {
      this.state.announced.splice(0, this.state.announced.length - MAX_ANNOUNCED)
    }
    this.pruneReadState()
    this.save()
    this.emit({ type: 'added' })
    return row
  }

  /** The newest rows as one person sees them, and their unread count over every row. */
  list(userId: string, limit = 50): { notifications: NotificationView[]; unread: number } {
    const read = new Set(this.state.readBy[userId] ?? [])
    const capped = Math.min(Math.max(1, Math.floor(limit) || 50), MAX_NOTIFICATIONS)
    const notifications = this.state.notifications.slice(0, capped).map((n) => ({ ...n, read: read.has(n.id) }))
    return { notifications, unread: this.unreadCount(userId) }
  }

  /**
   * The badge. Counted over every stored row, never over the page the client
   * happened to load, which is how Acta's badge came to understate.
   */
  unreadCount(userId: string): number {
    const read = new Set(this.state.readBy[userId] ?? [])
    return this.state.notifications.filter((n) => !read.has(n.id)).length
  }

  /** Mark some rows read for one person, or all of them when no ids are given. */
  markRead(userId: string, ids?: string[]): number {
    const known = new Set(this.state.notifications.map((n) => n.id))
    const read = new Set(this.state.readBy[userId] ?? [])
    const before = read.size
    for (const id of ids ?? known) if (known.has(id)) read.add(id)
    if (read.size !== before) {
      this.state.readBy[userId] = [...read]
      this.save()
      this.emit({ type: 'read', userId })
    }
    return this.unreadCount(userId)
  }

  /** Told about every write, for live delivery to open tabs. */
  subscribe(listener: (event: { type: 'added' | 'read'; userId?: string }) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // ─── State the watchers keep across restarts ─────────────────────────────

  outage(deviceId: string): Outage | undefined {
    return this.state.outages[deviceId]
  }

  setOutage(deviceId: string, outage: Outage | null): void {
    if (outage) this.state.outages[deviceId] = outage
    else delete this.state.outages[deviceId]
    this.save()
  }

  failing(key: string): string | undefined {
    return this.state.failing[key]
  }

  setFailing(key: string, error: string | null): void {
    if (error === null) {
      if (!(key in this.state.failing)) return
      delete this.state.failing[key]
    } else {
      this.state.failing[key] = error
    }
    this.save()
  }

  private pruneReadState(): void {
    const known = new Set(this.state.notifications.map((n) => n.id))
    for (const [user, ids] of Object.entries(this.state.readBy)) {
      this.state.readBy[user] = ids.filter((id) => known.has(id))
    }
  }

  private emit(event: { type: 'added' | 'read'; userId?: string }): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        /* one closed tab must not stop the others hearing */
      }
    }
  }

  private load(): FileShape {
    try {
      if (!existsSync(this.path)) return empty()
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<FileShape>
      return {
        notifications: Array.isArray(raw.notifications) ? raw.notifications : [],
        readBy: raw.readBy && typeof raw.readBy === 'object' ? raw.readBy : {},
        announced: Array.isArray(raw.announced) ? raw.announced : [],
        outages: raw.outages && typeof raw.outages === 'object' ? raw.outages : {},
        failing: raw.failing && typeof raw.failing === 'object' ? raw.failing : {},
      }
    } catch {
      // A corrupt file costs the history, not the bridge.
      return empty()
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      // Written aside and renamed, so a power cut mid-write leaves the old
      // file rather than half of a new one.
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, JSON.stringify(this.state))
      renameSync(tmp, this.path)
    } catch {
      /* the bell must not break the bridge it reports on */
    }
  }
}

// ─── Devices ────────────────────────────────────────────────────────────────

export interface ObservedDevice {
  id: string
  name: string
  pluginStatus: string
  health: DeviceHealth
}

function humanDuration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} seconds`
  const minutes = seconds / 60
  if (minutes < 90) return `${Math.round(minutes)} minutes`
  const hours = minutes / 60
  if (hours < 48) return `${Math.round(hours)} hours`
  return `${Math.round(hours / 24)} days`
}

/**
 * Turn device health, read on every tick, into one row when a device crosses
 * the line and one when it comes back.
 *
 * Health is derived from the `_updatedAt` stamp `reportTelemetry` writes for
 * every device of every native plugin (see device-health.ts), so this needs no
 * cooperation from plugins. A device of a plugin that is not running is
 * skipped: the plugin's own failure explains all of its devices at once, and
 * thirty rows saying "not responding" would bury the one that says why.
 */
export function observeDevices(store: NotificationStore, devices: ObservedDevice[], now: number): void {
  for (const device of devices) {
    if (device.pluginStatus !== 'running') continue
    const { health } = device
    const open = store.outage(device.id)

    if (!open) {
      // Stale already allows for the device's own interval, so a device that
      // reports every five minutes is not accused at ten. The ten minutes are
      // a floor on top of that, not a replacement for it.
      const silent = health.silentForSeconds ?? 0
      if (health.status !== 'stale' || !health.lastSeen || silent < OFFLINE_AFTER_SECONDS) continue
      store.setOutage(device.id, { since: health.lastSeen })
      store.add({
        key: `device.offline:${device.id}:${health.lastSeen}`,
        kind: 'device.offline',
        title: `${device.name} is not responding`,
        body: `No response for ${humanDuration(silent)}. It may be powered off, or its address may have changed.`,
        variant: 'warning',
        target: { kind: 'device', id: device.id },
      })
      continue
    }

    if (health.status === 'ok') {
      store.setOutage(device.id, null)
      const back = health.lastSeen ? Date.parse(health.lastSeen) : now
      const outageSeconds = Math.max(0, (back - Date.parse(open.since)) / 1000)
      store.add({
        key: `device.online:${device.id}:${open.since}`,
        kind: 'device.online',
        title: `${device.name} is back online`,
        body: `It answered again after ${humanDuration(outageSeconds)} without a response.`,
        variant: 'success',
        target: { kind: 'device', id: device.id },
      })
    }
  }
}

// ─── Plugins ────────────────────────────────────────────────────────────────

export interface ObservedPlugin {
  id: string
  name: string
  status: PluginStatus
  error?: string
  disabled?: boolean
}

/**
 * One row when a plugin enters the error state, and none while it stays
 * there or is retried and fails the same way again.
 *
 * Cleared once the plugin runs, so a crash after a recovery is news again.
 * The failing set is stored, so a plugin that fails the same way at every
 * start does not ring again on every restart of the daemon.
 */
export function observePlugins(store: NotificationStore, plugins: ObservedPlugin[], now: number): void {
  for (const plugin of plugins) {
    const key = `plugin:${plugin.id}`
    if (plugin.status === 'running') {
      store.setFailing(key, null)
      continue
    }
    if (plugin.status !== 'error' || plugin.disabled) continue
    const error = plugin.error?.trim() || 'It stopped with an error.'
    if (store.failing(key) !== undefined) continue
    store.setFailing(key, error)
    store.add({
      key: `plugin.failed:${plugin.id}:${now}`,
      kind: 'plugin.failed',
      title: `${plugin.name} stopped working`,
      body: firstLine(error),
      variant: 'warning',
      target: { kind: 'plugin', id: plugin.id },
    })
  }
}

/**
 * A plugin that could not be loaded at all.
 *
 * Distinct from the error state above: a module that throws on import never
 * reaches the registry as a running plugin, so there is no status to watch.
 * The daemon calls this from the places it catches the failure.
 */
export function pluginLoadFailed(
  store: NotificationStore,
  plugin: { key: string; name: string; target: NotificationTarget | null },
  err: unknown,
  now: number,
): void {
  const error = firstLine(err instanceof Error ? err.message : String(err))
  const key = `load:${plugin.key}`
  if (store.failing(key) === error) return
  store.setFailing(key, error)
  store.add({
    key: `plugin.failed:${key}:${now}`,
    kind: 'plugin.failed',
    title: `${plugin.name} could not be loaded`,
    body: error,
    variant: 'warning',
    target: plugin.target,
  })
}

/** The counterpart: a plugin that loaded is no longer failing to. */
export function pluginLoaded(store: NotificationStore, pluginKey: string): void {
  store.setFailing(`load:${pluginKey}`, null)
}

function firstLine(text: string): string {
  const line = text.split('\n')[0]?.trim() ?? ''
  return line.length > 300 ? `${line.slice(0, 297)}...` : line
}

// ─── Updates ────────────────────────────────────────────────────────────────

/**
 * Whether `latest` is newer than `current`, by numeric dotted version.
 *
 * Not `!==`: a development build ahead of npm would otherwise be told to
 * "update" to an older release.
 */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/, '')
      .split('-')[0]!
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0)
  const a = parse(latest)
  const b = parse(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

/** One row per new OpenBridge version, however often the check runs. */
export function openBridgeUpdate(store: NotificationStore, current: string, latest: string | null): void {
  if (!latest || !isNewer(latest, current)) return
  store.add({
    key: `update.openbridge:${latest}`,
    kind: 'update.openbridge',
    title: `OpenBridge v${latest} is available`,
    body: `You are on v${current}.`,
    variant: 'info',
    target: { kind: 'settings' },
  })
}

/** One row per new plugin version, however often the check runs. */
export function pluginUpdate(
  store: NotificationStore,
  plugin: { id: string; name: string; current: string },
  latest: string,
): void {
  if (!isNewer(latest, plugin.current)) return
  store.add({
    key: `update.plugin:${plugin.name}:${latest}`,
    kind: 'update.plugin',
    title: `${plugin.name} v${latest} is available`,
    body: `You are on v${plugin.current}.`,
    variant: 'info',
    target: { kind: 'plugin', id: plugin.id },
  })
}
