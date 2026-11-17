<template>
  <div class="house-editor" :class="{ 'is-phone': phone }">
    <div class="house-editor__main">
      <!-- Rounded, here only: the controls floating over the blueprint. -->
      <div class="house-editor__toolbar" data-nb-appearance="rounded">
        <NbTabs
          :model-value="floorId"
          :items="floorTabs"
          variant="contained"
          size="sm"
          aria-label="Floor to edit"
          @update:model-value="selectFloor"
        />
        <NbButton size="sm" variant="secondary" icon="plus" @click="newFloor">Floor</NbButton>
        <!-- One icon per tool, named by its tooltip (which is also its accessible name). -->
        <div class="house-editor__tools" role="toolbar" aria-label="Drawing tool">
          <NbButton
            v-for="t in TOOLS"
            :key="t.id"
            v-nb-tooltip="{ body: t.label, position: 'bottom' }"
            size="sm"
            :variant="tool === t.id ? 'primary' : 'ghost'"
            :icon="t.icon"
            :aria-pressed="tool === t.id"
            @click="setTool(t.id)"
          />
        </div>
        <NbSelect
          v-if="tool === 'furniture'"
          v-model="furnitureKind"
          :options="FURNITURE_KINDS"
          size="sm"
          aria-label="Furniture to add"
          class="house-editor__kind"
        />
        <NbButton
          v-if="!phone && !(inspector.visible && inspector.mode === 'house-editor')"
          size="sm"
          variant="secondary"
          icon="sidebar-simple"
          @click="inspector.openHouseEditor()"
        >
          Details
        </NbButton>
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
      <div class="house-editor__help" data-nb-appearance="rounded">
        <NbMessage variant="helper">{{ help }}</NbMessage>
      </div>
    </div>

    <!-- What is selected, and the devices not on the plan yet. On a wide
         screen they live in the shell's inspector beside the blueprint. On a
         phone the inspector is a sheet that would cover the blueprint, so
         they stay under it. -->
    <Teleport defer to="#house-editor-inspector" :disabled="phone">
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

        <NbPanel
          v-else-if="opening"
          :title="opening.type === 'door' && opening.glass ? 'Glass door' : OPENING_TITLE[opening.type]"
          :flat="true"
        >
          <NbField v-slot="{ id }" label="Type" orientation="stack">
            <NbSelect :id="id" v-model="opening.type" :options="OPENING_KINDS" size="sm" />
          </NbField>
          <NbField v-slot="{ id }" label="Width (m)" orientation="stack">
            <NbNumberInput
              :id="id"
              :model-value="opening.len / CELLS_PER_M"
              :min="0.5"
              :max="20"
              :step="0.25"
              size="sm"
              @update:model-value="setOpeningLength"
            />
          </NbField>
          <template v-if="opening.type === 'door'">
            <div class="house-editor__row house-editor__row--tight">
              <span>Glass</span>
              <NbSwitch
                name="house-door-glass"
                :model-value="!!opening.glass"
                @update:model-value="(v?: boolean) => setGlass(!!v)"
              />
            </div>
            <p v-if="opening.glass" class="house-editor__muted">A shutter can sit on it, like on a window.</p>
            <p class="house-editor__muted">{{ doorText }}</p>
            <div class="house-editor__row house-editor__row--tight">
              <NbButton size="sm" variant="secondary" icon="arrows-left-right" @click="flipHinge">Flip hinge</NbButton>
              <NbButton size="sm" variant="secondary" icon="arrows-down-up" @click="flipSide">Open other way</NbButton>
            </div>
          </template>
          <p v-if="opening.type === 'open'" class="house-editor__muted">
            No wall is drawn here, so the two rooms run into each other. Drag an end to leave part of the wall standing.
          </p>
          <p class="house-editor__muted">Drag it along the wall to move it, or drag an end to resize it.</p>
          <div class="house-editor__row">
            <span />
            <NbButton size="sm" variant="danger" icon="trash" @click="deleteOpening">Remove</NbButton>
          </div>
        </NbPanel>

        <NbPanel v-else-if="radiator" title="Radiator" :flat="true">
          <NbField v-slot="{ id }" label="Width (m)" orientation="stack">
            <NbNumberInput
              :id="id"
              :model-value="radiator.len / CELLS_PER_M"
              :min="0.5"
              :max="5"
              :step="0.25"
              size="sm"
              @update:model-value="setRadiatorLength"
            />
          </NbField>
          <p class="house-editor__muted">{{ radiatorText }}</p>
          <div class="house-editor__row house-editor__row--tight">
            <NbButton size="sm" variant="secondary" icon="arrows-down-up" @click="flipRadiator">
              Other side of the wall
            </NbButton>
          </div>
          <p class="house-editor__muted">Drag it along the wall to move it, or drag an end to resize it.</p>
          <div class="house-editor__row">
            <span />
            <NbButton size="sm" variant="danger" icon="trash" @click="deleteRadiator">Remove</NbButton>
          </div>
        </NbPanel>

        <NbPanel v-else-if="piece" :title="FURNITURE_NAME[piece.kind]" :flat="true">
          <NbField v-slot="{ id }" label="Type" orientation="stack">
            <NbSelect :id="id" v-model="piece.kind" :options="FURNITURE_KINDS" size="sm" />
          </NbField>
          <NbField v-slot="{ id }" label="Width (m)" orientation="stack">
            <NbNumberInput
              :id="id"
              :model-value="piece.w / CELLS_PER_M"
              :min="0.25"
              :max="20"
              :step="0.25"
              size="sm"
              @update:model-value="(v: number | null) => setPieceSize('w', v)"
            />
          </NbField>
          <NbField v-slot="{ id }" label="Depth (m)" orientation="stack">
            <NbNumberInput
              :id="id"
              :model-value="piece.d / CELLS_PER_M"
              :min="0.25"
              :max="20"
              :step="0.25"
              size="sm"
              @update:model-value="(v: number | null) => setPieceSize('d', v)"
            />
          </NbField>
          <NbField v-if="piece.kind !== 'rug'" v-slot="{ id }" label="Height (m)" orientation="stack">
            <NbNumberInput
              :id="id"
              :model-value="furnitureHeight(piece)"
              :min="0.1"
              :max="3"
              :step="0.05"
              size="sm"
              @update:model-value="setPieceHeight"
            />
          </NbField>
          <p class="house-editor__muted">{{ pieceText }}</p>
          <div v-if="FURNITURE_BACK[piece.kind]" class="house-editor__row house-editor__row--tight">
            <NbButton size="sm" variant="secondary" icon="arrows-down-up" @click="flipPiece">
              {{
                piece.kind === 'bed' || piece.kind === 'lounger' ? 'Head at the other end' : 'Back to the other side'
              }}
            </NbButton>
          </div>
          <div class="house-editor__row">
            <NbButton size="sm" variant="secondary" icon="arrow-clockwise" @click="turnPiece">Turn</NbButton>
            <NbButton size="sm" variant="danger" icon="trash" @click="deletePiece">Remove</NbButton>
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
          <NbField v-if="placedDevice?.kind === 'light'" v-slot="{ id }" label="Mounted" orientation="stack">
            <NbSelect
              :id="id"
              :model-value="lightMount(floor, placed)"
              :options="LIGHT_MOUNTS"
              size="sm"
              @update:model-value="(v: unknown) => setMount(v as HouseLightMount)"
            />
          </NbField>
          <template v-if="placedDevice && takesLook(placedDevice)">
            <NbField
              v-slot="{ id }"
              label="Drawn as"
              hint="The bridge sees a plug or a relay. Say what it powers, and the plan draws that."
              orientation="stack"
            >
              <NbSelect
                :id="id"
                :model-value="placed.look ?? ''"
                :options="lookOptions"
                size="sm"
                @update:model-value="(v: unknown) => setLook(v ? (v as HouseLook) : null)"
              />
            </NbField>
            <NbField
              v-if="(placed.look ?? placedDevice.defaultLook) === 'tv'"
              v-slot="{ id }"
              label="Screen runs"
              orientation="stack"
            >
              <NbSelect
                :id="id"
                :model-value="placed.axis ?? 'h'"
                :options="GATE_AXES"
                size="sm"
                @update:model-value="(v: unknown) => setGateAxis(v === 'v' ? 'v' : 'h')"
              />
            </NbField>
          </template>
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
    </Teleport>

    <div v-if="ghost" class="house-editor__ghost" :style="{ left: `${ghost.x}px`, top: `${ghost.y}px` }">
      {{ ghost.name }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useConfirm, usePhoneLayout, useToast } from '@nubisco/ui'
