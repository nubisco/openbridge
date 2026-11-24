/**
 * An IFC file (STEP, `.ifc`) read into a house plan, version 2. See "IFC
 * import" in docs/design/house-bim.md.
 *
 * Our own reader, like the writer in ifc.ts: no WebAssembly, no Node, no
 * DOM, so it runs in the browser and in the daemon alike. It reads what a
 * house plan holds (storeys, walls, spaces, doors, windows, radiators,
 * furniture) from the structures the common tools write, and says what it
 * left out. Devices are not read: they are OpenBridge's, not the building's.
 *
 * Coordinates: IFC's X is the plan's x, IFC's Y is the plan's -y (IFC's Y
 * runs north, up the page), in the file's length unit, read into
 * millimetres. A file whose house sits off the plan's corner, or partly at
 * negative coordinates, is moved onto the plot by whole half metres.
 */

import { area as loopArea } from './cells.js'
import { FURNITURE_HEIGHT, FURNITURE_NAME } from './ifc.js'
import {
  COVERING_KINDS,
  DEFAULTS,
  DOOR_OPERATIONS,
  FRAME_MATERIALS,
  FURNITURE_KINDS,
  LEAVES,
  PLAN_VERSION,
  WINDOW_OPERATIONS,
  type Covering,
  type Furniture,
  type Opening,
  type Plan,
  type Point,
  type Radiator,
  type Space,
  type SpaceKind,
  type Storey,
  type Wall,
} from './v2.js'
import { PlanError, validatePlan } from './validate.js'

export class IfcError extends Error {}

// ─── STEP ───────────────────────────────────────────────────────────────────

/** A value in a STEP file. `$` and `*` are null, `.X.` is `{ e }`, `IFCLABEL('x')` is `{ t, v }`. */
export type StepValue =
  | number
  | string
  | null
  | { ref: number }
  | { e: string }
  | { t: string; v: StepValue }
  | StepValue[]

export interface StepEntity {
  id: number
  /** Upper case, as IFC writes it: `IFCWALL`. */
  type: string
  args: StepValue[]
}

/** A STEP string's text: quotes undoubled, `\X2\` and the other escapes decoded. */
function decodeString(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === "'" && s[i + 1] === "'") {
      out += "'"
      i++
    } else if (c === '\\') {
      if (s.startsWith('\\\\', i)) {
        out += '\\'
        i++
      } else if (s.startsWith('\\X2\\', i) || s.startsWith('\\X4\\', i)) {
        const w = s[i + 2] === '2' ? 4 : 8
        const end = s.indexOf('\\X0\\', i + 4)
        const hex = s.slice(i + 4, end < 0 ? s.length : end)
        for (let j = 0; j + w <= hex.length; j += w) out += String.fromCodePoint(parseInt(hex.slice(j, j + w), 16))
        i = end < 0 ? s.length : end + 3
      } else if (s.startsWith('\\X\\', i)) {
        out += String.fromCharCode(parseInt(s.slice(i + 3, i + 5), 16))
        i += 4
      } else if (s.startsWith('\\S\\', i)) {
        out += String.fromCharCode(s.charCodeAt(i + 3) + 128)
        i += 3
      } else if (/^\\P[A-I]\\/.test(s.slice(i, i + 4))) i += 3
      else out += c
    } else out += c
  }
  return out
}

/** Every entity instance in a STEP file's DATA section, by its number. */
export function parseStep(text: string): Map<number, StepEntity> {
  const start = text.search(/\bDATA\s*;/)
  if (start < 0 || !/ISO-10303-21/.test(text.slice(0, 200))) throw new IfcError('This is not an IFC file.')
  let i = text.indexOf(';', start) + 1
  const n = text.length
  const out = new Map<number, StepEntity>()

  const ws = () => {
    for (;;) {
      while (i < n && /\s/.test(text[i])) i++
      if (text.startsWith('/*', i)) {
        const e = text.indexOf('*/', i + 2)
        i = e < 0 ? n : e + 2
      } else return
    }
  }
  const value = (): StepValue => {
    ws()
    const c = text[i]
    if (c === '$' || c === '*') {
      i++
      return null
    }
    if (c === '#') {
      const m = /^#(\d+)/.exec(text.slice(i, i + 20))!
      i += m[0].length
      return { ref: Number(m[1]) }
    }
    if (c === "'" || c === '"') {
      let j = i + 1
      for (;;) {
        const q = text.indexOf(c, j)
        if (q < 0) throw new IfcError('A string in the file never ends.')
        if (c === "'" && text[q + 1] === "'") j = q + 2
        else {
          const raw = text.slice(i + 1, q)
          i = q + 1
          return c === "'" ? decodeString(raw) : raw
        }
      }
    }
    if (c === '(') {
      i++
      const list: StepValue[] = []
      ws()
      if (text[i] === ')') {
        i++
        return list
      }
      for (;;) {
        list.push(value())
        ws()
        if (text[i] === ',') i++
        else if (text[i] === ')') {
          i++
          return list
        } else throw new IfcError(`The file is malformed near character ${i}.`)
      }
    }
    if (c === '.') {
      const e = text.indexOf('.', i + 1)
      const v = text.slice(i + 1, e)
      i = e + 1
      return { e: v }
    }
    const num = /^[-+]?(\d+\.?\d*([eE][-+]?\d+)?|\.\d+)/.exec(text.slice(i, i + 40))
    if (num) {
      i += num[0].length
      return Number(num[0])
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i, i + 80))
    if (name) {
      i += name[0].length
      ws()
      if (text[i] !== '(') throw new IfcError(`The file is malformed near character ${i}.`)
      i++
      const v = value()
      ws()
      i++ // ')'
      return { t: name[0].toUpperCase(), v }
    }
    throw new IfcError(`The file is malformed near character ${i}.`)
  }

  for (;;) {
    ws()
    if (i >= n || text.startsWith('ENDSEC', i)) break
    const head = /^#(\d+)\s*=\s*/.exec(text.slice(i, i + 40))
    if (!head) throw new IfcError(`The file is malformed near character ${i}.`)
    i += head[0].length
    const type = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i, i + 80))
    if (!type) {
      // A complex instance, `#1=(A()B());`: rare in IFC, and nothing a house needs.
      value()
      ws()
      if (text[i] === ';') i++
      continue
    }
    i += type[0].length
    const args = value()
    ws()
    if (text[i] === ';') i++
    out.set(Number(head[1]), {
      id: Number(head[1]),
      type: type[0].toUpperCase(),
      args: Array.isArray(args) ? args : [],
    })
  }
  return out
}

// ─── Small geometry ─────────────────────────────────────────────────────────

type V3 = [number, number, number]
/** An affine transform: its x, y and z axes and its origin. */
interface M {
  x: V3
  y: V3
  z: V3
  o: V3
}
const IDENTITY: M = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], o: [0, 0, 0] }
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a: V3): V3 => {
  const l = Math.hypot(...a)
  return l ? scale(a, 1 / l) : a
}
/** Where a point in m's frame is. */
const apply = (m: M, p: V3): V3 => add(m.o, add(scale(m.x, p[0]), add(scale(m.y, p[1]), scale(m.z, p[2]))))
/** Which way a direction in m's frame points. */
const turn = (m: M, d: V3): V3 => add(scale(m.x, d[0]), add(scale(m.y, d[1]), scale(m.z, d[2])))
/** b's frame, inside a's. */
const compose = (a: M, b: M): M => ({ x: turn(a, b.x), y: turn(a, b.y), z: turn(a, b.z), o: apply(a, b.o) })

