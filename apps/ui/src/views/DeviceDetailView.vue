<template>
  <div class="device-detail">
    <div v-if="device?.model" class="detail-header">
      <span class="detail-model">{{ device.model }}</span>
    </div>

    <div v-if="loadError" class="detail-message">
      <!-- was "danger", which NbMessage never accepted (error|warning|success|helper). -->
      <NbMessage variant="error">{{ loadError }}</NbMessage>
    </div>

    <template v-else-if="device">
      <!-- Live summary: the numbers as they are right now -->
      <div class="summary-row">
        <div
          v-for="metric in metrics"
          :key="metric.key"
          class="summary-tile"
          :class="{ active: metric.key === selectedMetric }"
          @click="selectMetric(metric.key)"
        >
          <span class="tile-label">{{ metric.label }}</span>
          <span class="tile-value">
            {{ formatValue(liveValue(metric), metric) }}
            <span class="tile-unit">{{ metric.unit }}</span>
          </span>
        </div>
      </div>

      <div v-if="metrics.length === 0" class="detail-message">
        <!-- was "info", likewise never a valid NbMessage variant. -->
        <NbMessage variant="helper">
          This device does not declare any metrics, so there is nothing to chart. Plugins opt in by describing their
          series in the device descriptor.
        </NbMessage>
      </div>

      <template v-else>
        <div class="chart-toolbar">
          <NbTabs
            class="range-tabs"
            :items="rangeTabs"
            :model-value="selectedRange"
            variant="contained"
            size="sm"
            aria-label="History range"
            @update:model-value="selectRange($event as RangeKey)"
          />
          <span v-if="resolutionLabel" class="resolution-note">{{ resolutionLabel }}</span>
        </div>

        <div class="chart-panel">
          <!-- curve was "monotone"; TLineCurve is linear|smooth|step. -->
          <NbLineChart
            v-if="chartSeries.length > 0 && chartSeries[0].data.length > 0"
            :series="chartSeries"
            :height="phone ? 220 : 320"
            :show-legend="chartSeries.length > 1"
            :show-grid="true"
            :show-tooltip="true"
            :points="false"
            curve="smooth"
          />
          <div v-else-if="loading" class="chart-empty">Loading…</div>
          <div v-else class="chart-empty">
            No data recorded yet for this range. History starts accumulating once the device reports.
          </div>
        </div>
      </template>
    </template>

    <div v-else class="detail-message">Loading…</div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, watchEffect, onMounted, onBeforeUnmount } from 'vue'
import { useRoute } from 'vue-router'
import { usePhoneLayout, type IBreadcrumbItem, type ITabItem } from '@nubisco/ui'
import { api, type DeviceDescriptor, type MetricDescriptor } from '@/api'
import { useLayoutStore } from '@/stores/layout'

type NativeDevice = DeviceDescriptor & { telemetry: Record<string, unknown> }

const route = useRoute()
const { phone } = usePhoneLayout()

const layout = useLayoutStore()
const deviceId = computed(() => String(route.params.id ?? ''))
const device = ref<NativeDevice | null>(null)
const metrics = ref<MetricDescriptor[]>([])
const selectedMetric = ref<string>('')
const loading = ref(false)
const loadError = ref('')
const resolution = ref(0)

interface SeriesPoint {
  t: number
  value: number | null
  min?: number | null
  max?: number | null
}
const points = ref<SeriesPoint[]>([])

const RANGES = [
  { key: '1h', label: '1 hour', seconds: 3600 },
  { key: '24h', label: '24 hours', seconds: 86400 },
  { key: '7d', label: '7 days', seconds: 7 * 86400 },
  { key: '30d', label: '30 days', seconds: 30 * 86400 },
  { key: '1y', label: '1 year', seconds: 365 * 86400 },
] as const
type RangeKey = (typeof RANGES)[number]['key']
const rangeTabs: ITabItem[] = RANGES.map((r) => ({ id: r.key, label: r.label }))
const selectedRange = ref<RangeKey>('24h')

// The device list is the parent, so the trail is the way back to it.
const crumbs = computed<IBreadcrumbItem[]>(() => [
  { label: 'Devices', to: { name: 'devices' } },
  { label: device.value?.name ?? deviceId.value },
])
// It is the frame's one trail, in the topbar, not a second one in the page.
watchEffect(() => layout.setPage(device.value?.name ?? deviceId.value, undefined, { crumbs: crumbs.value }))

const currentMetric = computed(() => metrics.value.find((m) => m.key === selectedMetric.value) ?? null)

/**
 * The chart prints a Date with its full `toString()`, time zone name and all,
 * which runs off a phone's edge. A phone gets a short label for the range
 * instead. The desktop keeps the Date it always had.
 */
