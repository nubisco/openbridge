<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    data: number[]
    color?: string
    height?: number
    gradientId?: string
  }>(),
  {
    color: '#7c3aed',
    height: 48,
    gradientId: 'spark-grad',
  },
)

const paths = computed(() => {
  const d = props.data
  if (d.length < 2) return { line: '', area: '' }

  const max = Math.max(...d, 0.001)
  const min = Math.min(...d, 0)
  const range = max - min || 1
  const h = props.height
  const step = 100 / (d.length - 1)

  const pts = d.map((v, i) => ({
    x: i * step,
    y: h - ((v - min) / range) * h * 0.82 - h * 0.06,
  }))

  // Smooth bezier
  let line = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`
  for (let i = 1; i < pts.length; i++) {
    const cpx = pts[i - 1].x + step * 0.45
    const cpy = pts[i - 1].y
    const cp2x = pts[i].x - step * 0.45
    const cp2y = pts[i].y
    line += ` C ${cpx.toFixed(2)} ${cpy.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${pts[i].x.toFixed(2)} ${pts[i].y.toFixed(2)}`
  }

  const last = pts[pts.length - 1]
  const area = `${line} L ${last.x.toFixed(2)} ${h} L ${pts[0].x.toFixed(2)} ${h} Z`

  return { line, area }
})
</script>

<template>
  <svg :viewBox="`0 0 100 ${height}`" preserveAspectRatio="none" class="sparkline" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient :id="gradientId" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" :stop-color="color" stop-opacity="0.3" />
        <stop offset="100%" :stop-color="color" stop-opacity="0.02" />
      </linearGradient>
    </defs>
    <path v-if="paths.area" :d="paths.area" :fill="`url(#${gradientId})`" />
    <path v-if="paths.line" :d="paths.line" :stroke="color" stroke-width="0.5" fill="none" stroke-linecap="round" />
  </svg>
</template>

<style scoped>
.sparkline {
  width: 100%;
  display: block;
  overflow: visible;
}
</style>
