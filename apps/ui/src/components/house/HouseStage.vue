<template>
  <div
    ref="stageEl"
    class="house-stage"
    :class="{ 'is-phone': phone, 'is-preview': preview, 'is-fill': fill }"
    @keydown="preview ? undefined : onKey($event)"
  >
    <svg
      ref="svgEl"
      class="house-stage__svg"
      :role="preview ? 'img' : 'group'"
      :aria-label="preview ? 'House plan' : 'House plan, live device state'"
      :viewBox="viewBox"
      @click="onClick"
      @keydown="onSvgKey"
      @wheel="preview ? undefined : onWheel($event)"
      @pointerdown="preview ? undefined : onPointerDown($event)"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    >
      <g class="hv-view" :style="{ transform: viewTransform }">
        <g class="hv-world" :style="{ transform: worldTransform }">
          <g
            v-for="f in floorsBottomUp"
            :key="f.id"
            class="hv-floor"
            :style="floorStyle(f.id)"
            :aria-hidden="!visible(f.id)"
            v-html="markup[f.id] ?? ''"
          />
        </g>
      </g>
    </svg>

    <div v-if="!preview" class="house-stage__view" role="group" aria-label="View" data-nb-appearance="rounded">
      <NbButton
        v-nb-tooltip="{ body: 'Zoom in', position: 'left', aria: 'none' }"
        size="sm"
        variant="ghost"
        icon="magnifying-glass-plus"
        aria-label="Zoom in"
        @click="zoomBy(1.4)"
      />
      <NbButton
        v-nb-tooltip="{ body: 'Zoom out', position: 'left', aria: 'none' }"
        size="sm"
        variant="ghost"
        icon="magnifying-glass-minus"
        aria-label="Zoom out"
        @click="zoomBy(1 / 1.4)"
      />
      <NbButton
        v-nb-tooltip="{ body: 'Fit the house, at normal zoom', position: 'left', aria: 'none' }"
        size="sm"
        variant="ghost"
        icon="frame-corners"
        aria-label="Fit the house, at normal zoom"
        :disabled="zoom === 1 && pan[0] === 0 && pan[1] === 0"
        @click="resetView"
      />
      <NbButton
        v-nb-tooltip="{ body: 'Turn left', position: 'left', aria: 'none' }"
        size="sm"
        variant="ghost"
        icon="arrow-counter-clockwise"
        aria-label="Turn left"
        @click="turn(-1)"
      />
      <NbButton
        v-nb-tooltip="{ body: 'Turn right', position: 'left', aria: 'none' }"
        size="sm"
        variant="ghost"
        icon="arrow-clockwise"
        aria-label="Turn right"
        @click="turn(1)"
      />
    </div>

    <HouseFloorMenu
      v-if="!preview"
      :floors="plan.floors"
      :model-value="floor"
      :phone="phone"
      allow-all
      @update:model-value="(id: string) => emit('update:floor', id)"
    />

    <!-- What an overlay shows, and why a room has no colour: it has no sensor. -->
    <div v-if="overlayLegend && !preview" class="house-stage__legend" role="note">
      <div>{{ overlayLegend.title }}</div>
      <div class="house-stage__legend-bar" :style="{ background: overlayLegend.gradient }" />
      <div class="house-stage__legend-ends">
        <span>{{ overlayLegend.lo }}</span>
        <span>{{ overlayLegend.hi }}</span>
      </div>
      <div class="house-stage__legend-note">{{ overlayLegend.note }}</div>
    </div>
    <div v-else-if="showLegend && !preview" class="house-stage__legend" aria-hidden="true">
      <div>Water temperature</div>
      <div class="house-stage__legend-bar" />
      <div class="house-stage__legend-ends">
        <span>20°</span>
        <span>55°</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, toRaw, watch } from 'vue'
import { usePhoneLayout } from '@nubisco/ui'
import type { HousePlan } from '@/api'
import { CELLS_PER_M, clamp, drawnBounds, project, r1, rotatePlan, S, type Point } from '@/house/geometry'
import { overlayColor, renderFloor, roomReadings, wallHeight, type SceneOptions } from '@/house/scene'
import type { LiveDevice } from '@/house/live'
import HouseFloorMenu from './HouseFloorMenu.vue'

