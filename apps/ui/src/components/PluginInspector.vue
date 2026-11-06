<template>
  <div v-if="inspector.selectedPlugin" class="inspector">
    <!-- Pinned: the sections scroll under it, so the plugin being edited and
         its one status stay in view however far down the config goes. -->
    <div class="inspector-header">
      <div class="inspector-avatar">
        <NbIcon name="puzzle-piece" size="lg" />
      </div>
      <div class="inspector-title">
        <h2 class="inspector-name type-heading-01">{{ inspector.selectedPlugin.manifest.name }}</h2>
        <span class="inspector-version type-body-sm tabular">v{{ inspector.selectedPlugin.manifest.version }}</span>
      </div>
      <NbBadge class="inspector-status" :variant="statusVariant(inspector.selectedPlugin.status)">
        {{ statusLabel[inspector.selectedPlugin.status] }}
      </NbBadge>
    </div>

    <div class="inspector-body nb-inspector">
      <NbShellPanel v-model:size="sections.status" title="Status" fluid>
        <NbField v-if="inspector.selectedPlugin.startedAt" label="Started">
          <span class="field-value type-body-compact tabular">
            {{ new Date(inspector.selectedPlugin.startedAt).toLocaleString() }}
          </span>
        </NbField>
        <NbField v-if="inspector.selectedPlugin.stoppedAt" label="Stopped">
          <span class="field-value type-body-compact tabular">
            {{ new Date(inspector.selectedPlugin.stoppedAt).toLocaleString() }}
          </span>
        </NbField>
        <NbField label="Disabled" control="fit">
          <NbSwitch
            :name="`plugin-disabled-${inspector.selectedPlugin.id}`"
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
            <NbField label="PIN">
              <span class="field-value type-code-md">{{ inspector.selectedPlugin.hapBridge.pincode }}</span>
            </NbField>
            <NbField label="Port">
              <span class="field-value type-body-compact tabular">{{ inspector.selectedPlugin.hapBridge.port }}</span>
            </NbField>
            <NbField label="Bridge">
              <span class="field-value type-body-compact">{{ inspector.selectedPlugin.hapBridge.name }}</span>
            </NbField>
          </div>
        </div>
        <p class="hap-hint type-helper-text">
          Scan with the Home app or enter the PIN manually to pair this plugin's devices.
        </p>
      </NbShellPanel>

      <!-- ── Update available ──────────────────────────────────────────────── -->
      <NbShellPanel v-if="inspector.selectedPlugin.availableUpdate" v-model:size="sections.update" title="Update" fluid>
        <NbBanner
          status="info"
          icon="arrow-circle-up"
          :title="`Version ${inspector.selectedPlugin.availableUpdate} is available`"
        >
          Currently on {{ inspector.selectedPlugin.manifest.version }}.
          <template #action>
            <NbButton variant="primary" size="sm" :loading="updating" :disabled="updating" @click="updatePlugin">
              {{ updating ? 'Updating...' : 'Update' }}
            </NbButton>
          </template>
        </NbBanner>
      </NbShellPanel>

      <!-- ── Remove plugin ─────────────────────────────────────────────────── -->
      <NbShellPanel v-model:size="sections.manage" title="Manage" fluid>
        <!-- The trigger is outlined danger, the confirmation keeps the filled one. -->
        <NbButton
          v-if="!confirmingRemove"
          class="manage-remove"
          variant="danger"
          outlined
          size="sm"
          icon="trash"
          @click="confirmingRemove = true"
        >
          Remove plugin
        </NbButton>
        <!-- Title and body are read as one paragraph, so the body continues the
             sentence rather than restating the plugin the header already names. -->
        <NbBanner v-else status="error" title="This uninstalls the plugin and removes its configuration">
          OpenBridge needs a restart afterwards.
          <template #action>
            <NbButton variant="secondary" size="sm" @click="confirmingRemove = false">Cancel</NbButton>
            <NbButton variant="danger" size="sm" :loading="removing" @click="removePlugin">Remove</NbButton>
          </template>
        </NbBanner>
      </NbShellPanel>

      <!-- ── Platform config editor for all Homebridge-source plugins ───────── -->
      <NbShellPanel v-if="isHomebridge" v-model:size="sections.config" title="Platform config" fluid>
        <NbInlineLoading v-if="loadingInfo" status="active" label="Loading config…" />

        <template v-else>
          <!-- Multiple platforms discovered → tabs -->
          <NbTabs
            v-if="pluginInfo && pluginInfo.platforms.length > 1"
            :model-value="selectedPlatform"
            :items="pluginInfo.platforms.map((p) => ({ id: p, label: p }))"
            aria-label="Platforms"
            size="sm"
            @update:model-value="(id: string) => selectPlatform(id)"
          />

          <!-- No platform detected at all -->
          <!-- Callout: true of this plugin for as long as the entry is missing,
               so dismissing it would not make it any less true. -->
          <NbBanner
            v-else-if="pluginInfo && pluginInfo.platforms.length === 0"
            status="warning"
            variant="callout"
            title="No platform detected"
          >
            Add a
            <code>platforms[]</code>
            entry manually in Config.
          </NbBanner>

          <!-- Visual / JSON tabs -->
          <template v-if="!pluginInfo || pluginInfo.platforms.length > 0">
            <!-- Tab switcher (only shown when schema is available) -->
            <NbTabs
              v-if="hasVisualSchema"
              :model-value="editorMode"
              :items="editorTabs"
              variant="contained"
              size="sm"
              @update:model-value="(id: string) => (editorMode = id as TEditorMode)"
            />

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
              <div v-if="configJson && !jsonValid" class="json-error type-body-sm">Invalid JSON</div>
              <div v-else-if="jsonMissingPlatform" class="json-error type-body-sm">Missing "platform" field</div>
            </div>

            <NbBanner v-if="saveError" status="error">{{ saveError }}</NbBanner>

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
                variant="tertiary"
                size="sm"
                :loading="restarting"
                icon="arrows-clockwise"
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
          <div v-if="nativeConfigJson && !nativeJsonValid" class="json-error type-body-sm">Invalid JSON</div>
        </div>
        <NbBanner v-if="nativeSaveError" status="error">{{ nativeSaveError }}</NbBanner>
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
            variant="tertiary"
            size="sm"
            :loading="restarting"
            icon="arrows-clockwise"
            @click="restartOpenBridge"
          >
            {{ restarting ? 'Restarting…' : 'Restart OpenBridge' }}
          </NbButton>
        </div>
      </NbShellPanel>

      <NbShellPanel v-model:size="sections.transfer" title="Import &amp; export" fluid>
        <div class="import-export-row">
          <NbButton variant="tertiary" size="sm" icon="download-simple" @click="exportConfig">Export config</NbButton>
          <NbButton variant="tertiary" size="sm" icon="upload-simple" @click="triggerImport">Import config</NbButton>
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
        <NbContainedList size="sm" aria-label="Devices registered by this plugin">
          <NbContainedListItem v-for="dev in pluginDevices" :key="dev.id" :title="dev.name">
            <template #leading>
              <NbIcon :name="widgetIcon(dev.widgetType)" size="sm" />
            </template>
            <template #trailing>
              <span class="plugin-device-type type-body-sm">{{ dev.widgetType }}</span>
            </template>
          </NbContainedListItem>
        </NbContainedList>
      </NbShellPanel>

      <NbShellPanel v-model:size="sections.manifest" title="Manifest" fluid>
        <NbField label="Name">
          <span class="field-value type-body-compact">{{ inspector.selectedPlugin.manifest.name }}</span>
        </NbField>
        <NbField label="Version">
          <span class="field-value type-body-compact tabular">{{ inspector.selectedPlugin.manifest.version }}</span>
        </NbField>
        <NbField v-if="inspector.selectedPlugin.manifest.description" label="Description">
          <span class="field-value type-body-compact">{{ inspector.selectedPlugin.manifest.description }}</span>
        </NbField>
        <NbField v-if="inspector.selectedPlugin.manifest.author" label="Author">
          <span class="field-value type-body-compact">{{ inspector.selectedPlugin.manifest.author }}</span>
        </NbField>
      </NbShellPanel>

      <NbShellPanel v-if="inspector.selectedPlugin.error" v-model:size="sections.error" title="Error" fluid>
        <!-- The message is whatever the plugin threw, so it stays monospaced
             and wrapping: it is output to read, not prose. -->
        <NbBanner status="error">
          <code class="error-text type-code-sm">{{ inspector.selectedPlugin.error }}</code>
        </NbBanner>
      </NbShellPanel>

      <NbShellPanel v-if="pluginLogs.length > 0" v-model:size="sections.logs" title="Recent logs" fluid>
        <div ref="logsEl" class="plugin-log-terminal type-code-sm">
          <div v-for="(entry, i) in pluginLogs" :key="i" class="plugin-log-line">
            <span class="plog-time tabular">{{ new Date(entry.timestamp).toLocaleTimeString() }}</span>
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
import * as iconSliders from '@nubisco/ui/icons/sliders'
import * as iconBracketsCurly from '@nubisco/ui/icons/brackets-curly'
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
// The icons are imported modules: a name inside a script object is not linked
// by the bundler plugin and would throw at runtime.
const editorTabs = [
  { id: 'visual', label: 'Visual', icon: iconSliders },
  { id: 'json', label: 'JSON', icon: iconBracketsCurly },
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
  // 'garage' covers gates too: HomeKit has no separate gate service, so a
  // sliding gate arrives here as a garage door opener and should look like one.
  gate: 'garage',
  // 'activity' is not in the icon catalogue (it never was, in 3.x either):
  // it silently rendered nothing, and @nubisco/ui 4.x throws on an unresolved
  // name, so this is now 'pulse'. Registered in src/icons.ts.
  sensor: 'pulse',
}

