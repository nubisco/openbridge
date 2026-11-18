import os from 'os'
import si from 'systeminformation'
import { readCpuTemperature, readCpuTimes, readDefaultInterfaceBytes } from './system-readings.js'

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

let lastCpu: { busy: number; total: number } | undefined

/** Percentage of CPU time spent busy since the previous tick, all cores together. */
async function cpuLoad(): Promise<number> {
  const times = readCpuTimes()
  if (!times) {
    const load = await si.currentLoad().catch(() => ({ currentLoad: 0 }))
    return load.currentLoad ?? 0
  }
  const prev = lastCpu
  lastCpu = times
  const total = prev ? times.total - prev.total : 0
  return prev && total > 0 ? (100 * (times.busy - prev.busy)) / total : 0
}

let lastNet: { rx: number; tx: number; at: number } | undefined

/** Bytes per second on the default interface since the previous tick. */
async function networkRates(): Promise<{ rx: number; tx: number }> {
  const bytes = readDefaultInterfaceBytes()
  if (!bytes) {
    const net = await si.networkStats().catch(() => [] as any[])
    return { rx: net[0]?.rx_sec ?? 0, tx: net[0]?.tx_sec ?? 0 }
  }
  const at = Date.now()
  const prev = lastNet
  lastNet = { ...bytes, at }
  const seconds = prev ? (at - prev.at) / 1000 : 0
  if (!prev || seconds <= 0) return { rx: 0, tx: 0 }
  return { rx: (bytes.rx - prev.rx) / seconds, tx: (bytes.tx - prev.tx) / seconds }
}

async function cpuTemperature(): Promise<number> {
  const direct = readCpuTemperature()
  if (direct !== undefined) return direct
  const temp = await si.cpuTemperature().catch(() => ({ main: -1 }))
  return temp.main ?? -1
}

async function collect(): Promise<MetricsSnapshot> {
  const [load, temp, net] = await Promise.all([cpuLoad(), cpuTemperature(), networkRates()])

  const snap: MetricsSnapshot = {
    t: Date.now(),
    cpu: Math.round(load),
    cpuTemp: Math.round(temp > 0 ? temp : -1),
    memTotal: os.totalmem(),
    memFree: os.freemem(),
    netRxSec: Math.max(0, Math.round(net.rx)),
    netTxSec: Math.max(0, Math.round(net.tx)),
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
