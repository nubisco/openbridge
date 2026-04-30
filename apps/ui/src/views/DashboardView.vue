<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, shallowRef } from 'vue'
import QRCode from 'qrcode'
import { api, type SystemInfo, type MetricsSnapshot } from '@/api'
import { useDaemonStore } from '@/stores/daemon'
import { useLayoutStore } from '@/stores/layout'
// NbSparkline replaced by NbSparkline from @nubisco/ui (globally registered)

const daemon = useDaemonStore()
const layout = useLayoutStore()

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

// ─── Log section ─────────────────────────────────────────────────────────────
const logFilter = ref<string[]>([]) // empty = show all
const logsEl = ref<HTMLElement | null>(null)
const logsExpanded = ref(false)

const pluginFilterOptions = computed(() => [
  { value: 'system', label: 'system' },
  ...daemon.plugins.map((p) => ({ value: p.manifest.name, label: p.manifest.name })),
])

const filteredLogs = computed(() => {
  if (logFilter.value.length === 0) return daemon.logs
  return daemon.logs.filter((e) => logFilter.value.includes(e.plugin))
})

const LOG_COLORS: Record<string, string> = {
  debug: '#6b7280',
  info: '#06b6d4',
  warn: '#f59e0b',
  error: '#ef4444',
}

function clearLogs() {
  daemon.logs.length = 0
}

