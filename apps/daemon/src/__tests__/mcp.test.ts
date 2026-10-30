import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import Fastify, { type FastifyInstance } from 'fastify'
import { PluginRegistry } from '@nubisco/openbridge-core'
import { AccessStore, s256Challenge, type Credential } from '../access.js'
import type { BridgeContext } from '../services/bridge.js'
import { handleMcpRequest } from '../mcp/index.js'
import { registerMcpRoutes } from '../mcp/index.js'
import { registerOauthRoutes, sameOrigin } from '../mcp/oauth.js'
import { clearReplays, type McpContext } from '../mcp/tools.js'
import { DeviceSeries } from '../timeseries.js'
import type { TAuthConfig } from '../auth.js'

let home: string

function makeBridge(): BridgeContext & { gate: ReturnType<typeof vi.fn> } {
  const registry = new PluginRegistry()
  const instance = registry.register({ manifest: { name: 'test-plugin', version: '1.0.0' } })
  registry.updateStatus('test-plugin', 'running')
  instance.devices = {
    meter: {
      id: 'meter',
      name: 'Energy meter',
      widgetType: 'energy_meter',
      pluginId: 'test-plugin',
      metrics: [
        { key: 'power', label: 'Power', unit: 'W', kind: 'instant' },
        { key: 'energy', label: 'Energy', unit: 'kWh', kind: 'cumulative' },
      ],
    },
    gate: { id: 'gate', name: 'Gate', widgetType: 'gate', pluginId: 'test-plugin' },
  }
  instance.telemetry = {
    meter: { power: 420, energy: 1234.5, _updatedAt: new Date().toISOString() },
  }
  const gate = vi.fn()
  const controls = new Map<string, (value: unknown) => void>([
    ['gate::open', gate],
    ['gate::factoryReset', () => {}],
  ])
  return {
    registry,
    home,
    hapAPI: null,
    controls,
    restrictedControls: new Set(['gate::factoryReset']),
    deviceEvents: null,
    observations: null,
    homekitServiceTypes: null,
    nativeAccessoryUuid: null,
    gate,
  }
}

const readCred: Credential = {
  kind: 'personal',
  name: 't',
  scopes: ['openbridge:read'],
  owner: { id: 'local', email: null },
  id: 'token:r',
}
const controlCred: Credential = { ...readCred, scopes: ['openbridge:read', 'openbridge:control'], id: 'token:c' }

function ctxFor(bridge: BridgeContext, credential: Credential): McpContext {
  return { bridge, credential, origin: 'http://bridge.local:8582', bridgeName: () => 'Home' }
}

async function call(ctx: McpContext, name: string, args: unknown = {}) {
  const res = (await handleMcpRequest(ctx, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  })) as {
    result?: { content: Array<{ text: string }>; isError?: boolean }
    error?: { message: string }
  }
  return {
    isError: res.result?.isError === true,
    error: res.error,
    text: res.result?.content[0]?.text ?? '',
    json: () => JSON.parse(res.result!.content[0]!.text),
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'openbridge-mcp-'))
  clearReplays()
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('protocol', () => {
  it('initialize names the server and points the agent at overview', async () => {
    const res = (await handleMcpRequest(ctxFor(makeBridge(), readCred), { id: 1, method: 'initialize' })) as any
    expect(res.result.serverInfo.name).toBe('openbridge')
    expect(res.result.serverInfo.icons[0].src).toBe('http://bridge.local:8582/logo.svg')
    expect(res.result.instructions).toContain('overview')
  })

  it('tools/list marks reads read-only and generates every schema', async () => {
    const res = (await handleMcpRequest(ctxFor(makeBridge(), readCred), { id: 1, method: 'tools/list' })) as any
    const byName = Object.fromEntries(res.result.tools.map((t: any) => [t.name, t]))
    expect(byName.overview.annotations).toEqual({ readOnlyHint: true })
    expect(byName.device_control.annotations).toBeUndefined()
    for (const t of res.result.tools) expect(t.inputSchema.type).toBe('object')
  })

  it('an unknown tool is a protocol error, a bad argument is a result the model reads', async () => {
    const ctx = ctxFor(makeBridge(), readCred)
    expect((await call(ctx, 'nope')).error).toBeDefined()
    const bad = await call(ctx, 'device_get', {})
    expect(bad.isError).toBe(true)
    expect(bad.text).toContain('device')
  })

  it('notifications get no reply', async () => {
    expect(
      await handleMcpRequest(ctxFor(makeBridge(), readCred), { method: 'notifications/initialized' }),
    ).toBeUndefined()
  })
})

