/**
 * Between plan versions 1 and 2.
 *
 * `fromV1` turns a version 1 plan into version 2, every value to the nearest
 * millimetre. Plans saved by the version 1 editor are whole half cells, so
 * for them it is exact. The editor itself now works to the millimetre in
 * version 1's shapes (rectangles, walls along room edges), so its values are
 * any number of millimetres, still exact. Given the version 2 plan it replaces, it keeps what version 1
 * cannot say (a wall's thickness, a door's frame, curtains with no motor) for
 * every element that is still there, so a save from the version 1 editor
 * loses nothing it did not change.
 *
 * `toV1` is the adapter the current editor and views draw from until they
 * work in millimetres themselves.
 */

import { Cells, Grid, area, rectLoops, rectangles, type Rect } from './cells.js'
import { overlapLength, wallLinesOf, type WallLine } from './edges.js'
import * as V1 from './v1.js'
import {
  DEFAULTS,
  DOOR_OPERATIONS,
  PLAN_VERSION,
  WINDOW_OPERATIONS,
  isGlazed,
  type Covering,
  type Door,
  type Furniture,
  type Opening,
  type Placement,
  type Plan,
  type Point,
  type Radiator,
  type Space,
  type Storey,
  type Wall,
  type Window,
} from './v2.js'

/** Millimetres per version 1 cell. */
export const CELL = V1.HOUSE_GRID * 1000

const mm = (cells: number) => Math.round(cells * CELL)
const cells = (v: number) => v / CELL
const mmRect = (q: Rect): Rect => ({ x: mm(q.x), y: mm(q.y), w: mm(q.w), h: mm(q.h) })

// ─── Sides ──────────────────────────────────────────────────────────────────
// Version 1 names a side as seen on the plan (up, down, left, right). Version
// 2 names it relative to the wall, as walls can run any way. The walls made
// here run towards +x or +y, so on screen (y down) the left of one running
// along x is up, and the left of one running along y is right.

type Side = 'up' | 'down' | 'left' | 'right'

function toWallSide(axis: 'h' | 'v', side: Side): 'left' | 'right' {
  return axis === 'h' ? (side === 'up' ? 'left' : 'right') : side === 'right' ? 'left' : 'right'
}

function fromWallSide(axis: 'h' | 'v', side: 'left' | 'right'): Side {
  return axis === 'h' ? (side === 'left' ? 'up' : 'down') : side === 'left' ? 'right' : 'left'
}

const axisOf = (a: Point, b: Point): 'h' | 'v' | null => (a[1] === b[1] ? 'h' : a[0] === b[0] ? 'v' : null)

// ─── Walls ──────────────────────────────────────────────────────────────────

/** A room's outline and holes, in millimetres. */
function roomLoops(r: V1.HouseRoom): Point[][] {
  if (r.outline) return [r.outline.map(([x, y]): Point => [mm(x), mm(y)])]
  return rectLoops(V1.roomRects(r).map(mmRect))
}

/**
 * The walls a version 1 floor implies: the edges of rooms that have walls,
 * merged into straight runs. A run is cut where it changes from a wall
 * between two rooms (inner, thin) to one with a room on one side only
 * (outer, thick), as those are different walls in a building.
 */
export function wallLines(floor: V1.HouseFloor): WallLine[] {
  return wallLinesOf(floor.rooms.filter((r) => r.kind === 'room').map(roomLoops))
}

const lineEnds = (l: WallLine): [Point, Point] => [l.a, l.b]

/** How far two walls on the same line overlap, in millimetres. 0 when they are not on one line. */
function overlap(a: Pick<Wall, 'a' | 'b'>, b: Pick<Wall, 'a' | 'b'>): number {
  return overlapLength([a.a, a.b], [b.a, b.b])
}

/** The wall spec on a wall's line that overlaps it most: what the editor set on it. */
function specFor(floor: V1.HouseFloor, shape: Pick<Wall, 'a' | 'b'>): V1.HouseWallSpec | undefined {
  return (floor.walls ?? [])
    .map((w) => {
      const a: Point = [mm(w.x), mm(w.y)]
      const b: Point = w.to
        ? [mm(w.to[0]), mm(w.to[1])]
        : w.axis === 'h'
          ? [mm(w.x + w.len), mm(w.y)]
          : [mm(w.x), mm(w.y + w.len)]
      return { w, o: overlap({ a, b }, shape) }
    })
    .filter((x) => x.o > 0)
    .sort((x, y) => y.o - x.o)[0]?.w
}

