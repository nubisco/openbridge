import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Cells, area, cellLoops, rectangles } from '../house-model/cells.js'
import { fromV1, toV1 } from '../house-model/convert.js'
import { PlanError, validatePlan } from '../house-model/validate.js'
import type { Door, Plan, Window } from '../house-model/v2.js'
import { HouseStore, validateHousePlan, type HousePlan } from '../house.js'

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

/**
 * Version 1 leaves the usual hinge and swing unsaid, and the version 1 view
 * adds each door's and window's detail, so compare without those.
 */
const norm = (p: HousePlan) =>
  JSON.parse(
    JSON.stringify(validateHousePlan(p), (k, v) =>
      (k === 'opens' && (v === 'down' || v === 'right')) ||
      (k === 'hinge' && v === 'start') ||
      k === 'spec' ||
      k === 'covering'
        ? undefined
        : v,
    ),
  )

const storey = (p: Plan, id: string) => p.storeys.find((s) => s.id === id)!
const opening = <T>(p: Plan, id: string) => p.storeys.flatMap((s) => s.openings).find((o) => o.id === id) as T

describe('plan version 2 from version 1', () => {
  it('converts every length to millimetres, exactly', () => {
    const { plan } = fromV1(v1())
    expect(plan.site).toEqual({ w: 15000, h: 10000 })
    const g = storey(plan, 'g')
    expect(g.placements.find((p) => p.ref === 'device:lamp')).toMatchObject({ x: 3250, y: 2500 })
    expect(g.placements.find((p) => p.ref === 'device:gate')).toMatchObject({ length: 3000 })
    expect(g.furniture[0]).toEqual({
      id: 'sofa',
      kind: 'sofa',
      x: 1500,
      y: 1500,
      w: 2000,
      d: 750,
      height: 850,
      back: 'up',
    })
    expect(storey(plan, 'f1').elevation).toBe(2800)
  })

  it('makes walls from the edges of rooms, thick outside and thin between rooms', () => {
    const g = storey(fromV1(v1()).plan, 'g')
    const at = (a: [number, number], b: [number, number]) =>
      g.walls.find((w) => w.a[0] === a[0] && w.a[1] === a[1] && w.b[0] === b[0] && w.b[1] === b[1])
    // The top of the living room and the kitchen: one line, all outside.
    expect(at([1000, 1000], [9000, 1000])).toMatchObject({ thickness: 300, height: 2500 })
    // Between the living room and the kitchen: one inner wall.
    expect(at([6000, 1000], [6000, 4000])).toMatchObject({ thickness: 100 })
    // A garden and a pool have no walls.
    expect(g.walls.some((w) => w.a[0] >= 10000)).toBe(false)
  })

  it('gives rooms of any shape an outline, and keeps how the editor drew them', () => {
    const living = storey(fromV1(v1()).plan, 'g').spaces.find((s) => s.id === 'living')!
    expect(living.outline).toEqual([
      [1000, 1000],
      [6000, 1000],
      [6000, 4000],
      [3000, 4000],
      [3000, 6000],
      [1000, 6000],
    ])
    expect(area(living.outline)).toBe(5000 * 3000 + 2000 * 2000)
    expect(living.rects).toHaveLength(2)
  })

  it('turns the four opening tools into doors and windows with variants', () => {
    const { plan } = fromV1(v1())
    expect(opening<Window>(plan, 'win')).toMatchObject({ kind: 'window', operation: 'casement', sill: 900, head: 2100 })
    expect(opening<Door>(plan, 'slide')).toMatchObject({ kind: 'door', operation: 'sliding', leaf: 'glazed', sill: 0 })
    expect(opening<Door>(plan, 'gd')).toMatchObject({ kind: 'door', operation: 'swing', leaf: 'glazed', hinge: 'end' })
    expect(opening<Door>(plan, 'wood')).toMatchObject({ kind: 'door', operation: 'swing', leaf: 'solid' })
    expect(opening(plan, 'gap')).toMatchObject({ kind: 'gap', width: 750 })
  })

  it('names the side a door opens to relative to its wall', () => {
    const { plan } = fromV1(v1())
    // A wall along x runs to the right, so down on the plan is its right.
    expect(opening<Door>(plan, 'gd').opens).toBe('right')
    // A wall along y runs down, so left on the plan is its right.
    expect(opening<Door>(plan, 'wood').opens).toBe('right')
  })

  it('hosts a door in its wall, at its distance along it', () => {
    const g = storey(fromV1(v1()).plan, 'g')
    const slide = g.openings.find((o) => o.id === 'slide')!
    const wall = g.walls.find((w) => w.id === slide.wall)!
    expect(wall.a[0]).toBe(1000)
    expect(wall.a[1] + slide.at).toBe(1750)
    expect(slide.width).toBe(1000)
  })

  it('turns a shutter put on a window into a covering its device drives', () => {
    const { plan } = fromV1(v1())
    expect(opening<Window>(plan, 'win').coverings).toEqual([{ id: 'c1', kind: 'shutter', side: 'outside' }])
    expect(storey(plan, 'g').placements.find((p) => p.ref === 'device:shutter')?.host).toEqual({
      opening: 'win',
      covering: 'c1',
    })
  })

  it('produces a plan that passes its own checks', () => {
    expect(() => validatePlan(fromV1(v1()).plan)).not.toThrow()
  })
})

