import { describe, it, expect } from 'vitest'
import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fromV1 } from '../house-model/convert.js'
import { globalId, stepReal, stepString, toIfc, type IfcDevice } from '../house-model/ifc.js'
import type { Door, Plan, Window } from '../house-model/v2.js'
import type { HousePlan } from '../house.js'

/** Two floors with a room of each kind, every kind of opening, coverings, furniture and devices. */
function plan(): Plan {
  const v1: HousePlan = {
    version: 1,
    grid: 0.5,
    plot: { w: 30, h: 20 },
    floors: [
      {
        id: 'g',
        name: 'Rez-de-chaussée',
        level: 0,
        rooms: [
          { id: 'garden', name: 'Garden', kind: 'outdoor', x: 0, y: 0, w: 30, h: 20 },
          {
            id: 'living',
            name: "Sam's living",
            kind: 'room',
            x: 2,
            y: 2,
            w: 10,
            h: 6,
            parts: [{ x: 2, y: 8, w: 4, h: 4 }],
          },
          { id: 'kitchen', name: 'Kitchen', kind: 'room', x: 12, y: 2, w: 6, h: 6 },
          { id: 'deck', name: 'Deck', kind: 'paved', x: 19, y: 9, w: 8, h: 6 },
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
          { ref: 'device:lamp', x: 6.5, y: 5, mount: 'ceiling' },
          { ref: 'device:shutter', x: 5, y: 2, opening: 'win' },
          { ref: 'device:unknown', x: 8, y: 5 },
        ],
        radiators: [{ id: 'rad', x: 12, y: 2.5, axis: 'v', len: 1.5, side: 'right' }],
        furniture: [
          { id: 'sofa', kind: 'sofa', x: 3, y: 3, w: 4, d: 1.5, back: 'up' },
          { id: 'bath', kind: 'bath', x: 13, y: 3, w: 3, d: 1.5 },
          { id: 'planter', kind: 'planter', x: 20, y: 16, w: 1, d: 1 },
        ],
      },
      {
        id: 'f1',
        name: 'First floor',
        level: 1,
        rooms: [{ id: 'bed', name: 'Bedroom', kind: 'room', x: 2, y: 2, w: 8, h: 8 }],
        openings: [{ id: 'bw', type: 'window', axis: 'h', x: 4, y: 2, len: 2 }],
        placements: [],
      },
    ],
  }
  const p = fromV1(v1).plan
  const g = p.storeys[0]
  ;(g.openings.find((o) => o.id === 'win') as Window).coverings!.push({ id: 'cur', kind: 'curtain', side: 'inside' })
  ;(g.openings.find((o) => o.id === 'slide') as Door).coverings = [{ id: 'aw', kind: 'awning', side: 'outside' }]
  return p
}

const DEVICES: Record<string, IfcDevice> = {
  'device:lamp': { name: 'Ceiling light', ifcClass: 'IfcLightFixture', predefined: 'POINTSOURCE' },
  'device:shutter': { name: 'Window shutter', ifcClass: 'IfcActuator', predefined: 'ELECTRICACTUATOR' },
}
const OPTS = { name: 'Test house', application: 'OpenBridge', timestamp: '2026-11-22T12:00:00', devices: DEVICES }

const count = (ifc: string, type: string) => ifc.split('\n').filter((l) => l.includes(`=${type}(`)).length

