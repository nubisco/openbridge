<template>
  <div class="devices-view">
    <component :is="topbarRight.Outlet">
      <NbButton
        v-nb-tooltip="{ body: viewToggleLabel }"
        variant="ghost"
        size="sm"
        :icon="view === 'cards' ? 'list' : 'squares-four'"
        :aria-label="viewToggleLabel"
        @click="toggleView"
      />
      <NbButton
        v-nb-tooltip="{ body: 'Refresh devices' }"
        variant="ghost"
        size="sm"
        icon="arrows-clockwise"
        aria-label="Refresh devices"
        :loading="refreshing"
        @click="refresh"
      />
    </component>

    <NbEmptyState
      v-if="totalDevices === 0"
      icon="devices"
      bordered
      title="No devices registered yet"
      description="Devices appear here once a platform plugin registers accessories. This page refreshes every 3 seconds, and discovery can take up to 60 seconds."
    />

    <!-- An unhealthy device is marked on the device itself, not summarised
         above the list. A page-level banner here used to sit between this
         `v-if` and the `v-else` below, which silently rebound the `v-else` to
         the banner's condition and hid the entire list whenever anything was
         unhealthy: one unreachable device made the other seventeen
         unreachable too. Keep these two branches adjacent. -->

    <!-- self on the layout, not the grid: the click must land on the empty
         area around the cards, and a card click stops at the card itself. -->
    <div v-else class="devices-layout" @click.self="inspector.close()">
      <!-- The cards are peers, so they are flat tiles on the page ground, not
           each a raised region. NbCard draws the title, the support line, the
           hover and the selection. Only health and the reading live here. -->
      <NbCardGrid v-if="view === 'cards'" min="200px" gap="md" @click.self="inspector.close()">
        <!-- Native plugin devices -->
        <NbCard
          v-for="dev in nativeDevices"
          :key="'native:' + dev.id"
          v-nb-tooltip="isUnhealthy(dev) ? cardTooltip(healthTooltip(dev)) : {}"
          flat
          clickable
          :orientation="phone ? 'horizontal' : 'vertical'"
          class="device-card"
          :class="{ unhealthy: isUnhealthy(dev) }"
          :icon="widgetIcon(effectiveType(dev))"
          :description="widgetLabel(effectiveType(dev))"
          :selected="selectedDeviceId === dev.id"
          @select="selectNative(dev)"
          @dblclick="openDetail(dev)"
        >
          <template #title>
            <span class="device-name">
              <!-- The same `warning` icon the page banner used, kept so the
                   signal people learned there still means the same thing. -->
              <NbIcon v-if="isUnhealthy(dev)" name="warning" size="sm" class="name-health-icon" />
              <span>{{ dev.name }}</span>
            </span>
          </template>
          <!-- Health, not plugin status. The two came apart during a real
               outage: the plugin kept running perfectly while the devices it
               polls had moved and stopped answering, so every dot stayed
               green for thirty-six hours and the failure was found in
               HomeKit instead. -->
          <template #meta>
            <span
              class="device-reachability"
              :class="healthClass(dev)"
              role="img"
              :aria-label="healthLabel(dev)"
              :title="dev.health?.reason ?? healthLabel(dev)"
            />
          </template>

          <!-- The reading: the one figure the card is for. -->
          <div class="device-summary">
            <template v-if="dev.widgetType === 'energy_meter' && dev.telemetry.power !== undefined">
              <span class="summary-primary type-heading-02 tabular">{{ fmtNum(dev.telemetry.power, 1) }} W</span>
            </template>
            <template v-else-if="dev.widgetType === 'thermostat' && dev.telemetry.currentTemperature !== undefined">
              <span class="summary-primary type-heading-02 tabular">
                {{ fmtNum(dev.telemetry.currentTemperature, 1) }}°C
              </span>
              <span v-if="dev.telemetry.targetTemperature !== undefined" class="type-body-sm tabular">
                target {{ fmtNum(dev.telemetry.targetTemperature, 1) }}°C
              </span>
            </template>
            <template v-else-if="dev.widgetType === 'dehumidifier' && dev.telemetry.currentHumidity !== undefined">
              <span class="summary-primary type-heading-02 tabular">
                {{ fmtNum(dev.telemetry.currentHumidity, 0) }}%
              </span>
            </template>
            <!-- Active state for switch/light -->
            <NbBadge
              v-else-if="dev.telemetry.active !== undefined"
              size="sm"
              :variant="dev.telemetry.active ? 'success' : 'neutral'"
            >
              {{ dev.telemetry.active ? 'On' : 'Off' }}
            </NbBadge>
          </div>

          <template v-if="hasControls(dev)" #footer>
            <!-- The card is a button: clicks and keys on its controls stop
                 here, or Space on the switch would also open the inspector. -->
            <div class="card-controls" @click.stop @keydown.stop @dblclick.stop>
              <!-- On/off toggle for all controllable devices -->
              <NbSwitch
                v-if="dev.telemetry.active !== undefined"
                :name="`device-active-${dev.id}`"
                :model-value="!!dev.telemetry.active"
                :label="dev.name"
                hide-label
                @update:model-value="requestControl(dev, 'active', $event)"
              />
              <!-- Thermostat target -->
              <NbNumberInput
                v-if="dev.widgetType === 'thermostat' && dev.telemetry.targetTemperature !== undefined"
                :model-value="Number(dev.telemetry.targetTemperature)"
                size="xs"
                :min="5"
                :max="35"
                :step="1"
                @update:model-value="(v: number | null) => v !== null && sendControl(dev.id, 'targetTemperature', v)"
              />
              <!-- Dehumidifier target -->
              <NbNumberInput
                v-if="dev.widgetType === 'dehumidifier' && dev.telemetry.targetHumidity !== undefined"
                :model-value="Number(dev.telemetry.targetHumidity)"
                size="xs"
                :min="30"
                :max="80"
                :step="5"
                @update:model-value="(v: number | null) => v !== null && sendControl(dev.id, 'targetHumidity', v)"
              />
            </div>
          </template>
        </NbCard>

        <!-- HAP / Homebridge accessories. The source goes in the support line,
             since a native device is the norm and this is the exception. -->
        <NbCard
          v-for="acc in daemon.accessories"
          :key="acc.uuid"
          v-nb-tooltip="acc.reachable ? {} : cardTooltip(HAP_UNREACHABLE_TOOLTIP)"
          flat
          clickable
          :orientation="phone ? 'horizontal' : 'vertical'"
          class="device-card"
          :class="{ unhealthy: !acc.reachable }"
          :icon="categoryInfo(acc.category).icon"
          :description="`${categoryInfo(acc.category).label} · HomeKit`"
          :selected="selectedDeviceId === acc.uuid"
          @select="selectHap(acc)"
        >
          <template #title>
            <span class="device-name">
              <NbIcon v-if="!acc.reachable" name="warning" size="sm" class="name-health-icon" />
              <span>{{ acc.displayName }}</span>
            </span>
          </template>
          <template #meta>
            <span
              class="device-reachability"
              :class="acc.reachable ? 'online' : 'stale'"
              role="img"
              :aria-label="acc.reachable ? 'Responding' : 'Not responding'"
              :title="acc.reachable ? 'Responding' : HAP_UNREACHABLE_TOOLTIP"
            />
          </template>

          <div v-if="hapPrimaryValue(acc)" class="device-summary">
            <span class="summary-primary type-heading-02 tabular">{{ hapPrimaryValue(acc) }}</span>
          </div>

          <template v-if="hapOnCharacteristic(acc)" #footer>
            <div class="card-controls" @click.stop @keydown.stop>
              <NbSwitch
                :name="`hap-on-${acc.uuid}`"
                :model-value="!!hapOnCharacteristic(acc)?.value"
                :label="acc.displayName"
                hide-label
                @update:model-value="toggleHapCharacteristic(acc, !!$event)"
              />
            </div>
          </template>
        </NbCard>
      </NbCardGrid>

      <NbDataTable
        v-else
        :columns="deviceColumns"
        :rows="deviceRows"
        row-key="key"
        size="sm"
        zebra
        stack-on-phone
        :sort-state="sortState"
        @sort="sortState = $event"
        @row-click="(row: DeviceRow) => row.select()"
      >
        <template #cell-name="{ row }">
          <div class="cell-name" :title="row.healthTooltip || undefined">
            <NbIcon :name="row.icon" size="sm" />
            <span>{{ row.name }}</span>
            <!-- NbDataTable exposes no per-row class or data attribute, so the
                 row highlight below hangs off this icon via `:has()` rather
                 than off the row itself. Giving the table a `rowClass` prop in
                 @nubisco/ui would be the cleaner fix. -->
            <NbIcon v-if="row.unhealthy" name="warning" size="sm" class="cell-health-icon" />
          </div>
        </template>
        <template #cell-state="{ row }">
          <NbBadge v-if="row.state" :variant="row.unhealthy ? 'warning' : row.stateOn ? 'success' : 'neutral'">
            {{ row.state }}
          </NbBadge>
          <span v-else>—</span>
        </template>
        <template #cell-detail="{ row }">
          <span class="tabular">{{ row.detail }}</span>
        </template>
      </NbDataTable>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed, watch } from 'vue'
