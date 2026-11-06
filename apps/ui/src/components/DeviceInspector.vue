<template>
  <div v-if="selected" class="inspector-content nb-inspector">
    <!-- Native device detail -->
    <template v-if="selected.kind === 'native'">
      <!-- The inspector's own pinned header. It is not a page, so it does not
           take NbPageHeader: the name stays in reach while the sections scroll. -->
      <div class="detail-header">
        <div class="detail-icon">
          <NbIcon :name="widgetIcon(effectiveType((selected as any).dev))" size="lg" />
        </div>
        <div class="detail-heading">
          <div v-if="!editingName" class="detail-title-row">
            <h2
              class="detail-name type-heading-01"
              title="Click to rename"
              @click="startRename((selected as any).dev.name)"
            >
              {{ (selected as any).dev.name }}
            </h2>
            <NbButton
              v-nb-tooltip="{ body: 'Rename' }"
              variant="ghost"
              size="sm"
              icon="pencil-simple"
              :aria-label="`Rename ${(selected as any).dev.name}`"
              @click="startRename((selected as any).dev.name)"
            />
          </div>
          <div v-else class="rename-row">
            <NbTextInput
              v-model="renameValue"
              size="sm"
              @keyup.enter="saveRename((selected as any).dev.id)"
              @keyup.escape="editingName = false"
            />
            <NbButton
              v-nb-tooltip="{ body: 'Save name' }"
              variant="primary"
              size="sm"
              icon="check"
              aria-label="Save name"
              @click="saveRename((selected as any).dev.id)"
            />
            <NbButton
              v-nb-tooltip="{ body: 'Cancel rename' }"
              variant="ghost"
              size="sm"
              icon="x"
              aria-label="Cancel rename"
              @click="editingName = false"
            />
          </div>
          <div class="detail-type type-body-sm">{{ widgetLabel(effectiveType((selected as any).dev)) }}</div>
        </div>
      </div>

      <!-- Device info -->
      <NbShellPanel title="Device info" fluid>
        <!-- Actions sit in the header of the thing they act on, and only the
             ones this device's plugin actually declared are rendered: a reboot
             is spelled differently on a Shelly Gen1 and Gen2 and does not
             exist at all on a Wiz bulb, so the product cannot hard-code one.
             A destructive one is outlined danger: the confirmation it opens
             carries the filled one. -->
        <template v-if="deviceActions.length > 0" #toolbar>
          <NbButton
            v-for="action in deviceActions"
            :key="action.id"
            size="xs"
            :variant="action.danger ? 'danger' : 'ghost'"
            :outlined="!!action.danger"
            :disabled="actionBusy !== ''"
            :loading="actionBusy === action.id"
            @click="runDeviceAction(action)"
          >
            {{ action.label }}
          </NbButton>
        </template>
        <!-- The reason, where someone looking at a device that is misbehaving
             will actually look. The dot on the card says something is wrong;
             this says what, and when it was last heard from. -->
        <NbBanner
          v-if="deviceHealth && deviceHealth.status === 'stale'"
          status="warning"
          :title="healthTitle"
          class="section-banner"
        >
          {{ deviceHealth.reason }}
        </NbBanner>
        <NbBanner v-if="actionNotice" :status="actionStatus" :title="actionNotice" class="section-banner" />
        <NbDefinitionList compact>
          <NbDefinitionListItem term="Plugin">{{ (selected as any).dev.pluginId }}</NbDefinitionListItem>
          <NbDefinitionListItem v-if="(selected as any).dev.manufacturer" term="Manufacturer">
            {{ (selected as any).dev.manufacturer }}
          </NbDefinitionListItem>
          <NbDefinitionListItem v-if="(selected as any).dev.model" term="Model">
            {{ (selected as any).dev.model }}
          </NbDefinitionListItem>
          <NbDefinitionListItem term="Status">{{ (selected as any).dev.pluginStatus }}</NbDefinitionListItem>
          <NbDefinitionListItem term="ID">
            <code class="detail-code type-code-sm">{{ (selected as any).dev.id }}</code>
          </NbDefinitionListItem>
        </NbDefinitionList>
      </NbShellPanel>

      <!-- Widget view -->
      <NbShellPanel title="State" fluid>
        <!-- Energy meter widget: the power is the reading people open it for,
             so it is the one large figure, and the rest are facts under it. -->
        <div v-if="(selected as any).dev.widgetType === 'energy_meter'" class="widget-energy">
          <div class="energy-primary">
            <span class="type-heading-04 tabular">{{ fmtNum((selected as any).dev.telemetry.power, 1) }}</span>
            <span class="reading-unit type-body-md">W</span>
          </div>
          <NbDefinitionList compact>
            <NbDefinitionListItem v-if="(selected as any).dev.telemetry.voltage !== undefined" term="Voltage">
              <span class="tabular">{{ fmtNum((selected as any).dev.telemetry.voltage, 1) }} V</span>
            </NbDefinitionListItem>
            <NbDefinitionListItem v-if="(selected as any).dev.telemetry.current !== undefined" term="Current">
              <span class="tabular">{{ fmtNum((selected as any).dev.telemetry.current, 3) }} A</span>
            </NbDefinitionListItem>
          </NbDefinitionList>
        </div>

        <!-- Thermostat widget -->
        <NbDefinitionList v-else-if="(selected as any).dev.widgetType === 'thermostat'" compact>
          <NbDefinitionListItem term="Current">
            <span class="tabular">{{ fmtNum((selected as any).dev.telemetry.currentTemperature, 1) }}°C</span>
          </NbDefinitionListItem>
          <NbDefinitionListItem term="Target">
            <span class="tabular">{{ fmtNum((selected as any).dev.telemetry.targetTemperature, 1) }}°C</span>
          </NbDefinitionListItem>
          <NbDefinitionListItem term="Active">
            <span :class="(selected as any).dev.telemetry.active ? 'state-on' : 'state-off'">
              {{ (selected as any).dev.telemetry.active ? 'On' : 'Off' }}
            </span>
          </NbDefinitionListItem>
        </NbDefinitionList>

        <!-- Dehumidifier widget -->
        <NbDefinitionList v-else-if="(selected as any).dev.widgetType === 'dehumidifier'" compact>
          <NbDefinitionListItem term="Humidity">
            <span class="tabular">{{ fmtNum((selected as any).dev.telemetry.currentHumidity, 0) }}%</span>
          </NbDefinitionListItem>
          <NbDefinitionListItem term="Target">
            <span class="tabular">{{ fmtNum((selected as any).dev.telemetry.targetHumidity, 0) }}%</span>
          </NbDefinitionListItem>
          <NbDefinitionListItem term="Active">
            <span :class="(selected as any).dev.telemetry.active ? 'state-on' : 'state-off'">
              {{ (selected as any).dev.telemetry.active ? 'On' : 'Off' }}
            </span>
          </NbDefinitionListItem>
        </NbDefinitionList>

        <!-- Generic sensor / switch / light -->
        <template v-else>
          <p v-if="telemetryEntries((selected as any).dev).length === 0" class="quiet-note type-body-sm">
            No telemetry yet
          </p>
          <NbDefinitionList v-else compact>
            <NbDefinitionListItem v-for="[k, v] in telemetryEntries((selected as any).dev)" :key="k" :term="k">
              <span class="tabular">{{ String(v) }}</span>
            </NbDefinitionListItem>
          </NbDefinitionList>
        </template>
      </NbShellPanel>

      <!-- Recent activity: what happened, and what asked for it. Shown only
           when the device has actually recorded something, so it does not sit
           empty on every device whose plugin never calls recordEvent. -->
      <NbShellPanel v-if="deviceEvents.length > 0" title="Recent activity" fluid>
        <ul class="event-list">
          <li v-for="(event, i) in deviceEvents" :key="`${event.at}-${i}`" class="event">
            <span class="event-time type-body-sm tabular" :title="event.at">{{ shortTime(event.at) }}</span>
            <span class="event-body">
              <span class="event-message type-body-compact">{{ event.message }}</span>
              <span v-if="event.source" class="event-source type-body-sm">{{ event.source }}</span>
            </span>
          </li>
        </ul>
      </NbShellPanel>

      <!-- Energy history chart (energy_meter devices only) -->
      <NbShellPanel v-if="(selected as any).dev.widgetType === 'energy_meter'" title="Energy history" fluid>
        <!-- Period tabs -->
        <NbTabs
          :model-value="historyPeriod"
          :items="HISTORY_PERIODS"
          variant="contained"
          size="sm"
          full-width
          aria-label="Energy history period"
          class="history-tabs"
          @update:model-value="(id: string) => (historyPeriod = id as THistoryPeriod)"
        />

        <!-- Total + navigation -->
        <div v-if="historyData" class="history-nav">
          <NbButton
            v-nb-tooltip="{ body: 'Previous period' }"
            variant="ghost"
            size="sm"
            icon="caret-left"
            aria-label="Previous period"
            @click="navigateHistory(-1)"
          />
          <div class="history-nav-center">
            <span class="history-total">
              <span class="type-heading-02 tabular">{{ historyData.totalKwh.toFixed(2) }}</span>
              <span class="reading-unit type-body-sm">kWh</span>
            </span>
            <span class="history-date type-body-sm tabular">{{ historyData.date }}</span>
          </div>
          <NbButton
            v-nb-tooltip="{ body: 'Next period' }"
            variant="ghost"
            size="sm"
            icon="caret-right"
            aria-label="Next period"
            @click="navigateHistory(1)"
          />
        </div>

        <!-- Bar chart -->
        <NbBarChart
          v-if="historyData && historyData.totalKwh > 0"
          :series="historyChartSeries"
          :height="120"
          :show-legend="false"
          :show-tooltip="true"
        />

        <p v-if="historyData && historyData.totalKwh === 0" class="no-history type-body-sm">
          No consumption recorded for this period. Data accumulates every 5 minutes.
        </p>

        <p v-if="!historyData && !historyLoading" class="no-history type-body-sm">No data available for this period.</p>

        <p v-if="historyLoading" class="no-history type-body-sm">Loading history…</p>
      </NbShellPanel>

      <!-- Reporting what the device cannot measure -->
      <NbShellPanel v-if="(selected as any).dev.observations" title="Report" fluid>
        <p class="obs-help type-body-sm">
          {{ (selected as any).dev.observations.help ?? 'Tell the plugin what this device cannot measure itself.' }}
        </p>
        <div class="obs-form">
          <NbNumberInput
            v-model="obsValue"
            size="sm"
            :min="(selected as any).dev.observations.min"
            :max="(selected as any).dev.observations.max"
            :step="0.5"
            :label="`${(selected as any).dev.observations.label} (${(selected as any).dev.observations.unit})`"
          />
          <!-- A pressed verdict is the secondary fill, not a primary: the one
               filled primary in this section is Save report. -->
          <div class="obs-verdicts" role="group" aria-label="How it feels">
            <NbButton
              v-for="v in OBSERVATION_VERDICTS"
              :key="v.id"
              size="sm"
              :variant="obsComfort === v.id ? 'secondary' : 'ghost'"
              :aria-pressed="obsComfort === v.id"
              @click="obsComfort = v.id"
            >
              {{ v.label }}
            </NbButton>
          </div>
          <NbTextInput v-model="obsNote" size="sm" placeholder="Anything worth noting (sunny, window open)" />
          <div class="obs-submit">
            <NbButton size="sm" variant="primary" :disabled="obsValue === null || obsBusy" @click="submitObservation">
              Save report
            </NbButton>
          </div>
        </div>
        <NbMessage v-if="obsError" variant="error">{{ obsError }}</NbMessage>
        <div v-if="observations.length > 0" class="obs-list">
          <div class="obs-list-head type-overline">
            {{ observationTotal }} report{{ observationTotal === 1 ? '' : 's' }} so far
          </div>
          <div v-for="(o, i) in observations" :key="i" class="obs-row">
            <span class="obs-when type-body-sm tabular">{{ new Date(o.at).toLocaleString() }}</span>
            <span class="type-body-compact tabular">{{ o.roomTemperature }}°</span>
            <NbBadge :variant="o.comfort === 'ok' ? 'success' : o.comfort === 'cold' ? 'info' : 'warning'" size="sm">
              {{ o.comfort }}
            </NbBadge>
            <span v-if="o.note" class="obs-note type-body-sm">{{ o.note }}</span>
          </div>
        </div>
      </NbShellPanel>

      <!-- Interpolation calibration -->
      <NbShellPanel
        v-if="(selected as any).dev.interpolation && interpolationPoints.length > 0"
        title="Calibration"
        fluid
      >
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
        <p class="calibration-hint type-helper-text">
          Drag points to adjust. Double-click to add. Right-click to remove.
        </p>
        <div class="calibration-actions">
          <NbButton variant="secondary" size="sm" :disabled="!interpolationDirty" @click="resetInterpolation">
            Reset
          </NbButton>
          <NbButton
            variant="primary"
            size="sm"
            :disabled="!interpolationDirty || interpolationSaving"
            @click="saveInterpolation"
          >
            {{ interpolationSaving ? 'Saving…' : 'Save' }}
          </NbButton>
        </div>
        <NbBanner v-if="interpolationSaved" status="success" title="Configuration saved" class="section-banner-after">
          Restart the plugin to apply the new mapping.
        </NbBanner>
      </NbShellPanel>
      <NbShellPanel v-else-if="(selected as any).dev.interpolation && interpolationLoading" title="Calibration" fluid>
        <p class="no-history type-body-sm">Loading calibration data…</p>
      </NbShellPanel>

      <!-- All telemetry data -->
      <NbShellPanel v-if="telemetryEntries((selected as any).dev).length > 0" title="All telemetry" fluid>
        <NbDefinitionList compact>
          <NbDefinitionListItem v-for="[k, v] in telemetryEntries((selected as any).dev)" :key="k" :term="k">
            <span class="tabular">{{ String(v) }}</span>
          </NbDefinitionListItem>
        </NbDefinitionList>
      </NbShellPanel>

      <!-- HomeKit, when the plugin published an accessory for this device.
           Native plugins add accessories straight to the bridge, so the device
           and its accessory are two views of one thing and the controls belong
           here rather than on a separate card. -->
      <NbShellPanel v-if="nativeAccessory" title="HomeKit" fluid>
        <div class="homekit-fields">
          <template v-for="svc in mainServices(nativeAccessory)" :key="svc.uuid">
            <NbField
              v-show="canRetype(svc.uuid)"
              label="Show in HomeKit as"
              orientation="stack"
              hint="A plugin cannot know what a generic relay drives. Set it here and OpenBridge re-applies it on every restart, so the Home app stops reverting to a switch."
            >
              <NbSelect
                :model-value="serviceTypeFor(nativeAccessory.uuid, svc.uuid)"
                :options="serviceTypeOptions"
                :disabled="homekitBusy"
                size="sm"
                @update:model-value="(v: TSelectValue) => setServiceType(nativeAccessory!.uuid, svc.uuid, String(v))"
              />
            </NbField>
          </template>
          <p v-if="serviceTypeNotice" class="quiet-note type-body-sm">{{ serviceTypeNotice }}</p>

          <div>
            <NbField label="Expose to HomeKit" control="fit">
              <NbSwitch
                :name="`homekit-visible-${nativeAccessory.uuid}`"
                :model-value="isHomekitVisible(nativeAccessory.uuid)"
                :disabled="homekitBusy"
                @update:model-value="(v?: boolean) => setHomekitVisible(nativeAccessory!.uuid, !!v)"
              />
            </NbField>
            <p class="field-hint type-helper-text">
              Hide devices the Home app cannot represent usefully. OpenBridge keeps its telemetry and history either
              way.
            </p>
          </div>
          <p v-if="homekitNotice" class="quiet-note type-body-sm">{{ homekitNotice }}</p>
        </div>
      </NbShellPanel>
    </template>

    <!-- HAP accessory detail (original) -->
    <template v-else-if="selected.kind === 'hap'">
      <div class="detail-header">
        <div class="detail-icon">
          <NbIcon :name="categoryInfo((selected as any).acc.category).icon" size="lg" />
        </div>
        <div class="detail-heading">
          <div v-if="!editingName" class="detail-title-row">
            <h2
              class="detail-name type-heading-01"
              title="Click to rename"
              @click="startRename((selected as any).acc.displayName)"
            >
              {{ (selected as any).acc.displayName }}
            </h2>
            <NbButton
              v-nb-tooltip="{ body: 'Rename' }"
              variant="ghost"
              size="sm"
              icon="pencil-simple"
              :aria-label="`Rename ${(selected as any).acc.displayName}`"
              @click="startRename((selected as any).acc.displayName)"
            />
          </div>
          <div v-else class="rename-row">
            <NbTextInput
              v-model="renameValue"
              size="sm"
              @keyup.enter="saveRename((selected as any).acc.uuid)"
              @keyup.escape="editingName = false"
            />
            <NbButton
              v-nb-tooltip="{ body: 'Save name' }"
              variant="primary"
              size="sm"
              icon="check"
              aria-label="Save name"
              @click="saveRename((selected as any).acc.uuid)"
            />
            <NbButton
              v-nb-tooltip="{ body: 'Cancel rename' }"
              variant="ghost"
              size="sm"
              icon="x"
              aria-label="Cancel rename"
              @click="editingName = false"
            />
          </div>
          <div class="detail-type type-body-sm">{{ categoryInfo((selected as any).acc.category).label }}</div>
        </div>
      </div>

      <!-- Manufacturer info -->
      <NbShellPanel v-if="manufacturerInfo((selected as any).acc)" title="Device info" fluid>
        <NbDefinitionList compact :items="manufacturerFacts((selected as any).acc)" />
      </NbShellPanel>

      <!-- Services & characteristics -->
      <NbShellPanel
        v-for="svc in mainServices((selected as any).acc)"
        :key="svc.uuid"
        :title="svc.displayName || svc.name"
        fluid
      >
        <!-- Present-as override. Offered only for the interchangeable on/off
             service types, which is what the daemon will accept. -->
        <NbField
          v-if="canRetype(svc.uuid)"
          label="Show in HomeKit as"
          orientation="stack"
          hint="A plugin cannot know what a generic relay drives. Set it here and OpenBridge re-applies it on every restart, so the Home app stops reverting to a switch."
          class="service-type"
        >
          <NbSelect
            :model-value="serviceTypeFor((selected as any).acc.uuid, svc.uuid)"
            :options="serviceTypeOptions"
            :disabled="homekitBusy"
            size="sm"
            @update:model-value="(v: TSelectValue) => setServiceType((selected as any).acc.uuid, svc.uuid, String(v))"
          />
        </NbField>
        <p v-if="serviceTypeNotice" class="quiet-note type-body-sm">{{ serviceTypeNotice }}</p>

        <NbDefinitionList compact>
          <NbDefinitionListItem v-for="ch in svc.characteristics" :key="ch.uuid" :term="ch.name">
            <!-- Writable bool → inline toggle -->
            <NbSwitch
              v-if="isWritable(ch) && ch.format === 'bool'"
              :name="`hap-char-${svc.uuid}-${ch.uuid}`"
              :model-value="!!ch.value"
              @update:model-value="setHapCharacteristic((selected as any).acc.uuid, svc.uuid, ch.uuid, $event ? 1 : 0)"
            />
            <!-- Read-only or non-bool writable → display value -->
            <span v-else class="tabular" :class="{ 'state-on': ch.format === 'bool' && ch.value }">
              {{ formatValue(ch) }}
            </span>
          </NbDefinitionListItem>
        </NbDefinitionList>
      </NbShellPanel>

      <!-- HomeKit visibility -->
      <NbShellPanel title="HomeKit" fluid>
        <NbField label="Expose to HomeKit" control="fit">
          <NbSwitch
            :name="`homekit-visible-${(selected as any).acc.uuid}`"
            :model-value="isHomekitVisible((selected as any).acc.uuid)"
            :disabled="homekitBusy"
            @update:model-value="(v?: boolean) => setHomekitVisible((selected as any).acc.uuid, !!v)"
          />
        </NbField>
        <p class="field-hint type-helper-text">
          Hide devices the Home app cannot represent usefully. OpenBridge keeps its telemetry and history either way.
        </p>
        <p v-if="homekitNotice" class="quiet-note type-body-sm">{{ homekitNotice }}</p>
      </NbShellPanel>

      <div class="detail-uuid type-code-sm">UUID: {{ (selected as any).acc.uuid }}</div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useConfirm, type IDefinitionListItem, type ITabItem } from '@nubisco/ui'
