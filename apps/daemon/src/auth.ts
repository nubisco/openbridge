/**
 * Optional Nubisco Platform authentication.
 *
 * Enabled when PLATFORM_ENABLED=true. Off by default so the OSS image
 * stays fully usable without external auth. When enabled, this module:
 *
 *   - Verifies platform-issued JWTs via JWKS (no extra deps).
 *   - Issues a short-lived, HMAC-signed local session cookie so subsequent
 *     /api/* requests don't have to re-validate against the platform.
 *   - Adds a Fastify onRequest hook that requires a valid session for any
 *     /api/* or /ws/* route, except /api/health (so Docker healthcheck
 *     keeps working). /auth/* (the auth endpoints themselves) stays public.
 *     The check uses the route the router matched and a normalized path,
 *     never the raw URL, see requiresSession().
 */

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { createHmac, randomBytes } from 'crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import os from 'os'
import { PlatformClient, type TJwtClaims } from './platform-client.js'

const COOKIE_NAME = 'openbridge_session'
const SESSION_TTL_SEC = 7 * 24 * 60 * 60 // 7 days

export interface TAuthConfig {
  enabled: boolean
  issuer: string | null
  /**
   * Where the browser talks to Accord: sign-in, sign-out and the account
   * switcher. Not the issuer, which stays an identifier in tokens while
   * browser sessions live on the auth host. Null when the issuer is.
   */
  authOrigin: string | null
  appId: string | null
  secret: Buffer
}

interface TSessionPayload {
  userId: string
  email: string
  /** Platform avatar URL, absent when the person has no avatar. */
  picture?: string
  /** Display name from the platform, absent when it sent none. */
  name?: string
  exp: number
}

/**
 * Keep a `picture` claim only when it is an avatar served by our own issuer.
 *
 * The value becomes an `<img src>` on every page, so a token that carried a
 * URL anywhere else would have this app fetch it, announcing the viewer to
 * whoever controls it. Restricting it to the issuer's origin under
 * `/api/avatars/` means the only thing it can point at is the avatar service
 * the token came from. Credentials in the URL are refused outright: they have
 * no business in an image source and are a sign the value was built by
 * something other than the platform.
 *
 * An absent or unusable claim returns undefined, which clears any stored value.
 * The platform omits `picture` entirely for someone with no avatar, so absent
 * means "no avatar" rather than "unchanged".
 */
export function acceptPictureClaim(issuer: string | null, picture: unknown): string | undefined {
  if (!issuer || typeof picture !== 'string' || picture === '') return undefined
  let url: URL
  let base: URL
  try {
    url = new URL(picture)
    base = new URL(issuer)
  } catch {
    return undefined
  }
  if (url.origin !== base.origin) return undefined
  if (!url.pathname.startsWith('/api/avatars/')) return undefined
  if (url.username !== '' || url.password !== '') return undefined
  return url.toString()
}

/**
 * Keep a `name` claim when it is a usable display name.
 *
 * It is shown as text, never as markup, so the only checks are that it is a
 * non-empty string and short enough not to bloat the session cookie. Anything
 * else returns undefined, and the user menu falls back to the email.
 */
export function acceptNameClaim(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined
  const trimmed = name.trim()
  if (trimmed === '' || trimmed.length > 200) return undefined
  return trimmed
}

function getConfigDir(): string {
  // The Docker image mounts /root/.openbridge as a persistent volume.
  // Fall back to the user's home dir for `pnpm dev` runs.
  return existsSync('/root/.openbridge') ? '/root/.openbridge' : `${os.homedir()}/.openbridge`
}

