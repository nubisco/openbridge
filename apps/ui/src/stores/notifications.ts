import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { get } from '@/api'

/**
 * The bell's state, after Acta's (`acta/web/src/stores/workspace.ts`), which
 * is the fleet standard (see "Notifications" in the workspace AGENTS.md).
 *
 * - The badge is the daemon's unread count, never a count of the rows loaded.
 * - A failed read is reported to the caller, so the bell can say so rather
 *   than claim there is nothing to see.
 * - Open tabs hear about changes over /ws/notifications and re-read, so the
 *   list is always the daemon's, read state included.
 * - Anything new while the tab is open is also raised as a desktop
 *   notification, if this browser allows it, and clicking one marks it read.
 */

export type NotificationTarget =
  | { kind: 'device'; id: string }
  | { kind: 'plugin'; id: string }
  | { kind: 'settings' }
  | { kind: 'config' }

export interface BridgeNotification {
  id: string
  kind: 'device.offline' | 'device.online' | 'plugin.failed' | 'update.openbridge' | 'update.plugin'
  title: string
  body: string
  variant: 'warning' | 'success' | 'info'
  target: NotificationTarget | null
  createdAt: string
  read: boolean
}

/** The line under a desktop notification, which says what kind of thing happened. */
export function announceReason(n: BridgeNotification): string {
  if (n.kind === 'device.offline' || n.kind === 'device.online') return n.body || 'A device changed state'
  if (n.kind === 'plugin.failed') return 'A plugin needs attention'
  return 'An update is available'
}

/** This browser's answer about desktop notifications, or that it cannot give one. */
export type DesktopPermission = 'default' | 'granted' | 'denied' | 'unsupported'

/** Ids already shown as a desktop notification, so a re-read never repeats one. */
const announced = new Set<string>()

export const useNotificationsStore = defineStore('notifications', () => {
  const items = ref<BridgeNotification[]>([])
  const unreadTotal = ref(0)
  /**
   * Whether the list has been read at all yet. Explicit rather than inferred
   * from an empty list: someone whose first read returns nothing would
   * otherwise have their first real notification swallowed as history.
   */
  let loaded = false
  /** Set by the bell, so a clicked desktop notification can open its row in place. */
  let opener: ((n: BridgeNotification) => void) | null = null

  const unread = computed(() => unreadTotal.value)

  /** Read the list. Resolves false when it could not be read. */
  async function load(): Promise<boolean> {
    const res = await get<{ notifications: BridgeNotification[]; unread: number }>('/notifications?limit=50').catch(
      () => null,
    )
    if (!res) return false
    // The first read fills the set without announcing: everything unread from
    // before the tab opened is history, not news.
    const first = !loaded
    loaded = true
    items.value = res.notifications
    const listed = res.notifications.filter((n) => !n.read).length
    unreadTotal.value = typeof res.unread === 'number' ? Math.max(res.unread, listed) : listed
    for (const n of res.notifications) {
      if (n.read || announced.has(n.id)) continue
      announced.add(n.id)
      if (!first) announce(n)
    }
    return true
  }

  async function post(ids?: string[]): Promise<void> {
    try {
      const res = await fetch('/api/notifications/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ids ? { ids } : {}),
      })
      if (res.ok) {
        const body = (await res.json()) as { unread?: number }
        if (typeof body.unread === 'number') unreadTotal.value = body.unread
      }
    } catch {
      /* the next read puts the badge right */
    }
  }

  async function markRead(id: string): Promise<void> {
    if (items.value.some((n) => n.id === id && !n.read)) unreadTotal.value = Math.max(0, unreadTotal.value - 1)
    items.value = items.value.map((n) => (n.id === id ? { ...n, read: true } : n))
    await post([id])
  }

  async function markAllRead(): Promise<void> {
    items.value = items.value.map((n) => ({ ...n, read: true }))
    unreadTotal.value = 0
    await post()
  }

  /** The OS-level notification, when the person has allowed them. */
  function announce(n: BridgeNotification): void {
    if (typeof Notification === 'undefined') return
    if (Notification.permission !== 'granted') return
    const notice = new Notification(n.title, {
      body: announceReason(n),
      // One per device or plugin replaces the last, so a device that drops and
      // returns shows its latest state rather than both.
      tag: n.target && 'id' in n.target ? `${n.target.kind}:${n.target.id}` : n.id,
      icon: '/logo.svg',
    })
    notice.onclick = async () => {
      window.focus()
      notice.close()
      // Opening it from the desktop is reading it, exactly as opening it from
      // the bell is. Left unread it would sit in the badge for something seen.
      await markRead(n.id)
      opener?.(n)
    }
  }

  /** Ask once, on a real click: browsers refuse the prompt otherwise. */
  async function enableDesktopNotifications(): Promise<DesktopPermission> {
    if (typeof Notification === 'undefined') return 'unsupported'
    if (Notification.permission !== 'default') return Notification.permission
    return Notification.requestPermission()
  }

  function setOpener(fn: ((n: BridgeNotification) => void) | null): void {
    opener = fn
  }

  // ─── Live delivery ───────────────────────────────────────────────────────
  let ws: WebSocket | null = null
  let wanted = false
  let reloadTimer: ReturnType<typeof setTimeout> | null = null

  function reloadSoon(): void {
    if (reloadTimer) clearTimeout(reloadTimer)
    // A burst (a plugin and its devices at once) becomes one read.
    reloadTimer = setTimeout(() => {
      reloadTimer = null
      void load()
    }, 300)
  }

  function connect(): void {
    wanted = true
    if (ws) return
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${protocol}//${location.host}/ws/notifications`)
    ws = socket
    socket.onmessage = () => reloadSoon()
    // Anything missed while the socket was down is picked up on reconnect.
    socket.onopen = () => reloadSoon()
    socket.onclose = () => {
      if (ws === socket) ws = null
      if (wanted) setTimeout(connect, 3000)
    }
  }

  function disconnect(): void {
    wanted = false
    ws?.close()
    ws = null
  }

  /** A different person signed in: their read state, and nothing announced as theirs. */
  function reset(): void {
    items.value = []
    unreadTotal.value = 0
    loaded = false
    announced.clear()
  }

  return {
    items,
    unread,
    load,
    markRead,
    markAllRead,
    enableDesktopNotifications,
    setOpener,
    connect,
    disconnect,
    reset,
  }
})
