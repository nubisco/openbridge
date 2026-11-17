import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerOriginGuard } from '../origin-guard.js'

describe('origin guard', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify()
    registerOriginGuard(app)
    for (const url of ['/api/devices', '/api/health', '/ws/shell', '/mcp', '/oauth/token', '/']) {
      app.get(url, async () => ({ ok: true }))
    }
    app.post('/api/devices/lamp/control', async () => ({ ok: true }))
    await app.ready()
  })
  afterAll(() => app.close())

  const call = (method: 'GET' | 'POST', url: string, headers: Record<string, string>) =>
    app.inject({ method, url, headers: { host: 'bridge.local:8582', ...headers } })

  it('refuses the API and the sockets to another site', async () => {
    const evil = { origin: 'https://evil.example' }
    expect((await call('GET', '/api/devices', evil)).statusCode).toBe(403)
    expect((await call('POST', '/api/devices/lamp/control', evil)).statusCode).toBe(403)
    expect((await call('GET', '/ws/shell', evil)).statusCode).toBe(403)
  })

  it('refuses another spelling of a guarded path', async () => {
    const res = await call('GET', '/API/%64evices', { origin: 'https://evil.example' })
    expect(res.statusCode).toBe(403)
  })

  it('lets its own page in, directly and behind a proxy', async () => {
    expect((await call('GET', '/api/devices', { origin: 'http://bridge.local:8582' })).statusCode).toBe(200)
    const proxied = await call('GET', '/api/devices', {
      host: 'localhost:8582',
      'x-forwarded-host': 'openbridge.example.test',
      origin: 'https://openbridge.example.test',
    })
    expect(proxied.statusCode).toBe(200)
  })

  it('lets clients that are not browsers in', async () => {
    expect((await call('GET', '/api/devices', {})).statusCode).toBe(200)
  })

  it('refuses an origin it cannot read', async () => {
    expect((await call('GET', '/api/devices', { origin: 'null' })).statusCode).toBe(403)
  })

  it('leaves the paths meant for other sites alone', async () => {
    const evil = { origin: 'https://claude.example' }
    expect((await call('GET', '/mcp', evil)).statusCode).toBe(200)
    expect((await call('GET', '/oauth/token', evil)).statusCode).toBe(200)
    expect((await call('GET', '/api/health', evil)).statusCode).toBe(200)
    expect((await call('GET', '/', evil)).statusCode).toBe(200)
  })
})