function loadOrCreateSecret(): Buffer {
  const explicit = process.env.OPENBRIDGE_SESSION_SECRET
  if (explicit && explicit.length >= 16) return Buffer.from(explicit, 'utf8')

  const dir = getConfigDir()
  const path = `${dir}/session.key`
  if (existsSync(path)) return readFileSync(path)

  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const secret = randomBytes(32)
  writeFileSync(path, secret, { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    // best effort: chmod fails on non-POSIX volumes
  }
  return secret
}

/** Nubisco's issuer, and the Accord host that holds its browser sessions. */
const NUBISCO_ISSUER = 'https://platform.nubisco.io'
const NUBISCO_AUTH_ORIGIN = 'https://auth.nubisco.io'

/**
 * The browser-facing origin for an issuer. PLATFORM_AUTH_ORIGIN wins when it
 * is set. Otherwise Nubisco's own issuer maps to Accord's auth host, so an
 * install that only sets PLATFORM_ISSUER keeps a working account switcher,
 * and any other issuer is its own auth host.
 */
export function resolveAuthOrigin(issuer: string | null, configured: string | undefined): string | null {
  const explicit = configured?.trim().replace(/\/$/, '')
  if (explicit) return explicit
  if (!issuer) return null
  return issuer === NUBISCO_ISSUER ? NUBISCO_AUTH_ORIGIN : issuer
}

export function loadAuthConfig(): TAuthConfig {
  const flag = process.env.PLATFORM_ENABLED?.toLowerCase().trim()
  const enabled = flag === 'true' || flag === '1' || flag === 'yes'
  const issuer = process.env.PLATFORM_ISSUER?.replace(/\/$/, '') ?? null
  return {
    enabled,
    issuer,
    authOrigin: resolveAuthOrigin(issuer, process.env.PLATFORM_AUTH_ORIGIN),
    appId: process.env.PLATFORM_APP_ID ?? null,
    secret: loadOrCreateSecret(),
  }
}

function signSession(secret: Buffer, payload: TSessionPayload): string {
  const data = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const sig = createHmac('sha256', secret).update(data).digest('base64url')
  return `${data}.${sig}`
}

function verifySession(secret: Buffer, cookie: string): TSessionPayload | null {
  const dot = cookie.indexOf('.')
  if (dot < 0) return null
  const data = cookie.slice(0, dot)
  const sig = cookie.slice(dot + 1)
  const expected = createHmac('sha256', secret).update(data).digest('base64url')
  if (sig !== expected) return null
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as TSessionPayload
    if (payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}

function getCookie(req: FastifyRequest, name: string): string | null {
  const header = req.headers.cookie ?? ''
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))
  return match ? (match[1] ?? null) : null
}

function isProductionLike(): boolean {
  return process.env.NODE_ENV === 'production'
}

