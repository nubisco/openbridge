<template>
  <div class="house-editor" :class="{ 'is-phone': phone }">
    <div class="house-editor__main">
      <div class="house-editor__toolbar">
        <NbTabs
          :model-value="floorId"
          :items="floorTabs"
          variant="contained"
          size="sm"
          aria-label="Floor to edit"
          @update:model-value="selectFloor"
        />
        <NbButton size="sm" variant="ghost" icon="plus" @click="newFloor">Floor</NbButton>
        <NbTabs
          :model-value="tool"
          :items="TOOLS"
          variant="contained"
          size="sm"
          aria-label="Drawing tool"
          @update:model-value="setTool"
        />
      </div>

      <div class="house-editor__canvas hv-stage-bg">
        <svg
          ref="svgEl"
          class="house-editor__svg"
          :class="`hv-tool-${tool}`"
          :viewBox="viewBox"
          role="application"
          aria-label="Blueprint editor"
          @pointerdown="onDown"
          @pointermove="onMove"
          @pointerup="onUp"
          @pointercancel="onUp"
          v-html="markup"
        />
      </div>
      <NbMessage variant="helper" class="house-editor__help">{{ help }}</NbMessage>
    </div>

    <aside class="house-editor__side">
      <!-- What is selected -->
      <NbPanel v-if="room" title="Room" :flat="true">
        <NbField v-slot="{ id }" label="Name" orientation="stack">
          <NbTextInput :id="id" v-model="room.name" size="sm" :maxlength="80" />
        </NbField>
        <NbField v-slot="{ id }" label="Type" orientation="stack">
          <NbSelect :id="id" v-model="room.kind" :options="ROOM_KINDS" size="sm" />
        </NbField>
        <p class="house-editor__muted">
          {{
            room.parts?.length
              ? `${metres(roomArea(room) / CELLS_PER_M)} m², in ${room.parts.length + 1} parts`
              : `${metres(room.w)} × ${metres(room.h)} m`
          }}
        </p>
        <!-- A wing is another rectangle joined to the room along an edge: an L
             is one wing, a U two. -->
        <div v-for="(part, i) in room.parts ?? []" :key="i" class="house-editor__row house-editor__row--tight">
          <span>Wing {{ i + 1 }} · {{ metres(part.w) }} × {{ metres(part.h) }} m</span>
          <NbButton
            size="sm"
            variant="ghost"
            icon="trash"
            :aria-label="`Remove wing ${i + 1}`"
            @click="removeWing(i)"
          />
        </div>
        <div class="house-editor__row">
          <NbButton
            size="sm"
            :variant="wingFor === room.id ? 'primary' : 'secondary'"
            :aria-pressed="wingFor === room.id"
            @click="toggleWing"
          >
            {{ wingFor === room.id ? 'Drawing a wing' : 'Add a wing' }}
          </NbButton>
          <NbButton size="sm" variant="danger" icon="trash" @click="deleteRoom">Delete room</NbButton>
        </div>
      </NbPanel>

      <NbPanel v-else-if="opening" :title="opening.type === 'door' ? 'Door' : 'Window'" :flat="true">
        <NbField v-slot="{ id }" label="Type" orientation="stack">
          <NbSelect :id="id" v-model="opening.type" :options="OPENING_KINDS" size="sm" />
        </NbField>
        <NbField v-slot="{ id }" label="Width (m)" orientation="stack">
          <NbNumberInput
            :id="id"
            :model-value="opening.len / CELLS_PER_M"
            :min="0.5"
            :max="10"
            :step="0.5"
            size="sm"
            @update:model-value="setOpeningLength"
          />
        </NbField>
        <div class="house-editor__row">
          <span />
          <NbButton size="sm" variant="danger" icon="trash" @click="deleteOpening">Remove</NbButton>
        </div>
      </NbPanel>

      <NbPanel v-else-if="placed" :title="placedDevice?.name ?? 'Device'" :flat="true">
        <p v-if="!placedDevice" class="house-editor__muted">
          This device is no longer on the bridge. Remove it from the plan, or leave it in case its plugin comes back.
        </p>
        <p v-else-if="placedDevice.kind === 'shutter'" class="house-editor__muted">
          {{
            placed.opening ? 'Attached to its window, and drawn on it.' : 'Drag it onto a window to attach it there.'
          }}
        </p>
        <NbField
          v-if="placedDevice?.kind === 'light' && !placedDevice.color"
          v-slot="{ id }"
          label="Glow colour"
          hint="This light cannot report a colour, so the plan uses this one."
          orientation="stack"
        >
          <NbSelect
            :id="id"
            :model-value="placed.color ?? WARM_LIGHT"
            :options="GLOW_COLOURS"
            size="sm"
            @update:model-value="(v: unknown) => setColor(String(v))"
          />
        </NbField>
        <template v-if="placedDevice?.kind === 'gate'">
          <NbField v-slot="{ id }" label="Gate width (m)" orientation="stack">
            <NbNumberInput
              :id="id"
              :model-value="(placed.length ?? 4) / CELLS_PER_M"
              :min="0.5"
              :max="20"
              :step="0.5"
              size="sm"
              @update:model-value="setGateLength"
            />
          </NbField>
          <NbField v-slot="{ id }" label="Runs" orientation="stack">
            <NbSelect
              :id="id"
              :model-value="placed.axis ?? 'h'"
              :options="GATE_AXES"
              size="sm"
              @update:model-value="(v: unknown) => setGateAxis(v === 'v' ? 'v' : 'h')"
            />
          </NbField>
        </template>
        <template v-if="placedDevice?.kind === 'heating'">
          <NbField label="Rooms its water circuit serves" orientation="stack">
            <div class="house-editor__checks">
              <NbCheckbox
                v-for="r in walledRooms"
                :key="r.id"
                :label="`${r.name} (${r.floor})`"
                :model-value="placed.circuitRooms?.includes(r.id) ?? false"
                @update:model-value="(v?: boolean) => toggleCircuitRoom(r.id, !!v)"
              />
            </div>
          </NbField>
        </template>
        <div class="house-editor__row">
          <span />
          <NbButton size="sm" variant="secondary" @click="removePlaced">Remove from plan</NbButton>
        </div>
      </NbPanel>

      <NbPanel v-else :title="floor.name" :flat="true">
        <NbField v-slot="{ id }" label="Floor name" orientation="stack">
          <NbTextInput :id="id" v-model="floor.name" size="sm" :maxlength="80" />
        </NbField>
        <template v-if="floor.level === 0">
          <NbField v-slot="{ id }" label="Plot width (m)" orientation="stack">
            <NbNumberInput
              :id="id"
              :model-value="plan.plot.w / CELLS_PER_M"
              :min="minPlot.w / CELLS_PER_M"
              :max="200"
              :step="0.5"
              size="sm"
              @update:model-value="(v: number | null) => setPlot('w', v)"
            />
          </NbField>
          <NbField v-slot="{ id }" label="Plot depth (m)" orientation="stack">
            <NbNumberInput
              :id="id"
              :model-value="plan.plot.h / CELLS_PER_M"
              :min="minPlot.h / CELLS_PER_M"
              :max="200"
              :step="0.5"
              size="sm"
              @update:model-value="(v: number | null) => setPlot('h', v)"
            />
          </NbField>
        </template>
        <div class="house-editor__row">
          <span class="house-editor__muted">{{ hasFloorBelow ? 'The dashed outline is the floor below.' : '' }}</span>
          <NbButton v-if="plan.floors.length > 1" size="sm" variant="danger" icon="trash" @click="deleteFloor">
            Delete floor
          </NbButton>
        </div>
      </NbPanel>

      <NbPanel title="Not on the plan yet" :flat="true">
        <p v-if="!unplaced.length" class="house-editor__muted">Every device is on the plan.</p>
        <p v-else class="house-editor__muted">Drag one onto the plan, or tap it and then tap where it is.</p>
        <div class="house-editor__tray">
          <NbButton
            v-for="d in unplaced"
            :key="d.ref"
            size="sm"
            :variant="armed === d.ref ? 'primary' : 'secondary'"
            class="house-editor__chip"
            :aria-pressed="armed === d.ref"
            @pointerdown="(e: PointerEvent) => chipDown(e, d.ref)"
            @click="chipClick(d.ref)"
          >
            {{ KIND_LETTER[d.kind] }} · {{ d.name }}
          </NbButton>
        </div>
      </NbPanel>
    </aside>

    <div v-if="ghost" class="house-editor__ghost" :style="{ left: `${ghost.x}px`, top: `${ghost.y}px` }">
      {{ ghost.name }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useConfirm, usePhoneLayout, useToast } from '@nubisco/ui'
