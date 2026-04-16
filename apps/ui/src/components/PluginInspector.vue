<script setup lang="ts">
import { ref, watch, computed, onMounted, onBeforeUnmount } from 'vue'
import { useInspectorStore } from '@/stores/inspector'
import { api, type LogEntry } from '@/api'
import MonacoJsonEditor from './MonacoJsonEditor.vue'
import PluginConfigForm from './PluginConfigForm.vue'

const restarting = ref(false)

async function restartOpenBridge() {
  if (restarting.value) return
  restarting.value = true
  try {
    await api.daemon.restart()
    let attempts = 0
    const poll = setInterval(async () => {
      attempts++
      try {
        await api.health()
        clearInterval(poll)
        restarting.value = false
      } catch {
        /* still restarting */
      }
      if (attempts > 30) {
        clearInterval(poll)
        restarting.value = false
      }
    }, 1000)
  } catch {
    restarting.value = false
  }
}

const inspector = useInspectorStore()

const statusLabel: Record<string, string> = {
  idle: 'Idle',
  loading: 'Loading',
  running: 'Running',
  stopped: 'Stopped',
  error: 'Error',
}

// ─── Plugin disabled toggle ───────────────────────────────────────────────────
const togglingDisabled = ref(false)

async function togglePluginDisabled() {
  if (!inspector.selectedPlugin || togglingDisabled.value) return
  const newDisabledState = !inspector.selectedPlugin.disabled
  togglingDisabled.value = true
  try {
    const updated = await api.setPluginDisabled(inspector.selectedPlugin.id, newDisabledState)
    inspector.selectedPlugin.disabled = updated.disabled
  } catch (err) {
    console.error('Failed to toggle plugin disabled state:', err)
  } finally {
    togglingDisabled.value = false
  }
}

// ─── Config section ───────────────────────────────────────────────────────────
const pluginInfo = ref<{ mainFile: string; platforms: string[] } | null>(null)
const loadingInfo = ref(false)
const selectedPlatform = ref('')
const configJson = ref('')
const saving = ref(false)
const saveError = ref<string | null>(null)
const saveSuccess = ref(false)

// Visual form editor
const configSchema = ref<Record<string, unknown> | null>(null)
const visualConfig = ref<Record<string, unknown>>({})
const editorMode = ref<'visual' | 'json'>('visual')
const hasVisualSchema = computed(() => configSchema.value?.schema != null)

// Show config editor for ANY homebridge-source plugin (running or stopped)
const isHomebridge = computed(() => inspector.selectedPlugin?.source === 'homebridge')
const isOpenbridge = computed(
  () => inspector.selectedPlugin != null && inspector.selectedPlugin.source !== 'homebridge',
)

// ─── Native plugin config ─────────────────────────────────────────────────────
const nativeConfigJson = ref('')
const nativeSaving = ref(false)
const nativeSaveError = ref<string | null>(null)
const nativeSaveSuccess = ref(false)
const nativeJsonValid = computed(() => {
  try {
    JSON.parse(nativeConfigJson.value)
    return true
  } catch {
    return false
  }
})

watch(
  () => inspector.selectedPlugin,
  async (plugin) => {
    nativeConfigJson.value = ''
    nativeSaveError.value = null
    nativeSaveSuccess.value = false
    if (!plugin || plugin.source === 'homebridge') return
    try {
      const res = await api.config.getPlugin(plugin.manifest.name)
      nativeConfigJson.value = JSON.stringify(res.config ?? {}, null, 2)
    } catch {
      nativeConfigJson.value = '{}'
    }
  },
)

// ─── Live device telemetry ────────────────────────────────────────────────────
const telemetry = ref<Record<string, Record<string, unknown>>>({})
let telemetryTimer: ReturnType<typeof setInterval> | null = null

async function fetchTelemetry() {
  if (!inspector.selectedPlugin || inspector.selectedPlugin.source === 'homebridge') return
  try {
    const res = await api.pluginTelemetry(inspector.selectedPlugin.id)
    telemetry.value = res.telemetry
  } catch {
    /* ignore — device may not have reported yet */
  }
}

