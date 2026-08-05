export interface PluginManifest {
  name: string
  version: string
  description?: string
  author?: string
  openbridge?: {
    minVersion?: string
  }
}

/** Describes a device's interpolation calibration capability. */
export interface InterpolationDescriptor {
  /** Label for the input (X) axis, e.g. "Room Temperature (C)" */
  inputLabel: string
  /** Label for the output (Y) axis, e.g. "Water Temperature (C)" */
  outputLabel: string
  /** Minimum allowed input value */
  inputMin: number
  /** Maximum allowed input value */
  inputMax: number
  /** Minimum allowed output value */
  outputMin: number
  /** Maximum allowed output value */
  outputMax: number
  /** The key in the device's platform config that holds the mapping array */
  configField: string
  /** Maps generic input/output keys to the config array's property names */
  configShape: { inputKey: string; outputKey: string }
}

/**
 * Describes one time-series a device reports.
 *
 * Storage cannot infer that `power` is instantaneous while `totalForwardEnergy`
 * only ever climbs, and the UI cannot infer that one is watts and the other
 * kilowatt-hours. Declaring them keeps plugins data-only: no plugin ships UI
 * code, and core can chart any device that describes its metrics, including
 * devices from plugins that do not exist yet.
 */
export interface MetricDescriptor {
  /** Matches the key used in reportTelemetry() */
  key: string
  /** Human label, e.g. "Power" */
  label: string
  /** Unit symbol, e.g. "W", "V", "A", "kWh" */
  unit: string
  /**
   * `instant` values are sampled points (power, voltage): rolling them up takes
   * the mean, and the min/max are kept so a spike is not averaged away.
   * `cumulative` values only increase (energy meters): rolling up keeps the last
   * value in the window, and a total over a period is the difference between
   * the window edges.
   */
  kind: 'instant' | 'cumulative'
  /** Decimal places to display. Defaults to 2. */
  precision?: number
  /**
   * Retain min/max when rolling this metric into coarser tiers. Defaults to
   * true for `instant` metrics. Worth disabling for values that barely move
   * (voltage, power factor) to keep coarse tiers narrow.
   */
  trackExtremes?: boolean
}

export interface DeviceDescriptor {
  id: string
  name: string
  /** Maps to a UI widget: 'switch' | 'light' | 'thermostat' | 'dehumidifier' | 'energy_meter' | 'sensor' */
  widgetType: string
  manufacturer?: string
  model?: string
  pluginId: string
  /** If present, this device supports interactive interpolation calibration */
  interpolation?: InterpolationDescriptor
  /**
   * Time-series this device reports. When present, OpenBridge records them to
   * history and can chart them. When absent, the device is still shown live but
   * nothing is stored.
   */
  metrics?: MetricDescriptor[]
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
  /** Latest version available on npm (set by the update checker) */
  availableUpdate?: string
}