const props = defineProps<{
  plan: HousePlan
  devices: Map<string, LiveDevice>
  /** A floor id, or `all` for the exploded view. */
  floor: string
  mode: 'iso' | 'flat'
  walls: 'up' | 'low'
  overlay: 'none' | 'temperature' | 'humidity'
  labels: boolean
  selected: string | null
  /**
   * A small, look-only copy for a card elsewhere (the dashboard): no floor
   * rail, no legend, nothing focusable, and taps pass through to whatever
   * the card links to.
   */
  preview?: boolean
  /** Fill the parent's height, for a page that is all house. */
  fill?: boolean
  /** Screen pixels at the top kept clear of the house, for a toolbar floating over it. */
  insetTop?: number
}>()

const emit = defineEmits<{
  'update:floor': [floor: string]
  /** A device was activated on the plan (tap, Enter or Space). */
  activate: [ref: string]
  /** A tap on nothing in particular. */
  clear: []
}>()

const { phone } = usePhoneLayout()

const stageEl = ref<HTMLElement | null>(null)
const svgEl = ref<SVGSVGElement | null>(null)
const size = ref({ w: 0, h: 0 })

// ─── Turning, zooming and panning ───────────────────────────────────────────

const TURNS_KEY = 'openbridge.house.turns'
const readTurns = () => {
  try {
    return Number(localStorage.getItem(TURNS_KEY)) || 0
  } catch {
    return 0
  }
}
/** Quarter turns of the house, remembered per browser. A preview is never turned. */
const turns = ref(props.preview ? 0 : readTurns())
function turn(dir: 1 | -1) {
  turns.value = (turns.value + dir + 4) % 4
  try {
    localStorage.setItem(TURNS_KEY, String(turns.value))
  } catch {
    /* remembered for this visit only */
  }
}
/**
 * The plan as drawn: turned. Ids and refs are the plan's own.
 *
 * Drawn from the raw plan, not the reactive one. Routing a heating circuit
 * looks every grid cell up against every room, and through Vue's proxy each
 * of those reads is tracked: on a real house that made every 3-second device
 * refresh cost 0.2 to 1.2 s of blocked page, against about 60 ms raw. The
 * plan is only ever replaced whole (loaded, saved), never edited in place,
 * so depending on the prop itself is enough to redraw when it changes.
 */
const viewPlan = computed(() => rotatePlan(toRaw(props.plan), turns.value))

