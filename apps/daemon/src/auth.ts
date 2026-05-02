/**
 * Optional Nubisco Platform authentication.
 *
 * Enabled when PLATFORM_ENABLED=true. Off by default so the OSS image
 * stays fully usable without external auth. When enabled, this module:
 *
 *   - Verifies platform-issued JWTs via JWKS (no extra deps).
 *   - Issues a short-lived, HMAC-signed local session cookie so subsequent
 *     /api/* requests don't have to re-validate against the platform.
 *   - Adds a Fastify pre-handler that requires a valid session for any
 *     /api/* or /ws/* path, except /api/health (so Docker healthcheck
 *     keeps working) and /auth/* (the auth endpoints themselves).
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
  appId: string | null
  secret: Buffer
}

interface TSessionPayload {
  userId: string
  email: string
  exp: number
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

export function loadAuthConfig(): TAuthConfig {
  const flag = process.env.PLATFORM_ENABLED?.toLowerCase().trim()
  const enabled = flag === 'true' || flag === '1' || flag === 'yes'
  return {
    enabled,
    issuer: process.env.PLATFORM_ISSUER?.replace(/\/$/, '') ?? null,
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
  // Public config — always available so the UI can decide whether to
  // show a login screen or boot straight into the app.
  app.get('/auth/platform/config', async () => ({
    enabled: config.enabled,
    issuer: config.issuer,
    appId: config.appId,
  }))

  if (!config.enabled || !config.issuer) {
    // Auth disabled: no callback/me/logout, no pre-handler. Public app.
    return
  }

  const platform = new PlatformClient({ issuer: config.issuer })

  app.post<{ Body: { token?: string } }>('/auth/platform/callback', async (req, reply) => {
    const token = req.body?.token
    if (!token) return reply.code(400).send({ error: 'token_required' })

    let claims: TJwtClaims
    try {
      claims = await platform.verify(token)
    } catch {
      return reply.code(401).send({ error: 'invalid_token' })
    }

    const payload: TSessionPayload = {
      userId: claims.sub,
      email: claims.email,
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SEC,
    }
    const cookieValue = signSession(config.secret, payload)
    const parts = [`${COOKIE_NAME}=${cookieValue}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${SESSION_TTL_SEC}`]
    if (isProductionLike()) parts.push('Secure')
    reply.header('Set-Cookie', parts.join('; '))
    return { ok: true, user: { id: claims.sub, email: claims.email } }
  })

  app.get('/auth/me', async (req, reply) => {
    const cookie = getCookie(req, COOKIE_NAME)
    if (!cookie) return reply.code(401).send({ error: 'unauthenticated' })
    const session = verifySession(config.secret, cookie)
    if (!session) return reply.code(401).send({ error: 'unauthenticated' })
    return { user: { id: session.userId, email: session.email } }
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
    const url = req.url.split('?')[0] ?? ''
    const gated = url.startsWith('/api/') || url.startsWith('/ws/')
    if (!gated) return
    if (url === '/api/health') return
    if (url.startsWith('/auth/')) return

    const cookie = getCookie(req, COOKIE_NAME)
    const session = cookie ? verifySession(config.secret, cookie) : null
    if (!session) {
      reply.code(401).send({ error: 'unauthenticated' })
    }
  })
}