import { useInspectorStore, type NativeDevice } from '@/stores/inspector'
import {
  api,
  type Accessory,
  type DeviceActionDescriptor,
  type DeviceEvent,
  type InterpolationDescriptor,
  type DeviceObservation,
} from '@/api'
import { onMounted } from 'vue'

// ─── HomeKit visibility ─────────────────────────────────────────────────────
// Keyed by HAP accessory UUID, the only identifier native and Homebridge-compat
// plugins share. Hiding is enforced at the bridge, so it applies to both.
const hiddenAccessories = ref<Set<string>>(new Set())
const homekitBusy = ref(false)
const homekitNotice = ref('')

function isHomekitVisible(uuid: string): boolean {
  return !hiddenAccessories.value.has(uuid)
}

async function loadHomekitHidden() {
  try {
    const { hidden } = await api.homekitHidden()
    hiddenAccessories.value = new Set(hidden)
  } catch {
    /* The bridge may be unavailable. Treat everything as visible. */
  }
}

async function setHomekitVisible(uuid: string, visible: boolean) {
  homekitBusy.value = true
  homekitNotice.value = ''
  try {
    const result = await api.setHomekitVisibility(uuid, visible)
    const next = new Set(hiddenAccessories.value)
    if (visible) next.delete(uuid)
    else next.add(uuid)
    hiddenAccessories.value = next
    // Be honest when the running bridge could not be updated, rather than
    // showing a toggle that looks applied but is not.
    if (!result.applied) {
      homekitNotice.value = 'Saved. This takes effect after the next OpenBridge restart.'
    }
  } catch (err) {
    homekitNotice.value = `Could not change visibility: ${(err as Error).message}`
  } finally {
    homekitBusy.value = false
  }
}

