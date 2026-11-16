<template>
  <div class="house" :class="{ 'is-phone': phone }">
    <component :is="topbarRight.Outlet">
      <div class="house__topbar">
        <template v-if="mode === 'edit'">
          <NbButton size="sm" variant="ghost" :disabled="saving" @click="discard">Discard</NbButton>
          <NbButton size="sm" variant="primary" :loading="saving" @click="save">Save plan</NbButton>
        </template>
        <NbButton v-else-if="house.hasPlan" size="sm" variant="secondary" icon="pencil-simple" @click="startEditing">
          Edit plan
        </NbButton>
      </div>
    </component>

    <!-- ═══ Editing ═══ -->
    <HouseEditor
      v-if="mode === 'edit' && draft"
      :plan="draft"
      :devices="byRef"
      :all-devices="devices"
      :initial-floor="floor === 'all' ? null : floor"
    />

    <!-- ═══ No plan yet ═══ -->
    <NbEmptyState
      v-else-if="house.loaded && !house.hasPlan"
      icon="blueprint"
      title="Draw your home"
      description="Sketch each floor as a few rooms, then put your devices where they really are. Lights glow in their colour, shutters show how far they are open, and heating shows its water running through the rooms it warms."
      :bordered="true"
    >
      <template #actions>
        <NbButton variant="primary" icon="pencil-simple" @click="startEditing">Start drawing</NbButton>
      </template>
    </NbEmptyState>

    <!-- ═══ Live ═══ -->
    <div v-else-if="house.plan" class="house__live">
      <div class="house__main">
        <div class="house__toolbar">
          <NbTabs v-model="view" :items="VIEW_ITEMS" variant="contained" size="sm" aria-label="View" />
          <NbTabs
            v-if="view === 'iso'"
            v-model="walls"
            :items="WALL_ITEMS"
            variant="contained"
            size="sm"
            aria-label="Walls"
          />
          <NbTabs v-model="overlay" :items="OVERLAY_ITEMS" variant="contained" size="sm" aria-label="Overlay" />
          <NbSwitch
            name="house-labels"
            label="Room names"
            :model-value="labels"
            @update:model-value="(v?: boolean) => (labels = !!v)"
          />
        </div>
        <HouseStage
          v-model:floor="floor"
          :plan="house.plan"
          :devices="byRef"
          :mode="view"
          :walls="walls"
          :overlay="overlay"
          :labels="labels"
          :selected="selected"
          @activate="activate"
        />
      </div>

      <aside class="house__side">
        <HouseDevicePanel :device="selectedDevice" :where="whereOf(selected)" @changed="poll" />
        <NbContainedList :title="listTitle" size="sm">
          <template v-for="group in listGroups" :key="group.id">
            <NbContainedListItem
              v-for="d in group.devices"
              :key="d.ref"
              :title="d.name"
              :line="group.label"
              :clickable="true"
              :current="selected === d.ref"
              @click="selected = d.ref"
            >
              <template #trailing>
                <NbBadge :variant="!d.reachable ? 'warning' : isActive(d) ? 'success' : 'neutral'" dot>
                  {{ stateText(d) || KIND_LABEL[d.kind] }}
                </NbBadge>
              </template>
            </NbContainedListItem>
          </template>
          <NbEmptyState
            v-if="!listGroups.length"
            size="sm"
            title="No devices on this floor"
            description="Edit the plan to place some."
          />
        </NbContainedList>
      </aside>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { useConfirm, usePhoneLayout, useShellSlot, useToast } from '@nubisco/ui'
import { api, type HousePlan } from '@/api'
import { useDaemonStore } from '@/stores/daemon'
import { useHouseStore } from '@/stores/house'
import { useLayoutStore } from '@/stores/layout'
import { emptyPlan, tidy } from '@/house/editor'
import { placementRoom } from '@/house/geometry'
import { KIND_LABEL, isActive, liveDevices, stateText, type LiveDevice, type NativeDevice } from '@/house/live'
import { setPower, tapToggles } from '@/house/control'
import HouseStage from '@/components/house/HouseStage.vue'
import HouseEditor from '@/components/house/HouseEditor.vue'
import HouseDevicePanel from '@/components/house/HouseDevicePanel.vue'
import '@/house/house.scss'