watch(
  () => inspector.selectedPlugin,
  (plugin) => {
    telemetry.value = {}
    if (telemetryTimer) {
      clearInterval(telemetryTimer)
      telemetryTimer = null
    }
    if (!plugin || plugin.source === 'homebridge') return
    fetchTelemetry()
    telemetryTimer = setInterval(fetchTelemetry, 3000)
  },
)
onBeforeUnmount(() => {
  if (telemetryTimer) clearInterval(telemetryTimer)
})

const TELEMETRY_LABELS: Record<string, { label: string; unit: string }> = {
  totalForwardEnergy: { label: 'Total energy', unit: 'kWh' },
  temperature: { label: 'Temperature', unit: '°C' },
  leakageCurrent: { label: 'Leakage', unit: 'mA' },
  fault: { label: 'Fault bitmap', unit: '' },
  switchState: { label: 'Breaker', unit: '' },
  voltage: { label: 'Voltage', unit: 'V' },
  current: { label: 'Current', unit: 'A' },
  power: { label: 'Active power', unit: 'W' },
  _updatedAt: { label: '', unit: '' },
}

function formatTelemetryValue(key: string, value: unknown): string {
  if (key === 'switchState') return value ? 'ON' : 'OFF'
  if (key === 'fault') return value === 0 ? 'None' : `0x${(value as number).toString(16)}`
  if (typeof value === 'number') return value.toFixed(key === 'current' ? 3 : 1)
  return String(value)
}

async function saveNativeConfig() {
  if (nativeSaving.value || !inspector.selectedPlugin) return
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(nativeConfigJson.value)
  } catch {
    nativeSaveError.value = 'Invalid JSON — fix the syntax first'
    return
  }
  nativeSaving.value = true
  nativeSaveError.value = null
  nativeSaveSuccess.value = false
  try {
    await api.config.savePlugin(inspector.selectedPlugin.manifest.name, parsed)
    nativeSaveSuccess.value = true
    setTimeout(() => {
      nativeSaveSuccess.value = false
    }, 3000)
  } catch (e) {
    nativeSaveError.value = String(e)
  } finally {
    nativeSaving.value = false
  }
}
const selectedHomebridgePlatformName = computed(() => {
  const plugin = inspector.selectedPlugin
  if (!plugin || plugin.source !== 'homebridge') return ''
  return plugin.platformName ?? plugin.id ?? plugin.manifest.name
})

watch(
  () => inspector.selectedPlugin,
  async (plugin) => {
    pluginInfo.value = null
    selectedPlatform.value = ''
    configJson.value = ''
    configSchema.value = null
    visualConfig.value = {}
    saveError.value = null
    saveSuccess.value = false

    if (!plugin || plugin.source !== 'homebridge') return

    loadingInfo.value = true
    try {
      // Homebridge instances can expose package name in manifest and platform name separately.
      // Always target config by platformName when available.
      const existing = await api.config.getPlatform(selectedHomebridgePlatformName.value)
      if (existing.config) {
        selectedPlatform.value = selectedHomebridgePlatformName.value
        configJson.value = JSON.stringify(existing.config, null, 2)
        visualConfig.value = existing.config as Record<string, unknown>
        await loadSchema(plugin.manifest.name)
        return
      }

      // Not yet configured — probe to discover the platform name.
      if (plugin.status !== 'stopped') return

      const info = await api.pluginInfo(plugin.manifest.name)
      pluginInfo.value = info
      if (info.platforms.length > 0) {
        await selectPlatform(info.platforms[0], info.mainFile)
      }
      await loadSchema(plugin.manifest.name)
    } catch {
      // Probe failed (e.g. plugin not in marketplace dir) — try by name as fallback
      try {
        const existing = await api.config.getPlatform(selectedHomebridgePlatformName.value)
        if (existing.config) {
          selectedPlatform.value = selectedHomebridgePlatformName.value
          configJson.value = JSON.stringify(existing.config, null, 2)
        }
      } catch {
        /* nothing to show */
      }
    } finally {
      loadingInfo.value = false
    }
  },
)