// ─── HomeKit service type ───────────────────────────────────────────────────
// What a service is *presented* as in the Home app. The set of valid targets
// comes from the daemon rather than being restated here, so the picker cannot
// offer a conversion the bridge would reject.
const serviceTypeOverrides = ref<Record<string, Record<string, string>>>({})
const availableServiceTypes = ref<Array<{ key: string; label: string; serviceUuid: string }>>([])
// Kept separate from homekitNotice so feedback appears beside the control the
// user just touched, not in the visibility section further down.
const serviceTypeNotice = ref('')

const serviceTypeOptions = computed(() => [
  { value: '', label: 'Default (as published)' },
  ...availableServiceTypes.value.map((t) => ({ value: t.key, label: t.label })),
])

/** Only the interchangeable on/off services can be re-typed. */
function canRetype(serviceUuid: string): boolean {
  return availableServiceTypes.value.some((t) => t.serviceUuid === serviceUuid)
}

function serviceTypeFor(accessoryUuid: string, serviceUuid: string): string {
  return serviceTypeOverrides.value[accessoryUuid]?.[serviceUuid] ?? ''
}

// A native plugin's device and the HAP accessory it published are two views of
// one thing, but the accessory never reaches /api/accessories, so it is fetched
// per selection. Null is a normal answer: plenty of devices are telemetry only.
const nativeAccessory = ref<Accessory | null>(null)

