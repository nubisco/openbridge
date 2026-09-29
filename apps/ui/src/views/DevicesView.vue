<template>
  <div class="devices-view">
    <Teleport v-if="totalDevices > 0" defer to="#ob-topbar-left">
      <span class="toolbar-count">{{ totalDevices }} device{{ totalDevices !== 1 ? 's' : '' }}</span>
      <NbBadge v-if="nativeDevices.length > 0">{{ nativeDevices.length }} native</NbBadge>
    </Teleport>

    <Teleport defer to="#ob-topbar-right">
      <NbButton
        variant="ghost"
        size="sm"
        :icon="view === 'cards' ? 'list' : 'squares-four'"
        :title="view === 'cards' ? 'Show as table' : 'Show as cards'"
        @click="toggleView"
      />
      <NbButton
        variant="ghost"
        size="sm"
        icon="arrows-clockwise"
        title="Refresh"
        :loading="refreshing"
        @click="refresh"
      />
    </Teleport>

    <div v-if="totalDevices === 0" class="empty-state">
      <NbIcon name="devices" :size="40" />
      <p>No devices registered yet.</p>
      <p class="empty-hint">
        Devices appear here once a platform plugin registers accessories.
        <br />
        This page auto-refreshes every 3 seconds: discovery can take up to 60s.
      </p>
    </div>

    <!-- An unhealthy device is marked on the device itself, not summarised
         above the list. A page-level banner here used to sit between this
         `v-if` and the `v-else` below, which silently rebound the `v-else` to
         the banner's condition and hid the entire list whenever anything was
         unhealthy: one unreachable device made the other seventeen
         unreachable too. Keep these two branches adjacent. -->

    <!-- self on the layout, not the grid: the click must land on the empty
         area around the cards, and a card click stops at the card itself. -->
    <div v-else class="devices-layout" @click.self="inspector.close()">
      <!-- Device grid -->
      <div v-if="view === 'cards'" class="device-grid" @click.self="inspector.close()">
        <!-- Native plugin devices -->
        <NbPanel
          v-for="dev in nativeDevices"
          :key="'native:' + dev.id"
          class="device-card native-card"
          :class="{ selected: selectedDeviceId === dev.id, unhealthy: isUnhealthy(dev) }"
          :title="isUnhealthy(dev) ? healthTooltip(dev) : undefined"
          @click="selectNative(dev)"
          @dblclick="openDetail(dev)"
        >
          <span class="device-card__accent" />
          <div class="device-icon native-icon">
            <NbIcon :name="widgetIcon(effectiveType(dev))" :size="22" />
          </div>
          <div class="device-info">
            <div class="device-name">
              <!-- The same `warning` icon the page banner used, kept so the
                   signal people learned there still means the same thing. -->
              <NbIcon v-if="isUnhealthy(dev)" name="warning" :size="14" class="name-health-icon" />
              <span>{{ dev.name }}</span>
            </div>
            <div class="device-type">{{ widgetLabel(effectiveType(dev)) }}</div>
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
                :name="`device-active-${dev.id}`"
                :model-value="!!dev.telemetry.active"
                @update:model-value="requestControl(dev, 'active', $event)"
              />
            </div>
            <!-- Thermostat target -->
            <div
              v-if="dev.widgetType === 'thermostat' && dev.telemetry.targetTemperature !== undefined"
              class="card-controls"
              @click.stop
            >
              <NbNumberInput
                :model-value="Number(dev.telemetry.targetTemperature)"
                size="xs"
                :min="5"
                :max="35"
                :step="1"
                @update:model-value="(v: number | null) => v !== null && sendControl(dev.id, 'targetTemperature', v)"
              />
            </div>
            <!-- Dehumidifier target -->
            <div
              v-if="dev.widgetType === 'dehumidifier' && dev.telemetry.targetHumidity !== undefined"
              class="card-controls"
              @click.stop
            >
              <NbNumberInput
                :model-value="Number(dev.telemetry.targetHumidity)"
                size="xs"
                :min="30"
                :max="80"
                :step="5"
                @update:model-value="(v: number | null) => v !== null && sendControl(dev.id, 'targetHumidity', v)"
              />
            </div>
          </div>
          <!-- Health, not plugin status. The two came apart during a real
               outage: the plugin kept running perfectly while the devices it
               polls had moved and stopped answering, so every dot stayed
               green for thirty-six hours and the failure was found in
               HomeKit instead. -->
          <div class="device-reachability" :class="healthClass(dev)" :title="dev.health?.reason ?? healthLabel(dev)" />
        </NbPanel>

        <!-- HAP / Homebridge accessories -->
        <NbPanel
          v-for="acc in daemon.accessories"
          :key="acc.uuid"
          class="device-card hap-card"
          :class="{
            selected: selectedDeviceId === acc.uuid,
            unreachable: !acc.reachable,
            unhealthy: !acc.reachable,
          }"
          :title="acc.reachable ? undefined : HAP_UNREACHABLE_TOOLTIP"
          @click="selectHap(acc)"
        >
          <div class="device-icon hap-icon" :class="{ unreachable: !acc.reachable }">
            <NbIcon :name="categoryInfo(acc.category).icon" :size="22" />
          </div>
          <div class="device-info">
            <div class="device-name">
              <NbIcon v-if="!acc.reachable" name="warning" :size="14" class="name-health-icon" />
              <span>{{ acc.displayName }}</span>
            </div>
            <div class="device-type">{{ categoryInfo(acc.category).label }}</div>
            <div v-if="hapPrimaryValue(acc)" class="device-summary">
              <span class="summary-primary">{{ hapPrimaryValue(acc) }}</span>
            </div>
            <!-- On/Off toggle for controllable accessories -->
            <div v-if="hapOnCharacteristic(acc)" class="card-controls" @click.stop>
              <NbSwitch
                :name="`hap-on-${acc.uuid}`"
                :model-value="!!hapOnCharacteristic(acc)?.value"
                @update:model-value="toggleHapCharacteristic(acc, !!$event)"
              />
            </div>
          </div>
          <div
            class="device-reachability"
            :class="acc.reachable ? 'online' : 'stale'"
            :title="acc.reachable ? 'Responding' : HAP_UNREACHABLE_TOOLTIP"
          />
        </NbPanel>
      </div>

      <NbDataTable
        v-else
        :columns="deviceColumns"
        :rows="deviceRows"
        row-key="key"
        size="sm"
        zebra
        :sort-state="sortState"
        @sort="sortState = $event"
        @row-click="(row: DeviceRow) => row.select()"
      >
        <template #cell-name="{ row }">
          <div class="cell-name" :title="row.healthTooltip || undefined">
            <NbIcon :name="row.icon" :size="16" />
            <span>{{ row.name }}</span>
            <!-- NbDataTable exposes no per-row class or data attribute, so the
                 row highlight below hangs off this icon via `:has()` rather
                 than off the row itself. Giving the table a `rowClass` prop in
                 @nubisco/ui would be the cleaner fix. -->
            <NbIcon v-if="row.unhealthy" name="warning" :size="14" class="cell-health-icon" />
          </div>
        </template>
        <template #cell-state="{ row }">
          <NbBadge v-if="row.state" :variant="row.unhealthy ? 'orange' : row.stateOn ? 'green' : 'grey'">
            {{ row.state }}
          </NbBadge>
          <span v-else>—</span>
        </template>
      </NbDataTable>
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

