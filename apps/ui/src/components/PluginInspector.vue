<template>
  <div v-if="inspector.selectedPlugin" class="inspector nb-inspector">
    <div class="inspector-header">
      <div class="inspector-avatar" :class="inspector.selectedPlugin.status">
        <NbIcon name="puzzle-piece" :size="24" />
      </div>
      <div class="inspector-title">
        <h2 class="inspector-name">{{ inspector.selectedPlugin.manifest.name }}</h2>
        <span class="inspector-version">v{{ inspector.selectedPlugin.manifest.version }}</span>
      </div>
    </div>

    <div class="inspector-body">
      <NbShellPanel v-model:size="sections.status" title="Status" fluid>
        <NbField label="Status" control="fit">
          <span class="status-badge" :class="inspector.selectedPlugin.status">
            {{ statusLabel[inspector.selectedPlugin.status] }}
          </span>
        </NbField>
        <NbField v-if="inspector.selectedPlugin.startedAt" label="Started" control="fit">
          <span class="field-value">{{ new Date(inspector.selectedPlugin.startedAt).toLocaleString() }}</span>
        </NbField>
        <NbField v-if="inspector.selectedPlugin.stoppedAt" label="Stopped" control="fit">
          <span class="field-value">{{ new Date(inspector.selectedPlugin.stoppedAt).toLocaleString() }}</span>
        </NbField>
        <NbField label="Disabled" control="fit">
          <NbSwitch
            :model-value="inspector.selectedPlugin.disabled ?? false"
            :disabled="togglingDisabled"
            @update:model-value="togglePluginDisabled"
          />
        </NbField>
      </NbShellPanel>

      <!-- ── HAP Bridge (if plugin publishes its own bridge) ───────────────── -->
      <NbShellPanel v-if="inspector.selectedPlugin.hapBridge" v-model:size="sections.hap" title="HomeKit pairing" fluid>
        <div class="hap-bridge-info">
          <div class="hap-qr">
            <img v-if="pluginQrUrl" :src="pluginQrUrl" alt="HomeKit QR Code" class="hap-qr-img" />
          </div>
          <div class="hap-details">
            <NbField label="PIN" control="fit">
              <span class="field-value mono">{{ inspector.selectedPlugin.hapBridge.pincode }}</span>
            </NbField>
            <NbField label="Port" control="fit">
              <span class="field-value">{{ inspector.selectedPlugin.hapBridge.port }}</span>
            </NbField>
            <NbField label="Bridge" control="fit">
              <span class="field-value">{{ inspector.selectedPlugin.hapBridge.name }}</span>
            </NbField>
          </div>
        </div>
        <p class="hap-hint">Scan with the Home app or enter the PIN manually to pair this plugin's devices.</p>
      </NbShellPanel>

      <!-- ── Update available ──────────────────────────────────────────────── -->
      <NbShellPanel v-if="inspector.selectedPlugin.availableUpdate" v-model:size="sections.update" title="Update" fluid>
        <div class="update-banner">
          <div class="update-banner-text">
            <NbIcon name="arrow-circle-up" :size="14" />
            <span>
              Version
              <strong>{{ inspector.selectedPlugin.availableUpdate }}</strong>
              is available (current: {{ inspector.selectedPlugin.manifest.version }})
            </span>
          </div>
          <NbButton variant="primary" size="sm" :loading="updating" :disabled="updating" @click="updatePlugin">
            {{ updating ? 'Updating...' : 'Update' }}
          </NbButton>
        </div>
      </NbShellPanel>

      <!-- ── Remove plugin ─────────────────────────────────────────────────── -->
      <NbShellPanel v-model:size="sections.manage" title="Manage" fluid>
        <NbButton
          v-if="!confirmingRemove"
          variant="ghost"
          size="sm"
          icon="trash"
          style="color: var(--nb-c-danger)"
          @click="confirmingRemove = true"
        >
          Remove plugin
        </NbButton>
        <div v-else class="remove-confirm">
          <p class="remove-warning">
            This will uninstall
            <strong>{{ inspector.selectedPlugin.manifest.name }}</strong>
            and remove its configuration. A restart is required.
          </p>
          <div class="remove-actions">
            <NbButton variant="ghost" size="sm" @click="confirmingRemove = false">Cancel</NbButton>
            <NbButton
              variant="primary"
              size="sm"
              :loading="removing"
              style="background: var(--nb-c-danger); border-color: var(--nb-c-danger)"
              @click="removePlugin"
            >
              Remove
            </NbButton>
          </div>
        </div>
      </NbShellPanel>

      <!-- ── Platform config editor for all Homebridge-source plugins ───────── -->
      <NbShellPanel v-if="isHomebridge" v-model:size="sections.config" title="Platform config" fluid>
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
            <NbTabs v-if="hasVisualSchema" v-model="editorMode" :tabs="editorTabs" variant="contained" size="sm" />

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
      </NbShellPanel>

      <!-- ── Plugin config editor for native OpenBridge plugins ───────────── -->
      <NbShellPanel v-if="isOpenbridge" v-model:size="sections.config" title="Plugin config" fluid>
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
      </NbShellPanel>

      <NbShellPanel v-model:size="sections.transfer" title="Import &amp; export" fluid>
        <div class="import-export-row">
          <NbButton variant="ghost" size="sm" icon="download" @click="exportConfig">Export config</NbButton>
          <NbButton variant="ghost" size="sm" icon="upload" @click="triggerImport">Import config</NbButton>
          <input ref="importInput" type="file" accept=".json" style="display: none" @change="importConfig" />
        </div>
      </NbShellPanel>

      <!-- ── Devices registered by this plugin ────────────────────────────── -->
      <NbShellPanel
        v-if="pluginDevices.length > 0"
        v-model:size="sections.devices"
        :title="`Devices (${pluginDevices.length})`"
        fluid
      >
        <div v-for="dev in pluginDevices" :key="dev.id" class="plugin-device-row">
          <NbIcon :name="widgetIcon(dev.widgetType)" :size="14" />
          <span class="plugin-device-name">{{ dev.name }}</span>
          <span class="plugin-device-type">{{ dev.widgetType }}</span>
        </div>
      </NbShellPanel>

      <NbShellPanel v-model:size="sections.manifest" title="Manifest" fluid>
        <NbField label="Name" control="fit">
          <span class="field-value">{{ inspector.selectedPlugin.manifest.name }}</span>
        </NbField>
        <NbField label="Version" control="fit">
          <span class="field-value">{{ inspector.selectedPlugin.manifest.version }}</span>
        </NbField>
        <NbField v-if="inspector.selectedPlugin.manifest.description" label="Description" control="fit">
          <span class="field-value">{{ inspector.selectedPlugin.manifest.description }}</span>
        </NbField>
        <NbField v-if="inspector.selectedPlugin.manifest.author" label="Author" control="fit">
          <span class="field-value">{{ inspector.selectedPlugin.manifest.author }}</span>
        </NbField>
      </NbShellPanel>

      <NbShellPanel v-if="inspector.selectedPlugin.error" v-model:size="sections.error" title="Error" fluid>
        <div class="error-box">{{ inspector.selectedPlugin.error }}</div>
      </NbShellPanel>

      <NbShellPanel v-if="pluginLogs.length > 0" v-model:size="sections.logs" title="Recent logs" fluid>
        <div ref="logsEl" class="plugin-log-terminal">
          <div v-for="(entry, i) in pluginLogs" :key="i" class="plugin-log-line">
            <span class="plog-time">{{ new Date(entry.timestamp).toLocaleTimeString() }}</span>
            <span class="plog-level" :style="{ color: LOG_COLORS[entry.level] }">{{ entry.level.toUpperCase() }}</span>
            <span class="plog-msg">{{ entry.message }}</span>
          </div>
        </div>
      </NbShellPanel>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed, onMounted, onBeforeUnmount } from 'vue'
