export interface PluginManifest {
  name: string
  version: string
  description?: string
  author?: string
  openbridge?: {
    minVersion?: string
  }
}

export interface PluginContext {
  config: Record<string, unknown>
  log: PluginLogger
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
}
