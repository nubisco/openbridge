// Re-export core types for plugin authors
export type { Plugin, PluginManifest, PluginContext, PluginLogger } from '@openbridge/core'

// Helper to define a plugin with type safety
export function definePlugin(plugin: import('@openbridge/core').Plugin): import('@openbridge/core').Plugin {
  return plugin
}
