<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed, watch } from 'vue'
import { useDaemonStore } from '@/stores/daemon'
import { useLayoutStore } from '@/stores/layout'
import { api, type Accessory, type DeviceDescriptor } from '@/api'

const daemon = useDaemonStore()
const layout = useLayoutStore()

// ─── HAP accessories (existing) ──────────────────────────────────────────────
const refreshing = ref(false)

// ─── Native devices ──────────────────────────────────────────────────────────
type NativeDevice = DeviceDescriptor & { telemetry: Record<string, unknown>; pluginStatus: string }
const nativeDevices = ref<NativeDevice[]>([])

// ─── Selection / detail panel ────────────────────────────────────────────────
type DeviceItem = { kind: 'hap'; acc: Accessory } | { kind: 'native'; dev: NativeDevice }

const selected = ref<DeviceItem | null>(null)

function selectHap(acc: Accessory) {
  if (selected.value?.kind === 'hap' && selected.value.acc.uuid === acc.uuid) {
    selected.value = null
  } else {
    selected.value = { kind: 'hap', acc }
  }
}

function selectNative(dev: NativeDevice) {
  if (selected.value?.kind === 'native' && selected.value.dev.id === dev.id) {
    selected.value = null
  } else {
    selected.value = { kind: 'native', dev }
  }
}

function closeDetail() {
  selected.value = null
}