describe('reading', () => {
  it('overview lists devices with telemetry, health and unrestricted controls only', async () => {
    const out = (await call(ctxFor(makeBridge(), readCred), 'overview')).json()
    const meter = out.devices.find((d: any) => d.id === 'meter')
    expect(meter.telemetry).toEqual({ power: 420, energy: 1234.5 })
    expect(meter.health).toBe('ok')
    expect(meter.metrics).toEqual(['power', 'energy'])
    const gate = out.devices.find((d: any) => d.id === 'gate')
    expect(gate.controls).toEqual(['open'])
    expect(out.url_templates.device).toBe('http://bridge.local:8582/devices/{id}')
    expect(out.plugins).toEqual([{ id: 'test-plugin', status: 'running', devices: 2 }])
  })

  it('device_history summarises a cumulative metric as the amount used', async () => {
    const bridge = makeBridge()
    const now = Math.floor(Date.now() / 1000)
    const series = new DeviceSeries(
      join(home, 'metrics'),
      'meter',
      bridge.registry.getAll()[0]!.devices!.meter!.metrics!,
    )
    series.ensureLayout()
    for (let i = 0; i < 6; i++) {
      series.append({ t: now - 3600 + i * 600, values: { power: 100 + i * 10, energy: 1000 + i * 0.5 } })
    }
    const energy = (
      await call(ctxFor(bridge, readCred), 'device_history', { device: 'meter', metric: 'energy', last: '2h' })
    ).json()
    expect(energy.summary.count).toBe(6)
    expect(energy.summary.delta).toBeCloseTo(2.5)
    expect(energy.summary.mean).toBeUndefined()

    const power = (
      await call(ctxFor(bridge, readCred), 'device_history', {
        device: 'meter',
        metric: 'power',
        last: '2h',
        max_points: 0,
      })
    ).json()
    expect(power.summary.max.value).toBe(150)
    expect(power.summary.mean).toBeCloseTo(125)
    expect(power.points).toBeUndefined()
  })

  it('device_history refuses a window it cannot read, in words', async () => {
    const res = await call(ctxFor(makeBridge(), readCred), 'device_history', {
      device: 'meter',
      metric: 'power',
      last: 'yesterday',
    })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('not a duration')
  })

  it('an unknown device is a refusal, not a crash', async () => {
    const res = await call(ctxFor(makeBridge(), readCred), 'device_get', { device: 'nope' })
    expect(res.isError).toBe(true)
    expect(res.text).toContain("Device 'nope' not found")
  })
})

describe('control', () => {
  it('a read-only token cannot operate anything', async () => {
    const bridge = makeBridge()
    const res = await call(ctxFor(bridge, readCred), 'device_control', {
      ops: [{ op_id: 'a', device: 'gate', control: 'open', value: true }],
    })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('read-only')
    expect(bridge.gate).not.toHaveBeenCalled()
  })

  it('runs an op once, and a retried op_id replays the first answer', async () => {
    const bridge = makeBridge()
    const ctx = ctxFor(bridge, controlCred)
    const op = { op_id: 'open-1', device: 'gate', control: 'open', value: true }
    expect((await call(ctx, 'device_control', { ops: [op] })).json().results[0]).toEqual({ op_id: 'open-1', ok: true })
    const again = (await call(ctx, 'device_control', { ops: [op] })).json().results[0]
    expect(again.replayed).toBe(true)
    expect(bridge.gate).toHaveBeenCalledTimes(1)
  })

  it('a restricted control is refused per op and the rest of the batch still runs', async () => {
    const bridge = makeBridge()
    const out = (
      await call(ctxFor(bridge, controlCred), 'device_control', {
        ops: [
          { op_id: 'x', device: 'gate', control: 'factoryReset' },
          { op_id: 'y', device: 'gate', control: 'open', value: true },
        ],
      })
    ).json()
    expect(out.results[0].ok).toBe(false)
    expect(out.results[0].error).toContain('restricted')
    expect(out.results[1].ok).toBe(true)
  })
})

