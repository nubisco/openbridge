/**
 * The house plan (version 2) as IFC4, written as a STEP file (`.ifc`). See
 * "The IFC export" in docs/design/house-bim.md for the mapping.
 *
 * Our own writer: no WebAssembly, no Node, no DOM, so it runs in the browser
 * and in the daemon alike. Nothing here knows OpenBridge's devices: what a
 * placed device is in IFC is handed in by the caller, by its reference.
 *
 * Coordinates: the plan's x runs right and its y down the page, in
 * millimetres. IFC's Y runs up the page (north), in metres, with Z up. So a
 * plan point (x, y) is IFC (x / 1000, -y / 1000), which keeps the house the
 * same way round, not mirrored, in other software.
 *
 * Every product and relationship gets a GlobalId derived from its id in the
 * plan, so exporting the same plan twice names the same things, which is
 * what other software relies on to follow changes between exports.
 */

import {
  DEFAULTS,
  isGlazed,
  type Covering,
  type Door,
  type Furniture,
  type Placement,
  type Plan,
  type Point,
  type Space,
  type Storey,
  type Wall,
  type Window,
} from './v2.js'

// ─── STEP values ────────────────────────────────────────────────────────────

/** A reference to an entity already written. */
export interface Ref {
  readonly ref: number
}
class Enum {
  constructor(readonly v: string) {}
}
class Int {
  constructor(readonly v: number) {}
}
/** A value of a named type, as properties carry them: IFCLABEL('x'). */
class Typed {
  constructor(
    readonly t: string,
    readonly v: Value,
  ) {}
}
const DERIVED = Symbol('derived')
type Value = Ref | Enum | Int | Typed | string | number | boolean | null | typeof DERIVED | Value[]

const E = (v: string) => new Enum(v)
const I = (v: number) => new Int(v)
const T = (t: string, v: Value) => new Typed(t, v)

/** A STEP string: quotes doubled, backslashes doubled, anything outside printable ASCII escaped. */
export function stepString(s: string): string {
  let out = ''
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    if (c === 0x27) out += "''"
    else if (c === 0x5c) out += '\\\\'
    else if (c >= 0x20 && c < 0x7f) out += ch
    else if (c <= 0xffff) out += `\\X2\\${c.toString(16).toUpperCase().padStart(4, '0')}\\X0\\`
    else out += `\\X4\\${c.toString(16).toUpperCase().padStart(8, '0')}\\X0\\`
  }
  return `'${out}'`
}

/** A STEP real: always with a decimal point, to the micrometre. */
export function stepReal(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`Not a number: ${n}`)
  let r = Math.round(n * 1e6) / 1e6
  if (Object.is(r, -0)) r = 0
  const s = String(r)
  if (s.includes('e')) {
    const [m, e] = r.toExponential().split('e')
    return `${m.includes('.') ? m : m + '.'}E${e}`
  }
  return s.includes('.') ? s : `${s}.`
}

function fmt(v: Value): string {
  if (v === null) return '$'
  if (v === DERIVED) return '*'
  if (typeof v === 'string') return stepString(v)
  if (typeof v === 'number') return stepReal(v)
  if (typeof v === 'boolean') return v ? '.T.' : '.F.'
  if (Array.isArray(v)) return `(${v.map(fmt).join(',')})`
  if (v instanceof Enum) return `.${v.v}.`
  if (v instanceof Int) return String(Math.round(v.v))
  if (v instanceof Typed) return `${v.t}(${fmt(v.v)})`
  return `#${v.ref}`
}

class Step {
  private lines: string[] = []
  add(type: string, ...args: Value[]): Ref {
    const ref = this.lines.length + 1
    this.lines.push(`#${ref}=${type}(${args.map(fmt).join(',')});`)
    return { ref }
  }
  get data() {
    return this.lines.join('\n')
  }
}

// ─── GlobalId ───────────────────────────────────────────────────────────────

const B64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$'

/** cyrb128: a small, well spread 128-bit hash of a string. Not for secrets. */
function hash128(s: string): [number, number, number, number] {
  let h1 = 1779033703
  let h2 = 3144134277
  let h3 = 1013904242
  let h4 = 2773480762
  for (let i = 0; i < s.length; i++) {
    const k = s.charCodeAt(i)
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067)
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233)
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213)
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179)
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067)
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233)
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213)
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179)
  h1 ^= h2 ^ h3 ^ h4
  h2 ^= h1
  h3 ^= h1
  h4 ^= h1
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0]
}