/**
 * The type to show for a device: its HomeKit override when one is set,
 * otherwise the widget type its plugin declared. Without this the card and the
 * inspector would contradict each other, one saying Switch while the picker
 * right below it says Light.
 */
function effectiveType(dev: NativeDevice): string {
  return (dev as unknown as { homekitType?: string }).homekitType || dev.widgetType
}

async function loadNativeAccessory(deviceId: string) {
  nativeAccessory.value = null
  try {
    const { accessory } = await api.deviceAccessory(deviceId)
    nativeAccessory.value = accessory
  } catch {
    /* The bridge is unavailable, so the HomeKit panel simply does not render. */
  }
}

async function loadServiceTypes() {
  try {
    const { overrides, available } = await api.homekitServiceTypes()
    serviceTypeOverrides.value = overrides
    availableServiceTypes.value = available
  } catch {
    /* The bridge may be unavailable, and then the picker simply does not render. */
  }
}

async function setServiceType(accessoryUuid: string, serviceUuid: string, type: string) {
  homekitBusy.value = true
  serviceTypeNotice.value = ''
  try {
    await api.setHomekitServiceType(accessoryUuid, serviceUuid, type || null)

    const next = { ...serviceTypeOverrides.value }
    const forAccessory = { ...(next[accessoryUuid] ?? {}) }
    if (type) forAccessory[serviceUuid] = type
    else delete forAccessory[serviceUuid]

    if (Object.keys(forAccessory).length > 0) next[accessoryUuid] = forAccessory
    else delete next[accessoryUuid]
    serviceTypeOverrides.value = next

    // Always a restart: HomeKit caches an accessory's shape at pairing, so this
    // one genuinely cannot be applied live.
    serviceTypeNotice.value = 'Saved. This takes effect after the next OpenBridge restart.'
  } catch (err) {
    serviceTypeNotice.value = `Could not change type: ${(err as Error).message}`
  } finally {
    homekitBusy.value = false
  }
}

