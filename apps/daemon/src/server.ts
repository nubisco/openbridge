import Fastify from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import type { SocketStream } from '@fastify/websocket'
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, chmodSync } from 'fs'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import { createRequire } from 'module'
import os from 'os'

const _req = createRequire(import.meta.url)
import type { PluginRegistry, Plugin } from '@openbridge/core'
import { Logger } from '@openbridge/logger'
import type { LogEntry } from '@openbridge/logger'
import type { HomebridgeAPI } from '@openbridge/compatibility-homebridge'
import { startMetrics, onMetrics, getHistory } from './metrics.js'

const log = Logger.create('system')

const __dirname = dirname(fileURLToPath(import.meta.url))

// Read version from own package.json (works in both monorepo dev and npm install)
const _ownPkg = _req('../package.json') as { version: string }
export const OPENBRIDGE_VERSION: string = _ownPkg.version

// Resolve UI dist: env override → npm layout (../ui-dist) → monorepo dev layout
const uiDist =
  [process.env.OPENBRIDGE_UI_PATH, resolve(__dirname, '../ui-dist'), resolve(__dirname, '../../../apps/ui/dist')]
    .filter(Boolean)
    .find((p) => existsSync(p!)) ?? ''
const uiAvailable = !!uiDist

import { OPENBRIDGE_HOME, OB_PLUGINS_DIR, HB_PLUGINS_DIR } from './daemon.js'

export interface HapInfo {
  setupURI: string
  pincode: string
}

export interface LocalPlugin {
  name: string
  version: string
  description: string
  author: string
  path: string
  platform?: string
  displayName?: string
}