const zoom = ref(1)
/** Pan, in viewBox units. */
const pan = ref<Point>([0, 0])
const viewTransform = computed(
  () => `translate(${r1(pan.value[0])}px,${r1(pan.value[1])}px) scale(${zoom.value.toFixed(4)})`,
)
function resetView() {
  zoom.value = 1
  pan.value = [0, 0]
}
/** Zoom about a point in viewBox units, the centre by default, keeping it still. */
function zoomBy(f: number, at?: Point) {
  const l = layout.value
  const c: Point = at ?? [(l?.VW ?? 1000) / 2, (l?.VH ?? 600) / 2]
  const next = clamp(zoom.value * f, 0.5, 8)
  const k = next / zoom.value
  pan.value = [c[0] - k * (c[0] - pan.value[0]), c[1] - k * (c[1] - pan.value[1])]
  zoom.value = next
}
/** A screen point in viewBox units. */
function toView(clientX: number, clientY: number): Point {
  const r = svgEl.value!.getBoundingClientRect()
  const l = layout.value
  return [((clientX - r.left) * (l?.VW ?? 1000)) / r.width, ((clientY - r.top) * (l?.VW ?? 1000)) / r.width]
}
function onWheel(e: WheelEvent) {
  e.preventDefault()
  // A trackpad pinch arrives as a wheel with ctrlKey, in small steps.
  zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0018)), toView(e.clientX, e.clientY))
}
// One finger or the mouse pans, two fingers pinch. A drag is never a tap.
const pointers = new Map<number, Point>()
let dragged = false
let startPan: Point = [0, 0]
let startAt: Point = [0, 0]
let pinch: { dist: number; zoom: number } | null = null
function onPointerDown(e: PointerEvent) {
  pointers.set(e.pointerId, [e.clientX, e.clientY])
  if (pointers.size === 1) {
    dragged = false
    startPan = [...pan.value] as Point
    startAt = [e.clientX, e.clientY]
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()]
    pinch = { dist: Math.hypot(a[0] - b[0], a[1] - b[1]), zoom: zoom.value }
  }
}
function onPointerMove(e: PointerEvent) {
  if (!pointers.has(e.pointerId)) return
  pointers.set(e.pointerId, [e.clientX, e.clientY])
  if (pointers.size === 2 && pinch) {
    const [a, b] = [...pointers.values()]
    const mid = toView((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
    zoomBy((pinch.zoom * Math.hypot(a[0] - b[0], a[1] - b[1])) / pinch.dist / zoom.value, mid)
    dragged = true
    return
  }
  const dx = e.clientX - startAt[0]
  const dy = e.clientY - startAt[1]
  if (!dragged && Math.hypot(dx, dy) < 5) return
  if (!dragged) svgEl.value?.setPointerCapture(e.pointerId)
  dragged = true
  const r = svgEl.value!.getBoundingClientRect()
  const s = (layout.value?.VW ?? 1000) / r.width
  pan.value = [startPan[0] + dx * s, startPan[1] + dy * s]
}
function onPointerUp(e: PointerEvent) {
  pointers.delete(e.pointerId)
  if (pointers.size < 2) pinch = null
  if (pointers.size === 1) {
    // Back to one finger after a pinch: pan from here, without a jump.
    const [p] = [...pointers.values()]
    startAt = p
    startPan = [...pan.value] as Point
  }
}
// A new floor or view starts framed.
watch(
  () => [props.floor, props.mode],
  () => resetView(),
)

const floorsBottomUp = computed(() => viewPlan.value.floors.slice().sort((a, b) => a.level - b.level))
const floorsTopDown = computed(() => floorsBottomUp.value.slice().reverse())
const all = computed(() => props.floor === 'all' || !props.plan.floors.some((f) => f.id === props.floor))

const visible = (id: string) => all.value || props.floor === id

/**
 * The overlay's scale, and how many of the rooms in view it could colour. A
 * room is coloured only by a sensor standing in it, so the note says so
 * plainly when there is none, instead of the overlay seeming to do nothing.
 */
const overlayLegend = computed(() => {
  const ov = props.overlay
  if (ov === 'none') return null
  const shown = viewPlan.value.floors.filter((f) => visible(f.id))
  let rooms = 0
  let measured = 0
  for (const f of shown) {
    rooms += f.rooms.filter((r) => r.kind === 'room').length
    const read = roomReadings(f, props.devices, ov)
    measured += f.rooms.filter((r) => r.kind === 'room' && read.has(r.id)).length
  }
  const [lo, hi] = ov === 'temperature' ? [16, 26] : [35, 80]
  const stops = [0, 0.25, 0.5, 0.75, 1].map((k) => overlayColor(ov, lo + (hi - lo) * k))
  const what = ov === 'temperature' ? 'temperature' : 'humidity'
  return {
    title: ov === 'temperature' ? 'Room temperature' : 'Room humidity',
    gradient: `linear-gradient(90deg, ${stops.join(', ')})`,
    lo: ov === 'temperature' ? `${lo}°` : `${lo}%`,
    hi: ov === 'temperature' ? `${hi}°` : `${hi}%`,
    note:
      measured === 0
        ? `No room here has a ${what} sensor. Place one in a room to colour it.`
        : `${measured} of ${rooms} room${rooms === 1 ? '' : 's'} measured. The rest have no ${what} sensor.`,
  }
})

/** Only when a pipe is on screen: a circuit serving a room on a floor in view. */
const showLegend = computed(() => {
  const shown = new Set(props.plan.floors.filter((f) => visible(f.id)).flatMap((f) => f.rooms.map((r) => r.id)))
  return props.plan.floors.some((f) => f.placements.some((p) => p.circuitRooms?.some((id) => shown.has(id))))
})

/**
 * Where each floor sits on the stage, and the scale that fits what is shown.
 * Floors stack upwards in the exploded view, and slide away when another
 * floor has focus, so switching floors reads as lifting a level off.
 */
const layout = computed(() => {
  const { w: cw, h: ch } = size.value
  if (!cw || !ch) return null
  const VW = 1000
  const VH = (1000 * ch) / cw
  const iso = props.mode === 'iso'
  const H = wallHeight({ mode: props.mode, walls: props.walls })
  const offsets: Record<string, Point> = {}
  let cum = 0
  let cursor = 0
  const portrait = VH / VW > 0.85
  floorsBottomUp.value.forEach((f, i) => {
    const b = drawnBounds(viewPlan.value, f)
    if (iso) {
      if (i > 0) cum -= (b.w + b.h) * 0.5 * S + H * S + 34
      offsets[f.id] = all.value ? [0, cum] : [0, 0]
    } else if (all.value) {
      offsets[f.id] = portrait ? [-b.x * S, -cursor - (b.y + b.h) * S] : [cursor - b.x * S, -b.y * S]
      cursor += (portrait ? b.h : b.w) * S + 50
    } else offsets[f.id] = [0, 0]
  })
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  for (const f of floorsBottomUp.value) {
    if (!visible(f.id)) continue
    const b = drawnBounds(viewPlan.value, f)
    const o = offsets[f.id]
    for (const [cx, cy] of [
      [b.x, b.y],
      [b.x + b.w, b.y],
      [b.x + b.w, b.y + b.h],
      [b.x, b.y + b.h],
    ]) {
      for (const z of [0, H + 0.7 * CELLS_PER_M]) {
        const p = project(props.mode, cx, cy, z)
        x1 = Math.min(x1, p[0] + o[0])
        x2 = Math.max(x2, p[0] + o[0])
        y1 = Math.min(y1, p[1] + o[1])
        y2 = Math.max(y2, p[1] + o[1])
      }
    }
  }
  if (!Number.isFinite(x1)) return null
  // Room for the floor rail: beside the plan on a wide stage, above it on a phone.
  // Room for what floats over the stage: the toolbar above, and the floor
  // rail beside the plan on a wide stage or under it on a phone.
  const px = VW / cw
  const padTop = props.preview ? 10 : ((props.insetTop ?? 0) + 12) * px
  // and the view buttons at the right, or above the rail on a phone.
  const padBottom = props.preview || !phone.value ? 0 : 108 * px
  const padLeft = props.preview || phone.value ? 0 : 170 * px
  const padRight = props.preview || phone.value ? 0 : 64 * px
  const k = Math.min((VW - padLeft - padRight) / (x2 - x1 + 50), (VH - padTop - padBottom) / (y2 - y1 + 50), 2.2)
  const tx = (padLeft - padRight) / 2 + VW / 2 - (k * (x1 + x2)) / 2
  const ty = (padTop - padBottom) / 2 + VH / 2 - (k * (y1 + y2)) / 2
  return { VW, VH, k, tx, ty, offsets, unit: (VW / (cw * k)) * (cw < 520 ? 0.82 : 1) }
})

const viewBox = computed(() => (layout.value ? `0 0 ${layout.value.VW} ${r1(layout.value.VH)}` : '0 0 1000 600'))
const worldTransform = computed(() =>
  layout.value
    ? `translate(${r1(layout.value.tx)}px,${r1(layout.value.ty)}px) scale(${layout.value.k.toFixed(4)})`
    : 'none',
)

function floorStyle(id: string) {
  const l = layout.value
  if (!l) return {}
  const f = props.plan.floors.find((x) => x.id === id)
  const focus = props.plan.floors.find((x) => x.id === props.floor)
  const o = l.offsets[id] ?? [0, 0]
  const shown = visible(id)
  let dy = 0
  if (!shown && props.mode === 'iso' && focus && f) dy = f.level > focus.level ? -260 : 200
  return {
    transform: `translate(${r1(o[0])}px,${r1(o[1] + dy)}px)`,
    opacity: shown ? 1 : 0,
    pointerEvents: shown ? undefined : ('none' as const),
  }
}

const markup = computed<Record<string, string>>(() => {
  const l = layout.value
  if (!l) return {}
  const options: SceneOptions = {
    mode: props.mode,
    walls: props.walls,
    overlay: props.overlay,
    labels: props.labels,
    selected: props.selected,
    // Markers keep their size on screen while the house is zoomed.
    unit: l.unit / zoom.value,
    compact: size.value.w < 520,
    offsets: l.offsets,
    all: all.value,
  }
  const out: Record<string, string> = {}
  for (const f of viewPlan.value.floors) {
    const svg = renderFloor(viewPlan.value, f, props.devices, options)
    // A preview is a picture: its devices must not take keyboard focus or
    // announce themselves as buttons inside a link.
    out[f.id] = props.preview ? svg.replace(/ role="button" tabindex="0"/g, '') : svg
  }
  return out
})

function refOf(target: EventTarget | null): string | null {
  const el = target instanceof Element ? target.closest('[data-ref]') : null
  return el?.getAttribute('data-ref') ?? null
}

function onClick(e: MouseEvent) {
  if (props.preview) return
  if (dragged) {
    dragged = false
    return
  }
  // Hit-tested from the point, not the event target: a floor sliding away
  // still has its shapes under the pointer for a moment, and pointer-events
  // is what keeps them from taking the tap.
  const hit = document.elementFromPoint(e.clientX, e.clientY)
  const ref = refOf(hit)
  if (ref) return emit('activate', ref)
  const plate = hit instanceof Element ? hit.closest('[data-plate]') : null
  if (plate && all.value) emit('update:floor', plate.getAttribute('data-plate') as string)
  else emit('clear')
}

function onSvgKey(e: KeyboardEvent) {
  if (e.key !== 'Enter' && e.key !== ' ') return
  const ref = refOf(e.target)
  if (!ref) return
  e.preventDefault()
  emit('activate', ref)
}

/** Arrow keys move between floors, top to bottom, like a lift. */
function onKey(e: KeyboardEvent) {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
  const order = (props.plan.floors.length > 1 ? ['all'] : []).concat(floorsTopDown.value.map((f) => f.id))
  const i = order.indexOf(props.floor) + (e.key === 'ArrowDown' ? 1 : -1)
  if (i < 0 || i >= order.length) return
  e.preventDefault()
  emit('update:floor', order[i])
}

// Re-rendering replaces the device nodes, so keyboard focus is carried over
// by ref to the new node with the same ref.
watch(markup, () => {
  const active = document.activeElement
  const ref = active && svgEl.value?.contains(active) ? refOf(active) : null
  if (!ref) return
  requestAnimationFrame(() => {
    const next = svgEl.value?.querySelector<SVGElement>(`[data-ref="${CSS.escape(ref)}"]`)
    next?.focus({ preventScroll: true })
  })
})

let observer: ResizeObserver | null = null
onMounted(() => {
  const measure = () => {
    const el = svgEl.value
    if (el) size.value = { w: el.clientWidth, h: el.clientHeight }
  }
  measure()
  observer = new ResizeObserver(measure)
  if (stageEl.value) observer.observe(stageEl.value)
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<style lang="scss" scoped>
.house-stage {
  position: relative;
  height: min(70vh, 680px);
  min-height: 380px;
  overflow: hidden;

  &.is-phone {
    height: min(108vw, 66vh);
    min-height: 340px;
  }

  // The house page: the house is the page, with no frame round it.
  &.is-fill {
    height: 100%;
    min-height: 0;
  }

  &.is-preview {
    height: 220px;
    min-height: 0;
  }
}

.house-stage__svg {
  width: 100%;
  height: 100%;
  display: block;
  // The stage takes pinch and drag itself, for zoom and pan.
  touch-action: none;
  cursor: grab;

  .is-preview & {
    pointer-events: none;
  }
}

.hv-world {
  transition: transform 0.6s cubic-bezier(0.2, 0.8, 0.2, 1);
}

.house-stage__view {
  position: absolute;
  right: var(--nb-spacing-8);
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  gap: var(--nb-spacing-2);
  // Concentric with the pill buttons inside: the panel's corner is the
  // button's (half its height) plus the inset that holds it off the edge.
  padding: var(--nb-overlay-inset, var(--nb-spacing-4));
  border-radius: calc(var(--nb-field-height-sm) / 2 + var(--nb-overlay-inset, var(--nb-spacing-4)));
  background: var(--nb-c-layer-1);
  border: 1px solid var(--nb-c-border);

  // On a phone, a row above the floor rail, out of the plan's middle.
  .is-phone & {
    top: auto;
    bottom: calc(var(--nb-spacing-8) + 52px);
    transform: none;
    flex-direction: row;
  }
}

.house-stage__legend {
  position: absolute;
  right: var(--nb-spacing-8);
  bottom: var(--nb-spacing-8);
  color: var(--nb-c-text-muted);
  font-size: 11px;
  padding: 6px 9px;
  border-radius: var(--nb-radius-md);
  background: var(--nb-c-layer-1);
  border: 1px solid var(--nb-c-border);
}

.house-stage__legend-bar {
  width: 130px;
  height: 6px;
  border-radius: 3px;
  margin: 4px 0 2px;
  background: linear-gradient(90deg, hsl(215 88% 56%), hsl(265 88% 60%), hsl(315 88% 58%), hsl(5 88% 56%));

  .is-phone & {
    width: 90px;
  }
}

.house-stage__legend-note {
  max-width: 200px;
  margin-top: 4px;
  line-height: 1.35;
}

.house-stage__legend-ends {
  display: flex;
  justify-content: space-between;
  opacity: 0.75;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
