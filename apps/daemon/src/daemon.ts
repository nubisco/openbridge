import { resolve, join } from 'path'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import os from 'os'
import { PluginRegistry, PluginLifecycle, loadPluginsFromDirectory, loadPlugin } from '@nubisco/openbridge-core'
import type { PluginContext, Plugin, DeviceDescriptor } from '@nubisco/openbridge-core'
import { Logger } from '@nubisco/openbridge-logger'
import { loadConfig, defaultConfigPath } from '@nubisco/openbridge-config'
import type { OpenBridgeConfig } from '@nubisco/openbridge-config'
import { createServer, type HapInfo } from './server.js'
import { HomebridgeAPI, loadHomebridgePlugin } from '@nubisco/openbridge-compatibility-homebridge'

const log = Logger.create('system')
const __dirname = dirname(fileURLToPath(import.meta.url))
const req = createRequire(import.meta.url)

// Canonical storage root — every file OpenBridge owns lives here
export const OPENBRIDGE_HOME = resolve(os.homedir(), '.openbridge')
export const OB_PLUGINS_DIR = join(OPENBRIDGE_HOME, 'plugins', 'openbridge')
export const HB_PLUGINS_DIR = join(OPENBRIDGE_HOME, 'plugins', 'homebridge')

export interface DaemonOptions {
  configPath?: string
  port?: number
}

type ControlHandler = (value: unknown) => void | Promise<void>

export class Daemon {
  private registry = new PluginRegistry()
  private lifecycle = new PluginLifecycle(this.registry)
  private loadedPlugins: Plugin[] = []
  /** npm package names of HB plugins already running via config.platforms — skip in discovery */
  private knownHbPackageNames = new Set<string>()
  private controls = new Map<string, ControlHandler>()