describe('AccessStore', () => {
  it('stores only hashes, mode 600, and a revoked token stops working', () => {
    const store = new AccessStore(join(home, 'access.json'))
    const { id, token } = store.createToken('laptop', 'read', { id: 'local', email: null })
    expect(token.startsWith('obt_pat_')).toBe(true)
    const file = readFileSync(join(home, 'access.json'), 'utf8')
    expect(file).not.toContain(token)
    expect(statSync(join(home, 'access.json')).mode & 0o777).toBe(0o600)
    expect(store.verify(token)?.scopes).toEqual(['openbridge:read'])
    expect(store.revokeToken(id)).toBe(true)
    expect(store.verify(token)).toBeNull()
  })

  it('sees a token another process wrote, without a restart', () => {
    const daemon = new AccessStore(join(home, 'access.json'))
    expect(daemon.listTokens()).toEqual([])
    const { token } = new AccessStore(join(home, 'access.json')).createToken('cli', 'control', {
      id: 'local',
      email: null,
    })
    expect(daemon.verify(token)?.scopes).toContain('openbridge:control')
  })

  it('a code is single use, needs the PKCE verifier, and refresh rotates', () => {
    const store = new AccessStore(join(home, 'access.json'))
    const reg = store.registerClient({ redirect_uris: ['http://localhost:4000/cb'], client_name: 'Claude' })
    if (!reg.ok) throw new Error('registration failed')
    const verifier = 'v'.repeat(50)
    const code = store.issueCode(
      {
        clientId: reg.id,
        redirectUri: 'http://localhost:4000/cb',
        codeChallenge: s256Challenge(verifier),
        access: 'read',
      },
      { id: 'local', email: null },
    )
    const form = (o: Record<string, string>) => (k: string) => o[k] ?? ''
    const base = { code, client_id: reg.id, redirect_uri: 'http://localhost:4000/cb' }
    expect(store.exchangeCode(form({ ...base, code_verifier: 'wrong' })).ok).toBe(false)
    const first = store.exchangeCode(form({ ...base, code_verifier: verifier }))
    if (!first.ok) throw new Error('exchange failed')
    expect(store.exchangeCode(form({ ...base, code_verifier: verifier })).ok).toBe(false)
    expect(store.verify(first.pair.access_token)?.kind).toBe('oauth')

    const next = store.refresh(form({ refresh_token: first.pair.refresh_token }))
    expect(next.ok).toBe(true)
    expect(store.refresh(form({ refresh_token: first.pair.refresh_token })).ok).toBe(false)

    expect(store.listConnections()).toHaveLength(1)
    expect(store.revokeConnection(reg.id)).toBe(true)
    if (next.ok) expect(store.verify(next.pair.access_token)).toBeNull()
  })

  it('refuses redirect targets that are not https or loopback', () => {
    const store = new AccessStore(join(home, 'access.json'))
    expect(store.registerClient({ redirect_uris: ['http://evil.example/cb'] }).ok).toBe(false)
  })
})