const topbarRight = useShellSlot('topbar-right')
const layout = useLayoutStore()
const daemon = useDaemonStore()
const house = useHouseStore()
const toast = useToast()
const confirm = useConfirm()
const { phone } = usePhoneLayout()

layout.setPage('House')

const VIEW_ITEMS = [
  { id: 'iso', label: '3D' },
  { id: 'flat', label: '2D' },
]
const WALL_ITEMS = [
  { id: 'up', label: 'Walls up' },
  { id: 'low', label: 'Walls low' },
]
const OVERLAY_ITEMS = [
  { id: 'none', label: 'Devices' },
  { id: 'temperature', label: 'Temperature' },
  { id: 'humidity', label: 'Humidity' },
]

// View settings are a per-viewer convenience, remembered in this browser.
function remembered<T extends string>(key: string, fallback: T, allowed: readonly T[]) {
  let initial = fallback
  try {
    const v = localStorage.getItem(`openbridge.house.${key}`) as T | null
    if (v && allowed.includes(v)) initial = v
  } catch {
    /* storage unavailable */
  }
  const r = ref<T>(initial)
  watch(r, (v) => {
    try {
      localStorage.setItem(`openbridge.house.${key}`, v)
    } catch {
      /* storage unavailable */
    }
  })
  return r
}
const view = remembered<'iso' | 'flat'>('view', 'iso', ['iso', 'flat'])
const walls = remembered<'up' | 'low'>('walls', 'up', ['up', 'low'])
const overlay = remembered<'none' | 'temperature' | 'humidity'>('overlay', 'none', ['none', 'temperature', 'humidity'])
const labelsSetting = remembered<'on' | 'off'>('labels', 'on', ['on', 'off'])
const labels = computed({
  get: () => labelsSetting.value === 'on',
  set: (v: boolean) => (labelsSetting.value = v ? 'on' : 'off'),
})

const floor = ref<string>('all')
const selected = ref<string | null>(null)
const mode = ref<'live' | 'edit'>('live')
const draft = ref<HousePlan | null>(null)
const saving = ref(false)
const native = ref<NativeDevice[]>([])

const devices = computed<LiveDevice[]>(() => liveDevices(native.value, daemon.accessories))
const byRef = computed(() => new Map(devices.value.map((d) => [d.ref, d])))
const selectedDevice = computed(() => (selected.value ? (byRef.value.get(selected.value) ?? null) : null))

/** "Kitchen, Ground floor", read from the plan as it is now. */
function whereOf(ref: string | null): string {
  if (!ref || !house.plan) return ''
  const at = placementRoom(house.plan, ref)
  if (!at) return 'Not on the plan'
  return at.room ? `${at.room.name}, ${at.floor.name}` : at.floor.name
}

const listTitle = computed(() => {
  const f = house.plan?.floors.find((x) => x.id === floor.value)
  return f ? `Devices, ${f.name.toLowerCase()}` : 'Devices'
})

/** Devices on the plan, grouped by room, on the floor in view. */
const listGroups = computed(() => {
  const plan = house.plan
  if (!plan) return []
  const floors = plan.floors
    .filter((f) => floor.value === 'all' || f.id === floor.value)
    .sort((a, b) => b.level - a.level)
  const groups: Array<{ id: string; label: string; devices: LiveDevice[] }> = []
  for (const f of floors) {
    const byRoom = new Map<string, { id: string; label: string; devices: LiveDevice[] }>()
    for (const p of f.placements) {
      const d = byRef.value.get(p.ref)
      if (!d) continue
      const where = whereOf(p.ref)
      const key = `${f.id}:${where}`
      if (!byRoom.has(key)) byRoom.set(key, { id: key, label: where, devices: [] })
      byRoom.get(key)!.devices.push(d)
    }
    groups.push(...[...byRoom.values()].sort((a, b) => a.label.localeCompare(b.label)))
  }
  return groups
})

