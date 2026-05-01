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
import type { PluginRegistry, Plugin, DeviceDescriptor } from '@nubisco/openbridge-core'
import { Logger } from '@nubisco/openbridge-logger'
import type { LogEntry } from '@nubisco/openbridge-logger'
import type { HomebridgeAPI } from '@nubisco/openbridge-compatibility-homebridge'
import { startMetrics, onMetrics, getHistory } from './metrics.js'

const log = Logger.create('system')

const __dirname = dirname(fileURLToPath(import.meta.url))

// Version: prefer the volume's version.json (set by entrypoint or self-update),
// then OPENBRIDGE_VERSION env var, then package.json for local dev.
const _ownPkg = _req('../package.json') as { version: string }
const APP_VOLUME = '/opt/openbridge'
const VERSION_FILE = join(APP_VOLUME, 'version.json')

function resolveVersion(): string {
  try {
    const vf = JSON.parse(readFileSync(VERSION_FILE, 'utf8'))
    if (vf.version) return vf.version
  } catch {
    /* not on volume */
  }
  return process.env.OPENBRIDGE_VERSION ?? _ownPkg.version
}

export const OPENBRIDGE_VERSION: string = resolveVersion()

// Self-update state (shared with WebSocket clients)
type UpdateStage = 'idle' | 'downloading' | 'extracting' | 'swapping' | 'restarting' | 'error'
interface UpdateProgress {
  stage: UpdateStage
  progress?: number
  message?: string
  version?: string
}
let updateProgress: UpdateProgress = { stage: 'idle' }
const updateListeners = new Set<(msg: UpdateProgress) => void>()

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
  controls: Map<string, (value: unknown) => void | Promise<void>> = new Map(),
  restrictedControls: Set<string> = new Set(),
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
  // Cache the last successful check so rate-limited or failed requests
  // can still report a known latest version instead of "up to date".
  let lastKnownLatest: { version: string; url: string; notes: string } | null = null

  app.get('/api/updates/check', async () => {
    try {
      const res = await fetch('https://api.github.com/repos/nubisco/openbridge/releases/latest', {
        signal: AbortSignal.timeout(8000),
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'openbridge-daemon' },
      })
      if (res.ok) {
        const data = (await res.json()) as { tag_name: string; html_url: string; body: string }
        lastKnownLatest = {
          version: data.tag_name.replace(/^v/, ''),
          url: data.html_url,
          notes: data.body,
        }
      }
      // On non-OK (rate limit, etc.) fall through to use lastKnownLatest
    } catch {
      // Network error, timeout, etc. — fall through to use lastKnownLatest
    }

    const latest = lastKnownLatest?.version ?? null
    const updateAvailable = latest !== null && latest !== OPENBRIDGE_VERSION

    // Detect if self-update is possible (volume is writable)
    let updateMethod: 'self' | 'manual' = 'manual'
    try {
      const testFile = join(APP_VOLUME, '.write-test')
      writeFileSync(testFile, 'ok')
      const { unlinkSync } = await import('fs')
      unlinkSync(testFile)
      updateMethod = 'self'
    } catch {
      /* volume not writable — manual update only */
    }

    return {
      current: OPENBRIDGE_VERSION,
      latest,
      updateAvailable,
      updateMethod,
      releaseUrl: lastKnownLatest?.url ?? null,
      releaseNotes: lastKnownLatest?.notes ?? null,
    }
  })

  // ─── Update progress WebSocket ────────────────────────────────────────────
  app.get('/ws/updates', { websocket: true }, (connection: SocketStream) => {
    const ws = connection.socket
    const listener = (msg: UpdateProgress) => {
      try {
        ws.send(JSON.stringify(msg))
      } catch {
        /* disconnected */
      }
    }
    updateListeners.add(listener)
    // Send current state immediately
    ws.send(JSON.stringify(updateProgress))
    ws.on('close', () => updateListeners.delete(listener))
  })

  // ─── Self-update apply ────────────────────────────────────────────────────
  app.post('/api/updates/apply', async () => {
    if (updateProgress.stage !== 'idle' && updateProgress.stage !== 'error') {
      throw { statusCode: 409, message: 'Update already in progress' }
    }

    const arch = os.arch() === 'x64' ? 'amd64' : os.arch() === 'arm64' ? 'arm64' : os.arch()
    const currentDir = join(APP_VOLUME, 'current')
    const stagingDir = join(APP_VOLUME, 'staging')
    const previousDir = join(APP_VOLUME, 'previous')

    // Check volume is writable
    try {
      mkdirSync(stagingDir, { recursive: true })
    } catch {
      throw { statusCode: 503, message: 'Update volume not available. Mount /opt/openbridge as a Docker volume.' }
    }

    function broadcast(msg: UpdateProgress) {
      updateProgress = msg
      for (const listener of updateListeners) listener(msg)
    }

    // Run update async — respond immediately
    ;(async () => {
      try {
        // 1. Fetch release info
        log.info('Self-update: fetching release info...')
        broadcast({ stage: 'downloading', progress: 0, message: 'Fetching release info...' })
        const releaseRes = await fetch('https://api.github.com/repos/nubisco/openbridge/releases/latest', {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'openbridge-daemon' },
        })
        if (!releaseRes.ok) throw new Error(`GitHub API returned ${releaseRes.status}`)
        const release = (await releaseRes.json()) as {
          tag_name: string
          assets: Array<{ name: string; browser_download_url: string; size: number }>
        }
        const version = release.tag_name.replace(/^v/, '')
        const assetName = `openbridge-v${version}-linux-${arch}.tar.gz`
        const asset = release.assets.find((a) => a.name === assetName)
        if (!asset)
          throw new Error(`Release asset ${assetName} not found. Your architecture (${arch}) may not be supported yet.`)

        // 2. Download tarball
        log.info(`Self-update: downloading ${assetName} (${(asset.size / 1024 / 1024).toFixed(1)} MB)...`)
        broadcast({ stage: 'downloading', progress: 0.1, message: `Downloading v${version}...`, version })
        const dlRes = await fetch(asset.browser_download_url, {
          headers: { 'User-Agent': 'openbridge-daemon' },
          redirect: 'follow',
        })
        if (!dlRes.ok || !dlRes.body) throw new Error(`Download failed: ${dlRes.status}`)

        const tarballPath = join(APP_VOLUME, 'download.tar.gz')
        const { createWriteStream } = await import('fs')
        const { pipeline } = await import('stream/promises')
        const { Readable } = await import('stream')

        // Stream download with progress
        const totalSize = asset.size
        let downloaded = 0
        const progressStream = new (await import('stream')).Transform({
          transform(chunk, _encoding, callback) {
            downloaded += chunk.length
            if (totalSize > 0) {
              const pct = Math.round((downloaded / totalSize) * 100) / 100
              broadcast({
                stage: 'downloading',
                progress: pct,
                message: `Downloading v${version}... ${Math.round(pct * 100)}%`,
                version,
              })
            }
            callback(null, chunk)
          },
        })

        await pipeline(Readable.fromWeb(dlRes.body as any), progressStream, createWriteStream(tarballPath))
        log.info(`Downloaded ${assetName} (${(downloaded / 1024 / 1024).toFixed(1)} MB)`)

        // 3. Extract
        broadcast({ stage: 'extracting', message: `Extracting v${version}...`, version })
        // Clean staging
        const { rmSync } = await import('fs')
        rmSync(stagingDir, { recursive: true, force: true })
        mkdirSync(stagingDir, { recursive: true })

        await new Promise<void>((resolve, reject) => {
          const tar = spawn('tar', ['xzf', tarballPath, '-C', stagingDir])
          tar.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited with ${code}`))))
          tar.on('error', reject)
        })

        // Clean up tarball
        rmSync(tarballPath, { force: true })
        log.info(`Extracted to staging directory`)

        // 4. Swap: current → previous, staging → current
        broadcast({ stage: 'swapping', message: 'Installing update...', version })
        rmSync(previousDir, { recursive: true, force: true })
        if (existsSync(currentDir)) {
          const { renameSync } = await import('fs')
          renameSync(currentDir, previousDir)
        }
        const { renameSync } = await import('fs')
        renameSync(stagingDir, currentDir)

        // Fix node-pty permissions
        try {
          const { execSync } = await import('child_process')
          execSync(`find "${currentDir}/apps/daemon/node_modules" -name "spawn-helper" -exec chmod +x {} \\;`, {
            stdio: 'ignore',
          })
        } catch {
          /* ignore */
        }

        // 5. Write version.json
        writeFileSync(
          VERSION_FILE,
          JSON.stringify(
            {
              version,
              arch,
              source: 'self-update',
              installedAt: new Date().toISOString(),
              previousVersion: OPENBRIDGE_VERSION,
            },
            null,
            2,
          ),
        )

        log.info(`Update to v${version} installed successfully — restarting...`)
        broadcast({ stage: 'restarting', message: `Restarting with v${version}...`, version })

        // 6. Restart — just exit; Docker's restart policy will bring us back
        // The entrypoint will see source:"self-update" in version.json and keep the updated files
        setTimeout(() => {
          process.exit(0)
        }, 500)
      } catch (err: any) {
        log.error(`Self-update failed: ${err.message}`)
        broadcast({ stage: 'error', message: err.message })
        // Clean up staging on failure
        try {
          const { rmSync } = await import('fs')
          rmSync(stagingDir, { recursive: true, force: true })
          rmSync(join(APP_VOLUME, 'download.tar.gz'), { force: true })
        } catch {
          /* ignore */
        }
      }
    })()

    return { updating: true }
  })

  // ─── Rollback ─────────────────────────────────────────────────────────────
  app.post('/api/updates/rollback', async () => {
    const currentDir = join(APP_VOLUME, 'current')
    const previousDir = join(APP_VOLUME, 'previous')

    if (!existsSync(previousDir)) {
      throw { statusCode: 404, message: 'No previous version available for rollback' }
    }

    const { rmSync, renameSync } = await import('fs')
    const rollbackDir = join(APP_VOLUME, 'rollback-tmp')

    // Swap: current → rollback-tmp, previous → current
    if (existsSync(currentDir)) renameSync(currentDir, rollbackDir)
    renameSync(previousDir, currentDir)
    rmSync(rollbackDir, { recursive: true, force: true })

    // Read version from rolled-back files
    let rolledBackVersion = 'unknown'
    try {
      const vf = JSON.parse(readFileSync(VERSION_FILE, 'utf8'))
      rolledBackVersion = vf.previousVersion ?? 'unknown'
    } catch {
      /* ignore */
    }

    writeFileSync(
      VERSION_FILE,
      JSON.stringify(
        {
          version: rolledBackVersion,
          arch: os.arch() === 'x64' ? 'amd64' : os.arch(),
          source: 'rollback',
          installedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    )

    log.info(`Rolled back to v${rolledBackVersion} — restarting...`)

    // Restart
    setTimeout(() => {
      const child = spawn(process.execPath, process.argv.slice(1), {
        detached: true,
        stdio: 'inherit',
        env: process.env,
      })
      child.unref()
      process.exit(0)
    }, 300)

    return { rollingBack: true, version: rolledBackVersion }
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
    const plugins = registry.getAll()
    // Attach cached enriched metadata to each plugin
    const cache = loadMetadataCache()
    for (const plugin of plugins) {
      const pkgName = plugin.manifest.name
      if (cache[pkgName]) {
        plugin.enrichedMetadata = cache[pkgName]
      }
    }
    return { plugins }
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
    const plugins = registry.getAll()
    // Attach cached enriched metadata to each plugin
    const cache = loadMetadataCache()
    for (const plugin of plugins) {
      const pkgName = plugin.manifest.name
      if (cache[pkgName]) {
        plugin.enrichedMetadata = cache[pkgName]
      }
    }
    return { plugins }
  })

  app.get('/api/plugins/:id', async (req) => {
    const { id } = req.params as { id: string }
    const entry = registry.get(id)
    if (!entry) throw { statusCode: 404, message: `Plugin '${id}' not found` }
    const instance = entry.instance
    // Attach cached enriched metadata if available
    const cache = loadMetadataCache()
    const pkgName = instance.manifest.name
    if (cache[pkgName]) {
      instance.enrichedMetadata = cache[pkgName]
    }
    return instance
  })

  app.get('/api/plugins/:id/telemetry', async (req) => {
    const { id } = req.params as { id: string }
    const entry = registry.get(id)
    if (!entry) throw { statusCode: 404, message: `Plugin '${id}' not found` }
    return { telemetry: entry.instance.telemetry ?? {} }
  })

  // Returns all devices across all plugins with their descriptors and latest telemetry
  app.get('/api/devices', async () => {
    // Load custom names
    const namesPath = join(OPENBRIDGE_HOME, 'device-names.json')
    let customNames: Record<string, string> = {}
    try {
      customNames = JSON.parse(readFileSync(namesPath, 'utf8'))
    } catch {
      /* no custom names */
    }

    const devices: Array<DeviceDescriptor & { telemetry: Record<string, unknown>; pluginStatus: string }> = []
    for (const instance of registry.getAll()) {
      if (!instance.devices) continue
      for (const device of Object.values(instance.devices)) {
        const telemetry = instance.telemetry?.[device.id] ?? {}
        const name = customNames[device.id] ?? device.name
        devices.push({ ...device, name, telemetry, pluginStatus: instance.status })
      }
    }
    return { devices }
  })

  // ─── Device rename ──────────────────────────────────────────────────────
  app.post('/api/devices/:deviceId/rename', async (req) => {
    const { deviceId } = req.params as { deviceId: string }
    const { name } = req.body as { name: string }
    if (!name?.trim()) throw { statusCode: 400, message: 'name is required' }

    // Update in registry (native devices)
    for (const instance of registry.getAll()) {
      if (instance.devices?.[deviceId]) {
        instance.devices[deviceId].name = name.trim()
        break
      }
    }

    // Update HAP accessory name if it exists
    if (hapAPI) {
      const raw = hapAPI.getRawAccessories?.() ?? []
      const acc = raw.find((a: any) => a.UUID === deviceId)
      if (acc) {
        // Find AccessoryInformation service and set Name characteristic
        for (const svc of acc.services ?? []) {
          for (const ch of svc.characteristics ?? []) {
            if (ch.displayName === 'Name' || ch.constructor?.name === 'Name') {
              try {
                ch.setValue(name.trim())
              } catch {
                /* ignore — some characteristics may not accept setValue */
              }
            }
          }
        }
        // Also update the displayName
        acc.displayName = name.trim()
      }
    }

    // Persist custom names to file
    const namesPath = join(OPENBRIDGE_HOME, 'device-names.json')
    let customNames: Record<string, string> = {}
    try {
      customNames = JSON.parse(readFileSync(namesPath, 'utf8'))
    } catch {
      /* start fresh */
    }
    customNames[deviceId] = name.trim()
    writeFileSync(namesPath, JSON.stringify(customNames, null, 2))

    log.info(`Device ${deviceId} renamed to "${name.trim()}"`)
    return { ok: true, deviceId, name: name.trim() }
  })

  app.post('/api/devices/:deviceId/control', async (req) => {
    const { deviceId } = req.params as { deviceId: string }
    const { control, value } = req.body as { control: string; value: unknown }
    const key = `${deviceId}::${control}`
    if (restrictedControls.has(key)) {
      throw { statusCode: 403, message: `Control '${control}' is restricted for device '${deviceId}'` }
    }
    const handler = controls.get(key)
    if (!handler) throw { statusCode: 404, message: `No control '${control}' registered for device '${deviceId}'` }
    await handler(value)
    return { ok: true }
  })

  app.get('/api/devices/:deviceId/history', async (req) => {
    const { deviceId } = req.params as { deviceId: string }
    const { period = 'day', date } = req.query as { period?: string; date?: string }

    const historyDir = join(OPENBRIDGE_HOME, 'energy-history')
    const filePath = join(historyDir, `${deviceId}.json`)

    let samples: Array<{ t: string; e: number }> = []
    try {
      samples = JSON.parse(readFileSync(filePath, 'utf8'))
    } catch {
      return { period, date: date ?? new Date().toISOString().slice(0, 10), buckets: [] }
    }

    const ref = date ? new Date(date) : new Date()

    if (period === 'day') {
      // 24 hourly buckets for ref day
      const dayStr = ref.toISOString().slice(0, 10)
      const buckets = Array.from({ length: 24 }, (_, h) => {
        const label = `${String(h).padStart(2, '0')}:00`
        const start = new Date(`${dayStr}T${String(h).padStart(2, '0')}:00:00Z`)
        const end = new Date(
          `${dayStr}T${String(h + 1).padStart(2, '0') === '24' ? '23:59:59' : String(h + 1).padStart(2, '0') + ':00:00'}Z`,
        )
        const inWindow = samples.filter((s) => s.t >= start.toISOString() && s.t < end.toISOString())
        if (inWindow.length < 2) return { label, kwh: null }
        const kwh = inWindow[inWindow.length - 1].e - inWindow[0].e
        return { label, kwh: Math.max(0, Math.round(kwh * 100) / 100) }
      })
      const totalKwh = buckets.reduce((sum, b) => sum + (b.kwh ?? 0), 0)
      return { period, date: dayStr, buckets, totalKwh: Math.round(totalKwh * 100) / 100 }
    }

    if (period === 'month') {
      // Daily buckets for ref month
      const year = ref.getFullYear()
      const month = ref.getMonth()
      const daysInMonth = new Date(year, month + 1, 0).getDate()
      const monthStr = `${year}-${String(month + 1).padStart(2, '0')}`
      const buckets = Array.from({ length: daysInMonth }, (_, d) => {
        const dayStr = `${monthStr}-${String(d + 1).padStart(2, '0')}`
        const start = new Date(`${dayStr}T00:00:00Z`)
        const end = new Date(`${dayStr}T23:59:59Z`)
        const inWindow = samples.filter((s) => s.t >= start.toISOString() && s.t <= end.toISOString())
        if (inWindow.length < 2) return { label: String(d + 1), kwh: null }
        const kwh = inWindow[inWindow.length - 1].e - inWindow[0].e
        return { label: String(d + 1), kwh: Math.max(0, Math.round(kwh * 100) / 100) }
      })
      const totalKwh = buckets.reduce((sum, b) => sum + (b.kwh ?? 0), 0)
      return { period, date: monthStr, buckets, totalKwh: Math.round(totalKwh * 100) / 100 }
    }

    // period === 'year'
    const year = ref.getFullYear()
    const buckets = Array.from({ length: 12 }, (_, m) => {
      const monthStr = `${year}-${String(m + 1).padStart(2, '0')}`
      const start = new Date(`${monthStr}-01T00:00:00Z`)
      const end = new Date(year, m + 1, 0, 23, 59, 59)
      const inWindow = samples.filter((s) => s.t >= start.toISOString() && s.t <= end.toISOString())
      if (inWindow.length < 2)
        return {
          label: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m],
          kwh: null,
        }
      const kwh = inWindow[inWindow.length - 1].e - inWindow[0].e
      return {
        label: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m],
        kwh: Math.max(0, Math.round(kwh * 100) / 100),
      }
    })
    const totalKwh = buckets.reduce((sum, b) => sum + (b.kwh ?? 0), 0)
    return { period, date: String(year), buckets, totalKwh: Math.round(totalKwh * 100) / 100 }
  })

  app.post('/api/plugins/:id/disabled', async (req) => {
    const { id } = req.params as { id: string }
    const { disabled } = req.body as { disabled: boolean }
    const entry = registry.get(id)
    if (!entry) throw { statusCode: 404, message: `Plugin '${id}' not found` }

    // Update the instance
    entry.instance.disabled = disabled

    // Persist to config.json under a disabledPlugins array
    try {
      let cfg: any = {}
      try {
        cfg = JSON.parse(readFileSync(configPath, 'utf8'))
      } catch {
        /* start fresh */
      }
      const disabledPlugins = cfg.disabledPlugins ?? []
      if (disabled && !disabledPlugins.includes(id)) {
        disabledPlugins.push(id)
      } else if (!disabled) {
        const idx = disabledPlugins.indexOf(id)
        if (idx >= 0) disabledPlugins.splice(idx, 1)
      }
      cfg.disabledPlugins = disabledPlugins
      writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8')
      log.info(`Plugin disabled state toggled: ${id} -> ${disabled}`)
    } catch (err) {
      log.warn(`Failed to persist disabled state: ${err}`)
    }

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

  // Get a single native plugin's config
  app.get('/api/config/plugin/:name', async (req) => {
    const { name } = req.params as { name: string }
    try {
      const cfg = JSON.parse(readFileSync(configPath, 'utf8'))
      const entry = (cfg.plugins ?? []).find((p: any) => p.name === name)
      return { config: entry?.config ?? null }
    } catch {
      return { config: null }
    }
  })

  // Upsert a native plugin's config entry
  app.post('/api/config/plugin', async (req) => {
    const { name, config } = req.body as { name: string; config: Record<string, unknown> }
    if (!name) throw { statusCode: 400, message: 'name is required' }
    let cfg: any = {}
    try {
      cfg = JSON.parse(readFileSync(configPath, 'utf8'))
    } catch {
      /* start fresh */
    }
    const plugins: any[] = cfg.plugins ?? []
    const idx = plugins.findIndex((p: any) => p.name === name)
    if (idx >= 0) plugins[idx] = { ...plugins[idx], config }
    else plugins.push({ name, enabled: true, config })
    cfg.plugins = plugins
    writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8')
    log.info(`Plugin config saved: ${name}`)
    return { saved: true, name }
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
      const { loadHomebridgePlugin } = await import('@nubisco/openbridge-compatibility-homebridge')
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

  // ─── Plugin metadata cache helpers ─────────────────────────────────────────
  const metadataCachePath = resolve(os.homedir(), '.openbridge', 'plugin-metadata-cache.json')

  function loadMetadataCache(): Record<string, any> {
    try {
      if (existsSync(metadataCachePath)) {
        return JSON.parse(readFileSync(metadataCachePath, 'utf8'))
      }
    } catch {
      /* ignore */
    }
    return {}
  }

  function saveMetadataCache(cache: Record<string, any>) {
    try {
      mkdirSync(dirname(metadataCachePath), { recursive: true })
      writeFileSync(metadataCachePath, JSON.stringify(cache, null, 2), 'utf8')
    } catch (err) {
      log.warn(`Failed to save metadata cache: ${err}`)
    }
  }

  async function fetchAndCacheEnrichedMetadata(pkgName: string): Promise<Record<string, any> | undefined> {
    try {
      // Fetch from the enriched endpoint (same logic as GET /api/marketplace/enriched/:name)
      const enrichedRes = await fetch(
        `http://localhost:${process.env.PORT ?? 8000}/api/marketplace/enriched/${encodeURIComponent(pkgName)}`,
      ).catch(() => null)
      if (enrichedRes?.ok) {
        const enriched = await enrichedRes.json()
        // Save to cache
        const cache = loadMetadataCache()
        cache[pkgName] = enriched
        saveMetadataCache(cache)
        return enriched
      }
    } catch (err) {
      log.warn(`Failed to fetch enriched metadata for ${pkgName}: ${err}`)
    }
    return undefined
  }

  // ─── Plugin update checker ─────────────────────────────────────────────────
  // Queries npm registry for latest versions of all installed plugins and
  // sets `availableUpdate` on each PluginInstance when a newer version exists.

  async function checkPluginUpdates(): Promise<number> {
    const plugins = registry.getAll()
    let updatesFound = 0

    for (const plugin of plugins) {
      const name = plugin.manifest.name
      const currentVersion = plugin.manifest.version
      if (!currentVersion || currentVersion === '?.?.?') continue

      try {
        const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
          signal: AbortSignal.timeout(5000),
          headers: { Accept: 'application/json' },
        })
        if (!res.ok) continue
        const data = (await res.json()) as { version?: string }
        const latest = data.version
        if (!latest) continue

        if (latest !== currentVersion) {
          plugin.availableUpdate = latest
          updatesFound++
        } else {
          plugin.availableUpdate = undefined
        }
      } catch {
        // npm unreachable for this package, skip
      }
    }

    if (updatesFound > 0) {
      log.info(`Plugin update check: ${updatesFound} update(s) available`)
    }
    return updatesFound
  }

  // Check for updates on startup (after a delay for plugins to register) and every 6 hours
  setTimeout(() => checkPluginUpdates(), 60_000)
  setInterval(() => checkPluginUpdates(), 6 * 60 * 60_000)

  app.get('/api/plugins/updates', async () => {
    const count = await checkPluginUpdates()
    const updates = registry
      .getAll()
      .filter((p) => p.availableUpdate)
      .map((p) => ({
        name: p.manifest.name,
        current: p.manifest.version,
        latest: p.availableUpdate,
      }))
    return { count, updates }
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

    // Detect if native OpenBridge plugin and register immediately
    let isNative = false
    try {
      const pkgPath = join(HB_PLUGINS_DIR, 'node_modules', pkg, 'package.json')
      const p = JSON.parse(readFileSync(pkgPath, 'utf8'))
      isNative = (Array.isArray(p.keywords) && p.keywords.includes('openbridge-plugin')) || p.openbridge != null

      if (isNative) {
        // Register as a pseudo-plugin so it appears in the UI immediately
        // It will be fully loaded on next restart
        const pseudoPlugin: import('@nubisco/openbridge-core').Plugin = {
          manifest: {
            name: p.name ?? pkg,
            version: p.version ?? '?.?.?',
            description: p.description ?? '',
            author: typeof p.author === 'string' ? p.author : (p.author?.name ?? ''),
          },
        }
        if (!registry.get(p.name ?? pkg)) {
          registry.register(pseudoPlugin)
          registry.updateStatus(p.name ?? pkg, 'stopped')
        }
        log.info(`Discovered plugin: ${p.name ?? pkg}`)
      }
    } catch {
      /* ignore detection errors */
    }

    // Fetch and cache enriched metadata in the background (non-blocking)
    fetchAndCacheEnrichedMetadata(pkg).catch((err) => log.warn(`Failed to cache metadata for ${pkg}: ${err}`))

    log.info(`Installed plugin: ${pkg}`)
    return { installed: pkg, mainFile, pluginsDir: HB_PLUGINS_DIR, isNative, needsRestart: isNative }
  })

  app.post('/api/marketplace/update/:name', async (req) => {
    const { name } = req.params as { name: string }
    if (!name || !/^[a-z0-9@._/-]+$/i.test(name)) {
      throw { statusCode: 400, message: 'Invalid package name' }
    }

    const entry = registry.get(name)
    const targetVersion = entry?.instance.availableUpdate
    const installArg = targetVersion ? `${name}@${targetVersion}` : name

    mkdirSync(HB_PLUGINS_DIR, { recursive: true })
    await new Promise<void>((ok, fail) => {
      const child = spawn('npm', ['install', '--prefix', HB_PLUGINS_DIR, installArg], {
        stdio: 'pipe',
        env: { ...process.env },
      })
      child.on('close', (code) => (code === 0 ? ok() : fail(new Error(`npm exited with ${code}`))))
    })

    // Update the in-memory manifest version so the UI reflects the change immediately
    if (entry) {
      try {
        const pkgPath = join(HB_PLUGINS_DIR, 'node_modules', name, 'package.json')
        const p = JSON.parse(readFileSync(pkgPath, 'utf8'))
        entry.instance.manifest.version = p.version ?? entry.instance.manifest.version
        entry.instance.manifest.description = p.description ?? entry.instance.manifest.description
      } catch {
        // If we can't read the new version, the restart will pick it up
      }
      entry.instance.availableUpdate = undefined
    }

    log.info(`Updated plugin: ${name} to ${targetVersion ?? 'latest'}`)
    return { updated: name, version: targetVersion ?? 'latest', needsRestart: true }
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

    // Remove stale plugin instances from in-memory registry so /plugins updates immediately.
    const removedInstances = registry.unregisterWhere((instance) => {
      if (instance.manifest.name === name) return true
      const desc = instance.manifest.description ?? ''
      // Backward compatibility for older pseudo-plugin descriptions.
      return desc.includes(`Homebridge platform: ${name}`)
    })

    // Prune config.platforms AND config.plugins entries for this package.
    try {
      const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as any
      let changed = false

      // Remove from platforms (Homebridge-compat plugins)
      if (Array.isArray(cfg.platforms)) {
        const before = cfg.platforms.length
        cfg.platforms = cfg.platforms.filter((p: any) => {
          const pluginPath = String(p?.plugin ?? '')
          return !pluginPath.includes(`/node_modules/${name}/`)
        })
        if (cfg.platforms.length !== before) changed = true
      }

      // Remove from plugins (native OpenBridge plugins)
      if (Array.isArray(cfg.plugins)) {
        const before = cfg.plugins.length
        cfg.plugins = cfg.plugins.filter((p: any) => p?.name !== name)
        if (cfg.plugins.length !== before) changed = true
      }

      if (changed) {
        writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8')
      }
    } catch {
      /* ignore config pruning errors */
    }

    // Remove any symlink in the native plugins dir
    try {
      const { readdirSync, lstatSync, unlinkSync, readlinkSync } = await import('fs')
      const nativeDir = join(OPENBRIDGE_HOME, 'plugins', 'openbridge')
      if (existsSync(nativeDir)) {
        for (const entry of readdirSync(nativeDir)) {
          const entryPath = join(nativeDir, entry)
          try {
            const stat = lstatSync(entryPath)
            if (stat.isSymbolicLink()) {
              const target = readlinkSync(entryPath)
              if (entry.includes(name.replace(/^@[^/]+\//, '')) || target.includes(name)) {
                unlinkSync(entryPath)
                log.info(`Removed symlink: ${entryPath}`)
              }
            }
          } catch {
            /* skip */
          }
        }
      }
    } catch {
      /* ignore symlink cleanup errors */
    }

    // Clear metadata cache for this plugin
    try {
      const cache = loadMetadataCache()
      delete cache[name]
      saveMetadataCache(cache)
    } catch {
      /* ignore cache cleanup errors */
    }

    log.info(`Uninstalled plugin: ${name}`)
    return { uninstalled: name, removedInstances }
  })

  // ─── Daemon restart ───────────────────────────────────────────────────────
  app.post('/api/daemon/restart', async (_req, reply) => {
    log.info('Restart requested via API — respawning...')
    await reply.send({ restarting: true })
    setTimeout(() => {
      // In dev mode (OPENBRIDGE_DEV=true set by the dev script), tsx watch detects the exit and restarts.
      // In prod mode (node dist/index.js), we respawn using the same entry point.
      const isTsx = process.env.OPENBRIDGE_DEV === 'true'
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

  // Helper: Extract GitHub repo URL from various sources
  function extractGithubRepo(pkg: any): string | null {
    let repo = pkg.repository?.url ?? pkg.repository ?? pkg.homepage ?? pkg.links?.repository ?? ''
    if (typeof repo !== 'string') return null

    // Normalize common npm package repository URL forms:
    // - git+https://github.com/owner/repo.git
    // - https://github.com/owner/repo
    // - github:owner/repo
    // - git@github.com:owner/repo.git
    repo = repo
      .trim()
      .replace(/^github:/, 'https://github.com/')
      .replace(/^git\+/, '')
      .replace(/^git@github\.com:/, 'https://github.com/')

    const match = repo.match(/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/?#].*)?$/)
    return match ? `${match[1]}/${match[2]}` : null
  }

  function parseCompactGithubCount(raw: string): number | undefined {
    const text = raw.trim().toLowerCase().replace(/,/g, '')
    const m = text.match(/([0-9]*\.?[0-9]+)\s*([km])?/)
    if (!m) return undefined
    const value = Number(m[1])
    if (Number.isNaN(value)) return undefined
    if (m[2] === 'k') return Math.round(value * 1000)
    if (m[2] === 'm') return Math.round(value * 1_000_000)
    return Math.round(value)
  }

  // Enriched marketplace metadata endpoint
  // Fetches npm download stats, GitHub stars, sponsors, and README
  app.get('/api/marketplace/enriched/:name', async (req) => {
    const { name } = req.params as { name: string }
    try {
      // Start with basic package info from npm registry
      const npmRes = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
        signal: AbortSignal.timeout(5000),
        headers: { Accept: 'application/json' },
      })
      if (!npmRes.ok) return { name }

      const npmData = (await npmRes.json()) as any
      const latestVersion = npmData['dist-tags']?.latest ?? npmData.version
      const packData = npmData.versions?.[latestVersion] ?? {}

      // Fetch npm download stats
      let weeklyDownloads: number | undefined
      try {
        const statsRes = await fetch(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(name)}`, {
          signal: AbortSignal.timeout(3000),
          headers: { Accept: 'application/json' },
        })
        if (statsRes.ok) {
          const stats = (await statsRes.json()) as { downloads?: number }
          weeklyDownloads = stats.downloads
        }
      } catch {
        /* stats not available */
      }

      // Extract GitHub repo and fetch stars + sponsors
      const githubRepo = extractGithubRepo(packData)
      let githubStars: number | undefined
      let githubSponsorsUrl: string | undefined

      if (githubRepo) {
        const owner = githubRepo.split('/')[0]
        if (owner) {
          // Keep sponsor link available even when GitHub API rate limits.
          githubSponsorsUrl = `https://github.com/sponsors/${owner}`
        }

        try {
          const ghRes = await fetch(`https://api.github.com/repos/${githubRepo}`, {
            signal: AbortSignal.timeout(5000),
            headers: { Accept: 'application/json', 'User-Agent': 'OpenBridge' },
          })
          if (ghRes.ok) {
            const ghData = (await ghRes.json()) as any
            githubStars = ghData.stargazers_count
          }
        } catch {
          /* GitHub API not available */
        }

        // Fallback: scrape stars from repo page when API is unavailable/rate-limited.
        if (githubStars == null) {
          try {
            const htmlRes = await fetch(`https://github.com/${githubRepo}`, {
              signal: AbortSignal.timeout(5000),
              headers: { 'User-Agent': 'OpenBridge' },
            })
            if (htmlRes.ok) {
              const html = await htmlRes.text()
              const starBlock =
                html.match(new RegExp(`href="/${githubRepo}/stargazers"[^>]*>\\s*([\\s\\S]*?)<\\/a>`, 'i'))?.[1] ?? ''
              const starText = starBlock
                .replace(/<[^>]*>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
              githubStars = parseCompactGithubCount(starText)
            }
          } catch {
            /* HTML fallback unavailable */
          }
        }
      }

      // Try to fetch README
      let readme: string | undefined
      let badges: string[] | undefined
      if (githubRepo) {
        try {
          const readmeRes = await fetch(`https://raw.githubusercontent.com/${githubRepo}/HEAD/README.md`, {
            signal: AbortSignal.timeout(3000),
          })
          if (readmeRes.ok) {
            const content = await readmeRes.text()
            readme = content
            // Extract badge markdown links: ![...](...)
            const badgeMatches = content.match(/!\[.*?\]\(.*?\)/g) ?? []
            badges = badgeMatches.slice(0, 5) // Limit to first 5 badges
          }
        } catch {
          /* README not available */
        }
      }

      // Extract documentation URL from package.json
      let documentationUrl: string | undefined
      if (packData.homepage) documentationUrl = packData.homepage
      else if (packData.repository?.url) {
        const match = packData.repository.url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/)
        if (match) documentationUrl = `https://github.com/${match[1]}/${match[2]}`
      }

      const enrichedPayload = {
        name,
        version: latestVersion,
        description: packData.description ?? npmData.description,
        author: packData.author,
        links: packData.links ?? {
          npm: `https://www.npmjs.com/package/${name}`,
          repository: githubRepo ? `https://github.com/${githubRepo}` : undefined,
          homepage: packData.homepage,
        },
        date: npmData.time?.[latestVersion] ?? new Date().toISOString(),
        weeklyDownloads,
        githubStars,
        githubSponsorsUrl,
        documentationUrl,
        badges,
        readme,
      }

      // Persist metadata so plugins page can reuse it across route changes/reloads.
      try {
        const cache = loadMetadataCache()
        cache[name] = enrichedPayload
        saveMetadataCache(cache)
      } catch {
        /* ignore cache save errors */
      }

      return enrichedPayload
    } catch (err) {
      log.debug(`Failed to enrich metadata for ${name}: ${err}`)
      return { name }
    }
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
