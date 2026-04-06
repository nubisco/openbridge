import type { Plugin, PluginInstance, PluginStatus } from './types.js'

export class PluginRegistry {
  private plugins = new Map<string, { plugin: Plugin; instance: PluginInstance }>()

  register(plugin: Plugin): PluginInstance {
    const id = plugin.manifest.name
    const instance: PluginInstance = {
      id,
      manifest: plugin.manifest,
      status: 'idle',
    }
    this.plugins.set(id, { plugin, instance })
    return instance
  }

  get(id: string) {
    return this.plugins.get(id)
  }

  getAll(): PluginInstance[] {
    return Array.from(this.plugins.values()).map((e) => e.instance)
  }

  updateStatus(id: string, status: PluginStatus, error?: string) {
    const entry = this.plugins.get(id)
    if (!entry) return
    entry.instance.status = status
    if (error) entry.instance.error = error
    if (status === 'running') entry.instance.startedAt = new Date()
    if (status === 'stopped') entry.instance.stoppedAt = new Date()
  }
}
