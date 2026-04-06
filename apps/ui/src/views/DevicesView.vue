<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useDaemonStore } from '@/stores/daemon'
import { useLayoutStore } from '@/stores/layout'
import { api, type Accessory, type AccessoryCharacteristic, type AccessoryService } from '@/api'

const daemon = useDaemonStore()
const layout = useLayoutStore()
const selected = ref<Accessory | null>(null)
const refreshing = ref(false)
const writing = ref<string | null>(null)

// ─── Local name overrides (persisted in localStorage) ────────────────────────
const nameOverrides = ref<Record<string, string>>(JSON.parse(localStorage.getItem('ob:deviceNames') ?? '{}'))
const editingName = ref(false)
const editNameValue = ref('')

function selectDevice(acc: Accessory) {
  selected.value = selected.value?.uuid === acc.uuid ? null : acc
  editingName.value = false
}

function closeDetail() {
  selected.value = null
  editingName.value = false
}

function deviceName(acc: Accessory): string {
  return nameOverrides.value[acc.uuid] ?? acc.displayName
}

function startEditName() {
  if (!selected.value) return
  editNameValue.value = deviceName(selected.value)
  editingName.value = true
}

function saveEditName() {
  if (!selected.value) return
  const trimmed = editNameValue.value.trim()
  if (trimmed && trimmed !== selected.value.displayName) {
    nameOverrides.value = { ...nameOverrides.value, [selected.value.uuid]: trimmed }
    localStorage.setItem('ob:deviceNames', JSON.stringify(nameOverrides.value))
  } else if (!trimmed) {
    const copy = { ...nameOverrides.value }
    delete copy[selected.value.uuid]
    nameOverrides.value = copy
    localStorage.setItem('ob:deviceNames', JSON.stringify(copy))
  }
  editingName.value = false
}

async function writeCharacteristic(acc: Accessory, svc: AccessoryService, ch: AccessoryCharacteristic, value: unknown) {
  const key = ch.uuid
  if (writing.value === key) return
  writing.value = key
  try {
    await api.setCharacteristic(acc.uuid, svc.uuid, ch.uuid, value)
    ch.value = value
    if (selected.value?.uuid === acc.uuid) {
      selected.value = JSON.parse(JSON.stringify(selected.value))
    }
  } catch {
    /* silently ignore */
  } finally {
    writing.value = null
  }
}

async function refresh() {
  refreshing.value = true
  await daemon.fetchAccessories()
  refreshing.value = false
}

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

function formatValue(ch: { value: unknown; format: string }): string {
  if (ch.value === null || ch.value === undefined) return '—'
  if (ch.format === 'bool') return ch.value ? 'On' : 'Off'
  if (typeof ch.value === 'number') return String(Math.round((ch.value as number) * 100) / 100)
  return String(ch.value)
}

