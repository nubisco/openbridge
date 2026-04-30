/**
 * @nubisco/openbridge-compatibility-homebridge
 *
 * Homebridge API compatibility shim for OpenBridge.
 * Wraps hap-nodejs so Homebridge platform plugins can run inside OpenBridge.
 */

import { EventEmitter } from 'events'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import os from 'os'
import { Logger } from '@nubisco/openbridge-logger'

const hapLog = Logger.create('hap-compat')

const __dirname = dirname(fileURLToPath(import.meta.url))

// Synchronous load — hap-nodejs is CJS
export function loadHapSync(): any {
  const req = createRequire(import.meta.url)
  const candidates = [
    resolve(__dirname, '../../../node_modules/hap-nodejs'),
    resolve(__dirname, '../../../../node_modules/hap-nodejs'),
    resolve(process.cwd(), 'node_modules/hap-nodejs'),
  ]
  for (const candidate of candidates) {
    try {
      return req(candidate)
    } catch {
      /* try next */
    }
  }
  throw new Error('hap-nodejs not found. Run: pnpm add hap-nodejs --filter @nubisco/openbridge-daemon')
}

export let hap: any = null

export function initHap(hapNodeJs: any) {
  hap = hapNodeJs
}

export interface PlatformRegistration {
  pluginName: string
  platformName: string
  Constructor: new (...args: any[]) => any
  dynamic: boolean
}

export interface AccessoryRegistration {
  pluginName: string
  accessoryName: string
  Constructor: new (...args: any[]) => any
}

/**
 * The Homebridge API object passed to plugins.
 * Plugins call: module.exports = function(homebridge) { homebridge.registerPlatform(...) }
 */
/**
 * PlatformAccessory — Homebridge-compatible wrapper around a hap.Accessory.
 *
 * hap-nodejs does NOT export PlatformAccessory; it is a Homebridge construct.
 * Plugins call `new PlatformAccessory(displayName, uuid, category?)` and then
 * use `.getService()`, `.addService()`, `.context`, etc.
 */
function makePlatformAccessoryClass(hapNodeJs: any) {
  const HapAccessory: any = hapNodeJs.Accessory

  class PlatformAccessory extends HapAccessory {
    context: any = {}
    _associatedPlugin?: string
    _associatedPlatform?: string

    constructor(displayName: string, uuid: string, category?: number) {
      super(displayName, uuid)
      if (category !== undefined) {
        this.category = category
      }
    }

    /**
     * Override addService to match Homebridge's behavior:
     * when a plugin calls addService(ServiceType, displayName) without a subtype and a service
     * of the same UUID already exists, automatically use displayName as the subtype.
     * Without this, hap-nodejs throws for accessories with multiple services of the same type
     * (e.g. multiple TemperatureSensor services on a heat-pump accessory).
     */
    addService(serviceType: any, ...args: any[]): any {
      if (typeof serviceType === 'function' && args.length >= 1 && args[1] === undefined) {
        const displayName = args[0]
        const typeUUID: string | undefined = serviceType.UUID
        if (displayName && typeUUID) {
          const hasConflict = (this as any).services?.some((s: any) => s.UUID === typeUUID)
          if (hasConflict) {
            // Use displayName as subtype to allow multiple services of the same type
            return super.addService(serviceType, displayName, displayName)
          }
        }
      }
      return super.addService(serviceType, ...args)
    }
  }

  return PlatformAccessory
}

export class HomebridgeAPI extends EventEmitter {
  hap: any
  platformAccessory: any
  version = '2.6.0'
  serverVersion = '2.6.0'
  user: {
    storagePath: () => string
    configPath: () => string
    persistPath: () => string
    cachedAccessoryPath: () => string
  }

  private _bridge: any
  private _platformRegistrations: PlatformRegistration[] = []
  private _platformInstances: Map<string, any> = new Map()
  private _accessories: Map<string, any> = new Map()
  private _onAccessoryAdd?: (accessory: any) => void
  private _onAccessoryRemove?: (accessory: any) => void
  /** Stored launch configs so platforms can be restarted after failure */
  private _platformLaunchConfigs: Map<string, { config: PlatformConfig; log: any; registry?: any }> = new Map()
  /** Tracks consecutive restart failures per platform for exponential backoff */
  private _platformRestartAttempts: Map<string, number> = new Map()
  /** Tracks last error time per platform to detect recurring failures */
  private _platformLastError: Map<string, number> = new Map()

