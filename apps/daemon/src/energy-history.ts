import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
  writeSync,
} from 'fs'

export interface EnergySample {
  t: string
  e: number
}

export interface EnergyBuckets {
  period: string
  date: string
  buckets: Array<{ label: string; kwh: number | null }>
  totalKwh?: number
}

/** Two years of samples, the history the energy chart can show. */
export const ENERGY_RETENTION_MS = 2 * 365 * 24 * 60 * 60 * 1000

/**
 * Old samples are pruned only once the oldest is a day past the retention.
 * Pruning rewrites the whole file, so doing it on every sample would make
 * every 5-minute write a full rewrite once the history is full.
 */
const PRUNE_SLACK_MS = 24 * 60 * 60 * 1000

/**
 * Records one sample. The file stays a JSON array, and the sample is written
 * over its closing bracket, so a write costs the same whatever the history's
 * size. The whole file is read only when it is time to prune it, or when it
 * does not end the way this writer leaves it.
 */
export function appendEnergySample(filePath: string, sample: EnergySample, now = Date.now()): void {
  if (!existsSync(filePath)) {
    writeFileSync(filePath, JSON.stringify([sample]))
    return
  }
  if (needsPrune(filePath, now) || !appendInPlace(filePath, sample)) rewrite(filePath, sample, now)
}

function appendInPlace(filePath: string, sample: EnergySample): boolean {
  const fd = openSync(filePath, 'r+')
  try {
    const size = fstatSync(fd).size
    if (size < 2) return false
    const tail = Buffer.alloc(2)
    readSync(fd, tail, 0, 2, size - 2)
    if (tail[1] !== 0x5d /* ] */) return false
    const empty = tail[0] === 0x5b /* [ */ && size === 2
    const piece = Buffer.from(`${empty ? '' : ','}${JSON.stringify(sample)}]`)
    writeSync(fd, piece, 0, piece.length, size - 1)
    return true
  } finally {
    closeSync(fd)
  }
}

/** Reads only the start of the file, where the oldest sample is. */
function needsPrune(filePath: string, now: number): boolean {
  const fd = openSync(filePath, 'r')
  try {
    const head = Buffer.alloc(64)
    const n = readSync(fd, head, 0, 64, 0)
    const first = /^\[\{"t":"([^"]+)"/.exec(head.subarray(0, n).toString('utf8'))
    if (!first) return false
    return first[1] < new Date(now - ENERGY_RETENTION_MS - PRUNE_SLACK_MS).toISOString()
  } finally {
    closeSync(fd)
  }
}

function rewrite(filePath: string, sample: EnergySample, now: number): void {
  let samples: EnergySample[]
  try {
    samples = JSON.parse(readFileSync(filePath, 'utf8'))
    if (!Array.isArray(samples)) throw new Error('not an array')
  } catch {
    // Keep a history that cannot be read rather than writing over it.
    renameSync(filePath, `${filePath}.unreadable-${now}`)
    samples = []
  }
  samples.push(sample)
  const cutoff = new Date(now - ENERGY_RETENTION_MS).toISOString()
  writeFileSync(filePath, JSON.stringify(samples.filter((s) => s.t >= cutoff)))
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * The energy used in each hour of a day, day of a month or month of a year:
 * the last reading in the window minus the first. Each window's bounds are
 * worked out once, then found by binary search.
 */
export function energyBuckets(samples: EnergySample[], period: string, date?: string): EnergyBuckets {
  const ref = date ? new Date(date) : new Date()
  // Samples are recorded in time order, so a window is one contiguous run that
  // two binary searches find. A file that is out of order is filtered instead.
  const sorted = samples.every((s, i) => i === 0 || samples[i - 1].t <= s.t)
  const firstIndex = (past: (t: string) => boolean): number => {
    let lo = 0
    let hi = samples.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (past(samples[mid].t)) hi = mid
      else lo = mid + 1
    }
    return lo
  }
  const used = (from: string, to: string, inclusive: boolean): number | null => {
    let first: EnergySample | undefined
    let last: EnergySample | undefined
    let count: number
    if (sorted) {
      const lo = firstIndex((t) => t >= from)
      const hi = firstIndex((t) => (inclusive ? t > to : t >= to))
      count = hi - lo
      first = samples[lo]
      last = samples[hi - 1]
    } else {
      const inWindow = samples.filter((s) => s.t >= from && (inclusive ? s.t <= to : s.t < to))
      count = inWindow.length
      first = inWindow[0]
      last = inWindow[inWindow.length - 1]
    }
    if (count < 2 || !first || !last) return null
    const kwh = last.e - first.e
    return Math.max(0, Math.round(kwh * 100) / 100)
  }
  const total = (buckets: Array<{ kwh: number | null }>) =>
    Math.round(buckets.reduce((sum, b) => sum + (b.kwh ?? 0), 0) * 100) / 100

  if (period === 'day') {
    const dayStr = ref.toISOString().slice(0, 10)
    const buckets = Array.from({ length: 24 }, (_, h) => {
      const label = `${String(h).padStart(2, '0')}:00`
      const start = new Date(`${dayStr}T${String(h).padStart(2, '0')}:00:00Z`)
      const end = new Date(
        `${dayStr}T${String(h + 1).padStart(2, '0') === '24' ? '23:59:59' : String(h + 1).padStart(2, '0') + ':00:00'}Z`,
      )
      return { label, kwh: used(start.toISOString(), end.toISOString(), false) }
    })
    return { period, date: dayStr, buckets, totalKwh: total(buckets) }
  }

  if (period === 'month') {
    const year = ref.getFullYear()
    const month = ref.getMonth()
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const monthStr = `${year}-${String(month + 1).padStart(2, '0')}`
    const buckets = Array.from({ length: daysInMonth }, (_, d) => {
      const dayStr = `${monthStr}-${String(d + 1).padStart(2, '0')}`
      const start = new Date(`${dayStr}T00:00:00Z`)
      const end = new Date(`${dayStr}T23:59:59Z`)
      return { label: String(d + 1), kwh: used(start.toISOString(), end.toISOString(), true) }
    })
    return { period, date: monthStr, buckets, totalKwh: total(buckets) }
  }

  const year = ref.getFullYear()
  const buckets = Array.from({ length: 12 }, (_, m) => {
    const monthStr = `${year}-${String(m + 1).padStart(2, '0')}`
    const start = new Date(`${monthStr}-01T00:00:00Z`)
    const end = new Date(year, m + 1, 0, 23, 59, 59)
    return { label: MONTHS[m], kwh: used(start.toISOString(), end.toISOString(), true) }
  })
  return { period, date: String(year), buckets, totalKwh: total(buckets) }
}
