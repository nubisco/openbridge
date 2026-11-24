import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { toV1 } from '../house-model/convert.js'
import { toIfc } from '../house-model/ifc.js'
import { IfcError, adoptIds, fromIfc, parseStep } from '../house-model/ifc-read.js'
import type { Plan, Storey } from '../house-model/v2.js'
import { plan } from './fixtures/ifc-plan.js'

const OPTS = { name: 'Test house', application: 'OpenBridge', timestamp: '2026-11-22T12:00:00' }
const storey = (p: Plan, level: number) => p.storeys.find((s) => s.level === level)!
/** What the import cannot bring back: devices (OpenBridge's, not the building's) and editor hints. */
const building = (s: Storey) => ({
  ...s,
  placements: [],
  spaces: s.spaces.map(({ rects: _rects, ...x }) => x),
  furniture: s.furniture.map(({ back: _back, ...u }) => u),
})

describe('STEP reading', () => {
  it('reads every kind of value', () => {
    const ents = parseStep(
      [
        'ISO-10303-21;',
        'HEADER;',
        "FILE_SCHEMA(('IFC4'));",
        'ENDSEC;',
        'DATA;',
        "#1=IFCTHING('It''s \\X2\\00E9\\X0\\t\\\\',$,*,.T.,(1,2.5,-3.E-2),#7,IFCLABEL('x;y)'),());",
        '/* a comment */ #2 = IFCOTHER((#1,#1));',
        'ENDSEC;',
        'END-ISO-10303-21;',
      ].join('\n'),
    )
    expect(ents.get(1)).toEqual({
      id: 1,
      type: 'IFCTHING',
      args: ["It's ét\\", null, null, { e: 'T' }, [1, 2.5, -0.03], { ref: 7 }, { t: 'IFCLABEL', v: 'x;y)' }, []],
    })
    expect(ents.get(2)?.args).toEqual([[{ ref: 1 }, { ref: 1 }]])
  })

  it('refuses what is not an IFC file', () => {
    expect(() => fromIfc('hello')).toThrow(IfcError)
  })
})

describe('IFC import of our own export', () => {
  it('brings back the building as it was', () => {
    const p = plan()
    const back = adoptIds(fromIfc(toIfc(p, OPTS)).plan, p)
    expect(back.site).toEqual(p.site)
    expect(back.snap).toBe(p.snap)
    expect(back.storeys.map((s) => [s.id, s.level, s.elevation, s.height])).toEqual(
      p.storeys.map((s) => [s.id, s.level, s.elevation, s.height]),
    )
    for (const s of p.storeys) expect(building(storey(back, s.level))).toEqual(building(s))
  })

  it('says nothing was left out', () => {
    expect(fromIfc(toIfc(plan(), OPTS)).notes).toEqual([])
  })
})

describe('IFC import of a file from another tool', () => {
  // Made by IfcOpenShell the way Bonsai makes one: see fixtures/make-foreign-ifc.py.
  const read = () => fromIfc(readFileSync(join(__dirname, 'fixtures', 'foreign-house.ifc'), 'utf8'))

  it('reads millimetres, storeys by height, and moves the house onto the plot', () => {
    const { plan: p, notes } = read()
    expect(notes).toEqual([])
    expect(p.storeys.map((s) => [s.name, s.level, s.elevation, s.height])).toEqual([
      ['Ground', 0, 0, 3000],
      ['Upper', 1, 3000, 2800],
    ])
    // Its origin was 2 m in from the left: moved by whole half metres to leave a margin.
    const g = storey(p, 0)
    expect(g.walls[0]).toMatchObject({ a: [1500, 1500], b: [9500, 1500], thickness: 300, height: 2700 })
    expect(p.site).toEqual({ w: 11000, h: 11000 })
  })

  it('reads walls by their axis, thickness and height from their body', () => {
    const g = storey(read().plan, 0)
    expect(g.walls.map((w) => [w.thickness, w.height])).toEqual([
      [300, 2700],
      [300, 2700],
      [300, 2700],
      [300, 2700],
      [100, 2700],
      [200, 1200],
    ])
    expect(g.walls[4]).toMatchObject({ a: [5500, 1500], b: [5500, 6500] })
  })

  it('moves rooms drawn to the inside of their walls onto the walls, by their long name', () => {
    const g = storey(read().plan, 0)
    expect(g.spaces).toEqual([
      {
        id: 'living-room',
        name: 'Living room',
        kind: 'room',
        outline: [
          [1500, 1500],
          [5500, 1500],
          [5500, 6500],
          [1500, 6500],
        ],
      },
      {
        id: 'kitchen',
        name: 'Kitchen',
        kind: 'room',
        outline: [
          [5500, 1500],
          [9500, 1500],
          [9500, 6500],
          [5500, 6500],
        ],
      },
    ])
  })

  it('puts doors and windows in their walls, from their openings', () => {
    const g = storey(read().plan, 0)
    const wallOf = (id: string) => g.walls.findIndex((w) => w.id === g.openings.find((o) => o.id === id)!.wall)
    expect(g.openings.map((o) => [o.kind, o.at, o.width])).toEqual([
      ['door', 1000, 900],
      ['window', 1500, 1200],
      ['door', 2000, 800],
    ])
    expect([wallOf(g.openings[0].id), wallOf(g.openings[1].id), wallOf(g.openings[2].id)]).toEqual([2, 0, 4])
    expect(g.openings[0]).toMatchObject({ operation: 'swing', leaf: 'solid', sill: 0, head: 2100, hinge: 'start' })
    expect(g.openings[1]).toMatchObject({ sill: 900, head: 2100 })
    expect(g.openings[2]).toMatchObject({ hinge: 'end', head: 2000 })
  })

  it('reads furniture by its type, as the box round it', () => {
    expect(storey(read().plan, 1).furniture).toEqual([{ id: 'f1', kind: 'bed', x: 2500, y: 3500, w: 1600, d: 2000 }])
  })

  it('gives rooms the editor draws, with their walls, and a garden wall drawn on its own', () => {
    const view = toV1(read().plan)
    const g = view.floors.find((f) => f.level === 0)!
    expect(g.rooms.map((r) => [r.name, r.x, r.y, r.w, r.h])).toEqual([
      ['Living room', 3, 3, 8, 10],
      ['Kitchen', 11, 3, 8, 10],
    ])
    expect(g.drawnWalls?.map((w) => [w.a, w.b, w.thickness, w.height])).toEqual([[[3, 19], [19, 19], 200, 1200]])
    expect(g.openings).toHaveLength(3)
  })
})

describe('Keeping ids across an import', () => {
  it('takes a storey by its level and a room by its name', () => {
    const p = fromIfc(readFileSync(join(__dirname, 'fixtures', 'foreign-house.ifc'), 'utf8')).plan
    adoptIds(p, {
      storeys: [
        { id: 'g', level: 0, spaces: [{ id: 'kt', name: 'kitchen ' }] },
        { id: 'f1', level: 1, spaces: [] },
      ],
    })
    expect(p.storeys.map((s) => s.id)).toEqual(['g', 'f1'])
    expect(storey(p, 0).spaces.map((x) => x.id)).toEqual(['living-room', 'kt'])
  })
})
