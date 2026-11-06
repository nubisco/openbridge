<template>
  <!-- The dashboard pattern. A home bridge is opened to answer "is everything
       running?", and the plugins are what answer it: they are what talks to
       the devices, and a plugin in error is the one thing here that changes
       what you do next. So the strip sums them up, the plugin list is the one
       raised region, and the rest supports it as flat tiles: the live metrics
       for when something is slow, then HomeKit pairing (a setup step, done
       once) and system information (reference). The trail names the page, so
       there is no heading repeating it. -->
  <div class="dashboard">
    <!-- Three figures from data the page already has. Hue is status: a tile
         turns red only when something is wrong. -->
    <NbCardGrid min="160px" gap="md">
      <NbStat size="sm" label="Plugins running" :value="`${daemon.runningCount} of ${daemon.plugins.length}`" />
      <NbStat
        size="sm"
        label="Plugin errors"
        :value="daemon.errorCount"
        :status="daemon.errorCount ? 'danger' : 'neutral'"
      />
      <!-- Reports the HAP bridge, not the browser's connection to the daemon.
           Those are not the same thing: the daemon serves this page perfectly
           well with no HomeKit bridge behind it, and reading "Running" in
           that state is worse than useless. -->
      <NbStat size="sm" label="HomeKit bridge" :value="hapStatusLabel" :status="hapStatus" />
    </NbCardGrid>

    <!-- The region the page is for: first, full width, and the page's only
         raised surface. -->
    <NbPanel title="Plugins">
      <template #actions>
        <NbButton size="sm" variant="tertiary" to="/plugins">Manage plugins</NbButton>
      </template>
      <p v-if="daemon.plugins.length === 0" class="empty-inline type-body-compact">No plugins loaded yet.</p>
      <NbContainedList v-else aria-label="Plugins" size="md">
        <NbContainedListItem v-for="p in daemon.plugins" :key="p.id" :title="p.manifest.name">
          <template #trailing>
            <span class="plugin-ver type-body-sm tabular">v{{ p.manifest.version }}</span>
            <NbBadge v-if="p.source === 'homebridge'" variant="neutral" size="sm">HB</NbBadge>
            <NbBadge :variant="statusVariant(p.status)" size="sm">{{ p.status }}</NbBadge>
          </template>
        </NbContainedListItem>
      </NbContainedList>
    </NbPanel>

    <!-- Live metrics: diagnostics, peers of each other, flat on the ground.
         A plain grid rather than NbCardGrid: four, two or one to a row, never
         three and an orphan. -->
    <div class="metrics">
      <NbPanel flat title="CPU" class="metric">
        <div class="metric__values">
          <span class="metric__big type-heading-03 tabular">{{ latest?.cpu ?? '—' }}</span>
          <span class="metric__unit type-body-sm">%</span>
          <span v-if="latest?.cpuTemp && latest.cpuTemp > 0" class="metric__sub type-body-sm tabular">
            {{ latest.cpuTemp }}°C
          </span>
        </div>
        <div class="metric__chart">
          <NbSparkline :data="cpuHistory" color="var(--nb-c-primary)" :height="40" />
        </div>
      </NbPanel>

      <NbPanel flat title="Memory" class="metric">
        <div class="metric__values">
          <span class="metric__big type-heading-03 tabular">{{ memPct }}</span>
          <span class="metric__unit type-body-sm">%</span>
          <span class="metric__sub type-body-sm tabular">{{ memUsed }} / {{ memTotal }}</span>
        </div>
        <NbProgressBar :value="memPct" :max="100" size="sm" />
        <div class="metric__chart">
          <NbSparkline :data="memHistory" color="var(--nb-c-primary)" :height="32" />
        </div>
      </NbPanel>

      <NbPanel flat title="Uptime" class="metric">
        <div class="uptime">
          <div class="uptime__row">
            <span class="type-heading-02 tabular">{{ sysInfo ? fmtUptime(sysInfo.uptimeSystem) : '—' }}</span>
            <span class="metric__sub type-body-sm">System</span>
          </div>
          <div class="uptime__row">
            <span class="type-heading-02 tabular">{{ sysInfo ? fmtUptime(sysInfo.uptimeProcess) : '—' }}</span>
            <span class="metric__sub type-body-sm">Process</span>
          </div>
        </div>
        <!-- Restarting interrupts HomeKit for a few seconds and destroys
             nothing, so it is not a danger action. Alone in its tile, it is
             tertiary rather than a stranded secondary. -->
        <div class="metric__chart">
          <NbButton
            variant="tertiary"
            size="sm"
            :loading="restarting"
            :icon="restartDone ? iconCheck : iconRestart"
            @click="restartOpenBridge"
          >
            {{ restartDone ? 'Restarted' : restarting ? 'Restarting…' : 'Restart OpenBridge' }}
          </NbButton>
        </div>
      </NbPanel>

      <NbPanel flat title="Network" class="metric">
        <div class="net">
          <div>
            <div class="type-heading-compact tabular">{{ latest ? fmtBytes(latest.netRxSec) + '/s' : '—' }}</div>
            <div class="metric__sub type-body-sm">↓ Received</div>
          </div>
          <div>
            <div class="type-heading-compact tabular">{{ latest ? fmtBytes(latest.netTxSec) + '/s' : '—' }}</div>
            <div class="metric__sub type-body-sm">↑ Sent</div>
          </div>
        </div>
        <div class="metric__chart net__charts">
          <NbSparkline :data="netRxHistory" color="var(--nb-c-primary)" :height="28" />
          <NbSparkline :data="netTxHistory" color="var(--nb-c-text-subtle)" :height="28" />
        </div>
      </NbPanel>
    </div>

    <!-- Setup and reference, read rarely: last, flat, two halves. -->
    <NbCardGrid min="320px" gap="lg" fill="auto-fit">
      <NbPanel flat title="HomeKit pairing">
        <div class="hk">
          <div v-if="qrDataUrl" class="hk__qr">
            <img :src="qrDataUrl" alt="HomeKit QR code" class="hk__qr-img" />
          </div>
          <div v-else class="hk__qr hk__qr--empty type-body-sm">
            <NbIcon name="qr-code" size="xl" />
            <span>{{ hapError ? 'HomeKit bridge unavailable' : 'No HAP bridge configured' }}</span>
          </div>
          <div class="hk__details">
            <div v-if="pincode" class="hk__pin type-heading-02 tabular">{{ pincode }}</div>
            <div v-if="pincode" class="metric__sub type-body-sm">Scan to add to HomeKit</div>
            <div v-if="hapError" class="hk__error type-body-sm">{{ hapError }}</div>
          </div>
        </div>
      </NbPanel>

      <NbPanel flat title="System information">
        <!-- A fixed term width keeps every value on one edge. The library's
             rows are separate grids, so a content-sized term would not. -->
        <NbDefinitionList v-if="sysInfo" compact term-width="6rem">
          <NbDefinitionListItem term="OS">{{ sysInfo.os }}</NbDefinitionListItem>
          <NbDefinitionListItem term="Arch">{{ sysInfo.arch }}</NbDefinitionListItem>
          <NbDefinitionListItem term="Hostname">{{ sysInfo.hostname }}</NbDefinitionListItem>
          <NbDefinitionListItem term="IP Address">{{ sysInfo.ip }}</NbDefinitionListItem>
          <NbDefinitionListItem term="User">{{ sysInfo.user }}</NbDefinitionListItem>
          <NbDefinitionListItem term="Node.js">{{ sysInfo.nodeVersion }}</NbDefinitionListItem>
          <NbDefinitionListItem term="OpenBridge">v{{ daemon.health?.version ?? '—' }}</NbDefinitionListItem>
          <NbDefinitionListItem term="Config">
            <span class="sys-path type-code-sm">{{ sysInfo.configPath }}</span>
          </NbDefinitionListItem>
          <NbDefinitionListItem term="OB plugins">
            <span class="sys-path type-code-sm">{{ sysInfo.obPluginsDir }}</span>
          </NbDefinitionListItem>
          <NbDefinitionListItem term="HB plugins">
            <span class="sys-path type-code-sm">{{ sysInfo.hbPluginsDir }}</span>
          </NbDefinitionListItem>
        </NbDefinitionList>
        <NbSpinner v-else size="sm" show-label label="Loading..." />
      </NbPanel>
    </NbCardGrid>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, shallowRef } from 'vue'
