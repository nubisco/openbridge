import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHmac } from 'crypto'
import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import type { DeviceHealth } from '@nubisco/openbridge-core'
import { assessDeviceHealth } from '../device-health.js'
import {
  LOCAL_USER,
  MAX_NOTIFICATIONS,
  NotificationStore,
  OFFLINE_AFTER_SECONDS,
  isNewer,
  observeDevices,
  observePlugins,
  openBridgeUpdate,
  pluginLoadFailed,
  pluginLoaded,
  pluginUpdate,
  type NotificationEvent,
  type ObservedDevice,
} from '../notifications.js'
import { REAUTH_CLOSE_CODE, SOCKET_MAX_AGE_MS, registerNotificationRoutes } from '../notification-routes.js'
import type { TAuthConfig } from '../auth.js'

const T0 = Date.parse('2026-11-05T12:00:00.000Z')

let dir: string
let path: string
let now: number
let store: NotificationStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ob-notifications-'))
  path = join(dir, 'notifications.json')
  now = T0
  store = new NotificationStore(path, () => now)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A device that last answered at `lastSeen`, as the daemon sees it at `now`. */
function device(lastSeen: number, opts: { pluginStatus?: string; interval?: number } = {}): ObservedDevice {
  const health: DeviceHealth = assessDeviceHealth({
    telemetry: { _updatedAt: new Date(lastSeen).toISOString() },
    intervalSeconds: opts.interval,
    pluginStatus: opts.pluginStatus ?? 'running',
    now,
  })
  return { id: 'gate', name: 'Gate', pluginStatus: opts.pluginStatus ?? 'running', health }
}

describe('a device that stops answering', () => {
  it('says nothing before ten minutes of silence, even once health calls it stale', () => {
    // Stale for a 30s device starts at two minutes. The bell waits for ten.
    const lastSeen = T0
    now = T0 + (OFFLINE_AFTER_SECONDS - 1) * 1000
    const d = device(lastSeen)
    expect(d.health.status).toBe('stale')
    observeDevices(store, [d], now)
    expect(store.list(LOCAL_USER).notifications).toHaveLength(0)
  })

  it('rings once when it crosses ten minutes, not once per poll', () => {
    const lastSeen = T0
    for (const minutes of [10, 11, 12, 30, 120]) {
      now = T0 + minutes * 60_000
      observeDevices(store, [device(lastSeen)], now)
    }
    const { notifications } = store.list(LOCAL_USER)
    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({
      kind: 'device.offline',
      title: 'Gate is not responding',
      variant: 'warning',
      target: { kind: 'device', id: 'gate' },
    })
  })

  it('honours a slow device whose own interval is longer than ten minutes', () => {
    // Reports every five minutes: stale only after four intervals, twenty minutes.
    now = T0 + 15 * 60_000
    observeDevices(store, [device(T0, { interval: 300 })], now)
    expect(store.list(LOCAL_USER).notifications).toHaveLength(0)
    now = T0 + 21 * 60_000
    observeDevices(store, [device(T0, { interval: 300 })], now)
    expect(store.list(LOCAL_USER).notifications).toHaveLength(1)
  })

  it('leaves the devices of a stopped plugin to the plugin row', () => {
    now = T0 + 60 * 60_000
    observeDevices(store, [device(T0, { pluginStatus: 'error' })], now)
    expect(store.list(LOCAL_USER).notifications).toHaveLength(0)
  })

  it('adds a back-online row when it answers again, and only once', () => {
    now = T0 + 11 * 60_000
    observeDevices(store, [device(T0)], now)
    now = T0 + 70 * 60_000
    observeDevices(store, [device(now)], now)
    observeDevices(store, [device(now)], now + 15_000)
    const { notifications } = store.list(LOCAL_USER)
    expect(notifications.map((n) => n.kind)).toEqual(['device.online', 'device.offline'])
    expect(notifications[0]).toMatchObject({ title: 'Gate is back online', variant: 'success' })
    expect(notifications[0]!.body).toContain('70 minutes')
  })

  it('says nothing when a device comes back that was never announced', () => {
    now = T0 + 3 * 60_000
    observeDevices(store, [device(T0)], now)
    observeDevices(store, [device(now)], now)
    expect(store.list(LOCAL_USER).notifications).toHaveLength(0)
  })

  it('keeps an open outage across a restart, so the return is still told', () => {
    now = T0 + 11 * 60_000
    observeDevices(store, [device(T0)], now)
    const reopened = new NotificationStore(path, () => now)
    observeDevices(reopened, [device(T0)], now + 60_000)
    now = T0 + 30 * 60_000
    observeDevices(reopened, [device(now)], now)
    expect(reopened.list(LOCAL_USER).notifications.map((n) => n.kind)).toEqual(['device.online', 'device.offline'])
  })
})