function isWritable(ch: { perms: string[] }) {
  return ch.perms.includes('pw')
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

let pollInterval: ReturnType<typeof setInterval> | null = null

onMounted(async () => {
  layout.setPage('Devices')
  await daemon.fetchAccessories()
  pollInterval = setInterval(() => daemon.fetchAccessories(), 5000)
})

onUnmounted(() => {
  if (pollInterval) clearInterval(pollInterval)
})
</script>

<template>
  <div class="devices-view">
    <div class="devices-toolbar">
      <div v-if="daemon.accessories.length > 0" class="toolbar-count">
        {{ daemon.accessories.length }} device{{ daemon.accessories.length !== 1 ? 's' : '' }}
      </div>
      <div class="toolbar-spacer" />
      <NbButton variant="ghost" size="sm" icon="arrows-clockwise" :loading="refreshing" @click="refresh" />
    </div>

    <div v-if="daemon.accessories.length === 0" class="empty-state">
      <NbIcon name="devices" :size="40" />
      <p>No devices registered yet.</p>
      <p class="empty-hint">
        Devices appear here once a platform plugin registers accessories.
        <br />
        This page auto-refreshes every 5 seconds — discovery can take up to 60s.
      </p>
    </div>

    <div v-else class="devices-layout">
      <!-- Device grid -->
      <div class="device-grid">
        <div
          v-for="acc in daemon.accessories"
          :key="acc.uuid"
          class="device-card"
          :class="{ selected: selected?.uuid === acc.uuid, unreachable: !acc.reachable }"
          @click="selectDevice(acc)"
        >
          <div class="device-icon" :class="{ unreachable: !acc.reachable }">
            <NbIcon :name="categoryInfo(acc.category).icon" :size="22" />
          </div>
          <div class="device-info">
            <div class="device-name">{{ deviceName(acc) }}</div>
            <div class="device-type">{{ categoryInfo(acc.category).label }}</div>
          </div>
          <div class="device-reachability" :class="acc.reachable ? 'online' : 'offline'" />
        </div>
      </div>

      <!-- Detail panel -->
      <div v-if="selected" class="device-detail">
        <div class="detail-header">
          <div class="detail-icon">
            <NbIcon :name="categoryInfo(selected.category).icon" :size="26" />
          </div>
          <div class="detail-title-wrap" style="flex: 1; min-width: 0">
            <template v-if="editingName">
              <input
                v-model="editNameValue"
                class="detail-name-input"
                autofocus
                @keydown.enter="saveEditName"
                @keydown.escape="editingName = false"
                @blur="saveEditName"
              />
            </template>
            <template v-else>
              <h2 class="detail-name" title="Click to rename" @click="startEditName">
                {{ deviceName(selected) }}
                <NbIcon name="pencil" :size="12" class="edit-icon" />
              </h2>
            </template>
            <div class="detail-type">{{ categoryInfo(selected.category).label }}</div>
          </div>
          <NbButton variant="ghost" size="sm" icon="x" @click="closeDetail" />
        </div>

        <!-- Manufacturer info -->
        <div v-if="manufacturerInfo(selected)" class="detail-section">
          <div class="section-label">Device info</div>
          <div class="info-grid">
            <template v-for="[k, v] in Object.entries(manufacturerInfo(selected)!)" :key="k">
              <span v-if="v" class="info-key">{{ k }}</span>
              <span v-if="v" class="info-val">{{ v }}</span>
            </template>
          </div>
        </div>

        <!-- Services & characteristics -->
        <div v-for="svc in mainServices(selected)" :key="svc.uuid" class="detail-section">
          <div class="section-label">{{ svc.displayName || svc.name }}</div>
          <div class="char-list">
            <div v-for="ch in svc.characteristics" :key="ch.uuid" class="char-row">
              <span class="char-name">{{ ch.name }}</span>
              <!-- Boolean writable → NbSwitch -->
              <NbSwitch
                v-if="ch.format === 'bool' && isWritable(ch)"
                :model-value="Boolean(ch.value)"
                :name="`ch-${ch.uuid}`"
                size="sm"
                variant="success"
                :disabled="writing === ch.uuid"
                @update:model-value="writeCharacteristic(selected!, svc, ch, $event)"
              />
              <!-- Non-boolean writable indicator -->
              <span v-else-if="isWritable(ch)" class="char-writable" title="Writable">
                <NbIcon name="pencil" :size="11" />
              </span>
              <span v-else class="char-value" :class="{ on: ch.format === 'bool' && ch.value }">
                {{ formatValue(ch) }}
              </span>
            </div>
          </div>
        </div>

        <div class="detail-uuid">UUID: {{ selected.uuid }}</div>
      </div>
    </div>
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
  border: 1px dashed #e8e8f0;
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
  border: 1.5px solid #e8e8f0;
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
    box-shadow: 0 2px 12px rgba(124, 58, 237, 0.15);
  }
  &.unreachable {
    opacity: 0.55;
  }
}

.device-icon {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  background: #f0eeff;
  color: #7c3aed;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  &.unreachable {
    background: #f3f4f6;
    color: #9ca3af;
  }
}

.device-info {
  flex: 1;
  min-width: 0;
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

.device-reachability {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
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
  background: #f9f9fc;
  border: 1px solid #e8e8f0;
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
  border-bottom: 1px solid #e8e8f0;
  position: sticky;
  top: 0;
  background: #f9f9fc;
}

.detail-icon {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  background: #f0eeff;
  color: #7c3aed;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.detail-name {
  font-weight: 700;
  font-size: 0.95rem;
  color: #111827;
  margin: 0;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.35rem;
  &:hover .edit-icon {
    opacity: 1;
  }
  .edit-icon {
    opacity: 0;
    color: #9ca3af;
    transition: opacity 0.15s;
  }
}

.detail-name-input {
  font-weight: 700;
  font-size: 0.95rem;
  color: #111827;
  border: 1.5px solid #a78bfa;
  border-radius: 5px;
  padding: 0.1rem 0.4rem;
  outline: none;
  width: 100%;
  background: #fff;
}

.detail-type {
  font-size: 0.75rem;
  color: #9ca3af;
}

.detail-section {
  padding: 0.85rem 1rem 0.5rem;
  border-bottom: 1px solid #e8e8f0;
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
  color: #6b7280;
  text-transform: capitalize;
}
.info-val {
  color: #111827;
  word-break: break-all;
}

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
  background: #fff;
  border: 1px solid #f0f0f8;
}

.char-name {
  flex: 1;
  color: #374151;
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
  color: #c084fc;
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
</style>
