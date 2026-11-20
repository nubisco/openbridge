<template>
  <svg
    class="house-ruler"
    :class="`house-ruler--${axis}`"
    :width="axis === 'x' ? length : RULER_SIZE"
    :height="axis === 'x' ? RULER_SIZE : length"
    aria-hidden="true"
  >
    <path class="house-ruler__ticks" :d="path" />
    <text v-for="t in labelled" :key="t.label" class="house-ruler__label" :transform="labelTransform(t.at)">
      {{ t.label }}
    </text>
    <path v-if="cursor !== null" class="house-ruler__cursor" :d="cursorPath" />
  </svg>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { RULER_SIZE, rulerTicks } from '@/house/ruler'

const props = defineProps<{
  axis: 'x' | 'y'
  /** Screen pixels per metre. */
  pxPerM: number
  /** Where metre 0 is, in pixels from the ruler's start. */
  origin: number
  length: number
  /** The pointer's position along the ruler, or null when it is off the canvas. */
  cursor: number | null
}>()

const ticks = computed(() => rulerTicks(props.pxPerM, props.origin, props.length))
const labelled = computed(() => ticks.value.filter((t) => t.label !== undefined))

const r = (n: number) => Math.round(n) + 0.5
// Marks stand on the edge next to the canvas, so they point at what they measure.
const mark = (at: number, size: number) => {
  const len = size * RULER_SIZE
  return props.axis === 'x'
    ? `M${r(at)},${RULER_SIZE}V${RULER_SIZE - len}`
    : `M${RULER_SIZE},${r(at)}H${RULER_SIZE - len}`
}
const path = computed(() => ticks.value.map((t) => mark(t.at, t.size)).join(''))
const cursorPath = computed(() => (props.cursor === null ? '' : mark(props.cursor, 1)))
// A number sits just past its mark, and reads bottom to top on the left ruler.
const labelTransform = (at: number) =>
  props.axis === 'x' ? `translate(${Math.round(at) + 3},10)` : `translate(10,${Math.round(at) - 3}) rotate(-90)`
</script>

<style lang="scss" scoped>
.house-ruler {
  display: block;
  overflow: hidden;
  background: var(--nb-c-layer-1);
  pointer-events: none;
}
.house-ruler--x {
  border-bottom: 1px solid var(--nb-c-border);
}
.house-ruler--y {
  border-right: 1px solid var(--nb-c-border);
}
.house-ruler__ticks {
  stroke: var(--nb-c-text-subtle);
  stroke-width: 1;
  shape-rendering: crispEdges;
}
.house-ruler__label {
  fill: var(--nb-c-text-muted);
  font-family: var(--nb-font-family-mono);
  font-size: 9px;
  font-variant-numeric: tabular-nums;
}
.house-ruler__cursor {
  stroke: var(--nb-c-primary);
  stroke-width: 1;
  shape-rendering: crispEdges;
}
</style>