/**
 * A drawn wall in millimetres. One along x or y is turned to run towards +x
 * or +y, as the walls made from rooms do, so doors on it name their sides
 * the same way.
 */
function drawnWall(d: V1.HouseDrawnWall): Wall {
  let a: Point = [mm(d.a[0]), mm(d.a[1])]
  let b: Point = [mm(d.b[0]), mm(d.b[1])]
  const axis = axisOf(a, b)
  if (axis && b[axis === 'h' ? 0 : 1] < a[axis === 'h' ? 0 : 1]) [a, b] = [b, a]
  return { id: d.id, a, b, thickness: d.thickness, height: d.height }
}

function makeWalls(floor: V1.HouseFloor, prev: Wall[]): Wall[] {
  // A wall's id must not clash with a door's or radiator's on the same storey,
  // or with a drawn wall's.
  const reserved = new Set(
    [...floor.openings, ...(floor.radiators ?? []), ...(floor.drawnWalls ?? [])].map((x) => x.id),
  )
  const used = new Set<string>()
  const walls: Wall[] = []
  for (const l of wallLines(floor)) {
    const [a, b] = lineEnds(l)
    const shape = { a, b }
    // The wall it was before: the one it overlaps most, if not already taken.
    const before = prev
      .filter((w) => !used.has(w.id))
      .map((w) => ({ w, o: overlap(w, shape) }))
      .filter((x) => x.o > 0)
      .sort((x, y) => y.o - x.o)[0]?.w
    const taken = (x: string) => used.has(x) || reserved.has(x)
    const kind = l.axis ?? 's'
    let id = before && !reserved.has(before.id) ? before.id : `w${kind}${a[0]}_${a[1]}`
    for (let n = 2; taken(id); n++) id = `w${kind}${a[0]}_${a[1]}_${n}`
    used.add(id)
    // What the editor set wins, then what the wall had.
    const spec = specFor(floor, shape)
    walls.push({
      id,
      a,
      b,
      thickness: spec?.thickness ?? before?.thickness ?? (l.inner ? DEFAULTS.innerWall : DEFAULTS.outerWall),
      height: spec?.height ?? before?.height ?? DEFAULTS.wallHeight,
    })
  }
  for (const d of floor.drawnWalls ?? []) walls.push(drawnWall(d))
  return walls
}

// ─── Openings ───────────────────────────────────────────────────────────────

/** The wall a version 1 opening sits in, and where along it. */
function host(o: V1.HouseOpening, walls: Wall[]): { wall: Wall; at: number } | null {
  const [s, e] = o.axis === 'h' ? [o.x, o.x + o.len] : [o.y, o.y + o.len]
  const line = o.axis === 'h' ? mm(o.y) : mm(o.x)
  for (const w of walls) {
    if (axisOf(w.a, w.b) !== o.axis) continue
    const k = o.axis === 'h' ? 1 : 0
    const i = o.axis === 'h' ? 0 : 1
    if (w.a[k] !== line) continue
    if (mm(s) >= w.a[i] && mm(e) <= w.b[i]) return { wall: w, at: mm(s) - w.a[i] }
  }
  return null
}