describe('over HTTP', () => {
  let app: FastifyInstance
  let store: AccessStore
  let bridge: ReturnType<typeof makeBridge>

  async function build(signIn = false) {
    app = Fastify()
    store = new AccessStore(join(home, 'access.json'))
    bridge = makeBridge()
    const authConfig: TAuthConfig = {
      enabled: signIn,
      issuer: signIn ? 'https://auth.example' : null,
      authOrigin: null,
      appId: null,
      secret: Buffer.from('x'.repeat(32)),
    }
    await registerMcpRoutes(app, { bridge, store, bridgeName: () => 'Home' })
    await registerOauthRoutes(app, { store, authConfig })
    await app.ready()
  }

  afterEach(async () => app?.close())

  const rpc = (body: unknown, token?: string) =>
    app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { host: 'bridge.local:8582', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      payload: body as object,
    })

  it('refuses /mcp without a token even when sign-in is off, and says where to sign in', async () => {
    await build(false)
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(res.statusCode).toBe(401)
    expect(res.headers['www-authenticate']).toBe(
      'Bearer resource_metadata="http://bridge.local:8582/.well-known/oauth-protected-resource/mcp"',
    )
  })

  it('advertises https when a tunnel ended TLS in front of it', async () => {
    await build(false)
    const headers = { host: 'openbridge.example.com', 'x-forwarded-proto': 'https' }
    const meta = await app.inject({ url: '/.well-known/oauth-authorization-server', headers })
    expect(meta.json().registration_endpoint).toBe('https://openbridge.example.com/oauth/register')
    const res = await app.inject({ method: 'POST', url: '/mcp', headers, payload: {} })
    expect(res.headers['www-authenticate']).toContain('"https://openbridge.example.com/.well-known/')

    // Anything but https is ignored, so the header can never downgrade.
    const odd = await app.inject({
      url: '/.well-known/oauth-authorization-server',
      headers: { host: 'bridge.local:8582', 'x-forwarded-proto': 'gopher' },
    })
    expect(odd.json().issuer).toBe('http://bridge.local:8582')
  })

  it('serves tools to a personal token', async () => {
    await build(false)
    const { token } = store.createToken('t', 'read', { id: 'local', email: null })
    const res = await rpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'overview', arguments: {} } },
      token,
    )
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.json().result.content[0].text).devices).toHaveLength(2)
  })

  it('refuses token creation from another site', async () => {
    await build(false)
    const res = await app.inject({
      method: 'POST',
      url: '/api/access/tokens',
      headers: { host: 'bridge.local:8582', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
      payload: { name: 'x', access: 'control' },
    })
    expect(res.statusCode).toBe(403)
    expect(store.listTokens()).toEqual([])

    const ok = await app.inject({
      method: 'POST',
      url: '/api/access/tokens',
      headers: { host: 'bridge.local:8582', origin: 'http://bridge.local:8582', 'sec-fetch-site': 'same-origin' },
      payload: { name: 'x', access: 'control' },
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().token).toMatch(/^obt_pat_/)
  })

  it('completes the connector handshake: discover, register, consent, token, call', async () => {
    await build(false)
    const meta = await app.inject({
      url: '/.well-known/oauth-authorization-server/mcp',
      headers: { host: 'bridge.local:8582' },
    })
    expect(meta.json().token_endpoint).toBe('http://bridge.local:8582/oauth/token')

    const reg = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { redirect_uris: ['http://localhost:4000/cb'], client_name: 'Claude Code' },
    })
    expect(reg.statusCode).toBe(201)
    const clientId = reg.json().client_id

    const verifier = 'a'.repeat(64)
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: 'http://localhost:4000/cb',
      response_type: 'code',
      state: 's1',
      code_challenge: s256Challenge(verifier),
      code_challenge_method: 'S256',
    })
    const authz = await app.inject({ url: `/oauth/authorize?${params}` })
    expect(authz.headers.location).toBe(`/oauth/consent?${params}`)

    const context = await app.inject({ url: `/oauth/context?${params}` })
    expect(context.json()).toMatchObject({ ok: true, clientName: 'Claude Code', signedIn: true })

    // A page elsewhere cannot approve on the person's behalf.
    const forged = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'cross-site',
        host: 'bridge.local:8582',
      },
      payload: `${params}&decision=approve&access=control`,
    })
    expect(forged.statusCode).toBe(403)

    const approved = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
        host: 'bridge.local:8582',
      },
      payload: `${params}&decision=approve&access=read`,
    })
    expect(approved.statusCode).toBe(302)
    const back = new URL(approved.headers.location as string)
    expect(back.searchParams.get('state')).toBe('s1')

    const tok = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'authorization_code',
        code: back.searchParams.get('code')!,
        client_id: clientId,
        redirect_uri: 'http://localhost:4000/cb',
        code_verifier: verifier,
      }).toString(),
    })
    expect(tok.statusCode).toBe(200)
    expect(tok.json().scope).toBe('openbridge:read')

    const control = await rpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'device_control', arguments: { ops: [{ op_id: 'z', device: 'gate', control: 'open' }] } },
      },
      tok.json().access_token,
    )
    expect(control.json().result.isError).toBe(true)
    expect(bridge.gate).not.toHaveBeenCalled()
  })

  it('asks for sign-in before consent when dashboard sign-in is on', async () => {
    await build(true)
    const reg = store.registerClient({ redirect_uris: ['http://localhost:4000/cb'] })
    if (!reg.ok) throw new Error('registration failed')
    const params = new URLSearchParams({
      client_id: reg.id,
      redirect_uri: 'http://localhost:4000/cb',
      response_type: 'code',
      code_challenge: 'c',
      code_challenge_method: 'S256',
    })
    expect((await app.inject({ url: `/oauth/context?${params}` })).json()).toMatchObject({
      signInRequired: true,
      signedIn: false,
    })
    const res = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
      payload: `${params}&decision=approve`,
    })
    expect(res.headers.location).toMatch(/^\/oauth\/consent\?/)
  })
})

