import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
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
  type ObservedDevice,
} from '../notifications.js'
import { registerNotificationRoutes } from '../notification-routes.js'
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
    const events: Array<{ type: string; userId?: string }> = []
    store.subscribe((e) => events.push(e))
    addRows(1)
    store.markRead('ana')
    store.markRead('ana') // nothing left to read: no event
    expect(events).toEqual([{ type: 'added' }, { type: 'read', userId: 'ana' }])
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
    registerNotificationRoutes(a, store, authConfig)
    await a.ready()
    return a
  }

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
})
