<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed } from 'vue'
import { useDaemonStore } from '@/stores/daemon'
import { useInspectorStore, type NativeDevice } from '@/stores/inspector'
import { useLayoutStore } from '@/stores/layout'
import { api, type Accessory } from '@/api'

const daemon = useDaemonStore()
const inspector = useInspectorStore()
const layout = useLayoutStore()

// ─── HAP accessories (existing) ──────────────────────────────────────────────
const refreshing = ref(false)

// ─── Native devices ──────────────────────────────────────────────────────────
const nativeDevices = ref<NativeDevice[]>([])

// ─── Selection via inspector ─────────────────────────────────────────────────
const selectedDeviceId = computed(() => {
  if (inspector.mode !== 'device' || !inspector.selectedDevice) return null
  return inspector.selectedDevice.kind === 'native'
    ? inspector.selectedDevice.dev.id
    : inspector.selectedDevice.acc.uuid
})

function selectHap(acc: Accessory) {
  if (selectedDeviceId.value === acc.uuid) {
    inspector.close()
  } else {
    inspector.openDevice({ kind: 'hap', acc })
  }
}

function selectNative(dev: NativeDevice) {
  if (selectedDeviceId.value === dev.id) {
    inspector.close()
  } else {
    inspector.openDevice({ kind: 'native', dev })
  }
}

// ─── HAP helpers (used in cards) ─────────────────────────────────────────────
// HAP accessory categories (from hap-nodejs Categories enum)
const CATEGORY_INFO: Record<number, { label: string; icon: string }> = {
  1: { label: 'Other', icon: 'cube' },
  2: { label: 'Bridge', icon: 'intersect' },
  3: { label: 'Fan', icon: 'fan' },
  4: { label: 'Garage Door', icon: 'garage' },
  5: { label: 'Light', icon: 'lamp' },
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

// ─── HAP accessory helpers ────────────────────────────────────────────────────
const SKIP_SERVICES = new Set([
  'AccessoryInformation',
  '0000003E-0000-1000-8000-0026BB765291',
  'ProtocolInformation',
  '000000A2-0000-1000-8000-0026BB765291',
])

const ON_CHARACTERISTIC_NAMES = new Set(['On', 'Active', 'LockTargetState', 'TargetDoorState'])

function hapPrimaryService(acc: Accessory) {
  return acc.services.find((s) => !SKIP_SERVICES.has(s.name) && !SKIP_SERVICES.has(s.uuid))
}

function hapOnCharacteristic(acc: Accessory) {
  const svc = hapPrimaryService(acc)
  if (!svc) return null
  return svc.characteristics.find((ch) => ON_CHARACTERISTIC_NAMES.has(ch.name) && ch.perms.includes('pw')) ?? null
}

function hapPrimaryValue(acc: Accessory): string | null {
  const svc = hapPrimaryService(acc)
  if (!svc) return null

  // Look for temperature, humidity, or other numeric readings
  for (const ch of svc.characteristics) {
    if (ch.name === 'CurrentTemperature' && ch.value != null) return `${Number(ch.value).toFixed(1)}°C`
    if (ch.name === 'CurrentRelativeHumidity' && ch.value != null) return `${Math.round(Number(ch.value))}%`
    if (ch.name === 'CurrentPosition' && ch.value != null) return `${Math.round(Number(ch.value))}%`
    if (ch.name === 'Brightness' && ch.value != null) return `${Math.round(Number(ch.value))}%`
  }

  // For switches, show On/Off
  const onCh = svc.characteristics.find((ch) => ch.name === 'On')
  if (onCh) return onCh.value ? 'On' : 'Off'

  return null
}

async function toggleHapCharacteristic(acc: Accessory, value: boolean) {
  const svc = hapPrimaryService(acc)
  const ch = hapOnCharacteristic(acc)
  if (!svc || !ch) return
  try {
    await api.setCharacteristic(acc.uuid, svc.uuid, ch.uuid, value ? 1 : 0)
    await daemon.fetchAccessories()
  } catch (e) {
    console.error('HAP control failed', e)
  }
}

function fmtNum(val: unknown, decimals = 1): string {
  if (val === null || val === undefined) return '—'
  const n = Number(val)
  if (!isFinite(n)) return String(val)
  return n.toFixed(decimals)
}

// ─── Total device count ───────────────────────────────────────────────────────
const totalDevices = computed(() => daemon.accessories.length + nativeDevices.value.length)

// ─── Data fetching ────────────────────────────────────────────────────────────
async function fetchNativeDevices() {
  try {
    const res = await api.devices()
    nativeDevices.value = res.devices

    // Keep selected native device in sync with latest telemetry
    if (inspector.mode === 'device' && inspector.selectedDevice?.kind === 'native') {
      const selectedId = inspector.selectedDevice.dev.id
      const updated = res.devices.find((d) => d.id === selectedId)
      if (updated) inspector.updateDevice({ kind: 'native', dev: updated })
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
          :class="{ selected: selectedDeviceId === dev.id }"
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
          class="device-card hap-card"
          :class="{
            selected: selectedDeviceId === acc.uuid,
            unreachable: !acc.reachable,
          }"
          @click="selectHap(acc)"
        >
          <div class="device-icon hap-icon" :class="{ unreachable: !acc.reachable }">
            <NbIcon :name="categoryInfo(acc.category).icon" :size="22" />
          </div>
          <div class="device-info">
            <div class="device-name">{{ acc.displayName }}</div>
            <div class="device-type">{{ categoryInfo(acc.category).label }}</div>
            <div v-if="hapPrimaryValue(acc)" class="device-summary">
              <span class="summary-primary">{{ hapPrimaryValue(acc) }}</span>
            </div>
            <!-- On/Off toggle for controllable accessories -->
            <div v-if="hapOnCharacteristic(acc)" class="card-controls" @click.stop>
              <NbSwitch
                :model-value="!!hapOnCharacteristic(acc)?.value"
                @update:model-value="toggleHapCharacteristic(acc, $event)"
              />
            </div>
          </div>
          <div class="device-reachability" :class="acc.reachable ? 'online' : 'offline'" />
        </div>
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
  min-height: 0;
  flex: 1;
  margin-top: 0.75rem;
}

.device-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 0.75rem;
  align-content: start;
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
    border-left: 3px solid #c4b5fd;
  }
  &.hap-card {
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
  &.hap-icon {
    background: #f3f4f6;
    color: #6b7280;
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