function widgetIcon(widgetType: string): string {
  return WIDGET_ICON[widgetType] ?? 'cube'
}

// Same colours the plugin list uses for the status, so the two agree.
function statusVariant(status: string) {
  if (status === 'running') return 'success'
  if (status === 'error') return 'danger'
  if (status === 'loading') return 'info'
  return 'neutral'
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
type TEditorMode = 'visual' | 'json'
// NbTabs models a plain string (its ids are open-ended), so the narrowing
// back to the two ids this switcher defines happens at the call site.
const editorMode = ref<TEditorMode>('visual')
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
// The header is pinned and the body scrolls: .nb-inspector sits on the body,
// so it is the body that takes the pattern's scroll, gutter and section caps.
.inspector {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.inspector-header {
  display: flex;
  align-items: center;
  gap: var(--nb-spacing-12);
  padding: var(--nb-spacing-12) var(--nb-spacing-16);
  border-bottom: 1px solid var(--nb-c-border);
  flex-shrink: 0;
}

// Neutral on purpose: the status badge beside the name is the one place the
// plugin's state is coloured.
.inspector-avatar {
  width: 40px;
  height: 40px;
  border-radius: var(--nb-radius-control);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--nb-c-layer-1);
  color: var(--nb-c-text-muted);
  flex-shrink: 0;
}

.inspector-title {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.inspector-name {
  margin: 0;
  color: var(--nb-c-text);
  overflow-wrap: anywhere;
}
.inspector-version {
  color: var(--nb-c-text-subtle);
}
.inspector-status {
  flex-shrink: 0;
}

// The phone sheet puts its dismiss button over the top right corner, so the
// header keeps clear of it.
@include variables.phone {
  .inspector-header {
    padding-right: calc(var(--nb-spacing-16) + var(--nb-shell-inspector-dismiss-inset, 0px));
  }
}

.hap-bridge-info {
  display: flex;
  gap: var(--nb-spacing-12);
  align-items: flex-start;
}
.hap-qr {
  flex-shrink: 0;
}
.hap-qr-img {
  display: block;
  width: 120px;
  height: 120px;
  border-radius: var(--nb-radius-control);
  border: 1px solid var(--nb-c-border);
}
.hap-details {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--nb-spacing-8);
}
.hap-hint {
  margin: 0;
  color: var(--nb-c-text-subtle);
}

// The .nb-inspector pattern supplies the panel gutter, gaps and section caps.
.inspector-body {
  flex: 1;
  min-height: 0;
}

.field-value {
  color: var(--nb-c-text);
  word-break: break-word;
}

// ─── Setup / config section ───────────────────────────────────────────────────
.error-text {
  word-break: break-word;
}

.visual-editor-wrap {
  max-height: 340px;
  overflow-y: auto;
  padding: var(--nb-spacing-4) 0;
}

// The editor has no frame of its own, so this draws the field border around
// it, and turns it red while the JSON does not parse.
.config-editor-wrap {
  position: relative;
  border: 1px solid var(--nb-c-text);
  border-radius: var(--nb-radius-control);
  overflow: hidden;
  transition: border-color var(--nb-motion-quick) var(--nb-ease-standard);
  &:focus-within {
    border-color: var(--nb-c-primary);
  }
  &.invalid {
    border-color: var(--nb-c-danger);
  }
}

.json-error {
  position: absolute;
  bottom: var(--nb-spacing-4);
  right: var(--nb-spacing-8);
  color: var(--nb-c-danger);
  background: var(--nb-c-scrim);
  padding: var(--nb-spacing-2) var(--nb-spacing-8);
  border-radius: var(--nb-radius-control-sm);
  pointer-events: none;
}

.setup-actions,
.import-export-row {
  display: flex;
  align-items: center;
  gap: var(--nb-spacing-8);
  flex-wrap: wrap;
}

.manage-remove {
  align-self: flex-start;
}

// ─── Per-plugin log terminal ──────────────────────────────────────────────────
.plugin-log-terminal {
  background: var(--nb-c-layer-1);
  border-radius: var(--nb-radius-control);
  padding: var(--nb-spacing-8) var(--nb-spacing-12);
  max-height: 200px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--nb-spacing-2);
}

.plugin-log-line {
  display: flex;
  gap: var(--nb-spacing-8);
  align-items: baseline;
  &:hover {
    background: var(--nb-c-surface-hover);
  }
}

.plog-time {
  color: var(--nb-c-text-muted);
  flex-shrink: 0;
}
// Wide enough for DEBUG, so every message starts on one edge.
.plog-level {
  flex-shrink: 0;
  width: 5ch;
}
.plog-msg {
  color: var(--nb-c-text-muted);
  flex: 1;
  min-width: 0;
  word-break: break-word;
}

.plugin-device-type {
  color: var(--nb-c-text-subtle);
  text-transform: capitalize;
}
</style>