import { useInspectorStore } from '@/stores/inspector'
import type {
  HouseFloor,
  HouseFurniture,
  HouseFurnitureKind,
  HouseLightMount,
  HouseLook,
  HouseOpening,
  HousePlan,
  HouseRadiator,
  HouseRect,
  HouseRoom,
} from '@/api'
import {
  CELLS_PER_M,
  FURNITURE_BACK,
  FURNITURE_HEIGHT,
  S,
  clamp,
  flippedSide,
  furnitureHeight,
  lightMount,
  radiatorRoom,
  roomArea,
  roomRects,
} from '@/house/geometry'
import {
  FURNITURE_NAME,
  addFloor,
  addFurniture,
  addOpenWall,
  flipFurniture,
  moveFurniture,
  removeFurniture,
  resizeFurniture,
  turnFurniture,
  addRadiator,
  moveRadiator,
  radiatorFits,
  removeRadiator,
  resizeRadiator,
  addOpening,
  addPart,
  addRoom,
  fitsFree,
  moveOpening,
  nearestWall,
  openingAt,
  place,
  removeFloor,
  removeOpening,
  removePart,
  resizeOpening,
  roomPayload,
  unplace,
  renderEditor,
  setPlotSize,
  shapeValid,
} from '@/house/editor'
import { KIND_LABEL, KIND_LETTER, LOOK_LABEL, type LiveDevice } from '@/house/live'
import { WARM_LIGHT } from '@/house/scene'

