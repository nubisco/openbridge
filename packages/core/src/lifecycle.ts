import type { Plugin, PluginContext } from './types.js'
import type { PluginRegistry } from './registry.js'

export class PluginLifecycle {
  constructor(private registry: PluginRegistry) {}

  async setup(plugin: Plugin, ctx: PluginContext): Promise<void> {
    const id = plugin.manifest.name
    this.registry.updateStatus(id, 'loading')
    try {
      await plugin.setup?.(ctx)
    } catch (err) {
      this.registry.updateStatus(id, 'error', String(err))
      throw err
    }
  }

  async start(plugin: Plugin, ctx: PluginContext): Promise<void> {
    const id = plugin.manifest.name
    try {
      await plugin.start?.(ctx)
      this.registry.updateStatus(id, 'running')
    } catch (err) {
      this.registry.updateStatus(id, 'error', String(err))
      throw err
    }
  }

  async stop(plugin: Plugin, ctx: PluginContext): Promise<void> {
    const id = plugin.manifest.name
    try {
      await plugin.stop?.(ctx)
      this.registry.updateStatus(id, 'stopped')
    } catch (err) {
      this.registry.updateStatus(id, 'error', String(err))
      throw err
    }
  }

  async startAll(plugins: Plugin[], ctxFactory: (plugin: Plugin) => PluginContext): Promise<void> {
    for (const plugin of plugins) {
      const ctx = ctxFactory(plugin)
      await this.setup(plugin, ctx)
      await this.start(plugin, ctx)
    }
  }

  async stopAll(plugins: Plugin[], ctxFactory: (plugin: Plugin) => PluginContext): Promise<void> {
    for (const plugin of [...plugins].reverse()) {
      const ctx = ctxFactory(plugin)
      await this.stop(plugin, ctx)
    }
  }
}
