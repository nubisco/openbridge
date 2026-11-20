/**
 * Between plan versions 1 and 2.
 *
 * `fromV1` turns a version 1 plan into version 2 exactly: every version 1
 * value is a whole number of half cells, which is a whole number of
 * millimetres. Given the version 2 plan it replaces, it keeps what version 1
 * cannot say (a wall's thickness, a door's frame, curtains with no motor) for
 * every element that is still there, so a save from the version 1 editor
 * loses nothing it did not change.
 *
 * `toV1` is the adapter the current editor and views draw from until they
 * work in millimetres themselves.
 */

import { Cells, cellLoops, cellsIn, rectangles } from './cells.js'
import * as V1 from './v1.js'
import {
  DEFAULTS,
  PLAN_VERSION,
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
/** To the nearest half cell, which is as fine as version 1 goes. */
const half = (v: number) => Math.round((v / CELL) * 2) / 2

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

const cellIn = (rooms: V1.HouseRoom[], cx: number, cy: number) =>
  rooms.some((r) => V1.roomRects(r).some((q) => cx >= q.x && cx < q.x + q.w && cy >= q.y && cy < q.y + q.h))

interface Line {
  axis: 'h' | 'v'
  /** The y of a line along x, or the x of one along y, in cells. */
  line: number
  start: number
  end: number
  inner: boolean
}

/**
 * The walls a version 1 floor implies: the edges of rooms that have walls,
 * merged into straight runs. A run is cut where it changes from a wall
 * between two rooms (inner, thin) to one with a room on one side only
 * (outer, thick), as those are different walls in a building.
 */
export function wallLines(floor: V1.HouseFloor): Line[] {
  const walled = floor.rooms.filter((r) => r.kind === 'room')
  const units = new Map<string, { axis: 'h' | 'v'; line: number; at: number; inner: boolean }>()
  for (const r of walled) {
    const rects = V1.roomRects(r)
    const inR = (x: number, y: number) => rects.some((q) => x >= q.x && x < q.x + q.w && y >= q.y && y < q.y + q.h)
    for (const q of rects) {
      for (let i = 0; i < q.w; i++) {
        const x = q.x + i
        for (const y of [q.y, q.y + q.h]) {
          if (inR(x, y - 1) && inR(x, y)) continue
          units.set(`h${x},${y}`, {
            axis: 'h',
            line: y,
            at: x,
            inner: cellIn(walled, x, y - 1) && cellIn(walled, x, y),
          })
        }
      }
      for (let j = 0; j < q.h; j++) {
        const y = q.y + j
        for (const x of [q.x, q.x + q.w]) {
          if (inR(x - 1, y) && inR(x, y)) continue
          units.set(`v${x},${y}`, {
            axis: 'v',
            line: x,
            at: y,
            inner: cellIn(walled, x - 1, y) && cellIn(walled, x, y),
          })
        }
      }
    }
  }
  const sorted = [...units.values()].sort((a, b) =>
    a.axis !== b.axis ? (a.axis === 'h' ? -1 : 1) : a.line - b.line || a.at - b.at,
  )
  const lines: Line[] = []
  for (const u of sorted) {
    const cur = lines[lines.length - 1]
    if (cur && cur.axis === u.axis && cur.line === u.line && cur.end === u.at && cur.inner === u.inner) cur.end++
    else lines.push({ axis: u.axis, line: u.line, start: u.at, end: u.at + 1, inner: u.inner })
  }
  return lines
}

const lineEnds = (l: Line): [Point, Point] =>
  l.axis === 'h'
    ? [
        [mm(l.start), mm(l.line)],
        [mm(l.end), mm(l.line)],
      ]
    : [
        [mm(l.line), mm(l.start)],
        [mm(l.line), mm(l.end)],
      ]

/** How far two walls on the same line overlap, in millimetres. 0 when they are not on one line. */
function overlap(a: Pick<Wall, 'a' | 'b'>, b: Pick<Wall, 'a' | 'b'>): number {
  const ax = axisOf(a.a, a.b)
  if (!ax || ax !== axisOf(b.a, b.b)) return 0
  const k = ax === 'h' ? 1 : 0
  if (a.a[k] !== b.a[k]) return 0
  const i = ax === 'h' ? 0 : 1
  const lo1 = Math.min(a.a[i], a.b[i])
  const hi1 = Math.max(a.a[i], a.b[i])
  const lo2 = Math.min(b.a[i], b.b[i])
  const hi2 = Math.max(b.a[i], b.b[i])
  return Math.max(0, Math.min(hi1, hi2) - Math.max(lo1, lo2))
}

function makeWalls(floor: V1.HouseFloor, prev: Wall[]): Wall[] {
  // A wall's id must not clash with a door's or radiator's on the same storey.
  const reserved = new Set([...floor.openings, ...(floor.radiators ?? [])].map((x) => x.id))
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
    let id = before && !reserved.has(before.id) ? before.id : `w${l.axis}${a[0]}_${a[1]}`
    for (let n = 2; taken(id); n++) id = `w${l.axis}${a[0]}_${a[1]}_${n}`
    used.add(id)
    walls.push({
      id,
      a,
      b,
      thickness: before?.thickness ?? (l.inner ? DEFAULTS.innerWall : DEFAULTS.outerWall),
      height: before?.height ?? DEFAULTS.wallHeight,
    })
  }
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
  const kept = old ? { frame: old.frame, coverings: old.coverings } : {}
  if (o.type === 'window') {
    const was = old?.kind === 'window' ? old : undefined
    const win: Window = {
      ...base,
      kind: 'window',
      operation: was?.operation ?? 'casement',
      sill: was?.sill ?? DEFAULTS.windowSill,
      head: was?.head ?? DEFAULTS.windowHead,
      ...kept,
      ...(o.hinge !== undefined || o.opens !== undefined ? sides() : {}),
    }
    return tidyOpening(win)
  }
  const sliding = o.type === 'slider'
  const glass = sliding || o.glass === true
  const was =
    old?.kind === 'door' &&
    (old.operation === 'sliding' || old.operation === 'lift-slide') === sliding &&
    (old.leaf !== 'solid') === glass
      ? old
      : undefined
  const door: Door = {
    ...base,
    kind: 'door',
    operation: was?.operation ?? (sliding ? 'sliding' : 'swing'),
    leaf: was?.leaf ?? (glass ? 'glazed' : 'solid'),
    sill: was?.sill ?? 0,
    head: was?.head ?? DEFAULTS.doorHead,
    ...kept,
    ...sides(),
  }
  return tidyOpening(door)
}