const props = defineProps<{
  /** The draft. Edited in place. */
  plan: HousePlan
  devices: Map<string, LiveDevice>
  allDevices: LiveDevice[]
  initialFloor: string | null
}>()

const { phone } = usePhoneLayout()
const inspector = useInspectorStore()
// The panels open with the editor on a wide screen, and go with it.
onMounted(() => {
  if (!phone.value) inspector.openHouseEditor()
})
onBeforeUnmount(() => {
  if (inspector.mode === 'house-editor') inspector.close()
})
const confirm = useConfirm()
const toast = useToast()

// Garden and Pool draw the same rectangles as Room, without walls. The type
// can still be changed afterwards in the room's panel.
const TOOLS = [
  { id: 'select', label: 'Select', icon: 'cursor' },
  { id: 'room', label: 'Room', icon: 'bounding-box' },
  { id: 'outdoor', label: 'Garden', icon: 'tree' },
  { id: 'paved', label: 'Paving', icon: 'squares-four' },
  { id: 'pool', label: 'Pool', icon: 'swimming-pool' },
  { id: 'door', label: 'Door', icon: 'door-open' },
  { id: 'window', label: 'Window', icon: 'app-window' },
  { id: 'slider', label: 'Sliding door', icon: 'columns' },
  { id: 'glassdoor', label: 'Glass door', icon: 'door' },
  { id: 'open', label: 'Open wall', icon: 'arrows-out-line-horizontal' },
  { id: 'radiator', label: 'Radiator', icon: 'thermometer-hot' },
  { id: 'furniture', label: 'Furniture', icon: 'armchair' },
]
const FURNITURE_KINDS = (Object.keys(FURNITURE_NAME) as HouseFurnitureKind[]).map((k) => ({
  label: FURNITURE_NAME[k],
  value: k,
}))
const ROOM_KINDS = [
  { label: 'Room (has walls)', value: 'room' },
  { label: 'Outdoor zone', value: 'outdoor' },
  { label: 'Paving', value: 'paved' },
  { label: 'Pool', value: 'pool' },
]
const OPENING_KINDS = [
  { label: 'Door', value: 'door' },
  { label: 'Window', value: 'window' },
  { label: 'Sliding glass door', value: 'slider' },
  { label: 'Open, no wall', value: 'open' },
]
const OPENING_TITLE = { door: 'Door', window: 'Window', open: 'Open wall', slider: 'Sliding door' } as const
const GATE_AXES = [
  { label: 'Left to right', value: 'h' },
  { label: 'Front to back', value: 'v' },
]
const LIGHT_MOUNTS = [
  { label: 'Ceiling', value: 'ceiling' },
  { label: 'Wall', value: 'wall' },
  { label: 'Floor lamp', value: 'floor' },
  { label: 'Table lamp', value: 'table' },
  { label: 'In the pool', value: 'pool' },
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

type Tool =
  | 'select'
  | 'room'
  | 'outdoor'
  | 'paved'
  | 'pool'
  | 'door'
  | 'window'
  | 'slider'
  | 'glassdoor'
  | 'open'
  | 'radiator'
  | 'furniture'
const isAreaTool = (t: Tool): t is 'room' | 'outdoor' | 'paved' | 'pool' =>
  t === 'room' || t === 'outdoor' || t === 'paved' || t === 'pool'
const tool = ref<Tool>('room')
const floorId = ref(props.initialFloor ?? props.plan.floors[0].id)
const selRoom = ref<string | null>(null)
const selRef = ref<string | null>(null)
const selOpening = ref<string | null>(null)
const selRadiator = ref<string | null>(null)
const selFurniture = ref<string | null>(null)
/** What the Furniture tool puts down next. */
const furnitureKind = ref<HouseFurnitureKind>('table')
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
const piece = computed(() => (floor.value.furniture ?? []).find((f) => f.id === selFurniture.value) ?? null)
const radiator = computed(() => (floor.value.radiators ?? []).find((r) => r.id === selRadiator.value) ?? null)
/** "Heats the Kitchen, from Heat pump", or why it does not. */
const radiatorText = computed(() => {
  const r = radiator.value
  if (!r) return ''
  const room = radiatorRoom(floor.value, r)
  if (!room) return 'It is not in a room.'
  const feed = props.plan.floors.flatMap((f) => f.placements).find((p) => p.circuitRooms?.includes(room.id))
  const name = feed ? (props.devices.get(feed.ref)?.name ?? 'a heating device') : null
  return name
    ? `Heats ${room.name}, on the circuit from ${name}.`
    : `Heats ${room.name}. No heating circuit serves this room yet: tick it on a heating device.`
})
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
    selectedRadiator: selRadiator.value,
    selectedFurniture: selFurniture.value,
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
    outdoor: 'Drag on the grid to draw a garden or a lawn. It has no walls.',
    paved:
      'Drag on the grid to draw paving: a terrace, a path, a drive, or the deck round the pool. Draw the pool inside it.',
    pool: 'Drag on the grid to draw a pool.',
    door: 'Tap a wall to put a door there. Drag a door to move it, or its ends to resize it.',
    window: 'Tap a wall to put a window there. Drag a window to move it, or its ends to resize it.',
    slider:
      'Tap a wall to put a sliding glass door there, two metres wide. Drag it to move it, or its ends to resize it. A shutter can sit on it.',
    glassdoor:
      'Tap a wall to put a glass door there. Drag it to move it, or its ends to resize it. A shutter can sit on it.',
    radiator:
      'Tap a wall, on the side the radiator hangs, to put one there. Drag it to move it, or its ends to resize it. A heating circuit serving the room runs through it.',
    furniture:
      'Pick what to add, then drag on the plan to draw it to size, or tap to put one of the usual size there. Drag a piece to move it, or a corner to resize it.',
    open: 'Tap a wall that is not really there, such as between a kitchen and the living room, and it is left out.',
  }[tool.value]
})

