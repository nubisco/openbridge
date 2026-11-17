<template>
  <NbPanel :title="device?.name ?? 'Nothing selected'" :flat="true">
    <template v-if="device">
      <p class="hdp__where type-body-sm">
        {{ where }}
        <span v-if="device.reachable === false">· Not responding</span>
      </p>

      <CameraView v-if="video && deviceId" :key="deviceId" :device-id="deviceId" :name="device.name" :video="video" />

      <div v-if="caps.power" class="hdp__row">
        <span>{{ device.kind === 'heating' || device.kind === 'dehumidifier' ? 'Running' : 'Power' }}</span>
        <NbSwitch
          :name="`house-power-${device.ref}`"
          :model-value="!!device.on"
          :disabled="busy || !device.reachable"
          @update:model-value="(v?: boolean) => run(() => setPower(device!, !!v))"
        />
      </div>

      <NbField v-if="caps.brightness" label="Brightness" orientation="stack">
        <NbSlider
          :model-value="device.brightness ?? 0"
          :min="1"
          :max="100"
          :disabled="busy || !device.reachable"
          @change="(v: number | [number, number]) => run(() => setBrightness(device!, Number(v)))"
        />
      </NbField>

      <NbField v-if="caps.target" v-slot="{ id }" label="Target temperature (°C)" orientation="stack">
        <NbNumberInput
          :id="id"
          :model-value="device.target ?? null"
          :min="5"
          :max="70"
          :step="0.5"
          size="sm"
          :disabled="busy || !device.reachable"
          @update:model-value="(v: number | null) => v !== null && run(() => setTarget(device!, v))"
        />
      </NbField>

      <NbField v-if="caps.position" label="Open position" orientation="stack">
        <NbSlider
          :model-value="device.position ?? 0"
          :min="0"
          :max="100"
          :step="5"
          :disabled="busy || !device.reachable"
          @change="(v: number | [number, number]) => run(() => setPosition(device!, Number(v)))"
        />
      </NbField>

      <div v-if="caps.gate" class="hdp__actions">
        <NbButton size="sm" variant="secondary" :disabled="busy || !device.reachable" @click="gate('open')">
          Open
        </NbButton>
        <NbButton size="sm" variant="secondary" :disabled="busy || !device.reachable" @click="gate('closed')">
          Close
        </NbButton>
      </div>

      <NbDefinitionList v-if="readings.length" class="hdp__readings">
        <NbDefinitionListItem v-for="r in readings" :key="r.term" :term="r.term">{{ r.value }}</NbDefinitionListItem>
      </NbDefinitionList>

      <div class="hdp__actions">
        <NbButton v-if="deviceId" size="sm" variant="ghost" :to="`/devices/${encodeURIComponent(deviceId)}`">
          Open device page
        </NbButton>
      </div>
    </template>
    <p v-else class="hdp__where type-body-sm">Tap a device on the plan.</p>
  </NbPanel>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useConfirm, useToast } from '@nubisco/ui'
import { capabilities, setBrightness, setGate, setPosition, setPower, setTarget } from '@/house/control'
import { KIND_LABEL, formatPower, type LiveDevice } from '@/house/live'
import CameraView from '@/components/CameraView.vue'

const props = defineProps<{
  device: LiveDevice | null
  /** "Kitchen, Ground floor" */
  where: string
}>()

const emit = defineEmits<{ changed: [] }>()

const toast = useToast()
const confirm = useConfirm()
const busy = ref(false)

const caps = computed(() =>
  props.device
    ? capabilities(props.device)
    : { power: false, brightness: false, target: false, position: false, gate: false },
)

const deviceId = computed(() => (props.device?.source.type === 'native' ? props.device.source.device.id : null))
const video = computed(() => (props.device?.source.type === 'native' ? props.device.source.device.video : undefined))

const readings = computed(() => {
  const d = props.device
  if (!d) return []
  const out: Array<{ term: string; value: string }> = [{ term: 'Kind', value: KIND_LABEL[d.kind] }]
  // A heat pump that names its readings says them itself: its bare "current"
  // temperature is one of them (often the tank), so it is not repeated.
  const named = d.kind === 'heating' && (d.supply !== undefined || d.hotWater !== undefined)
  if (d.temperature !== undefined && !named) out.push({ term: 'Temperature', value: `${d.temperature.toFixed(1)} °C` })
  if (d.supply !== undefined) out.push({ term: 'Water out', value: `${d.supply.toFixed(1)} °C` })
  if (d.return !== undefined) out.push({ term: 'Water back', value: `${d.return.toFixed(1)} °C` })
  if (d.hotWater !== undefined) out.push({ term: 'Hot water tank', value: `${d.hotWater.toFixed(1)} °C` })
  if (d.outside !== undefined) out.push({ term: 'Outside', value: `${d.outside.toFixed(1)} °C` })
  if (d.target !== undefined && !caps.value.target) out.push({ term: 'Target', value: `${d.target.toFixed(1)} °C` })
  if (d.humidity !== undefined) out.push({ term: 'Humidity', value: `${Math.round(d.humidity)}%` })
  if (d.power !== undefined) out.push({ term: 'Power', value: formatPower(d.power) })
  if (d.position !== undefined) out.push({ term: 'Position', value: `${Math.round(d.position)}% open` })
  if (d.gateState) out.push({ term: 'Gate', value: d.gateState })
  return out
})

async function run(action: () => Promise<void>) {
  busy.value = true
  try {
    await action()
    emit('changed')
  } catch (e) {
    toast.error((e as Error).message, { title: `Could not change ${props.device?.name ?? 'the device'}` })
  } finally {
    busy.value = false
  }
}

/** A gate moves something heavy in the street, so it asks first, like every other control that does. */
async function gate(target: 'open' | 'closed') {
  const d = props.device
  if (!d) return
  const ok = await confirm({
    title: target === 'open' ? 'Open the gate' : 'Close the gate',
    subjectLabel: 'Device',
    subject: d.name,
    message: target === 'open' ? 'The gate will start moving now.' : 'Make sure nothing is in the way.',
    confirmLabel: target === 'open' ? 'Open' : 'Close',
  })
  if (ok) await run(() => setGate(d, target))
}
</script>

<style lang="scss" scoped>
.hdp__where {
  margin: 0 0 var(--nb-spacing-12);
  color: var(--nb-c-text-muted);
}

.hdp__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nb-spacing-8);
  margin-bottom: var(--nb-spacing-12);
}

.hdp__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--nb-spacing-8);
  margin-top: var(--nb-spacing-12);
}

.hdp__readings {
  margin-top: var(--nb-spacing-12);
}
</style>
