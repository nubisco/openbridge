import { existsSync, mkdirSync, openSync, readSync, closeSync, statSync, appendFileSync, writeFileSync } from 'fs'
import { readFileSync, renameSync } from 'fs'
import { join } from 'path'
import type { MetricDescriptor } from '@nubisco/openbridge-core'

/**
 * Tiered time-series store for device metrics.
 *
 * Records are fixed-width and append-only. The previous format kept one JSON
 * array per device, rewritten in full on every sample: at two years of
 * five-minute samples that is 9.8 MB, 40 ms per sample tick and 39 ms per
 * query, for a single metric. Fixed-width binary records make a tick an append
 * (~0.02 ms) and a range query a seek plus one read (~0.2 ms), while holding
 * every metric for a timestamp in 28 bytes rather than 48.7 for one.
 *
 * Layout, per tier file:
 *
 *   offset 0   uint32   unix seconds
 *   offset 4   float32  metric 0 value
 *   offset 8   float32  metric 0 min      (only when the metric tracks extremes)
 *   offset 12  float32  metric 0 max      (only when the metric tracks extremes)
 *   ...
 *
 * float32 carries ~7 significant digits, which is ample for volts, amps and
 * watts. Cumulative energy is stored in kWh rather than Wh for the same reason:
 * a raw meter reading of 2,376,037 Wh is past float32's exact integer range.
 */

export interface Tier {
  /** File suffix, e.g. "raw" */
  name: string
  /** Seconds covered by one record */
  interval: number
  /** How many seconds of history this tier keeps */
  retention: number
}

/**
 * Default tiers: fine detail recently, coarse detail for a long time.
 *
 * Roughly 6.4 MB per device for six metrics over five years, against 9.8 MB for
 * one metric over two years in the format this replaces.
 */
export const DEFAULT_TIERS: Tier[] = [
  { name: 'raw', interval: 10, retention: 48 * 3600 },
  { name: 'minute', interval: 60, retention: 30 * 86400 },
  { name: 'fiveminute', interval: 300, retention: 365 * 86400 },
  { name: 'hour', interval: 3600, retention: 5 * 365 * 86400 },
]

const TS_BYTES = 4
const VALUE_BYTES = 4

/** True when this metric keeps min/max alongside the mean in rolled-up tiers. */
export function tracksExtremes(metric: MetricDescriptor): boolean {
  if (metric.trackExtremes !== undefined) return metric.trackExtremes
  return metric.kind === 'instant'
}

/** Byte width of one record for the given metric set. */
export function recordSize(metrics: MetricDescriptor[]): number {
  return TS_BYTES + metrics.reduce((sum, m) => sum + VALUE_BYTES * (tracksExtremes(m) ? 3 : 1), 0)
}

/** Byte offset of a metric's value within a record. */
function metricOffset(metrics: MetricDescriptor[], index: number): number {
  let offset = TS_BYTES
  for (let i = 0; i < index; i++) offset += VALUE_BYTES * (tracksExtremes(metrics[i]) ? 3 : 1)
  return offset
}

export interface Sample {
  /** Unix seconds */
  t: number
  /** Keyed by metric key */
  values: Record<string, number>
}

export interface Point {
  t: number
  value: number | null
  min?: number | null
  max?: number | null
}

/**
 * A device's history: one file per tier, all sharing the same metric layout.
 *
 * The layout is derived from the device's declared metrics. If a plugin changes
 * its metric set between releases the record width changes with it, so the
 * layout is written alongside the data and mismatched files are rotated out
 * rather than silently misread.
 */
export class DeviceSeries {
  private readonly recSize: number

  constructor(
    private readonly dir: string,
    readonly deviceId: string,
    readonly metrics: MetricDescriptor[],
    private readonly tiers: Tier[] = DEFAULT_TIERS,
  ) {
    this.recSize = recordSize(metrics)
  }

  private tierPath(tier: Tier): string {
    return join(this.dir, `${safeName(this.deviceId)}.${tier.name}.bin`)
  }

  private layoutPath(): string {
    return join(this.dir, `${safeName(this.deviceId)}.layout.json`)
  }

  /**
   * Ensure the on-disk layout matches the current metric set.
   *
   * A changed metric set makes every existing record unreadable, since the
   * record width and field order both shift. Rotating the files aside loses
   * history but never returns wrong numbers, which is the right trade for
   * measurements people make decisions from.
   */
  ensureLayout(): void {
    mkdirSync(this.dir, { recursive: true })
    const layout = {
      recordSize: this.recSize,
      metrics: this.metrics.map((m) => ({ key: m.key, extremes: tracksExtremes(m) })),
    }
    const path = this.layoutPath()

    if (existsSync(path)) {
      try {
        const existing = JSON.parse(readFileSync(path, 'utf8'))
        if (JSON.stringify(existing) === JSON.stringify(layout)) return
      } catch {
        /* unreadable layout — treat as a mismatch */
      }
      const stamp = Math.floor(nowSeconds())
      for (const tier of this.tiers) {
        const file = this.tierPath(tier)
        if (existsSync(file)) renameSync(file, `${file}.${stamp}.old`)
      }
    }

    writeFileSync(path, JSON.stringify(layout))
  }