function makeOpening(o: V1.HouseOpening, wall: Wall, at: number, prev: Opening | undefined): Opening {
  const base = { id: o.id, wall: wall.id, at, width: mm(o.len) }
  if (o.type === 'open') return { ...base, kind: 'gap' }
  const swing = (x: Opening): x is Door | Window => x.kind !== 'gap'
  const old = prev && swing(prev) ? prev : undefined
  const sides = (): Pick<Door, 'hinge' | 'opens'> => ({
    hinge: o.hinge ?? 'start',
    opens: toWallSide(o.axis, o.opens ?? (o.axis === 'h' ? 'down' : 'right')),
  })
  // What the editor said wins over what was stored. Frame and coverings
  // carry over to another kind of element, the rest only to the same kind.
  const spec = o.spec
  const kind = o.type === 'window' ? 'window' : 'door'
  const same = spec?.kind === kind ? spec : undefined
  const kept = {
    frame: spec && 'frame' in spec ? spec.frame : old?.frame,
    coverings: spec && 'coverings' in spec ? spec.coverings?.map((c) => ({ ...c })) : old?.coverings,
  }
  if (o.type === 'window') {
    const was = old?.kind === 'window' ? old : undefined
    const op = WINDOW_OPERATIONS.find((x) => x === same?.operation)
    const win: Window = {
      ...base,
      kind: 'window',
      operation: op ?? was?.operation ?? 'casement',
      sill: same?.sill ?? was?.sill ?? DEFAULTS.windowSill,
      head: same?.head ?? was?.head ?? DEFAULTS.windowHead,
      ...kept,
      ...(o.hinge !== undefined || o.opens !== undefined ? sides() : {}),
    }
    return tidyOpening(win)
  }
  // The cells say whether it slides and whether it is glass. The detail
  // only refines that, so a door made solid in an old tab loses its glass.
  const sliding = o.type === 'slider'
  const glass = sliding || o.glass === true
  const slides = (x: string | undefined) => x === 'sliding' || x === 'lift-slide'
  const fits = (x: { operation?: string; leaf?: string } | undefined) =>
    !!x && slides(x.operation) === sliding && (x.leaf !== 'solid') === glass
  const was = old?.kind === 'door' && fits(old) ? old : undefined
  const op = DOOR_OPERATIONS.find((x) => x === same?.operation && slides(x) === sliding)
  const leaf = same?.leaf !== undefined && (same.leaf !== 'solid') === glass ? same.leaf : undefined
  const door: Door = {
    ...base,
    kind: 'door',
    operation: op ?? was?.operation ?? (sliding ? 'sliding' : 'swing'),
    leaf: leaf ?? was?.leaf ?? (glass ? 'glazed' : 'solid'),
    sill: same?.sill ?? was?.sill ?? 0,
    head: same?.head ?? was?.head ?? DEFAULTS.doorHead,
    ...kept,
    ...sides(),
  }
  return tidyOpening(door)
}

/** Drop what an opening cannot have and empty lists, so the stored plan says only what is true. */
function tidyOpening<T extends Door | Window>(o: T): T {
  if (!isGlazed(o) || !o.coverings?.length) delete o.coverings
  if (o.frame === undefined || (!o.frame.material && !o.frame.colour)) delete o.frame
  if (o.hinge === undefined) delete o.hinge
  if (o.opens === undefined) delete o.opens
  return o
}

// ─── Spaces ─────────────────────────────────────────────────────────────────

function makeSpace(r: V1.HouseRoom): Space {
  if (r.outline) {
    // Drawn corner by corner: the corners are the shape, clockwise on screen.
    const outline = r.outline.map(([x, y]): Point => [mm(x), mm(y)])
    if (area(outline) < 0) outline.reverse()
    return { id: r.id, name: r.name, kind: r.kind, outline }
  }
  const rects = V1.roomRects(r).map(mmRect)
  const [outline, ...holes] = rectLoops(rects)
  const s: Space = { id: r.id, name: r.name, kind: r.kind, outline }
  if (holes.length) s.holes = holes
  if (r.parts?.length) s.rects = rects
  return s
}

// ─── Version 1 to 2 ─────────────────────────────────────────────────────────

export interface Migration {
  plan: Plan
  /** Openings that sat on no wall (left behind when a room moved), and so were not kept. */
  dropped: string[]
}