// ─── HAP helpers (unchanged logic from original) ─────────────────────────────
const CATEGORY_INFO: Record<number, { label: string; icon: string }> = {
  1: { label: 'Other', icon: 'cube' },
  2: { label: 'Bridge', icon: 'intersect' },
  3: { label: 'Fan', icon: 'fan' },
  5: { label: 'Garage Door', icon: 'garage' },
  6: { label: 'Lamp', icon: 'lamp' },
  7: { label: 'Lock', icon: 'lock' },
  8: { label: 'Outlet', icon: 'plugs' },
  9: { label: 'Switch', icon: 'toggle-right' },
  10: { label: 'Thermostat', icon: 'thermometer' },
  11: { label: 'Sensor', icon: 'activity' },
  12: { label: 'Security', icon: 'shield' },
  13: { label: 'Door', icon: 'door' },
  14: { label: 'Window', icon: 'app-window' },
  15: { label: 'Window Covering', icon: 'rows' },
  16: { label: 'Programm. Switch', icon: 'sliders' },
  17: { label: 'Range Extender', icon: 'broadcast' },
  19: { label: 'Air Purifier', icon: 'wind' },
  20: { label: 'Heater/Cooler', icon: 'thermometer-hot' },
  21: { label: 'Air Conditioner', icon: 'snowflake' },
  28: { label: 'Speaker', icon: 'speaker-high' },
  32: { label: 'TV', icon: 'television' },
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

// ─── Native device helpers ────────────────────────────────────────────────────
const WIDGET_ICON: Record<string, string> = {
  switch: 'plugs',
  light: 'lamp',
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

// ─── Total device count ───────────────────────────────────────────────────────
const totalDevices = computed(() => daemon.accessories.length + nativeDevices.value.length)

// ─── Data fetching ────────────────────────────────────────────────────────────
async function fetchNativeDevices() {
  try {
    const res = await api.devices()
    nativeDevices.value = res.devices

    // Keep selected native device in sync with latest telemetry
    if (selected.value?.kind === 'native') {
      const selectedId = (selected.value as { kind: 'native'; dev: NativeDevice }).dev.id
      const updated = res.devices.find((d) => d.id === selectedId)
      if (updated) selected.value = { kind: 'native', dev: updated }
    }
  } catch {
    /* silently ignore polling errors */
  }
}

async function refresh() {
  refreshing.value = true
  await Promise.all([daemon.fetchAccessories(), fetchNativeDevices()])
  refreshing.value = false
}

let pollInterval: ReturnType<typeof setInterval> | null = null

// Confirmation dialog state
const confirmDialog = ref<{ visible: boolean; deviceId: string; control: string; value: unknown; message: string }>({
  visible: false,
  deviceId: '',
  control: '',
  value: null,
  message: '',
})

function requiresConfirmation(dev: NativeDevice, control: string, value: unknown): string | false {
  // Energy meters / circuit breakers are safety-critical
  if (dev.widgetType === 'energy_meter' && control === 'active') {
    if (value) return `Turn on ${dev.name}? This will energise the connected circuit.`
    return `Turn off ${dev.name}? This will cut power to the connected circuit.`
  }
  return false
}

async function sendControl(deviceId: string, control: string, value: unknown) {
  try {
    await api.controlDevice(deviceId, control, value)
    await fetchNativeDevices()
  } catch (e) {
    console.error('Control failed', e)
  }
}

function requestControl(dev: NativeDevice, control: string, value: unknown) {
  const msg = requiresConfirmation(dev, control, value)
  if (msg) {
    confirmDialog.value = { visible: true, deviceId: dev.id, control, value, message: msg }
  } else {
    sendControl(dev.id, control, value)
  }
}

function confirmControl() {
  const { deviceId, control, value } = confirmDialog.value
  confirmDialog.value.visible = false
  sendControl(deviceId, control, value)
}

function cancelControl() {
  confirmDialog.value.visible = false
}

// Energy history
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

watch([historyPeriod, () => selected.value], () => {
  // Reset date to today/this-month/this-year when switching period
  const now = new Date()
  if (historyPeriod.value === 'day') historyDate.value = now.toISOString().slice(0, 10)
  else if (historyPeriod.value === 'month') historyDate.value = now.toISOString().slice(0, 7)
  else historyDate.value = String(now.getFullYear())
  if (selected.value?.kind === 'native' && (selected.value as any).dev.widgetType === 'energy_meter') {
    fetchHistory((selected.value as any).dev.id)
  }
})

watch(selected, (val) => {
  if (val?.kind === 'native' && (val as any).dev.widgetType === 'energy_meter') {
    historyDate.value = new Date().toISOString().slice(0, 10)
    historyPeriod.value = 'day'
    fetchHistory((val as any).dev.id)
  }
})

// Bar chart helper
function maxKwh(buckets: Array<{ kwh: number | null }>) {
  return Math.max(...buckets.map((b) => b.kwh ?? 0), 0.001)
}

onMounted(async () => {
  layout.setPage('Devices')
  await Promise.all([daemon.fetchAccessories(), fetchNativeDevices()])
  pollInterval = setInterval(fetchNativeDevices, 3000)
})

onUnmounted(() => {
  if (pollInterval) clearInterval(pollInterval)
})
</script>

<template>
  <div class="devices-view">
    <div class="devices-toolbar">
      <div v-if="totalDevices > 0" class="toolbar-count">
        {{ totalDevices }} device{{ totalDevices !== 1 ? 's' : '' }}
        <span v-if="nativeDevices.length > 0" class="toolbar-badge">{{ nativeDevices.length }} native</span>
      </div>
      <div class="toolbar-spacer" />
      <NbButton variant="ghost" size="sm" icon="arrows-clockwise" :loading="refreshing" @click="refresh" />
    </div>

    <div v-if="totalDevices === 0" class="empty-state">
      <NbIcon name="devices" :size="40" />
      <p>No devices registered yet.</p>
      <p class="empty-hint">
        Devices appear here once a platform plugin registers accessories.
        <br />
        This page auto-refreshes every 3 seconds — discovery can take up to 60s.
      </p>
    </div>

    <div v-else class="devices-layout">
      <!-- Device grid -->
      <div class="device-grid">
        <!-- Native plugin devices -->
        <div
          v-for="dev in nativeDevices"
          :key="'native:' + dev.id"
          class="device-card native-card"
          :class="{ selected: selected?.kind === 'native' && (selected as any).dev.id === dev.id }"
          @click="selectNative(dev)"
        >
          <div class="device-icon native-icon">
            <NbIcon :name="widgetIcon(dev.widgetType)" :size="22" />
          </div>
          <div class="device-info">
            <div class="device-name">{{ dev.name }}</div>
            <div class="device-type">{{ widgetLabel(dev.widgetType) }}</div>
            <!-- Inline widget summary -->
            <div class="device-summary">
              <!-- Energy meter -->
              <template v-if="dev.widgetType === 'energy_meter' && dev.telemetry.power !== undefined">
                <span class="summary-primary">{{ fmtNum(dev.telemetry.power, 1) }} W</span>
              </template>
              <!-- Thermostat -->
              <template v-else-if="dev.widgetType === 'thermostat' && dev.telemetry.currentTemperature !== undefined">
                <span class="summary-primary">{{ fmtNum(dev.telemetry.currentTemperature, 1) }}°C</span>
                <span v-if="dev.telemetry.targetTemperature !== undefined" class="summary-secondary">
                  target {{ fmtNum(dev.telemetry.targetTemperature, 1) }}°C
                </span>
              </template>
              <!-- Dehumidifier -->
              <template v-else-if="dev.widgetType === 'dehumidifier' && dev.telemetry.currentHumidity !== undefined">
                <span class="summary-primary">{{ fmtNum(dev.telemetry.currentHumidity, 0) }}%</span>
              </template>
              <!-- Active state for switch/light -->
              <template v-else-if="dev.telemetry.active !== undefined">
                <span class="summary-status" :class="dev.telemetry.active ? 'on' : 'off'">
                  {{ dev.telemetry.active ? 'On' : 'Off' }}
                </span>
              </template>
            </div>
            <!-- On/off toggle for all controllable devices -->
            <div v-if="dev.telemetry.active !== undefined" class="card-controls" @click.stop>
              <NbSwitch
                :model-value="!!dev.telemetry.active"
                @update:model-value="requestControl(dev, 'active', $event)"
              />
            </div>
            <!-- Thermostat stepper -->
            <div
              v-if="dev.widgetType === 'thermostat' && dev.telemetry.targetTemperature !== undefined"
              class="card-controls"
              @click.stop
            >
              <div class="ctrl-stepper">
                <button
                  @click.stop="
                    sendControl(dev.id, 'targetTemperature', (Number(dev.telemetry.targetTemperature) || 20) - 1)
                  "
                >
                  −
                </button>
                <span>{{ fmtNum(dev.telemetry.targetTemperature, 0) }}°</span>
                <button
                  @click.stop="
                    sendControl(dev.id, 'targetTemperature', (Number(dev.telemetry.targetTemperature) || 20) + 1)
                  "
                >
                  +
                </button>
              </div>
            </div>
            <!-- Dehumidifier stepper -->
            <div
              v-if="dev.widgetType === 'dehumidifier' && dev.telemetry.targetHumidity !== undefined"
              class="card-controls"
              @click.stop
            >
              <div class="ctrl-stepper">
                <button
                  @click.stop="sendControl(dev.id, 'targetHumidity', (Number(dev.telemetry.targetHumidity) || 50) - 5)"
                >
                  −
                </button>
                <span>{{ fmtNum(dev.telemetry.targetHumidity, 0) }}%</span>
                <button
                  @click.stop="sendControl(dev.id, 'targetHumidity', (Number(dev.telemetry.targetHumidity) || 50) + 5)"
                >
                  +
                </button>
              </div>
            </div>
          </div>
          <div class="device-reachability" :class="dev.pluginStatus === 'running' ? 'online' : 'offline'" />
        </div>

        <!-- HAP / Homebridge accessories -->
        <div
          v-for="acc in daemon.accessories"
          :key="acc.uuid"
          class="device-card"
          :class="{
            selected: selected?.kind === 'hap' && (selected as any).acc.uuid === acc.uuid,
            unreachable: !acc.reachable,
          }"
          @click="selectHap(acc)"
        >
          <div class="device-icon" :class="{ unreachable: !acc.reachable }">
            <NbIcon :name="categoryInfo(acc.category).icon" :size="22" />
          </div>
          <div class="device-info">
            <div class="device-name">{{ acc.displayName }}</div>
            <div class="device-type">{{ categoryInfo(acc.category).label }}</div>
          </div>
          <div class="device-reachability" :class="acc.reachable ? 'online' : 'offline'" />
        </div>
      </div>

      <!-- Detail panel -->
      <div v-if="selected" class="device-detail">
        <!-- Native device detail -->
        <template v-if="selected.kind === 'native'">
          <div class="detail-header">
            <div class="detail-icon native-icon">
              <NbIcon :name="widgetIcon((selected as any).dev.widgetType)" :size="26" />
            </div>
            <div style="flex: 1; min-width: 0">
              <h2 class="detail-name">{{ (selected as any).dev.name }}</h2>
              <div class="detail-type">{{ widgetLabel((selected as any).dev.widgetType) }}</div>
            </div>
            <NbButton variant="ghost" size="sm" icon="x" @click="closeDetail" />
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
                <span class="thermo-value accent">
                  {{ fmtNum((selected as any).dev.telemetry.targetHumidity, 0) }}%
                </span>
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
                v-if="Object.keys((selected as any).dev.telemetry).filter((k) => !k.startsWith('_')).length === 0"
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
              <button class="history-nav-btn" @click="navigateHistory(-1)">‹</button>
              <div class="history-nav-center">
                <span class="history-total">
                  {{ historyData.totalKwh.toFixed(2) }}
                  <span class="history-unit">kWh</span>
                </span>
                <span class="history-date">{{ historyData.date }}</span>
              </div>
              <button class="history-nav-btn" @click="navigateHistory(1)">›</button>
            </div>

            <!-- Bar chart -->
            <div v-if="historyData && historyData.buckets.length > 0" class="history-chart">
              <div v-for="(b, i) in historyData.buckets" :key="i" class="history-bar-wrap">
                <div
                  class="history-bar"
                  :style="{
                    height: b.kwh !== null ? Math.max(2, (b.kwh / maxKwh(historyData!.buckets)) * 100) + '%' : '2px',
                    opacity: b.kwh !== null ? 1 : 0.2,
                  }"
                  :title="b.kwh !== null ? b.label + ': ' + b.kwh + ' kWh' : b.label + ': no data'"
                />
              </div>
            </div>

            <div v-if="historyData && historyData.buckets.length === 0" class="no-history">
              No data yet — history accumulates as the device runs.
            </div>

            <div v-if="!historyData && !historyLoading" class="no-history">Loading history…</div>
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
              <h2 class="detail-name">{{ (selected as any).acc.displayName }}</h2>
              <div class="detail-type">{{ categoryInfo((selected as any).acc.category).label }}</div>
            </div>
            <NbButton variant="ghost" size="sm" icon="x" @click="closeDetail" />
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
                <span v-if="isWritable(ch)" class="char-writable" title="Writable">
                  <NbIcon name="pencil" :size="11" />
                </span>
                <span v-else class="char-value" :class="{ on: ch.format === 'bool' && ch.value }">
                  {{ formatValue(ch) }}
                </span>
              </div>
            </div>
          </div>

          <div class="detail-uuid">UUID: {{ (selected as any).acc.uuid }}</div>
        </template>
      </div>
    </div>

    <!-- Confirmation dialog for safety-critical controls -->
    <Teleport to="body">
      <div v-if="confirmDialog.visible" class="confirm-overlay" @click.self="cancelControl">
        <div class="confirm-dialog">
          <div class="confirm-icon">
            <NbIcon name="warning" :size="24" />
          </div>
          <p class="confirm-message">{{ confirmDialog.message }}</p>
          <div class="confirm-actions">
            <NbButton variant="ghost" size="sm" @click="cancelControl">Cancel</NbButton>
            <NbButton variant="primary" size="sm" @click="confirmControl">Confirm</NbButton>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style lang="scss" scoped>