/** A frame from an origin, a z axis and an x axis roughly at right angles to it. */
function frame(o: V3, z: V3, x: V3): M {
  const zz = norm(z)
  let xx = norm(add(x, scale(zz, -dot(x, zz))))
  if (!Math.hypot(...xx)) xx = Math.abs(zz[0]) < 0.9 ? norm(cross([0, 1, 0], zz)) : norm(cross(zz, [0, 0, 1]))
  return { x: xx, y: cross(zz, xx), z: zz, o }
}

/** A footprint on the plan, in the file's units with IFC's axes, and the heights it spans. */
interface Part {
  outer: Array<[number, number]>
  holes: Array<Array<[number, number]>>
  z0: number
  z1: number
  /** For an extruded rectangle: its frame in the world, and its sides. */
  rect?: { m: M; w: number; d: number }
}

// ─── The reader ─────────────────────────────────────────────────────────────

export interface IfcImport {
  plan: Plan
  /** What was left out or guessed, one line each, for the person to read. */
  notes: string[]
}

const WALLS = new Set(['IFCWALL', 'IFCWALLSTANDARDCASE', 'IFCWALLELEMENTEDCASE'])
const FURNISHING = new Set(['IFCFURNITURE', 'IFCFURNISHINGELEMENT', 'IFCSANITARYTERMINAL', 'IFCSYSTEMFURNITUREELEMENT'])
const ID = /^[A-Za-z0-9_-]{1,64}$/

const SANITARY_KIND: Record<string, Furniture['kind']> = {
  BATH: 'bath',
  SHOWER: 'shower',
  TOILETPAN: 'toilet',
  WASHHANDBASIN: 'basin',
  TABLE: 'table',
  BED: 'bed',
  SOFA: 'sofa',
  SHELF: 'shelves',
}
const FURNITURE_WORDS: Array<[RegExp, Furniture['kind']]> = [
  [/island/i, 'island'],
  [/\b(bed|cot)\b/i, 'bed'],
  [/sofa|couch|settee/i, 'sofa'],
  [/shel(f|ves)|bookcase/i, 'shelves'],
  [/table|desk/i, 'table'],
  [/\bbath(tub)?\b/i, 'bath'],
  [/shower/i, 'shower'],
  [/toilet|\bwc\b/i, 'toilet'],
  [/basin|sink/i, 'basin'],
  [/rug|carpet/i, 'rug'],
  [/lounger/i, 'lounger'],
  [/parasol|umbrella/i, 'parasol'],
  [/planter|plant/i, 'planter'],
  [/pergola/i, 'pergola'],
]

