<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { useInspectorStore, type NativeDevice } from '@/stores/inspector'
import { api, type Accessory, type InterpolationDescriptor } from '@/api'

const inspector = useInspectorStore()

const selected = computed(() => inspector.selectedDevice)

// Track which device is open so we only reset history when a *different* device is selected
const currentDeviceId = computed(() => {
  if (!selected.value) return null
  return selected.value.kind === 'native' ? selected.value.dev.id : selected.value.acc.uuid
})

// ─── HAP helpers ─────────────────────────────────────────────────────────────
// HAP accessory categories (from hap-nodejs Categories enum)
const CATEGORY_INFO: Record<number, { label: string; icon: string }> = {
  1: { label: 'Other', icon: 'cube' },
  2: { label: 'Bridge', icon: 'intersect' },
  3: { label: 'Fan', icon: 'fan' },
  4: { label: 'Garage Door', icon: 'garage' },
  5: { label: 'Light', icon: 'lightbulb' },
  6: { label: 'Lock', icon: 'lock' },
  7: { label: 'Outlet', icon: 'plugs' },
  8: { label: 'Switch', icon: 'toggle-right' },
  9: { label: 'Thermostat', icon: 'thermometer' },
  10: { label: 'Sensor', icon: 'activity' },
  11: { label: 'Security', icon: 'shield' },
  12: { label: 'Door', icon: 'door' },
  13: { label: 'Window', icon: 'app-window' },
  14: { label: 'Window Covering', icon: 'rows' },
  15: { label: 'Programm. Switch', icon: 'sliders' },
  16: { label: 'Range Extender', icon: 'broadcast' },
  17: { label: 'Camera', icon: 'camera' },
  18: { label: 'Video Doorbell', icon: 'bell' },
  19: { label: 'Air Purifier', icon: 'wind' },
  20: { label: 'Heater/Cooler', icon: 'thermometer-hot' },
  21: { label: 'Air Conditioner', icon: 'snowflake' },
  22: { label: 'Humidifier', icon: 'drop' },
  23: { label: 'Dehumidifier', icon: 'drop' },
  26: { label: 'Speaker', icon: 'speaker-high' },
  28: { label: 'Sprinkler', icon: 'drop' },
  29: { label: 'Faucet', icon: 'drop' },
  30: { label: 'Shower', icon: 'drop' },
  32: { label: 'TV', icon: 'television' },
  34: { label: 'Router', icon: 'broadcast' },
  36: { label: 'Target Control', icon: 'game-controller' },
  38: { label: 'Smart Speaker', icon: 'speaker-hifi' },
}

function categoryInfo(cat: number) {
  return CATEGORY_INFO[cat] ?? { label: `Category ${cat}`, icon: 'cube' }
}

const SKIP_SERVICES = new Set([
  'AccessoryInformation',
  '0000003E-0000-1000-8000-0026BB765291',
  'ProtocolInformation',
  '000000A2-0000-1000-8000-0026BB765291',
])

function mainServices(acc: Accessory) {
  return acc.services.filter((s) => !SKIP_SERVICES.has(s.name) && !SKIP_SERVICES.has(s.uuid))
}

function infoService(acc: Accessory) {
  return acc.services.find((s) => SKIP_SERVICES.has(s.name) || SKIP_SERVICES.has(s.uuid))
}

function manufacturerInfo(acc: Accessory) {
  const svc = infoService(acc)
  if (!svc) return null
  const get = (name: string) => svc.characteristics.find((c) => c.name === name || c.name.includes(name))?.value
  return {
    manufacturer: get('Manufacturer') ?? get('Manuf'),
    model: get('Model'),
    serial: get('SerialNumber') ?? get('Serial'),
    firmware: get('FirmwareRevision') ?? get('Firmware'),
  }
}

function formatValue(ch: { value: unknown; format: string }): string {
  if (ch.value === null || ch.value === undefined) return '—'
  if (ch.format === 'bool') return ch.value ? 'On' : 'Off'
  if (typeof ch.value === 'number') return String(Math.round((ch.value as number) * 100) / 100)
  return String(ch.value)
}