describe('a write that changes nothing tells nobody', () => {
  it('announces a key once, ever', () => {
    const input = {
      key: 'k',
      kind: 'update.openbridge' as const,
      title: 't',
      body: 'b',
      variant: 'info' as const,
      target: null,
    }
    expect(store.add(input)).not.toBeNull()
    expect(store.add(input)).toBeNull()
    expect(new NotificationStore(path).add(input)).toBeNull()
  })

  it('tells about a new OpenBridge version once, however often the check runs', () => {
    for (let i = 0; i < 5; i++) openBridgeUpdate(store, '1.6.0', '1.7.0')
    openBridgeUpdate(store, '1.6.0', '1.8.0')
    expect(store.list(LOCAL_USER).notifications.map((n) => n.title)).toEqual([
      'OpenBridge v1.8.0 is available',
      'OpenBridge v1.7.0 is available',
    ])
    expect(store.list(LOCAL_USER).notifications[0]!.target).toEqual({ kind: 'settings' })
  })

  it('does not offer a development build an older release', () => {
    openBridgeUpdate(store, '1.7.0-dev', '1.6.0')
    pluginUpdate(store, { id: 'p', name: 'p', current: '2.0.0' }, '1.9.9')
    expect(store.list(LOCAL_USER).notifications).toHaveLength(0)
    expect(isNewer('1.10.0', '1.9.0')).toBe(true)
  })

  it('tells about a plugin update once per version', () => {
    for (let i = 0; i < 3; i++) pluginUpdate(store, { id: 'Shelly', name: 'shelly', current: '1.0.0' }, '1.1.0')
    expect(store.list(LOCAL_USER).notifications).toHaveLength(1)
    expect(store.list(LOCAL_USER).notifications[0]!.target).toEqual({ kind: 'plugin', id: 'Shelly' })
  })

  it('tells about a plugin failure once until it runs again', () => {
    const failed = [{ id: 'tuya', name: 'Tuya', status: 'error' as const, error: 'boom\nstack' }]
    observePlugins(store, failed, now)
    observePlugins(store, [{ ...failed[0]!, status: 'loading' }], now + 1)
    observePlugins(store, failed, now + 2)
    expect(store.list(LOCAL_USER).notifications).toHaveLength(1)
    expect(store.list(LOCAL_USER).notifications[0]).toMatchObject({ body: 'boom', variant: 'warning' })

    observePlugins(store, [{ ...failed[0]!, status: 'running' }], now + 3)
    observePlugins(store, failed, now + 4)
    expect(store.list(LOCAL_USER).notifications).toHaveLength(2)
  })

  it('tells about a load failure once, even across restarts, until it loads', () => {
    const plugin = { key: '/p/index.js', name: 'Pool', target: { kind: 'config' as const } }
    pluginLoadFailed(store, plugin, new Error('missing module'), now)
    pluginLoadFailed(new NotificationStore(path), plugin, new Error('missing module'), now + 1)
    expect(new NotificationStore(path).list(LOCAL_USER).notifications).toHaveLength(1)
    pluginLoaded(store, plugin.key)
    pluginLoadFailed(store, plugin, new Error('missing module'), now + 2)
    expect(store.list(LOCAL_USER).notifications).toHaveLength(2)
  })
})