describe('sameOrigin', () => {
  const req = (headers: Record<string, string>) => ({ headers, host: 'bridge.local:8582', protocol: 'http' }) as any
  it('accepts the dashboard and non-browser callers, refuses other sites', () => {
    expect(sameOrigin(req({ 'sec-fetch-site': 'same-origin', origin: 'http://bridge.local:8582' }))).toBe(true)
    expect(sameOrigin(req({}))).toBe(true)
    expect(sameOrigin(req({ origin: 'https://evil.example' }))).toBe(false)
    expect(sameOrigin(req({ 'sec-fetch-site': 'same-site' }))).toBe(false)
  })
})

describe('the off switch', () => {
  it('reads only an explicit yes', async () => {
    const { isMcpEnabled } = await import('../mcp/index.js')
    expect(isMcpEnabled(undefined)).toBe(false)
    expect(isMcpEnabled('')).toBe(false)
    expect(isMcpEnabled('off')).toBe(false)
    expect(isMcpEnabled('ON')).toBe(true)
    expect(isMcpEnabled('1')).toBe(true)
  })

  it('serves no MCP, OAuth or token routes until OPENBRIDGE_MCP=on', async () => {
    const previousHome = process.env.HOME
    const previousFlag = process.env.OPENBRIDGE_MCP
    process.env.HOME = home
    try {
      const { createServer } = await import('../server.js')
      const off = await createServer(new PluginRegistry(), null, null, [], new Set(), new Map())
      try {
        const mcp = await off.inject({ method: 'POST', url: '/mcp', payload: {} })
        expect(mcp.statusCode).toBe(404)
        expect(mcp.json().error).toContain('OPENBRIDGE_MCP=on')
        // Unknown paths fall through to the dashboard, so what matters is that
        // nothing answers as the feature would.
        const reg = await off.inject({
          method: 'POST',
          url: '/oauth/register',
          payload: { redirect_uris: ['https://a.example/cb'] },
        })
        expect(reg.statusCode).not.toBe(201)
        await off.inject({ method: 'POST', url: '/api/access/tokens', payload: { name: 'x', access: 'control' } })
        expect(existsSync(join(home, '.openbridge', 'access.json'))).toBe(false)
        expect((await off.inject({ url: '/api/access' })).json()).toEqual({ enabled: false })
      } finally {
        await off.close()
      }

      process.env.OPENBRIDGE_MCP = 'on'
      const on = await createServer(new PluginRegistry(), null, null, [], new Set(), new Map())
      try {
        expect((await on.inject({ method: 'POST', url: '/mcp', payload: {} })).statusCode).toBe(401)
        expect((await on.inject({ url: '/api/access' })).json().enabled).toBe(true)
      } finally {
        await on.close()
      }
    } finally {
      process.env.HOME = previousHome
      if (previousFlag === undefined) delete process.env.OPENBRIDGE_MCP
      else process.env.OPENBRIDGE_MCP = previousFlag
    }
  })
})