onMounted(() => {
  loadHomekitHidden()
  loadServiceTypes()
})

const inspector = useInspectorStore()

// ─── Device actions ─────────────────────────────────────────────────────────
// One-shot commands a plugin declared for this device (reboot, identify). The
// descriptor carries the label and whether to confirm, so the guard is the
// plugin's call: it knows what the command costs, and the UI does not.
const confirm = useConfirm()
const actionBusy = ref('')
const actionNotice = ref('')
const actionStatus = ref<'success' | 'error'>('success')

const deviceHealth = computed(() => {
  const item = inspector.selectedDevice
  if (!item || item.kind !== 'native') return null
  return item.dev.health ?? null
})

const healthTitle = computed(() => {
  const seen = deviceHealth.value?.lastSeen
  if (!seen) return 'Not responding'
  return `Not responding since ${new Date(seen).toLocaleString()}`
})

/**
 * Reporting what a device cannot measure.
 *
 * The verdict is asked for alongside the number because it is the more
 * reliable half. A thermometer can be two degrees out and the reading still
 * useless alone, but "this is too cold" is never wrong about the thing that
 * matters, and it makes the "about right" samples identifiable. Those are the
 * ones a curve most needs and the ones nobody thinks to file.
 */
const OBSERVATION_VERDICTS = [
  { id: 'cold', label: 'Too cold' },
  { id: 'ok', label: 'About right' },
  { id: 'warm', label: 'Too warm' },
] as const