  /** Encode one sample into a record buffer. */
  private encode(sample: Sample, extremes?: Record<string, { min: number; max: number }>): Buffer {
    const buf = Buffer.alloc(this.recSize)
    buf.writeUInt32LE(sample.t >>> 0, 0)
    this.metrics.forEach((metric, index) => {
      const offset = metricOffset(this.metrics, index)
      const value = numeric(sample.values[metric.key])
      buf.writeFloatLE(value, offset)
      if (tracksExtremes(metric)) {
        const ext = extremes?.[metric.key]
        buf.writeFloatLE(ext ? numeric(ext.min) : value, offset + 4)
        buf.writeFloatLE(ext ? numeric(ext.max) : value, offset + 8)
      }
    })
    return buf
  }

  /**
   * Append a sample to the finest tier.
   *
   * Records must stay time-ordered for range reads to work, so a sample that is
   * not newer than the last one is dropped rather than appended out of order.
   */
  append(sample: Sample): boolean {
    this.ensureLayout()
    const tier = this.tiers[0]
    const path = this.tierPath(tier)

    const last = this.lastTimestamp(path)
    if (last !== null && sample.t <= last) return false

    appendFileSync(path, this.encode(sample))
    return true
  }

  private lastTimestamp(path: string): number | null {
    if (!existsSync(path)) return null
    const size = statSync(path).size
    if (size < this.recSize) return null
    const fd = openSync(path, 'r')
    try {
      const buf = Buffer.alloc(TS_BYTES)
      readSync(fd, buf, 0, TS_BYTES, size - this.recSize)
      return buf.readUInt32LE(0)
    } finally {
      closeSync(fd)
    }
  }

  /** Read every record in a tier whose timestamp falls within [from, to]. */
  readTier(tier: Tier, from: number, to: number): Point[][] {
    const path = this.tierPath(tier)
    const result: Point[][] = this.metrics.map(() => [])
    if (!existsSync(path)) return result

    const size = statSync(path).size
    const count = Math.floor(size / this.recSize)
    if (count === 0) return result

    const fd = openSync(path, 'r')
    try {
      // Records are time-ordered and fixed-width, so the range is found by
      // binary search rather than by scanning the file.
      const startIndex = this.seek(fd, count, from)
      if (startIndex >= count) return result

      const span = count - startIndex
      const buf = Buffer.alloc(span * this.recSize)
      readSync(fd, buf, 0, buf.length, startIndex * this.recSize)

      for (let i = 0; i < span; i++) {
        const base = i * this.recSize
        const t = buf.readUInt32LE(base)
        if (t < from) continue
        if (t > to) break
        this.metrics.forEach((metric, index) => {
          const offset = base + metricOffset(this.metrics, index)
          const point: Point = { t, value: buf.readFloatLE(offset) }
          if (tracksExtremes(metric)) {
            point.min = buf.readFloatLE(offset + 4)
            point.max = buf.readFloatLE(offset + 8)
          }
          result[index].push(point)
        })
      }
      return result
    } finally {
      closeSync(fd)
    }
  }