function isWritable(ch: { perms: string[] }) {
  return ch.perms.includes('pw')
}

// ─── Device rename ───────────────────────────────────────────────────────────
const editingName = ref(false)
const renameValue = ref('')
const renameInput = ref<HTMLInputElement | null>(null)

function startRename(currentName: string) {
  renameValue.value = currentName
  editingName.value = true
  nextTick(() => renameInput.value?.focus())
}

async function saveRename(deviceId: string) {
  if (!renameValue.value.trim()) return
  try {
    const newName = renameValue.value.trim()
    await api.renameDevice(deviceId, newName)
    editingName.value = false

    // Update the inspector's selected device in-place so it reflects immediately
    if (selected.value?.kind === 'native') {
      ;(selected.value as any).dev.name = newName
    } else if (selected.value?.kind === 'hap') {
      ;(selected.value as any).acc.displayName = newName
    }

    // Refresh the devices list in the background
    const { useDaemonStore } = await import('@/stores/daemon')
    const daemon = useDaemonStore()
    await daemon.fetchAccessories()
  } catch (e) {
    console.error('Rename failed:', e)
  }
}

async function setHapCharacteristic(accUuid: string, svcUuid: string, chUuid: string, value: unknown) {
  try {
    await api.setCharacteristic(accUuid, svcUuid, chUuid, value)
    // Refresh accessories to get updated values
    const { useDaemonStore } = await import('@/stores/daemon')
    const daemon = useDaemonStore()
    await daemon.fetchAccessories()
  } catch (e) {
    console.error('Failed to set characteristic:', e)
  }
}

// ─── Native device helpers ───────────────────────────────────────────────────
const WIDGET_ICON: Record<string, string> = {
  switch: 'plugs',
  light: 'lightbulb',
  thermostat: 'thermometer',
  dehumidifier: 'drop',
  energy_meter: 'lightning',
  sensor: 'activity',
}

const WIDGET_LABEL: Record<string, string> = {
  switch: 'Switch',
  light: 'Light',
  thermostat: 'Thermostat',
  dehumidifier: 'Dehumidifier',
  energy_meter: 'Energy Meter',
  sensor: 'Sensor',
}

function widgetIcon(widgetType: string): string {
  return WIDGET_ICON[widgetType] ?? 'cube'
}

function widgetLabel(widgetType: string): string {
  return WIDGET_LABEL[widgetType] ?? widgetType
}

function fmtNum(val: unknown, decimals = 1): string {
  if (val === null || val === undefined) return '—'
  const n = Number(val)
  if (!isFinite(n)) return String(val)
  return n.toFixed(decimals)
}

function telemetryEntries(dev: NativeDevice) {
  return Object.entries(dev.telemetry).filter(([k]) => !k.startsWith('_'))
}

// ─── Energy history ──────────────────────────────────────────────────────────
const historyPeriod = ref<'day' | 'month' | 'year'>('day')
const historyDate = ref(new Date().toISOString().slice(0, 10))
const historyData = ref<{
  period: string
  date: string
  buckets: Array<{ label: string; kwh: number | null }>
  totalKwh: number
} | null>(null)
const historyLoading = ref(false)

async function fetchHistory(deviceId: string) {
  if (historyLoading.value) return
  historyLoading.value = true
  try {
    historyData.value = await api.deviceHistory(deviceId, historyPeriod.value, historyDate.value)
  } catch {
    /* ignore */
  } finally {
    historyLoading.value = false
  }
}

function navigateHistory(direction: -1 | 1) {
  const d = new Date(historyDate.value + (historyDate.value.length <= 7 ? '-01' : ''))
  if (historyPeriod.value === 'day') {
    d.setDate(d.getDate() + direction)
    historyDate.value = d.toISOString().slice(0, 10)
  } else if (historyPeriod.value === 'month') {
    d.setMonth(d.getMonth() + direction)
    historyDate.value = d.toISOString().slice(0, 7)
  } else {
    d.setFullYear(d.getFullYear() + direction)
    historyDate.value = String(d.getFullYear())
  }
  if (selected.value?.kind === 'native') {
    fetchHistory((selected.value as any).dev.id)
  }
}

