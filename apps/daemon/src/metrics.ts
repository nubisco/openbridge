import os from 'os'
import si from 'systeminformation'

export interface MetricsSnapshot {
  t: number // unix ms
  cpu: number // 0-100
  cpuTemp: number // celsius, -1 = unavailable
  memTotal: number // bytes
  memFree: number // bytes
  netRxSec: number // bytes/s
  netTxSec: number // bytes/s
}

const MAX_HISTORY = 60
export const history: MetricsSnapshot[] = []

type Listener = (snap: MetricsSnapshot) => void
const listeners = new Set<Listener>()

export function onMetrics(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

async function collect(): Promise<MetricsSnapshot> {
  const [load, temp, net] = await Promise.all([
    si.currentLoad().catch(() => ({ currentLoad: 0 })),
    si.cpuTemperature().catch(() => ({ main: -1 })),
    si.networkStats().catch(() => [] as any[]),
  ])

  const snap: MetricsSnapshot = {
    t: Date.now(),
    cpu: Math.round(load.currentLoad ?? 0),
    cpuTemp: Math.round(temp.main && temp.main > 0 ? temp.main : -1),
    memTotal: os.totalmem(),
    memFree: os.freemem(),
    netRxSec: Math.max(0, Math.round(net[0]?.rx_sec ?? 0)),
    netTxSec: Math.max(0, Math.round(net[0]?.tx_sec ?? 0)),
  }

  history.push(snap)
  if (history.length > MAX_HISTORY) history.shift()
  return snap
}

let timer: ReturnType<typeof setInterval> | null = null

export function startMetrics(intervalMs = 2000): void {
  if (timer) return
  // Prime the CPU sampler (first reading is always 0)
  collect().then(() => {
    timer = setInterval(async () => {
      const snap = await collect()
      for (const fn of listeners) fn(snap)
    }, intervalMs)
  })
}

export function stopMetrics(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

export function getHistory(): MetricsSnapshot[] {
  return [...history]
}
