<template>
  <div class="dashboard">
    <!-- ─── Row 1: HomeKit + System Info + Plugins ────────────────────────── -->
    <div class="top-row">
      <!-- HomeKit pairing card -->
      <NbPanel class="hk-card">
        <div class="card-title">HomeKit Pairing</div>
        <div class="hk-body">
          <div v-if="qrDataUrl" class="qr-wrap">
            <img :src="qrDataUrl" alt="HomeKit QR Code" class="qr-img" />
          </div>
          <div v-else class="qr-placeholder">
            <NbIcon name="qr-code" :size="48" />
            <span>No HAP bridge configured</span>
          </div>
          <div class="hk-details">
            <div v-if="pincode" class="pin-display">{{ pincode }}</div>
            <div v-if="pincode" class="pin-label">Scan to add to HomeKit</div>
            <div class="hk-status">
              <span class="dot" :class="daemon.connected ? 'green' : 'gray'" />
              {{ daemon.connected ? 'Bridge running' : 'Bridge offline' }}
            </div>
          </div>
        </div>
      </NbPanel>

      <!-- System information card -->
      <NbPanel class="sys-card">
        <div class="card-title">System Information</div>
        <div v-if="sysInfo" class="sys-grid">
          <span class="sys-key">OS</span>
          <span class="sys-val">{{ sysInfo.os }}</span>
          <span class="sys-key">Arch</span>
          <span class="sys-val">{{ sysInfo.arch }}</span>
          <span class="sys-key">Hostname</span>
          <span class="sys-val">{{ sysInfo.hostname }}</span>
          <span class="sys-key">IP Address</span>
          <span class="sys-val">{{ sysInfo.ip }}</span>
          <span class="sys-key">User</span>
          <span class="sys-val">{{ sysInfo.user }}</span>
          <span class="sys-key">Node.js</span>
          <span class="sys-val">{{ sysInfo.nodeVersion }}</span>
          <span class="sys-key">OpenBridge</span>
          <span class="sys-val">v{{ daemon.health?.version ?? '—' }}</span>
          <span class="sys-key">Config</span>
          <span class="sys-val mono">{{ sysInfo.configPath }}</span>
          <span class="sys-key">OB plugins</span>
          <span class="sys-val mono">{{ sysInfo.obPluginsDir }}</span>
          <span class="sys-key">HB plugins</span>
          <span class="sys-val mono">{{ sysInfo.hbPluginsDir }}</span>
        </div>
        <div v-else class="loading-inline">
          <NbIcon name="spinner" :size="16" />
          Loading...
        </div>
      </NbPanel>

      <!-- Plugins mini-list card -->
      <NbPanel class="plugins-card">
        <div class="card-title">
          Plugins
          <span class="plugins-counts">
            <NbBadge variant="green">{{ daemon.runningCount }} running</NbBadge>
            <span v-if="daemon.errorCount" class="pill red">{{ daemon.errorCount }} error</span>
          </span>
        </div>
        <div v-if="daemon.plugins.length === 0" class="empty-inline">No plugins loaded yet.</div>
        <div v-else class="plugins-list">
          <div v-for="p in daemon.plugins" :key="p.id" class="plugin-row">
            <div class="plugin-dot" :class="p.status" />
            <span class="plugin-name">{{ p.manifest.name }}</span>
            <span class="plugin-ver">v{{ p.manifest.version }}</span>
            <NbBadge v-if="p.source === 'homebridge'" variant="orange" size="sm">HB</NbBadge>
            <NbBadge :variant="statusVariant(p.status)" size="sm">{{ p.status }}</NbBadge>
          </div>
        </div>
      </NbPanel>
    </div>

    <!-- ─── Row 2: Metrics cards ──────────────────────────────────────────── -->
    <div class="metrics-row">
      <!-- CPU -->
      <NbPanel class="metric-card">
        <div class="metric-header">
          <div class="metric-icon purple"><NbIcon name="cpu" :size="13" /></div>
          <span class="metric-title">CPU</span>
        </div>
        <div class="metric-values">
          <div class="metric-big">
            {{ latest?.cpu ?? '—' }}
            <span class="metric-unit">%</span>
          </div>
          <div v-if="latest?.cpuTemp && latest.cpuTemp > 0" class="metric-sub">{{ latest.cpuTemp }}°C</div>
        </div>
        <div class="metric-chart">
          <NbSparkline :data="cpuHistory" color="var(--nb-c-primary)" :height="40" />
        </div>
      </NbPanel>

      <!-- Memory -->
      <NbPanel class="metric-card">
        <div class="metric-header">
          <div class="metric-icon blue"><NbIcon name="database" :size="13" /></div>
          <span class="metric-title">Memory</span>
        </div>
        <div class="metric-values">
          <div class="metric-big">
            {{ memPct }}
            <span class="metric-unit">%</span>
          </div>
          <div class="metric-sub">{{ memUsed }} / {{ memTotal }}</div>
        </div>
        <NbProgressBar :value="memPct" :max="100" size="sm" />
        <div class="metric-chart">
          <NbSparkline :data="memHistory" color="var(--nb-c-info)" :height="32" />
        </div>
      </NbPanel>

      <!-- Uptime + Restart -->
      <NbPanel class="metric-card">
        <div class="metric-header">
          <div class="metric-icon green"><NbIcon name="clock" :size="13" /></div>
          <span class="metric-title">Uptime</span>
        </div>
        <div class="uptime-rows">
          <div class="uptime-row">
            <span class="uptime-val">{{ sysInfo ? fmtUptime(sysInfo.uptimeSystem) : '—' }}</span>
            <span class="uptime-label">System</span>
          </div>
          <div class="uptime-divider" />
          <div class="uptime-row">
            <span class="uptime-val">{{ sysInfo ? fmtUptime(sysInfo.uptimeProcess) : '—' }}</span>
            <span class="uptime-label">Process</span>
          </div>
        </div>
        <div style="margin-top: 0.75rem">
          <NbButton
            variant="secondary"
            size="sm"
            outlined
            style="width: 100%; justify-content: center"
            :loading="restarting"
            :icon="restartDone ? 'check' : restarting ? 'spinner' : 'arrows-clockwise'"
            @click="restartOpenBridge"
          >
            {{ restartDone ? 'Restarted' : restarting ? 'Restarting…' : 'Restart OpenBridge' }}
          </NbButton>
        </div>
      </NbPanel>

      <!-- Network -->
      <NbPanel class="metric-card net-card">
        <div class="metric-header">
          <div class="metric-icon amber"><NbIcon name="activity" :size="13" /></div>
          <span class="metric-title">Network</span>
        </div>
        <div class="net-values">
          <div>
            <div class="net-val">{{ latest ? fmtBytes(latest.netRxSec) + '/s' : '—' }}</div>
            <div class="net-label">↓ Received</div>
          </div>
          <div>
            <div class="net-val">{{ latest ? fmtBytes(latest.netTxSec) + '/s' : '—' }}</div>
            <div class="net-label">↑ Sent</div>
          </div>
        </div>
        <div class="metric-chart net-charts">
          <NbSparkline :data="netRxHistory" color="var(--nb-c-success)" :height="28" />
          <NbSparkline :data="netTxHistory" color="var(--nb-c-warning)" :height="28" />
        </div>
      </NbPanel>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, shallowRef } from 'vue'
