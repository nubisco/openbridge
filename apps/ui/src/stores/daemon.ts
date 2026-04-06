import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api, type PluginInstance, type LogEntry, type HealthResponse, type Accessory } from '@/api'

export const useDaemonStore = defineStore('daemon', () => {
  const health = ref<HealthResponse | null>(null)
  const plugins = ref<PluginInstance[]>([])
  const accessories = ref<Accessory[]>([])
  const logs = ref<LogEntry[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const connected = ref(false)

  const runningCount = computed(() => plugins.value.filter((p) => p.status === 'running').length)
  const errorCount = computed(() => plugins.value.filter((p) => p.status === 'error').length)

  async function fetchHealth() {
    try {
      health.value = await api.health()
      connected.value = true
      error.value = null
    } catch {
      connected.value = false
      health.value = null
    }
  }

  async function fetchPlugins() {
    loading.value = true
    try {
      const res = await api.plugins()
      plugins.value = res.plugins
    } catch (e) {
      error.value = String(e)
    } finally {
      loading.value = false
    }
  }

  async function fetchAccessories() {
    try {
      const res = await api.accessories()
      accessories.value = res.accessories
    } catch {
      /* daemon might not have HAP */
    }
  }

  async function fetchLogs(plugin?: string) {
    try {
      const res = await api.logs(plugin)
      logs.value = res.entries
    } catch (e) {
      error.value = String(e)
    }
  }

  let ws: WebSocket | null = null

  function connectLiveLogs() {
    if (ws) return
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    ws = new WebSocket(`${protocol}//${location.host}/ws/logs`)
    ws.onmessage = (e) => {
      try {
        const entry: LogEntry = JSON.parse(e.data as string)
        logs.value.push(entry)
        if (logs.value.length > 500) logs.value.shift()
      } catch {
        /* ignore */
      }
    }
    ws.onclose = () => {
      ws = null
      setTimeout(connectLiveLogs, 3000)
    }
  }

  function disconnectLiveLogs() {
    ws?.close()
    ws = null
  }

  return {
    health,
    plugins,
    accessories,
    logs,
    loading,
    error,
    connected,
    runningCount,
    errorCount,
    fetchHealth,
    fetchPlugins,
    fetchAccessories,
    fetchLogs,
    connectLiveLogs,
    disconnectLiveLogs,
  }
})
