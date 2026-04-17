// ─── Core plugin types ───────────────────────────────────────────────────────
export type { Plugin, PluginManifest, PluginContext, PluginLogger, DeviceDescriptor } from '@nubisco/openbridge-core'

// ─── HAP types for accessory development ─────────────────────────────────────
// Re-exported from hap-nodejs so plugin authors don't need a direct dependency.
export type { Service, Characteristic, CharacteristicValue, WithUUID, Categories } from 'hap-nodejs'
export { Accessory } from 'hap-nodejs'

import type { Accessory, Service as HAPService } from 'hap-nodejs'

/**
 * Extended accessory with context storage and subtype service lookup.
 * This mirrors the Homebridge PlatformAccessory interface so plugins
 * can work with both OpenBridge and Homebridge.
 */
export interface PlatformAccessory extends Accessory {
  context: Record<string, unknown>
  getServiceByUUIDAndSubType(uuid: HAPService | string, subtype: string): HAPService | undefined
  configureController(controller: unknown): void
}

/**
 * Logger interface for plugin use.
 * Compatible with both OpenBridge's PluginLogger and Homebridge's Logger.
 */
export interface Logger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
  debug(message: string, ...args: unknown[]): void
  log?(level: string, message: string, ...args: unknown[]): void
  success?(message: string, ...args: unknown[]): void
}

/**
 * API shim interface for platform plugins.
 * Provides the HAP surface that platform plugins need to register accessories.
 */
export interface API {
  hap: typeof import('hap-nodejs')
  on(event: string, listener: (...args: unknown[]) => void): void
  emit(event: string, ...args: unknown[]): void
  registerPlatformAccessories(pluginName: string, platformName: string, accessories: unknown[]): void
  unregisterPlatformAccessories(pluginName: string, platformName: string, accessories: unknown[]): void
  platformAccessory: unknown
  user: {
    storagePath(): string
    configPath(): string
    persistPath(): string
    cachedAccessoryPath(): string
  }
  versionGreaterOrEqual?(version: string): boolean
}

// ─── Helper ──────────────────────────────────────────────────────────────────

/** Define a plugin with type safety */
export function definePlugin(
  plugin: import('@nubisco/openbridge-core').Plugin,
): import('@nubisco/openbridge-core').Plugin {
  return plugin
}