import {
  useConfirm,
  usePhoneLayout,
  type IDataTableColumn,
  type IDataTableSortState,
  type ITooltipOptions,
  useShellSlot,
} from '@nubisco/ui'
import { useRouter } from 'vue-router'
import { useDaemonStore } from '@/stores/daemon'
import { useInspectorStore, type NativeDevice } from '@/stores/inspector'
import { useLayoutStore } from '@/stores/layout'
import { api, type Accessory } from '@/api'
// Controls this view puts in the shell topbar. Only on the right: the left
// is the frame's trail, and the device count rides on it through setPage, the
// same way the plugins page carries its own.
const topbarRight = useShellSlot('topbar-right')

// On a phone the grid is one column, so each card turns on its side: the icon
// beside the name rather than above it, and a list of tiles to scan.
const { phone } = usePhoneLayout()

const daemon = useDaemonStore()
const inspector = useInspectorStore()
const confirm = useConfirm()

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

/**
 * The same text for a card, as a library tooltip rather than the native
 * `title`: NbPanel has a `title` prop since @nubisco/ui 5.48, which drew this
 * text as the card's heading. Not on touch, where a tap selects the card.
 */
function cardTooltip(text: string): ITooltipOptions {
  const [header, ...rest] = text.split('\n')
  return { header, body: rest.join(' '), touch: false }
}

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