import type { HouseFloor, HouseOpening, HousePlan, HouseRect, HouseRoom } from '@/api'
import { CELLS_PER_M, S, clamp, openingUnits, roomArea, roomRects, wallUnits } from '@/house/geometry'
import {
  addFloor,
  addOpening,
  addPart,
  addRoom,
  nearestWall,
  openingAt,
  place,
  removeFloor,
  removeOpening,
  removePart,
  roomPayload,
  unplace,
  renderEditor,
  setPlotSize,
  shapeValid,
} from '@/house/editor'
import { KIND_LETTER, type LiveDevice } from '@/house/live'
import { WARM_LIGHT } from '@/house/scene'

const props = defineProps<{
  /** The draft. Edited in place. */
  plan: HousePlan
  devices: Map<string, LiveDevice>
  allDevices: LiveDevice[]
  initialFloor: string | null
}>()

const { phone } = usePhoneLayout()
const confirm = useConfirm()
const toast = useToast()

// Garden and Pool draw the same rectangles as Room, without walls. The type
// can still be changed afterwards in the room's panel.
const TOOLS = [
  { id: 'select', label: 'Select' },
  { id: 'room', label: 'Room' },
  { id: 'outdoor', label: 'Garden' },
  { id: 'pool', label: 'Pool' },
  { id: 'door', label: 'Door' },
  { id: 'window', label: 'Window' },
]
const ROOM_KINDS = [
  { label: 'Room (has walls)', value: 'room' },
  { label: 'Outdoor zone', value: 'outdoor' },
  { label: 'Pool', value: 'pool' },
]
const OPENING_KINDS = [
  { label: 'Door', value: 'door' },
  { label: 'Window', value: 'window' },
]
const GATE_AXES = [
  { label: 'Left to right', value: 'h' },
  { label: 'Front to back', value: 'v' },
]
const GLOW_COLOURS = [
  { label: 'Warm white', value: WARM_LIGHT },
  { label: 'Neutral white', value: '#ffe1b3' },
  { label: 'Cool white', value: '#cfe3ff' },
  { label: 'Blue', value: '#6f8bff' },
  { label: 'Green', value: '#5fe0a0' },
  { label: 'Pink', value: '#ff5fd2' },
  { label: 'Red', value: '#ff5a4d' },
]