import type { TShellPanelSize } from '@nubisco/ui'
import { useInspectorStore } from '@/stores/inspector'
import { useDaemonStore } from '@/stores/daemon'
import { api, type LogEntry, type DeviceDescriptor } from '@/api'
import QRCode from 'qrcode'
import MonacoJsonEditor from './MonacoJsonEditor.vue'
import PluginConfigForm from './PluginConfigForm.vue'

const daemon = useDaemonStore()
const restarting = ref(false)
const pluginQrUrl = ref('')

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
        location.reload()
      } catch {
        /* still restarting */
      }
      if (attempts > 60) {
        clearInterval(poll)
        restarting.value = false
      }
    }, 1000)
  } catch {
    restarting.value = false
  }
}

const inspector = useInspectorStore()

// "contained" is the library's segmented control, which is what a mode switch
// between two editors of the same thing wants.
const editorTabs = [
  { id: 'visual', label: 'Visual', icon: 'sliders' },
  { id: 'json', label: 'JSON', icon: 'brackets-curly' },
]

// Per-section collapse state for the NbShellPanel stack. Persisted because an
// inspector this tall is only usable if the sections you never look at stay
// shut between visits.
const SECTIONS_KEY = 'openbridge.pluginInspector.sections'
type SectionKey =
  | 'status'
  | 'hap'
  | 'update'
  | 'manage'
  | 'config'
  | 'transfer'
  | 'devices'
  | 'manifest'
  | 'error'
  | 'logs'