export function fromIfc(text: string): IfcImport {
  const ents = parseStep(text)
  const notes: string[] = []
  const get = (v: StepValue | undefined): StepEntity | undefined =>
    v && typeof v === 'object' && 'ref' in v ? ents.get(v.ref) : undefined
  const num = (v: StepValue | undefined): number | null => {
    if (typeof v === 'number') return v
    if (v && typeof v === 'object' && 't' in v) return num(v.v)
    return null
  }
  const str = (v: StepValue | undefined): string | null => {
    if (typeof v === 'string') return v
    if (v && typeof v === 'object' && 't' in v) return str(v.v)
    return null
  }
  const en = (v: StepValue | undefined): string | null => (v && typeof v === 'object' && 'e' in v ? v.e : null)
  const list = (v: StepValue | undefined): StepValue[] => (Array.isArray(v) ? v : [])
  const byType = (...types: string[]) => [...ents.values()].filter((e) => types.includes(e.type))

  // ── Units: millimetres per unit of length in the file.
  const unitMm = (u: StepEntity | undefined): number | null => {
    if (!u) return null
    if (u.type === 'IFCSIUNIT') {
      if (en(u.args[1]) !== 'LENGTHUNIT') return null
      const prefix: Record<string, number> = { MILLI: 1e-3, CENTI: 1e-2, DECI: 1e-1, KILO: 1e3 }
      return 1000 * (prefix[en(u.args[2]) ?? ''] ?? 1)
    }
    if (u.type === 'IFCCONVERSIONBASEDUNIT' || u.type === 'IFCCONVERSIONBASEDUNITWITHOFFSET') {
      if (en(u.args[1]) !== 'LENGTHUNIT') return null
      const measure = get(u.args[3])
      const k = num(measure?.args[0])
      const base = unitMm(get(measure?.args[1]))
      return k !== null && base !== null ? k * base : null
    }
    return null
  }
  const project = byType('IFCPROJECT')[0]
  if (!project) throw new IfcError('The file has no IfcProject, so it is not a building model.')
  let K = 1000
  for (const u of list(get(project.args[8])?.args[0])) {
    const k = unitMm(get(u))
    if (k !== null) K = k
  }
  const mm = (v: number) => Math.round(v * K)

  // ── Placements.
  const point3 = (v: StepValue | undefined): V3 => {
    const c = list(get(v)?.args[0]).map((x) => num(x) ?? 0)
    return [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0]
  }
  const dir3 = (v: StepValue | undefined, fallback: V3): V3 => {
    const d = get(v)
    if (!d) return fallback
    const c = list(d.args[0]).map((x) => num(x) ?? 0)
    return [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0]
  }
  const axis = (v: StepValue | undefined): M => {
    const a = get(v)
    if (!a) return IDENTITY
    if (a.type === 'IFCAXIS2PLACEMENT2D') return frame(point3(a.args[0]), [0, 0, 1], dir3(a.args[1], [1, 0, 0]))
    if (a.type === 'IFCAXIS2PLACEMENT3D')
      return frame(point3(a.args[0]), dir3(a.args[1], [0, 0, 1]), dir3(a.args[2], [1, 0, 0]))
    return IDENTITY
  }
  const placed = new Map<number, M>()
  const placement = (v: StepValue | undefined, depth = 0): M => {
    const p = get(v)
    if (!p || depth > 50) return IDENTITY
    const seen = placed.get(p.id)
    if (seen) return seen
    const m = p.type === 'IFCLOCALPLACEMENT' ? compose(placement(p.args[0], depth + 1), axis(p.args[1])) : IDENTITY
    placed.set(p.id, m)
    return m
  }
  const operator = (v: StepValue | undefined): M => {
    const t = get(v)
    if (!t) return IDENTITY
    const k = num(t.args[3]) ?? 1
    const x = dir3(t.args[0], [1, 0, 0])
    const z = t.type === 'IFCCARTESIANTRANSFORMATIONOPERATOR3D' ? dir3(t.args[4], [0, 0, 1]) : [0, 0, 1]
    const f = frame(point3(t.args[2]), z as V3, x)
    return { x: scale(f.x, k), y: scale(f.y, k), z: scale(f.z, k), o: f.o }
  }

  // ── Curves and profiles, as points in their own plane.
  const curve = (v: StepValue | undefined, depth = 0): Array<[number, number]> => {
    const c = get(v)
    if (!c || depth > 20) return []
    const pts = (l: StepValue[]) => l.map((p) => point3(p)).map((p): [number, number] => [p[0], p[1]])
    switch (c.type) {
      case 'IFCPOLYLINE':
        return pts(list(c.args[0]))
      case 'IFCINDEXEDPOLYCURVE': {
        const coords = list(get(c.args[0])?.args[0]).map((q) => list(q).map((x) => num(x) ?? 0))
        const segs = list(c.args[1])
        if (!segs.length) return coords.map((q): [number, number] => [q[0], q[1]])
        const out: Array<[number, number]> = []
        for (const s of segs) {
          const idx = s && typeof s === 'object' && 't' in s ? list(s.v) : list(s)
          for (const k of idx) {
            const q = coords[(num(k) ?? 1) - 1]
            if (!q) continue
            const last = out[out.length - 1]
            if (!last || last[0] !== q[0] || last[1] !== q[1]) out.push([q[0], q[1]])
          }
        }
        return out
      }
      case 'IFCCOMPOSITECURVE':
        return list(c.args[0]).flatMap((s) => curve(get(s)?.args[2], depth + 1))
      case 'IFCTRIMMEDCURVE': {
        const basis = get(c.args[0])
        const ends = [list(c.args[1]), list(c.args[2])].map((trim) => {
          const pt = trim.find((x) => get(x)?.type === 'IFCCARTESIANPOINT')
          if (pt) return point3(pt)
          const t = trim.map(num).find((x) => x !== null)
          if (basis?.type === 'IFCLINE' && t !== undefined && t !== null) {
            const vec = get(basis.args[1])
            const d = dir3(vec?.args[0], [1, 0, 0])
            return add(point3(basis.args[0]), scale(d, t * (num(vec?.args[1]) ?? 1)))
          }
          return null
        })
        return ends.every((e) => e) ? ends.map((e): [number, number] => [e![0], e![1]]) : []
      }
      case 'IFCCIRCLE': {
        const m = axis(c.args[0])
        const r = num(c.args[1]) ?? 0
        return Array.from({ length: 16 }, (_, i): [number, number] => {
          const p = apply(m, [r * Math.cos((i * Math.PI) / 8), r * Math.sin((i * Math.PI) / 8), 0])
          return [p[0], p[1]]
        })
      }
    }
    return []
  }
  const closed = (pts: Array<[number, number]>) => {
    const out = pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1])
    if (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop()
    return out
  }
  const profile = (
    v: StepValue | undefined,
  ): {
    outer: Array<[number, number]>
    holes: Array<Array<[number, number]>>
    rect?: { m: M; w: number; d: number }
  } | null => {
    const p = get(v)
    if (!p) return null
    if (/^IFC(ROUNDED)?RECTANGLE(HOLLOW)?PROFILEDEF$/.test(p.type)) {
      const m = axis(p.args[2])
      const w = num(p.args[3]) ?? 0
      const d = num(p.args[4]) ?? 0
      const corners: V3[] = [
        [-w / 2, -d / 2, 0],
        [w / 2, -d / 2, 0],
        [w / 2, d / 2, 0],
        [-w / 2, d / 2, 0],
      ]
      return {
        outer: corners.map((q) => apply(m, q)).map((q): [number, number] => [q[0], q[1]]),
        holes: [],
        rect: { m, w, d },
      }
    }
    if (p.type === 'IFCCIRCLEPROFILEDEF') {
      const m = axis(p.args[2])
      const r = num(p.args[3]) ?? 0
      const outer = Array.from({ length: 16 }, (_, i): [number, number] => {
        const q = apply(m, [r * Math.cos((i * Math.PI) / 8), r * Math.sin((i * Math.PI) / 8), 0])
        return [q[0], q[1]]
      })
      return { outer, holes: [] }
    }
    if (p.type === 'IFCARBITRARYCLOSEDPROFILEDEF' || p.type === 'IFCARBITRARYPROFILEDEFWITHVOIDS') {
      const outer = closed(curve(p.args[2]))
      const holes = p.type === 'IFCARBITRARYPROFILEDEFWITHVOIDS' ? list(p.args[3]).map((c) => closed(curve(c))) : []
      return outer.length >= 3 ? { outer, holes: holes.filter((h) => h.length >= 3) } : null
    }
    return null
  }

  // ── Solids, as footprints in the world.
  const solids = (item: StepEntity | undefined, m: M, out: Part[], depth = 0): void => {
    if (!item || depth > 20) return
    switch (item.type) {
      case 'IFCEXTRUDEDAREASOLID': {
        const pr = profile(item.args[0])
        if (!pr) return
        const pos = compose(m, axis(item.args[1]))
        const dir = norm(turn(pos, dir3(item.args[2], [0, 0, 1])))
        const depthV = num(item.args[3]) ?? 0
        // Only what stands up from the floor has a footprint.
        if (Math.abs(dir[2]) < 0.99) return
        const xy = (q: [number, number]): [number, number] => {
          const w = apply(pos, [q[0], q[1], 0])
          return [w[0], w[1]]
        }
        const za = pos.o[2]
        const zb = za + dir[2] * depthV
        out.push({
          outer: pr.outer.map(xy),
          holes: pr.holes.map((h) => h.map(xy)),
          z0: Math.min(za, zb),
          z1: Math.max(za, zb),
          rect: pr.rect ? { m: compose(pos, pr.rect.m), w: pr.rect.w, d: pr.rect.d } : undefined,
        })
        return
      }
      case 'IFCBOOLEANCLIPPINGRESULT':
      case 'IFCBOOLEANRESULT':
        // What is cut away (a wall's top under a roof) changes no footprint the plan needs.
        if (en(item.args[0]) !== 'INTERSECTION') solids(get(item.args[1]), m, out, depth + 1)
        return
      case 'IFCMAPPEDITEM': {
        const map = get(item.args[0])
        const target = compose(m, compose(operator(item.args[1]), axis(map?.args[0])))
        for (const it of list(get(map?.args[1])?.args[3])) solids(get(it), target, out, depth + 1)
        return
      }
      case 'IFCTRIANGULATEDFACESET':
      case 'IFCPOLYGONALFACESET':
      case 'IFCFACETEDBREP': {
        // A mesh: the box round its points, which is what a plan can say of it.
        let pts: V3[] = []
        if (item.type === 'IFCFACETEDBREP') {
          for (const f of list(get(item.args[0])?.args[0]))
            for (const b of list(get(f)?.args[0]))
              for (const q of list(get(get(b)?.args[0])?.args[0])) pts.push(point3(q))
        } else pts = list(get(item.args[0])?.args[0]).map((q) => list(q).map((x) => num(x) ?? 0) as V3)
        if (pts.length < 3) return
        const w = pts.map((q) => apply(m, q))
        out.push({
          outer: hull(w.map((q): [number, number] => [q[0], q[1]])),
          holes: [],
          z0: Math.min(...w.map((q) => q[2])),
          z1: Math.max(...w.map((q) => q[2])),
        })
        return
      }
    }
  }
  /** The body of a product, in the world: its solids' footprints, from its Body representation or else its FootPrint. */
  const body = (p: StepEntity): Part[] => {
    const m = placement(p.args[5])
    const reps = list(get(p.args[6])?.args[2])
      .map(get)
      .filter((r): r is StepEntity => !!r)
    const pick = (id: string) => reps.filter((r) => (str(r.args[1]) ?? '').toLowerCase() === id)
    for (const r of [...pick('body'), ...pick('footprint'), ...reps]) {
      const out: Part[] = []
      for (const it of list(r.args[3])) solids(get(it), m, out)
      if (out.length) return out
    }
    return []
  }
  /** A product's Axis, as its two ends in the world (IFC's X and Y). */
  const axisLine = (p: StepEntity): Array<[number, number]> => {
    const m = placement(p.args[5])
    for (const r of list(get(p.args[6])?.args[2]).map(get)) {
      if ((str(r?.args[1]) ?? '').toLowerCase() !== 'axis') continue
      for (const it of list(r?.args[3])) {
        const pts = curve(it)
        if (pts.length >= 2) {
          const w = [pts[0], pts[pts.length - 1]].map((q) => apply(m, [q[0], q[1], 0]))
          return w.map((q): [number, number] => [q[0], q[1]])
        }
      }
    }
    return []
  }

  // ── Relationships.
  const parent = new Map<number, number>()
  const children = (rel: string, from: number, to: number) => {
    for (const r of byType(rel)) {
      const target = get(r.args[from])
      if (!target) continue
      for (const c of list(r.args[to])) {
        const e = get(c)
        if (e && !parent.has(e.id)) parent.set(e.id, target.id)
      }
    }
  }
  children('IFCRELCONTAINEDINSPATIALSTRUCTURE', 5, 4)
  children('IFCRELAGGREGATES', 4, 5)
  children('IFCRELNESTS', 4, 5)
  const voids = new Map<number, number>() // opening -> wall
  for (const r of byType('IFCRELVOIDSELEMENT')) {
    const w = get(r.args[4])
    const o = get(r.args[5])
    if (w && o) voids.set(o.id, w.id)
  }
  const fills = new Map<number, number>() // opening -> door or window
  for (const r of byType('IFCRELFILLSELEMENT')) {
    const o = get(r.args[4])
    const f = get(r.args[5])
    if (o && f) fills.set(o.id, f.id)
  }
  const connected = new Map<number, number[]>()
  for (const r of byType('IFCRELCONNECTSELEMENTS')) {
    const a = get(r.args[5])
    const b = get(r.args[6])
    if (a && b) connected.set(a.id, [...(connected.get(a.id) ?? []), b.id])
  }
  // Property sets: entity -> set name -> property -> value.
  const props = new Map<number, Map<string, Map<string, StepValue>>>()
  for (const r of byType('IFCRELDEFINESBYPROPERTIES')) {
    const set = get(r.args[5])
    if (set?.type !== 'IFCPROPERTYSET') continue
    const name = str(set.args[2]) ?? ''
    const values = new Map<string, StepValue>()
    for (const pv of list(set.args[4]).map(get))
      if (pv?.type === 'IFCPROPERTYSINGLEVALUE') values.set(str(pv.args[0]) ?? '', pv.args[2])
    for (const o of list(r.args[4])) {
      const e = get(o)
      if (!e) continue
      if (!props.has(e.id)) props.set(e.id, new Map())
      props.get(e.id)!.set(name, values)
    }
  }
  const prop = (e: StepEntity, set: string, name: string) => props.get(e.id)?.get(set)?.get(name)
  // Layered materials: a wall's thickness when its body cannot say.
  const layers = new Map<number, number>()
  for (const r of byType('IFCRELASSOCIATESMATERIAL')) {
    let mat = get(r.args[5])
    if (mat?.type === 'IFCMATERIALLAYERSETUSAGE') mat = get(mat.args[0])
    if (mat?.type !== 'IFCMATERIALLAYERSET') continue
    const t = list(mat.args[0]).reduce<number>((s, l) => s + (num(get(l)?.args[1]) ?? 0), 0)
    for (const o of list(r.args[4])) {
      const e = get(o)
      if (e && t > 0) layers.set(e.id, t)
    }
  }

  // ── Storeys.
  const storeyEnts = byType('IFCBUILDINGSTOREY')
  if (!storeyEnts.length)
    throw new IfcError('The file has no storeys (IfcBuildingStorey), so there is no floor to read.')
  const elevation = (s: StepEntity) => num(s.args[9]) ?? placement(s.args[5]).o[2]
  storeyEnts.sort((a, b) => elevation(a) - elevation(b))
  const ground = storeyEnts.reduce((best, s) => (Math.abs(elevation(s)) < Math.abs(elevation(best)) ? s : best))
  const storeyOf = (e: StepEntity): StepEntity | undefined => {
    let id: number | undefined = e.id
    for (let k = 0; id !== undefined && k < 50; k++) {
      const x = ents.get(id)
      if (x?.type === 'IFCBUILDINGSTOREY') return x
      id = parent.get(id)
    }
    return undefined
  }
  const takenSpace = new Set<string>()
  const slug = (s: string, fallback: string, taken: Set<string>) => {
    let base =
      s
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || fallback
    if (!ID.test(base)) base = fallback
    let id = base
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
    taken.add(id)
    return id
  }
  const takenStorey = new Set<string>()
  interface Floor {
    ent: StepEntity
    storey: Storey
    /** The storey's floor, in the file's units, from which heights on it are measured. */
    z: number
    ids: Set<string>
    walls: Array<{ wall: Wall; ent: StepEntity }>
  }
  const gi = storeyEnts.indexOf(ground)
  const floors: Floor[] = storeyEnts.map((s, i) => {
    const name = (str(s.args[2]) || str(s.args[7]) || `Floor ${i - gi}`).slice(0, 80)
    return {
      ent: s,
      z: elevation(s),
      ids: new Set(),
      walls: [],
      storey: {
        id: slug(name, `storey-${i}`, takenStorey),
        name,
        level: i - gi,
        elevation: mm(elevation(s)),
        height: DEFAULTS.storeyHeight,
        walls: [],
        spaces: [],
        openings: [],
        radiators: [],
        furniture: [],
        placements: [],
      },
    }
  })
  const floorOf = new Map(floors.map((f) => [f.ent.id, f]))
  const floorFor = (e: StepEntity): Floor => {
    const s = storeyOf(e)
    if (s && floorOf.has(s.id)) return floorOf.get(s.id)!
    // Not placed in a storey: the one it stands in, by height.
    const z = placement(e.args[5]).o[2]
    return floors.filter((f) => f.z <= z + 1e-6).pop() ?? floors[0]
  }
  const elementId = (f: Floor, e: StepEntity, prefix: string) => {
    const tag = str(e.args[7])
    if (tag && ID.test(tag) && !f.ids.has(tag)) {
      f.ids.add(tag)
      return tag
    }
    let n = 1
    while (f.ids.has(`${prefix}${n}`)) n++
    f.ids.add(`${prefix}${n}`)
    return `${prefix}${n}`
  }

  // Plan points are IFC (X, -Y), in millimetres, moved onto the plot at the end.
  const P = (q: [number, number]): Point => [q[0] * K, -q[1] * K]
  const skipped = new Map<string, number>()
  const skip = (what: string) => skipped.set(what, (skipped.get(what) ?? 0) + 1)

  // ── Walls.
  for (const e of [...ents.values()].filter((x) => WALLS.has(x.type))) {
    const f = floorFor(e)
    const parts = body(e)
    const ax = axisLine(e).map(P)
    let a: Point | null = null
    let b: Point | null = null
    let thickness = layers.get(e.id) !== undefined ? layers.get(e.id)! * K : null
    const part = parts[0]
    if (ax.length === 2 && Math.hypot(ax[1][0] - ax[0][0], ax[1][1] - ax[0][1]) > 1) {
      ;[a, b] = ax
      // The body says where the wall is across its axis and how thick it is.
      if (part) {
        const u = unit2(a, b)
        const n: Point = [-u[1], u[0]]
        const across = part.outer.map(P).map((q) => (q[0] - a![0]) * n[0] + (q[1] - a![1]) * n[1])
        const lo = Math.min(...across)
        const hi = Math.max(...across)
        if (hi - lo > 1) {
          thickness = hi - lo
          const mid = (lo + hi) / 2
          a = [a[0] + n[0] * mid, a[1] + n[1] * mid]
          b = [b[0] + n[0] * mid, b[1] + n[1] * mid]
        }
      }
    } else if (part?.rect && parts.length === 1) {
      // An extruded rectangle: its long middle line.
      const { m, w, d } = part.rect
      const long = w >= d
      const along = long ? m.x : m.y
      const half = (long ? w : d) / 2
      const s = add(m.o, scale(along, -half))
      const t = add(m.o, scale(along, half))
      a = P([s[0], s[1]])
      b = P([t[0], t[1]])
      thickness = (long ? d : w) * K
    } else if (part) {
      const mid = middleLine(part.outer.map(P))
      if (mid) {
        ;[a, b] = mid.ends
        thickness = mid.width
      }
    }
    if (!a || !b || Math.hypot(b[0] - a[0], b[1] - a[1]) < 10) {
      skip('walls with no shape this reader understands')
      continue
    }
    const height = part
      ? (Math.max(...parts.map((q) => q.z1)) - Math.min(...parts.map((q) => q.z0))) * K
      : DEFAULTS.wallHeight
    const wall: Wall = {
      id: elementId(f, e, 'w'),
      a: [Math.round(a[0]), Math.round(a[1])],
      b: [Math.round(b[0]), Math.round(b[1])],
      thickness: clampInt(thickness ?? 200, 10, 2000),
      height: clampInt(height, 100, 20_000),
    }
    f.storey.walls.push(wall)
    f.walls.push({ wall, ent: e })
  }
  const curtain = byType('IFCCURTAINWALL').length
  if (curtain)
    notes.push(`${curtain} curtain wall${curtain === 1 ? ' was' : 's were'} left out: draw them as walls with windows.`)

  // ── Doors, windows and open stretches, by the openings that void the walls.
  const wallOf = new Map<number, { f: Floor; wall: Wall }>()
  for (const f of floors) for (const w of f.walls) wallOf.set(w.ent.id, { f, wall: w.wall })
  for (const [openingId, wallId] of voids) {
    const host = wallOf.get(wallId)
    const op = ents.get(openingId)
    if (!host || !op) continue
    const { f, wall } = host
    const fill = fills.has(openingId) ? ents.get(fills.get(openingId)!) : undefined
    const len = Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1])
    const u = unit2(wall.a, wall.b)
    const along = (q: Point) => (q[0] - wall.a[0]) * u[0] + (q[1] - wall.a[1]) * u[1]
    const opParts = body(op)
    const fillParts = fill ? body(fill) : []
    const span = (parts: Part[]) => {
      const ts = parts.flatMap((p) => p.outer.map(P)).map(along)
      return ts.length ? [Math.max(0, Math.min(...ts)), Math.min(len, Math.max(...ts))] : null
    }
    let s = span(opParts) ?? span(fillParts)
    if (!s && fill) {
      const o = placement(fill.args[5]).o
      const t0 = along(P([o[0], o[1]]))
      const w = (num(fill.args[9]) ?? 0) * K
      s = [Math.max(0, t0), Math.min(len, t0 + w)]
    }
    if (!s || s[1] - s[0] < 50) {
      skip(fill ? `${fill.type === 'IFCDOOR' ? 'doors' : 'windows'} that fit no wall` : 'openings that fit no wall')
      continue
    }
    const at = Math.round(s[0])
    const width = Math.min(Math.round(s[1] - s[0]), Math.floor(len) - at)
    if (width < 1 || at >= Math.floor(len)) continue
    const zs = (fillParts.length ? fillParts : opParts).flatMap((p) => [p.z0, p.z1])
    let sill = zs.length ? Math.round((Math.min(...zs) - f.z) * K) : 0
    let head = zs.length ? Math.round((Math.max(...zs) - f.z) * K) : wall.height
    const pSill = num(fill ? prop(fill, 'House_Opening', 'SillHeight') : undefined)
    const pHead = num(fill ? prop(fill, 'House_Opening', 'HeadHeight') : undefined)
    if (pSill !== null) sill = Math.round(pSill * K)
    if (pHead !== null) head = Math.round(pHead * K)
    sill = Math.max(0, sill)
    head = Math.max(sill + 1, head)
    const base = { id: '', wall: wall.id, at, width }
    let opening: Opening
    if (!fill || (fill.type !== 'IFCDOOR' && fill.type !== 'IFCWINDOW')) {
      // A hole with nothing in it is an open stretch of wall only when it runs floor to top.
      if (sill > 10 || head < wall.height - 10) {
        skip('recesses and holes that are not doors or windows')
        continue
      }
      opening = { ...base, id: elementId(f, op, 'o'), kind: 'gap' }
    } else {
      const label = (n: string) => str(prop(fill, 'House_Opening', n))
      const ours = !!props.get(fill.id)?.has('House_Opening')
      const opType = en(fill.args[11])
      const user = str(fill.args[12]) ?? ''
      // A hinge on the left, seen with the door's own frame: ours runs the other way when it faces back.
      const fm = placement(fill.args[5])
      const backwards = fm.x[0] * u[0] + -fm.x[1] * u[1] < 0
      const side = (s: 'start' | 'end') => (backwards ? (s === 'start' ? 'end' : 'start') : s)
      const frameMaterial = label('FrameMaterial')
      const frameColour = label('FrameColour')
      const frame: { material?: (typeof FRAME_MATERIALS)[number]; colour?: string } = {}
      if (frameMaterial && (FRAME_MATERIALS as readonly string[]).includes(frameMaterial))
        frame.material = frameMaterial as (typeof FRAME_MATERIALS)[number]
      if (frameColour && /^#[0-9a-fA-F]{6}$/.test(frameColour)) frame.colour = frameColour.toLowerCase()
      const hinge = label('Hinge')
      const opens = label('Opens')
      const extra = {
        sill,
        head,
        ...(frame.material || frame.colour ? { frame } : {}),
        ...(hinge === 'start' || hinge === 'end' ? { hinge: hinge as 'start' | 'end' } : {}),
        ...(opens === 'left' || opens === 'right' ? { opens: opens as 'left' | 'right' } : {}),
      }
      const id = elementId(f, fill, fill.type === 'IFCDOOR' ? 'd' : 'win')
      if (fill.type === 'IFCDOOR') {
        let operation = label('Operation')
        let hingeFromType: 'start' | 'end' | undefined
        // One of our own files says how it opens in House_Opening. Another says it in OperationType.
        if (!ours && (!operation || !(DOOR_OPERATIONS as readonly string[]).includes(operation))) {
          const t = opType ?? ''
          operation = /SLIDING/.test(t)
            ? 'sliding'
            : /FOLDING/.test(t)
              ? 'folding'
              : /DOUBLE_DOOR_SINGLE_SWING|DOUBLE_SWING/.test(t)
                ? 'double-swing'
                : t === 'USERDEFINED' && /LIFT/.test(user)
                  ? 'lift-slide'
                  : t === 'USERDEFINED' && /POCKET/.test(user)
                    ? 'pocket'
                    : 'swing'
          if (/_LEFT$/.test(t)) hingeFromType = side('start')
          else if (/_RIGHT$/.test(t)) hingeFromType = side('end')
        }
        const leaf = label('Leaf')
        opening = {
          ...base,
          ...extra,
          ...(extra.hinge || !hingeFromType ? {} : { hinge: hingeFromType }),
          id,
          kind: 'door',
          operation:
            operation && (DOOR_OPERATIONS as readonly string[]).includes(operation)
              ? (operation as (typeof DOOR_OPERATIONS)[number])
              : 'swing',
          leaf: leaf && (LEAVES as readonly string[]).includes(leaf) ? (leaf as (typeof LEAVES)[number]) : 'solid',
        }
      } else {
        const operation = label('Operation')
        opening = {
          ...base,
          ...extra,
          id,
          kind: 'window',
          operation:
            operation && (WINDOW_OPERATIONS as readonly string[]).includes(operation)
              ? (operation as (typeof WINDOW_OPERATIONS)[number])
              : 'casement',
        }
      }
      // What covers its glass.
      if (opening.kind === 'window' || opening.leaf !== 'solid') {
        const taken = new Set<string>()
        const coverings: Covering[] = []
        for (const cid of connected.get(fill.id) ?? []) {
          const c = ents.get(cid)
          if (c?.type !== 'IFCSHADINGDEVICE') continue
          const kind = str(prop(c, 'House_Covering', 'Kind'))
          const t = en(c.args[8])
          const k: Covering['kind'] | null =
            kind && (COVERING_KINDS as readonly string[]).includes(kind)
              ? (kind as Covering['kind'])
              : t === 'SHUTTER'
                ? 'shutter'
                : t === 'JALOUSIE'
                  ? 'external-blind'
                  : t === 'AWNING'
                    ? 'awning'
                    : null
          if (!k || coverings.length >= 6) continue
          const sideLabel = str(prop(c, 'House_Covering', 'Side'))
          const tag = str(c.args[7])
          let cId = tag && ID.test(tag) && !taken.has(tag) ? tag : ''
          for (let n = 1; !cId || taken.has(cId); n++) cId = `c${n}`
          taken.add(cId)
          coverings.push({ id: cId, kind: k, side: sideLabel === 'inside' ? 'inside' : 'outside' })
        }
        if (coverings.length) opening.coverings = coverings
      }
    }
    f.storey.openings.push(opening)
  }
  const filled = new Set(fills.values())
  const unhosted = byType('IFCDOOR', 'IFCWINDOW').filter((d) => !filled.has(d.id)).length
  if (unhosted) skipped.set('doors and windows in no opening of a wall', unhosted)

  // ── Spaces.
  for (const e of byType('IFCSPACE')) {
    const f = floorFor(e)
    const parts = body(e)
    const part = parts.reduce<Part | undefined>(
      (best, q) => (!best || Math.abs(polyArea(q.outer)) > Math.abs(polyArea(best.outer)) ? q : best),
      undefined,
    )
    if (!part) {
      skip('spaces with no shape')
      continue
    }
    const name = (str(e.args[7]) || str(e.args[2]) || 'Room').trim().slice(0, 80) || 'Room'
    const type = en(e.args[9])
    const objectType = (str(e.args[4]) ?? '').toLowerCase()
    const kind: SpaceKind =
      objectType === 'pool' ? 'pool' : objectType === 'paving' ? 'paved' : type === 'EXTERNAL' ? 'outdoor' : 'room'
    const ring = (pts: Array<[number, number]>) => clockwise(tidyLoop(pts.map(P)))
    const outline = ring(part.outer)
    if (outline.length < 3) {
      skip('spaces with no shape')
      continue
    }
    const space: Space = { id: slug(name, 'space', takenSpace), name, kind, outline }
    const holes = part.holes.map(ring).filter((h) => h.length >= 3)
    if (holes.length) space.holes = holes
    f.storey.spaces.push(space)
  }

  // ── Radiators.
  for (const e of byType('IFCSPACEHEATER')) {
    const f = floorFor(e)
    const parts = body(e)
    const part = parts[0]
    if (!part) {
      skip('radiators with no shape')
      continue
    }
    let r: Radiator
    if (part.rect && parts.length === 1) {
      // Along its placement's x, hanging on the side its panel is.
      const m = placement(e.args[5])
      const o = P([m.o[0], m.o[1]])
      const x: Point = [m.x[0], -m.x[1]]
      const lx = Math.hypot(x[0], x[1]) || 1
      const len = Math.max(part.rect.w, part.rect.d) * K
      // The panel's middle, in the radiator's own frame: on its left is +y.
      const c = part.rect.m.o
      const local = (c[0] - m.o[0]) * m.y[0] + (c[1] - m.o[1]) * m.y[1]
      r = {
        id: elementId(f, e, 'r'),
        a: [Math.round(o[0]), Math.round(o[1])],
        b: [Math.round(o[0] + (x[0] / lx) * len), Math.round(o[1] + (x[1] / lx) * len)],
        side: local >= 0 ? 'left' : 'right',
      }
    } else {
      const mid = middleLine(part.outer.map(P))
      if (!mid) continue
      r = {
        id: elementId(f, e, 'r'),
        a: mid.ends[0].map(Math.round) as Point,
        b: mid.ends[1].map(Math.round) as Point,
        side: 'left',
      }
    }
    if (r.a[0] === r.b[0] && r.a[1] === r.b[1]) continue
    f.storey.radiators.push(r)
  }

  // ── Furniture and bathroom fittings.
  const byName = new Map(Object.entries(FURNITURE_NAME).map(([k, v]) => [v.toLowerCase(), k as Furniture['kind']]))
  for (const e of [...ents.values()].filter((x) => FURNISHING.has(x.type))) {
    const f = floorFor(e)
    const parts = body(e)
    if (!parts.length) {
      skip('furniture with no shape')
      continue
    }
    const pts = parts.flatMap((q) => q.outer.map(P))
    const xs = pts.map((q) => q[0])
    const ys = pts.map((q) => q[1])
    const name = str(e.args[2]) ?? ''
    const objectType = str(e.args[4]) ?? ''
    const predefined = en(e.args[8]) ?? ''
    const kind: Furniture['kind'] =
      byName.get(name.toLowerCase()) ??
      byName.get(objectType.toLowerCase()) ??
      SANITARY_KIND[predefined] ??
      FURNITURE_WORDS.find(([re]) => re.test(`${name} ${objectType}`))?.[1] ??
      'cabinet'
    const x = Math.round(Math.min(...xs))
    const y = Math.round(Math.min(...ys))
    const u: Furniture = {
      id: elementId(f, e, 'f'),
      kind: (FURNITURE_KINDS as readonly string[]).includes(kind) ? kind : 'cabinet',
      x,
      y,
      w: Math.max(1, Math.round(Math.max(...xs)) - x),
      d: Math.max(1, Math.round(Math.max(...ys)) - y),
    }
    const height = Math.round((Math.max(...parts.map((q) => q.z1)) - Math.min(...parts.map((q) => q.z0))) * K)
    if (height >= 100 && height <= 3000 && Math.abs(height - FURNITURE_HEIGHT[u.kind]) > 1) u.height = height
    f.storey.furniture.push(u)
  }

  // ── Rooms drawn to the inside of their walls are moved out to the walls' middles, as the plan draws them.
  for (const f of floors)
    for (const s of f.storey.spaces) if (s.kind === 'room') s.outline = toWallLines(s.outline, f.storey.walls)

  // ── Storey heights: up to the next storey, the top one as high as its walls need.
  floors.forEach((f, i) => {
    const next = floors[i + 1]
    const walls = Math.max(0, ...f.storey.walls.map((w) => w.height))
    f.storey.height = clampInt(
      next ? next.storey.elevation - f.storey.elevation : Math.max(DEFAULTS.storeyHeight, walls + 300),
      1000,
      20_000,
    )
  })
  // Two storeys at one height cannot both be a level: the second is folded into the first.
  const levels = new Map<number, Floor>()
  for (const f of floors) {
    const twin = [...levels.values()].find((g) => g.storey.elevation === f.storey.elevation)
    if (twin) {
      notes.push(`"${f.storey.name}" is at the same height as "${twin.storey.name}", so it was joined to it.`)
      twin.storey.walls.push(...f.storey.walls)
      twin.storey.spaces.push(...f.storey.spaces)
      twin.storey.openings.push(...f.storey.openings)
      twin.storey.radiators.push(...f.storey.radiators)
      twin.storey.furniture.push(...f.storey.furniture)
    } else levels.set(f.storey.level, f)
  }
  const storeys = [...levels.values()].map((f) => f.storey)

  // ── The plot: the file's own, when it is one of ours; else round what was read.
  const all: Point[] = storeys.flatMap((s) => [
    ...s.walls.flatMap((w) => {
      const h = w.thickness / 2
      return [w.a, w.b].flatMap((q): Point[] => [
        [q[0] - h, q[1] - h],
        [q[0] + h, q[1] + h],
      ])
    }),
    ...s.spaces.flatMap((x) => x.outline),
    ...s.radiators.flatMap((r) => [r.a, r.b]),
    ...s.furniture.flatMap((u): Point[] => [
      [u.x, u.y],
      [u.x + u.w, u.y + u.d],
    ]),
  ])
  if (!all.length)
    throw new IfcError('Nothing in the file could be read as part of a house: no walls, rooms or furniture.')
  const site = byType('IFCSITE')[0]
  const given = site
    ? {
        w: num(prop(site, 'House_Site', 'Width')),
        h: num(prop(site, 'House_Site', 'Depth')),
        snap: num(prop(site, 'House_Site', 'Snap')),
      }
    : null
  const minX = Math.min(...all.map((q) => q[0]))
  const minY = Math.min(...all.map((q) => q[1]))
  // Onto the plot, by whole half metres so a grid in the file stays on the editor's.
  const MARGIN = 1000
  const dx = minX < 0 || !given?.w ? Math.ceil((MARGIN - minX) / 500) * 500 : 0
  const dy = minY < 0 || !given?.h ? Math.ceil((MARGIN - minY) / 500) * 500 : 0
  const shift = (q: Point): Point => [q[0] + dx, q[1] + dy]
  if (dx || dy)
    for (const s of storeys) {
      for (const w of s.walls) Object.assign(w, { a: shift(w.a), b: shift(w.b) })
      for (const x of s.spaces) {
        x.outline = x.outline.map(shift)
        if (x.holes) x.holes = x.holes.map((h) => h.map(shift))
      }
      for (const r of s.radiators) Object.assign(r, { a: shift(r.a), b: shift(r.b) })
      for (const u of s.furniture) Object.assign(u, { x: u.x + dx, y: u.y + dy })
    }
  const maxX = Math.max(...all.map((q) => q[0])) + dx
  const maxY = Math.max(...all.map((q) => q[1])) + dy
  const fitW = Math.ceil((maxX + MARGIN) / 500) * 500
  const fitH = Math.ceil((maxY + MARGIN) / 500) * 500
  const siteSize = {
    w: given?.w && !dx && mm(given.w) >= maxX ? mm(given.w) : fitW,
    h: given?.h && !dy && mm(given.h) >= maxY ? mm(given.h) : fitH,
  }
  if (siteSize.w > 200_000 || siteSize.h > 200_000)
    throw new IfcError('What the file holds is more than 200 m across, more than a house plan can take.')
  // Furniture stays on the plot.
  for (const s of storeys)
    for (const u of s.furniture) {
      u.x = clampInt(u.x, 0, siteSize.w - 1)
      u.y = clampInt(u.y, 0, siteSize.h - 1)
      u.w = clampInt(u.w, 1, siteSize.w - u.x)
      u.d = clampInt(u.d, 1, siteSize.h - u.y)
    }
  const snap = given?.snap ? clampInt(mm(given.snap), 1, 10_000) : 10

  for (const [what, n] of skipped) notes.push(`Left out ${what}: ${n}.`)
  const plan: Plan = { version: PLAN_VERSION, unit: 'mm', site: siteSize, snap, storeys }
  try {
    // Through JSON, which also turns the -0 that flipping IFC's Y leaves into 0.
    return { plan: validatePlan(JSON.parse(JSON.stringify(plan))), notes }
  } catch (e) {
    if (e instanceof PlanError) throw new IfcError(`The file was read, but what it gave is not a plan: ${e.message}`)
    throw e
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const clampInt = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)))