watch(historyPeriod, () => {
  const now = new Date()
  if (historyPeriod.value === 'day') historyDate.value = now.toISOString().slice(0, 10)
  else if (historyPeriod.value === 'month') historyDate.value = now.toISOString().slice(0, 7)
  else historyDate.value = String(now.getFullYear())
  if (selected.value?.kind === 'native' && (selected.value as any).dev.widgetType === 'energy_meter') {
    fetchHistory((selected.value as any).dev.id)
  }
})

watch(
  currentDeviceId,
  (newId, oldId) => {
    if (newId === oldId && historyData.value) return
    const val = selected.value
    if (val?.kind === 'native' && (val as any).dev.widgetType === 'energy_meter') {
      historyDate.value = new Date().toISOString().slice(0, 10)
      historyPeriod.value = 'day'
      fetchHistory((val as any).dev.id)
    }
  },
  { immediate: true },
)

// ─── Interpolation calibration ──────────────────────────────────────────────
interface InterpolationPoint {
  input: number
  output: number
}

const interpolationPoints = ref<InterpolationPoint[]>([])
const interpolationOriginal = ref<InterpolationPoint[]>([])
const interpolationLoading = ref(false)
const interpolationSaving = ref(false)
const interpolationSaved = ref(false)

const interpolationDirty = computed(() => {
  return JSON.stringify(interpolationPoints.value) !== JSON.stringify(interpolationOriginal.value)
})

const nativeDev = computed(() => {
  if (!selected.value || selected.value.kind !== 'native') return null
  return (selected.value as { kind: 'native'; dev: NativeDevice }).dev
})

// Resolve the plugin config for a device. Native plugins store config at
// plugins[].config, homebridge-compat platforms store it at platforms[].
async function resolvePluginConfig(dev: NativeDevice): Promise<{
  pluginConfig: Record<string, unknown>
  isNative: boolean
  pluginName: string
  platformName: string | undefined
} | null> {
  const { plugins } = await api.plugins()
  const plugin = plugins.find((p) => p.id === dev.pluginId)
  if (!plugin) return null

  const isNative = plugin.source !== 'homebridge'

  if (isNative) {
    const { config } = await api.config.getPlugin(dev.pluginId)
    if (!config) return null
    return { pluginConfig: config, isNative: true, pluginName: dev.pluginId, platformName: undefined }
  } else {
    const platformName = plugin.platformName ?? dev.pluginId
    const { config } = await api.config.getPlatform(platformName)
    if (!config) return null
    return { pluginConfig: config, isNative: false, pluginName: dev.pluginId, platformName }
  }
}

async function loadInterpolation() {
  const dev = nativeDev.value
  if (!dev?.interpolation) return

  interpolationLoading.value = true
  interpolationSaved.value = false
  try {
    const resolved = await resolvePluginConfig(dev)
    if (!resolved) return

    const devices = (resolved.pluginConfig.devices as Array<Record<string, unknown>>) ?? []
    const deviceConfig = devices.find((d) => d.id === dev.id)
    if (!deviceConfig) return

    const interp = dev.interpolation as InterpolationDescriptor
    const rawMap = (deviceConfig[interp.configField] as Array<Record<string, number>>) ?? []

    const points: InterpolationPoint[] = rawMap.map((entry) => ({
      input: entry[interp.configShape.inputKey] ?? 0,
      output: entry[interp.configShape.outputKey] ?? 0,
    }))

    interpolationPoints.value = points
    interpolationOriginal.value = JSON.parse(JSON.stringify(points))
  } catch (e) {
    console.error('Failed to load interpolation config:', e)
  } finally {
    interpolationLoading.value = false
  }
}