/** A tap on the plan: lights and plain switches toggle, everything else opens its controls. */
async function activate(ref: string) {
  selected.value = ref
  const d = byRef.value.get(ref)
  if (!d || !tapToggles(d)) return
  try {
    await setPower(d, !d.on)
    await poll()
  } catch (e) {
    toast.error((e as Error).message, { title: `Could not switch ${d.name}` })
  }
}

// ─── Editing ────────────────────────────────────────────────────────────────

function startEditing() {
  draft.value = JSON.parse(JSON.stringify(house.plan ?? emptyPlan()))
  mode.value = 'edit'
}

const dirty = computed(
  () => mode.value === 'edit' && JSON.stringify(draft.value) !== JSON.stringify(house.plan ?? emptyPlan()),
)

async function discard() {
  if (dirty.value) {
    const ok = await confirm({
      title: 'Discard changes',
      message: 'Your changes to the plan since it was last saved will be lost.',
      confirmLabel: 'Discard',
    })
    if (!ok) return
  }
  draft.value = null
  mode.value = 'live'
}

async function save() {
  if (!draft.value) return
  saving.value = true
  try {
    const result = await house.save(tidy(draft.value))
    if (result === 'conflict') {
      toast.error(
        'Someone saved the plan from another tab or device. Their version is loaded, so redo your change on top of it.',
        {
          title: 'Plan changed elsewhere',
        },
      )
      draft.value = JSON.parse(JSON.stringify(house.plan ?? emptyPlan()))
      return
    }
    toast.success('Plan saved')
    draft.value = null
    mode.value = 'live'
  } catch (e) {
    toast.error((e as Error).message, { title: 'Could not save the plan' })
  } finally {
    saving.value = false
  }
}

onBeforeRouteLeave(async () => {
  if (!dirty.value) return true
  return confirm({
    title: 'Leave without saving',
    message: 'Your changes to the plan have not been saved.',
    confirmLabel: 'Leave',
  })
})

// The floor in view may have been deleted in the editor.
watch(
  () => house.plan?.floors.map((f) => f.id).join(','),
  () => {
    if (floor.value !== 'all' && !house.plan?.floors.some((f) => f.id === floor.value)) floor.value = 'all'
    if ((house.plan?.floors.length ?? 0) === 1) floor.value = house.plan!.floors[0].id
  },
)

// ─── Live data ──────────────────────────────────────────────────────────────
// Polled like the Devices page: both lists are served from memory in the
// daemon, so this costs no device traffic.

async function poll() {
  try {
    const [res] = await Promise.all([api.devices(), daemon.fetchAccessories()])
    native.value = res.devices as NativeDevice[]
  } catch {
    /* a missed poll is retried in three seconds */
  }
}

let timer: ReturnType<typeof setInterval> | null = null
onMounted(async () => {
  await Promise.all([house.load().catch(() => undefined), poll()])
  if ((house.plan?.floors.length ?? 0) === 1) floor.value = house.plan!.floors[0].id
  timer = setInterval(poll, 3000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<style lang="scss" scoped>
.house__topbar {
  display: flex;
  gap: var(--nb-spacing-8);
}

.house__live {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  gap: var(--nb-spacing-16);
  align-items: start;

  .is-phone & {
    grid-template-columns: minmax(0, 1fr);
  }
}

.house__toolbar {
  display: flex;
  align-items: center;
  gap: var(--nb-spacing-8);
  margin-bottom: var(--nb-spacing-8);
  overflow-x: auto;
  padding-bottom: 2px;

  > * {
    flex: none;
  }

  // A tab bar fills its row by default. Here several sit side by side.
  > :deep(.nb-tabs) {
    width: auto;
  }
}

.house__side {
  display: flex;
  flex-direction: column;
  gap: var(--nb-spacing-12);
  min-width: 0;
}
</style>
