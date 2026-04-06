import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { PluginInstance } from '@/api'

export type InspectorMode = 'plugin' | 'marketplace'

export const useInspectorStore = defineStore('inspector', () => {
  const visible = ref(false)
  const mode = ref<InspectorMode>('plugin')
  const selectedPlugin = ref<PluginInstance | null>(null)

  function openPlugin(plugin: PluginInstance) {
    selectedPlugin.value = plugin
    mode.value = 'plugin'
    visible.value = true
  }

  function openMarketplace() {
    selectedPlugin.value = null
    mode.value = 'marketplace'
    visible.value = true
  }

  function close() {
    visible.value = false
    selectedPlugin.value = null
  }

  return { visible, mode, selectedPlugin, openPlugin, openMarketplace, close }
})
