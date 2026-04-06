import { resolve, join } from 'path'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import os from 'os'
import { PluginRegistry, PluginLifecycle, loadPluginsFromDirectory } from '@openbridge/core'
import type { PluginContext, Plugin } from '@openbridge/core'
import { Logger } from '@openbridge/logger'
import { loadConfig, defaultConfigPath } from '@openbridge/config'
import type { OpenBridgeConfig } from '@openbridge/config'
import { createServer, type HapInfo } from './server.js'
import { HomebridgeAPI, loadHomebridgePlugin } from '@openbridge/compatibility-homebridge'

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

export class Daemon {
  private registry = new PluginRegistry()
  private lifecycle = new PluginLifecycle(this.registry)
  private loadedPlugins: Plugin[] = []
  /** npm package names of HB plugins already running via config.platforms — skip in discovery */
  private knownHbPackageNames = new Set<string>()

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
    let hapBridge: any = null
    let homebridgeAPI: HomebridgeAPI | null = null
    let hapInfo: HapInfo | null = null

    if (config.platforms && config.platforms.length > 0) {
      log.info(`Setting up HAP bridge for ${config.platforms.length} platform(s)...`)

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
          throw new Error('hap-nodejs not found. Run: pnpm add hap-nodejs --filter @openbridge/daemon')
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

        // Load each platform plugin
        for (const platformConfig of config.platforms) {
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

        // Launch platforms (instantiate them with config, emit didFinishLaunching)
        const platformLogger = Logger.create('hap')
        await homebridgeAPI.launchPlatforms(config.platforms as any[], platformLogger, this.registry)

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
    }

    // ── OpenBridge native plugins ─────────────────────────────────────────────
    log.info(`Native plugins dir: ${OB_PLUGINS_DIR}`)
    const plugins = await loadPluginsFromDirectory(OB_PLUGINS_DIR)
    log.info(`Loaded ${plugins.length} native plugin(s)`)

    for (const plugin of plugins) {
      this.registry.register(plugin)
    }
    this.loadedPlugins = plugins
    await this.lifecycle.startAll(plugins, (plugin) => this.makeContext(plugin, config))

    // ── Marketplace-installed plugins (discovery) ──────────────────────────────
    this.discoverMarketplacePlugins()

    // ── HTTP server ───────────────────────────────────────────────────────────
    const localPluginSources = config.localPluginSources ?? []
    const server = await createServer(
      this.registry,
      homebridgeAPI,
      hapInfo,
      localPluginSources,
      this.knownHbPackageNames,
    )
    await server.listen({ port, host: '0.0.0.0' })

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

  private discoverMarketplacePlugins() {
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

    for (const pkgName of Object.keys(topLevel)) {
      if (this.registry.get(pkgName)) continue // already in registry by exact name
      if (this.knownHbPackageNames.has(pkgName)) continue // already running via config.platforms

      const pkgJsonPath = join(pluginsRoot, 'node_modules', pkgName, 'package.json')
      if (!existsSync(pkgJsonPath)) continue

      try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
        const name: string = pkg.name ?? pkgName
        const isHb =
          name.startsWith('homebridge-') || (Array.isArray(pkg.keywords) && pkg.keywords.includes('homebridge-plugin'))

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
    return {
      config: pluginConfig,
      log: Logger.create(plugin.manifest.name),
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