<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed } from 'vue'
import type { IDataTableColumn, IDataTableSortState } from '@nubisco/ui'
import { useRouter } from 'vue-router'
import { useDaemonStore } from '@/stores/daemon'
import { useInspectorStore, type NativeDevice } from '@/stores/inspector'
import { useLayoutStore } from '@/stores/layout'
import { api, type Accessory } from '@/api'

const daemon = useDaemonStore()
const inspector = useInspectorStore()

const router = useRouter()

/**
 * The dot's state.
 *
 * `unknown` is drawn the same as offline, deliberately: a device that has
 * never reported cannot be called healthy, and calling it broken would light
 * up every device for the first few seconds after a restart.
 */
/**
 * `unknown` is not counted as unhealthy here even though the dot draws it like
 * offline: every device is `unknown` for the first seconds after a restart, and
 * flagging the whole estate on every restart would teach people to ignore the
 * flag. Only `stale` means the device was answering and stopped.
 */
function isUnhealthy(dev: NativeDevice): boolean {
  return dev.health?.status === 'stale'
}

/** How long a device has been silent, in the roughest unit that still reads. */
function silentFor(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} seconds`
  if (seconds < 5400) return `${Math.round(seconds / 60)} minutes`
  if (seconds < 172800) return `${Math.round(seconds / 3600)} hours`
  return `${Math.round(seconds / 86400)} days`
}

/**
 * What to say on hover about a device that is not answering.
 *
 * The banner this replaces only stated the fact, which left nothing to act on.
 * Everything useful is already known here: when it was last heard from and what
 * the plugin reported. The rest (its address, its telemetry, its recent events)
 * is one click away in the inspector, so the hover says so.
 */
function healthTooltip(dev: NativeDevice): string {
  const h = dev.health
  if (!h || h.status !== 'stale') return ''

  const lines = ['Not responding']
  if (h.silentForSeconds !== null) lines.push(`Silent for ${silentFor(h.silentForSeconds)}.`)
  else if (h.lastSeen) lines.push(`Last seen ${new Date(h.lastSeen).toLocaleString()}.`)
  if (h.reason) lines.push(h.reason)
  lines.push(
    'OpenBridge is running: the device itself is not answering. Check it is powered and reachable at its configured address.',
    'Click to open it for its address, readings and recent events.',
  )
  return lines.join('\n')
}

/**
 * HomeKit accessories report a bare reachable flag with no reason attached, so
 * this is all that can honestly be said about one.
 */
const HAP_UNREACHABLE_TOOLTIP = [
  'Not responding',
  'HomeKit reports this accessory as unreachable. Check it is powered and on the network.',
  'Click to open it for its services and characteristics.',
].join('\n')

function healthClass(dev: NativeDevice): string {
  const status = dev.health?.status
  if (status === 'ok') return 'online'
  if (status === 'stale') return 'stale'
  return 'offline'
}

function healthLabel(dev: NativeDevice): string {
  const status = dev.health?.status
  if (status === 'ok') return 'Responding'
  if (status === 'stale') return 'Not responding'
  return 'No data yet'
}

/**
 * Double-click opens the device's own page. Single click keeps its existing
 * meaning (select and show the inspector), so nothing users already do changes.
 */
function openDetail(dev: NativeDevice) {
  router.push({ name: 'device-detail', params: { id: dev.id } })
}
const layout = useLayoutStore()

// ─── HAP accessories (existing) ──────────────────────────────────────────────
const refreshing = ref(false)

// ─── Native devices ──────────────────────────────────────────────────────────
const nativeDevices = ref<NativeDevice[]>([])

// ─── Card / table presentation ──────────────────────────────────────────────
// A viewing preference, so it belongs to the user rather than to the session.
// Kept separate from the plugins view's key: the two lists are browsed for
// different reasons and a table there does not imply a table here.
const VIEW_KEY = 'openbridge.devices.view'
const view = ref<'cards' | 'table'>(localStorage.getItem(VIEW_KEY) === 'table' ? 'table' : 'cards')

function toggleView() {
  view.value = view.value === 'cards' ? 'table' : 'cards'
  localStorage.setItem(VIEW_KEY, view.value)
}

const sortState = ref<IDataTableSortState | null>({ key: 'name', direction: 'asc' })

const deviceColumns: IDataTableColumn[] = [
  { key: 'name', header: 'Device', sortable: true },
  { key: 'type', header: 'Type', sortable: true, width: 160 },
  { key: 'source', header: 'Source', sortable: true, width: 120 },
  { key: 'state', header: 'State', sortable: true, width: 120 },
  { key: 'detail', header: 'Reading', sortable: true, width: 160 },
]

// NbDataTable is generic over `T extends Record<string, unknown>`, so a row
// interface needs an index signature to be assignable. Without it the rows,
// the row-click handler and every cell slot fall back to `unknown`.
// (@nubisco/ui 4.1.2; only visible once the plugin emits components.d.ts.)
interface DeviceRow {
  [key: string]: unknown
  key: string
  name: string
  type: string
  source: string
  state: string
  stateOn: boolean
  detail: string
  icon: string
  unhealthy: boolean
  healthTooltip: string
  select: () => void
}

const deviceRows = computed<DeviceRow[]>(() => {
  const rows: DeviceRow[] = [
    ...nativeDevices.value.map((dev) => ({
      key: 'native:' + dev.id,
      name: dev.name,
      type: widgetLabel(effectiveType(dev)),
      source: 'Native',
      state: dev.telemetry.active === undefined ? '' : dev.telemetry.active ? 'On' : 'Off',
      stateOn: !!dev.telemetry.active,
      detail: nativeSummary(dev),
      icon: widgetIcon(effectiveType(dev)),
      unhealthy: isUnhealthy(dev),
      healthTooltip: healthTooltip(dev),
      select: () => selectNative(dev),
    })),
    ...daemon.accessories.map((acc) => {
      const on = hapOnCharacteristic(acc)
      return {
        key: 'hap:' + acc.uuid,
        name: acc.displayName,
        type: categoryInfo(acc.category).label,
        source: 'HomeKit',
        state: acc.reachable ? (on ? (on.value ? 'On' : 'Off') : '') : 'Not responding',
        stateOn: acc.reachable && !!on?.value,
        detail: hapPrimaryValue(acc) ?? '',
        icon: categoryInfo(acc.category).icon,
        unhealthy: !acc.reachable,
        healthTooltip: acc.reachable ? '' : HAP_UNREACHABLE_TOOLTIP,
        select: () => selectHap(acc),
      }
    }),
  ]

  const sort = sortState.value
  if (!sort || sort.direction === 'none') return rows
  const dir = sort.direction === 'asc' ? 1 : -1
  return [...rows].sort(
    (a, b) =>
      dir * String(a[sort.key as keyof DeviceRow] ?? '').localeCompare(String(b[sort.key as keyof DeviceRow] ?? '')),
  )
})

/** The one number worth showing for a device in a single table cell. */
function nativeSummary(dev: NativeDevice): string {
  const t = dev.telemetry
  if (dev.widgetType === 'energy_meter' && t.power !== undefined) return `${fmtNum(t.power, 1)} W`
  if (dev.widgetType === 'thermostat' && t.currentTemperature !== undefined) {
    return `${fmtNum(t.currentTemperature, 1)}°C`
  }
  if (dev.widgetType === 'dehumidifier' && t.currentHumidity !== undefined) return `${fmtNum(t.currentHumidity, 0)}%`
  if (t.power !== undefined) return `${fmtNum(t.power, 1)} W`
  return ''
}

/**
 * The type to show for a device: its HomeKit override when one is set,
 * otherwise the widget type its plugin declared. Without this a relay retyped
 * to a light would still read "Switch" here while the inspector said Light.
 */
function effectiveType(dev: NativeDevice): string {
  return (dev as unknown as { homekitType?: string }).homekitType || dev.widgetType
}

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
  5: { label: 'Light', icon: 'lightbulb' },
  6: { label: 'Lock', icon: 'lock' },
  7: { label: 'Outlet', icon: 'plugs' },
  8: { label: 'Switch', icon: 'toggle-right' },
  9: { label: 'Thermostat', icon: 'thermometer' },
  // 'activity' is not in the icon catalogue (it never was, in 3.x either):
  // it silently rendered nothing, and @nubisco/ui 4.x throws on an unresolved
  // name, so this is now 'pulse'. Registered in src/icons.ts.
  10: { label: 'Sensor', icon: 'pulse' },
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
  light: 'lightbulb',
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
  // Cameras arrived as native devices when the camera platform stopped going
  // through the Homebridge compatibility layer. As HAP accessories they had
  // been drawn from CATEGORY_INFO, so nothing here covered them and all three
  // fell through to the generic cube. 'camera' is already registered in
  // src/icons.ts for HomeKit category 17.
  camera: 'camera',
}

const WIDGET_LABEL: Record<string, string> = {
  camera: 'Camera',
  switch: 'Switch',
  light: 'Light',
  thermostat: 'Thermostat',
  dehumidifier: 'Dehumidifier',
  energy_meter: 'Energy Meter',
  gate: 'Gate',
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
  // A faulted accessory still carries its last good reading, so rendering it
  // verbatim is how a dead bulb came to claim it was switched off. Say what is
  // actually known instead.
  if (!acc.reachable) return 'Not responding'

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

/**
 * Both lists, every tick.
 *
 * Only the native list used to be polled, so anything arriving through the
 * Homebridge compatibility layer (every WiZ bulb, every camera) was fetched
 * once on mount and then frozen until the page was reloaded or the refresh
 * button pressed. Turning a light on elsewhere never showed up, which read as
 * the bridge having missed the change rather than the page having stopped
 * asking. Both are served from memory in the daemon, so this costs no device
 * traffic.
 */
async function poll() {
  await Promise.all([daemon.fetchAccessories(), fetchNativeDevices()])

  // fetchNativeDevices does this for its own kind. An open inspector holds the
  // object it was given, so without the same step for HAP it would keep showing
  // the reading from whenever it was opened.
  if (inspector.mode === 'device' && inspector.selectedDevice?.kind === 'hap') {
    const selectedUuid = inspector.selectedDevice.acc.uuid
    const updated = daemon.accessories.find((a) => a.uuid === selectedUuid)
    if (updated) inspector.updateDevice({ kind: 'hap', acc: updated })
  }
}

onMounted(async () => {
  layout.setPage('Devices')
  await poll()
  pollInterval = setInterval(poll, 3000)
})

onUnmounted(() => {
  if (pollInterval) clearInterval(pollInterval)
})
</script>

<style lang="scss" scoped>
.devices-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

// Teleported next to the breadcrumb in the shell topbar.
.toolbar-count {
  font-size: 0.8rem;
  color: var(--nb-c-text-muted);
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  padding: 4rem 2rem;
  color: var(--nb-c-text-subtle);
  text-align: center;
  border: 1px dashed var(--nb-c-border);
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

.cell-name {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.cell-health-icon {
  color: var(--nb-c-warning);
  flex-shrink: 0;
}

// Table equivalent of the card's warning border. NbDataTable takes no row
// class and puts no key on the <tr>, so the row is selected by the health icon
// our own name-cell slot renders into it. Worth replacing with a `rowClass`
// prop on the shared table rather than leaning on `:has()` long term.
:deep(.nb-data-table__row:has(.cell-health-icon)) {
  background: color-mix(in srgb, var(--nb-c-warning) 8%, transparent);
  box-shadow: inset 3px 0 0 0 var(--nb-c-warning);
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

// NbPanel supplies the surface, border and layer: the same primitive the
// plugin cards use, so the two pages read as one system. Only selection,
// the native/HAP accent and the inner rhythm live here.
.device-card {
  position: relative;
  overflow: hidden;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.5rem;
  transition:
    border-color 0.15s,
    background 0.15s;

  &:hover {
    background: var(--nb-c-surface-hover);
  }
  &.selected {
    border-color: var(--nb-c-primary);
    box-shadow: 0 0 0 1px var(--nb-c-primary);
  }
  &.unreachable {
    opacity: 0.55;
  }

  // Warning, not danger, matching the dot: a device that has stopped answering
  // is usually a network or power problem outside OpenBridge and is often
  // transient. The card stays fully interactive, because its inspector holds
  // the address and the recent events needed to fix it.
  //
  // Placed after `.selected` so selecting an unhealthy device still shows the
  // selection colour rather than leaving the two competing for the border.
  &.unhealthy:not(.selected) {
    border-color: var(--nb-c-warning);
    box-shadow: inset 3px 0 0 0 var(--nb-c-warning);
  }

  // An unreachable HAP card dims to 0.55, which would take the warning border
  // down with it. The mark has to stay legible.
  &.unhealthy {
    opacity: 1;
  }
}

.name-health-icon {
  color: var(--nb-c-warning);
  flex-shrink: 0;
}

// Marks a device served by a native OpenBridge plugin, mirroring the status
// accent on the plugin cards.
.device-card__accent {
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
  background: var(--nb-c-primary);
}

.device-icon {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--nb-c-primary) 12%, var(--nb-c-surface));
  color: var(--nb-c-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  &.unreachable {
    background: var(--nb-c-layer-1);
    color: var(--nb-c-text-subtle);
  }
  &.native-icon {
    background: color-mix(in srgb, var(--nb-c-primary) 12%, var(--nb-c-surface));
    color: var(--nb-c-primary);
  }
  &.hap-icon {
    background: var(--nb-c-layer-1);
    color: var(--nb-c-text-muted);
  }
}

.device-info {
  flex: 1;
  min-width: 0;
  width: 100%;
}
.device-name {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  min-width: 0;
  font-weight: 600;
  font-size: 0.875rem;
  color: var(--nb-c-text);

  // Truncation belongs to the text now that the name can carry a health icon.
  // Left on the container, the ellipsis would eat the icon before the name.
  > span {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
}
.device-type {
  font-size: 0.74rem;
  color: var(--nb-c-text-subtle);
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
  color: var(--nb-c-text);
}
.summary-secondary {
  font-size: 0.72rem;
  color: var(--nb-c-text-subtle);
}
.summary-status {
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  &.on {
    background: color-mix(in srgb, var(--nb-c-success) 30%, var(--nb-c-surface));
    color: var(--nb-c-success);
  }
  &.off {
    background: var(--nb-c-layer-1);
    color: var(--nb-c-text-subtle);
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
    background: var(--nb-c-success);
  }
  // Warning rather than danger: the device is not answering, which is usually
  // a network or power problem outside OpenBridge and is often transient. A
  // red dot on a gate that is merely slow to answer teaches people to ignore
  // the colour, and then it cannot report the outage that matters.
  &.stale {
    background: var(--nb-c-warning);
  }
  &.offline {
    background: var(--nb-c-border);
  }
}

// ─── Card controls ─────────────────────────────────────────────────────────────
.card-controls {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.5rem;
}
// ─── Confirmation dialog ──────────────────────────────────────────────────────
.confirm-overlay {
  position: fixed;
  inset: 0;
  background: var(--nb-c-scrim);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.confirm-dialog {
  background: var(--nb-c-surface);
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
  background: color-mix(in srgb, var(--nb-c-warning) 30%, var(--nb-c-surface));
  color: var(--nb-c-warning);
  display: flex;
  align-items: center;
  justify-content: center;
}
.confirm-message {
  font-size: 0.85rem;
  color: var(--nb-c-text);
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
