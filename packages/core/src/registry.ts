import type { Plugin, PluginInstance, PluginStatus } from './types.js'

export class PluginRegistry {
  private plugins = new Map<string, { plugin: Plugin; instance: PluginInstance }>()

  register(plugin: Plugin, instanceId?: string): PluginInstance {
    const id = instanceId ?? plugin.manifest.name
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

  unregister(id: string): boolean {
    return this.plugins.delete(id)
  }

  unregisterWhere(predicate: (instance: PluginInstance) => boolean): number {
    let removed = 0
    for (const [id, entry] of this.plugins.entries()) {
      if (predicate(entry.instance)) {
        this.plugins.delete(id)
        removed++
      }
    }
    return removed
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
