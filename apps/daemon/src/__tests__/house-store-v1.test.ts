import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fromV1, toV1 } from '@nubisco/bim/convert'
import type { Plan, Window } from '@nubisco/bim/v2'
import { HouseStore, type HousePlan } from '../house.js'

// The plan model itself (conversion, validation, IFC) is @nubisco/bim and is
// tested there. What stays here is OpenBridge's own: the file HouseStore keeps.

/** A small house that uses everything version 1 can say. */
function v1(): HousePlan {
  return {
    version: 1,
    grid: 0.5,
    plot: { w: 30, h: 20 },
    floors: [
      {
        id: 'g',
        name: 'Ground floor',
        level: 0,
        rooms: [
          { id: 'garden', name: 'Garden', kind: 'outdoor', x: 0, y: 0, w: 30, h: 20 },
          // An L: the main rectangle and a wing below its left half.
          { id: 'living', name: 'Living', kind: 'room', x: 2, y: 2, w: 10, h: 6, parts: [{ x: 2, y: 8, w: 4, h: 4 }] },
          { id: 'kitchen', name: 'Kitchen', kind: 'room', x: 12, y: 2, w: 6, h: 6 },
          // A room drawn inside another.
          { id: 'pantry', name: 'Pantry', kind: 'room', x: 15, y: 5, w: 3, h: 3 },
          { id: 'pool', name: 'Pool', kind: 'pool', x: 20, y: 10, w: 6, h: 4 },
        ],
        openings: [
          { id: 'win', type: 'window', axis: 'h', x: 4, y: 2, len: 2 },
          { id: 'slide', type: 'slider', axis: 'v', x: 2, y: 3.5, len: 2 },
          { id: 'gd', type: 'door', axis: 'h', x: 7, y: 8, len: 1, glass: true, hinge: 'end', opens: 'down' },
          { id: 'wood', type: 'door', axis: 'v', x: 12, y: 3, len: 1, opens: 'left' },
          { id: 'gap', type: 'open', axis: 'v', x: 12, y: 6, len: 1.5 },
        ],
        placements: [
          { ref: 'device:lamp', x: 6.5, y: 5, color: '#ffb45e', mount: 'ceiling' },
          { ref: 'device:shutter', x: 5, y: 2, opening: 'win' },
          { ref: 'device:pump', x: 22, y: 9, circuitRooms: ['living', 'bed'] },
          { ref: 'device:gate', x: 15, y: 20, length: 6, axis: 'h' },
        ],
        radiators: [{ id: 'rad', x: 12, y: 2.5, axis: 'v', len: 1.5, side: 'right' }],
        furniture: [{ id: 'sofa', kind: 'sofa', x: 3, y: 3, w: 4, d: 1.5, height: 0.85, back: 'up' }],
      },
      {
        id: 'f1',
        name: 'First floor',
        level: 1,
        rooms: [{ id: 'bed', name: 'Bedroom', kind: 'room', x: 2, y: 2, w: 8, h: 8 }],
        openings: [],
        placements: [{ ref: 'accessory:AB-CD', x: 4, y: 4 }],
      },
    ],
  }
}
const opening = <T>(p: Plan, id: string) => p.storeys.flatMap((s) => s.openings).find((o) => o.id === id) as T

describe('HouseStore with a version 1 file', () => {
  let dir: string
  let path: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ob-house-v2-'))
    path = join(dir, 'house.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('converts it on load, keeps the old file once, and keeps rooms of devices', () => {
    writeFileSync(path, JSON.stringify({ plan: v1(), rev: 7, updatedAt: '2026-11-01T00:00:00.000Z' }))
    const store = new HouseStore(path)
    expect(store.get().rev).toBe(7)
    expect(store.get().plan?.version).toBe(2)
    expect(JSON.parse(readFileSync(path, 'utf8')).plan.version).toBe(2)
    expect(JSON.parse(readFileSync(`${path}.v1.json`, 'utf8')).plan.version).toBe(1)
    expect(store.roomOf('device:lamp')?.name).toBe('Living')
    expect(store.roomOf('device:shutter')?.name).toBe('Living')
    // A second start reads version 2 and leaves the copy alone.
    writeFileSync(`${path}.v1.json`, 'kept')
    new HouseStore(path)
    expect(readFileSync(`${path}.v1.json`, 'utf8')).toBe('kept')
  })

  it('takes a save in either version, keeping what version 1 cannot say', () => {
    const store = new HouseStore(path)
    store.set(fromV1(v1()).plan, 0)
    const stored = store.get().plan!
    opening<Window>(stored, 'win').frame = { material: 'pvc' }
    store.set(stored, 1)
    const fromOldTab = toV1(store.get().plan!)
    fromOldTab.floors[0].rooms.find((r) => r.id === 'kitchen')!.name = 'Cozinha'
    store.set(fromOldTab, 2)
    expect(opening<Window>(store.get().plan!, 'win').frame).toEqual({ material: 'pvc' })
    expect(store.get().plan!.storeys[0].spaces.find((s) => s.id === 'kitchen')?.name).toBe('Cozinha')
    expect(existsSync(`${path}.v1.json`)).toBe(false)
  })
})