const obsValue = ref<number | null>(null)
const obsComfort = ref<'cold' | 'ok' | 'warm'>('ok')
const obsNote = ref('')
const obsBusy = ref(false)
const obsError = ref('')
const observations = ref<DeviceObservation[]>([])
const observationTotal = ref(0)

async function loadObservations() {
  const item = inspector.selectedDevice
  if (!item || item.kind !== 'native' || !(item.dev as any).observations) {
    observations.value = []
    observationTotal.value = 0
    return
  }
  try {
    const res = await api.deviceObservations(item.dev.id, 20)
    observations.value = res.observations
    observationTotal.value = res.total
  } catch {
    /* the panel is still usable for reporting even if the history will not load */
  }
}

async function submitObservation() {
  const item = inspector.selectedDevice
  if (!item || item.kind !== 'native' || obsValue.value === null) return

  obsBusy.value = true
  obsError.value = ''
  try {
    await api.reportObservation(item.dev.id, {
      roomTemperature: obsValue.value,
      comfort: obsComfort.value,
      ...(obsNote.value.trim() ? { note: obsNote.value.trim() } : {}),
    })
    obsNote.value = ''
    await loadObservations()
  } catch (e) {
    obsError.value = e instanceof Error ? e.message : String(e)
  } finally {
    obsBusy.value = false
  }
}

