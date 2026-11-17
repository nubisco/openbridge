/**
 * The bell's HTTP and live surface.
 *
 *   GET  /api/notifications?limit=50  newest rows for the person asking, with read state, plus the unread count
 *   POST /api/notifications/read      { ids?: string[] } marks those rows read, or all of them without ids
 *   POST /api/notifications/clear     { ids?: string[], before?: string } takes rows out of this person's list
 *   WS   /ws/notifications            { verb, entity, id, actor } whenever a row is added, or this person
 *                                     read or cleared one in another tab
 *
 * The socket carries what changed, not the row. A tab re-reads the list when
 * it is told something changed, so the list it shows is always the server's,
 * read state and count included, and a missed message costs nothing but a
 * moment. That is the frame "Getting it to an open tab now: live delivery" in
 * the workspace AGENTS.md asks for: verb, entity, id and actor kind.
 *
 * Read state belongs to the signed-in person (the session's user id), or to a
 * single local person when sign-in is off. The auth hook in auth.ts already
 * gates /api/* and /ws/* when sign-in is on.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { WebSocket } from '@fastify/websocket'
import { readSession, type TAuthConfig } from './auth.js'
import { isOwnOrigin } from './origin-guard.js'
import { LOCAL_USER, type NotificationEvent, type NotificationStore } from './notifications.js'

/**
 * A socket is authorised once, when it connects. With sign-in on, one older
 * than this is closed the next time something would be sent to it, so the tab
 * reconnects through the session check and a session that has ended stops
 * there rather than hearing about the house forever.
 */
export const SOCKET_MAX_AGE_MS = 30 * 60_000

/** Close code that tells a tab to reconnect and sign in again. */
export const REAUTH_CLOSE_CODE = 4001

/** What a tab is sent. The content is never in it. */
export interface NotificationFrame {
  verb: NotificationEvent['verb']
  entity: 'notification'
  /** The row, when the change was to one row. */
  id: string | null
  /** A row is written by the bridge. Reading and clearing are done by a person. */
  actor: 'bridge' | 'person'
}

export function notificationUser(authConfig: TAuthConfig | null, req: FastifyRequest): string {
  if (!authConfig) return LOCAL_USER
  return readSession(authConfig, req)?.userId ?? LOCAL_USER
}

function idList(raw: unknown): string[] | undefined {
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : undefined
}

export function registerNotificationRoutes(
  app: FastifyInstance,
  store: NotificationStore,
  authConfig: TAuthConfig | null,
  clock: () => number = Date.now,
): void {
  app.get<{ Querystring: { limit?: string } }>('/api/notifications', async (req) => {
    const limit = Number(req.query.limit ?? 50)
    return store.list(notificationUser(authConfig, req), Number.isFinite(limit) ? limit : 50)
  })

  app.post<{ Body: { ids?: unknown } | undefined }>('/api/notifications/read', async (req) => {
    return { unread: store.markRead(notificationUser(authConfig, req), idList(req.body?.ids)) }
  })

  app.post<{ Body: { ids?: unknown; before?: unknown } | undefined }>(
    '/api/notifications/clear',
    async (req, reply) => {
      const before = req.body?.before
      if (before !== undefined && (typeof before !== 'string' || Number.isNaN(Date.parse(before)))) {
        return reply.code(400).send({ error: '`before` must be an ISO date' })
      }
      const selection = { ids: idList(req.body?.ids), before }
      return { unread: store.clear(notificationUser(authConfig, req), selection) }
    },
  )

  app.get('/ws/notifications', { websocket: true }, (ws: WebSocket, req) => {
    if (!isOwnOrigin(req)) {
      req.log.warn(`Refused a notifications socket from origin ${String(req.headers.origin)}`)
      ws.close(1008, 'origin not allowed')
      return
    }
    const userId = notificationUser(authConfig, req)
    const openedAt = clock()
    const signedIn = authConfig?.enabled === true
    const unsubscribe = store.subscribe((event) => {
      // A row added reaches everybody. Somebody reading or clearing reaches
      // only their own other tabs, whose badge just went stale.
      if (event.userId !== undefined && event.userId !== userId) return
      if (ws.readyState !== ws.OPEN) return
      if (signedIn && clock() - openedAt > SOCKET_MAX_AGE_MS) {
        ws.close(REAUTH_CLOSE_CODE, 'sign in again')
        return
      }
      const frame: NotificationFrame = {
        verb: event.verb,
        entity: 'notification',
        id: event.id ?? null,
        actor: event.verb === 'notification.created' ? 'bridge' : 'person',
      }
      try {
        ws.send(JSON.stringify(frame))
      } catch {
        /* disconnected */
      }
    })
    ws.on('close', unsubscribe)
  })
}