  constructor(hapNodeJs: any, bridge: any) {
    super()
    this._bridge = bridge

    // User storage paths (Homebridge plugins call api.user.storagePath(), etc.)
    const storageBase = resolve(os.homedir(), '.openbridge')
    this.user = {
      storagePath: () => storageBase,
      configPath: () => resolve(storageBase, 'config.json'),
      persistPath: () => resolve(storageBase, 'persist'),
      cachedAccessoryPath: () => resolve(storageBase, 'accessories'),
    }

    this.hap = hapNodeJs
    // Build PlatformAccessory from the hap.Accessory base class
    this.platformAccessory = makePlatformAccessoryClass(hapNodeJs)

    // Alias for plugins that access api.hap.Accessory.Categories
    if (!this.hap.Accessory) {
      this.hap.Accessory = { Categories: hapNodeJs.Categories }
    } else if (!this.hap.Accessory.Categories) {
      this.hap.Accessory.Categories = hapNodeJs.Categories
    }

    // Some plugins use api.hap.uuid
    if (!this.hap.uuid) {
      this.hap.uuid = hapNodeJs.uuid
    }
  }

  onAccessoryAdd(fn: (accessory: any) => void) {
    this._onAccessoryAdd = fn
  }

  onAccessoryRemove(fn: (accessory: any) => void) {
    this._onAccessoryRemove = fn
  }

  /**
   * Called by plugins in two forms:
   *   4-arg: registerPlatform(pluginName, platformName, Constructor, dynamic)
   *   2-arg: registerPlatform(platformName, Constructor, dynamic?)
   */
  registerPlatform(...args: any[]) {
    let pluginName: string
    let platformName: string
    let Constructor: new (...args: any[]) => any
    let dynamic: boolean

    if (typeof args[0] === 'string' && typeof args[1] === 'string') {
      // 4-arg form: (pluginName, platformName, Constructor, dynamic)
      ;[pluginName, platformName, Constructor, dynamic = false] = args
    } else {
      // 2-arg form: (platformName, Constructor, dynamic?)
      pluginName = args[0]
      platformName = args[0]
      Constructor = args[1]
      dynamic = args[2] ?? false
    }

    this._platformRegistrations.push({ pluginName, platformName, Constructor, dynamic })
  }

  /**
   * Called by plugins: homebridge.registerAccessory(pluginName, accessoryName, Constructor)
   */
  registerAccessory(_pluginName: string, _accessoryName: string, _Constructor: new (...args: any[]) => any) {
    // TODO: implement accessory (non-platform) registration
  }

  /**
   * Called by platform instances to add accessories to the bridge.
   * api.registerPlatformAccessories(pluginName, platformName, [accessory, ...])
   */
  registerPlatformAccessories(_pluginName: string, _platformName: string, accessories: any | any[]) {
    const arr = Array.isArray(accessories) ? accessories : [accessories]
    hapLog.info(`registerPlatformAccessories: adding ${arr.length} accessory(ies)`)
    for (const acc of arr) {
      try {
        if (!acc?.UUID) {
          hapLog.warn(`  skipped accessory with no UUID: ${acc?.displayName}`)
          continue
        }
        hapLog.info(`  + ${acc.displayName} (UUID: ${acc.UUID})`)
        acc._associatedPlatform = _platformName
        this._accessories.set(acc.UUID, acc)
        if (this._bridge) {
          try {
            this._bridge.addBridgedAccessory(acc)
          } catch (bridgeErr) {
            hapLog.warn(`  bridge.addBridgedAccessory failed (non-fatal): ${bridgeErr}`)
          }
        }
        this._onAccessoryAdd?.(acc)
      } catch (err) {
        hapLog.error(`  ✗ failed to register ${acc?.displayName}: ${err}`)
      }
    }
  }