export async function registerAuthRoutes(app: FastifyInstance, config: TAuthConfig): Promise<void> {
  // Public config: always available so the UI can decide whether to
  // show a login screen or boot straight into the app.
  app.get('/auth/platform/config', async () => ({
    enabled: config.enabled,
    issuer: config.issuer,
    authOrigin: config.authOrigin,
    appId: config.appId,
  }))

  if (!config.enabled || !config.issuer) {
    // Auth disabled: no callback/me/logout, no pre-handler. Public app.
    return
  }

  const platform = new PlatformClient({ issuer: config.issuer })

  app.post<{ Body: { token?: string; expected_sub?: string } }>('/auth/platform/callback', async (req, reply) => {
    const token = req.body?.token
    if (!token) return reply.code(400).send({ error: 'token_required' })

    let claims: TJwtClaims
    try {
      claims = await platform.verify(token)
    } catch {
      return reply.code(401).send({ error: 'invalid_token' })
    }

    // Multi-account rule 1: only trust tokens issued to THIS app. A valid
    // platform token minted for a different relying party must not open a
    // session here.
    if (config.appId && claims.app && claims.app !== config.appId) {
      return reply.code(401).send({ error: 'wrong_app' })
    }

    // Multi-account rule 3: a silent renewal must come back as the same
    // subject. The UI passes expected_sub when it re-authenticates
    // non-interactively; a different account may only take over through an
    // explicit interactive switch (which sends no expectation).
    const expectedSub = req.body?.expected_sub
    if (expectedSub && claims.sub !== expectedSub) {
      return reply.code(409).send({ error: 'subject_mismatch' })
    }

    // Re-read at every sign-in, so a changed avatar is picked up and a removed
    // one disappears. This session is the only user record OpenBridge keeps.
    const picture = acceptPictureClaim(config.issuer, claims.picture)
    const name = acceptNameClaim(claims.name)
    const payload: TSessionPayload = {
      userId: claims.sub,
      email: claims.email,
      ...(picture ? { picture } : {}),
      ...(name ? { name } : {}),
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SEC,
    }
    const cookieValue = signSession(config.secret, payload)
    const parts = [`${COOKIE_NAME}=${cookieValue}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${SESSION_TTL_SEC}`]
    if (isProductionLike()) parts.push('Secure')
    reply.header('Set-Cookie', parts.join('; '))
    return { ok: true, user: { id: claims.sub, email: claims.email, picture, name } }
  })

  app.get('/auth/me', async (req, reply) => {
    const cookie = getCookie(req, COOKIE_NAME)
    if (!cookie) return reply.code(401).send({ error: 'unauthenticated' })
    const session = verifySession(config.secret, cookie)
    if (!session) return reply.code(401).send({ error: 'unauthenticated' })
    return { user: { id: session.userId, email: session.email, picture: session.picture, name: session.name } }
  })

  app.post('/auth/logout', async (_req, reply) => {
    const parts = [`${COOKIE_NAME}=`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0']
    if (isProductionLike()) parts.push('Secure')
    reply.header('Set-Cookie', parts.join('; '))
    return { ok: true }
  })

  // Gate /api/* and /ws/* when auth is enabled. Health and auth routes
  // are public so the Docker healthcheck and login flow keep working.
  app.addHook('onRequest', async (req, reply) => {
    if (!requiresSession(req.routeOptions?.url, req.url)) return

    const cookie = getCookie(req, COOKIE_NAME)
    const session = cookie ? verifySession(config.secret, cookie) : null
    if (!session) {
      return reply.code(401).send({ error: 'unauthenticated' })
    }
  })
}

const PUBLIC_PATHS = new Set(['/api/health'])

function isGatedPath(path: string): boolean {
  if (PUBLIC_PATHS.has(path)) return false
  return path === '/api' || path.startsWith('/api/') || path === '/ws' || path.startsWith('/ws/')
}

/**
 * Reduce a request path to the form the gate compares against, so that no
 * spelling of a protected path can slip past it: percent-encoding (applied any
 * number of times, including encoded slashes and dots), backslashes, repeated
 * slashes, dot segments, trailing dots on a segment and letter case all fold
 * away. Returns null when the path cannot be decoded.
 */
export function normalizeRequestPath(rawUrl: string): string | null {
  let path = rawUrl.split('?')[0]?.split('#')[0] ?? ''
  for (let i = 0; i < 5; i++) {
    let decoded: string
    try {
      decoded = decodeURIComponent(path)
    } catch {
      return null
    }
    if (decoded === path) break
    path = decoded
  }
  if (/%[0-9a-f]{2}/i.test(path)) return null

  const out: string[] = []
  for (const raw of path.replace(/\\/g, '/').toLowerCase().split('/')) {
    const segment = raw.trim()
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      out.pop()
      continue
    }
    // Some layers treat "api." and "api" as the same name, so the gate does too.
    out.push(segment.replace(/[.\s]+$/, '') || segment)
  }
  return '/' + out.join('/')
}

/**
 * Whether a request must carry a valid session.
 *
 * The decision rests on what the router matched, never on the raw URL alone.
 * The router decodes the path before matching, so a check on the raw string
 * let `/%61pi/plugins` reach `/api/plugins` (and `/%77s/shell` open a shell)
 * without a session. The matched route pattern is authoritative for anything
 * that reaches a handler. The normalized path is checked as well, so an
 * unmatched spelling of a protected path is refused rather than falling
 * through, and a future router option (case-insensitive matching, trailing
 * slash folding) cannot reopen the hole. A path that cannot be decoded is
 * refused.
 */
export function requiresSession(routeUrl: string | undefined, rawUrl: string): boolean {
  if (routeUrl !== undefined && isGatedPath(routeUrl)) return true
  const path = normalizeRequestPath(rawUrl)
  if (path === null) return true
  return isGatedPath(path)
}