const metres = (cells: number) => String(Math.round((cells / CELLS_PER_M) * 100) / 100)

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
  selRadiator.value = null
  selFurniture.value = null
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

function setRadiatorLength(v: number | null) {
  const r = radiator.value
  if (!r || v === null) return
  const want = clamp(Math.round(v * CELLS_PER_M * 2) / 2, 1, 10)
  let len = r.len
  const step = want > len ? 0.5 : -0.5
  while (len !== want && radiatorFits(floor.value, { ...r, len: len + step })) len += step
  r.len = len
}

function flipRadiator() {
  const r = radiator.value
  if (!r) return
  const side = ({ up: 'down', down: 'up', left: 'right', right: 'left' } as const)[r.side]
  if (radiatorFits(floor.value, { ...r, side })) r.side = side
  else toast.warning('The other side of this wall already has a radiator there.')
}

function deleteRadiator() {
  if (radiator.value) removeRadiator(floor.value, radiator.value.id)
  selRadiator.value = null
}

function setPieceSize(side: 'w' | 'd', v: number | null) {
  const f = piece.value
  if (!f || v === null) return
  const cells = clamp(Math.round(v * CELLS_PER_M * 2) / 2, 0.5, side === 'w' ? props.plan.plot.w : props.plan.plot.h)
  f[side] = cells
  // Grown past the plot's edge, it moves back onto it.
  if (side === 'w') f.x = clamp(f.x, 0, props.plan.plot.w - f.w)
  else f.y = clamp(f.y, 0, props.plan.plot.h - f.d)
}

