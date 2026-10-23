import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createHmac } from 'crypto'
import { request } from 'http'
import Fastify, { type FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import { normalizeRequestPath, registerAuthRoutes, requiresSession, type TAuthConfig } from '../auth.js'

const SECRET = Buffer.from('auth-gate-test-secret-0123456789', 'utf8')

function sessionCookie(): string {
  const data = Buffer.from(
    JSON.stringify({ userId: 'u1', email: 'u1@example.test', exp: Math.floor(Date.now() / 1000) + 600 }),
    'utf8',
  ).toString('base64url')
  const sig = createHmac('sha256', SECRET).update(data).digest('base64url')
  return `openbridge_session=${data}.${sig}`
}

/**
 * Every spelling here reached a protected handler, or would have if the
 * router learned to fold it, while the gate compared the raw URL against
 * "/api/" and "/ws/".
 */
const BYPASS_ATTEMPTS = [
  '/%61pi/plugins',
  '/%61%70%69/plugins',
  '/%2561pi/plugins',
  '/%41PI/plugins',
  '/API/plugins',
  '/Api/Plugins',
  '/api%2fplugins',
  '/api%2Fplugins',
  '/%2fapi/plugins',
  '//api/plugins',
  '/api//plugins',
  '/api/plugins.',
  '/api./plugins',
  '/api/./plugins',
  '/%2e/api/plugins',
  '/assets/../api/plugins',
  '/assets/..%2fapi/plugins',
  '/assets/%2e%2e/api/plugins',
  '/static/..%5capi/plugins',
  '/api/plugins?x=1',
]

describe('normalizeRequestPath', () => {
  it('folds every spelling of a protected path to the same form', () => {
    for (const url of BYPASS_ATTEMPTS) {
      expect(normalizeRequestPath(url), url).toBe('/api/plugins')
    }
  })

  it('leaves dashboard routes alone', () => {
    expect(normalizeRequestPath('/devices/abc')).toBe('/devices/abc')
    expect(normalizeRequestPath('/')).toBe('/')
  })

  it('refuses a path that cannot be decoded', () => {
    expect(normalizeRequestPath('/%E0%A4%A')).toBeNull()
  })
})

describe('requiresSession', () => {
  it('gates by the matched route even when the raw URL looks unrelated', () => {
    expect(requiresSession('/api/plugins', '/%61pi/plugins')).toBe(true)
    expect(requiresSession('/ws/shell', '/%77s/shell')).toBe(true)
  })

  it('gates unmatched spellings of protected paths', () => {
    for (const url of BYPASS_ATTEMPTS) expect(requiresSession(undefined, url), url).toBe(true)
    expect(requiresSession(undefined, '/WS/logs')).toBe(true)
  })

  it('keeps health, auth and the dashboard public', () => {
    expect(requiresSession('/api/health', '/api/health')).toBe(false)
    expect(requiresSession('/auth/me', '/auth/me')).toBe(false)
    expect(requiresSession('/auth/platform/config', '/auth/platform/config')).toBe(false)
    expect(requiresSession(undefined, '/')).toBe(false)
    expect(requiresSession(undefined, '/devices/abc')).toBe(false)
    expect(requiresSession(undefined, '/apiary')).toBe(false)
  })
})

describe('platform auth gate on a running server', () => {
  let app: FastifyInstance
  let port = 0

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(websocket)
    const config: TAuthConfig = { enabled: true, issuer: 'https://issuer.invalid', appId: null, secret: SECRET }
    await registerAuthRoutes(app, config)
    app.get('/api/health', async () => ({ status: 'ok' }))
    app.get('/api/plugins', async () => ({ plugins: ['secret'] }))
    app.get('/ws/shell', { websocket: true }, (ws) => ws.send('shell-open'))
    // Mirrors the dashboard fallback in server.ts.
    app.setNotFoundHandler(async (_req, reply) => reply.type('text/html').send('<html></html>'))
    await app.listen({ port: 0, host: '127.0.0.1' })
    port = (app.server.address() as { port: number }).port
  })

  afterAll(async () => {
    await app.close()
  })

  it.each(BYPASS_ATTEMPTS)('refuses %s without a session', async (url) => {
    const res = await app.inject({ method: 'GET', url })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'unauthenticated' })
  })

  it('serves protected routes and health as before', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/api/plugins' })).statusCode).toBe(401)
    const authed = await app.inject({ method: 'GET', url: '/%61pi/plugins', headers: { cookie: sessionCookie() } })
    expect(authed.statusCode).toBe(200)
    expect(authed.json()).toEqual({ plugins: ['secret'] })
    expect((await app.inject({ method: 'GET', url: '/devices/abc' })).statusCode).toBe(200)
  })

  /** Send a WebSocket upgrade and report the status the server answered with. */
  function upgrade(path: string, cookie?: string): Promise<number> {
    return new Promise((resolve, reject) => {
      // A fresh connection per attempt: the server closes one it refused an upgrade on.
      const req = request({
        agent: false,
        host: '127.0.0.1',
        port,
        path,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          ...(cookie ? { Cookie: cookie } : {}),
        },
      })
      req.on('upgrade', (res, socket) => {
        socket.destroy()
        resolve(res.statusCode ?? 0)
      })
      req.on('response', (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', reject)
      req.end()
    })
  }

  it.each(['/ws/shell', '/%77s/shell', '/%77%73/shell', '/WS/shell', '/ws//shell', '/assets/..%2fws/shell'])(
    'refuses a WebSocket upgrade to %s without a session',
    async (path) => {
      expect(await upgrade(path)).toBe(401)
    },
  )

  it('upgrades a WebSocket with a session', async () => {
    expect(await upgrade('/ws/shell', sessionCookie())).toBe(101)
  })
})