  async start(options: DaemonOptions = {}) {
    const configPath = options.configPath ?? defaultConfigPath()
    log.info('Starting OpenBridge daemon...')
    log.info(`Config: ${configPath}`)

    const config = await loadConfig(configPath)
    Logger.setLevel(config.bridge.logLevel)

    const port = options.port ?? config.bridge.port

    // Ensure canonical storage dirs exist
    mkdirSync(OB_PLUGINS_DIR, { recursive: true })
    mkdirSync(HB_PLUGINS_DIR, { recursive: true })

    log.info(`Bridge name: ${config.bridge.name}`)
    log.info(`HTTP API port: ${port}`)
    log.info(`OpenBridge home: ${OPENBRIDGE_HOME}`)

    // ── HAP Bridge (HomeKit) ──────────────────────────────────────────────────
    // The default bridge is ALWAYS created — it advertises all accessories
    // from both native plugins and Homebridge-compatible platforms.
    let hapBridge: any = null
    let homebridgeAPI: HomebridgeAPI | null = null
    let hapInfo: HapInfo | null = null

    // Load disabled plugins list early — applies to both Homebridge platforms and native plugins
    let disabledPlugins: string[] = []
    try {
      const rawCfg = JSON.parse(readFileSync(configPath, 'utf8'))
      disabledPlugins = (rawCfg.disabledPlugins ?? []) as string[]
    } catch {
      /* config file may not exist yet */
    }

    try {
      // Load hap-nodejs — look in daemon or workspace node_modules
      const hapCandidates = [
        resolve(__dirname, '../node_modules/hap-nodejs'), // apps/daemon/node_modules (from dist/)
        resolve(__dirname, '../../node_modules/hap-nodejs'), // apps/node_modules
        resolve(__dirname, '../../../node_modules/hap-nodejs'), // workspace root node_modules
        resolve(process.cwd(), 'node_modules/hap-nodejs'),
      ]

      let hapNodeJs: any = null
      for (const candidate of hapCandidates) {
        try {
          hapNodeJs = req(candidate)
          log.info(`Loaded hap-nodejs from ${candidate}`)
          break
        } catch {
          /* try next */
        }
      }

      if (!hapNodeJs) {
        throw new Error('hap-nodejs not found. Run: pnpm add hap-nodejs --filter @nubisco/openbridge-daemon')
      }

      // Init HAP storage
      const storagePath = resolve(process.env.HOME ?? '.', '.openbridge', 'hap-storage')
      hapNodeJs.HAPStorage.setCustomStoragePath(storagePath)

      // Create the bridge
      hapBridge = new hapNodeJs.Bridge(config.bridge.name, hapNodeJs.uuid.generate(config.bridge.name))

      hapBridge
        .getService(hapNodeJs.Service.AccessoryInformation)
        .setCharacteristic(hapNodeJs.Characteristic.Manufacturer, 'Nubisco')
        .setCharacteristic(hapNodeJs.Characteristic.Model, 'OpenBridge')
        .setCharacteristic(hapNodeJs.Characteristic.SoftwareRevision, '0.1.0')

      // Create the HomebridgeAPI shim
      homebridgeAPI = new HomebridgeAPI(hapNodeJs, hapBridge)

      // Load Homebridge-compatible platform plugins (if any)
      if (config.platforms && config.platforms.length > 0) {
        // Filter out disabled platforms
        const enabledPlatforms = config.platforms.filter((p) => !disabledPlugins.includes(p.platform as string))
        const skippedPlatforms = config.platforms.filter((p) => disabledPlugins.includes(p.platform as string))

        if (enabledPlatforms.length > 0) {
          log.info(`Loading ${enabledPlatforms.length} Homebridge platform(s)...`)
        }
        for (const p of skippedPlatforms) {
          log.info(`Skipping disabled platform: ${p.platform}`)
        }

        for (const platformConfig of enabledPlatforms) {
          if (!platformConfig.plugin) {
            log.warn(`Platform "${platformConfig.platform}" has no "plugin" path, skipping`)
            continue
          }

          const pluginPath = resolve(platformConfig.plugin as string)
          log.info(`Loading Homebridge plugin: ${pluginPath}`)

          try {
            // Inject version from plugin's package.json if available
            const pkgPath = pluginPath
              .replace(/\/dist\/.*$/, '/package.json')
              .replace(/\/index\.js$/, '/../package.json')
            try {
              const pkg = req(pkgPath)
              ;(platformConfig as any).version = pkg.version
              if (pkg.name) this.knownHbPackageNames.add(pkg.name)
            } catch {
              /* version stays unknown */
            }

            const pluginFn = loadHomebridgePlugin(pluginPath)
            pluginFn(homebridgeAPI as any)
            log.info(`Registered platform: ${platformConfig.platform}`)
          } catch (err) {
            log.error(`Failed to load plugin ${platformConfig.plugin}: ${err}`)
          }
        }

        // Launch only enabled platforms
        const platformLogger = Logger.create('hap')
        await homebridgeAPI.launchPlatforms(enabledPlatforms as any[], platformLogger, this.registry)
      }

      // Publish the HAP bridge
      const hapPort = config.bridge.hapPort ?? 51826
      const pincode = config.bridge.pincode ?? '031-45-154'

      const username = config.bridge.username ?? generateUsername(config.bridge.name)

      hapBridge.publish({
        username,
        pincode,
        port: hapPort,
        category: hapNodeJs.Categories.BRIDGE,
      })

      hapInfo = { setupURI: hapBridge.setupURI(), pincode }
      log.info(`HAP bridge published — PIN: ${pincode}`)
      printPairingInfo(hapInfo.setupURI, pincode)
    } catch (err) {
      log.error(`HAP bridge setup failed: ${err}`)
    }

    // ── OpenBridge native plugins ─────────────────────────────────────────────
    log.info(`Native plugins dir: ${OB_PLUGINS_DIR}`)
    const plugins = await loadPluginsFromDirectory(OB_PLUGINS_DIR)
    log.info(`Loaded ${plugins.length} native plugin(s)`)

    for (const plugin of plugins) {
      this.registry.register(plugin)
    }
    this.loadedPlugins = plugins

    // Mark disabled native plugins
    for (const disabledId of disabledPlugins) {
      const entry = this.registry.get(disabledId)
      if (entry) {
        entry.instance.disabled = true
        this.registry.updateStatus(disabledId, 'stopped')
        log.debug(`Plugin marked as disabled: ${disabledId}`)
      }
    }

    // Only start plugins that are not disabled
    const enabledPlugins = plugins.filter((p) => !disabledPlugins.includes(p.manifest.name))
    await this.lifecycle.startAll(enabledPlugins, (plugin) => this.makeContext(plugin, config))
    await this.discoverMarketplacePlugins(config, disabledPlugins)

    // ── HTTP server ───────────────────────────────────────────────────────────
    const localPluginSources = config.localPluginSources ?? []
    const server = await createServer(
      this.registry,
      homebridgeAPI,
      hapInfo,
      localPluginSources,
      this.knownHbPackageNames,
      this.controls,
    )
    await server.listen({ port, host: '0.0.0.0' })

    // ── Energy history sampling ───────────────────────────────────────────────
    setInterval(
      () => {
        this.sampleEnergyHistory()
      },
      5 * 60 * 1000,
    )
    // Also sample immediately on startup (after a short delay for devices to connect)
    setTimeout(() => this.sampleEnergyHistory(), 30_000)

    log.info(`OpenBridge running at http://localhost:${port}`)

    // ── Graceful shutdown ─────────────────────────────────────────────────────
    const shutdown = async () => {
      log.info('Shutting down...')
      hapBridge?.unpublish()
      await this.lifecycle.stopAll(this.loadedPlugins, (plugin) => this.makeContext(plugin, config))
      await server.close()
      process.exit(0)
    }

    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  }