type Tool = 'select' | 'room' | 'outdoor' | 'pool' | 'door' | 'window'
const isAreaTool = (t: Tool): t is 'room' | 'outdoor' | 'pool' => t === 'room' || t === 'outdoor' || t === 'pool'
const tool = ref<Tool>('room')
const floorId = ref(props.initialFloor ?? props.plan.floors[0].id)
const selRoom = ref<string | null>(null)
const selRef = ref<string | null>(null)
const selOpening = ref<string | null>(null)
const armed = ref<string | null>(null)
const draft = ref<Pick<HouseRoom, 'x' | 'y' | 'w' | 'h'> | null>(null)
const svgEl = ref<SVGSVGElement | null>(null)
const unit = ref(1)

const floor = computed<HouseFloor>(() => props.plan.floors.find((f) => f.id === floorId.value) ?? props.plan.floors[0])
const floorTabs = computed(() =>
  props.plan.floors
    .slice()
    .sort((a, b) => b.level - a.level)
    .map((f) => ({ id: f.id, label: f.name })),
)
const room = computed(() => floor.value.rooms.find((r) => r.id === selRoom.value) ?? null)
const opening = computed(() => floor.value.openings.find((o) => o.id === selOpening.value) ?? null)
const placed = computed(() => floor.value.placements.find((p) => p.ref === selRef.value) ?? null)
const placedDevice = computed(() => (placed.value ? props.devices.get(placed.value.ref) : undefined))
const unplaced = computed(() => {
  const on = new Set(props.plan.floors.flatMap((f) => f.placements.map((p) => p.ref)))
  return props.allDevices.filter((d) => !on.has(d.ref)).sort((a, b) => a.name.localeCompare(b.name))
})
const walledRooms = computed(() =>
  props.plan.floors.flatMap((f) => f.rooms.filter((r) => r.kind === 'room').map((r) => ({ ...r, floor: f.name }))),
)
/** The plot cannot shrink under a room. */
const minPlot = computed(() => {
  const rooms = props.plan.floors.flatMap((f) => f.rooms)
  return {
    w: Math.max(2, ...rooms.map((r) => r.x + r.w)),
    h: Math.max(2, ...rooms.map((r) => r.y + r.h)),
  }
})