  /**
   * Called by some platform plugins to publish accessories as standalone (not bridged).
   * In real Homebridge these get their own HAP server, but OpenBridge funnels
   * everything through a single bridge so we add them as bridged accessories.
   */
  publishExternalAccessories(_pluginName: string, accessories: any | any[]) {
    const arr = Array.isArray(accessories) ? accessories : [accessories]
    hapLog.info(`publishExternalAccessories: adding ${arr.length} accessory(ies)`)
    for (const acc of arr) {
      try {
        if (!acc?.UUID) {
          hapLog.warn(`  skipped accessory with no UUID: ${acc?.displayName}`)
          continue
        }
        hapLog.info(`  + ${acc.displayName} (UUID: ${acc.UUID})`)
        acc._associatedPlatform = _pluginName
        this._accessories.set(acc.UUID, acc)
        if (this._bridge) {
          try {
            this._bridge.addBridgedAccessory(acc)
          } catch (bridgeErr) {
            hapLog.warn(`  bridge.addBridgedAccessory failed (non-fatal): ${bridgeErr}`)
          }
        }
        this._onAccessoryAdd?.(acc)
      } catch (err) {
        hapLog.error(`  failed to publish ${acc?.displayName}: ${err}`)
      }
    }
  }

  /**
   * Returns whether the running Homebridge version is >= the given semver string.
   * We always return false (we are not Homebridge), which disables optional features
   * like Adaptive Lighting that check for minimum versions.
   */
  versionGreaterOrEqual(_version: string): boolean {
    return false
  }

  getRawAccessories(): any[] {
    return Array.from(this._accessories.values())
  }

  getAccessories(): SerializedAccessory[] {
    hapLog.debug(`getAccessories called — map has ${this._accessories.size} entries`)
    return Array.from(this._accessories.values()).map(serializeAccessory)
  }

  /**
   * Called by platform instances to remove accessories.
   */
  unregisterPlatformAccessories(_pluginName: string, _platformName: string, accessories: any[]) {
    for (const acc of accessories) {
      this._accessories.delete(acc.UUID)
      try {
        this._bridge.removeBridgedAccessory(acc, false)
      } catch {
        /* ignore if not found */
      }
      this._onAccessoryRemove?.(acc)
    }
  }

  getPlatformRegistrations(): PlatformRegistration[] {
    return [...this._platformRegistrations]
  }

  /**
   * Instantiate all registered platforms with the given config entries.
   * registry is optional — if provided, each platform is registered as a
   * PluginInstance so it appears in the OpenBridge UI plugins page.
   */
  async launchPlatforms(configs: PlatformConfig[], log: any, registry?: any): Promise<void> {
    for (const reg of this._platformRegistrations) {
      const config = configs.find((c) => c.platform === reg.platformName)
      if (!config) {
        log.warn(`No config found for platform "${reg.platformName}", skipping`)
        continue
      }

      // Register as a plugin instance so the UI shows it, marked as homebridge source
      if (registry) {
        const pseudoPlugin = {
          manifest: {
            name: reg.pluginName,
            version: (config.version as string | undefined) ?? '?.?.?',
            description: `Platform: ${reg.platformName}`,
            author: 'homebridge-compat',
          },
          setup: undefined,
          start: undefined,
          stop: undefined,
        }
        const instance = registry.register(pseudoPlugin, reg.platformName)
        instance.source = 'homebridge'
        instance.platformName = reg.platformName
        registry.updateStatus(instance.id, 'loading')
      }

      try {
        // Give each platform its own named logger so log entries carry plugin: platformName
        const platformLog = createPlatformLogger(Logger.create(reg.platformName), reg.platformName)
        const instance = new reg.Constructor(platformLog, config, this)
        this._platformInstances.set(reg.platformName, instance)
        log.info(`Platform "${reg.platformName}" instantiated`)

        // Dynamic platforms implement configureAccessory() to re-adopt cached accessories.
        // Feed any existing accessories for this platform back to the new instance.
        if (typeof instance.configureAccessory === 'function') {
          const cached = Array.from(this._accessories.values()).filter(
            (acc: any) => acc._associatedPlatform === reg.platformName,
          )
          for (const acc of cached) {
            try {
              instance.configureAccessory(acc)
            } catch (err) {
              hapLog.warn(`configureAccessory failed for ${acc.displayName}: ${err}`)
            }
          }
          if (cached.length > 0) {
            hapLog.info(`Restored ${cached.length} cached accessory(ies) for "${reg.platformName}"`)
          }
        }

        registry?.updateStatus(reg.platformName, 'running')

        // Store launch config so we can restart the platform if it fails later
        this._platformLaunchConfigs.set(reg.platformName, { config, log, registry })
        this._platformRestartAttempts.set(reg.platformName, 0)
      } catch (err) {
        log.error(`Platform "${reg.platformName}" failed to start: ${err}`)
        registry?.updateStatus(reg.platformName, 'error', String(err))
      }
    }

    // Signal that all plugins have loaded — platforms listen for this
    hapLog.info('Emitting didFinishLaunching — platforms should start device discovery')
    this.emit('didFinishLaunching')
  }