export function fromV1(p: V1.HousePlan, previous?: Plan | null): Migration {
  const dropped: string[] = []
  const storeys = p.floors.map((f): Storey => {
    const before = previous?.storeys.find((s) => s.id === f.id)
    const walls = makeWalls(f, before?.walls ?? [])
    const openings: Opening[] = []
    for (const o of f.openings) {
      const h = host(o, walls)
      if (!h) {
        dropped.push(`${f.name}: ${o.type} ${o.id}`)
        continue
      }
      openings.push(
        makeOpening(
          o,
          h.wall,
          h.at,
          before?.openings.find((x) => x.id === o.id),
        ),
      )
    }
    const byId = new Map(openings.map((o) => [o.id, o]))

    // Which covering each device on a window drives. One it drove before
    // keeps it. A device newly put on a window takes a covering nobody
    // drives (a shutter first), or brings a new shutter.
    const hosts = new Map<string, { opening: string; covering: string }>()
    const claimed = new Set<string>()
    const onGlass = f.placements.filter((pl) => {
      const o = pl.opening ? byId.get(pl.opening) : undefined
      return !!o && isGlazed(o)
    })
    for (const pl of onGlass) {
      const o = byId.get(pl.opening!) as Door | Window
      const chosen = pl.covering && o.coverings?.some((c) => c.id === pl.covering) ? pl.covering : undefined
      const taken = (c: string) => claimed.has(`${o.id}/${c}`)
      if (chosen && !taken(chosen)) {
        hosts.set(pl.ref, { opening: o.id, covering: chosen })
        claimed.add(`${o.id}/${chosen}`)
        continue
      }
      const was = before?.placements.find((x) => x.ref === pl.ref)?.host
      if (
        pl.covering === undefined &&
        was?.opening === o.id &&
        !taken(was.covering ?? '') &&
        was.covering &&
        o.coverings?.some((c) => c.id === was.covering)
      ) {
        hosts.set(pl.ref, { opening: o.id, covering: was.covering })
        claimed.add(`${o.id}/${was.covering}`)
      }
    }
    for (const pl of onGlass) {
      if (hosts.has(pl.ref)) continue
      const o = byId.get(pl.opening!) as Door | Window
      const list = (o.coverings ??= [])
      const free = list.filter((c) => !claimed.has(`${o.id}/${c.id}`))
      let c: Covering | undefined = free.find((x) => x.kind === 'shutter') ?? free[0]
      if (!c) {
        let n = list.length + 1
        while (list.some((x) => x.id === `c${n}`)) n++
        c = { id: `c${n}`, kind: 'shutter', side: 'outside' }
        list.push(c)
      }
      claimed.add(`${o.id}/${c.id}`)
      hosts.set(pl.ref, { opening: o.id, covering: c.id })
    }

    const placements = f.placements.map((pl): Placement => {
      const out: Placement = { ref: pl.ref, x: mm(pl.x), y: mm(pl.y) }
      const h = hosts.get(pl.ref)
      if (h) out.host = h
      if (pl.color !== undefined) out.color = pl.color
      if (pl.circuitRooms !== undefined) out.circuitRooms = [...pl.circuitRooms]
      if (pl.length !== undefined) out.length = mm(pl.length)
      if (pl.axis !== undefined) out.axis = pl.axis
      if (pl.mount !== undefined) out.mount = pl.mount
      if (pl.look !== undefined) out.look = pl.look
      return out
    })

    const radiators = (f.radiators ?? []).map((r): Radiator => {
      const a: Point = [mm(r.x), mm(r.y)]
      const b: Point = r.axis === 'h' ? [mm(r.x + r.len), mm(r.y)] : [mm(r.x), mm(r.y + r.len)]
      return { id: r.id, a, b, side: toWallSide(r.axis, r.side) }
    })

    const furniture = (f.furniture ?? []).map((u): Furniture => {
      const out: Furniture = { id: u.id, kind: u.kind, x: mm(u.x), y: mm(u.y), w: mm(u.w), d: mm(u.d) }
      if (u.height !== undefined) out.height = Math.round(u.height * 1000)
      if (u.back !== undefined) out.back = u.back
      return out
    })

    const height = before?.height ?? DEFAULTS.storeyHeight
    return {
      id: f.id,
      name: f.name,
      level: f.level,
      elevation: before && before.level === f.level ? before.elevation : f.level * DEFAULTS.storeyHeight,
      height,
      walls,
      spaces: f.rooms.map(makeSpace),
      openings,
      radiators,
      furniture,
      placements,
    }
  })
  return {
    plan: {
      version: PLAN_VERSION,
      unit: 'mm',
      site: { w: mm(p.plot.w), h: mm(p.plot.h) },
      snap: previous?.snap ?? CELL,
      storeys,
    },
    dropped,
  }
}