.devices-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.devices-toolbar {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  margin-bottom: -0.25rem;
}
.toolbar-count {
  font-size: 0.8rem;
  color: #9ca3af;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.toolbar-badge {
  font-size: 0.7rem;
  background: rgba(124, 58, 237, 0.08);
  color: #7c3aed;
  border: 1px solid rgba(124, 58, 237, 0.2);
  border-radius: 99px;
  padding: 0.1rem 0.5rem;
}
.toolbar-spacer {
  flex: 1;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  padding: 4rem 2rem;
  color: #9ca3af;
  text-align: center;
  border: 1px dashed #d1d5db;
  border-radius: 12px;
  p {
    margin: 0;
    font-size: 0.875rem;
  }
  .empty-hint {
    font-size: 0.8rem;
    line-height: 1.6;
  }
}

.devices-layout {
  display: flex;
  gap: 1.25rem;
  min-height: 0;
  flex: 1;
  margin-top: 0.75rem;
}

.device-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 0.75rem;
  align-content: start;
  flex: 1;
}

.device-card {
  background: #fff;
  border: 1.5px solid #e5e7eb;
  border-radius: 12px;
  padding: 1rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
  &:hover {
    border-color: #c4b5fd;
  }
  &.selected {
    border-color: #7c3aed;
    box-shadow: 0 2px 12px rgba(124, 58, 237, 0.12);
  }
  &.unreachable {
    opacity: 0.55;
  }
  &.native-card {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
  }
}