import QRCode from 'qrcode'
import { api, type SystemInfo, type MetricsSnapshot } from '@/api'
import { useDaemonStore } from '@/stores/daemon'
import { useLayoutStore } from '@/stores/layout'
// Bound through a ternary, so the bundler plugin cannot link them by name.
import * as iconCheck from '@nubisco/ui/icons/check'
import * as iconRestart from '@nubisco/ui/icons/arrows-clockwise'

const daemon = useDaemonStore()
const layout = useLayoutStore()

function statusVariant(status: string) {
  if (status === 'running') return 'success'
  if (status === 'error') return 'danger'
  if (status === 'loading') return 'info'
  return 'neutral'
}

// ─── Restart OpenBridge ───────────────────────────────────────────────────────
const restarting = ref(false)
const restartDone = ref(false)

async function restartOpenBridge() {
  if (restarting.value) return
  restarting.value = true
  restartDone.value = false
  try {
    await api.daemon.restart()
    restartDone.value = true
    let attempts = 0
    const poll = setInterval(async () => {
      attempts++
      try {
        await api.health()
        clearInterval(poll)
        // Reload the page so all stores, WebSockets, and UI reset cleanly
        location.reload()
      } catch {
        /* still restarting */
      }
      if (attempts > 60) {
        clearInterval(poll)
        restarting.value = false
      }
    }, 1000)
  } catch {
    restarting.value = false
  }
}