watch(
  () => inspector.selectedDevice,
  () => {
    obsError.value = ''
    obsNote.value = ''
    void loadObservations()
  },
  { immediate: true },
)

const deviceActions = computed<DeviceActionDescriptor[]>(() => {
  const item = inspector.selectedDevice
  if (!item || item.kind !== 'native') return []
  return item.dev.actions ?? []
})

async function runDeviceAction(action: DeviceActionDescriptor) {
  const item = inspector.selectedDevice
  if (!item || item.kind !== 'native') return

  if (action.confirm) {
    const ok = await confirm({
      title: action.label,
      subjectLabel: 'Device',
      subject: item.dev.name,
      message: action.confirm,
      confirmLabel: action.label,
    })
    if (!ok) return
  }

  actionBusy.value = action.id
  actionNotice.value = ''
  try {
    await api.controlDevice(item.dev.id, action.id, true)
    actionStatus.value = 'success'
    actionNotice.value = `${action.label} sent.`
  } catch (err) {
    actionStatus.value = 'error'
    actionNotice.value = `${action.label} failed: ${(err as Error).message}`
  } finally {
    actionBusy.value = ''
  }
}

const selected = computed(() => inspector.selectedDevice)

// Track which device is open so we only reset history when a *different* device is selected
const currentDeviceId = computed(() => {
  if (!selected.value) return null
  return selected.value.kind === 'native' ? selected.value.dev.id : selected.value.acc.uuid
})

// ─── HAP helpers ─────────────────────────────────────────────────────────────
// HAP accessory categories (from hap-nodejs Categories enum)
// NbSwitch models `boolean | undefined` and NbSelect
// `string | number | (string | number)[] | null`. These controls are all
// single-value, so the handlers narrow at the call site.
type TSelectValue = string | number | (string | number)[] | null

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

/** The accessory's information service as facts, with the empty ones left out. */
function manufacturerFacts(acc: Accessory): IDefinitionListItem[] {
  const info = manufacturerInfo(acc)
  if (!info) return []
  return Object.entries(info)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => ({ term: k.charAt(0).toUpperCase() + k.slice(1), value: String(v) }))
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
// NbTextInput autofocuses when it mounts, so no ref is needed to drive focus.

function startRename(currentName: string) {
  renameValue.value = currentName
  editingName.value = true
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

// ─── Recent activity ─────────────────────────────────────────────────────────
const deviceEvents = ref<DeviceEvent[]>([])

/** Time of day, with the full timestamp on hover. A timeline is read by when. */
function shortTime(at: string): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return at
  const today = new Date().toDateString() === d.toDateString()
  return today
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

async function loadDeviceEvents() {
  const current = selected.value
  if (current?.kind !== 'native') {
    deviceEvents.value = []
    return
  }
  try {
    const res = await api.deviceEvents((current as any).dev.id, 100)
    deviceEvents.value = res.events
  } catch {
    // A device whose plugin records nothing, or an older daemon: show no panel
    // rather than an error for something that is purely additional.
    deviceEvents.value = []
  }
}

// ─── Native device helpers ───────────────────────────────────────────────────
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
  // See the note on the copy in DevicesView.vue: native cameras had no entry
  // in either map and fell through to the generic cube.
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
type THistoryPeriod = 'day' | 'month' | 'year'
const historyPeriod = ref<THistoryPeriod>('day')
const HISTORY_PERIODS: ITabItem[] = [
  { id: 'day', label: 'Day' },
  { id: 'month', label: 'Month' },
  { id: 'year', label: 'Year' },
]
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

    // Only native devices need this: a HAP selection already carries its
    // accessory, so there is nothing to resolve.
    if (val?.kind === 'native') loadNativeAccessory((val as any).dev.id)
    else nativeAccessory.value = null

    void loadDeviceEvents()

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

<style lang="scss" scoped>
// An inspector is dense: controls are `sm`, rows 8 apart, and a section's
// groups 12 apart (the xs and sm rows of the density pairing table).
.inspector-content {
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  height: 100%;
}

// ─── Pinned header ─────────────────────────────────────────────────────────────
.detail-header {
  display: flex;
  align-items: center;
  gap: var(--nb-spacing-12);
  padding: var(--nb-spacing-16);
  border-bottom: 1px solid var(--nb-c-border);
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--nb-c-surface);

  // On a phone the sheet's 44px dismiss button floats over this header's
  // right edge, so a long name stops short of it instead of running under it.
  @include variables.phone {
    padding-inline-end: calc(var(--nb-shell-inspector-dismiss-inset, 0px) + var(--nb-spacing-8));
  }
}

