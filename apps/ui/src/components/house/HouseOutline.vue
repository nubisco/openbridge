<template>
  <!-- The house as an outline: floors, the rooms on each, and what is in each
       room. Picking a row selects it on the plan. -->
  <NbTree
    ref="treeEl"
    :model-value="selected"
    size="sm"
    aria-label="The house"
    class="house-outline"
    @update:model-value="(id: string) => pick(id)"
  >
    <NbTreeNode v-for="f in tree" :id="f.id" :key="f.id" :label="f.label" icon="stack">
      <NbTreeNode v-for="r in f.rooms" :id="r.id" :key="r.id" :label="r.label" :icon="r.icon">
        <NbTreeNode v-for="x in r.items" :id="x.id" :key="x.id" :label="x.label" :icon="x.icon" />
      </NbTreeNode>
      <NbTreeNode v-if="f.openings.length" :id="`group:${f.floor}:openings`" label="Doors and windows" icon="door-open">
        <NbTreeNode v-for="x in f.openings" :id="x.id" :key="x.id" :label="x.label" :icon="x.icon" />
      </NbTreeNode>
      <NbTreeNode v-if="f.loose.length" :id="`group:${f.floor}:loose`" label="Not in a room" icon="dots-three">
        <NbTreeNode v-for="x in f.loose" :id="x.id" :key="x.id" :label="x.label" :icon="x.icon" />
      </NbTreeNode>
    </NbTreeNode>
  </NbTree>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { HouseFloor, HousePlan, HouseRoom } from '@/api'
import { CELLS_PER_M, radiatorRoom, roomAt } from '@/house/geometry'
import { FURNITURE_NAME } from '@/house/editor'
import { DEVICE_ICON, FURNITURE_ICON } from '@/house/library'
import type { LiveDevice } from '@/house/live'
import { openingName } from '@/house/openings'

/** A row of the outline, as the editor selects it. */
export interface OutlinePick {
  type: 'floor' | 'room' | 'device' | 'furniture' | 'radiator' | 'opening'
  floor: string
  id: string
}

const props = defineProps<{
  plan: HousePlan
  devices: Map<string, LiveDevice>
  /** The selected row's id, as `outlineId` makes it. */
  selected: string | null
}>()

const emit = defineEmits<{ pick: [pick: OutlinePick] }>()

const ROOM_ICON: Record<HouseRoom['kind'], string> = {
  room: 'bounding-box',
  outdoor: 'tree',
  paved: 'squares-four',
  pool: 'swimming-pool',
}

interface Row {
  id: string
  label: string
  icon: string
}

const m = (cells: number) => `${Math.round((cells / CELLS_PER_M) * 100) / 100} m`

function floorTree(f: HouseFloor) {
  const byRoom = new Map<string, Row[]>()
  const rooms = f.rooms
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((r) => {
      const items: Row[] = []
      byRoom.set(r.id, items)
      return { id: outlineId('room', f.id, r.id), label: r.name || 'Unnamed', icon: ROOM_ICON[r.kind], items }
    })
  const loose: Row[] = []
  const put = (room: HouseRoom | undefined, row: Row) => (room ? byRoom.get(room.id)! : loose).push(row)

  for (const p of f.placements) {
    const d = props.devices.get(p.ref)
    put(roomAt(f, p.x, p.y), {
      id: outlineId('device', f.id, p.ref),
      label: d?.name ?? p.ref,
      icon: d ? DEVICE_ICON[d.kind] : 'devices',
    })
  }
  for (const x of f.furniture ?? []) {
    put(roomAt(f, x.x + x.w / 2, x.y + x.d / 2), {
      id: outlineId('furniture', f.id, x.id),
      label: FURNITURE_NAME[x.kind],
      icon: FURNITURE_ICON[x.kind],
    })
  }
  for (const r of f.radiators ?? []) {
    put(radiatorRoom(f, r), {
      id: outlineId('radiator', f.id, r.id),
      label: `Radiator, ${m(r.len)}`,
      icon: 'thermometer-hot',
    })
  }
  const openings = f.openings.map((o) => ({
    id: outlineId('opening', f.id, o.id),
    label: `${openingName(o)}, ${m(o.len)}`,
    icon: o.type === 'window' ? 'app-window' : o.type === 'open' ? 'arrows-out-line-horizontal' : 'door-open',
  }))
  return { id: outlineId('floor', f.id, f.id), floor: f.id, label: f.name, rooms, openings, loose }
}

const tree = computed(() =>
  props.plan.floors
    .slice()
    .sort((a, b) => b.level - a.level)
    .map(floorTree),
)

function pick(id: string) {
  const [type, floor, ...rest] = id.split(':')
  if (type === 'group') return
  emit('pick', { type: type as OutlinePick['type'], floor, id: rest.join(':') })
}

// Floors and rooms start open, and the selected row is always in view.
const treeEl = ref<{ expandIds: (ids: string[]) => void } | null>(null)
function expandTo(id: string | null) {
  if (!id) return
  const [, floor] = id.split(':')
  const f = tree.value.find((x) => x.floor === floor)
  if (!f) return
  const ids = [f.id]
  for (const r of f.rooms) if (r.id === id || r.items.some((x) => x.id === id)) ids.push(r.id)
  if (f.openings.some((x) => x.id === id)) ids.push(`group:${floor}:openings`)
  if (f.loose.some((x) => x.id === id)) ids.push(`group:${floor}:loose`)
  treeEl.value?.expandIds(ids)
}
onMounted(() => treeEl.value?.expandIds(tree.value.flatMap((f) => [f.id, ...f.rooms.map((r) => r.id)])))
watch(
  () => props.selected,
  (id) => expandTo(id),
)
</script>

<script lang="ts">
/** The outline's id for a row: its type, its floor and its own id. */
export const outlineId = (type: string, floor: string, id: string) => `${type}:${floor}:${id}`
</script>