async function saveInterpolation() {
  const dev = nativeDev.value
  if (!dev?.interpolation) return

  interpolationSaving.value = true
  interpolationSaved.value = false
  try {
    const resolved = await resolvePluginConfig(dev)
    if (!resolved) return

    const interp = dev.interpolation as InterpolationDescriptor
    const devices = (resolved.pluginConfig.devices as Array<Record<string, unknown>>) ?? []
    const deviceIdx = devices.findIndex((d) => d.id === dev.id)
    if (deviceIdx < 0) return

    // Transform back to config shape
    const configMap = interpolationPoints.value.map((pt) => ({
      [interp.configShape.inputKey]: pt.input,
      [interp.configShape.outputKey]: pt.output,
    }))

    devices[deviceIdx] = { ...devices[deviceIdx], [interp.configField]: configMap }
    resolved.pluginConfig.devices = devices

    if (resolved.isNative) {
      await api.config.savePlugin(resolved.pluginName, resolved.pluginConfig)
    } else {
      await api.config.savePlatform(resolved.pluginConfig)
    }

    interpolationOriginal.value = JSON.parse(JSON.stringify(interpolationPoints.value))
    interpolationSaved.value = true
  } catch (e) {
    console.error('Failed to save interpolation config:', e)
  } finally {
    interpolationSaving.value = false
  }
}

function resetInterpolation() {
  interpolationPoints.value = JSON.parse(JSON.stringify(interpolationOriginal.value))
  interpolationSaved.value = false
}

// Load interpolation when device changes
watch(
  currentDeviceId,
  (newId, oldId) => {
    if (newId === oldId && interpolationOriginal.value.length > 0) return
    interpolationSaved.value = false
    if (selected.value?.kind === 'native' && (selected.value as any).dev.interpolation) {
      loadInterpolation()
    } else {
      interpolationPoints.value = []
      interpolationOriginal.value = []
    }
  },
  { immediate: true },
)

const historyChartSeries = computed(() => {
  if (!historyData.value?.buckets) return []

  // For day view, show all 24 hours but use short labels (only show every 6h)
  // For month view, show all days but use short labels
  // For year view, show all 12 months
  const buckets = historyData.value.buckets
  return [
    {
      name: 'kWh',
      data: buckets.map((b) => {
        // Shorten labels for readability
        let label = b.label
        if (historyPeriod.value === 'day') {
          // Only show label at 00, 06, 12, 18
          const hour = parseInt(b.label)
          label = hour % 6 === 0 ? b.label : ''
        } else if (historyPeriod.value === 'month') {
          // Only show every 5th day
          const day = parseInt(b.label)
          label = day % 5 === 1 ? b.label : ''
        }
        return {
          x: label,
          y: Math.max(0, Math.round((b.kwh ?? 0) * 100) / 100),
        }
      }),
    },
  ]
})
</script>

