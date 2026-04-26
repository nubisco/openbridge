export interface PluginManifest {
  name: string
  version: string
  description?: string
  author?: string
  openbridge?: {
    minVersion?: string
  }
}

export interface DeviceDescriptor {
  id: string
  name: string
  /** Maps to a UI widget: 'switch' | 'light' | 'thermostat' | 'dehumidifier' | 'energy_meter' | 'sensor' */
  widgetType: string
  manufacturer?: string
  model?: string
  pluginId: string
}

export interface PluginContext {
  config: Record<string, unknown>
  log: PluginLogger
  /** Report live telemetry for a device — data appears in the OpenBridge UI */
  reportTelemetry(deviceId: string, data: Record<string, unknown>): void
  /** Register a device so it appears in the OpenBridge devices view */
  registerDevice(device: Omit<DeviceDescriptor, 'pluginId'>): void
  /** Register a command handler so the UI can control a device */
  registerControl(deviceId: string, controlId: string, handler: (value: unknown) => void | Promise<void>): void
  /** Register a HAP bridge so its QR/PIN appear in the OpenBridge UI */
  registerHapBridge(info: { setupURI: string; pincode: string; port: number; name: string }): void
  /** Block a device control from being changed via UI or HomeKit */
  restrictControl(deviceId: string, controlId: string): void
  /**
   * Returns the main HAP bridge so native plugins can add accessories to it
   * instead of creating their own bridge. Returns null if the bridge is not available.
   */
  getHapBridge?(): { bridge: unknown; hap: unknown } | null
}

export interface PluginLogger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
  debug(message: string, ...args: unknown[]): void
}

export interface Plugin {
  manifest: PluginManifest
  setup?(ctx: PluginContext): void | Promise<void>
  start?(ctx: PluginContext): void | Promise<void>
  stop?(ctx: PluginContext): void | Promise<void>
}

export type PluginStatus = 'idle' | 'loading' | 'running' | 'stopped' | 'error'

export interface PluginInstance {
  id: string
  manifest: PluginManifest
  status: PluginStatus
  error?: string
  startedAt?: Date
  stoppedAt?: Date
  source?: 'native' | 'homebridge'
  disabled?: boolean
  platformName?: string
  enrichedMetadata?: Record<string, unknown> // Cached npm metadata (downloads, stars, sponsors, docs url)
  /** Live telemetry keyed by device ID, set via ctx.reportTelemetry() */
  telemetry?: Record<string, Record<string, unknown>>
  /** Registered devices keyed by device ID, set via ctx.registerDevice() */
  devices?: Record<string, DeviceDescriptor>
  /** HAP bridge info if the plugin publishes its own bridge */
  hapBridge?: { setupURI: string; pincode: string; port: number; name: string }
}
