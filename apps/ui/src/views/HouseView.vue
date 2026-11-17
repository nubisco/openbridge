<template>
  <div class="house">
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
      :devices="house.byRef"
      :all-devices="house.devices"
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
    <!-- The house is the page: the plan fills the content area with the view
         controls floating over it, and a device's controls open in the
         shell's inspector only once something is picked. -->
    <div v-else-if="house.plan" class="house__live">
      <HouseStage
        v-model:floor="floor"
        fill
        :inset-top="48"
        :plan="house.plan"
        :devices="house.byRef"
        :mode="view"
        :walls="walls"
        :overlay="overlay"
        :labels="labels"
        :selected="selected"
        @activate="activate"
        @clear="deselect"
      />
      <div class="house__toolbar" data-nb-appearance="rounded">
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
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { useConfirm, usePhoneLayout, useShellSlot, useToast } from '@nubisco/ui'
import type { HousePlan } from '@/api'
import { useHouseStore } from '@/stores/house'
import { useInspectorStore } from '@/stores/inspector'
import { useLayoutStore } from '@/stores/layout'
import { emptyPlan, tidy } from '@/house/editor'
import { setPower, tapToggles } from '@/house/control'
import HouseStage from '@/components/house/HouseStage.vue'
import HouseEditor from '@/components/house/HouseEditor.vue'
import '@/house/house.scss'

const topbarRight = useShellSlot('topbar-right')
const layout = useLayoutStore()
const house = useHouseStore()
const inspector = useInspectorStore()
const toast = useToast()
const confirm = useConfirm()

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

const { phone } = usePhoneLayout()
const floor = ref<string>('all')
const mode = ref<'live' | 'edit'>('live')
const draft = ref<HousePlan | null>(null)
const saving = ref(false)

// The house, live or as a blueprint being edited, runs edge to edge. The empty
// state keeps the page's padding, and so does the editor on a phone, where
// its panels sit under the blueprint. The rail folds to icons while the House
// is open, to give the plan the width.
watch(
  () => (mode.value === 'live' ? house.hasPlan : !phone.value),
  (bleed) => layout.setPage('Home', { fullBleed: bleed, compactNav: true }),
  { immediate: true },
)

/** What is picked on the plan is what the inspector shows, and only while it shows it. */
const selected = computed(() => (inspector.visible && inspector.mode === 'house' ? inspector.houseRef : null))

function deselect() {
  if (inspector.mode === 'house') inspector.close()
}

/** A tap on the plan: it picks the device, and lights and plain switches also toggle. */
async function activate(ref: string) {
  inspector.openHouse(ref)
  const d = house.byRef.get(ref)
  if (!d) return
  const placed = house.plan?.floors.flatMap((f) => f.placements).find((p) => p.ref === ref)
  if (!tapToggles(d, placed?.look ?? d.defaultLook)) return
  try {
    await setPower(d, !d.on)
    await house.poll()
  } catch (e) {
    toast.error((e as Error).message, { title: `Could not switch ${d.name}` })
  }
}

// ─── Editing ────────────────────────────────────────────────────────────────

function startEditing() {
  deselect()
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

let timer: ReturnType<typeof setInterval> | null = null
onMounted(async () => {
  await Promise.all([house.load().catch(() => undefined), house.poll()])
  if ((house.plan?.floors.length ?? 0) === 1) floor.value = house.plan!.floors[0].id
  timer = setInterval(() => house.poll(), 3000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<style lang="scss" scoped>
.house {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.house__topbar {
  display: flex;
  gap: var(--nb-spacing-8);
}

.house__live {
  position: relative;
  flex: 1;
  min-height: 0;
}

// The view controls float over the house, top left.
.house__toolbar {
  position: absolute;
  top: var(--nb-spacing-12);
  left: var(--nb-spacing-12);
  right: var(--nb-spacing-12);
  display: flex;
  align-items: center;
  gap: var(--nb-spacing-8);
  overflow-x: auto;
  padding-bottom: 2px;
  pointer-events: none;

  > * {
    flex: none;
    pointer-events: auto;
  }

  // A tab bar fills its row by default. Here several sit side by side.
  > :deep(.nb-tabs) {
    width: auto;
  }
}
</style>