/** An IFC GlobalId (22 characters, 128 bits) that is always the same for the same key. */
export function globalId(key: string): string {
  let n = hash128(key).reduce((acc, x) => (acc << 32n) | BigInt(x), 0n)
  let out = ''
  for (let i = 0; i < 22; i++) {
    out = B64[Number(n & 63n)] + out
    n >>= 6n
  }
  return out
}

// ─── What the caller says about devices ─────────────────────────────────────

/** IFC classes a device can be exported as. Each takes a PredefinedType as its ninth attribute. */
export const DEVICE_CLASSES = [
  'IfcActuator',
  'IfcAlarm',
  'IfcAudioVisualAppliance',
  'IfcBuildingElementProxy',
  'IfcController',
  'IfcElectricAppliance',
  'IfcFlowMeter',
  'IfcLightFixture',
  'IfcOutlet',
  'IfcSensor',
  'IfcSwitchingDevice',
  'IfcUnitaryEquipment',
] as const

export interface IfcDevice {
  name: string
  ifcClass: (typeof DEVICE_CLASSES)[number]
  /** The class's PredefinedType, as written: `LIGHTSENSOR`, or `USERDEFINED` with `objectType`. */
  predefined: string
  objectType?: string
  /** Height of its middle above the floor, in millimetres. */
  z?: number
}

export interface IfcOptions {
  /** The project's and the building's name. */
  name: string
  /** The file name written in the header. */
  fileName?: string
  /** The software named in the header. */
  application?: string
  /** The time written in the header, ISO 8601. Fixed in tests so the output is stable. */
  timestamp?: string
  /** What each placed device is, by its reference. A device left out is not exported. */
  devices?: Record<string, IfcDevice>
}

// ─── The mapping's choices ──────────────────────────────────────────────────

/** Heights of furniture, in millimetres, when the plan does not give one. */
export const FURNITURE_HEIGHT: Record<Furniture['kind'], number> = {
  table: 750,
  cabinet: 900,
  island: 900,
  bed: 500,
  sofa: 800,
  shelves: 1800,
  rug: 10,
  bath: 550,
  shower: 50,
  toilet: 400,
  basin: 850,
  lounger: 350,
  parasol: 2300,
  planter: 600,
  pergola: 2500,
}

export const FURNITURE_NAME: Record<Furniture['kind'], string> = {
  table: 'Table',
  cabinet: 'Cabinet',
  island: 'Kitchen island',
  bed: 'Bed',
  sofa: 'Sofa',
  shelves: 'Shelves',
  rug: 'Rug',
  bath: 'Bath',
  shower: 'Shower',
  toilet: 'Toilet',
  basin: 'Washbasin',
  lounger: 'Sun lounger',
  parasol: 'Parasol',
  planter: 'Planter',
  pergola: 'Pergola',
}

/** Bathroom fittings are sanitary terminals in IFC, everything else furniture. */
const SANITARY: Partial<Record<Furniture['kind'], string>> = {
  bath: 'BATH',
  shower: 'SHOWER',
  toilet: 'TOILETPAN',
  basin: 'WASHHANDBASIN',
}
const FURNITURE_TYPE: Partial<Record<Furniture['kind'], string>> = {
  table: 'TABLE',
  bed: 'BED',
  sofa: 'SOFA',
  shelves: 'SHELF',
}

const COVERING_NAME: Record<Covering['kind'], string> = {
  shutter: 'Roller shutter',
  'external-blind': 'External blind',
  awning: 'Awning',
  curtain: 'Curtains',
  blind: 'Interior blind',
}
const COVERING_TYPE: Record<Covering['kind'], string> = {
  shutter: 'SHUTTER',
  'external-blind': 'JALOUSIE',
  awning: 'AWNING',
  curtain: 'USERDEFINED',
  blind: 'USERDEFINED',
}

function doorOperation(d: Door): { type: string; user: string | null } {
  const side = d.hinge === 'end' ? 'RIGHT' : 'LEFT'
  switch (d.operation) {
    case 'swing':
      return { type: `SINGLE_SWING_${side}`, user: null }
    case 'double-swing':
      return { type: 'DOUBLE_DOOR_SINGLE_SWING', user: null }
    case 'sliding':
      return { type: 'DOUBLE_DOOR_SLIDING', user: null }
    case 'folding':
      return { type: `FOLDING_TO_${side}`, user: null }
    case 'lift-slide':
      return { type: 'USERDEFINED', user: 'LIFT_AND_SLIDE' }
    case 'pocket':
      return { type: 'USERDEFINED', user: 'POCKET' }
  }
}