const viewBox = computed(() => {
  const pad = 0.5 * CELLS_PER_M * S
  return `${-pad} ${-pad} ${props.plan.plot.w * S + 2 * pad} ${props.plan.plot.h * S + 2 * pad}`
})

const markup = computed(() =>
  renderEditor(props.plan, floor.value, props.devices, {
    selectedRoom: selRoom.value,
    selectedRef: selRef.value,
    selectedOpening: selOpening.value,
    draft: draft.value,
    unit: unit.value,
    showHandles: tool.value === 'select',
  }),
)

const help = computed(() => {
  if (wingFor.value) return 'Drag a rectangle along an edge of the room to join it as a wing, making an L or a U.'
  if (armed.value) return `Now tap the plan where "${props.devices.get(armed.value)?.name ?? 'it'}" is.`
  return {
    select: 'Drag a room to move it, or its corners to resize it. Drag a device to move it. Tap anything to edit it.',
    room: 'Drag on the grid to draw a room. It snaps to half a metre. Draw one inside another for a room within a room.',
    outdoor: 'Drag on the grid to draw a garden, terrace or drive. It has no walls.',
    pool: 'Drag on the grid to draw a pool.',
    door: 'Tap a wall to put a door there. Tap a door to edit it.',
    window: 'Tap a wall to put a window there. Tap a window to edit it.',
  }[tool.value]
})

const metres = (cells: number) => {
  const m = cells / CELLS_PER_M
  return Number.isInteger(m) ? String(m) : m.toFixed(1)
}

function setTool(id: string) {
  tool.value = id as Tool
  armed.value = null
  wingFor.value = null
}

/** The room the next rectangle drawn joins as a wing, while adding one. */
const wingFor = ref<string | null>(null)

function toggleWing() {
  wingFor.value = wingFor.value === selRoom.value ? null : selRoom.value
}

function removeWing(i: number) {
  if (room.value) removePart(room.value, i)
}

function clearSelection() {
  wingFor.value = null
  selRoom.value = null
  selRef.value = null
  selOpening.value = null
}

function selectFloor(id: string) {
  floorId.value = id
  clearSelection()
}

function newFloor() {
  const f = addFloor(props.plan)
  floorId.value = f.id
  clearSelection()
  selRoom.value = f.rooms[0]?.id ?? null
  tool.value = 'select'
}

const hasFloorBelow = computed(() => props.plan.floors.some((f) => f.level < floor.value.level))

async function deleteFloor() {
  const f = floor.value
  const devices = f.placements.length
  const ok = await confirm({
    title: 'Delete floor',
    subjectLabel: 'Floor',
    subject: f.name,
    message: devices
      ? `Its rooms go, and its ${devices} device${devices === 1 ? '' : 's'} move back to "Not on the plan yet". Nothing is saved until you save the plan.`
      : 'Its rooms go. Nothing is saved until you save the plan.',
    confirmLabel: 'Delete',
  })
  if (!ok) return
  removeFloor(props.plan, f.id)
  floorId.value = props.plan.floors[0].id
  clearSelection()
}

function deleteRoom() {
  floor.value.rooms = floor.value.rooms.filter((r) => r.id !== selRoom.value)
  selRoom.value = null
}

function deleteOpening() {
  if (opening.value) removeOpening(floor.value, opening.value.id)
  selOpening.value = null
}

function setOpeningLength(v: number | null) {
  const o = opening.value
  if (!o || v === null) return
  const units = wallUnits(floor.value)
  const want = clamp(Math.round(v * CELLS_PER_M), 1, 20)
  // Grow only along wall, and never over another opening.
  const others = new Set(floor.value.openings.filter((x) => x !== o).flatMap(openingUnits))
  let len = 1
  while (len < want) {
    const next: HouseOpening = { ...o, len: len + 1 }
    const k = openingUnits(next)[len]
    if (!units.has(k) || others.has(k)) break
    len++
  }
  o.len = len
}