const viewToggleLabel = computed(() => (view.value === 'cards' ? 'Show as table' : 'Show as cards'))

function toggleView() {
  view.value = view.value === 'cards' ? 'table' : 'cards'
  localStorage.setItem(VIEW_KEY, view.value)
}

const sortState = ref<IDataTableSortState | null>({ key: 'name', direction: 'asc' })

const deviceColumns: IDataTableColumn[] = [
  // On a phone each row is a card: the name is its title, and type and source
  // share the muted line under it, as they read together ("Light, Native").
  { key: 'name', header: 'Device', sortable: true, primary: true },
  { key: 'type', header: 'Type', sortable: true, width: 160, phoneMeta: true },
  { key: 'source', header: 'Source', sortable: true, width: 120, phoneMeta: true },
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

/** Whether a native card has anything to operate in its footer. */
function hasControls(dev: NativeDevice): boolean {
  const t = dev.telemetry
  return (
    t.active !== undefined ||
    (dev.widgetType === 'thermostat' && t.targetTemperature !== undefined) ||
    (dev.widgetType === 'dehumidifier' && t.targetHumidity !== undefined)
  )
}

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

interface ControlConfirmation {
  title: string
  message: string
  confirmLabel: string
  tone: 'danger' | 'neutral'
}

function requiresConfirmation(dev: NativeDevice, control: string, value: unknown): ControlConfirmation | false {
  // Energy meters / circuit breakers are safety-critical
  if (dev.widgetType === 'energy_meter' && control === 'active') {
    // Cutting power is the destructive one. Energising is consequential but
    // not destructive, so it gets the primary button the old dialog had.
    if (value) {
      return {
        title: 'Turn on circuit',
        message: 'This will energise the connected circuit.',
        confirmLabel: 'Turn on',
        tone: 'neutral',
      }
    }
    return {
      title: 'Turn off circuit',
      message: 'This will cut power to the connected circuit.',
      confirmLabel: 'Turn off',
      tone: 'danger',
    }
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

async function requestControl(dev: NativeDevice, control: string, value: unknown) {
  const ask = requiresConfirmation(dev, control, value)
  if (ask) {
    const ok = await confirm({ ...ask, subjectLabel: 'Device', subject: dev.name })
    if (!ok) return
  }
  void sendControl(dev.id, control, value)
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

// The count is the frame's, beside the page name, as on the plugins page. It
// used to sit in the topbar's left slot with a "native" badge, but that slot
// is the trail and nothing else. The source is on each HomeKit card's support
// line and in the table's Source column instead.
watch(
  totalDevices,
  (n) => {
    // Hidden at zero, as before: the empty state already says there are none.
    layout.setPage('Devices', n > 0 ? n : undefined)
  },
  { immediate: true },
)

onMounted(async () => {
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

.cell-name {
  display: flex;
  align-items: center;
  gap: var(--nb-spacing-8);
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
}

// Warning, not danger, matching the dot: a device that has stopped answering
// is usually a network or power problem outside OpenBridge and is often
// transient. The card stays fully interactive, because its inspector holds
// the address and the recent events needed to fix it.
//
// Not on a selected card, so selecting an unhealthy device still shows the
// selection edge rather than leaving the two competing for the border.
.device-card.unhealthy:not(.nb-card--selected) {
  border-color: var(--nb-c-warning);
  box-shadow: inset 3px 0 0 0 var(--nb-c-warning);
}

.device-name {
  display: flex;
  align-items: center;
  gap: var(--nb-spacing-4);
  min-width: 0;

  // Truncation belongs to the text now that the name can carry a health icon.
  // Left on the container, the ellipsis would eat the icon before the name.
  > span {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
}

.name-health-icon {
  color: var(--nb-c-warning);
  flex-shrink: 0;
}

// The reading, then its qualifier ("target 20.0°C") on the same baseline.
.device-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--nb-spacing-8);
}

.summary-primary {
  color: var(--nb-c-text);
}

.device-reachability {
  display: block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
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

.card-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--nb-spacing-8);
  width: 100%;
}
</style>
