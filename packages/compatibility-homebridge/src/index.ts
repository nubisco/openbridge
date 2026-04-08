/**
 * @openbridge/compatibility-homebridge
 *
 * Homebridge API compatibility shim for OpenBridge.
 * Wraps hap-nodejs so Homebridge platform plugins can run inside OpenBridge.
 */

import { EventEmitter } from 'events'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import os from 'os'
import { Logger } from '@openbridge/logger'

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
  throw new Error('hap-nodejs not found. Run: pnpm add hap-nodejs --filter @openbridge/daemon')
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
          hapLog.warn(`  ⚠ skipped accessory with no UUID: ${acc?.displayName}`)
          continue
        }
        hapLog.info(`  + ${acc.displayName} (UUID: ${acc.UUID})`)
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
   * We treat them the same as bridged accessories for OpenBridge purposes.
   */
  publishExternalAccessories(_pluginName: string, accessories: any | any[]) {
    const arr = Array.isArray(accessories) ? accessories : [accessories]
    hapLog.info(`publishExternalAccessories: adding ${arr.length} accessory(ies)`)
    for (const acc of arr) {
      try {
        if (!acc?.UUID) continue
        hapLog.info(`  + ${acc.displayName} (UUID: ${acc.UUID})`)
        this._accessories.set(acc.UUID, acc)
        this._onAccessoryAdd?.(acc)
      } catch (err) {
        hapLog.error(`  ✗ failed to publish ${acc?.displayName}: ${err}`)
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
        registry?.updateStatus(reg.platformName, 'running')
      } catch (err) {
        log.error(`Platform "${reg.platformName}" failed to start: ${err}`)
        registry?.updateStatus(reg.platformName, 'error', String(err))
      }
    }

    // Signal that all plugins have loaded — platforms listen for this
    hapLog.info('Emitting didFinishLaunching — platforms should start device discovery')
    this.emit('didFinishLaunching')
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

  return {
    uuid: acc.UUID,
    displayName: acc.displayName,
    category: acc.category ?? 1,
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