describe('IFC export', () => {
  it('writes a STEP file for IFC4', () => {
    const ifc = toIfc(plan(), OPTS)
    expect(ifc.startsWith('ISO-10303-21;\nHEADER;')).toBe(true)
    expect(ifc).toContain("FILE_SCHEMA(('IFC4'));")
    expect(ifc.trimEnd().endsWith('END-ISO-10303-21;')).toBe(true)
  })

  it('maps the plan as the design says', () => {
    const p = plan()
    const ifc = toIfc(p, OPTS)
    expect(count(ifc, 'IFCBUILDINGSTOREY')).toBe(2)
    expect(count(ifc, 'IFCWALL')).toBe(p.storeys.reduce((n, s) => n + s.walls.length, 0))
    expect(count(ifc, 'IFCSPACE')).toBe(6)
    // A slab under every walled room.
    expect(count(ifc, 'IFCSLAB')).toBe(3)
    // Every opening voids its wall, a gap included, and only doors and windows fill one.
    expect(count(ifc, 'IFCOPENINGELEMENT')).toBe(6)
    expect(count(ifc, 'IFCRELVOIDSELEMENT')).toBe(6)
    expect(count(ifc, 'IFCDOOR')).toBe(3)
    expect(count(ifc, 'IFCWINDOW')).toBe(2)
    expect(count(ifc, 'IFCRELFILLSELEMENT')).toBe(5)
    // The shutter the device drives, the curtains and the awning.
    expect(count(ifc, 'IFCSHADINGDEVICE')).toBe(3)
    expect(count(ifc, 'IFCSANITARYTERMINAL')).toBe(1)
    expect(count(ifc, 'IFCFURNITURE')).toBe(2)
    expect(count(ifc, 'IFCSPACEHEATER')).toBe(1)
    // Only the devices the caller named.
    expect(count(ifc, 'IFCLIGHTFIXTURE')).toBe(1)
    expect(count(ifc, 'IFCACTUATOR')).toBe(1)
    expect(ifc).not.toContain('device:unknown')
    // The sliding door slides, and the shutter motor drives its shutter.
    expect(ifc).toMatch(/IFCDOOR\([^\n]*\.DOUBLE_DOOR_SLIDING\./)
    expect(ifc).toMatch(/IFCSHADINGDEVICE\([^\n]*'Roller shutter'[^\n]*\.SHUTTER\.\)/)
    expect(ifc).toContain("IFCPROPERTYSINGLEVALUE('Motorised',$,IFCBOOLEAN(.T.),$)")
  })

  it('is the same every time, so other software can follow changes', () => {
    expect(toIfc(plan(), OPTS)).toBe(toIfc(plan(), OPTS))
  })

  it('gives every product and relationship its own GlobalId', () => {
    const ids = [...toIfc(plan(), OPTS).matchAll(/^#\d+=IFC[A-Z]+\('([^']{22})'/gm)].map((m) => m[1])
    expect(ids.length).toBeGreaterThan(50)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[0-3][0-9A-Za-z_$]{21}$/)
    expect(globalId('a')).toBe(globalId('a'))
    expect(globalId('a')).not.toBe(globalId('b'))
  })

  it('writes strings and numbers the way STEP wants them', () => {
    expect(stepString("Sam's")).toBe("'Sam''s'")
    expect(stepString('a\\b')).toBe("'a\\\\b'")
    expect(stepString('Rez-de-chaussée')).toBe("'Rez-de-chauss\\X2\\00E9\\X0\\e'")
    expect(stepString('🏠')).toBe("'\\X4\\0001F3E0\\X0\\'")
    expect(stepReal(2)).toBe('2.')
    expect(stepReal(-0)).toBe('0.')
    expect(stepReal(0.1 + 0.2)).toBe('0.3')
    expect(stepReal(1e-5)).toBe('0.00001')
    expect(stepReal(1e21)).toBe('1.E+21')
  })

  // IfcOpenShell checks the schema, its rules and every shape. CI runs it;
  // locally, point IFC_PYTHON at a Python with ifcopenshell and pytest.
  it.skipIf(!process.env.IFC_PYTHON)(
    'passes IfcOpenShell validation',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'ifc-'))
      try {
        const file = join(dir, 'house.ifc')
        const ifc = toIfc(plan(), OPTS)
        writeFileSync(file, ifc)
        const run = spawnSync(process.env.IFC_PYTHON!, [join(__dirname, 'validate-ifc.py'), file], { encoding: 'utf8' })
        const out = JSON.parse(run.stdout || '{}')
        expect(out.issues ?? [run.stderr]).toEqual([])
        // Every shape written was built.
        expect(out.shapes).toBe(count(ifc, 'IFCPRODUCTDEFINITIONSHAPE'))
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    120_000,
  )
})