  /** Index of the first record at or after `from`. */
  private seek(fd: number, count: number, from: number): number {
    const buf = Buffer.alloc(TS_BYTES)
    let lo = 0
    let hi = count
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      readSync(fd, buf, 0, TS_BYTES, mid * this.recSize)
      if (buf.readUInt32LE(0) < from) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /**
   * Pick the finest tier that covers the requested range without returning an
   * unreasonable number of points to draw.
   */
  chooseTier(from: number, to: number, maxPoints = 720): Tier {
    const span = Math.max(1, to - from)
    for (const tier of this.tiers) {
      const covers = span <= tier.retention
      const points = span / tier.interval
      if (covers && points <= maxPoints) return tier
    }
    return this.tiers[this.tiers.length - 1]
  }

  /**
   * Read one metric over a range, choosing the tier automatically.
   *
   * The chosen tier can legitimately be empty: rollup only populates coarser
   * tiers once windows complete, so a device installed ten minutes ago has raw
   * data and nothing else. Falling back to finer tiers means the chart shows
   * what exists instead of nothing. If a fallback tier holds more points than
   * the caller can draw, it is decimated by striding rather than truncated, so
   * the shape of the range is preserved.
   */
  query(metricKey: string, from: number, to: number, maxPoints = 720): { tier: Tier; points: Point[] } {
    const index = this.metrics.findIndex((m) => m.key === metricKey)
    const chosen = this.chooseTier(from, to, maxPoints)
    if (index === -1) return { tier: chosen, points: [] }

    const start = this.tiers.indexOf(chosen)
    for (let i = start; i >= 0; i--) {
      const tier = this.tiers[i]
      const points = this.readTier(tier, from, to)[index]
      if (points.length > 0) return { tier, points: decimate(points, maxPoints) }
    }
    return { tier: chosen, points: [] }
  }

  /**
   * Roll finished windows from each tier into the next coarser one, then drop
   * records past the tier's retention.
   *
   * Only windows that have fully elapsed are rolled up, so a partially filled
   * bucket is never written as if it were complete.
   */
  rollup(now = nowSeconds()): void {
    for (let i = 0; i < this.tiers.length - 1; i++) {
      const source = this.tiers[i]
      const target = this.tiers[i + 1]

      const targetPath = this.tierPath(target)
      const lastTarget = this.lastTimestamp(targetPath)
      const windowStart = lastTarget === null ? 0 : lastTarget + target.interval
      const lastCompleteWindow = Math.floor(now / target.interval) * target.interval

      if (windowStart >= lastCompleteWindow) continue

      const series = this.readTier(source, windowStart, lastCompleteWindow - 1)
      if (series.every((points) => points.length === 0)) continue

      // Group source points by target window.
      const windows = new Map<number, Array<Point[]>>()
      series.forEach((points, metricIndex) => {
        for (const point of points) {
          const bucket = Math.floor(point.t / target.interval) * target.interval
          if (bucket >= lastCompleteWindow) continue
          if (!windows.has(bucket)) windows.set(bucket, this.metrics.map(() => []))
          windows.get(bucket)![metricIndex].push(point)
        }
      })

      const buckets = [...windows.keys()].sort((a, b) => a - b)
      for (const bucket of buckets) {
        const grouped = windows.get(bucket)!
        const values: Record<string, number> = {}
        const extremes: Record<string, { min: number; max: number }> = {}

        this.metrics.forEach((metric, index) => {
          const points = grouped[index].filter((p) => p.value !== null && Number.isFinite(p.value))
          if (points.length === 0) return

          if (metric.kind === 'cumulative') {
            // A counter's value for a window is where it ended up.
            values[metric.key] = points[points.length - 1].value as number
          } else {
            const sum = points.reduce((acc, p) => acc + (p.value as number), 0)
            values[metric.key] = sum / points.length
          }

          if (tracksExtremes(metric)) {
            const mins = points.map((p) => (p.min ?? p.value) as number)
            const maxes = points.map((p) => (p.max ?? p.value) as number)
            extremes[metric.key] = { min: Math.min(...mins), max: Math.max(...maxes) }
          }
        })

        appendFileSync(targetPath, this.encode({ t: bucket, values }, extremes))
      }
    }

    this.prune(now)
  }

  /**
   * Drop records older than each tier's retention.
   *
   * Records are time-ordered, so trimming is a copy of the surviving tail
   * rather than a filter of the whole file.
   */
  prune(now = nowSeconds()): void {
    for (const tier of this.tiers) {
      const path = this.tierPath(tier)
      if (!existsSync(path)) continue
      const cutoff = now - tier.retention
      const size = statSync(path).size
      const count = Math.floor(size / this.recSize)
      if (count === 0) continue

      const fd = openSync(path, 'r')
      let keepFrom: number
      try {
        keepFrom = this.seek(fd, count, cutoff)
      } finally {
        closeSync(fd)
      }
      if (keepFrom === 0) continue

      if (keepFrom >= count) {
        writeFileSync(path, Buffer.alloc(0))
        continue
      }

      const fdRead = openSync(path, 'r')
      try {
        const span = count - keepFrom
        const buf = Buffer.alloc(span * this.recSize)
        readSync(fdRead, buf, 0, buf.length, keepFrom * this.recSize)
        writeFileSync(path, buf)
      } finally {
        closeSync(fdRead)
      }
    }
  }

  /** Total bytes on disk across all tiers. */
  diskUsage(): number {
    return this.tiers.reduce((sum, tier) => {
      const path = this.tierPath(tier)
      return sum + (existsSync(path) ? statSync(path).size : 0)
    }, 0)
  }
}

/**
 * Reduce a series to at most `maxPoints` by striding.
 *
 * The last point is always kept: on a live chart the newest reading is the one
 * people look at, and dropping it makes the line appear to lag.
 */
function decimate(points: Point[], maxPoints: number): Point[] {
  if (points.length <= maxPoints || maxPoints <= 0) return points
  const stride = Math.ceil(points.length / maxPoints)
  const out: Point[] = []
  for (let i = 0; i < points.length; i += stride) out.push(points[i])
  const last = points[points.length - 1]
  if (out[out.length - 1] !== last) out.push(last)
  return out
}

function numeric(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

/** Device ids come from plugins, so they must not be trusted as path segments. */
export function safeName(deviceId: string): string {
  return deviceId.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}
