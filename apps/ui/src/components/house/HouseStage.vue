<template>
  <div ref="stageEl" class="house-stage hv-stage-bg" :class="{ 'is-phone': phone }" @keydown="onKey">
    <svg
      ref="svgEl"
      class="house-stage__svg"
      role="group"
      aria-label="House plan, live device state"
      :viewBox="viewBox"
      @click="onClick"
      @keydown="onSvgKey"
    >
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
    </svg>

    <div class="house-stage__rail" role="group" aria-label="Floors">
      <NbButton
        v-if="plan.floors.length > 1"
        size="sm"
        :variant="floor === 'all' ? 'primary' : 'ghost'"
        icon="stack"
        :aria-pressed="floor === 'all'"
        @click="emit('update:floor', 'all')"
      >
        <span v-if="!phone">All floors</span>
        <span v-else class="sr-only">All floors</span>
      </NbButton>
      <NbButton
        v-for="f in floorsTopDown"
        :key="f.id"
        size="sm"
        :variant="floor === f.id ? 'primary' : 'ghost'"
        :aria-pressed="floor === f.id"
        :title="f.name"
        @click="emit('update:floor', f.id)"
      >
        {{ phone ? shortName(f) : f.name }}
      </NbButton>
    </div>

    <div v-if="showLegend" class="house-stage__legend" aria-hidden="true">
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
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { usePhoneLayout } from '@nubisco/ui'
import type { HouseFloor, HousePlan } from '@/api'
import { CELLS_PER_M, floorBounds, project, r1, S, type Point } from '@/house/geometry'
import { renderFloor, wallHeight, type SceneOptions } from '@/house/scene'
import type { LiveDevice } from '@/house/live'

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
}>()

const emit = defineEmits<{
  'update:floor': [floor: string]
  /** A device was activated on the plan (tap, Enter or Space). */
  activate: [ref: string]
}>()

const { phone } = usePhoneLayout()

const stageEl = ref<HTMLElement | null>(null)
const svgEl = ref<SVGSVGElement | null>(null)
const size = ref({ w: 0, h: 0 })

const floorsBottomUp = computed(() => props.plan.floors.slice().sort((a, b) => a.level - b.level))
const floorsTopDown = computed(() => floorsBottomUp.value.slice().reverse())
const all = computed(() => props.floor === 'all' || !props.plan.floors.some((f) => f.id === props.floor))

const shortName = (f: HouseFloor) => (f.level === 0 ? 'G' : f.level < 0 ? `B${-f.level}` : String(f.level))

const visible = (id: string) => all.value || props.floor === id

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
    const b = floorBounds(props.plan, f)
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
    const b = floorBounds(props.plan, f)
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
  const padTop = phone.value ? 70 : 20
  const padLeft = phone.value ? 0 : (170 * VW) / cw
  const k = Math.min((VW - padLeft) / (x2 - x1 + 50), (VH - padTop) / (y2 - y1 + 50), 2.2)
  const tx = padLeft / 2 + VW / 2 - (k * (x1 + x2)) / 2
  const ty = padTop / 2 + VH / 2 - (k * (y1 + y2)) / 2
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
    unit: l.unit,
    compact: size.value.w < 520,
    offsets: l.offsets,
    all: all.value,
  }
  const out: Record<string, string> = {}
  for (const f of props.plan.floors) out[f.id] = renderFloor(props.plan, f, props.devices, options)
  return out
})

function refOf(target: EventTarget | null): string | null {
  const el = target instanceof Element ? target.closest('[data-ref]') : null
  return el?.getAttribute('data-ref') ?? null
}

function onClick(e: MouseEvent) {
  // Hit-tested from the point, not the event target: a floor sliding away
  // still has its shapes under the pointer for a moment, and pointer-events
  // is what keeps them from taking the tap.
  const hit = document.elementFromPoint(e.clientX, e.clientY)
  const ref = refOf(hit)
  if (ref) return emit('activate', ref)
  const plate = hit instanceof Element ? hit.closest('[data-plate]') : null
  if (plate && all.value) emit('update:floor', plate.getAttribute('data-plate') as string)
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
  border-radius: var(--nb-radius-md);
  overflow: hidden;
  border: 1px solid var(--nb-c-border);

  &.is-phone {
    height: min(108vw, 66vh);
    min-height: 340px;
  }
}

.house-stage__svg {
  width: 100%;
  height: 100%;
  display: block;
  touch-action: manipulation;
}

.hv-world {
  transition: transform 0.6s cubic-bezier(0.2, 0.8, 0.2, 1);
}

.house-stage__rail {
  position: absolute;
  left: var(--nb-spacing-8);
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--nb-spacing-4);
  padding: var(--nb-spacing-4);
  border-radius: var(--nb-radius-md);
  // A page surface floating on the stage, in the page's theme, so the
  // library's buttons read as they do everywhere else in light and dark.
  background: var(--nb-c-layer-1);
  border: 1px solid var(--nb-c-border);

  .is-phone & {
    top: var(--nb-spacing-8);
    transform: none;
    flex-direction: row;
  }
}

.house-stage__legend {
  position: absolute;
  right: var(--nb-spacing-8);
  bottom: var(--nb-spacing-8);
  color: #dcebff;
  font-size: 11px;
  padding: 6px 9px;
  border-radius: var(--nb-radius-md);
  background: rgba(6, 14, 32, 0.6);
  border: 1px solid rgba(120, 180, 255, 0.16);
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
