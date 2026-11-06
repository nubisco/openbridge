<template>
  <div class="device-detail">
    <!-- A record: the device's name, the one state it is in, and the facts
         that define it stay in reach while the history scrolls. The trail in
         the topbar ends in the same name, which is fine here: the name is the
         record, not a repeat of a section label. -->
    <NbPageHeader v-if="device" :title="device.name" sticky>
      <template #status>
        <NbBadge :variant="healthVariant">{{ healthLabel }}</NbBadge>
      </template>
      <template v-if="facts.length > 0" #facts>
        <NbDefinitionList layout="auto" compact term-width="8rem" :items="facts" />
      </template>
    </NbPageHeader>

    <!-- was "danger", which NbMessage never accepted (error|warning|success|helper). -->
    <NbMessage v-if="loadError" variant="error">{{ loadError }}</NbMessage>

    <template v-else-if="device">
      <!-- was "info", likewise never a valid NbMessage variant. -->
      <NbMessage v-if="metrics.length === 0" variant="helper">
        This device does not declare any metrics, so there is nothing to chart. Plugins opt in by describing their
        series in the device descriptor.
      </NbMessage>

      <template v-else>
        <!-- Live summary: the numbers as they are right now. Each tile picks
             the series the chart below plots. -->
        <div class="summary-row">
          <NbStat
            v-for="metric in metrics"
            :key="metric.key"
            size="sm"
            clickable
            :selected="metric.key === selectedMetric"
            :label="metric.label"
            :value="statValue(metric)"
            @select="selectMetric(metric.key)"
          />
        </div>

        <NbPanel :title="currentMetric?.label" :description="resolutionLabel || undefined" class="chart-panel">
          <NbTabs
            class="range-tabs"
            :items="rangeTabs"
            :model-value="selectedRange"
            variant="contained"
            size="sm"
            aria-label="History range"
            @update:model-value="selectRange($event as RangeKey)"
          />
          <!-- curve was "monotone", which TLineCurve (linear|smooth|step) never had. -->
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
          <div v-else-if="loading" class="chart-empty type-body-compact">Loading…</div>
          <div v-else class="chart-empty type-body-compact">
            No data recorded yet for this range. History starts accumulating once the device reports.
          </div>
        </NbPanel>
      </template>
    </template>

    <div v-else class="detail-loading type-body-compact">Loading…</div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, watchEffect, onMounted, onBeforeUnmount } from 'vue'
import { useRoute } from 'vue-router'
import { usePhoneLayout, type IBreadcrumbItem, type IDefinitionListItem, type ITabItem } from '@nubisco/ui'
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

/** The tile shows the figure with its unit, formatted as the reader sees it. */
function statValue(metric: MetricDescriptor): string {
  const value = formatValue(liveValue(metric), metric)
  return metric.unit ? `${value} ${metric.unit}` : value
}

/**
 * The record's one state is whether the device is answering. `unknown` is not
 * called broken: every device is unknown for the first seconds after a
 * restart, so it reads as "No data yet", the same words the device list uses.
 */
const healthLabel = computed(() => {
  const status = device.value?.health?.status
  if (status === 'ok') return 'Responding'
  if (status === 'stale') return 'Not responding'
  return 'No data yet'
})

const healthVariant = computed<'success' | 'warning' | 'neutral'>(() => {
  const status = device.value?.health?.status
  if (status === 'ok') return 'success'
  if (status === 'stale') return 'warning'
  return 'neutral'
})

/** What defines the device, as facts under its name. Absent facts are left out. */
const facts = computed<IDefinitionListItem[]>(() => {
  const dev = device.value
  if (!dev) return []
  const items: IDefinitionListItem[] = []
  if (dev.manufacturer) items.push({ term: 'Manufacturer', value: dev.manufacturer })
  if (dev.model) items.push({ term: 'Model', value: dev.model })
  items.push({ term: 'Plugin', value: dev.pluginId })
  const lastSeen = dev.health?.lastSeen
  if (lastSeen) items.push({ term: 'Last seen', value: new Date(lastSeen).toLocaleString() })
  return items
})

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
// The header, the summary and the chart are regions of one record, 24 apart.
.device-detail {
  display: flex;
  flex-direction: column;
  gap: var(--nb-spacing-24);
  padding: 0 var(--nb-spacing-24) var(--nb-spacing-24);

  // The shell already keeps a phone's gutter. A second one on top cost the
  // tiles and the chart 40px of a 360px screen.
  @include variables.phone {
    padding-inline: 0;
  }
}

.detail-loading {
  color: var(--nb-c-text-muted);
}

.summary-row {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: var(--nb-spacing-16);

  // One tile per row filled a phone's first screen with four numbers. A
  // narrower minimum fits two side by side at 360px, and more when sideways.
  @include variables.phone {
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: var(--nb-spacing-8);
  }
}

.chart-panel {
  min-width: 0;
  overflow-x: auto;
}

// NbTabs fills its row by default. Sized to its tabs, the range reads as a
// control of the chart rather than a band across the panel.
.range-tabs {
  width: auto;
  max-width: 100%;
  margin-block-end: var(--nb-spacing-16);
}

.chart-empty {
  display: grid;
  place-items: center;
  height: 320px;
  padding: 0 var(--nb-spacing-32);
  color: var(--nb-c-text-muted);
  text-align: center;

  @include variables.phone {
    height: 220px;
  }
}
</style>