// ─── Static info ──────────────────────────────────────────────────────────────
const sysInfo = ref<SystemInfo | null>(null)
const qrDataUrl = ref('')
const pincode = ref('')
/** Why HomeKit is unavailable, as reported by the daemon. */
const hapError = ref('')

/** Red only when the bridge is down. A running bridge is the quiet default. */
const hapStatus = computed(() => (daemon.connected && hapError.value ? 'danger' : 'neutral'))

const hapStatusLabel = computed(() => {
  if (!daemon.connected) return 'Daemon offline'
  return hapError.value ? 'Offline' : 'Running'
})

// ─── Live metrics ─────────────────────────────────────────────────────────────
const cpuHistory = ref<number[]>([])
const memHistory = ref<number[]>([])
const netRxHistory = ref<number[]>([])
const netTxHistory = ref<number[]>([])
const latest = shallowRef<MetricsSnapshot | null>(null)
let metricsWs: WebSocket | null = null

function connectMetrics() {
  if (metricsWs) {
    metricsWs.onclose = null
    metricsWs.close()
    metricsWs = null
  }
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  metricsWs = new WebSocket(`${protocol}//${location.host}/ws/metrics`)
  metricsWs.onmessage = (e) => {
    // Skip buffered messages when tab was hidden to avoid catch-up animation
    if (document.hidden) return
    try {
      const msg = JSON.parse(e.data as string)
      if (msg.type === 'history') {
        const snaps: MetricsSnapshot[] = msg.data
        cpuHistory.value = snaps.map((s) => s.cpu)
        memHistory.value = snaps.map((s) => memPercent(s))
        netRxHistory.value = snaps.map((s) => s.netRxSec)
        netTxHistory.value = snaps.map((s) => s.netTxSec)
        if (snaps.length) latest.value = snaps[snaps.length - 1]
      } else if (msg.type === 'snapshot') {
        const s: MetricsSnapshot = msg.data
        latest.value = s
        push(cpuHistory, s.cpu)
        push(memHistory, memPercent(s))
        push(netRxHistory, s.netRxSec)
        push(netTxHistory, s.netTxSec)
      }
    } catch {
      /* ignore */
    }
  }
  metricsWs.onclose = () => {
    metricsWs = null
    setTimeout(connectMetrics, 3000)
  }
}

// When the tab becomes visible again, reconnect to get fresh history
// instead of processing the buffered snapshots that accumulated while hidden.
function onVisibilityChange() {
  if (!document.hidden) {
    connectMetrics()
  }
}

function push(arr: typeof cpuHistory, val: number) {
  arr.value = [...arr.value.slice(-59), val]
}

function memPercent(s: MetricsSnapshot): number {
  return s.memTotal ? Math.round(((s.memTotal - s.memFree) / s.memTotal) * 100) : 0
}