<template>
  <div v-if="selected" class="inspector-content">
    <!-- Native device detail -->
    <template v-if="selected.kind === 'native'">
      <div class="detail-header">
        <div class="detail-icon native-icon">
          <NbIcon :name="widgetIcon((selected as any).dev.widgetType)" :size="26" />
        </div>
        <div style="flex: 1; min-width: 0">
          <h2
            v-if="!editingName"
            class="detail-name"
            :title="'Click to rename'"
            style="cursor: pointer"
            @click="startRename((selected as any).dev.name)"
          >
            {{ (selected as any).dev.name }}
            <NbIcon name="pencil" :size="10" style="opacity: 0.4; margin-left: 4px" />
          </h2>
          <div v-else class="rename-row">
            <input
              ref="renameInput"
              v-model="renameValue"
              class="rename-input"
              @keyup.enter="saveRename((selected as any).dev.id)"
              @keyup.escape="editingName = false"
            />
            <NbButton variant="primary" size="sm" icon="check" @click="saveRename((selected as any).dev.id)" />
            <NbButton variant="ghost" size="sm" icon="x" @click="editingName = false" />
          </div>
          <div class="detail-type">{{ widgetLabel((selected as any).dev.widgetType) }}</div>
        </div>
        <NbButton variant="ghost" size="sm" icon="x" @click="inspector.close()" />
      </div>

      <!-- Device info -->
      <div class="detail-section">
        <div class="section-label">Device info</div>
        <div class="info-grid">
          <span class="info-key">Plugin</span>
          <span class="info-val">{{ (selected as any).dev.pluginId }}</span>
          <template v-if="(selected as any).dev.manufacturer">
            <span class="info-key">Manufacturer</span>
            <span class="info-val">{{ (selected as any).dev.manufacturer }}</span>
          </template>
          <template v-if="(selected as any).dev.model">
            <span class="info-key">Model</span>
            <span class="info-val">{{ (selected as any).dev.model }}</span>
          </template>
          <span class="info-key">Status</span>
          <span class="info-val">{{ (selected as any).dev.pluginStatus }}</span>
          <span class="info-key">ID</span>
          <span class="info-val mono">{{ (selected as any).dev.id }}</span>
        </div>
      </div>

      <!-- Widget view -->
      <div class="detail-section">
        <div class="section-label">State</div>

        <!-- Energy meter widget -->
        <div v-if="(selected as any).dev.widgetType === 'energy_meter'" class="widget-energy">
          <div class="energy-primary">
            <span class="energy-value">{{ fmtNum((selected as any).dev.telemetry.power, 1) }}</span>
            <span class="energy-unit">W</span>
          </div>
          <div class="energy-secondary">
            <template v-if="(selected as any).dev.telemetry.voltage !== undefined">
              <span class="energy-item">
                <span class="energy-label">Voltage</span>
                <span class="energy-item-val">{{ fmtNum((selected as any).dev.telemetry.voltage, 1) }} V</span>
              </span>
            </template>
            <template v-if="(selected as any).dev.telemetry.current !== undefined">
              <span class="energy-item">
                <span class="energy-label">Current</span>
                <span class="energy-item-val">{{ fmtNum((selected as any).dev.telemetry.current, 3) }} A</span>
              </span>
            </template>
          </div>
        </div>

        <!-- Thermostat widget -->
        <div v-else-if="(selected as any).dev.widgetType === 'thermostat'" class="widget-thermo">
          <div class="thermo-row">
            <span class="thermo-label">Current</span>
            <span class="thermo-value">{{ fmtNum((selected as any).dev.telemetry.currentTemperature, 1) }}°C</span>
          </div>
          <div class="thermo-row">
            <span class="thermo-label">Target</span>
            <span class="thermo-value accent">
              {{ fmtNum((selected as any).dev.telemetry.targetTemperature, 1) }}°C
            </span>
          </div>
          <div class="thermo-row">
            <span class="thermo-label">Active</span>
            <span class="thermo-value" :class="(selected as any).dev.telemetry.active ? 'on' : 'off'">
              {{ (selected as any).dev.telemetry.active ? 'On' : 'Off' }}
            </span>
          </div>
        </div>

        <!-- Dehumidifier widget -->
        <div v-else-if="(selected as any).dev.widgetType === 'dehumidifier'" class="widget-thermo">
          <div class="thermo-row">
            <span class="thermo-label">Humidity</span>
            <span class="thermo-value">{{ fmtNum((selected as any).dev.telemetry.currentHumidity, 0) }}%</span>
          </div>
          <div class="thermo-row">
            <span class="thermo-label">Target</span>
            <span class="thermo-value accent">{{ fmtNum((selected as any).dev.telemetry.targetHumidity, 0) }}%</span>
          </div>
          <div class="thermo-row">
            <span class="thermo-label">Active</span>
            <span class="thermo-value" :class="(selected as any).dev.telemetry.active ? 'on' : 'off'">
              {{ (selected as any).dev.telemetry.active ? 'On' : 'Off' }}
            </span>
          </div>
        </div>

        <!-- Generic sensor / switch / light -->
        <div v-else class="widget-generic">
          <template
            v-if="Object.keys((selected as any).dev.telemetry).filter((k: string) => !k.startsWith('_')).length === 0"
          >
            <span class="no-telemetry">No telemetry yet</span>
          </template>
          <div v-for="[k, v] in telemetryEntries((selected as any).dev)" :key="k" class="char-row">
            <span class="char-name">{{ k }}</span>
            <span class="char-value">{{ String(v) }}</span>
          </div>
        </div>
      </div>

      <!-- Energy history chart (energy_meter devices only) -->
      <div v-if="(selected as any).dev.widgetType === 'energy_meter'" class="detail-section energy-history">
        <div class="section-label">Energy history</div>

        <!-- Period tabs -->
        <div class="history-tabs">
          <button
            v-for="p in ['day', 'month', 'year']"
            :key="p"
            class="history-tab"
            :class="{ active: historyPeriod === p }"
            @click="historyPeriod = p as any"
          >
            {{ p }}
          </button>
        </div>

        <!-- Total + navigation -->
        <div v-if="historyData" class="history-nav">
          <button class="history-nav-btn" @click="navigateHistory(-1)">&#8249;</button>
          <div class="history-nav-center">
            <span class="history-total">
              {{ historyData.totalKwh.toFixed(2) }}
              <span class="history-unit">kWh</span>
            </span>
            <span class="history-date">{{ historyData.date }}</span>
          </div>
          <button class="history-nav-btn" @click="navigateHistory(1)">&#8250;</button>
        </div>

        <!-- Bar chart -->
        <NbBarChart
          v-if="historyData && historyData.totalKwh > 0"
          :series="historyChartSeries"
          :height="120"
          :show-legend="false"
          :show-tooltip="true"
        />

        <div v-if="historyData && historyData.totalKwh === 0" class="no-history">
          No consumption recorded for this period. Data accumulates every 5 minutes.
        </div>

        <div v-if="!historyData && !historyLoading" class="no-history">No data available for this period.</div>

        <div v-if="historyLoading" class="no-history">Loading history…</div>
      </div>

      <!-- Interpolation calibration -->
      <div v-if="(selected as any).dev.interpolation && interpolationPoints.length > 0" class="detail-section">
        <div class="section-label">Calibration</div>
        <NbInterpolationChart
          v-model="interpolationPoints"
          :height="220"
          :input-label="(selected as any).dev.interpolation.inputLabel"
          :output-label="(selected as any).dev.interpolation.outputLabel"
          :input-min="(selected as any).dev.interpolation.inputMin"
          :input-max="(selected as any).dev.interpolation.inputMax"
          :output-min="(selected as any).dev.interpolation.outputMin"
          :output-max="(selected as any).dev.interpolation.outputMax"
          :input-step="0.5"
          :output-step="1"
          :show-grid="true"
          :show-tooltip="true"
        />
        <div class="calibration-hint">Drag points to adjust. Double-click to add. Right-click to remove.</div>
        <div class="calibration-actions">
          <NbButton
            variant="primary"
            size="sm"
            :disabled="!interpolationDirty || interpolationSaving"
            @click="saveInterpolation"
          >
            {{ interpolationSaving ? 'Saving...' : 'Save' }}
          </NbButton>
          <NbButton variant="ghost" size="sm" :disabled="!interpolationDirty" @click="resetInterpolation">
            Reset
          </NbButton>
        </div>
        <div v-if="interpolationSaved" class="calibration-restart-notice">
          Configuration saved. Restart the plugin to apply the new mapping.
        </div>
      </div>
      <div v-else-if="(selected as any).dev.interpolation && interpolationLoading" class="detail-section">
        <div class="section-label">Calibration</div>
        <div class="no-history">Loading calibration data...</div>
      </div>

      <!-- All telemetry data -->
      <div v-if="telemetryEntries((selected as any).dev).length > 0" class="detail-section">
        <div class="section-label">All telemetry</div>
        <div class="char-list">
          <div v-for="[k, v] in telemetryEntries((selected as any).dev)" :key="k" class="char-row">
            <span class="char-name">{{ k }}</span>
            <span class="char-value">{{ String(v) }}</span>
          </div>
        </div>
      </div>
    </template>

    <!-- HAP accessory detail (original) -->
    <template v-else-if="selected.kind === 'hap'">
      <div class="detail-header">
        <div class="detail-icon">
          <NbIcon :name="categoryInfo((selected as any).acc.category).icon" :size="26" />
        </div>
        <div style="flex: 1; min-width: 0">
          <h2
            v-if="!editingName"
            class="detail-name"
            :title="'Click to rename'"
            style="cursor: pointer"
            @click="startRename((selected as any).acc.displayName)"
          >
            {{ (selected as any).acc.displayName }}
            <NbIcon name="pencil" :size="10" style="opacity: 0.4; margin-left: 4px" />
          </h2>
          <div v-else class="rename-row">
            <input
              ref="renameInput"
              v-model="renameValue"
              class="rename-input"
              @keyup.enter="saveRename((selected as any).acc.uuid)"
              @keyup.escape="editingName = false"
            />
            <NbButton variant="primary" size="sm" icon="check" @click="saveRename((selected as any).acc.uuid)" />
            <NbButton variant="ghost" size="sm" icon="x" @click="editingName = false" />
          </div>
          <div class="detail-type">{{ categoryInfo((selected as any).acc.category).label }}</div>
        </div>
        <NbButton variant="ghost" size="sm" icon="x" @click="inspector.close()" />
      </div>

      <!-- Manufacturer info -->
      <div v-if="manufacturerInfo((selected as any).acc)" class="detail-section">
        <div class="section-label">Device info</div>
        <div class="info-grid">
          <template v-for="[k, v] in Object.entries(manufacturerInfo((selected as any).acc)!)" :key="k">
            <span v-if="v" class="info-key">{{ k }}</span>
            <span v-if="v" class="info-val">{{ v }}</span>
          </template>
        </div>
      </div>

      <!-- Services & characteristics -->
      <div v-for="svc in mainServices((selected as any).acc)" :key="svc.uuid" class="detail-section">
        <div class="section-label">{{ svc.displayName || svc.name }}</div>
        <div class="char-list">
          <div v-for="ch in svc.characteristics" :key="ch.uuid" class="char-row">
            <span class="char-name">{{ ch.name }}</span>
            <!-- Writable bool → inline toggle -->
            <template v-if="isWritable(ch) && ch.format === 'bool'">
              <NbSwitch
                :model-value="!!ch.value"
                @update:model-value="
                  setHapCharacteristic((selected as any).acc.uuid, svc.uuid, ch.uuid, $event ? 1 : 0)
                "
              />
            </template>
            <!-- Read-only or non-bool writable → display value -->
            <span v-else class="char-value" :class="{ on: ch.format === 'bool' && ch.value }">
              {{ formatValue(ch) }}
            </span>
          </div>
        </div>
      </div>

      <div class="detail-uuid">UUID: {{ (selected as any).acc.uuid }}</div>
    </template>
  </div>
