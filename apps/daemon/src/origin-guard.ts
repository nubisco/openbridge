/**
 * Keeps other websites out of the bridge's API and sockets.
 *
 * A bridge answers on the home network, and the browser of anyone at home can
 * reach it. Without sign-in nothing else stops a page on another site from
 * calling the API or opening the terminal socket from that browser. CORS does
 * not cover a WebSocket, and it only hides a response: the request itself, a
 * POST that switches a device or runs a command, still lands. With sign-in on,
 * a `SameSite=Lax` cookie still travels between subdomains of one site. So
 * every `/api` and `/ws` request that a browser marks as coming from another
 * site is refused, signed in or not.
 *
 * Left alone: requests with no `Origin` (curl, scripts on the bridge, a
 * same-site navigation), which the session gate governs, and the paths that
 * exist to be called from elsewhere (`/mcp`, OAuth and discovery, sign-in).
 */

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requiresSession } from './auth.js'

function firstHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  return raw?.split(',')[0]?.trim().toLowerCase() || undefined
}

/**
 * Whether a request comes from this bridge's own page, or from no page at all.
 *
 * The page's host is compared with the host the request was addressed to,
 * and with the one a reverse proxy says it forwarded, so a bridge behind a
 * tunnel that rewrites `Host` still accepts its own page.
 */
export function isOwnOrigin(req: FastifyRequest): boolean {
  const origin = firstHeader(req.headers.origin)
  if (!origin) return true
  let originHost: string
  try {
    originHost = new URL(origin).host.toLowerCase()
  } catch {
    return false
  }
  const hosts = [firstHeader(req.headers.host), firstHeader(req.headers['x-forwarded-host'])]
  return hosts.some((host) => host !== undefined && host === originHost)
}

/** Refuses `/api` and `/ws` requests from another site's page, with 403. */
export function registerOriginGuard(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    // The same paths the session gate covers, so no spelling of one slips past.
    if (!requiresSession(req.routeOptions?.url, req.url)) return
    if (isOwnOrigin(req)) return
    req.log.warn(`Refused ${req.method} ${req.url} from origin ${String(req.headers.origin)}`)
    return reply.code(403).send({ error: 'origin not allowed' })
  })
}