function setPieceHeight(v: number | null) {
  const f = piece.value
  if (!f || v === null) return
  const m = clamp(Math.round(v * 100) / 100, 0.1, 3)
  // The usual height for its kind is left unset, so changing the kind keeps it right.
  if (m === FURNITURE_HEIGHT[f.kind]) delete f.height
  else f.height = m
}

function turnPiece() {
  if (piece.value) turnFurniture(props.plan, floor.value, piece.value)
}

function flipPiece() {
  if (piece.value) flipFurniture(floor.value, piece.value)
}

/** What the panel says about the selected piece: where its back is, and what stands on it. */
const pieceText = computed(() => {
  const f = piece.value
  if (!f) return ''
  const parts: string[] = []
  if (FURNITURE_BACK[f.kind]) {
    parts.push(
      f.kind === 'bed' || f.kind === 'lounger'
        ? 'The heavy line on the plan is its head.'
        : 'The heavy line on the plan is its back.',
    )
  }
  if (['table', 'cabinet', 'island', 'bed', 'shelves', 'basin'].includes(f.kind))
    parts.push('A lamp put on it stands on it.')
  parts.push('Drag it to move it, or drag a corner to resize it.')
  return parts.join(' ')
})

function deletePiece() {
  if (piece.value) removeFurniture(floor.value, piece.value.id)
  selFurniture.value = null
}

function deleteOpening() {
  if (opening.value) removeOpening(floor.value, opening.value.id)
  selOpening.value = null
}

function setOpeningLength(v: number | null) {
  const o = opening.value
  if (!o || v === null) return
  // In quarter metres, growing only along wall and never over another opening.
  const want = clamp(Math.round(v * CELLS_PER_M * 2) / 2, 1, 40)
  let len = o.len
  const step = want > len ? 0.5 : -0.5
  while (len !== want && fitsFree(floor.value, { ...o, len: len + step })) len += step
  o.len = len
}