describe('the version 1 view of a version 2 plan', () => {
  it('gives back exactly the plan it came from', () => {
    const before = v1()
    expect(norm(toV1(validatePlan(fromV1(before).plan)))).toEqual(norm(before))
  })

  it('converts the same way twice', () => {
    const once = fromV1(v1()).plan
    expect(fromV1(toV1(once), once).plan).toEqual(once)
  })

  it('splits a room into rectangles itself when it has no hint', () => {
    const plan = fromV1(v1()).plan
    const living = storey(plan, 'g').spaces.find((s) => s.id === 'living')!
    delete living.rects
    const room = toV1(plan).floors[0].rooms.find((r) => r.id === 'living')!
    expect(Cells.of([room, ...(room.parts ?? [])]).size).toBe(10 * 6 + 4 * 4)
    expect(room).toMatchObject({ x: 2, y: 2, w: 10, h: 6, parts: [{ x: 2, y: 8, w: 4, h: 4 }] })
  })
})

describe('plans measured to the millimetre', () => {
  // Version 1 shapes with values off the half metre grid, as the editor
  // draws them once snapping is finer. A cell is 500 mm, so 0.002 is 1 mm.
  function fine(): HousePlan {
    return {
      version: 1,
      grid: 0.5,
      plot: { w: 30.002, h: 20 },
      floors: [
        {
          id: 'g',
          name: 'Ground floor',
          level: 0,
          rooms: [
            // 1017 mm in, 4123 by 3001 mm, with a wing below it.
            {
              id: 'a',
              name: 'A',
              kind: 'room',
              x: 2.034,
              y: 2,
              w: 8.246,
              h: 6.002,
              parts: [{ x: 2.034, y: 8.002, w: 3.1, h: 2.5 }],
            },
            // Beside it, sharing 2.4 m of its right wall.
            { id: 'b', name: 'B', kind: 'room', x: 10.28, y: 3.2, w: 4, h: 4.8 },
          ],
          openings: [{ id: 'd', type: 'door', axis: 'v', x: 10.28, y: 4.05, len: 1.638 }],
          placements: [{ ref: 'device:x', x: 4.568, y: 5.002 }],
          radiators: [{ id: 'r', axis: 'h', x: 3.3, y: 2, len: 1.71, side: 'down' }],
          furniture: [{ id: 'f', kind: 'table', x: 3.002, y: 3.5, w: 2.4, d: 1.6 }],
        },
      ],
    }
  }

  it('converts every value to the millimetre and back', () => {
    const plan = validatePlan(fromV1(fine()).plan)
    const g = storey(plan, 'g')
    expect(g.spaces.find((s) => s.id === 'a')!.outline).toEqual([
      [1017, 1000],
      [5140, 1000],
      [5140, 4001],
      [2567, 4001],
      [2567, 5251],
      [1017, 5251],
    ])
    expect(g.openings[0]).toMatchObject({ width: 819 })
    expect(g.placements[0]).toMatchObject({ x: 2284, y: 2501 })
    expect(toV1(plan)).toMatchObject(fine())
    expect(fromV1(toV1(plan), plan).plan).toEqual(plan)
  })

  it('cuts walls where they change from between rooms to outside', () => {
    const walls = storey(fromV1(fine()).plan, 'g').walls
    const right = walls.filter((w) => w.a[0] === 5140 && w.b[0] === 5140)
    // Room A's right wall: outside above B, between A and B, outside below B.
    expect(right.map((w) => [w.a[1], w.b[1], w.thickness])).toEqual([
      [1000, 1600, 300],
      [1600, 4000, 100],
      [4000, 4001, 300],
    ])
  })

  it('splits a shape into rectangles by their real size', () => {
    const plan = fromV1(fine()).plan
    delete storey(plan, 'g').spaces.find((s) => s.id === 'a')!.rects
    const room = toV1(plan).floors[0].rooms.find((r) => r.id === 'a')!
    expect(room).toMatchObject({ x: 2.034, y: 2, w: 8.246, h: 6.002, parts: [{ x: 2.034, y: 8.002, w: 3.1, h: 2.5 }] })
  })
})

