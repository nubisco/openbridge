import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { appendEnergySample, energyBuckets, ENERGY_RETENTION_MS, type EnergySample } from '../energy-history.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

function file(content?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ob-energy-'))
  dirs.push(dir)
  const path = join(dir, 'meter.json')
  if (content !== undefined) writeFileSync(path, content)
  return path
}

const DAY = 24 * 60 * 60 * 1000
const at = (ms: number) => new Date(ms).toISOString()

describe('appendEnergySample', () => {
  it('starts a file that does not exist yet', () => {
    const path = file()
    appendEnergySample(path, { t: at(0), e: 1 })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual([{ t: at(0), e: 1 }])
  })

  it('adds to an empty array and to a full one, leaving valid JSON', () => {
    const now = Date.parse('2026-11-18T10:00:00Z')
    const path = file('[]')
    appendEnergySample(path, { t: at(now), e: 1 }, now)
    appendEnergySample(path, { t: at(now + 300_000), e: 1.5 }, now + 300_000)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual([
      { t: at(now), e: 1 },
      { t: at(now + 300_000), e: 1.5 },
    ])
  })

  it('does not rewrite the file until the oldest sample is a day past the retention', () => {
    const now = Date.parse('2026-11-18T10:00:00Z')
    const justExpired = { t: at(now - ENERGY_RETENTION_MS - 1000), e: 1 }
    const path = file(JSON.stringify([justExpired, { t: at(now - DAY), e: 2 }]))
    appendEnergySample(path, { t: at(now), e: 3 }, now)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveLength(3)

    const later = now + 2 * DAY
    appendEnergySample(path, { t: at(later), e: 4 }, later)
    expect(JSON.parse(readFileSync(path, 'utf8')).map((s: EnergySample) => s.e)).toEqual([2, 3, 4])
  })

  it('moves a history it cannot read aside instead of writing over it', () => {
    const path = file('[{"t":"2026-11-18T10:00:00.000Z","e":1},{"t":')
    const now = Date.parse('2026-11-18T10:05:00Z')
    appendEnergySample(path, { t: at(now), e: 9 }, now)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual([{ t: at(now), e: 9 }])
    const kept = readdirSync(join(path, '..')).filter((n) => n.includes('.unreadable-'))
    expect(kept).toHaveLength(1)
    expect(existsSync(join(path, '..', kept[0]))).toBe(true)
  })
})

/** The route as it was before the bounds were worked out once per window. */
function previousBuckets(samples: EnergySample[], period: string, date?: string) {
  const ref = date ? new Date(date) : new Date()
  if (period === 'day') {
    const dayStr = ref.toISOString().slice(0, 10)
    const buckets = Array.from({ length: 24 }, (_, h) => {
      const label = `${String(h).padStart(2, '0')}:00`
      const start = new Date(`${dayStr}T${String(h).padStart(2, '0')}:00:00Z`)
      const end = new Date(
        `${dayStr}T${String(h + 1).padStart(2, '0') === '24' ? '23:59:59' : String(h + 1).padStart(2, '0') + ':00:00'}Z`,
      )
      const inWindow = samples.filter((s) => s.t >= start.toISOString() && s.t < end.toISOString())
      if (inWindow.length < 2) return { label, kwh: null }
      const kwh = inWindow[inWindow.length - 1].e - inWindow[0].e
      return { label, kwh: Math.max(0, Math.round(kwh * 100) / 100) }
    })
    const totalKwh = buckets.reduce((sum, b) => sum + (b.kwh ?? 0), 0)
    return { period, date: dayStr, buckets, totalKwh: Math.round(totalKwh * 100) / 100 }
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
      const inWindow = samples.filter((s) => s.t >= start.toISOString() && s.t <= end.toISOString())
      if (inWindow.length < 2) return { label: String(d + 1), kwh: null }
      const kwh = inWindow[inWindow.length - 1].e - inWindow[0].e
      return { label: String(d + 1), kwh: Math.max(0, Math.round(kwh * 100) / 100) }
    })
    const totalKwh = buckets.reduce((sum, b) => sum + (b.kwh ?? 0), 0)
    return { period, date: monthStr, buckets, totalKwh: Math.round(totalKwh * 100) / 100 }
  }
  const year = ref.getFullYear()
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const buckets = Array.from({ length: 12 }, (_, m) => {
    const monthStr = `${year}-${String(m + 1).padStart(2, '0')}`
    const start = new Date(`${monthStr}-01T00:00:00Z`)
    const end = new Date(year, m + 1, 0, 23, 59, 59)
    const inWindow = samples.filter((s) => s.t >= start.toISOString() && s.t <= end.toISOString())
    if (inWindow.length < 2) return { label: names[m], kwh: null }
    const kwh = inWindow[inWindow.length - 1].e - inWindow[0].e
    return { label: names[m], kwh: Math.max(0, Math.round(kwh * 100) / 100) }
  })
  const totalKwh = buckets.reduce((sum, b) => sum + (b.kwh ?? 0), 0)
  return { period, date: String(year), buckets, totalKwh: Math.round(totalKwh * 100) / 100 }
}

describe('energyBuckets', () => {
  // Every 15 minutes for 400 days, with a gap and readings on the window edges.
  const start = Date.parse('2025-10-01T00:00:00Z')
  const samples: EnergySample[] = []
  let e = 100
  for (let t = start; t < start + 400 * DAY; t += 900_000) {
    if (t > start + 50 * DAY && t < start + 53 * DAY) continue
    e += ((t / 900_000) % 7) * 0.013
    samples.push({ t: at(t), e: Math.round(e * 1000) / 1000 })
  }
  samples.push({ t: '2026-03-14T23:59:59.500Z', e: e + 1 })
  samples.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0))

  const cases: Array<[string, string | undefined]> = [
    ['day', '2026-03-14'],
    ['day', '2025-11-21'],
    ['day', '2027-01-01'],
    ['month', '2026-03-14'],
    ['month', '2025-11-02'],
    ['year', '2026-06-01'],
    ['year', '2025-02-01'],
  ]
  it.each(cases)('gives the same %s view for %s as the route did before', (period, date) => {
    expect(energyBuckets(samples, period, date)).toEqual(previousBuckets(samples, period, date))
  })

  it.each(cases)('gives the same %s view for %s from a file out of order', (period, date) => {
    const shuffled = [...samples]
    expect(samples.every((x, i) => i === 0 || samples[i - 1].t <= x.t)).toBe(true)
    for (let i = 0; i < shuffled.length; i += 97) {
      const j = (i * 31) % shuffled.length
      ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }
    expect(energyBuckets(shuffled, period, date)).toEqual(previousBuckets(shuffled, period, date))
  })
})