.detail-icon {
  width: 44px;
  height: 44px;
  border-radius: var(--nb-radius-panel);
  background: color-mix(in srgb, var(--nb-c-primary) 12%, var(--nb-c-surface));
  color: var(--nb-c-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.detail-heading {
  flex: 1;
  min-width: 0;
}

.detail-title-row {
  display: flex;
  align-items: center;
  gap: var(--nb-spacing-4);
  min-width: 0;
}

.detail-name {
  cursor: pointer;
  color: var(--nb-c-text);
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}

.rename-row {
  display: flex;
  align-items: center;
  gap: var(--nb-spacing-4);

  > :first-child {
    flex: 1;
    min-width: 0;
  }
}

.detail-type {
  color: var(--nb-c-text-subtle);
}

// ─── Shared ────────────────────────────────────────────────────────────────────
.section-banner {
  margin-bottom: var(--nb-spacing-8);
}

.section-banner-after {
  margin-top: var(--nb-spacing-8);
}

.detail-code {
  color: var(--nb-c-text-muted);
  word-break: break-all;
}

.reading-unit {
  color: var(--nb-c-text-subtle);
}

// On and off are states, so they carry the state's colour.
.state-on {
  color: var(--nb-c-success);
}

.state-off {
  color: var(--nb-c-text-subtle);
}

.quiet-note {
  margin: 0;
  color: var(--nb-c-text-muted);
}

// NbField puts its hint under the control's column, which for a switch on the
// right edge is the switch's own width. The hint sits under the whole row instead.
.field-hint {
  margin: var(--nb-spacing-2) 0 0;
  color: var(--nb-c-text-subtle);
}

// ─── Widget: energy meter ──────────────────────────────────────────────────────
.widget-energy {
  display: flex;
  flex-direction: column;
  gap: var(--nb-spacing-8);
}

.energy-primary {
  display: flex;
  align-items: baseline;
  gap: var(--nb-spacing-4);
  color: var(--nb-c-text);
}

// ─── Recent activity ───────────────────────────────────────────────────────────
.event-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--nb-spacing-4);
}

.event {
  display: flex;
  gap: var(--nb-spacing-8);
  align-items: baseline;
}

// Fixed width and tabular figures so the messages line up into a column that
// can be scanned down, which is the whole point of a timeline.
.event-time {
  flex: 0 0 auto;
  min-width: 5.5rem;
  color: var(--nb-c-text-subtle);
}

.event-body {
  display: flex;
  gap: var(--nb-spacing-8);
  align-items: baseline;
  flex-wrap: wrap;
  min-width: 0;
}

.event-message {
  color: var(--nb-c-text);
}

.event-source {
  color: var(--nb-c-text-muted);
}

.detail-uuid {
  padding: var(--nb-spacing-12) var(--nb-spacing-16);
  color: var(--nb-c-text-subtle);
  word-break: break-all;
}

// ─── Energy history ────────────────────────────────────────────────────────────
.history-tabs {
  margin-bottom: var(--nb-spacing-12);
}

.history-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--nb-spacing-12);
}

.history-nav-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--nb-spacing-2);
}

.history-total {
  display: flex;
  align-items: baseline;
  gap: var(--nb-spacing-4);
  color: var(--nb-c-text);
}

.history-date {
  color: var(--nb-c-text-subtle);
}

.no-history {
  margin: 0;
  padding: var(--nb-spacing-16) 0;
  color: var(--nb-c-text-subtle);
  text-align: center;
}

// ─── Calibration ──────────────────────────────────────────────────────────────
.calibration-hint {
  margin: var(--nb-spacing-4) 0 var(--nb-spacing-8);
  color: var(--nb-c-text-subtle);
  text-align: center;
}

.calibration-actions {
  display: flex;
  gap: var(--nb-spacing-8);
  justify-content: flex-end;
}

// ─── HomeKit ───────────────────────────────────────────────────────────────────
.homekit-fields {
  display: flex;
  flex-direction: column;
  gap: var(--nb-spacing-12);
}

.service-type {
  margin-bottom: var(--nb-spacing-12);
}

// ─── Report ────────────────────────────────────────────────────────────────────
.obs-help {
  margin: 0 0 var(--nb-spacing-8);
  color: var(--nb-c-text-muted);
}

.obs-form {
  display: flex;
  flex-direction: column;
  gap: var(--nb-spacing-8);
}

.obs-verdicts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--nb-spacing-4);
}

.obs-submit {
  display: flex;
  justify-content: flex-end;
}

.obs-list {
  margin-top: var(--nb-spacing-16);
  border-top: 1px solid var(--nb-c-border);
  padding-top: var(--nb-spacing-12);
}

.obs-list-head {
  color: var(--nb-c-text-muted);
  margin-bottom: var(--nb-spacing-8);
}

.obs-row {
  display: flex;
  align-items: center;
  gap: var(--nb-spacing-8);
  padding: var(--nb-spacing-4) 0;
}

.obs-when {
  color: var(--nb-c-text-subtle);
  white-space: nowrap;
}

.obs-note {
  min-width: 0;
  color: var(--nb-c-text-subtle);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
