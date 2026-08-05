import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, statSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { MetricDescriptor } from '@nubisco/openbridge-core'
import { DeviceSeries, recordSize, tracksExtremes, safeName, type Tier } from '../timeseries.js'

// Mirrors what the Shelly plugin reports for one phase.
const METRICS: MetricDescriptor[] = [
  { key: 'power', label: 'Power', unit: 'W', kind: 'instant' },
  { key: 'voltage', label: 'Voltage', unit: 'V', kind: 'instant', trackExtremes: false },
  { key: 'totalForwardEnergy', label: 'Energy', unit: 'kWh', kind: 'cumulative' },
]

const TIERS: Tier[] = [
  { name: 'raw', interval: 10, retention: 600 },
  { name: 'minute', interval: 60, retention: 3600 },
  { name: 'hour', interval: 3600, retention: 86400 },
]

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ob-ts-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const series = (metrics = METRICS) => new DeviceSeries(dir, 'shelly-c8c9a33e65d6-p1', metrics, TIERS)

describe('record layout', () => {
  it('sizes a record from the metric set', () => {
    // 4 (ts) + power 3x4 + voltage 1x4 + energy 1x4
    expect(recordSize(METRICS)).toBe(4 + 12 + 4 + 4)
  })

  it('tracks extremes for instant metrics by default and not for cumulative ones', () => {
    expect(tracksExtremes(METRICS[0])).toBe(true)
    expect(tracksExtremes(METRICS[2])).toBe(false)
  })

  it('honours an explicit trackExtremes override', () => {
    // Voltage barely moves; keeping min/max for it wastes width.
    expect(tracksExtremes(METRICS[1])).toBe(false)
  })

  it('sanitises device ids so they cannot escape the history directory', () => {
    expect(safeName('../../etc/passwd')).toBe('.._.._etc_passwd')
    expect(safeName('shelly-c8c9a33e65d6-p1')).toBe('shelly-c8c9a33e65d6-p1')
  })
})

describe('append and query', () => {
  it('round-trips values', () => {
    const s = series()
    s.append({ t: 1000, values: { power: 221.66, voltage: 242.77, totalForwardEnergy: 1152.2775 } })

    const { points } = s.query('power', 0, 2000)
    expect(points).toHaveLength(1)
    expect(points[0].t).toBe(1000)
    expect(points[0].value).toBeCloseTo(221.66, 2)
  })

  it('keeps cumulative energy precise enough to be useful', () => {
    const s = series()
    s.append({ t: 1000, values: { totalForwardEnergy: 1152.2775 } })
    const { points } = s.query('totalForwardEnergy', 0, 2000)
    // float32 holds ~7 significant digits, so kWh survives; raw Wh would not.
    expect(points[0].value).toBeCloseTo(1152.2775, 3)
  })

  it('refuses out-of-order samples so records stay seekable', () => {
    const s = series()
    expect(s.append({ t: 2000, values: { power: 1 } })).toBe(true)
    expect(s.append({ t: 1500, values: { power: 2 } })).toBe(false)
    expect(s.append({ t: 2000, values: { power: 3 } })).toBe(false)
    expect(s.append({ t: 2010, values: { power: 4 } })).toBe(true)

    const { points } = s.query('power', 0, 9999)
    expect(points.map((p) => p.t)).toEqual([2000, 2010])
  })

  it('coerces non-finite values to zero rather than storing NaN', () => {
    const s = series()
    s.append({ t: 1000, values: { power: NaN, voltage: Infinity, totalForwardEnergy: 5 } })
    expect(s.query('power', 0, 2000).points[0].value).toBe(0)
    expect(s.query('voltage', 0, 2000).points[0].value).toBe(0)
  })

  it('returns an empty series for an unknown metric instead of throwing', () => {
    const s = series()
    s.append({ t: 1000, values: { power: 1 } })
    expect(s.query('nonsense', 0, 2000).points).toEqual([])
  })

  it('returns only the requested window', () => {
    const s = series()
    for (let t = 1000; t < 1100; t += 10) s.append({ t, values: { power: t } })

    const { points } = s.query('power', 1030, 1060)
    expect(points.map((p) => p.t)).toEqual([1030, 1040, 1050, 1060])
  })

  it('reads nothing from a device with no history', () => {
    expect(series().query('power', 0, 9999).points).toEqual([])
  })
})