async function loadSchema(pluginName: string) {
  try {
    const res = await fetch(`/api/marketplace/plugin-schema/${encodeURIComponent(pluginName)}`)
    if (res.ok) {
      const data = (await res.json()) as { schema: Record<string, unknown> | null }
      configSchema.value = data.schema
    }
  } catch {
    /* no schema */
  }
}

async function selectPlatform(name: string, mainFile?: string) {
  selectedPlatform.value = name
  try {
    const res = await api.config.getPlatform(name)
    const cfg = res.config ? res.config : { platform: name, plugin: mainFile ?? pluginInfo.value?.mainFile ?? '' }
    configJson.value = JSON.stringify(cfg, null, 2)
    visualConfig.value = cfg as Record<string, unknown>
  } catch {
    const cfg = { platform: name, plugin: mainFile ?? pluginInfo.value?.mainFile ?? '' }
    configJson.value = JSON.stringify(cfg, null, 2)
    visualConfig.value = cfg
  }
}

function onVisualChange(val: Record<string, unknown>) {
  visualConfig.value = val
  // Keep JSON in sync
  configJson.value = JSON.stringify(val, null, 2)
}

function onJsonChange(json: string) {
  configJson.value = json
  // Keep visual in sync
  try {
    visualConfig.value = JSON.parse(json)
  } catch {
    /* invalid JSON */
  }
}

function parseJson(): Record<string, unknown> | null {
  try {
    return JSON.parse(configJson.value)
  } catch {
    return null
  }
}

const jsonValid = computed(() => parseJson() !== null)
const jsonMissingPlatform = computed(() => {
  const p = parseJson()
  return p !== null && typeof p.platform !== 'string'
})

// ─── Per-plugin live logs ──────────────────────────────────────────────────────
const pluginLogs = ref<LogEntry[]>([])
const logsEl = ref<HTMLElement | null>(null)
let logWs: WebSocket | null = null

function connectLogWs() {
  if (logWs) {
    logWs.close()
    logWs = null
  }
  if (!inspector.selectedPlugin) return

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  logWs = new WebSocket(`${protocol}//${location.host}/ws/logs`)
  logWs.onmessage = (e) => {
    try {
      const entry: LogEntry = JSON.parse(e.data as string)
      if (entry.plugin === inspector.selectedPlugin?.id || entry.plugin === inspector.selectedPlugin?.manifest.name) {
        pluginLogs.value = [...pluginLogs.value.slice(-199), entry]
        setTimeout(() => {
          if (logsEl.value) logsEl.value.scrollTop = logsEl.value.scrollHeight
        }, 10)
      }
    } catch {
      /* ignore */
    }
  }
  logWs.onclose = () => {
    if (inspector.selectedPlugin) setTimeout(connectLogWs, 3000)
  }
}

watch(
  () => inspector.selectedPlugin,
  async (plugin) => {
    pluginLogs.value = []
    logWs?.close()
    logWs = null
    if (!plugin) return
    // Load recent history then open live WebSocket
    try {
      const res = await api.logs(plugin.manifest.name, 100)
      pluginLogs.value = res.entries
      setTimeout(() => {
        if (logsEl.value) logsEl.value.scrollTop = logsEl.value.scrollHeight
      }, 20)
    } catch {
      /* ignore */
    }
    connectLogWs()
  },
)
onMounted(() => {
  if (inspector.selectedPlugin) connectLogWs()
})
onBeforeUnmount(() => {
  logWs?.close()
})

const LOG_COLORS: Record<string, string> = {
  debug: '#6b7280',
  info: '#06b6d4',
  warn: '#f59e0b',
  error: '#ef4444',
}