describe('saving from the version 1 editor keeps what it cannot say', () => {
  function edited(): Plan {
    const plan = fromV1(v1()).plan
    const g = storey(plan, 'g')
    const outer = g.walls.find((w) => w.thickness === 300)!
    outer.thickness = 350
    const win = opening<Window>(plan, 'win')
    win.operation = 'sliding'
    win.frame = { material: 'aluminium', colour: '#ffffff' }
    win.coverings = [...(win.coverings ?? []), { id: 'c2', kind: 'curtain', side: 'inside' }]
    const wood = opening<Door>(plan, 'wood')
    wood.frame = { material: 'wood', colour: '#6b4a2b' }
    return validatePlan(plan)
  }

  it('keeps wall thickness, frames, the window type and curtains', () => {
    const previous = edited()
    const again = fromV1(toV1(previous), previous).plan
    expect(again).toEqual(previous)
  })

  it('keeps a wall that grew, and the thickness it had', () => {
    const previous = edited()
    const next = toV1(previous)
    next.floors[0].rooms.find((r) => r.id === 'kitchen')!.w = 8
    const g = storey(fromV1(next, previous).plan, 'g')
    const before = storey(previous, 'g').walls.find((w) => w.thickness === 350)!
    expect(g.walls.find((w) => w.id === before.id)?.thickness).toBe(350)
  })

  it('starts a door made into a window from a window, keeping its frame', () => {
    const previous = edited()
    const next = toV1(previous)
    next.floors[0].openings.find((o) => o.id === 'wood')!.type = 'window'
    const win = opening<Window>(fromV1(next, previous).plan, 'wood')
    expect(win).toMatchObject({ kind: 'window', operation: 'casement', sill: 900, frame: { material: 'wood' } })
  })

  it('drops coverings from a glass door made solid', () => {
    const previous = fromV1(v1()).plan
    const gd = opening<Door>(previous, 'gd')
    gd.coverings = [{ id: 'c1', kind: 'curtain', side: 'inside' }]
    const next = toV1(previous)
    delete next.floors[0].openings.find((o) => o.id === 'gd')!.glass
    expect(opening<Door>(fromV1(next, previous).plan, 'gd').coverings).toBeUndefined()
  })

  it('lets a new device drive a curtain nobody drives yet', () => {
    const previous = edited()
    const next = toV1(previous)
    next.floors[0].placements.push({ ref: 'device:curtain', x: 4, y: 2, opening: 'win' })
    const g = storey(fromV1(next, previous).plan, 'g')
    expect(g.placements.find((p) => p.ref === 'device:curtain')?.host).toEqual({ opening: 'win', covering: 'c2' })
    expect(g.placements.find((p) => p.ref === 'device:shutter')?.host).toEqual({ opening: 'win', covering: 'c1' })
  })

  it('takes the detail the editor set on a door or window', () => {
    const previous = fromV1(v1()).plan
    const next = toV1(previous)
    const win = next.floors[0].openings.find((o) => o.id === 'win')!
    win.spec = {
      kind: 'window',
      operation: 'fixed',
      sill: 0,
      head: 2100,
      frame: { material: 'aluminium', colour: '#ffffff' },
      coverings: [
        { id: 'c1', kind: 'shutter', side: 'outside' },
        { id: 'c2', kind: 'curtain', side: 'inside' },
      ],
    }
    next.floors[0].openings.find((o) => o.id === 'gd')!.spec = { kind: 'door', operation: 'swing', leaf: 'part-glazed' }
    const plan = validatePlan(fromV1(validateHousePlan(next), previous).plan)
    expect(opening<Window>(plan, 'win')).toMatchObject({
      operation: 'fixed',
      sill: 0,
      frame: { material: 'aluminium', colour: '#ffffff' },
      coverings: [{ id: 'c1' }, { id: 'c2' }],
    })
    expect(opening<Door>(plan, 'gd').leaf).toBe('part-glazed')
  })

  it('takes every covering off when the editor sends an empty list', () => {
    const previous = fromV1(v1()).plan
    const next = toV1(previous)
    next.floors[0].openings.find((o) => o.id === 'win')!.spec!.coverings = []
    next.floors[0].placements = next.floors[0].placements.filter((p) => p.ref !== 'device:shutter')
    expect(opening<Window>(fromV1(next, previous).plan, 'win').coverings).toBeUndefined()
  })

  it('ignores detail that does not fit what the cells say', () => {
    const previous = fromV1(v1()).plan
    const next = toV1(previous)
    // A sliding operation on a door that is not a slider, and a glazed leaf on a solid door.
    next.floors[0].openings.find((o) => o.id === 'wood')!.spec = { kind: 'door', operation: 'sliding', leaf: 'glazed' }
    expect(opening<Door>(fromV1(next, previous).plan, 'wood')).toMatchObject({ operation: 'swing', leaf: 'solid' })
  })

  it('lets the editor say which covering a device drives', () => {
    const previous = fromV1(v1()).plan
    const next = toV1(previous)
    const win = next.floors[0].openings.find((o) => o.id === 'win')!
    win.spec!.coverings = [
      { id: 'c1', kind: 'shutter', side: 'outside' },
      { id: 'c2', kind: 'blind', side: 'inside' },
    ]
    next.floors[0].placements.find((p) => p.ref === 'device:shutter')!.covering = 'c2'
    const g = storey(fromV1(next, previous).plan, 'g')
    expect(g.placements.find((p) => p.ref === 'device:shutter')?.host).toEqual({ opening: 'win', covering: 'c2' })
  })

  it('leaves out an opening that sits on no wall, and says so', () => {
    const p = v1()
    p.floors[0].openings.push({ id: 'lost', type: 'door', axis: 'h', x: 25, y: 15, len: 1 })
    const { plan, dropped } = fromV1(p)
    expect(opening(plan, 'lost')).toBeUndefined()
    expect(dropped).toEqual(['Ground floor: door lost'])
  })
})