/** Lights, shutters and gates are drawn from what they report. Everything else can say what it is. */
const takesLook = (d: LiveDevice) => d.kind !== 'light' && d.kind !== 'shutter' && d.kind !== 'gate'

const lookOptions = computed(() => {
  const d = placedDevice.value
  const fallback = d?.defaultLook ? LOOK_LABEL[d.defaultLook] : d ? KIND_LABEL[d.kind] : 'Device'
  return [
    { label: `As its type (${fallback.toLowerCase()})`, value: '' },
    ...Object.entries(LOOK_LABEL).map(([value, label]) => ({ label, value })),
  ]
})

function setLook(look: HouseLook | null) {
  const p = placed.value
  if (!p) return
  if (look) p.look = look
  else delete p.look
}

function setMount(mount: HouseLightMount) {
  const p = placed.value
  if (!p) return
  // The default for where it stands is left unset, so moving the light
  // into or out of a pool keeps it right.
  if (mount === lightMount(floor.value, { x: p.x, y: p.y })) delete p.mount
  else p.mount = mount
}

/** "Hinged on the left, opens down", in the plan's own terms. */
const doorText = computed(() => {
  const o = opening.value
  if (!o) return ''
  const hinge = o.axis === 'h' ? (o.hinge === 'end' ? 'right' : 'left') : o.hinge === 'end' ? 'bottom' : 'top'
  const side = o.opens ?? (o.axis === 'h' ? 'down' : 'right')
  return `Hinged at the ${hinge}, opens ${side === 'up' || side === 'down' ? side + 'wards' : 'to the ' + side} on the plan.`
})

/** Glass or solid. A shutter on a door that is made solid comes off it when the plan is saved. */
function setGlass(on: boolean) {
  const o = opening.value
  if (!o) return
  if (on) o.glass = true
  else delete o.glass
}

function flipHinge() {
  const o = opening.value
  if (!o) return
  if (o.hinge === 'end') delete o.hinge
  else o.hinge = 'end'
}