// ─── Version 2 to 1 ─────────────────────────────────────────────────────────

function sameCells(a: Cells, b: Cells): boolean {
  if (a.size !== b.size) return false
  for (const [x, y] of a) if (!b.has(x, y)) return false
  return true
}

/** Whether an outline is a plain rectangle. */
function isRectangle(loop: Point[]): boolean {
  return loop.length === 4 && loop.every((p, i) => !!axisOf(p, loop[(i + 1) % 4]))
}

function roomOf(s: Space): V1.HouseRoom {
  const holes = s.holes ?? []
  // A shape the editor did not draw as rectangles, and that is not one:
  // a room drawn corner by corner. Its corners say what it is.
  if (!s.rects && !holes.length && !isRectangle(s.outline)) {
    const xs = s.outline.map((p) => p[0])
    const ys = s.outline.map((p) => p[1])
    const [x0, y0] = [Math.min(...xs), Math.min(...ys)]
    return {
      id: s.id,
      name: s.name,
      kind: s.kind,
      x: cells(x0),
      y: cells(y0),
      w: cells(Math.max(...xs) - x0),
      h: cells(Math.max(...ys) - y0),
      outline: s.outline.map(([x, y]) => [cells(x), cells(y)]),
    }
  }
  const g = Grid.of(s.rects ?? [], [s.outline, ...holes])
  const shape = g.inside(s.outline, holes)
  // The rectangles the editor drew it as, while they still make this shape.
  let hint: Rect[] | undefined
  try {
    if (s.rects && sameCells(g.cells(s.rects), shape)) hint = s.rects
  } catch {
    // A rectangle off the outline's corners: not this shape.
  }
  const rects = hint ?? rectangles(shape, g).map((r) => g.rect(r))
  const [main, ...parts] = rects.map((q) => ({ x: cells(q.x), y: cells(q.y), w: cells(q.w), h: cells(q.h) }))
  const room: V1.HouseRoom = { id: s.id, name: s.name, kind: s.kind, ...(main ?? { x: 0, y: 0, w: 1, h: 1 }) }
  if (parts.length) room.parts = parts
  return room
}

function openingOf(o: Opening, wall: Wall): V1.HouseOpening | null {
  const axis = axisOf(wall.a, wall.b)
  if (!axis) return null
  const i = axis === 'h' ? 0 : 1
  const dir = Math.sign(wall.b[i] - wall.a[i]) || 1
  const s = dir > 0 ? wall.a[i] + o.at : wall.a[i] - o.at - o.width
  const at = cells(s)
  const len = cells(o.width)
  const out: V1.HouseOpening =
    axis === 'h'
      ? { id: o.id, type: 'door', axis, x: at, y: cells(wall.a[1]), len }
      : { id: o.id, type: 'door', axis, x: cells(wall.a[0]), y: at, len }
  if (o.kind === 'gap') return { ...out, type: 'open' }
  if (o.kind === 'window') out.type = 'window'
  else if (o.operation === 'sliding' || o.operation === 'lift-slide') out.type = 'slider'
  else if (o.leaf !== 'solid') out.glass = true
  const spec: V1.OpeningSpec = { kind: o.kind, operation: o.operation, sill: o.sill, head: o.head }
  if (o.kind === 'door') spec.leaf = o.leaf
  if (o.frame) spec.frame = { ...o.frame }
  if (isGlazed(o)) spec.coverings = (o.coverings ?? []).map((c) => ({ ...c }))
  out.spec = spec
  // Version 1 leaves the usual hinge and side unsaid.
  if (o.hinge === 'end') out.hinge = 'end'
  if (o.opens) {
    const side = fromWallSide(axis, o.opens)
    if (side !== (axis === 'h' ? 'down' : 'right')) out.opens = side
  }
  return out
}