const SPACE_TYPE: Record<Space['kind'], { type: string; objectType: string | null }> = {
  room: { type: 'INTERNAL', objectType: null },
  outdoor: { type: 'EXTERNAL', objectType: null },
  paved: { type: 'USERDEFINED', objectType: 'Paving' },
  pool: { type: 'USERDEFINED', objectType: 'Pool' },
}

// ─── Geometry ───────────────────────────────────────────────────────────────

const m = (mm: number) => mm / 1000
/** A plan point as IFC X and Y, in metres. */
const P = (p: Point): [number, number] => [m(p[0]), -m(p[1])]

function insidePolygon(poly: Point[], x: number, y: number): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function inSpace(s: Space, x: number, y: number): boolean {
  return insidePolygon(s.outline, x, y) && !(s.holes ?? []).some((h) => insidePolygon(h, x, y))
}

// ─── The export ─────────────────────────────────────────────────────────────

export function toIfc(plan: Plan, opts: IfcOptions): string {
  const w = new Step()
  const gid = (key: string) => globalId(`${opts.name}|${key}`)

  // Shared geometry and the context everything is drawn in.
  const point3 = (x: number, y: number, z: number) => w.add('IFCCARTESIANPOINT', [x, y, z])
  const point2 = (x: number, y: number) => w.add('IFCCARTESIANPOINT', [x, y])
  const dir3 = (x: number, y: number, z: number) => w.add('IFCDIRECTION', [x, y, z])
  const zUp = dir3(0, 0, 1)
  const origin = point3(0, 0, 0)
  const wcs = w.add('IFCAXIS2PLACEMENT3D', origin, null, null)
  const context = w.add('IFCGEOMETRICREPRESENTATIONCONTEXT', null, 'Model', I(3), 1e-5, wcs, null)
  const body = w.add(
    'IFCGEOMETRICREPRESENTATIONSUBCONTEXT',
    'Body',
    'Model',
    DERIVED,
    DERIVED,
    DERIVED,
    DERIVED,
    context,
    null,
    E('MODEL_VIEW'),
    null,
  )
  const units = w.add('IFCUNITASSIGNMENT', [
    w.add('IFCSIUNIT', DERIVED, E('LENGTHUNIT'), null, E('METRE')),
    w.add('IFCSIUNIT', DERIVED, E('AREAUNIT'), null, E('SQUARE_METRE')),
    w.add('IFCSIUNIT', DERIVED, E('VOLUMEUNIT'), null, E('CUBIC_METRE')),
    w.add('IFCSIUNIT', DERIVED, E('PLANEANGLEUNIT'), null, E('RADIAN')),
  ])

  /** A placement at a point, turned so its x runs along `x` (in IFC X and Y), relative to another. */
  const place = (rel: Ref | null, at: [number, number, number], x?: [number, number]) => {
    const axes = x
      ? w.add('IFCAXIS2PLACEMENT3D', point3(...at), zUp, dir3(x[0], x[1], 0))
      : w.add('IFCAXIS2PLACEMENT3D', point3(...at), null, null)
    return w.add('IFCLOCALPLACEMENT', rel, axes)
  }
  const solid = (profile: Ref, z0: number, depth: number) =>
    w.add('IFCEXTRUDEDAREASOLID', profile, w.add('IFCAXIS2PLACEMENT3D', point3(0, 0, z0), null, null), zUp, depth)
  const shape = (...solids: Ref[]) =>
    w.add('IFCPRODUCTDEFINITIONSHAPE', null, null, [
      w.add('IFCSHAPEREPRESENTATION', body, 'Body', 'SweptSolid', solids),
    ])
  /** A box centred at (cx, cy) in its placement, from z0 up by `depth`, all in metres. */
  const box = (cx: number, cy: number, xd: number, yd: number, z0: number, depth: number) =>
    solid(
      w.add(
        'IFCRECTANGLEPROFILEDEF',
        E('AREA'),
        null,
        w.add('IFCAXIS2PLACEMENT2D', point2(cx, cy), null),
        Math.max(xd, 0.001),
        Math.max(yd, 0.001),
      ),
      z0,
      Math.max(depth, 0.001),
    )
  const loop = (pts: Point[]) => {
    const ps = pts.map((p) => point2(...P(p)))
    return w.add('IFCPOLYLINE', [...ps, ps[0]])
  }
  const area = (s: Space, z0: number, depth: number) =>
    solid(
      s.holes?.length
        ? w.add('IFCARBITRARYPROFILEDEFWITHVOIDS', E('AREA'), null, loop(s.outline), s.holes.map(loop))
        : w.add('IFCARBITRARYCLOSEDPROFILEDEF', E('AREA'), null, loop(s.outline)),
      z0,
      depth,
    )

  const rel = (type: string, key: string, ...args: Value[]) => w.add(type, gid(`rel|${key}`), null, null, null, ...args)
  const psets: Array<{ key: string; name: string; on: Ref; props: Array<[string, Typed | null]> }> = []
  const materials = new Map<string, { material: Ref; on: Ref[] }>()
  const material = (name: string, on: Ref) => {
    if (!materials.has(name)) materials.set(name, { material: w.add('IFCMATERIAL', name, null, null), on: [] })
    materials.get(name)!.on.push(on)
  }

  // The project, the site and the building.
  const project = w.add('IFCPROJECT', gid('project'), null, opts.name, null, null, null, null, [context], units)
  const sitePlace = place(null, [0, 0, 0])
  const site = w.add(
    'IFCSITE',
    gid('site'),
    null,
    'Plot',
    null,
    null,
    sitePlace,
    null,
    null,
    E('ELEMENT'),
    null,
    null,
    null,
    null,
    null,
  )
  const buildingPlace = place(sitePlace, [0, 0, 0])
  const building = w.add(
    'IFCBUILDING',
    gid('building'),
    null,
    opts.name,
    null,
    null,
    buildingPlace,
    null,
    null,
    E('ELEMENT'),
    null,
    null,
    null,
  )
  rel('IFCRELAGGREGATES', 'project', project, [site])
  // The plot and the editor's snapping step, which IFC has no place for, so an import gets them back.
  psets.push({
    key: 'site',
    name: 'House_Site',
    on: site,
    props: [
      ['Width', T('IFCPOSITIVELENGTHMEASURE', m(plan.site.w))],
      ['Depth', T('IFCPOSITIVELENGTHMEASURE', m(plan.site.h))],
      ['Snap', T('IFCPOSITIVELENGTHMEASURE', m(plan.snap))],
    ],
  })
  rel('IFCRELAGGREGATES', 'site', site, [building])

  // Walls of one thickness share a layer set.
  const layerSets = new Map<number, { usage: Ref; walls: Ref[] }>()

  const storeys: Ref[] = []
  for (const st of plan.storeys) storeys.push(exportStorey(st))
  rel('IFCRELAGGREGATES', 'building', building, storeys)

  for (const [t, { usage, walls }] of layerSets) rel('IFCRELASSOCIATESMATERIAL', `walls|${t}`, walls, usage)
  for (const [name, { material: mat, on }] of materials) rel('IFCRELASSOCIATESMATERIAL', `material|${name}`, on, mat)
  for (const p of psets) {
    const props = p.props
      .filter((x): x is [string, Typed] => x[1] !== null)
      .map(([n, v]) => w.add('IFCPROPERTYSINGLEVALUE', n, null, v, null))
    if (!props.length) continue
    const set = w.add('IFCPROPERTYSET', gid(`pset|${p.key}`), null, p.name, null, props)
    rel('IFCRELDEFINESBYPROPERTIES', `pset|${p.key}`, [p.on], set)
  }

  function exportStorey(st: Storey): Ref {
    const k = (s: string) => `${st.id}|${s}`
    const placement = place(buildingPlace, [0, 0, m(st.elevation)])
    const storey = w.add(
      'IFCBUILDINGSTOREY',
      gid(k('storey')),
      null,
      st.name,
      null,
      null,
      placement,
      null,
      null,
      E('ELEMENT'),
      m(st.elevation),
    )
    const contained: Ref[] = []
    const walled = st.spaces.filter((s) => s.kind === 'room')
    const roomAt = (x: number, y: number) => walled.some((s) => inSpace(s, x, y))

    // Spaces, and a floor slab under each room.
    const spaces: Ref[] = []
    const wallTop = Math.max(DEFAULTS.wallHeight, ...st.walls.map((x) => x.height))
    for (const s of st.spaces) {
      if (s.outline.length < 3) continue
      const t = SPACE_TYPE[s.kind]
      const [z0, depth] = s.kind === 'room' ? [0, m(wallTop)] : s.kind === 'pool' ? [-1.5, 1.5] : [0, 0.05]
      spaces.push(
        w.add(
          'IFCSPACE',
          gid(k(`space|${s.id}`)),
          null,
          s.name,
          null,
          t.objectType,
          place(placement, [0, 0, 0]),
          shape(area(s, z0, depth)),
          null,
          E('ELEMENT'),
          E(t.type),
          null,
        ),
      )
      if (s.kind === 'room')
        contained.push(
          w.add(
            'IFCSLAB',
            gid(k(`slab|${s.id}`)),
            null,
            `Floor, ${s.name}`,
            null,
            null,
            place(placement, [0, 0, 0]),
            shape(area(s, -0.2, 0.2)),
            s.id,
            E(st.level <= 0 ? 'BASESLAB' : 'FLOOR'),
          ),
        )
    }
    if (spaces.length) rel('IFCRELAGGREGATES', k('spaces'), storey, spaces)

    // Walls, and what is in them.
    const wallPlace = new Map<string, { ref: Ref; placement: Ref; wall: Wall; len: number; left: Point }>()
    for (const wl of st.walls) {
      const dx = wl.b[0] - wl.a[0]
      const dy = wl.b[1] - wl.a[1]
      const len = Math.hypot(dx, dy)
      if (len < 1) continue
      const pl = place(placement, [...P(wl.a), 0], [dx / len, -dy / len])
      const ref = w.add(
        'IFCWALL',
        gid(k(`wall|${wl.id}`)),
        null,
        'Wall',
        null,
        null,
        pl,
        shape(box(m(len) / 2, 0, m(len), m(wl.thickness), 0, m(wl.height))),
        wl.id,
        E('STANDARD'),
      )
      contained.push(ref)
      if (!layerSets.has(wl.thickness)) {
        const layer = w.add(
          'IFCMATERIALLAYER',
          w.add('IFCMATERIAL', 'Wall', null, null),
          m(wl.thickness),
          null,
          null,
          null,
          null,
          null,
        )
        const set = w.add('IFCMATERIALLAYERSET', [layer], `Wall ${wl.thickness} mm`, null)
        layerSets.set(wl.thickness, {
          usage: w.add('IFCMATERIALLAYERSETUSAGE', set, E('AXIS2'), E('POSITIVE'), -m(wl.thickness) / 2, null),
          walls: [],
        })
      }
      layerSets.get(wl.thickness)!.walls.push(ref)
      // On the plan as drawn, standing at a looking at b, left is (dy, -dx).
      wallPlace.set(wl.id, { ref, placement: pl, wall: wl, len, left: [dy / len, -dx / len] })
    }

    const fills = new Map<string, Ref>()
    const shading = new Map<string, Ref>()
    for (const o of st.openings) {
      const host = wallPlace.get(o.wall)
      if (!host) continue
      const { wall } = host
      const glazed = o.kind !== 'gap'
      const sill = glazed ? Math.max(0, o.sill) : 0
      const head = glazed ? Math.min(wall.height, Math.max(o.head, sill + 1)) : wall.height
      const ok = k(`opening|${o.id}`)
      const opPlace = place(host.placement, [m(o.at), 0, m(sill)])
      const opening = w.add(
        'IFCOPENINGELEMENT',
        gid(ok),
        null,
        o.kind === 'gap' ? 'Open wall' : 'Opening',
        null,
        null,
        opPlace,
        shape(box(m(o.width) / 2, 0, m(o.width), m(wall.thickness) + 0.1, 0, m(head - sill))),
        o.id,
        E('OPENING'),
      )
      rel('IFCRELVOIDSELEMENT', `${ok}|voids`, host.ref, opening)
      if (o.kind === 'gap') continue

      const fillPlace = place(opPlace, [0, 0, 0])
      const fillShape = shape(box(m(o.width) / 2, 0, m(o.width), o.kind === 'door' ? 0.06 : 0.04, 0, m(head - sill)))
      let fill: Ref
      if (o.kind === 'door') {
        const op = doorOperation(o)
        fill = w.add(
          'IFCDOOR',
          gid(k(`door|${o.id}`)),
          null,
          'Door',
          null,
          null,
          fillPlace,
          fillShape,
          o.id,
          m(head - sill),
          m(o.width),
          E('DOOR'),
          E(op.type),
          op.user,
        )
      } else {
        fill = w.add(
          'IFCWINDOW',
          gid(k(`window|${o.id}`)),
          null,
          'Window',
          null,
          null,
          fillPlace,
          fillShape,
          o.id,
          m(head - sill),
          m(o.width),
          E('WINDOW'),
          E(o.operation === 'sliding' ? 'DOUBLE_PANEL_VERTICAL' : 'SINGLE_PANEL'),
          null,
        )
      }
      contained.push(fill)
      fills.set(o.id, fill)
      rel('IFCRELFILLSELEMENT', `${ok}|fills`, opening, fill)
      if (o.frame?.material) material(o.frame.material, fill)
      psets.push({
        key: k(`opening|${o.id}`),
        name: 'House_Opening',
        on: fill,
        props: [
          ['Operation', T('IFCLABEL', o.operation)],
          ['Leaf', o.kind === 'door' ? T('IFCLABEL', (o as Door).leaf) : null],
          ['FrameMaterial', o.frame?.material ? T('IFCLABEL', o.frame.material) : null],
          ['FrameColour', o.frame?.colour ? T('IFCLABEL', o.frame.colour) : null],
          ['Hinge', o.hinge ? T('IFCLABEL', o.hinge) : null],
          ['Opens', o.opens ? T('IFCLABEL', o.opens) : null],
          ['SillHeight', T('IFCLENGTHMEASURE', m(sill))],
          ['HeadHeight', T('IFCLENGTHMEASURE', m(head))],
        ],
      })

      // What covers the glass, on its side of the wall: the side with a walled
      // room is inside. In the wall's placement, its left is +y.
      if (!isGlazed(o)) continue
      const mid: Point = [
        wall.a[0] + ((wall.b[0] - wall.a[0]) * (o.at + o.width / 2)) / host.len,
        wall.a[1] + ((wall.b[1] - wall.a[1]) * (o.at + o.width / 2)) / host.len,
      ]
      const probe = wall.thickness / 2 + 200
      const leftRoom = roomAt(mid[0] + host.left[0] * probe, mid[1] + host.left[1] * probe)
      const rightRoom = roomAt(mid[0] - host.left[0] * probe, mid[1] - host.left[1] * probe)
      const insideIsLeft = !(rightRoom && !leftRoom)
      const driven = new Set(st.placements.filter((p) => p.host?.opening === o.id).map((p) => p.host?.covering))
      for (const c of (o as Door | Window).coverings ?? []) {
        const sign = (c.side === 'inside') === insideIsLeft ? 1 : -1
        const off = sign * (m(wall.thickness) / 2 + 0.05)
        const W = m(o.width)
        const Hh = m(head - sill)
        const solids =
          c.kind === 'curtain'
            ? [box(W * 0.075, off, W * 0.15, 0.04, 0, Hh), box(W * 0.925, off, W * 0.15, 0.04, 0, Hh)]
            : c.kind === 'awning'
              ? [box(W / 2, off + sign * 0.1, W, 0.2, Hh, 0.12)]
              : [box(W / 2, off, W, 0.12, Math.max(0, Hh - 0.18), 0.18)]
        const ref = w.add(
          'IFCSHADINGDEVICE',
          gid(k(`covering|${o.id}|${c.id}`)),
          null,
          COVERING_NAME[c.kind],
          null,
          COVERING_TYPE[c.kind] === 'USERDEFINED' ? COVERING_NAME[c.kind] : null,
          place(opPlace, [0, 0, 0]),
          shape(...solids),
          c.id,
          E(COVERING_TYPE[c.kind]),
        )
        contained.push(ref)
        shading.set(`${o.id}|${c.id}`, ref)
        rel('IFCRELCONNECTSELEMENTS', k(`covering|${o.id}|${c.id}|on`), null, fill, ref)
        psets.push({
          key: k(`covering|${o.id}|${c.id}`),
          name: 'House_Covering',
          on: ref,
          props: [
            ['Kind', T('IFCLABEL', c.kind)],
            ['Side', T('IFCLABEL', c.side)],
            ['Motorised', T('IFCBOOLEAN', driven.has(c.id))],
          ],
        })
      }
    }

    // Radiators: a panel on the side of the line they hang on.
    for (const r of st.radiators) {
      const dx = r.b[0] - r.a[0]
      const dy = r.b[1] - r.a[1]
      const len = Math.hypot(dx, dy)
      if (len < 1) continue
      const sign = r.side === 'left' ? 1 : -1
      contained.push(
        w.add(
          'IFCSPACEHEATER',
          gid(k(`radiator|${r.id}`)),
          null,
          'Radiator',
          null,
          null,
          place(placement, [...P(r.a), 0], [dx / len, -dy / len]),
          shape(box(m(len) / 2, sign * 0.06, m(len), 0.08, 0.15, 0.6)),
          r.id,
          E('RADIATOR'),
        ),
      )
    }

    // Furniture, and the fittings of a bathroom.
    for (const f of st.furniture) {
      const sanitary = SANITARY[f.kind]
      const type = sanitary ?? FURNITURE_TYPE[f.kind] ?? 'USERDEFINED'
      const [cx, cy] = P([f.x + f.w / 2, f.y + f.d / 2])
      contained.push(
        w.add(
          sanitary ? 'IFCSANITARYTERMINAL' : 'IFCFURNITURE',
          gid(k(`furniture|${f.id}`)),
          null,
          FURNITURE_NAME[f.kind],
          null,
          type === 'USERDEFINED' ? FURNITURE_NAME[f.kind] : null,
          place(placement, [cx, cy, 0]),
          shape(box(0, 0, m(f.w), m(f.d), 0, m(f.height ?? FURNITURE_HEIGHT[f.kind]))),
          f.id,
          E(type),
        ),
      )
    }

    // Devices the caller named.
    for (const p of st.placements) {
      const d = opts.devices?.[p.ref]
      if (!d || !DEVICE_CLASSES.includes(d.ifcClass)) continue
      const z = d.z ?? deviceHeight(p, st)
      const ref = w.add(
        d.ifcClass.toUpperCase(),
        gid(k(`device|${p.ref}`)),
        null,
        d.name,
        null,
        d.predefined === 'USERDEFINED' ? (d.objectType ?? d.name) : null,
        place(placement, [...P([p.x, p.y]), m(z)]),
        shape(box(0, 0, 0.2, 0.2, -0.1, 0.2)),
        null,
        E(d.predefined),
      )
      contained.push(ref)
      psets.push({
        key: k(`device|${p.ref}`),
        name: 'House_Device',
        on: ref,
        props: [['Reference', T('IFCIDENTIFIER', p.ref)]],
      })
      const drives = p.host?.covering ? shading.get(`${p.host.opening}|${p.host.covering}`) : undefined
      if (drives) rel('IFCRELCONNECTSELEMENTS', k(`device|${p.ref}|drives`), null, ref, drives)
    }

    if (contained.length) rel('IFCRELCONTAINEDINSPATIALSTRUCTURE', k('contains'), contained, storey)
    return storey
  }

  const header = [
    'ISO-10303-21;',
    'HEADER;',
    `FILE_DESCRIPTION((${stepString('ViewDefinition [DesignTransferView]')}),'2;1');`,
    `FILE_NAME(${[
      stepString(opts.fileName ?? 'house.ifc'),
      stepString(opts.timestamp ?? new Date().toISOString().slice(0, 19)),
      `(${stepString('')})`,
      `(${stepString('')})`,
      stepString(opts.application ?? ''),
      stepString(opts.application ?? ''),
      stepString(''),
    ].join(',')});`,
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
  ]
  return `${header.join('\n')}\n${w.data}\nENDSEC;\nEND-ISO-10303-21;\n`
}

/** Where a device sits when the caller does not say: by how a light is mounted, else at switch height. */
function deviceHeight(p: Placement, st: Storey): number {
  const top = Math.max(DEFAULTS.wallHeight, ...st.walls.map((x) => x.height))
  switch (p.mount) {
    case 'ceiling':
      return top - 100
    case 'wall':
      return 1800
    case 'table':
      return 850
    case 'floor':
      return 1400
    case 'pool':
      return -500
    default:
      return p.host ? 2000 : 1100
  }
}