const DEFAULT_SECTIONS: Record<SectionKey, TShellPanelSize> = {
  status: 'default',
  hap: 'default',
  update: 'default',
  manage: 'collapsed',
  config: 'default',
  transfer: 'collapsed',
  devices: 'default',
  manifest: 'collapsed',
  error: 'default',
  logs: 'default',
}

const sections = ref<Record<SectionKey, TShellPanelSize>>({ ...DEFAULT_SECTIONS })

try {
  const stored = JSON.parse(localStorage.getItem(SECTIONS_KEY) ?? '{}')
  sections.value = { ...DEFAULT_SECTIONS, ...stored }
} catch {
  /* malformed preference: fall back to defaults */
}

watch(sections, (v) => localStorage.setItem(SECTIONS_KEY, JSON.stringify(v)), { deep: true })

// Generate QR code when plugin has a HAP bridge
watch(
  () => inspector.selectedPlugin?.hapBridge?.setupURI,
  async (uri) => {
    if (uri) {
      try {
        pluginQrUrl.value = await QRCode.toDataURL(uri, { width: 160, margin: 1 })
      } catch {
        pluginQrUrl.value = ''
      }
    } else {
      pluginQrUrl.value = ''
    }
  },
  { immediate: true },
)

// ─── Plugin devices ──────────────────────────────────────────────────────────
const pluginDevices = computed((): DeviceDescriptor[] => {
  const plugin = inspector.selectedPlugin
  if (!plugin?.devices) return []
  return Object.values(plugin.devices) as DeviceDescriptor[]
})

const WIDGET_ICON: Record<string, string> = {
  switch: 'plugs',
  light: 'lamp',
  thermostat: 'thermometer',
  dehumidifier: 'drop',
  energy_meter: 'lightning',
  sensor: 'activity',
}

function widgetIcon(widgetType: string): string {
  return WIDGET_ICON[widgetType] ?? 'cube'
}

const statusLabel: Record<string, string> = {
  idle: 'Idle',
  loading: 'Loading',
  running: 'Running',
  stopped: 'Stopped',
  error: 'Error',
}

// ─── Plugin update ───────────────────────────────────────────────────────────
const updating = ref(false)

async function updatePlugin() {
  if (!inspector.selectedPlugin || updating.value) return
  updating.value = true
  try {
    await api.marketplace.update(inspector.selectedPlugin.manifest.name)
    await daemon.fetchPlugins()
    // Restart to load the new version
    await restartOpenBridge()
  } catch (err) {
    console.error('Failed to update plugin:', err)
  } finally {
    updating.value = false
  }
}

// ─── Plugin removal ──────────────────────────────────────────────────────────
const confirmingRemove = ref(false)
const removing = ref(false)