export async function createServer(
  registry: PluginRegistry,
  hapAPI: HomebridgeAPI | null = null,
  hapInfo: HapInfo | null = null,
  localPluginSources: string[] = [],
  knownHbPackageNames: Set<string> = new Set(),
) {
  const app = Fastify({ logger: false })

  await app.register(cors, { origin: true })
  await app.register(websocket)

  // Start live metrics collection
  startMetrics(2000)

  // ─── Health ───────────────────────────────────────────────────────────────
  app.get('/api/health', async () => {
    return { status: 'ok', version: OPENBRIDGE_VERSION, timestamp: new Date().toISOString() }
  })

  // ─── Update check ─────────────────────────────────────────────────────────
  app.get('/api/updates/check', async () => {
    try {
      const res = await fetch('https://registry.npmjs.org/openbridge/latest', {
        signal: AbortSignal.timeout(8000),
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) return { current: OPENBRIDGE_VERSION, latest: null, updateAvailable: false }
      const data = (await res.json()) as { version: string }
      const latest = data.version
      const updateAvailable = latest !== OPENBRIDGE_VERSION
      return { current: OPENBRIDGE_VERSION, latest, updateAvailable }
    } catch {
      return { current: OPENBRIDGE_VERSION, latest: null, updateAvailable: false }
    }
  })

  // ─── Update apply (triggers Watchtower pull + container restart) ──────────
  app.post('/api/updates/apply', async () => {
    const token = process.env.WATCHTOWER_TOKEN
    if (!token) {
      throw { statusCode: 503, message: 'Update service not configured (WATCHTOWER_TOKEN not set)' }
    }
    try {
      const res = await fetch('http://watchtower:8080/v1/update', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) throw new Error(`Watchtower responded with ${res.status}`)
      log.info('Update triggered via Watchtower — container will restart shortly')
      return { updating: true }
    } catch (err) {
      throw { statusCode: 502, message: `Failed to contact update service: ${err}` }
    }
  })

  // ─── System info ──────────────────────────────────────────────────────────
  app.get('/api/system', async () => {
    const ni = os.networkInterfaces()
    const ip =
      Object.values(ni)
        .flat()
        .find((a) => a && !a.internal && a.family === 'IPv4')?.address ?? 'N/A'
    return {
      os: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      hostname: os.hostname(),
      user: os.userInfo().username,
      nodeVersion: process.version,
      ip,
      configPath: join(OPENBRIDGE_HOME, 'config.json'),
      obPluginsDir: OB_PLUGINS_DIR,
      hbPluginsDir: HB_PLUGINS_DIR,
      uptimeSystem: os.uptime(),
      uptimeProcess: process.uptime(),
    }
  })

  // ─── HomeKit QR ───────────────────────────────────────────────────────────
  app.get('/api/qr', async () => {
    return hapInfo ?? { setupURI: null, pincode: null }
  })

  // ─── Live metrics WebSocket ───────────────────────────────────────────────
  app.get('/ws/metrics', { websocket: true }, (connection: SocketStream) => {
    const ws = connection.socket
    // Send history immediately on connect
    ws.send(JSON.stringify({ type: 'history', data: getHistory() }))

    const unsub = onMetrics((snap) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'snapshot', data: snap }))
      }
    })

    ws.on('close', unsub)
  })

  // ─── Plugins ─────────────────────────────────────────────────────────────
  app.get('/api/plugins', async () => {
    return { plugins: registry.getAll() }
  })

  // Re-scan HB plugins dir and register any newly installed packages
  app.post('/api/plugins/refresh', async () => {
    const manifestPath = join(HB_PLUGINS_DIR, 'package.json')
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
        const deps: Record<string, string> = manifest.dependencies ?? {}
        for (const pkgName of Object.keys(deps)) {
          if (registry.get(pkgName)) continue
          if (knownHbPackageNames.has(pkgName)) continue // already running via config.platforms
          const pkgJsonPath = join(HB_PLUGINS_DIR, 'node_modules', pkgName, 'package.json')
          if (!existsSync(pkgJsonPath)) continue
          try {
            const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
            const name: string = pkg.name ?? pkgName
            const pseudoPlugin: Plugin = {
              manifest: {
                name,
                version: pkg.version ?? '?.?.?',
                description: pkg.description ?? '',
                author: typeof pkg.author === 'string' ? pkg.author : (pkg.author?.name ?? ''),
              },
            }
            const instance = registry.register(pseudoPlugin)
            instance.source = 'homebridge'
            registry.updateStatus(name, 'stopped')
            log.info(`Discovered plugin: ${name}`)
          } catch {
            /* skip */
          }
        }
      } catch {
        /* ignore */
      }
    }
    return { plugins: registry.getAll() }
  })

  app.get('/api/plugins/:id', async (req) => {
    const { id } = req.params as { id: string }
    const entry = registry.get(id)
    if (!entry) throw { statusCode: 404, message: `Plugin '${id}' not found` }
    return entry.instance
  })

  // ─── Accessories (HAP / Homebridge) ───────────────────────────────────────
  app.get('/api/accessories', async () => {
    return { accessories: hapAPI ? hapAPI.getAccessories() : [] }
  })

  // Write a characteristic value — triggers the platform's onSet handler
  app.post('/api/accessories/:uuid/characteristics', async (req) => {
    if (!hapAPI) throw { statusCode: 503, message: 'HAP not available' }
    const { uuid } = req.params as { uuid: string }
    const { serviceUuid, charUuid, value } = req.body as { serviceUuid: string; charUuid: string; value: unknown }

    const raw = hapAPI.getRawAccessories()
    const acc = raw.find((a: any) => a.UUID === uuid)
    if (!acc) throw { statusCode: 404, message: `Accessory '${uuid}' not found` }

    const svc = acc.services?.find((s: any) => s.UUID === serviceUuid)
    if (!svc) throw { statusCode: 404, message: `Service '${serviceUuid}' not found` }

    const ch = svc.characteristics?.find((c: any) => c.UUID === charUuid)
    if (!ch) throw { statusCode: 404, message: `Characteristic '${charUuid}' not found` }

    try {
      ch.setValue(value)
    } catch (err) {
      throw { statusCode: 500, message: `setValue failed: ${err}` }
    }

    log.debug(`Set ${acc.displayName} / ${svc.displayName} / ${ch.displayName} = ${value}`)
    return { uuid, serviceUuid, charUuid, value }
  })

  app.get('/api/accessories/debug', async () => {
    if (!hapAPI) return { hapAPI: false }
    const raw = hapAPI.getRawAccessories()
    return {
      count: raw.length,
      names: raw.map((a: any) => ({ displayName: a.displayName, UUID: a.UUID, category: a.category })),
    }
  })

  // ─── Bridge config (structured) ───────────────────────────────────────────
  app.get('/api/bridge', async () => {
    try {
      const cfg = JSON.parse(readFileSync(configPath, 'utf8'))
      return cfg.bridge ?? {}
    } catch {
      return {}
    }
  })

  app.post('/api/bridge', async (req) => {
    const bridgeUpdate = req.body as Record<string, unknown>
    let cfg: any = {}
    try {
      cfg = JSON.parse(readFileSync(configPath, 'utf8'))
    } catch {
      /* start fresh */
    }
    cfg.bridge = { ...(cfg.bridge ?? {}), ...bridgeUpdate }
    writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8')
    log.info('Bridge config saved')
    return { saved: true, bridge: cfg.bridge }
  })

  // ─── Config file editor ────────────────────────────────────────────────────
  const configPath = resolve(os.homedir(), '.openbridge', 'config.json')

  app.get('/api/config', async () => {
    try {
      return { content: readFileSync(configPath, 'utf8') }
    } catch {
      return { content: '{}' }
    }
  })

  app.post('/api/config', async (req) => {
    const { content } = req.body as { content: string }
    try {
      JSON.parse(content)
    } catch {
      throw { statusCode: 400, message: 'Invalid JSON' }
    }
    writeFileSync(configPath, content, 'utf8')
    log.info('Config saved')
    return { saved: true }
  })

  // Upsert a single platform entry (add or replace by platform name)
  app.post('/api/config/platform', async (req) => {
    const { platform } = req.body as { platform: Record<string, unknown> }
    if (!platform?.platform) throw { statusCode: 400, message: 'platform.platform is required' }
    let cfg: any = {}
    try {
      cfg = JSON.parse(readFileSync(configPath, 'utf8'))
    } catch {
      /* start fresh */
    }
    const platforms: any[] = cfg.platforms ?? []
    const idx = platforms.findIndex((p: any) => p.platform === platform.platform)
    if (idx >= 0) platforms[idx] = platform
    else platforms.push(platform)
    cfg.platforms = platforms
    writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8')
    log.info(`Platform config saved: ${platform.platform}`)
    return { saved: true, platform: platform.platform }
  })

  // Get a single platform's config (or empty object if not configured)
  app.get('/api/config/platform/:name', async (req) => {
    const { name } = req.params as { name: string }
    try {
      const cfg = JSON.parse(readFileSync(configPath, 'utf8'))
      const entry = (cfg.platforms ?? []).find((p: any) => p.platform === name)
      return { config: entry ?? null }
    } catch {
      return { config: null }
    }
  })

  // ─── Marketplace ──────────────────────────────────────────────────────────
  app.get('/api/marketplace/search', async (req) => {
    const { q = '', from = '0', size = '20' } = req.query as Record<string, string>
    const text = encodeURIComponent(`keywords:homebridge-plugin ${q}`.trim())
    const url = `https://registry.npmjs.org/-/v1/search?text=${text}&size=${size}&from=${from}`
    const res = await fetch(url)
    if (!res.ok) throw { statusCode: 502, message: `npm registry error: ${res.status}` }
    return res.json()
  })

  // Probe a marketplace plugin to discover its platform name(s) without fully starting it
  app.get('/api/marketplace/plugin-info/:name', async (req) => {
    const { name } = req.params as { name: string }
    const pkgDir = join(HB_PLUGINS_DIR, 'node_modules', name)
    if (!existsSync(pkgDir)) throw { statusCode: 404, message: `Plugin '${name}' not installed` }

    const pkgJsonPath = join(pkgDir, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
    const mainFile = join(pkgDir, pkg.main ?? 'index.js')

    const platforms: string[] = []
    const spyAPI: any = {
      hap: { Characteristic: {}, Service: {}, Accessory: { Categories: {} }, uuid: { generate: () => '' } },
      platformAccessory: class {},
      // Handle both calling conventions:
      //   4-arg: registerPlatform(pluginName, platformName, Constructor, dynamic)
      //   3-arg: registerPlatform(platformName, Constructor, dynamic)
      registerPlatform: (...args: any[]) => {
        const platformName = typeof args[0] === 'string' && typeof args[1] === 'string' ? args[1] : args[0]
        if (typeof platformName === 'string') platforms.push(platformName)
      },
      registerAccessory: () => {},
      on: () => spyAPI,
      emit: () => false,
      version: '2.0.0',
      serverVersion: '2.0.0',
      user: {
        storagePath: () => join(os.homedir(), '.openbridge'),
        configPath: () => join(os.homedir(), '.openbridge', 'config.json'),
        persistPath: () => join(os.homedir(), '.openbridge', 'persist'),
        cachedAccessoryPath: () => join(os.homedir(), '.openbridge', 'accessories'),
      },
    }

    try {
      const { loadHomebridgePlugin } = await import('@openbridge/compatibility-homebridge')
      const fn = loadHomebridgePlugin(mainFile)
      fn(spyAPI)
    } catch {
      /* plugin may fail without real HAP, but registration should have happened */
    }

    return { name, version: pkg.version, mainFile, platforms }
  })

  app.get('/api/marketplace/installed', async () => {
    const nmDir = join(HB_PLUGINS_DIR, 'node_modules')
    if (!existsSync(nmDir)) return { packages: [] }
    try {
      const pkgJson = join(HB_PLUGINS_DIR, 'package.json')
      if (!existsSync(pkgJson)) return { packages: [] }
      const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'))
      const deps = { ...pkg.dependencies }
      return {
        packages: Object.entries(deps).map(([name, version]) => {
          let mainFile = ''
          try {
            const pkgPath = join(nmDir, name, 'package.json')
            const p = JSON.parse(readFileSync(pkgPath, 'utf8'))
            mainFile = join(nmDir, name, p.main ?? 'index.js')
          } catch {
            /* ignore */
          }
          return { name, version, mainFile }
        }),
      }
    } catch {
      return { packages: [] }
    }
  })

  // OpenBridge native + local dev plugins
  // Always scans ~/.openbridge/plugins/openbridge (canonical install location)
  // plus any extra directories in config.localPluginSources (for dev/testing)
  app.get('/api/marketplace/local', async () => {
    const plugins: LocalPlugin[] = []
    const seen = new Set<string>()

    // Helper: scan a directory for openbridge-* sub-packages
    function scanDir(dir: string) {
      if (!existsSync(dir)) return
      let entries: string[]
      try {
        entries = readdirSync(dir, { encoding: 'utf8', withFileTypes: false }) as string[]
      } catch {
        return
      }
      for (const entry of entries) {
        if (!entry.startsWith('openbridge-')) continue
        const pkgPath = join(dir, entry, 'package.json')
        if (!existsSync(pkgPath)) continue
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
          const name: string = pkg.name ?? entry
          if (seen.has(name)) continue // deduplicate across sources
          seen.add(name)
          plugins.push({
            name,
            version: pkg.version ?? '0.0.0',
            description: pkg.description ?? '',
            author: typeof pkg.author === 'string' ? pkg.author : (pkg.author?.name ?? ''),
            path: join(dir, entry),
            platform: pkg.openbridge?.platform,
            displayName: pkg.openbridge?.displayName,
          })
        } catch {
          /* skip */
        }
      }
    }

    // 1. Canonical install location (highest priority — shows installed native plugins)
    scanDir(OB_PLUGINS_DIR)

    // 2. Extra dev/test directories from config
    for (const sourceDir of localPluginSources) scanDir(sourceDir)

    return { plugins }
  })

  app.post('/api/marketplace/install', async (req) => {
    const { package: pkg } = req.body as { package: string }
    if (!pkg || !/^[a-z0-9@._/-]+$/i.test(pkg)) {
      throw { statusCode: 400, message: 'Invalid package name' }
    }
    mkdirSync(HB_PLUGINS_DIR, { recursive: true })
    await new Promise<void>((ok, fail) => {
      const child = spawn('npm', ['install', '--prefix', HB_PLUGINS_DIR, pkg], {
        stdio: 'pipe',
        env: { ...process.env },
      })
      child.on('close', (code) => (code === 0 ? ok() : fail(new Error(`npm exited with ${code}`))))
    })
    // Find the installed plugin's main file
    let mainFile = ''
    try {
      const pkgPath = join(HB_PLUGINS_DIR, 'node_modules', pkg, 'package.json')
      const p = JSON.parse(readFileSync(pkgPath, 'utf8'))
      mainFile = join(HB_PLUGINS_DIR, 'node_modules', pkg, p.main ?? 'index.js')
    } catch {
      /* ignore */
    }
    log.info(`Installed plugin: ${pkg}`)
    return { installed: pkg, mainFile, pluginsDir: HB_PLUGINS_DIR }
  })

  app.delete('/api/marketplace/uninstall/:name', async (req) => {
    const { name } = req.params as { name: string }
    if (!name || !/^[a-z0-9@._/-]+$/i.test(name)) {
      throw { statusCode: 400, message: 'Invalid package name' }
    }
    await new Promise<void>((ok, fail) => {
      const child = spawn('npm', ['uninstall', '--prefix', HB_PLUGINS_DIR, name], {
        stdio: 'pipe',
        env: { ...process.env },
      })
      child.on('close', (code) => (code === 0 ? ok() : fail(new Error(`npm exited with ${code}`))))
    })
    log.info(`Uninstalled plugin: ${name}`)
    return { uninstalled: name }
  })

  // ─── Daemon restart ───────────────────────────────────────────────────────
  app.post('/api/daemon/restart', async (_req, reply) => {
    log.info('Restart requested via API — respawning...')
    await reply.send({ restarting: true })
    setTimeout(() => {
      // In dev mode (tsx watch), tsx's supervisor detects process exit and restarts automatically.
      // In prod mode (node dist/index.js), we respawn using the same entry point.
      const isTsx = process.argv.some((a) => a.includes('tsx'))
      if (isTsx) {
        // Let tsx watch restart us
        process.exit(0)
      } else {
        const child = spawn(process.execPath, process.argv.slice(1), {
          detached: true,
          stdio: 'inherit',
          env: process.env,
        })
        child.unref()
        process.exit(0)
      }
    }, 300)
  })

  // ─── Logs ─────────────────────────────────────────────────────────────────
  app.get('/api/logs', async (req) => {
    const query = req.query as { plugin?: string; limit?: string }
    const entries = Logger.getEntries(query.plugin, query.limit ? parseInt(query.limit) : 200)
    return { entries }
  })

  app.get('/ws/logs', { websocket: true }, (connection: SocketStream) => {
    const ws = connection.socket
    log.debug('Log WebSocket client connected')
    const unsubscribe = Logger.subscribe((entry: LogEntry) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(entry))
    })
    ws.on('close', () => {
      unsubscribe()
      log.debug('Log WebSocket client disconnected')
    })
  })

  // ─── Plugin config schema ────────────────────────────────────────────────
  // Returns parsed config.schema.json for a given installed HB plugin
  app.get('/api/marketplace/plugin-schema/:name', async (req) => {
    const { name } = req.params as { name: string }
    const pkgDir = join(HB_PLUGINS_DIR, 'node_modules', name)
    const schemaPath = join(pkgDir, 'config.schema.json')
    if (!existsSync(schemaPath)) {
      // Also try at package root (some plugins ship it differently)
      const altPath = join(pkgDir, 'homebridge-ui', 'config.schema.json')
      if (existsSync(altPath)) return { schema: JSON.parse(readFileSync(altPath, 'utf8')) }
      return { schema: null }
    }
    return { schema: JSON.parse(readFileSync(schemaPath, 'utf8')) }
  })

  // ─── Interactive shell WebSocket (PTY) ───────────────────────────────────
  // Ensure node-pty's spawn-helper has execute permission (pnpm doesn't preserve +x on prebuilds)
  try {
    const nodePtyDir = resolve(dirname(_req.resolve('node-pty')), '..')
    const arch = `${process.platform}-${process.arch}`
    const spawnHelper = join(nodePtyDir, 'prebuilds', arch, 'spawn-helper')
    if (existsSync(spawnHelper)) chmodSync(spawnHelper, 0o755)
  } catch {
    /* best-effort */
  }

  app.get('/ws/shell', { websocket: true }, (connection: SocketStream) => {
    const ws = connection.socket
    let pty: any = null
    try {
      const nodePty = _req('node-pty')
      const shell = process.env.SHELL || (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh')
      pty = nodePty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: process.env.HOME ?? process.cwd(),
        env: { ...process.env },
      })

      pty.onData((data: string) => {
        if (ws.readyState === ws.OPEN) ws.send(data)
      })

      pty.onExit(() => {
        if (ws.readyState === ws.OPEN) ws.close()
      })
    } catch (err) {
      ws.send(`\r\n\x1b[31mFailed to start shell: ${err}\x1b[0m\r\n`)
      ws.close()
      return
    }

    ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString())
        if (msg.type === 'input') pty?.write(msg.data)
        if (msg.type === 'resize') pty?.resize(Number(msg.cols), Number(msg.rows))
      } catch {
        // plain string input fallback
        pty?.write(raw.toString())
      }
    })

    ws.on('close', () => {
      try {
        pty?.kill()
      } catch {
        /* ignore */
      }
    })
  })

  // Terminal WebSocket — streams ANSI-formatted log lines for xterm.js
  app.get('/ws/terminal', { websocket: true }, (connection: SocketStream) => {
    const ws = connection.socket

    function ansiLine(entry: LogEntry): string {
      const ANSI: Record<string, string> = {
        debug: '\x1b[90m',
        info: '\x1b[36m',
        warn: '\x1b[33m',
        error: '\x1b[31m',
      }
      const reset = '\x1b[0m'
      const dim = '\x1b[2m'
      const time = new Date(entry.timestamp).toLocaleTimeString()
      const level = entry.level.toUpperCase().padEnd(5)
      const plugin = entry.plugin !== 'system' ? `\x1b[35m[${entry.plugin}]${reset} ` : ''
      return `${dim}${time}${reset} ${ANSI[entry.level] ?? ''}${level}${reset} ${plugin}${entry.message}\r\n`
    }

    // Replay recent history
    const history = Logger.getEntries(undefined, 500)
    for (const entry of history) {
      if (ws.readyState === ws.OPEN) ws.send(ansiLine(entry))
    }

    const unsubscribe = Logger.subscribe((entry: LogEntry) => {
      if (ws.readyState === ws.OPEN) ws.send(ansiLine(entry))
    })

    ws.on('close', unsubscribe)
  })

  // ─── Serve built UI ───────────────────────────────────────────────────────
  if (uiAvailable) {
    await app.register(fastifyStatic, { root: uiDist, wildcard: false })
    app.setNotFoundHandler(async (_req, reply) => reply.sendFile('index.html'))
    log.info(`Serving UI from ${uiDist}`)
  } else {
    app.get('/', async () => ({
      name: 'OpenBridge Daemon',
      version: OPENBRIDGE_VERSION,
      ui: 'not built — run: cd apps/ui && pnpm build',
    }))
  }

  return app
}
