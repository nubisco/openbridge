import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Test config in a temp directory — mirrors ~/.openbridge structure
const TEST_HOME = join(tmpdir(), `openbridge-test-${Date.now()}`)
const TEST_DIR = join(TEST_HOME, '.openbridge')
const CONFIG_PATH = join(TEST_DIR, 'config.json')
const PLUGINS_DIR = join(TEST_DIR, 'plugins')
const HB_PLUGINS_DIR = join(PLUGINS_DIR, 'homebridge')
const OB_PLUGINS_DIR = join(PLUGINS_DIR, 'openbridge')

const TEST_PORT = 19582
const BASE = `http://localhost:${TEST_PORT}`

function writeConfig(config: Record<string, unknown>) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
}

const baseConfig = {
  bridge: {
    name: 'Test Bridge',
    port: TEST_PORT,
    hapPort: 59826,
    pincode: '111-22-333',
    logLevel: 'error',
  },
  platforms: [],
  plugins: [
    {
      name: 'test-native-plugin',
      enabled: true,
      config: { foo: 'bar' },
    },
  ],
  disabledPlugins: [],
}

describe('OpenBridge Server API', () => {
  beforeAll(() => {
    // Create test directories
    mkdirSync(TEST_DIR, { recursive: true })
    mkdirSync(HB_PLUGINS_DIR, { recursive: true })
    mkdirSync(OB_PLUGINS_DIR, { recursive: true })

    // Set env vars before importing daemon
    process.env.HOME = TEST_HOME
    process.env.OPENBRIDGE_VERSION = '0.0.0-test'
  })

  afterAll(() => {
    try {
      rmSync(TEST_HOME, { recursive: true, force: true })
    } catch {
      /* ignore cleanup errors */
    }
  })

  describe('Health & System', () => {
    beforeEach(() => {
      writeConfig(baseConfig)
    })

    it('GET /api/health returns status ok', async () => {
      // Import server lazily to pick up env changes
      const { createServer } = await import('../server.js')
      const { PluginRegistry } = await import('@nubisco/openbridge-core')
      const registry = new PluginRegistry()

      const server = await createServer(registry, null, null, [], new Set(), new Map())
      await server.listen({ port: TEST_PORT, host: '127.0.0.1' })

      try {
        const res = await fetch(`${BASE}/api/health`)
        const data = await res.json()

        expect(res.status).toBe(200)
        expect(data.status).toBe('ok')
        expect(data.version).toBe('0.0.0-test')
        expect(data.timestamp).toBeDefined()
      } finally {
        await server.close()
      }
    })

    it('GET /api/qr returns null when no HAP bridge', async () => {
      const { createServer } = await import('../server.js')
      const { PluginRegistry } = await import('@nubisco/openbridge-core')
      const registry = new PluginRegistry()

      const server = await createServer(registry, null, null, [], new Set(), new Map())
      await server.listen({ port: TEST_PORT, host: '127.0.0.1' })

      try {
        const res = await fetch(`${BASE}/api/qr`)
        const data = await res.json()

        expect(data.setupURI).toBeNull()
        expect(data.pincode).toBeNull()
      } finally {
        await server.close()
      }
    })

    it('GET /api/qr returns pairing info when HAP bridge is set', async () => {
      const { createServer } = await import('../server.js')
      const { PluginRegistry } = await import('@nubisco/openbridge-core')
      const registry = new PluginRegistry()

      const hapInfo = { setupURI: 'X-HM://test', pincode: '111-22-333' }
      const server = await createServer(registry, null, hapInfo, [], new Set(), new Map())
      await server.listen({ port: TEST_PORT, host: '127.0.0.1' })

      try {
        const res = await fetch(`${BASE}/api/qr`)
        const data = await res.json()

        expect(data.setupURI).toBe('X-HM://test')
        expect(data.pincode).toBe('111-22-333')
      } finally {
        await server.close()
      }
    })
  })

  describe('Plugin Management', () => {
    it('GET /api/plugins returns registered plugins', async () => {
      writeConfig(baseConfig)
      const { createServer } = await import('../server.js')
      const { PluginRegistry } = await import('@nubisco/openbridge-core')
      const registry = new PluginRegistry()

      // Register a test plugin
      registry.register({
        manifest: { name: 'test-plugin', version: '1.0.0', description: 'A test' },
      })
      registry.updateStatus('test-plugin', 'running')

      const server = await createServer(registry, null, null, [], new Set(), new Map())
      await server.listen({ port: TEST_PORT, host: '127.0.0.1' })

      try {
        const res = await fetch(`${BASE}/api/plugins`)
        const data = await res.json()

        expect(data.plugins).toHaveLength(1)
        expect(data.plugins[0].manifest.name).toBe('test-plugin')
        expect(data.plugins[0].status).toBe('running')
      } finally {
        await server.close()
      }
    })

    it('POST /api/plugins/:id/disabled toggles disabled state', async () => {
      writeConfig(baseConfig)
      const { createServer } = await import('../server.js')
      const { PluginRegistry } = await import('@nubisco/openbridge-core')
      const registry = new PluginRegistry()

      registry.register({
        manifest: { name: 'toggle-test', version: '1.0.0' },
      })
      registry.updateStatus('toggle-test', 'running')

      const server = await createServer(registry, null, null, [], new Set(), new Map())
      await server.listen({ port: TEST_PORT, host: '127.0.0.1' })

      try {
        // Disable
        const res1 = await fetch(`${BASE}/api/plugins/toggle-test/disabled`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ disabled: true }),
        })
        const data1 = await res1.json()
        expect(data1.disabled).toBe(true)

        // Verify persisted to config
        const cfg = readConfig()
        expect((cfg as any).disabledPlugins).toContain('toggle-test')

        // Re-enable
        const res2 = await fetch(`${BASE}/api/plugins/toggle-test/disabled`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ disabled: false }),
        })
        const data2 = await res2.json()
        expect(data2.disabled).toBe(false)

        const cfg2 = readConfig()
        expect((cfg2 as any).disabledPlugins).not.toContain('toggle-test')
      } finally {
        await server.close()
      }
    })
  })

  describe('Config Management', () => {
    it('GET /api/config returns config content', async () => {
      writeConfig(baseConfig)
      const { createServer } = await import('../server.js')
      const { PluginRegistry } = await import('@nubisco/openbridge-core')
      const registry = new PluginRegistry()

      const server = await createServer(registry, null, null, [], new Set(), new Map())
      await server.listen({ port: TEST_PORT, host: '127.0.0.1' })

      try {
        const res = await fetch(`${BASE}/api/config`)
        const data = await res.json()

        expect(data.content).toBeDefined()
        const parsed = JSON.parse(data.content)
        expect(parsed.bridge.name).toBe('Test Bridge')
      } finally {
        await server.close()
      }
    })

    it('POST /api/config saves valid JSON', async () => {
      writeConfig(baseConfig)
      const { createServer } = await import('../server.js')
      const { PluginRegistry } = await import('@nubisco/openbridge-core')
      const registry = new PluginRegistry()

      const server = await createServer(registry, null, null, [], new Set(), new Map())
      await server.listen({ port: TEST_PORT, host: '127.0.0.1' })

      try {
        const newConfig = { ...baseConfig, bridge: { ...baseConfig.bridge, name: 'Updated Bridge' } }
        const res = await fetch(`${BASE}/api/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: JSON.stringify(newConfig, null, 2) }),
        })

        expect(res.ok).toBe(true)

        // Verify file was written
        const saved = readConfig()
        expect((saved as any).bridge.name).toBe('Updated Bridge')
      } finally {
        await server.close()
      }
    })

    it('POST /api/config rejects invalid JSON', async () => {
      writeConfig(baseConfig)
      const { createServer } = await import('../server.js')
      const { PluginRegistry } = await import('@nubisco/openbridge-core')
      const registry = new PluginRegistry()

      const server = await createServer(registry, null, null, [], new Set(), new Map())
      await server.listen({ port: TEST_PORT, host: '127.0.0.1' })

      try {
        const res = await fetch(`${BASE}/api/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: 'not valid json {{' }),
        })

        expect(res.ok).toBe(false)
      } finally {
        await server.close()
      }
    })
  })

  describe('Bridge Config', () => {
    it('GET /api/bridge returns bridge settings', async () => {
      writeConfig(baseConfig)
      const { createServer } = await import('../server.js')
      const { PluginRegistry } = await import('@nubisco/openbridge-core')
      const registry = new PluginRegistry()

      const server = await createServer(registry, null, null, [], new Set(), new Map())
      await server.listen({ port: TEST_PORT, host: '127.0.0.1' })

      try {
        const res = await fetch(`${BASE}/api/bridge`)
        const data = await res.json()

        expect(data.name).toBe('Test Bridge')
        expect(data.port).toBe(TEST_PORT)
        expect(data.pincode).toBe('111-22-333')
      } finally {
        await server.close()
      }
    })

    it('POST /api/bridge updates bridge config', async () => {
      writeConfig(baseConfig)
      const { createServer } = await import('../server.js')
      const { PluginRegistry } = await import('@nubisco/openbridge-core')
      const registry = new PluginRegistry()

      const server = await createServer(registry, null, null, [], new Set(), new Map())
      await server.listen({ port: TEST_PORT, host: '127.0.0.1' })

      try {
        const res = await fetch(`${BASE}/api/bridge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'New Bridge Name' }),
        })
        expect(res.ok).toBe(true)

        const saved = readConfig()
        expect((saved as any).bridge.name).toBe('New Bridge Name')
      } finally {
        await server.close()
      }
    })
  })

  describe('Device Management', () => {
    it('GET /api/devices returns devices from registry', async () => {
      writeConfig(baseConfig)
      const { createServer } = await import('../server.js')
      const { PluginRegistry } = await import('@nubisco/openbridge-core')
      const registry = new PluginRegistry()

      // Register a plugin with devices
      const instance = registry.register({
        manifest: { name: 'device-plugin', version: '1.0.0' },
      })
      instance.devices = {
        'dev-1': {
          id: 'dev-1',
          name: 'Test Switch',
          widgetType: 'switch',
          pluginId: 'device-plugin',
        },
      }
      instance.telemetry = {
        'dev-1': { active: true, _updatedAt: new Date().toISOString() },
      }
      registry.updateStatus('device-plugin', 'running')

      const server = await createServer(registry, null, null, [], new Set(), new Map())
      await server.listen({ port: TEST_PORT, host: '127.0.0.1' })

      try {
        const res = await fetch(`${BASE}/api/devices`)
        const data = await res.json()

        expect(data.devices).toHaveLength(1)
        expect(data.devices[0].id).toBe('dev-1')
        expect(data.devices[0].name).toBe('Test Switch')
        expect(data.devices[0].telemetry.active).toBe(true)
        expect(data.devices[0].pluginStatus).toBe('running')
      } finally {
        await server.close()
      }
    })

    it('POST /api/devices/:id/control calls registered handler', async () => {
      writeConfig(baseConfig)
      const { createServer } = await import('../server.js')
      const { PluginRegistry } = await import('@nubisco/openbridge-core')
      const registry = new PluginRegistry()

      let controlledValue: unknown = null
      const controls = new Map<string, (value: unknown) => void>()
      controls.set('dev-1::active', (value) => {
        controlledValue = value
      })

      // Register device
      const instance = registry.register({
        manifest: { name: 'ctrl-plugin', version: '1.0.0' },
      })
      instance.devices = {
        'dev-1': { id: 'dev-1', name: 'Switch', widgetType: 'switch', pluginId: 'ctrl-plugin' },
      }
      registry.updateStatus('ctrl-plugin', 'running')

      const server = await createServer(registry, null, null, [], new Set(), controls)
      await server.listen({ port: TEST_PORT, host: '127.0.0.1' })

      try {
        const res = await fetch(`${BASE}/api/devices/dev-1/control`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ control: 'active', value: false }),
        })

        expect(res.ok).toBe(true)
        expect(controlledValue).toBe(false)
      } finally {
        await server.close()
      }
    })
  })

  describe('Marketplace Uninstall', () => {
    it('DELETE /api/marketplace/uninstall prunes config.plugins', async () => {
      const config = {
        ...baseConfig,
        plugins: [
          { name: 'keep-this', config: {} },
          { name: 'remove-this', config: {} },
        ],
      }
      writeConfig(config)

      const { createServer } = await import('../server.js')
      const { PluginRegistry } = await import('@nubisco/openbridge-core')
      const registry = new PluginRegistry()

      // Register the plugin to be removed
      registry.register({
        manifest: { name: 'remove-this', version: '1.0.0' },
      })

      // Create a proper npm package structure so npm uninstall works
      writeFileSync(join(HB_PLUGINS_DIR, 'package.json'), JSON.stringify({ dependencies: { 'remove-this': '1.0.0' } }))
      const pkgDir = join(HB_PLUGINS_DIR, 'node_modules', 'remove-this')
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), '{"name":"remove-this","version":"1.0.0"}')

      const server = await createServer(registry, null, null, [], new Set(), new Map())
      await server.listen({ port: TEST_PORT, host: '127.0.0.1' })

      try {
        const res = await fetch(`${BASE}/api/marketplace/uninstall/remove-this`, {
          method: 'DELETE',
        })
        const data = await res.json()

        expect(data.uninstalled).toBe('remove-this')

        // Verify plugin removed from config
        const saved = readConfig()
        const plugins = (saved as any).plugins as { name: string }[]
        expect(plugins).toHaveLength(1)
        expect(plugins[0].name).toBe('keep-this')

        // Verify removed from registry
        expect(registry.get('remove-this')).toBeUndefined()
      } finally {
        await server.close()
      }
    })

    it('DELETE /api/marketplace/uninstall prunes config.platforms', async () => {
      const config = {
        ...baseConfig,
        platforms: [
          { platform: 'KeepPlatform', plugin: `${HB_PLUGINS_DIR}/node_modules/keep-plugin/dist/index.js` },
          { platform: 'RemovePlatform', plugin: `${HB_PLUGINS_DIR}/node_modules/remove-plugin/dist/index.js` },
        ],
      }
      writeConfig(config)

      const { createServer } = await import('../server.js')
      const { PluginRegistry } = await import('@nubisco/openbridge-core')
      const registry = new PluginRegistry()

      // Create proper npm package structure
      writeFileSync(
        join(HB_PLUGINS_DIR, 'package.json'),
        JSON.stringify({ dependencies: { 'remove-plugin': '1.0.0' } }),
      )
      const pkgDir = join(HB_PLUGINS_DIR, 'node_modules', 'remove-plugin')
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), '{"name":"remove-plugin","version":"1.0.0"}')

      const server = await createServer(registry, null, null, [], new Set(), new Map())
      await server.listen({ port: TEST_PORT, host: '127.0.0.1' })

      try {
        const res = await fetch(`${BASE}/api/marketplace/uninstall/remove-plugin`, {
          method: 'DELETE',
        })

        expect(res.ok).toBe(true)

        const saved = readConfig()
        const platforms = (saved as any).platforms as { platform: string }[]
        expect(platforms).toHaveLength(1)
        expect(platforms[0].platform).toBe('KeepPlatform')
      } finally {
        await server.close()
      }
    })
  })

  describe('Platform Auth Callback (multi-account rules)', () => {
    const ISSUER = 'https://platform.test'
    const KID = 'test-key'
    let keyPair: CryptoKeyPair
    let publicJwk: JsonWebKey & { kid: string; alg: string; use: string }

    beforeAll(async () => {
      keyPair = (await crypto.subtle.generateKey(
        { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
        true,
        ['sign', 'verify'],
      )) as CryptoKeyPair
      publicJwk = { ...(await crypto.subtle.exportKey('jwk', keyPair.publicKey)), kid: KID, alg: 'RS256', use: 'sig' }
    })

    async function signJwt(claims: Record<string, unknown>): Promise<string> {
      const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url')
      const signingInput = `${enc({ alg: 'RS256', kid: KID })}.${enc(claims)}`
      const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keyPair.privateKey, Buffer.from(signingInput))
      return `${signingInput}.${Buffer.from(sig).toString('base64url')}`
    }

    function baseClaims(): Record<string, unknown> {
      const now = Math.floor(Date.now() / 1000)
      return {
        sub: 'u-jose',
        email: 'jose@nubisco.io',
        role: 'admin',
        app: 'openbridge',
        iss: ISSUER,
        iat: now,
        exp: now + 300,
      }
    }

    async function withAuthServer(fn: (base: string) => Promise<void>) {
      writeConfig(baseConfig)
      process.env.PLATFORM_ENABLED = 'true'
      process.env.PLATFORM_ISSUER = ISSUER
      process.env.PLATFORM_APP_ID = 'openbridge'

      const realFetch = globalThis.fetch
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        if (String(input) === `${ISSUER}/.well-known/jwks.json`) {
          return Promise.resolve(new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 }))
        }
        return realFetch(input, init)
      })

      const { createServer } = await import('../server.js')
      const { PluginRegistry } = await import('@nubisco/openbridge-core')
      const server = await createServer(new PluginRegistry(), null, null, [], new Set(), new Map())
      await server.listen({ port: TEST_PORT, host: '127.0.0.1' })

      try {
        await fn(BASE)
      } finally {
        fetchSpy.mockRestore()
        delete process.env.PLATFORM_ENABLED
        delete process.env.PLATFORM_ISSUER
        delete process.env.PLATFORM_APP_ID
        await server.close()
      }
    }

    async function postCallback(base: string, body: Record<string, unknown>) {
      return fetch(`${base}/auth/platform/callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    }

    it('accepts a valid token for this app and sets a session cookie', async () => {
      await withAuthServer(async (base) => {
        const res = await postCallback(base, { token: await signJwt(baseClaims()) })
        expect(res.status).toBe(200)
        expect(res.headers.get('set-cookie')).toContain('openbridge_session=')
        const data = await res.json()
        expect(data.user).toEqual({ id: 'u-jose', email: 'jose@nubisco.io' })
      })
    })

    it('rejects a token issued to a different app', async () => {
      await withAuthServer(async (base) => {
        const res = await postCallback(base, { token: await signJwt({ ...baseClaims(), app: 'analytics' }) })
        expect(res.status).toBe(401)
        expect((await res.json()).error).toBe('wrong_app')
      })
    })

    it('rejects a renewal whose subject changed (expected_sub mismatch)', async () => {
      await withAuthServer(async (base) => {
        const res = await postCallback(base, { token: await signJwt(baseClaims()), expected_sub: 'u-tools' })
        expect(res.status).toBe(409)
        expect((await res.json()).error).toBe('subject_mismatch')
      })
    })

    it('accepts a renewal when the subject matches expected_sub', async () => {
      await withAuthServer(async (base) => {
        const res = await postCallback(base, { token: await signJwt(baseClaims()), expected_sub: 'u-jose' })
        expect(res.status).toBe(200)
      })
    })
  })

  describe('Update Check', () => {
    beforeEach(() => {
      writeConfig(baseConfig)
    })

    it('GET /api/updates/check resolves latest via releases redirect even when the API is rate-limited', async () => {
      const { createServer } = await import('../server.js')
      const { PluginRegistry } = await import('@nubisco/openbridge-core')
      const registry = new PluginRegistry()

      const server = await createServer(registry, null, null, [], new Set(), new Map())
      await server.listen({ port: TEST_PORT, host: '127.0.0.1' })

      const realFetch = globalThis.fetch
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        const url = String(input)
        if (url === 'https://github.com/nubisco/openbridge/releases/latest') {
          return Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { location: 'https://github.com/nubisco/openbridge/releases/tag/v9.9.9' },
            }),
          )
        }
        if (url.startsWith('https://api.github.com/')) {
          return Promise.resolve(new Response('{"message":"API rate limit exceeded"}', { status: 403 }))
        }
        return realFetch(input, init)
      })

      try {
        const res = await fetch(`${BASE}/api/updates/check`)
        const data = await res.json()

        expect(res.status).toBe(200)
        expect(data.current).toBe('0.0.0-test')
        expect(data.latest).toBe('9.9.9')
        expect(data.updateAvailable).toBe(true)
        expect(data.releaseUrl).toBe('https://github.com/nubisco/openbridge/releases/tag/v9.9.9')
        expect(data.releaseNotes).toBeNull()
      } finally {
        fetchSpy.mockRestore()
        await server.close()
      }
    })

    it('GET /api/updates/check reports latest null when GitHub is unreachable', async () => {
      const { createServer } = await import('../server.js')
      const { PluginRegistry } = await import('@nubisco/openbridge-core')
      const registry = new PluginRegistry()

      const server = await createServer(registry, null, null, [], new Set(), new Map())
      await server.listen({ port: TEST_PORT, host: '127.0.0.1' })

      const realFetch = globalThis.fetch
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        const url = String(input)
        if (url.includes('github.com')) {
          return Promise.reject(new TypeError('fetch failed'))
        }
        return realFetch(input, init)
      })

      try {
        const res = await fetch(`${BASE}/api/updates/check`)
        const data = await res.json()

        expect(res.status).toBe(200)
        expect(data.current).toBe('0.0.0-test')
        expect(data.latest).toBeNull()
        expect(data.updateAvailable).toBe(false)
      } finally {
        fetchSpy.mockRestore()
        await server.close()
      }
    })
  })
})