  /**
   * Restart a platform that has failed. Removes old accessories,
   * re-instantiates the platform, and re-emits didFinishLaunching.
   */
  async restartPlatform(platformName: string): Promise<boolean> {
    const reg = this._platformRegistrations.find((r) => r.platformName === platformName)
    const launchConfig = this._platformLaunchConfigs.get(platformName)
    if (!reg || !launchConfig) {
      hapLog.warn(`Cannot restart platform "${platformName}": no registration or config found`)
      return false
    }

    const { config, registry } = launchConfig
    const attempts = (this._platformRestartAttempts.get(platformName) ?? 0) + 1
    this._platformRestartAttempts.set(platformName, attempts)

    hapLog.info(`Restarting platform "${platformName}" (attempt ${attempts})...`)
    registry?.updateStatus(platformName, 'loading')

    // Remove old accessories registered by this platform
    const oldInstance = this._platformInstances.get(platformName)
    if (oldInstance) {
      const toRemove: any[] = []
      for (const [_uuid, acc] of this._accessories.entries()) {
        if (acc._associatedPlatform === platformName) {
          toRemove.push(acc)
        }
      }
      for (const acc of toRemove) {
        this._accessories.delete(acc.UUID)
        try {
          this._bridge?.removeBridgedAccessory(acc, false)
        } catch {
          /* ignore */
        }
      }
      hapLog.info(`  Removed ${toRemove.length} stale accessory(ies)`)
    }

    try {
      const platformLog = createPlatformLogger(Logger.create(reg.platformName), reg.platformName)
      const instance = new reg.Constructor(platformLog, config, this)
      this._platformInstances.set(platformName, instance)

      // Re-emit didFinishLaunching so the new instance starts discovery
      this.emit('didFinishLaunching')

      hapLog.info(`Platform "${platformName}" restarted successfully`)
      registry?.updateStatus(platformName, 'running')
      this._platformRestartAttempts.set(platformName, 0)
      return true
    } catch (err) {
      hapLog.error(`Platform "${platformName}" restart failed: ${err}`)
      registry?.updateStatus(platformName, 'error', String(err))
      return false
    }
  }

  /**
   * Returns the backoff delay (ms) for the next restart attempt of a platform.
   * Exponential: 30s, 60s, 120s, 240s, capped at 5 minutes.
   */
  getRestartBackoff(platformName: string): number {
    const attempts = this._platformRestartAttempts.get(platformName) ?? 0
    return Math.min(30_000 * Math.pow(2, attempts), 5 * 60_000)
  }

  getPlatformInstances(): Map<string, any> {
    return this._platformInstances
  }
}

export interface PlatformConfig {
  platform: string
  [key: string]: unknown
}

function createPlatformLogger(baseLog: any, platformName: string) {
  const prefix = `[${platformName}]`
  // Homebridge platform logger is a callable function with .info/.warn/.error/.log methods
  const fn = (message: string, ...args: unknown[]) => baseLog.info(`${prefix} ${message}`, ...args)
  fn.info = (message: string, ...args: unknown[]) => baseLog.info(`${prefix} ${message}`, ...args)
  fn.warn = (message: string, ...args: unknown[]) => baseLog.warn(`${prefix} ${message}`, ...args)
  fn.error = (message: string, ...args: unknown[]) => baseLog.error(`${prefix} ${message}`, ...args)
  fn.debug = (message: string, ...args: unknown[]) => baseLog.debug(`${prefix} ${message}`, ...args)
  // Generic log(level, message, ...args) — used by some plugins (e.g. homebridge-shelly-ds9)
  fn.log = (level: string, message: string, ...args: unknown[]) => {
    const method = (fn as any)[level] ?? fn.info
    method(message, ...args)
  }
  // success is treated as info in some plugins
  fn.success = (message: string, ...args: unknown[]) => baseLog.info(`${prefix} ${message}`, ...args)
  return fn
}

export interface SerializedCharacteristic {
  uuid: string
  name: string
  value: unknown
  format: string
  perms: string[]
}

export interface SerializedService {
  uuid: string
  name: string
  displayName: string
  characteristics: SerializedCharacteristic[]
}