function xValue(t: number): Date | string {
  const d = new Date(t * 1000)
  if (!phone.value) return d
  const short = selectedRange.value === '1h' || selectedRange.value === '24h'
  return short
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/**
 * Chart series. Instant metrics that track extremes get a min and max band
 * alongside the mean, so an averaged hour still shows the peak it contained
 * rather than flattening it.
 */
const chartSeries = computed(() => {
  const metric = currentMetric.value
  if (!metric || points.value.length === 0) return []

  const main = {
    name: metric.label,
    data: points.value.map((p) => ({ x: xValue(p.t), y: p.value ?? 0 })),
  }

  const hasBand = points.value.some((p) => p.min !== undefined && p.min !== null && p.min !== p.value)
  if (!hasBand) return [main]

  return [
    main,
    { name: 'Min', data: points.value.map((p) => ({ x: xValue(p.t), y: p.min ?? p.value ?? 0 })) },
    { name: 'Max', data: points.value.map((p) => ({ x: xValue(p.t), y: p.max ?? p.value ?? 0 })) },
  ]
})

const resolutionLabel = computed(() => {
  if (!resolution.value) return ''
  const s = resolution.value
  if (s < 60) return `${s}s resolution`
  if (s < 3600) return `${Math.round(s / 60)} min resolution`
  return `${Math.round(s / 3600)} h resolution`
})

function liveValue(metric: MetricDescriptor): number | null {
  const raw = device.value?.telemetry?.[metric.key]
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function formatValue(value: number | null, metric: MetricDescriptor): string {
  if (value === null) return '—'
  return value.toFixed(metric.precision ?? 2)
}

function selectMetric(key: string) {
  if (selectedMetric.value === key) return
  selectedMetric.value = key
  void loadSeries()
}

function selectRange(key: RangeKey) {
  if (selectedRange.value === key) return
  selectedRange.value = key
  void loadSeries()
}

async function loadDevice() {
  try {
    const { devices } = await api.devices()
    const found = devices.find((d) => d.id === deviceId.value)
    if (!found) {
      loadError.value = `Device "${deviceId.value}" was not found. It may have been removed, or its plugin stopped.`
      return
    }
    device.value = found as NativeDevice
    metrics.value = found.metrics ?? []
    if (!selectedMetric.value && metrics.value.length > 0) selectedMetric.value = metrics.value[0].key
  } catch (err) {
    loadError.value = `Could not load device: ${(err as Error).message}`
  }
}

async function loadSeries() {
  if (!selectedMetric.value) return
  const range = RANGES.find((r) => r.key === selectedRange.value)!
  const to = Math.floor(Date.now() / 1000)
  const from = to - range.seconds

  loading.value = true
  try {
    const result = await api.deviceMetrics(deviceId.value, { metric: selectedMetric.value, from, to })
    points.value = result.series?.points ?? []
    resolution.value = result.series?.resolution ?? 0
  } catch (err) {
    loadError.value = `Could not load history: ${(err as Error).message}`
  } finally {
    loading.value = false
  }
}

// Refresh live values often enough to feel current, and the chart less often:
// re-reading a whole range every few seconds is wasteful and makes the line jump.
let liveTimer: ReturnType<typeof setInterval> | null = null
let chartTimer: ReturnType<typeof setInterval> | null = null

onMounted(async () => {
  await loadDevice()
  await loadSeries()
  liveTimer = setInterval(() => void loadDevice(), 5000)
  chartTimer = setInterval(() => void loadSeries(), 30000)
})

onBeforeUnmount(() => {
  if (liveTimer) clearInterval(liveTimer)
  if (chartTimer) clearInterval(chartTimer)
})

watch(deviceId, async () => {
  device.value = null
  metrics.value = []
  selectedMetric.value = ''
  points.value = []
  loadError.value = ''
  await loadDevice()
  await loadSeries()
})
</script>

<style lang="scss" scoped>
.device-detail {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1rem 1.25rem;

  // The shell already keeps a phone's gutter. A second one on top cost the
  // tiles and the chart 40px of a 360px screen.
  @include variables.phone {
    padding-inline: 0;
  }
}

.detail-header {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.detail-model {
  color: var(--nb-c-text-muted);
  font-size: 0.85rem;
}

.detail-message {
  padding: 1rem 0;
  color: var(--nb-color-text-muted, var(--nb-c-text-muted));
}

.summary-row {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 0.75rem;

  // One tile per row filled a phone's first screen with four numbers. A
  // narrower minimum fits two side by side at 360px, and more when sideways.
  @include variables.phone {
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  }
}

.summary-tile {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.75rem 0.9rem;
  border: 1px solid var(--nb-color-border, var(--nb-c-border));
  border-radius: 10px;
  cursor: pointer;
  transition:
    border-color 120ms ease,
    background-color 120ms ease;
}

.summary-tile:hover {
  border-color: var(--nb-color-primary, var(--nb-c-primary));
}

.summary-tile.active {
  border-color: var(--nb-color-primary, var(--nb-c-primary));
  background: color-mix(in srgb, var(--nb-color-primary, var(--nb-c-primary)) 6%, transparent);
}

.tile-label {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--nb-color-text-muted, var(--nb-c-text-muted));
}

.tile-value {
  font-size: 1.35rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.tile-unit {
  font-size: 0.8rem;
  font-weight: 400;
  color: var(--nb-color-text-muted, var(--nb-c-text-muted));
  margin-left: 0.15rem;
}

.chart-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

// NbTabs fills its row by default, which pushed the resolution note onto a
// line of its own. Sized to its tabs, the note stays beside them.
.range-tabs {
  width: auto;
  min-width: 0;
  flex: 0 1 auto;
}

.resolution-note {
  font-size: 0.75rem;
  color: var(--nb-color-text-muted, var(--nb-c-text-muted));
}

.chart-panel {
  border: 1px solid var(--nb-color-border, var(--nb-c-border));
  border-radius: 12px;
  padding: 0.75rem;
  min-height: 340px;
  overflow-x: auto;

  // A 320px chart under the tiles leaves a phone held sideways no room to see it.
  @include variables.phone {
    min-height: 240px;
  }
}

.chart-empty {
  display: grid;
  place-items: center;
  height: 320px;
  color: var(--nb-color-text-muted, var(--nb-c-text-muted));
  font-size: 0.9rem;
  text-align: center;
  padding: 0 2rem;

  @include variables.phone {
    height: 220px;
  }
}
</style>