async function save() {
  if (saving.value) return
  const parsed = parseJson()
  if (!parsed) {
    saveError.value = 'Invalid JSON — fix the syntax first'
    return
  }
  if (typeof parsed.platform !== 'string' || !parsed.platform) {
    saveError.value = 'Config must include a "platform" string field'
    return
  }
  saving.value = true
  saveError.value = null
  saveSuccess.value = false
  try {
    await api.config.savePlatform(parsed)
    saveSuccess.value = true
    setTimeout(() => {
      saveSuccess.value = false
    }, 3000)
  } catch (e) {
    saveError.value = String(e)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div v-if="inspector.selectedPlugin" class="inspector">
    <div class="inspector-header">
      <div class="inspector-avatar" :class="inspector.selectedPlugin.status">
        <NbIcon name="puzzle-piece" :size="24" />
      </div>
      <div class="inspector-title">
        <h2 class="inspector-name">{{ inspector.selectedPlugin.manifest.name }}</h2>
        <span class="inspector-version">v{{ inspector.selectedPlugin.manifest.version }}</span>
      </div>
      <NbButton variant="ghost" size="sm" icon="x" @click="inspector.close()" />
    </div>

    <div class="inspector-body">
      <!-- Status -->
      <section class="inspector-section">
        <div class="field-row">
          <span class="field-label">Status</span>
          <span class="status-badge" :class="inspector.selectedPlugin.status">
            {{ statusLabel[inspector.selectedPlugin.status] }}
          </span>
        </div>
        <div v-if="inspector.selectedPlugin.startedAt" class="field-row">
          <span class="field-label">Started</span>
          <span class="field-value">{{ new Date(inspector.selectedPlugin.startedAt).toLocaleString() }}</span>
        </div>
        <div v-if="inspector.selectedPlugin.stoppedAt" class="field-row">
          <span class="field-label">Stopped</span>
          <span class="field-value">{{ new Date(inspector.selectedPlugin.stoppedAt).toLocaleString() }}</span>
        </div>
        <div class="field-row">
          <span class="field-label">Disabled</span>
          <NbSwitch
            :model-value="inspector.selectedPlugin.disabled ?? false"
            :disabled="togglingDisabled"
            @update:model-value="togglePluginDisabled"
          />
        </div>
      </section>

      <!-- ── Platform config editor for all Homebridge-source plugins ───────── -->
      <section v-if="isHomebridge" class="inspector-section setup-section">
        <h3 class="section-heading">
          <NbIcon name="gear" :size="12" />
          Platform config
        </h3>

        <div v-if="loadingInfo" class="setup-loading">
          <NbIcon name="spinner" :size="14" />
          Loading config…
        </div>

        <template v-else>
          <!-- Multiple platforms discovered → tabs -->
          <div v-if="pluginInfo && pluginInfo.platforms.length > 1" class="platform-tabs">
            <button
              v-for="p in pluginInfo.platforms"
              :key="p"
              class="platform-tab"
              :class="{ active: selectedPlatform === p }"
              @click="selectPlatform(p)"
            >
              {{ p }}
            </button>
          </div>

          <!-- No platform detected at all -->
          <div v-else-if="pluginInfo && pluginInfo.platforms.length === 0" class="setup-notice">
            <NbIcon name="info" :size="13" />
            No platform detected. Add a
            <code>platforms[]</code>
            entry manually in Config.
          </div>

          <!-- Visual / JSON tabs -->
          <template v-if="!pluginInfo || pluginInfo.platforms.length > 0">
            <!-- Tab switcher (only shown when schema is available) -->
            <div v-if="hasVisualSchema" class="editor-tabs">
              <button class="editor-tab" :class="{ active: editorMode === 'visual' }" @click="editorMode = 'visual'">
                <NbIcon name="sliders" :size="11" />
                Visual
              </button>
              <button class="editor-tab" :class="{ active: editorMode === 'json' }" @click="editorMode = 'json'">
                <NbIcon name="brackets-curly" :size="11" />
                JSON
              </button>
            </div>

            <!-- Visual form -->
            <div v-if="editorMode === 'visual' && hasVisualSchema" class="visual-editor-wrap">
              <PluginConfigForm
                :hb-schema="configSchema as any"
                :model-value="visualConfig"
                @update:model-value="onVisualChange"
              />
            </div>

            <!-- JSON editor (always shown when no schema, or JSON tab active) -->
            <div
              v-if="editorMode === 'json' || !hasVisualSchema"
              class="config-editor-wrap"
              :class="{ invalid: configJson && !jsonValid }"
            >
              <MonacoJsonEditor :model-value="configJson" :height="220" @update:model-value="onJsonChange" />
              <div v-if="configJson && !jsonValid" class="json-error">Invalid JSON</div>
              <div v-else-if="jsonMissingPlatform" class="json-error">Missing "platform" field</div>
            </div>

            <div v-if="saveError" class="save-error">
              <NbIcon name="warning" :size="13" />
              {{ saveError }}
            </div>

            <div class="setup-actions">
              <NbButton
                variant="primary"
                size="sm"
                :loading="saving"
                :disabled="saving || !jsonValid || jsonMissingPlatform"
                :icon="saveSuccess ? 'check' : 'floppy-disk'"
                @click="save"
              >
                {{ saveSuccess ? 'Saved!' : 'Save config' }}
              </NbButton>
              <NbButton
                v-if="saveSuccess"
                variant="secondary"
                size="sm"
                outlined
                :loading="restarting"
                :icon="restarting ? 'spinner' : 'arrows-clockwise'"
                @click="restartOpenBridge"
              >
                {{ restarting ? 'Restarting…' : 'Restart OpenBridge' }}
              </NbButton>
            </div>
          </template>
        </template>
      </section>

      <!-- ── Plugin config editor for native OpenBridge plugins ───────────── -->
      <section v-if="isOpenbridge" class="inspector-section setup-section">
        <h3 class="section-heading">
          <NbIcon name="gear" :size="12" />
          Plugin config
        </h3>
        <div class="config-editor-wrap" :class="{ invalid: nativeConfigJson && !nativeJsonValid }">
          <MonacoJsonEditor
            :model-value="nativeConfigJson"
            :height="220"
            @update:model-value="nativeConfigJson = $event"
          />
          <div v-if="nativeConfigJson && !nativeJsonValid" class="json-error">Invalid JSON</div>
        </div>
        <div v-if="nativeSaveError" class="save-error">
          <NbIcon name="warning" :size="13" />
          {{ nativeSaveError }}
        </div>
        <div class="setup-actions">
          <NbButton
            variant="primary"
            size="sm"
            :loading="nativeSaving"
            :disabled="nativeSaving || !nativeJsonValid"
            :icon="nativeSaveSuccess ? 'check' : 'floppy-disk'"
            @click="saveNativeConfig"
          >
            {{ nativeSaveSuccess ? 'Saved!' : 'Save config' }}
          </NbButton>
          <NbButton
            v-if="nativeSaveSuccess"
            variant="secondary"
            size="sm"
            outlined
            :loading="restarting"
            :icon="restarting ? 'spinner' : 'arrows-clockwise'"
            @click="restartOpenBridge"
          >
            {{ restarting ? 'Restarting…' : 'Restart OpenBridge' }}
          </NbButton>
        </div>
      </section>

      <!-- ── Live device telemetry (native plugins only) ──────────────────── -->
      <section v-if="isOpenbridge && Object.keys(telemetry).length > 0" class="inspector-section">
        <h3 class="section-heading">
          <NbIcon name="chart-line" :size="12" />
          Live telemetry
        </h3>
        <div v-for="(deviceData, deviceId) in telemetry" :key="deviceId" class="telemetry-device">
          <div class="telemetry-device-id">{{ deviceId }}</div>
          <div class="telemetry-grid">
            <template v-for="(val, key) in deviceData" :key="key">
              <div v-if="key !== '_updatedAt'" class="telemetry-card">
                <span class="telemetry-label">{{ TELEMETRY_LABELS[key]?.label ?? key }}</span>
                <span class="telemetry-value">
                  {{ formatTelemetryValue(String(key), val) }}
                  <span v-if="TELEMETRY_LABELS[key]?.unit" class="telemetry-unit">
                    {{ TELEMETRY_LABELS[key].unit }}
                  </span>
                </span>
              </div>
            </template>
          </div>
          <div v-if="deviceData._updatedAt" class="telemetry-updated">
            Updated {{ new Date(deviceData._updatedAt as string).toLocaleTimeString() }}
          </div>
        </div>
      </section>

      <!-- Manifest -->
      <section class="inspector-section">
        <h3 class="section-heading">Manifest</h3>
        <div class="field-row">
          <span class="field-label">Name</span>
          <span class="field-value">{{ inspector.selectedPlugin.manifest.name }}</span>
        </div>
        <div class="field-row">
          <span class="field-label">Version</span>
          <span class="field-value">{{ inspector.selectedPlugin.manifest.version }}</span>
        </div>
        <div v-if="inspector.selectedPlugin.manifest.description" class="field-row">
          <span class="field-label">Description</span>
          <span class="field-value">{{ inspector.selectedPlugin.manifest.description }}</span>
        </div>
        <div v-if="inspector.selectedPlugin.manifest.author" class="field-row">
          <span class="field-label">Author</span>
          <span class="field-value">{{ inspector.selectedPlugin.manifest.author }}</span>
        </div>
      </section>

      <!-- Error -->
      <section v-if="inspector.selectedPlugin.error" class="inspector-section">
        <h3 class="section-heading">Error</h3>
        <div class="error-box">{{ inspector.selectedPlugin.error }}</div>
      </section>

      <!-- Per-plugin logs -->
      <section v-if="pluginLogs.length > 0" class="inspector-section">
        <h3 class="section-heading">
          <NbIcon name="terminal" :size="12" />
          Recent logs
        </h3>
        <div ref="logsEl" class="plugin-log-terminal">
          <div v-for="(entry, i) in pluginLogs" :key="i" class="plugin-log-line">
            <span class="plog-time">{{ new Date(entry.timestamp).toLocaleTimeString() }}</span>
            <span class="plog-level" :style="{ color: LOG_COLORS[entry.level] }">{{ entry.level.toUpperCase() }}</span>
            <span class="plog-msg">{{ entry.message }}</span>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.inspector {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.inspector-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 1rem 1.1rem;
  border-bottom: 1px solid #f0f0f8;
  flex-shrink: 0;
}

.inspector-avatar {
  width: 42px;
  height: 42px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f0f0f8;
  color: #6b7280;
  flex-shrink: 0;
  &.running {
    background: #d1fae5;
    color: #059669;
  }
  &.error {
    background: #fee2e2;
    color: #dc2626;
  }
  &.loading {
    background: #fef3c7;
    color: #d97706;
  }
}

.inspector-title {
  flex: 1;
  min-width: 0;
}
.inspector-name {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 700;
  color: #111827;
}
.inspector-version {
  font-size: 0.75rem;
  color: #9ca3af;
}

.inspector-body {
  flex: 1;
  overflow-y: auto;
  padding: 1rem 1.1rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.inspector-section {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.section-heading {
  margin: 0 0 0.25rem;
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: #9ca3af;
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

.field-row {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  font-size: 0.83rem;
}
.field-label {
  color: #6b7280;
  width: 80px;
  flex-shrink: 0;
  padding-top: 1px;
}
.field-value {
  color: #111827;
  flex: 1;
  word-break: break-word;
}

.status-badge {
  font-size: 0.72rem;
  font-weight: 700;
  padding: 0.15rem 0.55rem;
  border-radius: 20px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  background: #f3f4f6;
  color: #6b7280;
  &.running {
    background: #d1fae5;
    color: #065f46;
  }
  &.error {
    background: #fee2e2;
    color: #991b1b;
  }
  &.loading {
    background: #fef3c7;
    color: #92400e;
  }
}

.error-box {
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 6px;
  padding: 0.65rem;
  font-size: 0.8rem;
  color: #dc2626;
  font-family: monospace;
}

// ─── Setup / config section ───────────────────────────────────────────────────
.setup-section {
  background: #f9f9fc;
  border: 1px solid #e8e8f0;
  border-radius: 10px;
  padding: 0.9rem;
  gap: 0.75rem;
}

.setup-loading,
.setup-notice {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.8rem;
  color: #6b7280;
  code {
    background: #e8e8f0;
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    font-size: 0.76rem;
  }
}

.editor-tabs {
  display: flex;
  gap: 2px;
  background: #f0f0f8;
  border-radius: 7px;
  padding: 2px;
}
.editor-tab {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.72rem;
  font-weight: 600;
  padding: 0.25rem 0.6rem;
  border-radius: 5px;
  border: none;
  cursor: pointer;
  background: transparent;
  color: #6b7280;
  transition: all 0.12s;
  &.active {
    background: #fff;
    color: #7c3aed;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  }
  &:hover:not(.active) {
    color: #374151;
  }
}

.visual-editor-wrap {
  max-height: 340px;
  overflow-y: auto;
  padding: 0.25rem 0;
}

.platform-tabs {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.platform-tab {
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.25rem 0.65rem;
  border-radius: 6px;
  border: 1.5px solid #e8e8f0;
  cursor: pointer;
  background: #fff;
  color: #6b7280;
  transition: all 0.12s;
  &.active {
    border-color: #7c3aed;
    background: #f0eeff;
    color: #7c3aed;
  }
  &:hover:not(.active) {
    border-color: #c4b5fd;
  }
}

.config-editor-wrap {
  position: relative;
  border: 1.5px solid #374151;
  border-radius: 8px;
  overflow: hidden;
  transition: border-color 0.15s;
  &:focus-within {
    border-color: #7c3aed;
  }
  &.invalid {
    border-color: #fca5a5;
  }
}

.json-error {
  position: absolute;
  bottom: 4px;
  right: 8px;
  font-size: 0.68rem;
  color: #f87171;
  background: rgba(30, 30, 46, 0.85);
  padding: 1px 6px;
  border-radius: 3px;
  pointer-events: none;
}

.save-error {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.78rem;
  color: #dc2626;
}

.setup-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}

// ─── Per-plugin log terminal ──────────────────────────────────────────────────
.plugin-log-terminal {
  background: #0d1117;
  border-radius: 8px;
  padding: 0.6rem 0.75rem;
  max-height: 200px;
  overflow-y: auto;
  font-family: 'MesloLGS NF', monospace;
  font-size: 0.72rem;
  line-height: 1.55;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.plugin-log-line {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
  &:hover {
    background: rgba(255, 255, 255, 0.03);
    border-radius: 3px;
  }
}

.plog-time {
  color: #4b5563;
  flex-shrink: 0;
  font-size: 0.68rem;
}
.plog-level {
  flex-shrink: 0;
  width: 34px;
  font-weight: 700;
  font-size: 0.66rem;
}
.plog-msg {
  color: #c9d1d9;
  flex: 1;
  word-break: break-word;
}

.telemetry-device {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.telemetry-device-id {
  font-size: 0.7rem;
  color: #6b7280;
  font-family: monospace;
  letter-spacing: 0.03em;
}

.telemetry-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
  gap: 8px;
}

.telemetry-card {
  background: #161b22;
  border: 1px solid #21262d;
  border-radius: 8px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.telemetry-label {
  font-size: 0.65rem;
  color: #6b7280;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.telemetry-value {
  font-size: 1rem;
  font-weight: 600;
  color: #e6edf3;
  line-height: 1.2;
}

.telemetry-unit {
  font-size: 0.65rem;
  color: #8b949e;
  font-weight: 400;
  margin-left: 2px;
}

.telemetry-updated {
  font-size: 0.65rem;
  color: #4b5563;
  text-align: right;
}
</style>