function setColor(c: string) {
  if (placed.value) placed.value.color = c
}

function setGateLength(v: number | null) {
  if (placed.value && v !== null) placed.value.length = clamp(Math.round(v * CELLS_PER_M), 1, 40)
}

function setGateAxis(axis: 'h' | 'v') {
  if (placed.value) placed.value.axis = axis
}

function toggleCircuitRoom(id: string, on: boolean) {
  const p = placed.value
  if (!p) return
  const list = new Set(p.circuitRooms ?? [])
  if (on) list.add(id)
  else list.delete(id)
  if (list.size) p.circuitRooms = [...list]
  else delete p.circuitRooms
}

function removePlaced() {
  if (placed.value) unplace(props.plan, placed.value.ref)
  selRef.value = null
}

function setPlot(axis: 'w' | 'h', v: number | null) {
  if (v === null) return
  setPlotSize(props.plan, axis, v * CELLS_PER_M)
}

// ─── Pointer ────────────────────────────────────────────────────────────────

type Drag =
  | { type: 'draw'; x0: number; y0: number }
  | {
      type: 'resize'
      room: HouseRoom
      /** The part being resized: the room itself, or one of its wings. */
      r: HouseRect
      corner: string
      o: { x1: number; y1: number; x2: number; y2: number }
    }
  | {
      type: 'move'
      r: HouseRoom
      start: { x: number; y: number }
      /** Where each part started, main rectangle first. */
      o: HouseRect[]
      payload: ReturnType<typeof roomPayload>
    }
  | { type: 'device'; ref: string }
let drag: Drag | null = null

function toGrid(e: { clientX: number; clientY: number }) {
  const m = svgEl.value?.getScreenCTM()
  if (!m) return { x: 0, y: 0 }
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse())
  return { x: p.x / S, y: p.y / S }
}

function measureUnit() {
  const m = svgEl.value?.getScreenCTM()
  unit.value = m && m.a ? 1 / m.a : 1
}

function placeAt(ref: string, p: { x: number; y: number }) {
  const d = props.devices.get(ref)
  if (!d) return
  place(props.plan, floor.value, d, p.x, p.y)
  armed.value = null
  clearSelection()
  selRef.value = ref
}

function onDown(e: PointerEvent) {
  const p = toGrid(e)
  const pw = props.plan.plot.w
  const ph = props.plan.plot.h
  const t = e.target instanceof Element ? e.target : null
  if (armed.value) return placeAt(armed.value, p)

  if (isAreaTool(tool.value) || wingFor.value) {
    const x0 = clamp(Math.round(p.x), 0, pw)
    const y0 = clamp(Math.round(p.y), 0, ph)
    drag = { type: 'draw', x0, y0 }
    draft.value = { x: x0, y: y0, w: 0, h: 0 }
  } else if (tool.value === 'door' || tool.value === 'window') {
    const u = nearestWall(floor.value, p.x, p.y)
    clearSelection()
    if (!u) return
    const existing = openingAt(floor.value, u)
    const o = existing ?? addOpening(floor.value, u, tool.value)
    if (o) selOpening.value = o.id
    return
  } else {
    const handle = t?.closest('[data-handle]')
    const dev = t?.closest('[data-ref]')
    const rm = t?.closest('[data-room]')
    if (handle && room.value) {
      const [index, corner] = (handle.getAttribute('data-handle') as string).split(':')
      const r = roomRects(room.value)[Number(index)]
      if (!r) return
      drag = {
        type: 'resize',
        room: room.value,
        r,
        corner,
        o: { x1: r.x, y1: r.y, x2: r.x + r.w, y2: r.y + r.h },
      }
    } else if (dev) {
      clearSelection()
      selRef.value = dev.getAttribute('data-ref')
      drag = { type: 'device', ref: selRef.value as string }
    } else if (rm) {
      const r = floor.value.rooms.find((x) => x.id === rm.getAttribute('data-room'))
      if (!r) return
      clearSelection()
      selRoom.value = r.id
      drag = { type: 'move', r, start: p, o: roomRects(r).map((q) => ({ ...q })), payload: roomPayload(floor.value, r) }
    } else {
      // A tap on a wall opening in the select tool edits it.
      const u = nearestWall(floor.value, p.x, p.y, 0.6)
      const o = u ? openingAt(floor.value, u) : undefined
      clearSelection()
      if (o) selOpening.value = o.id
    }
  }
  if (drag) {
    e.preventDefault()
    try {
      svgEl.value?.setPointerCapture(e.pointerId)
    } catch {
      /* a synthetic pointer has nothing to capture */
    }
  }
}