</template>

<style lang="scss" scoped>
.inspector-content {
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  height: 100%;
}

.detail-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 1rem;
  border-bottom: 1px solid #e5e7eb;
  position: sticky;
  top: 0;
  background: #fff;
}

.detail-icon {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  background: #ede9fe;
  color: #7c3aed;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  &.native-icon {
    background: #ede9fe;
    color: #7c3aed;
  }
}

.detail-name {
  font-weight: 700;
  font-size: 0.95rem;
  color: #111827;
  margin: 0;
}

.rename-row {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}
.rename-input {
  font-size: 0.9rem;
  font-weight: 600;
  color: #111827;
  border: 1px solid #c4b5fd;
  border-radius: 6px;
  padding: 0.2rem 0.4rem;
  outline: none;
  flex: 1;
  min-width: 0;
  &:focus {
    border-color: #7c3aed;
    box-shadow: 0 0 0 2px rgba(124, 58, 237, 0.1);
  }
}

.detail-type {
  font-size: 0.75rem;
  color: #9ca3af;
}

.detail-section {
  padding: 0.85rem 1rem 0.5rem;
  border-bottom: 1px solid #f3f4f6;
}

.section-label {
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: #9ca3af;
  margin-bottom: 0.5rem;
}

.info-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.25rem 0.75rem;
  font-size: 0.8rem;
}
.info-key {
  color: #9ca3af;
  text-transform: capitalize;
}
.info-val {
  color: #111827;
  word-break: break-all;
  &.mono {
    font-family: monospace;
    font-size: 0.72rem;
    color: #6b7280;
  }
}