  private async discoverMarketplacePlugins(config: OpenBridgeConfig, disabledPlugins: string[]) {
    const pluginsRoot = HB_PLUGINS_DIR
    const manifestPath = join(pluginsRoot, 'package.json')
    if (!existsSync(manifestPath)) return

    let topLevel: Record<string, string>
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      topLevel = manifest.dependencies ?? {}
    } catch {
      return
    }

    log.info(`Marketplace deps: ${Object.keys(topLevel).join(', ')}`)

    for (const pkgName of Object.keys(topLevel)) {
      if (this.registry.get(pkgName)) {
        log.info(`Skipping ${pkgName}: already in registry`)
        continue
      }
      if (this.knownHbPackageNames.has(pkgName)) {
        log.info(`Skipping ${pkgName}: known HB package`)
        continue
      }

      const pkgJsonPath = join(pluginsRoot, 'node_modules', pkgName, 'package.json')
      if (!existsSync(pkgJsonPath)) continue

      try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
        const name: string = pkg.name ?? pkgName
        const isNative =
          (Array.isArray(pkg.keywords) && pkg.keywords.includes('openbridge-plugin')) || pkg.openbridge != null
        const isHb =
          name.startsWith('homebridge-') || (Array.isArray(pkg.keywords) && pkg.keywords.includes('homebridge-plugin'))

        // Native OpenBridge plugins — load via the plugin loader and start them
        if (isNative) {
          // Ensure the plugin can resolve peer dependencies (like hap-nodejs) from the daemon's node_modules
          const daemonModules = resolve(__dirname, '../node_modules')
          if (!process.env.NODE_PATH?.includes(daemonModules)) {
            process.env.NODE_PATH = process.env.NODE_PATH ? `${process.env.NODE_PATH}:${daemonModules}` : daemonModules
            // Re-initialize the module resolution paths
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            require('module').Module._initPaths()
          }

          const pluginDir = join(pluginsRoot, 'node_modules', pkgName)
          const candidates = [join(pluginDir, 'dist', 'index.js'), join(pluginDir, 'index.js')]
          log.info(`Native plugin ${name}: looking in ${pluginDir}`)
          log.info(
            `  dist/index.js exists: ${existsSync(candidates[0])}, index.js exists: ${existsSync(candidates[1])}`,
          )
          let loaded = false
          for (const candidate of candidates) {
            if (existsSync(candidate)) {
              try {
                const plugin = await loadPlugin(candidate)
                this.registry.register(plugin)
                this.loadedPlugins.push(plugin)

                // Check if disabled
                if (!disabledPlugins.includes(name)) {
                  await this.lifecycle.startAll([plugin], (p) => this.makeContext(p, config))
                } else {
                  const entry = this.registry.get(name)
                  if (entry) entry.instance.disabled = true
                  this.registry.updateStatus(name, 'stopped')
                }

                log.info(`Loaded native plugin from marketplace: ${name} v${pkg.version ?? '?'}`)
                loaded = true
                break
              } catch (err) {
                log.error(`Failed to load native plugin ${name}: ${err}`)
              }
            }
          }
          if (loaded) continue
        }

        // Homebridge-compatible or unconfigured plugins — register as pseudo-plugin
        const pseudoPlugin: Plugin = {
          manifest: {
            name,
            version: pkg.version ?? '?.?.?',
            description: pkg.description ?? '',
            author: typeof pkg.author === 'string' ? pkg.author : (pkg.author?.name ?? ''),
          },
        }

        const instance = this.registry.register(pseudoPlugin)
        if (isHb) instance.source = 'homebridge'
        this.registry.updateStatus(name, 'stopped')
        log.info(`Discovered marketplace plugin: ${name} v${pkg.version ?? '?'} (not yet configured)`)
      } catch {
        /* skip malformed packages */
      }
    }
  }

  private makeContext(plugin: Plugin, config: OpenBridgeConfig): PluginContext {
    const pluginConfig = config.plugins.find((p) => p.name === plugin.manifest.name)?.config ?? {}
    const registry = this.registry
    const controls = this.controls
    return {
      config: pluginConfig,
      log: Logger.create(plugin.manifest.name),
      reportTelemetry(deviceId: string, data: Record<string, unknown>) {
        const entry = registry.get(plugin.manifest.name)
        if (!entry) return
        if (!entry.instance.telemetry) entry.instance.telemetry = {}
        entry.instance.telemetry[deviceId] = { ...data, _updatedAt: new Date().toISOString() }
      },
      registerDevice(device: Omit<DeviceDescriptor, 'pluginId'>) {
        const entry = registry.get(plugin.manifest.name)
        if (!entry) return
        if (!entry.instance.devices) entry.instance.devices = {}
        entry.instance.devices[device.id] = { ...device, pluginId: plugin.manifest.name }
      },
      registerControl(deviceId: string, controlId: string, handler: ControlHandler) {
        controls.set(`${deviceId}::${controlId}`, handler)
      },
    }
  }

  private sampleEnergyHistory() {
    const historyDir = join(OPENBRIDGE_HOME, 'energy-history')
    mkdirSync(historyDir, { recursive: true })

    for (const instance of this.registry.getAll()) {
      if (!instance.devices) continue
      for (const device of Object.values(instance.devices)) {
        if (device.widgetType !== 'energy_meter') continue
        const energy = instance.telemetry?.[device.id]?.totalForwardEnergy
        if (energy === undefined || energy === null) continue

        const filePath = join(historyDir, `${device.id}.json`)
        let samples: Array<{ t: string; e: number }> = []
        try {
          samples = JSON.parse(readFileSync(filePath, 'utf8'))
        } catch {
          /* start fresh */
        }

        const now = new Date().toISOString()
        samples.push({ t: now, e: Number(energy) })

        // Keep only 2 years of 5-minute samples ≈ 210k entries max
        const cutoff = new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000).toISOString()
        samples = samples.filter((s) => s.t >= cutoff)

        writeFileSync(filePath, JSON.stringify(samples))
      }
    }
  }
}