export interface SerializedAccessory {
  uuid: string
  displayName: string
  category: number
  services: SerializedService[]
  reachable: boolean
}

// Map HAP service UUIDs to accessory categories. Used to infer the category
// when a plugin doesn't explicitly set one (many Homebridge plugins don't).
const SERVICE_UUID_TO_CATEGORY: Record<string, number> = {
  '00000043-0000-1000-8000-0026BB765291': 5, // Lightbulb
  '00000040-0000-1000-8000-0026BB765291': 3, // Fan / Fanv2
  '000000B7-0000-1000-8000-0026BB765291': 3, // Fanv2
  '00000041-0000-1000-8000-0026BB765291': 4, // GarageDoorOpener
  '00000045-0000-1000-8000-0026BB765291': 6, // LockMechanism
  '00000047-0000-1000-8000-0026BB765291': 7, // Outlet
  '00000049-0000-1000-8000-0026BB765291': 8, // Switch
  '0000004A-0000-1000-8000-0026BB765291': 9, // Thermostat
  '00000080-0000-1000-8000-0026BB765291': 10, // ContactSensor
  '00000082-0000-1000-8000-0026BB765291': 10, // HumiditySensor
  '00000083-0000-1000-8000-0026BB765291': 10, // LeakSensor
  '00000084-0000-1000-8000-0026BB765291': 10, // LightSensor
  '00000085-0000-1000-8000-0026BB765291': 10, // MotionSensor
  '00000086-0000-1000-8000-0026BB765291': 10, // OccupancySensor
  '0000008A-0000-1000-8000-0026BB765291': 10, // TemperatureSensor
  '0000007E-0000-1000-8000-0026BB765291': 11, // SecuritySystem
  '00000081-0000-1000-8000-0026BB765291': 12, // Door
  '0000008B-0000-1000-8000-0026BB765291': 13, // Window
  '0000008C-0000-1000-8000-0026BB765291': 14, // WindowCovering
  '000000BB-0000-1000-8000-0026BB765291': 19, // AirPurifier
  '000000BC-0000-1000-8000-0026BB765291': 20, // HeaterCooler
  '000000BD-0000-1000-8000-0026BB765291': 22, // HumidifierDehumidifier
  '000000D0-0000-1000-8000-0026BB765291': 32, // Television
}

function inferCategoryFromServices(acc: any): number {
  try {
    for (const svc of acc.services ?? []) {
      const cat = SERVICE_UUID_TO_CATEGORY[svc.UUID]
      if (cat !== undefined) return cat
    }
  } catch {
    /* ignore */
  }
  return 1 // OTHER
}

function serializeAccessory(acc: any): SerializedAccessory {
  const services: SerializedService[] = []

  try {
    for (const svc of acc.services ?? []) {
      const characteristics: SerializedCharacteristic[] = []
      for (const ch of svc.characteristics ?? []) {
        try {
          characteristics.push({
            uuid: ch.UUID,
            name: ch.constructor?.name ?? ch.displayName ?? ch.UUID,
            value: ch.value,
            format: ch.props?.format ?? 'unknown',
            perms: ch.props?.perms ?? [],
          })
        } catch {
          /* skip bad characteristic */
        }
      }
      services.push({
        uuid: svc.UUID,
        name: svc.constructor?.name ?? svc.displayName ?? svc.UUID,
        displayName: svc.displayName ?? '',
        characteristics,
      })
    }
  } catch {
    /* skip bad service */
  }

  // Use the explicit category if set and not OTHER (1), otherwise infer from services
  const explicitCategory = acc.category ?? 1
  const category = explicitCategory !== 1 ? explicitCategory : inferCategoryFromServices(acc)

  return {
    uuid: acc.UUID,
    displayName: acc.displayName,
    category,
    services,
    reachable: acc.reachable !== false,
  }
}

/**
 * Load a Homebridge-compatible plugin from a file path.
 * Plugins use CommonJS: module.exports = function(homebridge) { ... }
 */
export function loadHomebridgePlugin(pluginPath: string): (homebridge: HomebridgeAPI) => void {
  const req = createRequire(import.meta.url)
  const mod = req(pluginPath)
  const fn = mod.default ?? mod
  if (typeof fn !== 'function') {
    throw new Error(`Homebridge plugin at ${pluginPath} must export a function`)
  }
  return fn as (homebridge: HomebridgeAPI) => void
}