// ─── Formatters ───────────────────────────────────────────────────────────────
function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`
  return `${(b / 1024 ** 3).toFixed(1)} GB`
}

function fmtUptime(secs: number): string {
  const d = Math.floor(secs / 86400)
  const h = Math.floor((secs % 86400) / 3600)
  const m = Math.floor((secs % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

const memUsed = computed(() => (latest.value ? fmtBytes(latest.value.memTotal - latest.value.memFree) : '—'))
const memTotal = computed(() => (latest.value ? fmtBytes(latest.value.memTotal) : '—'))
const memPct = computed(() => (latest.value ? memPercent(latest.value) : 0))

onMounted(async () => {
  layout.setPage('Dashboard')
  daemon.fetchPlugins()

  try {
    sysInfo.value = await api.system()
  } catch {
    /* daemon may not be up */
  }

  try {
    const qrRes = await api.qr()
    hapError.value = qrRes.error ?? ''
    if (qrRes.setupURI) {
      pincode.value = qrRes.pincode ?? ''
      qrDataUrl.value = await QRCode.toDataURL(qrRes.setupURI, {
        width: 148,
        margin: 1,
        // Literal, not tokenised: these are scanned by a camera, so maximum
        // contrast matters more than matching the theme.
        color: { dark: '#000000', light: '#ffffff' },
      })
    }
  } catch {
    /* ignore */
  }

  connectMetrics()
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onUnmounted(() => {
  metricsWs?.close()
  metricsWs = null
  document.removeEventListener('visibilitychange', onVisibilityChange)
})
</script>

<style lang="scss" scoped>
// Regions are xl apart (the dashboard pattern).
.dashboard {
  container-type: inline-size;
  display: flex;
  flex-direction: column;
  gap: var(--nb-spacing-32);
}

.metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--nb-spacing-24);

  @container (max-width: 960px) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  // Two side by side squeezes the network tile's two rates past its edge at
  // 360px, so on a phone the metrics stack.
  @include variables.phone {
    grid-template-columns: minmax(0, 1fr);
  }
}

.empty-inline {
  margin: 0;
  color: var(--nb-c-text-muted);
}

.plugin-ver {
  color: var(--nb-c-text-muted);
}

// ─── Metrics ─────────────────────────────────────────────────────────────────
.metric {
  display: flex;
  flex-direction: column;
  gap: var(--nb-spacing-8);

  &__values {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--nb-spacing-4);
  }

  &__big {
    color: var(--nb-c-text);
  }

  &__unit,
  &__sub {
    color: var(--nb-c-text-muted);
  }

  &__unit + &__sub {
    margin-inline-start: var(--nb-spacing-4);
  }

  // Charts and the restart button sit on the tile's bottom edge, so the
  // four tiles line up whatever their content above.
  &__chart {
    margin-top: auto;
  }
}

.uptime {
  display: flex;
  gap: var(--nb-spacing-24);

  &__row {
    display: flex;
    flex-direction: column;
  }
}

.net {
  display: flex;
  gap: var(--nb-spacing-24);

  &__charts {
    display: flex;
    flex-direction: column;
    gap: var(--nb-spacing-2);
  }
}

// ─── HomeKit ─────────────────────────────────────────────────────────────────
.hk {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--nb-spacing-12);

  // The QR code is drawn at a fixed 148px (see QRCode.toDataURL), so its
  // frame and the empty placeholder hold the same box.
  &__qr {
    border-radius: var(--nb-radius-md);
    overflow: hidden;
    border: 1px solid var(--nb-c-border);
  }

  &__qr-img {
    display: block;
    width: 148px;
    height: 148px;
  }

  &__qr--empty {
    width: 148px;
    height: 148px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--nb-spacing-8);
    padding: var(--nb-spacing-8);
    color: var(--nb-c-text-muted);
    text-align: center;
    border-style: dashed;
  }

  &__details {
    text-align: center;
  }

  &__pin {
    color: var(--nb-c-text);
  }

  &__error {
    margin-top: var(--nb-spacing-4);
    color: var(--nb-c-danger);
  }
}

// A path is read character by character, so it keeps the monospace face.
.sys-path {
  color: var(--nb-c-text-muted);
  overflow-wrap: anywhere;
}
</style>