describe('unread count and read state', () => {
  function addRows(n: number) {
    for (let i = 0; i < n; i++) {
      now += 1000
      store.add({ key: `r${i}`, kind: 'update.plugin', title: `r${i}`, body: '', variant: 'info', target: null })
    }
  }

  it('counts every stored row, not the page the client loaded', () => {
    addRows(60)
    const { notifications, unread } = store.list(LOCAL_USER, 10)
    expect(notifications).toHaveLength(10)
    expect(unread).toBe(60)
  })

  it('keeps the newest rows only', () => {
    addRows(MAX_NOTIFICATIONS + 5)
    const { notifications, unread } = store.list(LOCAL_USER, 1000)
    expect(notifications).toHaveLength(MAX_NOTIFICATIONS)
    expect(notifications[0]!.title).toBe(`r${MAX_NOTIFICATIONS + 4}`)
    expect(unread).toBe(MAX_NOTIFICATIONS)
  })

  it('keeps read state per person', () => {
    addRows(3)
    const [newest] = store.list('ana').notifications
    expect(store.markRead('ana', [newest!.id])).toBe(2)
    expect(store.unreadCount('ana')).toBe(2)
    expect(store.unreadCount('ben')).toBe(3)
    expect(store.list('ana').notifications[0]!.read).toBe(true)
    expect(store.list('ben').notifications[0]!.read).toBe(false)

    expect(store.markRead('ben')).toBe(0)
    expect(store.unreadCount('ana')).toBe(2)
    expect(new NotificationStore(path).unreadCount('ben')).toBe(0)
  })

  it('tells only the reader when somebody reads, and everybody when a row is added', () => {
    const events: NotificationEvent[] = []
    store.subscribe((e) => events.push(e))
    addRows(1)
    const id = store.list('ana').notifications[0]!.id
    store.markRead('ana')
    store.markRead('ana') // nothing left to read: no event
    expect(events).toEqual([
      { verb: 'notification.created', id },
      { verb: 'notification.read', userId: 'ana' },
    ])
  })
})

describe('clearing', () => {
  function addRows(n: number, prefix = 'r') {
    for (let i = 0; i < n; i++) {
      now += 1000
      store.add({
        key: `${prefix}${i}`,
        kind: 'update.plugin',
        title: `${prefix}${i}`,
        body: '',
        variant: 'info',
        target: null,
      })
    }
  }

  it("takes a row out of one person's list and nobody else's", () => {
    addRows(3)
    const [newest] = store.list('ana').notifications
    expect(store.clear('ana', { ids: [newest!.id] })).toBe(2)
    expect(store.list('ana').notifications.map((n) => n.title)).toEqual(['r1', 'r0'])
    expect(store.list('ben').notifications.map((n) => n.title)).toEqual(['r2', 'r1', 'r0'])
    expect(store.unreadCount('ben')).toBe(3)
  })

  it('counts a cleared row as read, so it owes no badge and no desktop notification', () => {
    addRows(2)
    store.clear('ana')
    expect(store.unreadCount('ana')).toBe(0)
    expect(store.list('ana')).toEqual({ notifications: [], unread: 0 })
  })

  it('clears up to the newest row the person saw, never one that arrived after', () => {
    addRows(2)
    const seen = store.list('ana').notifications[0]!.createdAt
    now += 1000
    store.add({ key: 'late', kind: 'update.plugin', title: 'late', body: '', variant: 'info', target: null })
    expect(store.clear('ana', { before: seen })).toBe(1)
    expect(store.list('ana').notifications.map((n) => n.title)).toEqual(['late'])
  })

  it('shows rows that arrive after a clear', () => {
    addRows(1)
    store.clear('ana')
    now += 1000
    store.add({ key: 'next', kind: 'update.plugin', title: 'next', body: '', variant: 'info', target: null })
    expect(store.list('ana')).toMatchObject({ notifications: [{ title: 'next', read: false }], unread: 1 })
  })

  it('survives a restart', () => {
    addRows(2)
    store.clear('ana', { ids: [store.list('ana').notifications[0]!.id] })
    const reopened = new NotificationStore(path, () => now)
    expect(reopened.list('ana').notifications.map((n) => n.title)).toEqual(['r0'])
  })

  it("tells only that person's tabs, and nobody when nothing changed", () => {
    addRows(1)
    const id = store.list('ana').notifications[0]!.id
    const events: NotificationEvent[] = []
    store.subscribe((e) => events.push(e))
    store.clear('ana', { ids: [id] })
    store.clear('ana', { ids: [id] })
    store.clear('ana', { ids: ['no-such-row'] })
    expect(events).toEqual([{ verb: 'notification.cleared', userId: 'ana', id }])
  })

  it('reads a file written before clearing existed', () => {
    const row = {
      id: 'old-1',
      kind: 'update.openbridge',
      title: 'OpenBridge v1.20.0 is available',
      body: 'You are on v1.19.0.',
      variant: 'info',
      target: { kind: 'settings' },
      createdAt: '2026-11-01T10:00:00.000Z',
    }
    writeFileSync(
      path,
      JSON.stringify({ notifications: [row], readBy: { ana: ['old-1'] }, announced: ['k'], outages: {}, failing: {} }),
    )
    const old = new NotificationStore(path, () => now)
    expect(old.list('ana')).toEqual({ notifications: [{ ...row, read: true }], unread: 0 })
    expect(old.list('ben').unread).toBe(1)
    expect(old.clear('ben')).toBe(0)
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    expect(saved.clearedBy).toEqual({ ben: ['old-1'] })
    expect(saved.readBy.ana).toEqual(['old-1'])
  })

  it('forgets cleared ids once their rows fall off the end', () => {
    addRows(1)
    store.clear('ana')
    addRows(MAX_NOTIFICATIONS, 'later')
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    expect(saved.clearedBy.ana).toEqual([])
  })
})