function flipSide() {
  const o = opening.value
  if (o) o.opens = flippedSide(o)
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
  | { type: 'omove'; o: HouseOpening; grab: number }
  | { type: 'oresize'; o: HouseOpening; end: 'start' | 'end' }
  | { type: 'rmove'; r: HouseRadiator; grab: number }
  | { type: 'rresize'; r: HouseRadiator; end: 'start' | 'end' }
  | { type: 'fdraw'; x0: number; y0: number }
  | { type: 'fmove'; f: HouseFurniture; grab: { x: number; y: number } }
  | { type: 'fresize'; f: HouseFurniture; corner: string; o: { x1: number; y1: number; x2: number; y2: number } }
let drag: Drag | null = null

/** Start dragging the opening under the pointer, or one of the selected opening's ends. */
function grabOpening(t: Element | null, p: { x: number; y: number }): boolean {
  // Radiators are grabbed the same way: by their line, or the selected one's ends.
  const rend = t?.closest('[data-rhandle]')?.getAttribute('data-rhandle')
  if (rend && radiator.value) {
    drag = { type: 'rresize', r: radiator.value, end: rend === 'end' ? 'end' : 'start' }
    return true
  }
  const rid = t?.closest('[data-radiator]')?.getAttribute('data-radiator')
  const rad = rid ? (floor.value.radiators ?? []).find((x) => x.id === rid) : undefined
  if (rad) {
    clearSelection()
    selRadiator.value = rad.id
    drag = { type: 'rmove', r: rad, grab: (rad.axis === 'h' ? p.x : p.y) - (rad.axis === 'h' ? rad.x : rad.y) }
    return true
  }
  const end = t?.closest('[data-ohandle]')?.getAttribute('data-ohandle')
  if (end && opening.value) {
    drag = { type: 'oresize', o: opening.value, end: end === 'end' ? 'end' : 'start' }
    return true
  }
  const id = t?.closest('[data-opening]')?.getAttribute('data-opening')
  const o = id ? floor.value.openings.find((x) => x.id === id) : undefined
  if (!o) return false
  clearSelection()
  selOpening.value = o.id
  drag = { type: 'omove', o, grab: (o.axis === 'h' ? p.x : p.y) - (o.axis === 'h' ? o.x : o.y) }
  return true
}

/** Start dragging the piece of furniture under the pointer, or a corner of the selected one. */
function grabFurniture(t: Element | null, p: { x: number; y: number }): boolean {
  const corner = t?.closest('[data-fhandle]')?.getAttribute('data-fhandle')
  const f = piece.value
  if (corner && f) {
    drag = { type: 'fresize', f, corner, o: { x1: f.x, y1: f.y, x2: f.x + f.w, y2: f.y + f.d } }
    return true
  }
  const id = t?.closest('[data-furniture]')?.getAttribute('data-furniture')
  const hit = id ? (floor.value.furniture ?? []).find((x) => x.id === id) : undefined
  if (!hit) return false
  clearSelection()
  selFurniture.value = hit.id
  drag = { type: 'fmove', f: hit, grab: { x: p.x - hit.x, y: p.y - hit.y } }
  return true
}

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
  } else if (
    tool.value === 'door' ||
    tool.value === 'window' ||
    tool.value === 'slider' ||
    tool.value === 'glassdoor' ||
    tool.value === 'open'
  ) {
    if (!grabOpening(t, p)) {
      const u = nearestWall(floor.value, p.x, p.y)
      clearSelection()
      if (!u) return
      const existing = openingAt(floor.value, u)
      const o =
        existing ?? (tool.value === 'open' ? addOpenWall(floor.value, u) : addOpening(floor.value, u, tool.value))
      if (o) selOpening.value = o.id
      if (existing)
        drag = {
          type: 'omove',
          o: existing,
          grab: (u.axis === 'h' ? p.x : p.y) - (u.axis === 'h' ? existing.x : existing.y),
        }
    }
  } else if (tool.value === 'furniture') {
    if (!grabFurniture(t, p)) {
      clearSelection()
      const x0 = clamp(Math.round(p.x * 2) / 2, 0, pw)
      const y0 = clamp(Math.round(p.y * 2) / 2, 0, ph)
      drag = { type: 'fdraw', x0, y0 }
      draft.value = { x: x0, y: y0, w: 0, h: 0 }
    }
  } else if (tool.value === 'radiator') {
    if (!grabOpening(t, p)) {
      const u = nearestWall(floor.value, p.x, p.y)
      clearSelection()
      if (!u) return
      const r = addRadiator(floor.value, u, p.x, p.y)
      if (r) selRadiator.value = r.id
      else toast.warning('There is no room for a radiator there. It needs wall, not a doorway, on the side of a room.')
    }
  } else if (grabOpening(t, p)) {
    /* a door, window or radiator, or one of its ends, is being dragged */
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
    } else if (grabFurniture(t, p)) {
      /* a piece of furniture, or one of its corners, is being dragged */
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
  } else if (drag.type === 'fdraw') {
    const x = clamp(Math.round(p.x * 2) / 2, 0, pw)
    const y = clamp(Math.round(p.y * 2) / 2, 0, ph)
    draft.value = {
      x: Math.min(x, drag.x0),
      y: Math.min(y, drag.y0),
      w: Math.abs(x - drag.x0),
      h: Math.abs(y - drag.y0),
    }
  } else if (drag.type === 'fmove') {
    moveFurniture(props.plan, drag.f, p.x, p.y, drag.grab)
  } else if (drag.type === 'fresize') {
    resizeFurniture(props.plan, drag.f, drag.corner, drag.o, p.x, p.y)
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
    for (const q of payload.radiators) Object.assign(q.o, { x: q.x + dx, y: q.y + dy })
    for (const q of payload.furniture) Object.assign(q.o, { x: q.x + dx, y: q.y + dy })
    for (const q of payload.placements) Object.assign(q.p, { x: q.x + dx, y: q.y + dy })
  } else if (drag.type === 'omove') {
    moveOpening(floor.value, drag.o, p.x, p.y, drag.grab)
  } else if (drag.type === 'oresize') {
    resizeOpening(floor.value, drag.o, drag.end, p.x, p.y)
  } else if (drag.type === 'rmove') {
    moveRadiator(floor.value, drag.r, p.x, p.y, drag.grab)
  } else if (drag.type === 'rresize') {
    resizeRadiator(floor.value, drag.r, drag.end, p.x, p.y)
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
  if (drag?.type === 'fdraw') {
    const d = draft.value
    draft.value = null
    // A drag draws it to size. A tap, or a drag too small to mean anything, puts down the usual size.
    const drawn = d && d.w >= 0.5 && d.h >= 0.5
    const f = addFurniture(
      props.plan,
      floor.value,
      furnitureKind.value,
      drawn ? { x: d.x, y: d.y, w: d.w, d: d.h } : { x: drag.x0, y: drag.y0 },
    )
    clearSelection()
    selFurniture.value = f.id
  } else if (drag?.type === 'draw' && wingFor.value) {
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
  // The blueprint is the page: it fills the content area edge to edge, with
  // the tools floating over it.
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;

  // On a phone the panels sit under the blueprint, and the page scrolls.
  &.is-phone {
    display: grid;
    gap: var(--nb-spacing-16);
  }
}

.house-editor__main {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;

  .is-phone & {
    display: block;
  }
}

.house-editor__tools {
  display: flex;
  gap: var(--nb-spacing-2);
  // Concentric with the pill buttons inside, as the view's own panels are.
  padding: var(--nb-overlay-inset, var(--nb-spacing-4));
  border-radius: calc(var(--nb-field-height-sm) / 2 + var(--nb-overlay-inset, var(--nb-spacing-4)));
  background: var(--nb-c-layer-1);
  border: 1px solid var(--nb-c-border);
}
.house-editor__kind {
  width: 10rem;
}
.house-editor__toolbar {
  position: absolute;
  z-index: 1;
  top: var(--nb-spacing-12);
  left: var(--nb-spacing-12);
  right: var(--nb-spacing-12);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--nb-spacing-8);
  pointer-events: none;

  > * {
    pointer-events: auto;
  }

  .is-phone & {
    position: static;
    margin-bottom: var(--nb-spacing-8);
  }

  // A tab bar fills its row by default. Here several sit side by side.
  > :deep(.nb-tabs) {
    width: auto;
    max-width: 100%;
  }
}