describe('rollup', () => {
  it('averages instant metrics and keeps the last value of cumulative ones', () => {
    const s = series()
    // One full minute of raw samples: power ramps, energy accumulates.
    for (let i = 0; i < 6; i++) {
      s.append({ t: 600 + i * 10, values: { power: 100 + i * 10, voltage: 240, totalForwardEnergy: 50 + i } })
    }
    s.rollup(700)

    const power = s.query('power', 600, 660, 1)
    expect(power.tier.name).not.toBe('raw')
    // mean of 100,110,120,130,140,150
    expect(power.points[0].value).toBeCloseTo(125, 5)

    const energy = s.query('totalForwardEnergy', 600, 660, 1)
    // last value in the window, not the mean — it is a counter
    expect(energy.points[0].value).toBeCloseTo(55, 5)
  })

  it('preserves peaks so a spike is not averaged away', () => {
    const s = series()
    for (let i = 0; i < 6; i++) {
      s.append({ t: 600 + i * 10, values: { power: i === 3 ? 3000 : 100 } })
    }
    s.rollup(700)

    const { points } = s.query('power', 600, 660, 1)
    expect(points[0].max).toBeCloseTo(3000, 1)
    expect(points[0].min).toBeCloseTo(100, 1)
    // The mean alone would hide the spike entirely.
    expect(points[0].value).toBeLessThan(700)
  })

  it('does not roll up a window that has not finished yet', () => {
    const s = series()
    for (let i = 0; i < 3; i++) s.append({ t: 600 + i * 10, values: { power: 100 } })
    const minuteTier = TIERS[1]

    // now is inside the 600-660 window, so it must not be written as complete.
    // Asserted against the minute tier directly: query() would fall back to raw
    // and report the live samples, which says nothing about what was rolled up.
    s.rollup(630)
    expect(s.readTier(minuteTier, 600, 660)[0]).toEqual([])

    s.rollup(700)
    expect(s.readTier(minuteTier, 600, 660)[0]).toHaveLength(1)
  })

  it('is idempotent, so repeated runs do not duplicate records', () => {
    const s = series()
    for (let i = 0; i < 6; i++) s.append({ t: 600 + i * 10, values: { power: 100 } })

    s.rollup(700)
    const first = s.query('power', 0, 9999, 1).points.length
    s.rollup(700)
    s.rollup(700)
    expect(s.query('power', 0, 9999, 1).points.length).toBe(first)
  })
})

describe('retention', () => {
  it('drops records past a tier retention', () => {
    const s = series()
    for (let t = 1000; t <= 2000; t += 10) s.append({ t, values: { power: 1 } })

    // raw retention is 600s, so at now=2000 anything before 1400 goes
    s.prune(2000)
    const { points } = s.query('power', 0, 9999)
    expect(points[0].t).toBeGreaterThanOrEqual(1400)
    expect(points[points.length - 1].t).toBe(2000)
  })

  it('empties a tier whose records have all expired', () => {
    const s = series()
    for (let t = 1000; t < 1100; t += 10) s.append({ t, values: { power: 1 } })
    s.prune(100000)
    expect(s.query('power', 0, 999999).points).toEqual([])
  })

  it('keeps everything when nothing has expired', () => {
    const s = series()
    for (let t = 1000; t < 1100; t += 10) s.append({ t, values: { power: 1 } })
    const before = s.query('power', 0, 9999).points.length
    s.prune(1100)
    expect(s.query('power', 0, 9999).points.length).toBe(before)
  })
})

describe('tier selection', () => {
  it('uses the finest tier for a short range', () => {
    expect(series().chooseTier(0, 300).name).toBe('raw')
  })

  it('steps up to a coarser tier rather than returning thousands of points', () => {
    const s = series()
    // 3000s at 10s resolution is 300 points; capped at 50 it must coarsen
    expect(s.chooseTier(0, 3000, 50).name).not.toBe('raw')
  })

  it('falls back to the coarsest tier for a range beyond all retentions', () => {
    expect(series().chooseTier(0, 10 * 365 * 86400).name).toBe('hour')
  })
})

describe('layout changes', () => {
  it('rotates existing data aside when the metric set changes', () => {
    const s = series()
    s.append({ t: 1000, values: { power: 100 } })
    expect(s.query('power', 0, 9999).points).toHaveLength(1)

    // A plugin release that adds a metric changes the record width, making
    // every existing record unreadable at the new offsets.
    const changed = new DeviceSeries(
      dir,
      'shelly-c8c9a33e65d6-p1',
      [...METRICS, { key: 'current', label: 'Current', unit: 'A', kind: 'instant' }],
      TIERS,
    )
    changed.ensureLayout()

    // Old data is set aside, not reinterpreted as garbage.
    expect(changed.query('power', 0, 9999).points).toEqual([])
    expect(readdirSync(dir).some((f) => f.endsWith('.old'))).toBe(true)
  })

  it('leaves data alone when the metric set is unchanged', () => {
    const s = series()
    s.append({ t: 1000, values: { power: 100 } })
    series().ensureLayout()
    expect(series().query('power', 0, 9999).points).toHaveLength(1)
  })
})

describe('storage cost', () => {
  it('holds a full day of 10-second samples in a few hundred kilobytes', () => {
    const s = series()
    for (let i = 0; i < 8640; i++) {
      s.append({ t: 100000 + i * 10, values: { power: 400, voltage: 242, totalForwardEnergy: 1000 + i * 0.01 } })
    }
    const bytes = s.diskUsage()
    // 8640 records x 24 bytes
    expect(bytes).toBeLessThan(300 * 1024)
    expect(bytes).toBeGreaterThan(0)
    expect(existsSync(join(dir, 'shelly-c8c9a33e65d6-p1.raw.bin'))).toBe(true)
    expect(statSync(join(dir, 'shelly-c8c9a33e65d6-p1.raw.bin')).size % recordSize(METRICS)).toBe(0)
  })
})