describe('routes', () => {
  const secret = Buffer.from('a-test-secret-of-enough-length')
  const auth: TAuthConfig = { enabled: true, issuer: 'https://auth.test', authOrigin: null, appId: null, secret }

  function cookieFor(userId: string): string {
    const data = Buffer.from(
      JSON.stringify({ userId, email: `${userId}@x.test`, exp: Math.floor(Date.now() / 1000) + 600 }),
    ).toString('base64url')
    const sig = createHmac('sha256', secret).update(data).digest('base64url')
    return `openbridge_session=${data}.${sig}`
  }

  async function app(authConfig: TAuthConfig | null) {
    const a = Fastify()
    await a.register(websocket)
    registerNotificationRoutes(a, store, authConfig, () => now)
    await a.ready()
    return a
  }

  /** Open the socket and collect what it is sent, and how it closes. */
  async function socket(a: Awaited<ReturnType<typeof app>>, headers: Record<string, string> = {}) {
    const frames: unknown[] = []
    let closed: number | null = null
    const ws = await a.injectWS('/ws/notifications', { headers })
    ws.on('message', (data: Buffer) => frames.push(JSON.parse(data.toString())))
    ws.on('close', (code: number) => (closed = code))
    return { ws, frames, closed: () => closed }
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

  it('lists with the unread count, and marks read for the local person when sign-in is off', async () => {
    openBridgeUpdate(store, '1.6.0', '1.7.0')
    pluginUpdate(store, { id: 'p', name: 'p', current: '1.0.0' }, '1.0.1')
    const a = await app(null)
    const list = await a.inject({ method: 'GET', url: '/api/notifications' })
    expect(list.json().unread).toBe(2)
    const id = list.json().notifications[0].id
    const read = await a.inject({ method: 'POST', url: '/api/notifications/read', payload: { ids: [id] } })
    expect(read.json()).toEqual({ unread: 1 })
    expect(store.unreadCount(LOCAL_USER)).toBe(1)
    await a.close()
  })

  it('keeps read state per signed-in person', async () => {
    openBridgeUpdate(store, '1.6.0', '1.7.0')
    const a = await app(auth)
    await a.inject({ method: 'POST', url: '/api/notifications/read', headers: { cookie: cookieFor('ana') } })
    const ana = await a.inject({ method: 'GET', url: '/api/notifications', headers: { cookie: cookieFor('ana') } })
    const ben = await a.inject({ method: 'GET', url: '/api/notifications', headers: { cookie: cookieFor('ben') } })
    expect(ana.json().unread).toBe(0)
    expect(ben.json().unread).toBe(1)
    await a.close()
  })
  it('clears for the person asking, up to what they saw', async () => {
    openBridgeUpdate(store, '1.6.0', '1.7.0')
    const a = await app(auth)
    const seen = store.list('ana').notifications[0]!.createdAt
    now += 1000
    pluginUpdate(store, { id: 'p', name: 'p', current: '1.0.0' }, '1.0.1')
    const res = await a.inject({
      method: 'POST',
      url: '/api/notifications/clear',
      headers: { cookie: cookieFor('ana') },
      payload: { before: seen },
    })
    expect(res.json()).toEqual({ unread: 1 })
    expect(store.list('ana').notifications.map((n) => n.kind)).toEqual(['update.plugin'])
    expect(store.list('ben').notifications).toHaveLength(2)
    await a.close()
  })

  it('refuses a clear with a date it cannot read, rather than clearing everything', async () => {
    openBridgeUpdate(store, '1.6.0', '1.7.0')
    const a = await app(null)
    const res = await a.inject({ method: 'POST', url: '/api/notifications/clear', payload: { before: 'yesterday' } })
    expect(res.statusCode).toBe(400)
    expect(store.list(LOCAL_USER).notifications).toHaveLength(1)
    await a.close()
  })

  it('sends what changed and never the row, to the tabs it concerns', async () => {
    const a = await app(auth)
    const ana = await socket(a, { cookie: cookieFor('ana'), host: 'bridge.test', origin: 'https://bridge.test' })
    const ben = await socket(a, { cookie: cookieFor('ben'), host: 'bridge.test', origin: 'https://bridge.test' })
    openBridgeUpdate(store, '1.6.0', '1.7.0')
    const id = store.list('ana').notifications[0]!.id
    store.markRead('ana', [id])
    store.clear('ana', { ids: [id] })
    await settle()
    const created = { verb: 'notification.created', entity: 'notification', id, actor: 'bridge' }
    expect(ana.frames).toEqual([
      created,
      { verb: 'notification.read', entity: 'notification', id, actor: 'person' },
      { verb: 'notification.cleared', entity: 'notification', id, actor: 'person' },
    ])
    expect(ben.frames).toEqual([created])
    ana.ws.terminate()
    ben.ws.terminate()
    await a.close()
  })

  it('refuses a socket opened from another site', async () => {
    const a = await app(null)
    const evil = await socket(a, { host: 'bridge.test', origin: 'https://evil.test' })
    await settle()
    expect(evil.closed()).toBe(1008)
    openBridgeUpdate(store, '1.6.0', '1.7.0')
    await settle()
    expect(evil.frames).toEqual([])
    await a.close()
  })

  it('accepts its own page behind a proxy that rewrites the host', async () => {
    const a = await app(null)
    const own = await socket(a, {
      host: 'localhost:8582',
      'x-forwarded-host': 'openbridge.example.test',
      origin: 'https://openbridge.example.test',
    })
    openBridgeUpdate(store, '1.6.0', '1.7.0')
    await settle()
    expect(own.frames).toHaveLength(1)
    expect(own.closed()).toBeNull()
    own.ws.terminate()
    await a.close()
  })

  it('makes a signed-in socket sign in again after thirty minutes', async () => {
    const a = await app(auth)
    const ana = await socket(a, { cookie: cookieFor('ana') })
    now += SOCKET_MAX_AGE_MS + 1000
    openBridgeUpdate(store, '1.6.0', '1.7.0')
    await settle()
    expect(ana.frames).toEqual([])
    expect(ana.closed()).toBe(REAUTH_CLOSE_CODE)
    await a.close()
  })

  it('keeps a socket open past thirty minutes when sign-in is off, as there is nothing to re-check', async () => {
    const a = await app(null)
    const local = await socket(a)
    now += SOCKET_MAX_AGE_MS + 1000
    openBridgeUpdate(store, '1.6.0', '1.7.0')
    await settle()
    expect(local.frames).toHaveLength(1)
    local.ws.terminate()
    await a.close()
  })
})