import QRCode from 'qrcode'
import { api, type SystemInfo, type MetricsSnapshot } from '@/api'
import { useDaemonStore } from '@/stores/daemon'
import { useLayoutStore } from '@/stores/layout'
// NbSparkline replaced by NbSparkline from @nubisco/ui (globally registered)

const daemon = useDaemonStore()
const layout = useLayoutStore()

function statusVariant(status: string) {
  if (status === 'running') return 'green'
  if (status === 'error') return 'red'
  if (status === 'loading') return 'blue'
  return 'grey'
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
.dashboard {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  flex: 1;
  min-height: 0;
}

// ─── Cards ────────────────────────────────────────────────────────────────────
.card-title {
  font-size: 0.78rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--nb-c-text-subtle);
  margin-bottom: 0.85rem;
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

// ─── Row 1: 3 columns ────────────────────────────────────────────────────────
.top-row {
  display: grid;
  grid-template-columns: 220px 1fr 1fr;
  gap: 1rem;
}

// HomeKit card
.hk-card {
  display: flex;
  flex-direction: column;
}
.hk-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
}
.qr-wrap {
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--nb-c-border);
}
.qr-img {
  display: block;
  width: 148px;
  height: 148px;
}
.qr-placeholder {
  width: 148px;
  height: 148px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  color: var(--nb-c-border);
  font-size: 0.75rem;
  text-align: center;
  border: 1px dashed var(--nb-c-border);
  border-radius: 8px;
}
.hk-details {
  text-align: center;
}
.pin-display {
  font-size: 1.3rem;
  font-weight: 800;
  letter-spacing: 0.12em;
  color: var(--nb-c-text);
  font-family: monospace;
}
.pin-label {
  font-size: 0.72rem;
  color: var(--nb-c-text-subtle);
  margin-top: 2px;
}
.hk-status {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.75rem;
  color: var(--nb-c-text-muted);
  margin-top: 0.5rem;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  &.green {
    background: var(--nb-c-success);
    box-shadow: 0 0 4px color-mix(in srgb, var(--nb-c-success) 60%, transparent);
  }
  &.gray {
    background: var(--nb-c-border);
  }
}