.house-editor__canvas {
  flex: 1;
  min-height: 0;
  overflow: hidden;

  .is-phone & {
    border-radius: var(--nb-radius-md);
    border: 1px solid var(--nb-c-border);
  }
}

.house-editor__svg {
  width: 100%;
  height: 100%;
  display: block;
  // Room for the toolbar above the plot and the hint below it. The blue is
  // the canvas behind, so it still runs to every edge.
  box-sizing: border-box;
  padding: 64px 16px 60px;

  .is-phone & {
    height: auto;
    max-height: 74vh;
  }
  touch-action: none;
  cursor: crosshair;
  user-select: none;
  -webkit-user-select: none;

  &.hv-tool-select {
    cursor: default;
  }
}

.house-editor__help {
  position: absolute;
  left: var(--nb-spacing-12);
  bottom: var(--nb-spacing-12);
  max-width: min(640px, calc(100% - 24px));
  // On a page surface, so it reads on the blueprint in light and dark.
  padding: var(--nb-spacing-4) var(--nb-spacing-12);
  border-radius: var(--nb-radius-control);
  background: var(--nb-c-layer-1);
  border: 1px solid var(--nb-c-border);

  .is-phone & {
    position: static;
    margin-top: var(--nb-spacing-8);
    padding: 0;
    background: none;
    border: 0;
  }
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