function unit2(a: Point, b: Point): Point {
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
  return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]
}

function polyArea(pts: Array<[number, number]>): number {
  let s = 0
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]
    const [x2, y2] = pts[(i + 1) % pts.length]
    s += x1 * y2 - x2 * y1
  }
  return s / 2
}

/** The convex hull of points, for the footprint of a mesh. */
function hull(pts: Array<[number, number]>): Array<[number, number]> {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (p.length < 3) return p
  const turnOf = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: Array<[number, number]> = []
  for (const q of p) {
    while (lower.length >= 2 && turnOf(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop()
    lower.push(q)
  }
  const upper: Array<[number, number]> = []
  for (const q of p.reverse()) {
    while (upper.length >= 2 && turnOf(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop()
    upper.push(q)
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

/**
 * The middle line of a long footprint: along its longest edge, from the
 * middle of where its two long sides start to the middle of where they end,
 * so a wall cut at an angle where it meets another ends on its centre line.
 */
function middleLine(pts: Point[]): { ends: [Point, Point]; width: number } | null {
  if (pts.length < 3) return null
  let best = -1
  let u: Point = [1, 0]
  pts.forEach((p, i) => {
    const q = pts[(i + 1) % pts.length]
    const l = Math.hypot(q[0] - p[0], q[1] - p[1])
    if (l > best) {
      best = l
      u = [(q[0] - p[0]) / l, (q[1] - p[1]) / l]
    }
  })
  if (u[0] < 0 || (u[0] === 0 && u[1] < 0)) u = [-u[0], -u[1]]
  const n: Point = [-u[1], u[0]]
  const al = (q: Point) => q[0] * u[0] + q[1] * u[1]
  const ac = (q: Point) => q[0] * n[0] + q[1] * n[1]
  const across = pts.map(ac)
  const lo = Math.min(...across)
  const hi = Math.max(...across)
  const mid = (lo + hi) / 2
  // The two long sides: edges running along u, on either side of the middle.
  const sides: Array<[number, number]> = [
    [Infinity, -Infinity],
    [Infinity, -Infinity],
  ]
  pts.forEach((p, i) => {
    const q = pts[(i + 1) % pts.length]
    const l = Math.hypot(q[0] - p[0], q[1] - p[1])
    if (!l || Math.abs(((q[0] - p[0]) * n[0] + (q[1] - p[1]) * n[1]) / l) > 0.035) return
    const k = ac(p) < mid ? 0 : 1
    sides[k] = [Math.min(sides[k][0], al(p), al(q)), Math.max(sides[k][1], al(p), al(q))]
  })
  const all = pts.map(al)
  const ok = sides.every((s) => s[0] <= s[1])
  const t0 = ok ? (sides[0][0] + sides[1][0]) / 2 : Math.min(...all)
  const t1 = ok ? (sides[0][1] + sides[1][1]) / 2 : Math.max(...all)
  const at = (t: number): Point => [u[0] * t + n[0] * mid, u[1] * t + n[1] * mid]
  return { ends: [at(t0), at(t1)], width: hi - lo }
}

/** A loop in whole millimetres, without repeated points or corners on a straight line. */
function tidyLoop(pts: Point[]): Point[] {
  let out = pts.map((q): Point => [Math.round(q[0]), Math.round(q[1])])
  out = out.filter((q, i) => {
    const p = out[(i + out.length - 1) % out.length]
    return q[0] !== p[0] || q[1] !== p[1]
  })
  for (let changed = true; changed && out.length > 3; ) {
    changed = false
    for (let i = 0; i < out.length; i++) {
      const p = out[(i + out.length - 1) % out.length]
      const q = out[i]
      const r = out[(i + 1) % out.length]
      if ((q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0]) === 0) {
        out.splice(i, 1)
        changed = true
        break
      }
    }
  }
  return out
}

/** Clockwise on the plan as drawn, as version 2 keeps outlines. */
function clockwise(pts: Point[]): Point[] {
  return loopArea(pts) < 0 ? [...pts].reverse() : pts
}

/**
 * A room drawn to the inside faces of its walls, as most tools draw one,
 * moved out to the walls' middle lines, as the plan draws rooms: each edge
 * that runs along a wall at half its thickness moves onto that wall's line,
 * and the corners are where the moved edges meet again.
 */
function toWallLines(outline: Point[], walls: Wall[]): Point[] {
  const n = outline.length
  const lines = outline.map((p, i) => {
    const q = outline[(i + 1) % n]
    const u = unit2(p, q)
    const len = Math.hypot(q[0] - p[0], q[1] - p[1])
    let move = 0
    let found = Infinity
    for (const w of walls) {
      const wu = unit2(w.a, w.b)
      if (Math.abs(u[0] * wu[1] - u[1] * wu[0]) > 0.0175) continue
      // How far the edge is from the wall's middle line, and whether they run side by side.
      const nn: Point = [-wu[1], wu[0]]
      const d = (p[0] - w.a[0]) * nn[0] + (p[1] - w.a[1]) * nn[1]
      const half = w.thickness / 2
      if (Math.abs(Math.abs(d) - half) > Math.max(25, half * 0.15)) continue
      const t = (x: Point) => (x[0] - w.a[0]) * wu[0] + (x[1] - w.a[1]) * wu[1]
      const wl = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1])
      const [e0, e1] = [t(p), t(q)].sort((x, y) => x - y)
      const overlap = Math.min(e1, wl + half) - Math.max(e0, -half)
      if (overlap < Math.min(len, wl) * 0.5) continue
      if (Math.abs(d) < found) {
        found = Math.abs(d)
        // Moved by -d along the wall's normal, onto its line.
        move = -d * (nn[0] * -u[1] + nn[1] * u[0])
      }
    }
    // Offset along this edge's own left normal.
    const ln: Point = [-u[1], u[0]]
    return { p: [p[0] + ln[0] * move, p[1] + ln[1] * move] as Point, u }
  })
  const out = lines.map((l, i) => {
    const prev = lines[(i + n - 1) % n]
    const den = prev.u[0] * l.u[1] - prev.u[1] * l.u[0]
    if (Math.abs(den) < 1e-9) return l.p
    const t = ((l.p[0] - prev.p[0]) * l.u[1] - (l.p[1] - prev.p[1]) * l.u[0]) / den
    return [prev.p[0] + prev.u[0] * t, prev.p[1] + prev.u[1] * t] as Point
  })
  return clockwise(tidyLoop(out))
}

/**
 * Keep the ids a plan already uses for what the import brings back: a storey
 * by its level, a space by its name on that storey. Device placements and
 * anything else that names them then still find them.
 */
export function adoptIds(
  plan: Plan,
  previous: { storeys: Array<{ id: string; level: number; spaces: Array<{ id: string; name: string }> }> },
): Plan {
  const storeyIds = new Set(plan.storeys.map((s) => s.id))
  const spaceIds = new Set(plan.storeys.flatMap((s) => s.spaces.map((x) => x.id)))
  for (const s of plan.storeys) {
    const was = previous.storeys.find((p) => p.level === s.level)
    if (!was) continue
    if (was.id !== s.id && !storeyIds.has(was.id)) {
      storeyIds.delete(s.id)
      s.id = was.id
      storeyIds.add(was.id)
    }
    const used = new Set<string>()
    for (const x of s.spaces) {
      const match = was.spaces.find(
        (q) => q.name.trim().toLowerCase() === x.name.trim().toLowerCase() && !used.has(q.id),
      )
      if (!match) continue
      used.add(match.id)
      if (match.id === x.id || spaceIds.has(match.id)) continue
      spaceIds.delete(x.id)
      x.id = match.id
      spaceIds.add(match.id)
    }
  }
  return plan
}