// System info
.sys-card {
  display: flex;
  flex-direction: column;
}
.sys-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.3rem 1.25rem;
  font-size: 0.81rem;
}
.sys-key {
  color: var(--nb-c-text-muted);
  white-space: nowrap;
}
.sys-val {
  color: var(--nb-c-text);
  word-break: break-all;
  &.mono {
    font-family: monospace;
    font-size: 0.75rem;
    color: var(--nb-c-text-muted);
  }
}
.loading-inline {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--nb-c-text-subtle);
  font-size: 0.82rem;
}

// Plugins mini-list
.plugins-card {
  display: flex;
  flex-direction: column;
}
.plugins-counts {
  display: flex;
  gap: 0.4rem;
  margin-left: auto;
}
.empty-inline {
  font-size: 0.82rem;
  color: var(--nb-c-text-subtle);
}
.plugins-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
  flex: 1;
}
.plugin-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.45rem 0.7rem;
  border-radius: 7px;
  background: var(--nb-c-layer-1);
  font-size: 0.82rem;
  &:hover {
    background: var(--nb-c-layer-1);
  }
}
.plugin-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--nb-c-border);
  &.running {
    background: var(--nb-c-success);
  }
  &.error {
    background: var(--nb-c-danger);
  }
  &.loading {
    background: var(--nb-c-warning);
  }
}
.plugin-name {
  font-weight: 500;
  color: var(--nb-c-text);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plugin-ver {
  color: var(--nb-c-text-subtle);
  flex-shrink: 0;
}
// ─── Row 2 ────────────────────────────────────────────────────────────────────
.metrics-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1rem;
}

.metric-card {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.75rem 0.9rem;
}
.metric-header {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.metric-title {
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--nb-c-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.metric-icon {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  &.purple {
    background: color-mix(in srgb, var(--nb-c-primary) 12%, var(--nb-c-surface));
    color: var(--nb-c-primary);
  }
  &.blue {
    background: color-mix(in srgb, var(--nb-c-info) 10%, var(--nb-c-surface));
    color: var(--nb-c-info);
  }
  &.green {
    background: color-mix(in srgb, var(--nb-c-success) 10%, var(--nb-c-surface));
    color: var(--nb-c-success);
  }
  &.amber {
    background: color-mix(in srgb, var(--nb-c-warning) 10%, var(--nb-c-surface));
    color: var(--nb-c-warning);
  }
}

.metric-values {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
}
.metric-big {
  font-size: 1.6rem;
  font-weight: 800;
  color: var(--nb-c-text);
  line-height: 1;
  .metric-unit {
    font-size: 0.82rem;
    font-weight: 500;
    color: var(--nb-c-text-subtle);
    margin-left: 1px;
  }
}
.metric-sub {
  font-size: 0.72rem;
  color: var(--nb-c-text-subtle);
}
.metric-chart {
  margin-top: auto;
}

.uptime-rows {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  margin-top: 0.15rem;
  flex: 1;
}
.uptime-row {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  flex: 1;
}
.uptime-val {
  font-size: 1.15rem;
  font-weight: 700;
  color: var(--nb-c-text);
}
.uptime-label {
  font-size: 0.66rem;
  color: var(--nb-c-text-subtle);
}
.uptime-divider {
  width: 1px;
  height: 28px;
  background: var(--nb-c-border);
  flex-shrink: 0;
}

.net-values {
  display: flex;
  gap: 1.25rem;
}
.net-val {
  font-size: 0.9rem;
  font-weight: 700;
  color: var(--nb-c-text);
}
.net-label {
  font-size: 0.66rem;
  color: var(--nb-c-text-subtle);
  margin-top: 2px;
}
.net-charts {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 0.5rem;
}
</style>