// ─── Widget: energy meter ──────────────────────────────────────────────────────
.widget-energy {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.25rem 0;
}
.energy-primary {
  display: flex;
  align-items: baseline;
  gap: 0.25rem;
}
.energy-value {
  font-size: 2rem;
  font-weight: 700;
  color: #111827;
}
.energy-unit {
  font-size: 1rem;
  color: #9ca3af;
}
.energy-secondary {
  display: flex;
  gap: 1rem;
}
.energy-item {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}
.energy-label {
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #9ca3af;
}
.energy-item-val {
  font-size: 0.85rem;
  font-weight: 600;
  color: #111827;
}

// ─── Widget: thermostat / dehumidifier ────────────────────────────────────────
.widget-thermo {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.thermo-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.3rem 0.5rem;
  border-radius: 6px;
  background: #f9f9fc;
}
.thermo-label {
  font-size: 0.8rem;
  color: #9ca3af;
}
.thermo-value {
  font-size: 0.9rem;
  font-weight: 600;
  color: #111827;
  &.accent {
    color: #7c3aed;
  }
  &.on {
    color: #059669;
  }
  &.off {
    color: #9ca3af;
  }
}

// ─── Widget: generic sensor ───────────────────────────────────────────────────
.widget-generic {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.no-telemetry {
  font-size: 0.8rem;
  color: #9ca3af;
  font-style: italic;
}

// ─── Char rows ─────────────────────────────────────────────────────────────────
.char-list {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.char-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8rem;
  padding: 0.3rem 0.5rem;
  border-radius: 6px;
  background: #f9f9fc;
  border: 1px solid #f3f4f6;
}

.char-name {
  flex: 1;
  color: #6b7280;
}
.char-value {
  color: #111827;
  font-weight: 500;
  font-size: 0.78rem;
  &.on {
    color: #059669;
  }
}
.char-writable {
  color: #7c3aed;
  display: flex;
  align-items: center;
}

.detail-uuid {
  padding: 0.75rem 1rem;
  font-size: 0.68rem;
  color: #d1d5db;
  font-family: monospace;
  word-break: break-all;
}

// ─── Energy history ────────────────────────────────────────────────────────────
.energy-history {
  padding-bottom: 1rem;
}

.history-tabs {
  display: flex;
  gap: 0.25rem;
  margin-bottom: 0.75rem;
}
.history-tab {
  flex: 1;
  padding: 0.25rem;
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: capitalize;
  border-radius: 6px;
  border: 1px solid #e5e7eb;
  background: #fff;
  color: #6b7280;
  cursor: pointer;
  transition: all 0.15s;
  &.active {
    background: #ede9fe;
    border-color: #c4b5fd;
    color: #7c3aed;
  }
}

.history-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.75rem;
}
.history-nav-btn {
  background: none;
  border: 1px solid #e5e7eb;
  color: #6b7280;
  border-radius: 6px;
  width: 28px;
  height: 28px;
  font-size: 1rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  &:hover {
    color: #111827;
    border-color: #9ca3af;
  }
}
.history-nav-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}
.history-total {
  font-size: 1.2rem;
  font-weight: 700;
  color: #111827;
}
.history-unit {
  font-size: 0.7rem;
  color: #9ca3af;
  font-weight: 400;
}
.history-date {
  font-size: 0.7rem;
  color: #9ca3af;
}

.history-chart {
  display: flex;
  align-items: flex-end;
  height: 80px;
  gap: 2px;
  padding: 0 2px;
}
.history-bar-wrap {
  flex: 1;
  height: 100%;
  display: flex;
  align-items: flex-end;
}
.history-bar {
  width: 100%;
  background: #7c3aed;
  border-radius: 2px 2px 0 0;
  transition: height 0.3s ease;
  min-height: 2px;
  opacity: 0.7;
  &:hover {
    opacity: 1;
  }
}

.no-history {
  font-size: 0.78rem;
  color: #9ca3af;
  font-style: italic;
  text-align: center;
  padding: 1rem 0;
}

// ─── Calibration ──────────────────────────────────────────────────────────────
.calibration-hint {
  font-size: 0.68rem;
  color: #9ca3af;
  text-align: center;
  margin-top: 0.25rem;
  margin-bottom: 0.5rem;
}

.calibration-actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
}

.calibration-restart-notice {
  margin-top: 0.5rem;
  padding: 0.4rem 0.6rem;
  font-size: 0.75rem;
  color: #92400e;
  background: #fef3c7;
  border: 1px solid #fde68a;
  border-radius: 6px;
  text-align: center;
}
</style>