onMounted(async () => {
  layout.setPage('Dashboard')
  daemon.fetchPlugins()

  // Pre-load recent log history (WebSocket only delivers new entries)
  daemon.fetchLogs()

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
        color: { dark: '#1a1a2e', light: '#ffffff' },
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

<template>
  <div class="dashboard">
    <!-- ─── Row 1: HomeKit + System Info + Plugins ────────────────────────── -->
    <template v-if="!logsExpanded">
      <div class="top-row">
        <!-- HomeKit pairing card -->
        <div class="card hk-card">
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
        </div>

        <!-- System information card -->
        <div class="card sys-card">
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
        </div>

        <!-- Plugins mini-list card -->
        <div class="card plugins-card">
          <div class="card-title">
            Plugins
            <span class="plugins-counts">
              <span class="pill green">{{ daemon.runningCount }} running</span>
              <span v-if="daemon.errorCount" class="pill red">{{ daemon.errorCount }} error</span>
            </span>
          </div>
          <div v-if="daemon.plugins.length === 0" class="empty-inline">No plugins loaded yet.</div>
          <div v-else class="plugins-list">
            <div v-for="p in daemon.plugins" :key="p.id" class="plugin-row">
              <div class="plugin-dot" :class="p.status" />
              <span class="plugin-name">{{ p.manifest.name }}</span>
              <span class="plugin-ver">v{{ p.manifest.version }}</span>
              <span v-if="p.source === 'homebridge'" class="hb-badge">HB</span>
              <span class="plugin-status" :class="p.status">{{ p.status }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- ─── Row 2: Metrics cards ──────────────────────────────────────────── -->
      <div class="metrics-row">
        <!-- CPU -->
        <div class="card metric-card">
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
            <NbSparkline :data="cpuHistory" color="#7c3aed" :height="40" />
          </div>
        </div>

        <!-- Memory -->
        <div class="card metric-card">
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
          <div class="mem-bar-wrap"><div class="mem-bar" :style="{ width: memPct + '%' }" /></div>
          <div class="metric-chart">
            <NbSparkline :data="memHistory" color="#3b82f6" :height="32" />
          </div>
        </div>

        <!-- Uptime + Restart -->
        <div class="card metric-card">
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
        </div>

        <!-- Network -->
        <div class="card metric-card net-card">
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
            <NbSparkline :data="netRxHistory" color="#10b981" :height="28" />
            <NbSparkline :data="netTxHistory" color="#f59e0b" :height="28" />
          </div>
        </div>
      </div>
    </template>
    <!-- end v-if="!logsExpanded" -->

    <!-- ─── Row 3: Live Logs ──────────────────────────────────────────────── -->
    <div class="card logs-card" :class="{ 'logs-card--expanded': logsExpanded }">
      <div class="logs-card-header">
        <span class="card-title" style="margin-bottom: 0">Live Logs</span>
        <div class="logs-filter">
          <NbSelect v-model="logFilter" multiple :options="pluginFilterOptions" placeholder="All plugins" size="sm" />
        </div>
        <NbButton
          variant="ghost"
          size="sm"
          :icon="logsExpanded ? 'arrows-in' : 'arrows-out'"
          :title="logsExpanded ? 'Collapse' : 'Expand'"
          @click="logsExpanded = !logsExpanded"
        />
        <NbButton variant="ghost" size="sm" icon="trash" title="Clear" @click="clearLogs" />
      </div>
      <div ref="logsEl" class="log-list">
        <div v-if="filteredLogs.length === 0" class="log-empty">No log entries yet.</div>
        <div v-for="(entry, i) in filteredLogs" :key="i" class="log-line">
          <span class="log-time">{{ new Date(entry.timestamp).toLocaleTimeString() }}</span>
          <span class="log-level" :style="{ color: LOG_COLORS[entry.level] }">{{ entry.level.toUpperCase() }}</span>
          <span class="log-plugin">{{ entry.plugin }}</span>
          <span class="log-msg">{{ entry.message }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.dashboard {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  flex: 1;
  min-height: 0;
}

// ─── Cards ────────────────────────────────────────────────────────────────────
.card {
  background: #fff;
  border: 1px solid #e8e8f0;
  border-radius: 12px;
  padding: 1.1rem 1.25rem;
}

.card-title {
  font-size: 0.78rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: #9ca3af;
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
  border: 1px solid #e8e8f0;
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
  color: #d1d5db;
  font-size: 0.75rem;
  text-align: center;
  border: 1px dashed #e8e8f0;
  border-radius: 8px;
}
.hk-details {
  text-align: center;
}
.pin-display {
  font-size: 1.3rem;
  font-weight: 800;
  letter-spacing: 0.12em;
  color: #1a1a2e;
  font-family: monospace;
}
.pin-label {
  font-size: 0.72rem;
  color: #9ca3af;
  margin-top: 2px;
}
.hk-status {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.75rem;
  color: #6b7280;
  margin-top: 0.5rem;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  &.green {
    background: #34d399;
    box-shadow: 0 0 4px rgba(52, 211, 153, 0.6);
  }
  &.gray {
    background: #d1d5db;
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
  color: #6b7280;
  white-space: nowrap;
}
.sys-val {
  color: #111827;
  word-break: break-all;
  &.mono {
    font-family: monospace;
    font-size: 0.75rem;
    color: #6b7280;
  }
}
.loading-inline {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: #9ca3af;
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
.pill {
  font-size: 0.68rem;
  font-weight: 700;
  padding: 0.1rem 0.5rem;
  border-radius: 20px;
  text-transform: uppercase;
  &.green {
    background: #d1fae5;
    color: #065f46;
  }
  &.red {
    background: #fee2e2;
    color: #991b1b;
  }
}
.empty-inline {
  font-size: 0.82rem;
  color: #9ca3af;
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
  background: #f9f9fc;
  font-size: 0.82rem;
  &:hover {
    background: #f0f0f8;
  }
}
.plugin-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: #d1d5db;
  &.running {
    background: #34d399;
  }
  &.error {
    background: #f87171;
  }
  &.loading {
    background: #fbbf24;
  }
}
.plugin-name {
  font-weight: 500;
  color: #111827;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plugin-ver {
  color: #9ca3af;
  flex-shrink: 0;
}
.hb-badge {
  font-size: 0.62rem;
  font-weight: 700;
  background: #fef3c7;
  color: #92400e;
  border: 1px solid #fcd34d;
  padding: 0 0.35rem;
  border-radius: 3px;
  flex-shrink: 0;
}
.plugin-status {
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  flex-shrink: 0;
  color: #9ca3af;
  &.running {
    color: #059669;
  }
  &.error {
    color: #dc2626;
  }
  &.loading {
    color: #d97706;
  }
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
  color: #6b7280;
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
    background: #f0eeff;
    color: #7c3aed;
  }
  &.blue {
    background: #eff6ff;
    color: #3b82f6;
  }
  &.green {
    background: #ecfdf5;
    color: #10b981;
  }
  &.amber {
    background: #fffbeb;
    color: #f59e0b;
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
  color: #111827;
  line-height: 1;
  .metric-unit {
    font-size: 0.82rem;
    font-weight: 500;
    color: #9ca3af;
    margin-left: 1px;
  }
}
.metric-sub {
  font-size: 0.72rem;
  color: #9ca3af;
}
.metric-chart {
  margin-top: auto;
}

.mem-bar-wrap {
  height: 3px;
  background: #f0f0f8;
  border-radius: 2px;
  overflow: hidden;
}
.mem-bar {
  height: 100%;
  background: #3b82f6;
  border-radius: 2px;
  transition: width 0.5s ease;
  max-width: 100%;
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
  color: #111827;
}
.uptime-label {
  font-size: 0.66rem;
  color: #9ca3af;
}
.uptime-divider {
  width: 1px;
  height: 28px;
  background: #e8e8f0;
  flex-shrink: 0;
}

.net-values {
  display: flex;
  gap: 1.25rem;
}
.net-val {
  font-size: 0.9rem;
  font-weight: 700;
  color: #111827;
}
.net-label {
  font-size: 0.66rem;
  color: #9ca3af;
  margin-top: 2px;
}
.net-charts {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 0.5rem;
}

// ─── Row 3: Logs ──────────────────────────────────────────────────────────────
.logs-card {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.logs-card-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
  flex-shrink: 0;

  .logs-filter {
    width: 260px;
  }
}

.log-list {
  background: #0d1117;
  border-radius: 8px;
  padding: 0.6rem 0.75rem;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  font-family: 'MesloLGS NF', monospace;
  font-size: 0.72rem;
  line-height: 1.55;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.log-empty {
  color: #4b5563;
  padding: 1rem 0;
  text-align: center;
}

.log-line {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
  &:hover {
    background: rgba(255, 255, 255, 0.03);
    border-radius: 3px;
  }
}

.log-time {
  color: #4b5563;
  flex-shrink: 0;
  font-size: 0.68rem;
}
.log-level {
  flex-shrink: 0;
  width: 34px;
  font-weight: 700;
  font-size: 0.66rem;
}
.log-plugin {
  color: #7c6f9f;
  flex-shrink: 0;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.log-msg {
  color: #c9d1d9;
  flex: 1;
  word-break: break-word;
}
</style>