function onMove(e: PointerEvent) {
  if (!drag) return
  const p = toGrid(e)
  const pw = props.plan.plot.w
  const ph = props.plan.plot.h
  if (drag.type === 'draw') {
    const x = clamp(Math.round(p.x), 0, pw)
    const y = clamp(Math.round(p.y), 0, ph)
    draft.value = {
      x: Math.min(x, drag.x0),
      y: Math.min(y, drag.y0),
      w: Math.abs(x - drag.x0),
      h: Math.abs(y - drag.y0),
    }
  } else if (drag.type === 'resize') {
    const { o, r, corner, room: owner } = drag
    let { x1, y1, x2, y2 } = o
    if (corner.includes('w')) x1 = clamp(Math.round(p.x), 0, x2 - 1)
    if (corner.includes('e')) x2 = clamp(Math.round(p.x), x1 + 1, pw)
    if (corner.includes('n')) y1 = clamp(Math.round(p.y), 0, y2 - 1)
    if (corner.includes('s')) y2 = clamp(Math.round(p.y), y1 + 1, ph)
    // A size that would split the room or overlap its own parts is not taken:
    // the part stays at the last size that kept the room in one piece.
    const before = { x: r.x, y: r.y, w: r.w, h: r.h }
    Object.assign(r, { x: x1, y: y1, w: x2 - x1, h: y2 - y1 })
    if (!shapeValid(owner)) Object.assign(r, before)
  } else if (drag.type === 'move') {
    const { r, o, start, payload } = drag
    // The whole shape moves, kept inside the plot by the box around it.
    const box = {
      x: Math.min(...o.map((q) => q.x)),
      y: Math.min(...o.map((q) => q.y)),
      x2: Math.max(...o.map((q) => q.x + q.w)),
      y2: Math.max(...o.map((q) => q.y + q.h)),
    }
    const dx = clamp(Math.round(p.x - start.x), -box.x, pw - box.x2)
    const dy = clamp(Math.round(p.y - start.y), -box.y, ph - box.y2)
    roomRects(r).forEach((q, i) => Object.assign(q, { x: o[i].x + dx, y: o[i].y + dy }))
    for (const q of payload.rooms) {
      roomRects(q.room).forEach((x, i) => Object.assign(x, { x: q.o[i].x + dx, y: q.o[i].y + dy }))
    }
    for (const q of payload.openings) Object.assign(q.o, { x: q.x + dx, y: q.y + dy })
    for (const q of payload.placements) Object.assign(q.p, { x: q.x + dx, y: q.y + dy })
  } else if (drag.type === 'device') {
    const ref = drag.ref
    const d = props.devices.get(ref)
    const pl = floor.value.placements.find((x) => x.ref === ref)
    if (!pl) return
    if (d) place(props.plan, floor.value, d, p.x, p.y)
    else Object.assign(pl, { x: clamp(Math.round(p.x * 2) / 2, 0, pw), y: clamp(Math.round(p.y * 2) / 2, 0, ph) })
  }
}

function onUp() {
  if (drag?.type === 'draw' && wingFor.value) {
    const d = draft.value
    draft.value = null
    const owner = floor.value.rooms.find((r) => r.id === wingFor.value)
    if (owner && d && d.w >= 1 && d.h >= 1) {
      if (addPart(owner, d)) wingFor.value = null
      else toast.warning('A wing has to share an edge with the room and not overlap it. Try again.')
    }
  } else if (drag?.type === 'draw') {
    const d = draft.value
    draft.value = null
    if (d && d.w >= 1 && d.h >= 1) {
      const r = addRoom(props.plan, floor.value, d, isAreaTool(tool.value) ? tool.value : 'room')
      clearSelection()
      selRoom.value = r.id
    }
  }
  drag = null
}