.device-icon {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  background: #ede9fe;
  color: #7c3aed;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  &.unreachable {
    background: #f3f4f6;
    color: #9ca3af;
  }
  &.native-icon {
    background: #ede9fe;
    color: #7c3aed;
  }
}

.device-info {
  flex: 1;
  min-width: 0;
  width: 100%;
}
.device-name {
  font-weight: 600;
  font-size: 0.875rem;
  color: #111827;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.device-type {
  font-size: 0.74rem;
  color: #9ca3af;
  margin-top: 2px;
}
.device-summary {
  margin-top: 0.35rem;
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
}
.summary-primary {
  font-size: 1.1rem;
  font-weight: 700;
  color: #111827;
}
.summary-secondary {
  font-size: 0.72rem;
  color: #9ca3af;
}
.summary-status {
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  &.on {
    background: #d1fae5;
    color: #065f46;
  }
  &.off {
    background: #f3f4f6;
    color: #9ca3af;
  }
}

.device-reachability {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  align-self: flex-start;
  margin-top: 0.25rem;
  &.online {
    background: #34d399;
  }
  &.offline {
    background: #d1d5db;
  }
}

// ─── Detail panel ─────────────────────────────────────────────────────────────
.device-detail {
  width: 300px;
  flex-shrink: 0;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  max-height: calc(100vh - 160px);
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

// ─── Card controls ─────────────────────────────────────────────────────────────
.card-controls {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.5rem;
}
.ctrl-stepper {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  background: #f9f9fc;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  padding: 0.1rem 0.25rem;
  button {
    background: none;
    border: none;
    color: #6b7280;
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
    padding: 0 0.2rem;
    &:hover {
      color: #111827;
    }
  }
  span {
    font-size: 0.8rem;
    font-weight: 600;
    color: #111827;
    min-width: 2.5rem;
    text-align: center;
  }
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

// ─── Confirmation dialog ──────────────────────────────────────────────────────
.confirm-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.3);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.confirm-dialog {
  background: #fff;
  border-radius: 12px;
  padding: 1.5rem;
  max-width: 360px;
  width: 90%;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
}
.confirm-icon {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  background: #fef3c7;
  color: #92400e;
  display: flex;
  align-items: center;
  justify-content: center;
}
.confirm-message {
  font-size: 0.85rem;
  color: #374151;
  text-align: center;
  margin: 0;
  line-height: 1.5;
}
.confirm-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.25rem;
}
</style>
