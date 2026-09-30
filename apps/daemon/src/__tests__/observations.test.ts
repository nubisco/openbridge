import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ObservationStore, validateObservation, type DeviceObservation } from '../observations.js'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ob-obs-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function obs(over: Partial<DeviceObservation> = {}): DeviceObservation {
  return { at: new Date().toISOString(), roomTemperature: 21, comfort: 'ok', ...over }
}

describe('ObservationStore', () => {
  it('returns nothing for a device that has never been reported on', () => {
    expect(new ObservationStore(home).list('heating')).toEqual([])
    expect(new ObservationStore(home).count('heating')).toBe(0)
  })

  it('stores and returns an observation with its context', () => {
    const store = new ObservationStore(home)
    store.append('heating', obs({ roomTemperature: 19, comfort: 'cold', context: { outside: 8, flow: 40 } }))

    const [first] = store.list('heating')
    expect(first!.roomTemperature).toBe(19)
    expect(first!.comfort).toBe('cold')
    expect(first!.context).toEqual({ outside: 8, flow: 40 })
  })

  it('returns newest first', () => {
    const store = new ObservationStore(home)
    store.append('heating', obs({ roomTemperature: 1 }))
    store.append('heating', obs({ roomTemperature: 2 }))
    store.append('heating', obs({ roomTemperature: 3 }))

    expect(store.list('heating').map((o) => o.roomTemperature)).toEqual([3, 2, 1])
  })

  it('keeps devices apart', () => {
    const store = new ObservationStore(home)
    store.append('heating', obs({ roomTemperature: 19 }))
    store.append('pool', obs({ roomTemperature: 28 }))

    expect(store.list('heating')).toHaveLength(1)
    expect(store.list('pool')[0]!.roomTemperature).toBe(28)
  })

  it('survives a torn line rather than losing the whole history', () => {
    // A power cut mid-append leaves half a line. One bad record must not take
    // a season of calibration data with it.
    const store = new ObservationStore(home)
    store.append('heating', obs({ roomTemperature: 19 }))
    mkdirSync(join(home, 'observations'), { recursive: true })
    const file = join(home, 'observations', 'heating.jsonl')
    writeFileSync(file, readFileSync(file, 'utf8') + '{"at":"2026-01-01","roomTem\n', 'utf8')
    store.append('heating', obs({ roomTemperature: 21 }))

    expect(store.list('heating').map((o) => o.roomTemperature)).toEqual([21, 19])
  })

  it('caps how many it returns', () => {
    const store = new ObservationStore(home)
    for (let i = 0; i < 20; i++) store.append('heating', obs({ roomTemperature: i }))
    expect(store.list('heating', 5)).toHaveLength(5)
  })

  it('cannot be made to write outside its directory by a hostile device id', () => {
    // Device ids come from plugins and reach the filesystem here. Separators are
    // replaced, so a traversal becomes one flat filename inside observations/
    // rather than a write up the tree.
    const store = new ObservationStore(home)
    store.append('../../escape', obs())

    const written = readdirSync(join(home, 'observations'))
    expect(written).toHaveLength(1)
    expect(written[0]).not.toContain('/')
    expect(store.count('../../escape')).toBe(1)
    // Nothing landed beside the home directory, which is where a traversal
    // would have put it.
    expect(readdirSync(home)).toEqual(['observations'])
  })
})

describe('validateObservation', () => {
  it('accepts a well-formed report and stamps its own time', () => {
    const r = validateObservation({ roomTemperature: 21.5, comfort: 'ok' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.roomTemperature).toBe(21.5)
    // Stamped here so a client's clock cannot disagree with the rest of the data.
    expect(Date.parse(r.value.at)).toBeGreaterThan(0)
  })

  it('rejects a missing or non-numeric temperature', () => {
    expect(validateObservation({ comfort: 'ok' }).ok).toBe(false)
    expect(validateObservation({ roomTemperature: 'warm', comfort: 'ok' }).ok).toBe(false)
  })

  it('rejects a temperature outside any plausible room', () => {
    // A sanity bound against a typo or a Fahrenheit reading, not an opinion
    // about comfort: one bad sample skews a curve fitted from very few.
    expect(validateObservation({ roomTemperature: 72, comfort: 'ok' }).ok).toBe(false)
    expect(validateObservation({ roomTemperature: -40, comfort: 'ok' }).ok).toBe(false)
  })

  it('requires a comfort verdict', () => {
    expect(validateObservation({ roomTemperature: 21 }).ok).toBe(false)
    expect(validateObservation({ roomTemperature: 21, comfort: 'chilly' }).ok).toBe(false)
  })

  it('keeps a note but bounds its length', () => {
    const r = validateObservation({ roomTemperature: 21, comfort: 'ok', note: 'x'.repeat(900) })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.note).toHaveLength(500)
  })

  it('omits an absent note rather than storing an empty one', () => {
    const r = validateObservation({ roomTemperature: 21, comfort: 'ok' })
    expect(r.ok && 'note' in r.value).toBe(false)
  })

  it('rejects a non-object body', () => {
    expect(validateObservation(null).ok).toBe(false)
    expect(validateObservation('21').ok).toBe(false)
  })
})