// ─── Tray ───────────────────────────────────────────────────────────────────
// A device can be dragged from the tray, or tapped to arm it and then placed
// with a tap on the plan, which is the path that works for a finger and a
// keyboard alike.

const ghost = ref<{ ref: string; name: string; x: number; y: number } | null>(null)
let chip: { ref: string; x: number; y: number; moved: boolean } | null = null
let suppressClick = false

function chipDown(e: PointerEvent, ref: string) {
  chip = { ref, x: e.clientX, y: e.clientY, moved: false }
  window.addEventListener('pointermove', chipMove)
  window.addEventListener('pointerup', chipUp, { once: true })
}

function chipMove(e: PointerEvent) {
  if (!chip) return
  if (!chip.moved && Math.hypot(e.clientX - chip.x, e.clientY - chip.y) > 6) chip.moved = true
  if (chip.moved) {
    ghost.value = { ref: chip.ref, name: props.devices.get(chip.ref)?.name ?? '', x: e.clientX, y: e.clientY }
  }
}

function chipUp(e: PointerEvent) {
  window.removeEventListener('pointermove', chipMove)
  const c = chip
  chip = null
  ghost.value = null
  if (!c?.moved) return
  suppressClick = true
  const rect = svgEl.value?.getBoundingClientRect()
  if (rect && e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
    placeAt(c.ref, toGrid(e))
  }
}

function chipClick(ref: string) {
  if (suppressClick) {
    suppressClick = false
    return
  }
  armed.value = armed.value === ref ? null : ref
}

let observer: ResizeObserver | null = null
onMounted(() => {
  measureUnit()
  observer = new ResizeObserver(() => measureUnit())
  if (svgEl.value) observer.observe(svgEl.value)
  // Start where the person can act: drawing on an empty plan, selecting on one with rooms.
  if (props.plan.floors.some((f) => f.rooms.length)) tool.value = 'select'
})
onBeforeUnmount(() => {
  observer?.disconnect()
  window.removeEventListener('pointermove', chipMove)
})
watch(
  () => [props.plan.plot.w, props.plan.plot.h],
  () => nextTick(measureUnit),
)
</script>

<style lang="scss" scoped>
.house-editor {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: var(--nb-spacing-16);
  align-items: start;

  &.is-phone {
    grid-template-columns: minmax(0, 1fr);
  }
}

.house-editor__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--nb-spacing-8);
  margin-bottom: var(--nb-spacing-8);

  // A tab bar fills its row by default. Here several sit side by side.
  > :deep(.nb-tabs) {
    width: auto;
    max-width: 100%;
  }
}

.house-editor__canvas {
  border-radius: var(--nb-radius-md);
  border: 1px solid var(--nb-c-border);
  overflow: hidden;
}

.house-editor__svg {
  width: 100%;
  max-height: 74vh;
  display: block;
  touch-action: none;
  cursor: crosshair;
  user-select: none;
  -webkit-user-select: none;

  &.hv-tool-select {
    cursor: default;
  }
}

.house-editor__help {
  margin-top: var(--nb-spacing-8);
}

.house-editor__side {
  display: flex;
  flex-direction: column;
  gap: var(--nb-spacing-12);
  min-width: 0;

  :deep(.nb-field) {
    margin-bottom: var(--nb-spacing-8);
  }
}

.house-editor__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nb-spacing-8);
  margin-top: var(--nb-spacing-8);
}

.house-editor__row--tight {
  margin-top: 0;
}

.house-editor__muted {
  color: var(--nb-c-text-muted);
  margin: 0 0 var(--nb-spacing-8);
}

.house-editor__checks {
  display: grid;
  gap: var(--nb-spacing-4);
}

.house-editor__tray {
  display: flex;
  flex-wrap: wrap;
  gap: var(--nb-spacing-8);
}

.house-editor__chip {
  touch-action: none;
}

.house-editor__ghost {
  position: fixed;
  z-index: 50;
  pointer-events: none;
  transform: translate(-50%, -50%);
  padding: var(--nb-spacing-4) var(--nb-spacing-8);
  border-radius: var(--nb-radius-control);
  background: var(--nb-c-primary);
  color: #fff;
  font-size: 12px;
  white-space: nowrap;
}
</style>
