/**
 * The bell's HTTP and live surface.
 *
 *   GET  /api/notifications?limit=50  newest rows for the person asking, with read state, plus the unread count
 *   POST /api/notifications/read      { ids?: string[] } marks those rows read, or all of them without ids
 *   WS   /ws/notifications            { type: 'changed' } whenever a row is added or this person read one
 *
 * The socket carries a nudge, not the row. A tab re-reads the list when it is
 * told something changed, so the list it shows is always the server's, read
 * state and count included, and a missed message costs nothing but a moment.
 *
 * Read state belongs to the signed-in person (the session's user id), or to a
 * single local person when sign-in is off. The auth hook in auth.ts already
 * gates /api/* and /ws/* when sign-in is on.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { WebSocket } from '@fastify/websocket'
import { readSession, type TAuthConfig } from './auth.js'
import { LOCAL_USER, type NotificationStore } from './notifications.js'

export function notificationUser(authConfig: TAuthConfig | null, req: FastifyRequest): string {
  if (!authConfig) return LOCAL_USER
  return readSession(authConfig, req)?.userId ?? LOCAL_USER
}

export function registerNotificationRoutes(
  app: FastifyInstance,
  store: NotificationStore,
  authConfig: TAuthConfig | null,
): void {
  app.get<{ Querystring: { limit?: string } }>('/api/notifications', async (req) => {
    const limit = Number(req.query.limit ?? 50)
    return store.list(notificationUser(authConfig, req), Number.isFinite(limit) ? limit : 50)
  })

  app.post<{ Body: { ids?: unknown } | undefined }>('/api/notifications/read', async (req) => {
    const raw = req.body?.ids
    const ids = Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : undefined
    return { unread: store.markRead(notificationUser(authConfig, req), ids) }
  })

  app.get('/ws/notifications', { websocket: true }, (ws: WebSocket, req) => {
    const userId = notificationUser(authConfig, req)
    const unsubscribe = store.subscribe((event) => {
      // A row added reaches everybody. Somebody reading reaches only their
      // own other tabs, whose badge just went stale.
      if (event.type === 'read' && event.userId !== userId) return
      if (ws.readyState !== ws.OPEN) return
      try {
        ws.send(JSON.stringify({ type: 'changed' }))
      } catch {
        /* disconnected */
      }
    })
    ws.on('close', unsubscribe)
  })
}
