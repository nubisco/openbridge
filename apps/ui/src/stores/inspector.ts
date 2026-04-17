import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { PluginInstance, Accessory, DeviceDescriptor } from '@/api'

export type InspectorMode = 'plugin' | 'marketplace' | 'device'

export type NativeDevice = DeviceDescriptor & { telemetry: Record<string, unknown>; pluginStatus: string }
export type DeviceItem = { kind: 'hap'; acc: Accessory } | { kind: 'native'; dev: NativeDevice }

export const useInspectorStore = defineStore('inspector', () => {
  const visible = ref(false)
  const mode = ref<InspectorMode>('plugin')
  const selectedPlugin = ref<PluginInstance | null>(null)
  const selectedDevice = ref<DeviceItem | null>(null)

  function openPlugin(plugin: PluginInstance) {
    selectedPlugin.value = plugin
    selectedDevice.value = null
    mode.value = 'plugin'
    visible.value = true
  }

  function openMarketplace() {
    selectedPlugin.value = null
    selectedDevice.value = null
    mode.value = 'marketplace'
    visible.value = true
  }

  function openDevice(device: DeviceItem) {
    selectedDevice.value = device
    selectedPlugin.value = null
    mode.value = 'device'
    visible.value = true
  }

  function updateDevice(device: DeviceItem) {
    if (selectedDevice.value && mode.value === 'device') {
      if (device.kind === 'native' && selectedDevice.value.kind === 'native') {
        if (device.dev.id === selectedDevice.value.dev.id) {
          selectedDevice.value = device
        }
      } else if (device.kind === 'hap' && selectedDevice.value.kind === 'hap') {
        if (device.acc.uuid === selectedDevice.value.acc.uuid) {
          selectedDevice.value = device
        }
      }
    }
  }

  function close() {
    visible.value = false
    selectedPlugin.value = null
    selectedDevice.value = null
  }

  return { visible, mode, selectedPlugin, selectedDevice, openPlugin, openMarketplace, openDevice, updateDevice, close }
})