describe('outlines of cells', () => {
  it('finds the hole in a ring of cells', () => {
    const ring = Cells.of([
      { x: 0, y: 0, w: 3, h: 1 },
      { x: 0, y: 2, w: 3, h: 1 },
      { x: 0, y: 1, w: 1, h: 1 },
      { x: 2, y: 1, w: 1, h: 1 },
    ])
    const [outer, hole] = cellLoops(ring)
    expect(area(outer)).toBe(9)
    expect(area(hole)).toBe(-1)
  })

  it('keeps two cells that touch at a corner as two simple loops', () => {
    const loops = cellLoops(
      Cells.of([
        { x: 0, y: 0, w: 1, h: 1 },
        { x: 1, y: 1, w: 1, h: 1 },
      ]),
    )
    expect(loops.map((l) => l.length)).toEqual([4, 4])
  })

  it('splits an L into its two rectangles, largest first', () => {
    const rects = rectangles(
      Cells.of([
        { x: 0, y: 0, w: 2, h: 5 },
        { x: 2, y: 3, w: 4, h: 2 },
      ]),
    )
    expect(rects).toEqual([
      { x: 0, y: 3, w: 6, h: 2 },
      { x: 0, y: 0, w: 2, h: 3 },
    ])
  })
})

describe('validatePlan', () => {
  const plan = () => fromV1(v1()).plan
  const refuse = (change: (p: Plan) => void, message: RegExp) => {
    const p = plan()
    change(p)
    expect(() => validatePlan(p)).toThrow(PlanError)
    expect(() => validatePlan(p)).toThrow(message)
  }

  it('refuses curtains on a solid door', () =>
    refuse((p) => {
      opening<Door>(p, 'wood').coverings = [{ id: 'c1', kind: 'curtain', side: 'inside' }]
    }, /only glass/))

  it('refuses a device driving a covering that is not there', () =>
    refuse((p) => {
      storey(p, 'g').placements.find((x) => x.host)!.host!.covering = 'nope'
    }, /no covering 'nope'/))

  it('refuses an opening that runs past the end of its wall', () =>
    refuse((p) => {
      opening<Door>(p, 'slide').width = 999_999
    }, /width/))

  it('refuses an opening in a wall that is not there', () =>
    refuse((p) => {
      opening<Door>(p, 'slide').wall = 'nope'
    }, /no wall 'nope'/))

  it('refuses a window whose head is below its sill', () =>
    refuse((p) => {
      opening<Window>(p, 'win').head = 500
    }, /head/))

  it('refuses a door that opens a way doors do not', () =>
    refuse((p) => {
      ;(opening<Door>(p, 'wood') as { operation: string }).operation = 'revolving'
    }, /operation/))

  it('drops fields it does not know', () => {
    const p = plan() as Plan & { extra?: number }
    p.extra = 1
    expect(validatePlan(p)).not.toHaveProperty('extra')
  })
})

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