/** Drop what an opening cannot have and empty lists, so the stored plan says only what is true. */
function tidyOpening<T extends Door | Window>(o: T): T {
  if (!isGlazed(o) || !o.coverings?.length) delete o.coverings
  if (o.frame === undefined) delete o.frame
  if (o.hinge === undefined) delete o.hinge
  if (o.opens === undefined) delete o.opens
  return o
}

// ─── Spaces ─────────────────────────────────────────────────────────────────

const scale = (loop: Point[]): Point[] => loop.map(([x, y]) => [mm(x), mm(y)])

function makeSpace(r: V1.HouseRoom): Space {
  const [outline, ...holes] = cellLoops(Cells.of(V1.roomRects(r)))
  const s: Space = { id: r.id, name: r.name, kind: r.kind, outline: scale(outline) }
  if (holes.length) s.holes = holes.map(scale)
  if (r.parts?.length) s.rects = V1.roomRects(r).map((q) => ({ x: mm(q.x), y: mm(q.y), w: mm(q.w), h: mm(q.h) }))
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
      const was = before?.placements.find((x) => x.ref === pl.ref)?.host
      const o = byId.get(pl.opening!) as Door | Window
      if (was?.opening === o.id && was.covering && o.coverings?.some((c) => c.id === was.covering)) {
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
    plan: { version: PLAN_VERSION, unit: 'mm', site: { w: mm(p.plot.w), h: mm(p.plot.h) }, snap: CELL, storeys },
    dropped,
  }
}

// ─── Version 2 to 1 ─────────────────────────────────────────────────────────

function sameCells(a: Cells, b: Cells): boolean {
  if (a.size !== b.size) return false
  for (const [x, y] of a) if (!b.has(x, y)) return false
  return true
}

function roomOf(s: Space): V1.HouseRoom {
  const grid = cellsIn(s.outline, s.holes ?? [], CELL)
  const hint = s.rects?.map((q) => ({ x: half(q.x), y: half(q.y), w: half(q.w), h: half(q.h) }))
  const [main, ...parts] = hint && sameCells(Cells.of(hint), grid) ? hint : rectangles(grid)
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
  const at = half(s)
  const len = half(o.width)
  const out: V1.HouseOpening =
    axis === 'h'
      ? { id: o.id, type: 'door', axis, x: at, y: cells(wall.a[1]), len }
      : { id: o.id, type: 'door', axis, x: cells(wall.a[0]), y: at, len }
  if (o.kind === 'gap') return { ...out, type: 'open' }
  if (o.kind === 'window') out.type = 'window'
  else if (o.operation === 'sliding' || o.operation === 'lift-slide') out.type = 'slider'
  else if (o.leaf !== 'solid') out.glass = true
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
        const out: V1.HousePlacement = { ref: pl.ref, x: half(pl.x), y: half(pl.y) }
        if (pl.host) out.opening = pl.host.opening
        if (pl.color !== undefined) out.color = pl.color
        if (pl.circuitRooms !== undefined) out.circuitRooms = [...pl.circuitRooms]
        if (pl.length !== undefined) out.length = Math.max(1, Math.round(cells(pl.length)))
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
      const len = half(Math.abs(r.b[i] - r.a[i]))
      // A radiator drawn the other way round has its sides the other way round too.
      const side = r.b[i] >= r.a[i] ? r.side : r.side === 'left' ? 'right' : 'left'
      return [
        axis === 'h'
          ? { id: r.id, axis, x: half(lo), y: cells(r.a[1]), len, side: fromWallSide(axis, side) }
          : { id: r.id, axis, x: cells(r.a[0]), y: half(lo), len, side: fromWallSide(axis, side) },
      ]
    })
    if (radiators.length) floor.radiators = radiators
    const furniture = s.furniture.map((u): V1.HouseFurniture => {
      const out: V1.HouseFurniture = { id: u.id, kind: u.kind, x: half(u.x), y: half(u.y), w: half(u.w), d: half(u.d) }
      if (u.height !== undefined) out.height = Math.round(u.height / 10) / 100
      if (u.back !== undefined) out.back = u.back
      return out
    })
    if (furniture.length) floor.furniture = furniture
    return floor
  })
  return {
    version: V1.HOUSE_V1,
    grid: V1.HOUSE_GRID,
    plot: { w: Math.round(cells(p.site.w)), h: Math.round(cells(p.site.h)) },
    floors,
  }
}