async function removePlugin() {
  if (!inspector.selectedPlugin || removing.value) return
  removing.value = true
  try {
    await api.marketplace.uninstall(inspector.selectedPlugin.manifest.name)
    await daemon.fetchPlugins()
    inspector.close()
    // Trigger a restart to fully clean up
    await api.daemon.restart()
  } catch (err) {
    console.error('Failed to remove plugin:', err)
  } finally {
    removing.value = false
    confirmingRemove.value = false
  }
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

// ─── Import / Export ──────────────────────────────────────────────────────────
const importInput = ref<HTMLInputElement | null>(null)

function triggerImport() {
  importInput.value?.click()
}

function exportConfig() {
  if (!inspector.selectedPlugin) return
  const name = inspector.selectedPlugin.manifest.name
  const configData = isHomebridge.value ? configJson.value : nativeConfigJson.value
  if (!configData) return

  const blob = new Blob([configData], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${name.replace(/[^a-z0-9-]/gi, '-')}-config.json`
  a.click()
  URL.revokeObjectURL(url)
}

async function importConfig(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file || !inspector.selectedPlugin) return

  try {
    const text = await file.text()
    const parsed = JSON.parse(text)

    // Detect if this is a Homebridge platform config (has "platform" field at root)
    // or a native OpenBridge plugin config
    let configToSave: Record<string, unknown>

    if (parsed.platform && typeof parsed.platform === 'string') {
      // Homebridge format: { platform: "ShellyDS9", devices: [...], ... }
      // Strip the "plugin" path field (Homebridge-specific) and keep the rest
      const { plugin: _plugin, ...deviceConfig } = parsed
      configToSave = deviceConfig
    } else {
      // Native format or raw config object
      configToSave = parsed
    }

    // Save to config.plugins
    await api.config.savePlugin(inspector.selectedPlugin.manifest.name, configToSave)

    // Update the editor
    if (isHomebridge.value) {
      configJson.value = JSON.stringify(configToSave, null, 2)
    } else {
      nativeConfigJson.value = JSON.stringify(configToSave, null, 2)
    }

    // Reset file input
    if (importInput.value) importInput.value.value = ''
  } catch (e) {
    console.error('Import failed:', e)
  }
}

async function saveNativeConfig() {
  if (nativeSaving.value || !inspector.selectedPlugin) return
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(nativeConfigJson.value)
  } catch {
    nativeSaveError.value = 'Invalid JSON: fix the syntax first'
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
      // Config can live in config.platforms[] (keyed by platform name) or in
      // config.plugins[] (keyed by npm package name) depending on how the
      // plugin was loaded: the endpoint resolves across both.
      const existing = await api.config.getHbPlugin(selectedHomebridgePlatformName.value, plugin.packageName)
      if (existing.config) {
        selectedPlatform.value = selectedHomebridgePlatformName.value
        configJson.value = JSON.stringify(existing.config, null, 2)
        visualConfig.value = existing.config as Record<string, unknown>
        await loadSchema(plugin.manifest.name)
        return
      }

      // Nothing stored yet: probe the package to discover its platform name so
      // the editor can be seeded. (This used to bail out for anything that was
      // not 'stopped', which skipped the probe for every running plugin.)
      const info = await api.pluginInfo(plugin.packageName ?? plugin.manifest.name)
      pluginInfo.value = info
      if (info.platforms.length > 0) {
        await selectPlatform(info.platforms[0], info.mainFile)
      }
      await loadSchema(plugin.manifest.name)
    } catch {
      // Probe failed (e.g. plugin not in marketplace dir): try by name as fallback
      try {
        const existing = await api.config.getHbPlugin(selectedHomebridgePlatformName.value, plugin.packageName)
        if (existing.config) {
          selectedPlatform.value = selectedHomebridgePlatformName.value
          configJson.value = JSON.stringify(existing.config, null, 2)
          visualConfig.value = existing.config as Record<string, unknown>
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
  debug: 'var(--nb-c-text-muted)',
  info: 'var(--nb-c-info)',
  warn: 'var(--nb-c-warning)',
  error: 'var(--nb-c-danger)',
}

async function save() {
  if (saving.value || !inspector.selectedPlugin) return
  const parsed = parseJson()
  if (!parsed) {
    saveError.value = 'Invalid JSON: fix the syntax first'
    return
  }
  saving.value = true
  saveError.value = null
  saveSuccess.value = false
  try {
    const plugin = inspector.selectedPlugin
    if (plugin.source === 'homebridge') {
      // Round trips to wherever the config was found. Writing by manifest.name
      // would key the entry on the *platform* name for plugins that use
      // registerPlatform's 2-arg form, which the loader never looks up.
      await api.config.saveHbPlugin(selectedHomebridgePlatformName.value, parsed, plugin.packageName)
    } else {
      await api.config.savePlugin(plugin.manifest.name, parsed)
    }
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
  border-bottom: 1px solid var(--nb-c-layer-1);
  flex-shrink: 0;
}

.inspector-avatar {
  width: 42px;
  height: 42px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--nb-c-layer-1);
  color: var(--nb-c-text-muted);
  flex-shrink: 0;
  &.running {
    background: color-mix(in srgb, var(--nb-c-success) 30%, var(--nb-c-surface));
    color: var(--nb-c-success);
  }
  &.error {
    background: color-mix(in srgb, var(--nb-c-danger) 30%, var(--nb-c-surface));
    color: var(--nb-c-danger);
  }
  &.loading {
    background: color-mix(in srgb, var(--nb-c-warning) 30%, var(--nb-c-surface));
    color: var(--nb-c-warning);
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
  color: var(--nb-c-text);
}
.inspector-version {
  font-size: 0.75rem;
  color: var(--nb-c-text-subtle);
}

.hap-bridge-info {
  display: flex;
  gap: 1rem;
  align-items: flex-start;
}
.hap-qr {
  flex-shrink: 0;
}
.hap-qr-img {
  width: 120px;
  height: 120px;
  border-radius: 8px;
  border: 1px solid var(--nb-c-border);
}
.hap-details {
  flex: 1;
  min-width: 0;
}
.hap-hint {
  margin: 0.5rem 0 0;
  font-size: 0.72rem;
  color: var(--nb-c-text-subtle);
  line-height: 1.4;
}

// The .nb-inspector pattern supplies the panel gutter, gaps and section caps.
.inspector-body {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.update-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  background: color-mix(in srgb, var(--nb-c-info) 10%, var(--nb-c-surface));
  border: 1px solid color-mix(in srgb, var(--nb-c-info) 30%, var(--nb-c-surface));
  border-radius: 8px;
  padding: 0.65rem 0.75rem;
}
.update-banner-text {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.78rem;
  color: var(--nb-c-info);
  line-height: 1.4;
}

.remove-confirm {
  background: color-mix(in srgb, var(--nb-c-danger) 10%, var(--nb-c-surface));
  border: 1px solid color-mix(in srgb, var(--nb-c-danger) 30%, var(--nb-c-surface));
  border-radius: 8px;
  padding: 0.75rem;
}
.remove-warning {
  margin: 0 0 0.5rem;
  font-size: 0.78rem;
  color: var(--nb-c-danger);
  line-height: 1.4;
}
.remove-actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
}

.field-value {
  color: var(--nb-c-text);
  word-break: break-word;
}

.status-badge {
  font-size: 0.72rem;
  font-weight: 700;
  padding: 0.15rem 0.55rem;
  border-radius: 20px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  background: var(--nb-c-layer-1);
  color: var(--nb-c-text-muted);
  &.running {
    background: color-mix(in srgb, var(--nb-c-success) 30%, var(--nb-c-surface));
    color: var(--nb-c-success);
  }
  &.error {
    background: color-mix(in srgb, var(--nb-c-danger) 30%, var(--nb-c-surface));
    color: var(--nb-c-danger);
  }
  &.loading {
    background: color-mix(in srgb, var(--nb-c-warning) 30%, var(--nb-c-surface));
    color: var(--nb-c-warning);
  }
}

.error-box {
  background: color-mix(in srgb, var(--nb-c-danger) 10%, var(--nb-c-surface));
  border: 1px solid color-mix(in srgb, var(--nb-c-danger) 30%, var(--nb-c-surface));
  border-radius: 6px;
  padding: 0.65rem;
  font-size: 0.8rem;
  color: var(--nb-c-danger);
  font-family: monospace;
}

// ─── Setup / config section ───────────────────────────────────────────────────
.setup-loading,
.setup-notice {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.8rem;
  color: var(--nb-c-text-muted);
  code {
    background: var(--nb-c-border);
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    font-size: 0.76rem;
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
  border: 1.5px solid var(--nb-c-border);
  cursor: pointer;
  background: var(--nb-c-surface);
  color: var(--nb-c-text-muted);
  transition: all 0.12s;
  &.active {
    border-color: var(--nb-c-primary);
    background: color-mix(in srgb, var(--nb-c-primary) 12%, var(--nb-c-surface));
    color: var(--nb-c-primary);
  }
  &:hover:not(.active) {
    border-color: var(--nb-c-primary);
  }
}

.config-editor-wrap {
  position: relative;
  border: 1.5px solid var(--nb-c-text);
  border-radius: 8px;
  overflow: hidden;
  transition: border-color 0.15s;
  &:focus-within {
    border-color: var(--nb-c-primary);
  }
  &.invalid {
    border-color: var(--nb-c-danger);
  }
}

.json-error {
  position: absolute;
  bottom: 4px;
  right: 8px;
  font-size: 0.68rem;
  color: var(--nb-c-danger);
  background: var(--nb-c-scrim);
  padding: 1px 6px;
  border-radius: 3px;
  pointer-events: none;
}

.save-error {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.78rem;
  color: var(--nb-c-danger);
}

.setup-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}

// ─── Per-plugin log terminal ──────────────────────────────────────────────────
.plugin-log-terminal {
  background: var(--nb-c-layer-1);
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
    background: var(--nb-c-surface-hover);
    border-radius: 3px;
  }
}

.plog-time {
  color: var(--nb-c-text-muted);
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
  color: var(--nb-c-text-muted);
  flex: 1;
  word-break: break-word;
}

.import-export-row {
  display: flex;
  gap: 0.5rem;
}

.plugin-device-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.5rem;
  border-radius: 6px;
  background: var(--nb-c-layer-1);
  border: 1px solid var(--nb-c-layer-1);
  font-size: 0.8rem;
}
.plugin-device-name {
  flex: 1;
  font-weight: 500;
  color: var(--nb-c-text);
}
.plugin-device-type {
  font-size: 0.7rem;
  color: var(--nb-c-text-subtle);
  text-transform: capitalize;
}
</style>
