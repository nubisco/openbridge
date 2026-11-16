import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { PluginInstance, Accessory, DeviceDescriptor } from '@/api'

export type InspectorMode = 'plugin' | 'marketplace' | 'device' | 'house' | 'house-editor'

export type NativeDevice = DeviceDescriptor & { telemetry: Record<string, unknown>; pluginStatus: string }
export type DeviceItem = { kind: 'hap'; acc: Accessory } | { kind: 'native'; dev: NativeDevice }

export const useInspectorStore = defineStore('inspector', () => {
  const visible = ref(false)
  const mode = ref<InspectorMode>('plugin')
  const selectedPlugin = ref<PluginInstance | null>(null)
  const selectedDevice = ref<DeviceItem | null>(null)
  /** The device picked on the House plan, by its plan ref. */
  const houseRef = ref<string | null>(null)

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

  function openHouse(ref: string) {
    houseRef.value = ref
    selectedDevice.value = null
    selectedPlugin.value = null
    mode.value = 'house'
    visible.value = true
  }

  /**
   * The House editor's panels: what is selected on the blueprint, and the
   * devices not on it yet. The editor teleports them into the inspector.
   */
  function openHouseEditor() {
    houseRef.value = null
    selectedDevice.value = null
    selectedPlugin.value = null
    mode.value = 'house-editor'
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
    houseRef.value = null
  }

  return {
    visible,
    mode,
    selectedPlugin,
    selectedDevice,
    houseRef,
    openPlugin,
    openMarketplace,
    openDevice,
    openHouse,
    openHouseEditor,
    updateDevice,
    close,
  }
})