export function toV1(p: Plan): V1.HousePlan {
  const floors = p.storeys.map((s): V1.HouseFloor => {
    const walls = new Map(s.walls.map((w) => [w.id, w]))
    const openings: V1.HouseOpening[] = []
    for (const o of s.openings) {
      const w = walls.get(o.wall)
      const v = w ? openingOf(o, w) : null
      if (v) openings.push(v)
    }
    const floor: V1.HouseFloor = {
      id: s.id,
      name: s.name,
      level: s.level,
      rooms: s.spaces.map(roomOf),
      openings,
      placements: s.placements.map((pl) => {
        const out: V1.HousePlacement = { ref: pl.ref, x: cells(pl.x), y: cells(pl.y) }
        if (pl.host) out.opening = pl.host.opening
        if (pl.host?.covering) out.covering = pl.host.covering
        if (pl.color !== undefined) out.color = pl.color
        if (pl.circuitRooms !== undefined) out.circuitRooms = [...pl.circuitRooms]
        if (pl.length !== undefined) out.length = cells(pl.length)
        if (pl.axis !== undefined) out.axis = pl.axis
        if (pl.mount !== undefined) out.mount = pl.mount
        if (pl.look !== undefined) out.look = pl.look
        return out
      }),
    }
    const radiators = s.radiators.flatMap((r): V1.HouseRadiator[] => {
      const axis = axisOf(r.a, r.b)
      if (!axis) return []
      const i = axis === 'h' ? 0 : 1
      const lo = Math.min(r.a[i], r.b[i])
      const len = cells(Math.abs(r.b[i] - r.a[i]))
      // A radiator drawn the other way round has its sides the other way round too.
      const side = r.b[i] >= r.a[i] ? r.side : r.side === 'left' ? 'right' : 'left'
      return [
        axis === 'h'
          ? { id: r.id, axis, x: cells(lo), y: cells(r.a[1]), len, side: fromWallSide(axis, side) }
          : { id: r.id, axis, x: cells(r.a[0]), y: cells(lo), len, side: fromWallSide(axis, side) },
      ]
    })
    if (radiators.length) floor.radiators = radiators
    const furniture = s.furniture.map((u): V1.HouseFurniture => {
      const out: V1.HouseFurniture = {
        id: u.id,
        kind: u.kind,
        x: cells(u.x),
        y: cells(u.y),
        w: cells(u.w),
        d: cells(u.d),
      }
      if (u.height !== undefined) out.height = Math.round(u.height / 10) / 100
      if (u.back !== undefined) out.back = u.back
      return out
    })
    if (furniture.length) floor.furniture = furniture
    // A wall that follows no room edge was drawn on its own.
    const fromRooms = wallLines(floor).map((l) => {
      const [a, b] = lineEnds(l)
      return { a, b }
    })
    const drawn = s.walls.filter((w) => !fromRooms.some((l) => overlap(l, w) > 0))
    if (drawn.length)
      floor.drawnWalls = drawn.map((w) => ({
        id: w.id,
        a: [cells(w.a[0]), cells(w.a[1])],
        b: [cells(w.b[0]), cells(w.b[1])],
        thickness: w.thickness,
        height: w.height,
      }))
    const specs = s.walls.flatMap((w): V1.HouseWallSpec[] => {
      if (drawn.includes(w)) return []
      const axis = axisOf(w.a, w.b)
      if (!axis) {
        // A slanted edge of a room drawn corner by corner.
        return [
          {
            axis: 'h',
            x: cells(w.a[0]),
            y: cells(w.a[1]),
            len: 0,
            to: [cells(w.b[0]), cells(w.b[1])],
            thickness: w.thickness,
            height: w.height,
          },
        ]
      }
      const i = axis === 'h' ? 0 : 1
      const lo = Math.min(w.a[i], w.b[i])
      const len = cells(Math.abs(w.b[i] - w.a[i]))
      const at = axis === 'h' ? { x: cells(lo), y: cells(w.a[1]) } : { x: cells(w.a[0]), y: cells(lo) }
      return [{ axis, ...at, len, thickness: w.thickness, height: w.height }]
    })
    if (specs.length) floor.walls = specs
    return floor
  })
  return {
    version: V1.HOUSE_V1,
    grid: V1.HOUSE_GRID,
    plot: { w: cells(p.site.w), h: cells(p.site.h) },
    floors,
  }
}