function generateUsername(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i)
    hash |= 0
  }
  const h = Math.abs(hash).toString(16).padStart(10, '0')
  return `${h[0]}${h[1]}:${h[2]}${h[3]}:${h[4]}${h[5]}:${h[6]}${h[7]}:${h[8]}${h[9]}:AB`
}

function printPairingInfo(setupURI: string, pincode: string): void {
  try {
    const qrcode = req('qrcode-terminal') as { generate: (text: string, opts: object, cb: (s: string) => void) => void }
    qrcode.generate(setupURI, { small: true }, (qr: string) => {
      const border = '─'.repeat(40)
      console.log(`\n\x1b[35m┌${border}┐\x1b[0m`)
      console.log(`\x1b[35m│\x1b[0m  \x1b[1mScan to pair with HomeKit\x1b[0m` + ' '.repeat(13) + `\x1b[35m│\x1b[0m`)
      console.log(`\x1b[35m│\x1b[0m` + ' '.repeat(40) + `\x1b[35m│\x1b[0m`)
      for (const line of qr.split('\n')) {
        const pad = ' '.repeat(Math.max(0, 38 - line.length))
        console.log(`\x1b[35m│\x1b[0m  ${line}${pad}\x1b[35m│\x1b[0m`)
      }
      console.log(`\x1b[35m│\x1b[0m` + ' '.repeat(40) + `\x1b[35m│\x1b[0m`)
      const pinPrefix = '  PIN: '
      const pinPad = ' '.repeat(Math.max(0, 40 - pinPrefix.length - pincode.length))
      console.log(`\x1b[35m│\x1b[0m${pinPrefix}\x1b[1;33m${pincode}\x1b[0m${pinPad}\x1b[35m│\x1b[0m`)
      console.log(`\x1b[35m└${border}┘\x1b[0m\n`)
    })
  } catch {
    // qrcode-terminal not available — fall back to text
    console.log(`\n  HomeKit PIN: \x1b[1;33m${pincode}\x1b[0m`)
    console.log(`  Setup URI:   ${setupURI}\n`)
  }
}
