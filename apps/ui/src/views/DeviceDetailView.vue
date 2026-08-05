<template>
  <div class="device-detail">
    <NbBreadcrumbs :title="breadcrumbTitle" :subtitle="device?.name ?? deviceId">
      <NbButton variant="ghost" size="sm" icon="arrow-left" @click="goBack">Devices</NbButton>
    </NbBreadcrumbs>

    <div v-if="loadError" class="detail-message">
      <NbMessage variant="danger">{{ loadError }}</NbMessage>
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
        <NbMessage variant="info">
          This device does not declare any metrics, so there is nothing to chart. Plugins opt in by describing their
          series in the device descriptor.
        </NbMessage>
      </div>

      <template v-else>
        <div class="chart-toolbar">
          <div class="range-tabs">
            <button
              v-for="range in RANGES"
              :key="range.key"
              class="range-tab"
              :class="{ active: range.key === selectedRange }"
              @click="selectRange(range.key)"
            >
              {{ range.label }}
            </button>
          </div>
          <span v-if="resolutionLabel" class="resolution-note">{{ resolutionLabel }}</span>
        </div>

        <div class="chart-panel">
          <NbLineChart
            v-if="chartSeries.length > 0 && chartSeries[0].data.length > 0"
            :series="chartSeries"
            :height="320"
            :show-legend="chartSeries.length > 1"
            :show-grid="true"
            :show-tooltip="true"
            :points="false"
            curve="monotone"
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
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, type DeviceDescriptor, type MetricDescriptor } from '@/api'

type NativeDevice = DeviceDescriptor & { telemetry: Record<string, unknown> }

const route = useRoute()
const router = useRouter()

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
const selectedRange = ref<RangeKey>('24h')

const breadcrumbTitle = computed(() => device.value?.model ?? 'Device')

const currentMetric = computed(() => metrics.value.find((m) => m.key === selectedMetric.value) ?? null)

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
    data: points.value.map((p) => ({ x: new Date(p.t * 1000), y: p.value ?? 0 })),
  }

  const hasBand = points.value.some((p) => p.min !== undefined && p.min !== null && p.min !== p.value)
  if (!hasBand) return [main]

  return [
    main,
    { name: 'Min', data: points.value.map((p) => ({ x: new Date(p.t * 1000), y: p.min ?? p.value ?? 0 })) },
    { name: 'Max', data: points.value.map((p) => ({ x: new Date(p.t * 1000), y: p.max ?? p.value ?? 0 })) },
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

function goBack() {
  router.push({ name: 'devices' })
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

<style scoped>
.device-detail {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1rem 1.25rem;
}

.detail-message {
  padding: 1rem 0;
  color: var(--nb-color-text-muted, #6b7280);
}

.summary-row {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 0.75rem;
}

.summary-tile {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.75rem 0.9rem;
  border: 1px solid var(--nb-color-border, #e5e7eb);
  border-radius: 10px;
  cursor: pointer;
  transition:
    border-color 120ms ease,
    background-color 120ms ease;
}

.summary-tile:hover {
  border-color: var(--nb-color-primary, #7c3aed);
}

.summary-tile.active {
  border-color: var(--nb-color-primary, #7c3aed);
  background: color-mix(in srgb, var(--nb-color-primary, #7c3aed) 6%, transparent);
}

.tile-label {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--nb-color-text-muted, #6b7280);
}

.tile-value {
  font-size: 1.35rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.tile-unit {
  font-size: 0.8rem;
  font-weight: 400;
  color: var(--nb-color-text-muted, #6b7280);
  margin-left: 0.15rem;
}

.chart-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

.range-tabs {
  display: inline-flex;
  gap: 0.25rem;
}

.range-tab {
  border: 1px solid transparent;
  background: transparent;
  border-radius: 7px;
  padding: 0.3rem 0.65rem;
  font-size: 0.82rem;
  cursor: pointer;
  color: var(--nb-color-text-muted, #6b7280);
}

.range-tab.active {
  border-color: var(--nb-color-border, #e5e7eb);
  color: var(--nb-color-text, #111827);
  font-weight: 600;
}

.resolution-note {
  font-size: 0.75rem;
  color: var(--nb-color-text-muted, #6b7280);
}

.chart-panel {
  border: 1px solid var(--nb-color-border, #e5e7eb);
  border-radius: 12px;
  padding: 0.75rem;
  min-height: 340px;
  overflow-x: auto;
}

.chart-empty {
  display: grid;
  place-items: center;
  height: 320px;
  color: var(--nb-color-text-muted, #6b7280);
  font-size: 0.9rem;
  text-align: center;
  padding: 0 2rem;
}
</style>
