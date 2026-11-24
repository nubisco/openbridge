/**
 * Blueprint editing for the House view: the operations on a plan the editor
 * performs, and the top-down drawing it edits on.
 *
 * The person draws rooms, not walls. Walls follow from room edges, and doors
 * and windows are taps on a wall. Every operation here mutates the plan it is
 * given in place, so the view keeps one reactive draft and saves it as a
 * whole.
 */
import type {
  HouseFloor,
  HouseFurniture,
  HouseFurnitureKind,
  HouseOpening,
  HousePlan,
  HouseRadiator,
  HouseRect,
  HouseRoom,
} from '@/api'
import {
  CELLS_PER_M,
  S,
  clamp,
  clockwiseSide,
  doorSwing,
  esc,
  FURNITURE_BACK,
  furnitureBack,
  oppositeSide,
  CELL_MM,
  drawnAxis,
  mmOf,
  openingFits,
  openingLine,
  openingSpan,
  openingsOverlap,
  r1,
  roomArea,
  roomAt,
  roomContains,
  roomShapes,
  roomOutline,
  roomRects,
  roomsOutsideIn,
  same,
  snap,
  toMm,
  sliderPanes,
  takesShutter,
  Walls,
  wallRuns,
  across,
  along,
  lineThrough,
  radiatorNormal,
  opensTowards,
  sideName,
  type WallRun,
  onLine,
  openingEnd,
  openingMiddle,
  placedOn,
  pointAt,
  rightOf,
  sameLine,
  sideNormal,
  type Line,
  type OnWall,
  type Point,
  type WallSpan,
  type WallUnit,
} from './geometry'
import { DEFAULTS } from '@nubisco/bim/v2'
import { area as loopArea } from '@nubisco/bim/cells'
import { wallLines } from '@nubisco/bim/convert'
import { overlapLength } from '@nubisco/bim/edges'
import type { HouseDimension, HouseDrawnWall, HouseFloor as FloorV1 } from '@nubisco/bim/v1'
import { coveringDraws } from './coverings'
import { KIND_LETTER, type LiveDevice } from './live'
import { applyPreset, claimCovering, detach, presetCells, type OpeningPreset } from './openings'

/** 16 by 11 metres: a house and a garden, before the person resizes it. */
export function emptyPlan(): HousePlan {
  return {
    version: 1,
    grid: 1 / CELLS_PER_M,
    plot: { w: 32, h: 22 },
    floors: [{ id: 'ground', name: 'Ground floor', level: 0, rooms: [], openings: [], placements: [] }],
  }
}

const FLOOR_NAMES: Record<number, string> = {
  [-1]: 'Basement',
  0: 'Ground floor',
  1: 'First floor',
  2: 'Second floor',
  3: 'Third floor',
}

function uniqueId(prefix: string, taken: (id: string) => boolean): string {
  let n = 1
  while (taken(`${prefix}${n}`)) n++
  return `${prefix}${n}`
}

const roomTaken = (plan: HousePlan) => (id: string) => plan.floors.some((f) => f.rooms.some((r) => r.id === id))

const KIND_NAME: Record<HouseRoom['kind'], string> = { room: 'Room', outdoor: 'Garden', paved: 'Paving', pool: 'Pool' }

export function addRoom(
  plan: HousePlan,
  floor: HouseFloor,
  rect: Pick<HouseRoom, 'x' | 'y' | 'w' | 'h'>,
  kind: HouseRoom['kind'] = 'room',
): HouseRoom {
  const id = uniqueId('room', roomTaken(plan))
  const n = floor.rooms.filter((r) => r.kind === kind).length + 1
  const name = kind === 'pool' && n === 1 ? 'Pool' : `${KIND_NAME[kind]} ${n}`
  const room: HouseRoom = { id, name, kind, ...rect }
  floor.rooms.push(room)
  return room
}

/**
 * A new floor above the top one, starting as one room covering the outline of
 * the floor below, which is how most upper floors begin. The person splits it.
 */
export function addFloor(plan: HousePlan): HouseFloor {
  const top = plan.floors.reduce((a, b) => (b.level > a.level ? b : a))
  const level = top.level + 1
  const walled = top.rooms.filter((r) => r.kind === 'room')
  const id = uniqueId('floor', (x) => plan.floors.some((f) => f.id === x))
  const floor: HouseFloor = {
    id,
    name: FLOOR_NAMES[level] ?? `Floor ${level}`,
    level,
    rooms: [],
    openings: [],
    placements: [],
  }
  if (walled.length) {
    const rects = walled.flatMap(roomRects)
    const x = Math.min(...rects.map((r) => r.x))
    const y = Math.min(...rects.map((r) => r.y))
    const w = Math.max(...rects.map((r) => r.x + r.w)) - x
    const h = Math.max(...rects.map((r) => r.y + r.h)) - y
    floor.rooms.push({ id: uniqueId('room', roomTaken(plan)), name: 'Room 1', kind: 'room', x, y, w, h })
  }
  plan.floors.push(floor)
  return floor
}

/** Resize the plot, never smaller than the rooms on it. */
export function setPlotSize(plan: HousePlan, axis: 'w' | 'h', cells: number): void {
  const rects = plan.floors.flatMap((f) => f.rooms.flatMap(roomRects))
  const min = Math.max(2, ...rects.map((r) => (axis === 'w' ? r.x + r.w : r.y + r.h)))
  plan.plot[axis] = clamp(toMm(cells), min, 400)
}

export function removeFloor(plan: HousePlan, floorId: string): void {
  if (plan.floors.length <= 1) return
  plan.floors = plan.floors.filter((f) => f.id !== floorId)
}

const overlaps = (a: HouseRect, b: HouseRect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

const touches = (a: HouseRect, b: HouseRect) => {
  const alongX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const alongY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return (
    ((a.y + a.h === b.y || b.y + b.h === a.y) && alongX >= 1) ||
    ((a.x + a.w === b.x || b.x + b.w === a.x) && alongY >= 1)
  )
}

/**
 * Whether a room's parts make one piece: none overlap, and each shares an
 * edge with the shape before it. The same rule the daemon checks on save,
 * applied while dragging so the editor never shows a shape it would refuse.
 */
export function shapeValid(r: HouseRoom): boolean {
  if (r.outline) return polygonValid(r.outline)
  const shape: HouseRect[] = [r]
  for (const q of r.parts ?? []) {
    if (q.w < 1 || q.h < 1) return false
    if (shape.some((s) => overlaps(s, q)) || !shape.some((s) => touches(s, q))) return false
    shape.push(q)
  }
  return true
}

const copyPoint = (p: Point): Point => [p[0], p[1]]

/** Whether two segments cross, touching ends not counted. */
function crossing(a: Point, b: Point, c: Point, d: Point): boolean {
  const o = (p: Point, q: Point, r: Point) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]))
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0
}

/**
 * Whether corners make a room: three or more, at least a quarter of a
 * square metre inside, and no edge crossing another.
 */
export function polygonValid(pts: Point[]): boolean {
  if (pts.length < 3) return false
  if (pts.some((p, i) => same(p[0], pts[(i + 1) % pts.length][0]) && same(p[1], pts[(i + 1) % pts.length][1])))
    return false
  if (Math.abs(loopArea(pts)) < 1) return false
  const n = pts.length
  for (let i = 0; i < n; i++)
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue
      if (crossing(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return false
    }
  return true
}

/** Fit a room drawn corner by corner's box to its corners, clockwise on screen. */
function fitBox(r: HouseRoom): void {
  if (!r.outline) return
  if (loopArea(r.outline) < 0) r.outline.reverse()
  const xs = r.outline.map((p) => p[0])
  const ys = r.outline.map((p) => p[1])
  r.x = Math.min(...xs)
  r.y = Math.min(...ys)
  r.w = toMm(Math.max(...xs) - r.x)
  r.h = toMm(Math.max(...ys) - r.y)
}

/** A room drawn corner by corner. Null when the corners do not make one. */
export function addPolygonRoom(
  plan: HousePlan,
  floor: HouseFloor,
  corners: Point[],
  kind: HouseRoom['kind'] = 'room',
): HouseRoom | null {
  if (!polygonValid(corners)) return null
  const r = addRoom(plan, floor, { x: 0, y: 0, w: 1, h: 1 }, kind)
  r.outline = corners.map(copyPoint)
  fitBox(r)
  return r
}

/** Move one corner of a room drawn corner by corner, where the room still holds together. */
export function moveCorner(r: HouseRoom, i: number, p: Point): boolean {
  if (!r.outline) return false
  const next = r.outline.map((q, j) => (j === i ? copyPoint(p) : q))
  if (!polygonValid(next)) return false
  r.outline = next
  fitBox(r)
  return true
}

/** Put a room where a snapshot had it, moved by (dx, dy): its rectangles, or its corners. */
export function shiftRoom(r: HouseRoom, from: { o: HouseRect[]; outline?: Point[] }, dx: number, dy: number): void {
  roomRects(r).forEach((q, i) => Object.assign(q, { x: toMm(from.o[i].x + dx), y: toMm(from.o[i].y + dy) }))
  if (from.outline) r.outline = from.outline.map((p) => [toMm(p[0] + dx), toMm(p[1] + dy)])
}

/** Join a rectangle to a room as a wing. False when it would not make one piece. */
export function addPart(r: HouseRoom, rect: HouseRect): boolean {
  const parts = [...(r.parts ?? []), { ...rect }]
  if (parts.length > 8 || !shapeValid({ ...r, parts })) return false
  r.parts = parts
  return true
}

/**
 * Remove a wing. The parts after it may have hung off it, so any that no
 * longer join the room go too, rather than leaving a room in two pieces.
 */
export function removePart(r: HouseRoom, index: number): void {
  const rest = (r.parts ?? []).filter((_, i) => i !== index)
  const kept: HouseRect[] = []
  for (const q of rest) if (shapeValid({ ...r, parts: [...kept, q] })) kept.push(q)
  if (kept.length) r.parts = kept
  else delete r.parts
}

/** What moves with a room when it is dragged: its openings and the devices in it. */
export function roomPayload(floor: HouseFloor, r: HouseRoom) {
  // Rooms drawn inside this one move with it: an en-suite goes where its
  // bedroom goes.
  const inner = floor.rooms.filter(
    (x) => x !== r && roomShapes(x).every((loop) => loop.every(([px, py]) => roomContains(r, px, py))),
  )
  const group = new Set<HouseRoom>([r, ...inner])
  // The outlines of the rooms that move, so their doors and radiators go too.
  const edge = new Walls([...group].flatMap(roomOutline))
  const onEdge = (o: Pick<HouseOpening, 'axis' | 'x' | 'y' | 'len'>) => openingFits(o, edge)
  return {
    rooms: inner.map((x) => ({ room: x, o: roomRects(x).map((q) => ({ ...q })), outline: x.outline?.map(copyPoint) })),
    openings: floor.openings.filter(onEdge).map((o) => ({ o, x: o.x, y: o.y })),
    radiators: (floor.radiators ?? []).filter(onEdge).map((r) => ({ o: r, x: r.x, y: r.y })),
    furniture: (floor.furniture ?? [])
      .filter((f) => {
        const at = roomAt(floor, f.x + f.w / 2, f.y + f.d / 2)
        return !!at && group.has(at)
      })
      .map((f) => ({ o: f, x: f.x, y: f.y })),
    placements: floor.placements
      .filter((p) => {
        if (p.opening) return false
        const at = roomAt(floor, p.x, p.y)
        return !!at && group.has(at)
      })
      .map((p) => ({ p, x: p.x, y: p.y })),
  }
}

/** The point on a wall nearest a point, within reach of a finger. */
export function nearestWall(floor: HouseFloor, x: number, y: number, reach = 1.4): WallUnit | null {
  return Walls.of(floor).nearest(x, y, reach)
}

/** The opening on that wall at that point, if any. */
export function openingAt(floor: HouseFloor, u: WallUnit): HouseOpening | undefined {
  return floor.openings.find((o) => {
    if (!sameLine(openingLine(o), u.line)) return false
    const [s, e] = openingSpan(o)
    return mmOf(s) <= mmOf(u.at) && mmOf(u.at) <= mmOf(e)
  })
}

/**
 * The stretch of the wall at `u` that is free: up to the wall's ends, or the
 * doors and windows either side. Null when `u` is on a door or window.
 */
function freeAround(floor: HouseFloor, u: WallUnit): [number, number] | null {
  const stretch = Walls.of(floor).holdingOn(u.line, u.at, u.at)
  if (!stretch) return null
  let [lo, hi] = stretch
  for (const o of floor.openings) {
    if (!sameLine(openingLine(o), u.line)) continue
    const [s, e] = openingSpan(o)
    if (mmOf(e) <= mmOf(u.at)) lo = Math.max(lo, e)
    else if (mmOf(s) >= mmOf(u.at)) hi = Math.min(hi, s)
    else return null
  }
  return [lo, hi]
}

/**
 * Put a door or window on the wall at `u`, as wide as its preset and centred
 * on the tap where the wall allows. Returns null when there is no free wall
 * half a metre long there.
 */
export function addOpening(floor: HouseFloor, u: WallUnit, preset: OpeningPreset): HouseOpening | null {
  const free = freeAround(floor, u)
  if (!free || mmOf(free[1] - free[0]) < mmOf(1)) return null
  // As wide as the preset: a sliding door two metres, the usual two panes.
  const len = Math.min(presetCells(preset), free[1] - free[0])
  const start = clamp(snapOn(floor, u, u.at - len / 2), free[0], free[1] - len)
  const id = uniqueId(preset.kind, (x) => floor.openings.some((o) => o.id === x))
  const o: HouseOpening = { id, type: preset.kind, ...onLine(u.line, start, len) }
  applyPreset(o, preset)
  floor.openings.push(o)
  return o
}

/**
 * The window, sliding door or glass door nearest a point, within two cells, that has no
 * shutter yet.
 * Measured to the window's segment, so a drop anywhere along a wide window
 * counts, not only near its middle.
 */
export function nearestFreeWindow(floor: HouseFloor, x: number, y: number, reach = 2): HouseOpening | null {
  const taken = new Set(floor.placements.map((p) => p.opening).filter(Boolean))
  let best: HouseOpening | null = null
  let bd = reach
  for (const o of floor.openings) {
    if (!takesShutter(o) || taken.has(o.id)) continue
    const l = openingLine(o)
    const [s, e] = openingSpan(o)
    const [cx, cy] = pointAt(l, clamp(along(l, [x, y]), s, e))
    const d = Math.hypot(x - cx, y - cy)
    if (d < bd) {
      bd = d
      best = o
    }
  }
  return best
}

/** Whether an opening would sit wholly on wall, clear of every other opening. */
export function fitsFree(floor: HouseFloor, o: HouseOpening): boolean {
  if (mmOf(o.len) < mmOf(1)) return false
  return openingFits(o, Walls.of(floor)) && !floor.openings.some((x) => x.id !== o.id && openingsOverlap(x, o))
}

/**
 * Leave the wall at `u` out: the whole stretch of it the same two rooms
 * share, up to the corners or the doors and windows already on it. Two rooms
 * that run into each other usually have nothing between them at all.
 */
export function addOpenWall(floor: HouseFloor, u: WallUnit): HouseOpening | null {
  const free = freeAround(floor, u)
  if (!free) return null
  // Which rooms are either side at a point along the wall.
  const k = 0.01
  const n = rightOf(u.line)
  const sides = (t: number) => {
    const [px, py] = pointAt(u.line, t)
    const a = roomAt(floor, px - n[0] * k, py - n[1] * k)
    const b = roomAt(floor, px + n[0] * k, py + n[1] * k)
    return `${a?.id ?? ''}|${b?.id ?? ''}`
  }
  // Where the rooms either side can change: any room's corner along the wall.
  const cuts = new Set<number>([free[0], free[1]])
  for (const r of floor.rooms)
    for (const loop of roomShapes(r))
      for (const p of loop) {
        const c = along(u.line, p)
        if (mmOf(c) > mmOf(free[0]) && mmOf(c) < mmOf(free[1])) cuts.add(c)
      }
  const at = [...cuts].sort((a, b) => a - b)
  const i = Math.max(
    0,
    at.findIndex((c, n) => n + 1 < at.length && mmOf(c) <= mmOf(u.at) && mmOf(u.at) <= mmOf(at[n + 1])),
  )
  const pair = sides((at[i] + at[i + 1]) / 2)
  let lo = i
  let hi = i + 1
  while (lo > 0 && sides((at[lo - 1] + at[lo]) / 2) === pair) lo--
  while (hi + 1 < at.length && sides((at[hi] + at[hi + 1]) / 2) === pair) hi++
  const id = uniqueId('open', (x) => floor.openings.some((o) => o.id === x))
  const o: HouseOpening = { id, type: 'open', ...onLine(u.line, at[lo], at[hi] - at[lo]) }
  floor.openings.push(o)
  return o
}

/**
 * Slide an opening so the spot it was grabbed by (`grab` cells from its
 * start) follows the pointer. It can jump to another wall, turning with it.
 * Nothing changes where it would not fit, so a drag past a corner or onto
 * another door just stops at the last place that worked.
 */
export function moveOpening(floor: HouseFloor, o: HouseOpening, x: number, y: number, grab: number): boolean {
  const u = nearestWall(floor, x, y)
  if (!u) return false
  const start = snapOn(floor, u, along(u.line, [x, y]) - grab)
  const next = placedOn(o, onLine(u.line, start, o.len))
  // A side is named for the wall's direction, so a turned door opens the default way.
  if (!parallel(openingLine(next), openingLine(o))) delete next.opens
  if (!fitsFree(floor, next)) return false
  setPlace(o, next)
  return true
}

/** Drag one end of an opening along its wall, snapped, never under half a metre long. */
export function resizeOpening(floor: HouseFloor, o: HouseOpening, end: 'start' | 'end', x: number, y: number): boolean {
  const next = resized(floor, o, end, x, y)
  if (!fitsFree(floor, next)) return false
  setPlace(o, next)
  return true
}

/** The same thing with one end moved to where the pointer is along its wall. */
function resized<T extends OnWall>(floor: HouseFloor, o: T, end: 'start' | 'end', x: number, y: number): T {
  const l = openingLine(o)
  const [s0, s1] = openingSpan(o)
  const at = snapOn(floor, { line: l, at: s0 }, along(l, [x, y]))
  const start = end === 'start' ? Math.min(at, s1 - 1) : s0
  const stop = end === 'end' ? Math.max(at, s0 + 1) : s1
  return placedOn(o, onLine(l, start, stop - start))
}

/** Put a door or radiator where `next` is, dropping what it no longer has. */
function setPlace<T extends OnWall & { opens?: string }>(o: T, next: T): void {
  Object.assign(o, next)
  if (!next.to) delete o.to
  if (!next.opens) delete o.opens
}

/**
 * A place along a wall, snapped. Along x or y that is the grid. At an angle
 * it is the distance from the stretch's first end, so a door lands a whole
 * number of centimetres from the corner rather than off the grid's lines.
 */
function snapOn(floor: HouseFloor, u: WallUnit, t: number): number {
  if (u.line.axis !== 's') return snap(t, true)
  const s = Walls.of(floor).holdingOn(u.line, u.at, u.at)?.[0] ?? 0
  return s + snap(t - s, true)
}

/** Whether two wall lines run the same way, so a door's side means the same on both. */
const parallel = (a: Line, b: Line) =>
  a.axis === b.axis && (a.axis !== 's' || Math.abs(a.d[0] * b.d[1] - a.d[1] * b.d[0]) < 1e-6)

// ─── Walls ──────────────────────────────────────────────────────────────────
// Walls follow the room edges. What the person sets on one (thickness,
// height) is kept on the floor by where the wall is, and the plan's walls
// take it from there when saved (@nubisco/bim/convert).

/** A wall of a floor, in cells, with what it is built as. */
export interface FloorWall {
  /** Where it is, as a key: the same wall keeps it while rooms do not move. A drawn wall's is `d:` and its id. */
  key: string
  /** The drawn wall this is, for one drawn on its own. */
  drawn?: HouseDrawnWall
  /** Null for a wall at an angle. */
  axis: 'h' | 'v' | null
  /** For one along x or y: the line it is on, and where it starts and ends along it. 0 at an angle. */
  line: number
  start: number
  end: number
  /** Its ends. */
  a: Point
  b: Point
  /** Between two rooms, rather than with a room on one side only. */
  inner: boolean
  /** Millimetres. */
  thickness: number
  height: number
}

/** The walls a run is made of, each with its own thickness and height, end to end along it. */
export function runPieces(run: WallRun, walls: FloorWall[]): Array<{ A: Point; B: Point; w: FloorWall }> {
  const A: Point = [run.x1, run.y1]
  const B: Point = [run.x2, run.y2]
  if (!same(run.x1, run.x2) && !same(run.y1, run.y2)) {
    // At an angle: the slanted walls on its line, each for the stretch of the run it covers.
    const l = lineThrough(A, B)
    const [a, b] = [along(l, A), along(l, B)]
    const out: Array<{ A: Point; B: Point; w: FloorWall }> = []
    for (const w of walls) {
      if (w.axis || !sameLine(lineThrough(w.a, w.b), l)) continue
      const [wa, wb] = [along(l, w.a), along(l, w.b)]
      const s = Math.max(Math.min(a, b), Math.min(wa, wb))
      const e = Math.min(Math.max(a, b), Math.max(wa, wb))
      if (mmOf(e) <= mmOf(s)) continue
      out.push(a <= b ? { A: pointAt(l, s), B: pointAt(l, e), w } : { A: pointAt(l, e), B: pointAt(l, s), w })
    }
    return out
  }
  const axis = same(run.y1, run.y2) ? 'h' : 'v'
  const [a, b] = axis === 'h' ? [run.x1, run.x2] : [run.y1, run.y2]
  const line = axis === 'h' ? run.y1 : run.x1
  const out: Array<{ A: Point; B: Point; w: FloorWall }> = []
  for (const w of walls) {
    if (w.axis !== axis || !same(w.line, line)) continue
    const s = Math.max(Math.min(a, b), w.start)
    const e = Math.min(Math.max(a, b), w.end)
    if (mmOf(e) <= mmOf(s)) continue
    out.push(axis === 'h' ? { A: [s, line], B: [e, line], w } : { A: [line, s], B: [line, e], w })
  }
  return out
}

// ─── Walls as solids ────────────────────────────────────────────────────────

const segDist = (p: Point, a: Point, b: Point) => {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]]
  const t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1), 0, 1)
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t)
}
const leftOf = (d: Point): Point => [-d[1], d[0]]
/** Where the line through p along d meets the line through q along e. */
function meet(p: Point, d: Point, q: Point, e: Point): Point | null {
  const den = d[0] * e[1] - d[1] * e[0]
  if (Math.abs(den) < 1e-9) return null
  const t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / den
  return [p[0] + d[0] * t, p[1] + d[1] * t]
}

/**
 * The end of a wall at `p`, travelling into it along `din`: its corner on the
 * left of that travel and the one on the right. Two walls meeting at a corner
 * are cut where their faces meet (a mitre, for any angle and either
 * thickness). A wall ending against the side of another reaches into it, and
 * so does one between rooms meeting a corner of outside walls. A free end, or
 * one at a door or window, is cut square.
 */
function wallEnd(
  p: Point,
  din: Point,
  own: FloorWall,
  walls: FloorWall[],
  gaps: Array<[Point, Point]>,
): [Point, Point] {
  const h = own.thickness / 2 / CELL_MM
  const n = leftOf(din)
  const square = (e: number): [Point, Point] => [
    [p[0] + din[0] * e + n[0] * h, p[1] + din[1] * e + n[1] * h],
    [p[0] + din[0] * e - n[0] * h, p[1] + din[1] * e - n[1] * h],
  ]
  const atEnd = (q: Point) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-3
  if (!atEnd(own.a) && !atEnd(own.b)) return square(0)
  const corners: Array<{ v: Point; h: number; inner: boolean }> = []
  let into = 0
  // Half the thickness of a wall at the corner whose end there is a door or window.
  let blocked = 0
  for (const g of walls) {
    if (g === own) continue
    const gu = unit(g.a, g.b)
    if (Math.abs(din[0] * gu[1] - din[1] * gu[0]) < 1e-6) continue
    const hg = g.thickness / 2 / CELL_MM
    // A door, window or open stretch at the corner: there is no wall there to meet.
    const open = gaps.some(
      ([a, b]) => segDist(p, a, b) < 1e-3 && Math.abs(gu[0] * (b[1] - a[1]) - gu[1] * (b[0] - a[0])) < 1e-6,
    )
    if (open && (atEnd(g.a) || atEnd(g.b))) {
      blocked = Math.max(blocked, hg)
      continue
    }
    if (atEnd(g.a)) corners.push({ v: gu, h: hg, inner: g.inner })
    else if (atEnd(g.b)) corners.push({ v: [-gu[0], -gu[1]], h: hg, inner: g.inner })
    else if (segDist(p, g.a, g.b) < 1e-3) {
      // Against the side of a wall running past: reach its far face.
      const sin = Math.abs(din[0] * gu[1] - din[1] * gu[0])
      into = Math.max(into, hg / sin)
    }
  }
  // Where more than two walls meet, an outside wall turns the corner with the
  // other outside wall, and a wall between rooms butts into them.
  const pair = corners.length === 1 ? corners : corners.filter((c) => c.inner === own.inner)
  if (pair.length === 1 && !into && !blocked && !(own.inner && corners.length > 1)) {
    const { v, h: hg } = pair[0]
    const m = leftOf(v)
    const l = meet([p[0] + n[0] * h, p[1] + n[1] * h], din, [p[0] + m[0] * hg, p[1] + m[1] * hg], v)
    const r = meet([p[0] - n[0] * h, p[1] - n[1] * h], din, [p[0] - m[0] * hg, p[1] - m[1] * hg], v)
    // A very sharp corner would run its point far out: cut it square instead.
    const far = 4 * Math.max(h, hg)
    if (l && r && Math.hypot(l[0] - p[0], l[1] - p[1]) < far && Math.hypot(r[0] - p[0], r[1] - p[1]) < far)
      return [l, r]
  }
  // A wall between rooms stops at a corner of outside walls, which close it.
  if (own.inner && corners.length > 1) return square(into)
  return square(Math.max(into, blocked, ...corners.map((c) => c.h)))
}

/** A piece of wall as its outline on the floor: start left, end left, end right, start right. */
export function wallOutline(
  A: Point,
  B: Point,
  own: FloorWall,
  walls: FloorWall[],
  gaps: Array<[Point, Point]>,
): Point[] {
  const u = unit(A, B)
  const [eL, eR] = wallEnd(B, u, own, walls, gaps)
  // Travelling into the start, the wall's left is on the right.
  const [sR, sL] = wallEnd(A, [-u[0], -u[1]], own, walls, gaps)
  return [sL, eL, eR, sR]
}

/** Where a floor's walls are not, for wallOutline: its doors, windows and open stretches. */
export function wallGaps(runs: WallRun[]): Array<[Point, Point]> {
  return runs
    .filter((r) => r.type !== 'wall')
    .map((r): [Point, Point] => [
      [r.x1, r.y1],
      [r.x2, r.y2],
    ])
}

/** Every wall of a floor, cut where it changes from between rooms to outside, as the saved plan cuts them. */
export function floorWalls(floor: HouseFloor): FloorWall[] {
  const drawn = (floor.drawnWalls ?? []).map((d): FloorWall => {
    const axis = drawnAxis(d)
    const i = axis === 'v' ? 1 : 0
    return {
      key: `d:${d.id}`,
      drawn: d,
      axis,
      line: axis ? d.a[1 - i] : 0,
      start: axis ? Math.min(d.a[i], d.b[i]) : 0,
      end: axis ? Math.max(d.a[i], d.b[i]) : 0,
      a: d.a,
      b: d.b,
      inner: false,
      thickness: d.thickness,
      height: d.height,
    }
  })
  return [...fromRooms(floor), ...drawn]
}

const toCells = (p: Point): Point => [p[0] / CELL_MM, p[1] / CELL_MM]
const toMmPoint = (p: Point): Point => [mmOf(p[0]), mmOf(p[1])]

function fromRooms(floor: HouseFloor): FloorWall[] {
  return wallLines({ ...floor, drawnWalls: undefined } as unknown as FloorV1).map((l) => {
    const [a, b] = [toCells(l.a), toCells(l.b)]
    const spec = specOn(floor, a, b)
    return {
      key: `${l.axis ?? 's'}${l.a[0]}_${l.a[1]}_${l.b[0]}`,
      axis: l.axis,
      line: l.line / CELL_MM,
      start: l.start / CELL_MM,
      end: l.end / CELL_MM,
      a,
      b,
      inner: l.inner,
      thickness: spec?.thickness ?? (l.inner ? DEFAULTS.innerWall : DEFAULTS.outerWall),
      height: spec?.height ?? DEFAULTS.wallHeight,
    }
  })
}

type WallSpec = NonNullable<HouseFloor['walls']>[number]

/** A spec's two ends, in cells. */
function specEnds(w: WallSpec): [Point, Point] {
  if (w.to) return [[w.x, w.y], w.to]
  return [[w.x, w.y], w.axis === 'h' ? [w.x + w.len, w.y] : [w.x, w.y + w.len]]
}

/** How far a spec runs along a wall, in millimetres. */
const specOverlap = (w: WallSpec, a: Point, b: Point) => {
  const [p, q] = specEnds(w)
  return overlapLength([toMmPoint(p), toMmPoint(q)], [toMmPoint(a), toMmPoint(b)])
}

/** The spec that runs along a wall most. */
function specOn(floor: HouseFloor, a: Point, b: Point) {
  let best: WallSpec | undefined
  let most = 0
  for (const w of floor.walls ?? []) {
    const o = specOverlap(w, a, b)
    if (o > most) {
      most = o
      best = w
    }
  }
  return best
}

/** Set a wall's thickness or height. Any spec it overlaps gives way to one that is exactly this wall. */
export function setWall(floor: HouseFloor, w: FloorWall, patch: { thickness?: number; height?: number }): void {
  if (w.drawn) {
    Object.assign(w.drawn, patch)
    return
  }
  const keep = (floor.walls ?? []).filter((s) => specOverlap(s, w.a, w.b) <= 0)
  const thickness = patch.thickness ?? w.thickness
  const height = patch.height ?? w.height
  keep.push(
    w.axis
      ? {
          axis: w.axis,
          x: w.axis === 'h' ? w.start : w.line,
          y: w.axis === 'v' ? w.start : w.line,
          len: toMm(w.end - w.start),
          thickness,
          height,
        }
      : { axis: 'h', x: w.a[0], y: w.a[1], len: 0, to: [w.b[0], w.b[1]], thickness, height },
  )
  floor.walls = keep
}

// ─── Walls drawn on their own ───────────────────────────────────────────────

/** Where a drawn wall's end can catch: a room's corner, or another drawn wall's end. */
function catchPoints(floor: HouseFloor, except?: string): Point[] {
  const out: Point[] = []
  for (const r of floor.rooms) for (const loop of roomShapes(r)) out.push(...loop)
  for (const d of floor.drawnWalls ?? []) if (d.id !== except) out.push(d.a, d.b)
  return out
}

/**
 * Where a drawn wall's end goes for a pointer at (x, y): onto a corner or
 * another wall's end within reach, else snapped. From `from`, a line within
 * a few degrees of straight across or down is made exactly so, which is
 * what doors need and what was almost certainly meant.
 */
export function wallPoint(floor: HouseFloor, x: number, y: number, from?: Point, except?: string, skip?: Point): Point {
  return catchPoint(catchPoints(floor, except), x, y, from, skip)
}

/** The nearest of `points` within reach of (x, y), else (x, y) snapped, straightened from `from`. */
function catchPoint(points: Point[], x: number, y: number, from?: Point, skip?: Point): Point {
  const reach = 0.4
  let p: Point = [snap(x, true), snap(y, true)]
  let best = reach
  for (const c of points) {
    // The corner being dragged does not catch on where it is now.
    if (skip && same(c[0], skip[0]) && same(c[1], skip[1])) continue
    const d = Math.hypot(c[0] - x, c[1] - y)
    if (d < best) {
      best = d
      p = [c[0], c[1]]
    }
  }
  if (from) {
    const dx = p[0] - from[0]
    const dy = p[1] - from[1]
    const tan = Math.tan((4 * Math.PI) / 180)
    if (Math.abs(dy) <= Math.abs(dx) * tan) p = [p[0], from[1]]
    else if (Math.abs(dx) <= Math.abs(dy) * tan) p = [from[0], p[1]]
  }
  return [toMm(p[0]), toMm(p[1])]
}

/** Whether a drawn wall can stand there: long enough, and not along another wall. */
export function drawnWallFits(floor: HouseFloor, d: Pick<HouseDrawnWall, 'id' | 'a' | 'b'>): boolean {
  if (Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]) < 0.2) return false
  const axis = drawnAxis(d)
  if (!axis) return true
  const others = Walls.of({ ...floor, drawnWalls: (floor.drawnWalls ?? []).filter((x) => x.id !== d.id) })
  const i = axis === 'h' ? 0 : 1
  return !others.overlapping(axis, d.a[1 - i], Math.min(d.a[i], d.b[i]), Math.max(d.a[i], d.b[i]))
}

/** Draw a wall from `a` to `b`: a partition, 100 mm thick and full height, until the person says otherwise. */
export function addDrawnWall(floor: HouseFloor, a: Point, b: Point): HouseDrawnWall | null {
  const taken = (v: string) =>
    (floor.drawnWalls ?? []).some((x) => x.id === v) ||
    floor.openings.some((o) => o.id === v) ||
    (floor.radiators ?? []).some((r) => r.id === v)
  const d: HouseDrawnWall = {
    id: uniqueId('wall', taken),
    a,
    b,
    thickness: DEFAULTS.innerWall,
    height: DEFAULTS.wallHeight,
  }
  if (!drawnWallFits(floor, d)) return null
  ;(floor.drawnWalls ??= []).push(d)
  return d
}

/** Move a drawn wall's ends, where it still fits. */
export function moveDrawnWall(floor: HouseFloor, d: HouseDrawnWall, a: Point, b: Point): boolean {
  if (!drawnWallFits(floor, { id: d.id, a, b })) return false
  d.a = a
  d.b = b
  return true
}

/** The doors, windows and radiators on a drawn wall, with where they are, so moving it carries them. */
export function onDrawnWall(floor: HouseFloor, d: HouseDrawnWall) {
  const axis = drawnAxis(d)
  const i = axis === 'h' ? 0 : 1
  const only = axis
    ? new Walls([{ axis, line: d.a[1 - i], start: Math.min(d.a[i], d.b[i]), end: Math.max(d.a[i], d.b[i]) }])
    : new Walls([], [[d.a, d.b]])
  return [...floor.openings, ...(floor.radiators ?? [])]
    .filter((x) => openingFits(x, only))
    .map((o) => ({ o, x: o.x, y: o.y, to: o.to }))
}

/**
 * What is on a drawn wall, said from the end that stays while the other is
 * dragged: how far along, how wide, which end the hinge is at, and which
 * side it opens to or hangs on, so it can follow the wall round.
 */
export interface Held {
  o: HouseOpening | HouseRadiator
  from: number
  hingeNear: boolean
  left: boolean
}

export function holdOnWall(floor: HouseFloor, d: HouseDrawnWall, fixed: Point, moving: Point): Held[] {
  const dir = unit(fixed, moving)
  const left: Point = [dir[1], -dir[0]]
  const dist = (p: Point) => Math.hypot(p[0] - fixed[0], p[1] - fixed[1])
  return onDrawnWall(floor, d).map(({ o }) => {
    const a: Point = [o.x, o.y]
    const b = openingEnd(o)
    const n = 'side' in o ? radiatorNormal(o) : opensTowards(o)
    const hinge = 'side' in o || o.hinge !== 'end' ? a : b
    return {
      o,
      from: Math.min(dist(a), dist(b)),
      hingeNear: dist(hinge) <= Math.min(dist(a), dist(b)) + 1e-9,
      left: n[0] * left[0] + n[1] * left[1] > 0,
    }
  })
}

/** Put what a drawn wall holds back on it, as `holdOnWall` said it, once its end has moved. */
export function followWall(held: Held[], fixed: Point, moving: Point): void {
  const dir = unit(fixed, moving)
  const l = lineThrough(fixed, moving)
  const forward = l.d[0] * dir[0] + l.d[1] * dir[1] > 0
  for (const h of held) {
    const near = along(l, [fixed[0] + dir[0] * h.from, fixed[1] + dir[1] * h.from])
    const next = placedOn(h.o, onLine(l, forward ? near : near - h.o.len, h.o.len))
    const n: Point = h.left ? [dir[1], -dir[0]] : [-dir[1], dir[0]]
    if ('side' in next) next.side = sideName(l, n)
    else if (next.type === 'door' || next.opens !== undefined || next.hinge !== undefined) {
      // Only what swings says how: a window or gap that never said keeps saying nothing.
      next.opens = sideName(l, n)
      if (h.hingeNear === forward) delete next.hinge
      else next.hinge = 'end'
    }
    Object.assign(h.o, next)
    if (!next.to) delete h.o.to
    if (!('side' in next) && next.hinge === undefined) delete (h.o as HouseOpening).hinge
  }
}

const unit = (a: Point, b: Point): Point => {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
  return [(b[0] - a[0]) / len, (b[1] - a[1]) / len]
}

/** Make a drawn wall this long, from its first end. */
export function setDrawnLength(floor: HouseFloor, d: HouseDrawnWall, len: number): boolean {
  const now = Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1])
  if (!now) return false
  const k = len / now
  const b: Point = [toMm(d.a[0] + (d.b[0] - d.a[0]) * k), toMm(d.a[1] + (d.b[1] - d.a[1]) * k)]
  return moveDrawnWall(floor, d, d.a, b)
}

export function removeDrawnWall(floor: HouseFloor, id: string): void {
  floor.drawnWalls = (floor.drawnWalls ?? []).filter((d) => d.id !== id)
  if (!floor.drawnWalls.length) delete floor.drawnWalls
}

// ─── The Ruler ──────────────────────────────────────────────────────────────

/** Where a dimension's end can catch: corners, wall ends, the ends of doors, windows and radiators, other dimensions. */
function measurePoints(floor: HouseFloor, except?: string): Point[] {
  const out = catchPoints(floor)
  for (const o of [...floor.openings, ...(floor.radiators ?? [])]) out.push([o.x, o.y], openingEnd(o))
  for (const d of floor.dimensions ?? []) if (d.id !== except) out.push(d.a, d.b)
  return out
}

/** Where a dimension's end goes for a pointer at (x, y). */
export function rulerPoint(floor: HouseFloor, x: number, y: number, from?: Point, except?: string): Point {
  return catchPoint(measurePoints(floor, except), x, y, from)
}

export const dimensionLength = (d: { a: Point; b: Point }) => Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1])

/** Leave a dimension line on the plan, from `a` to `b`. Null when its ends are too close to measure. */
export function addDimension(floor: HouseFloor, a: Point, b: Point): HouseDimension | null {
  if (dimensionLength({ a, b }) < 0.1) return null
  const d: HouseDimension = { id: uniqueId('dim', (v) => (floor.dimensions ?? []).some((x) => x.id === v)), a, b }
  ;(floor.dimensions ??= []).push(d)
  return d
}

export function removeDimension(floor: HouseFloor, id: string): void {
  floor.dimensions = (floor.dimensions ?? []).filter((d) => d.id !== id)
  if (!floor.dimensions.length) delete floor.dimensions
}

/**
 * Make the whole plan `k` times its size, about the plot's corner: every
 * position and length across the ground, on every floor. Heights and wall
 * thicknesses stay. With `keepSizes`, doors, windows, radiators, furniture
 * and gates move with the plan and keep their size, unless a door or
 * radiator would then not fit its wall, when it is scaled too.
 */
export function resizePlan(plan: HousePlan, k: number, keepSizes: boolean): void {
  const at = (v: number) => toMm(v * k)
  const pt = (p: Point): Point => [at(p[0]), at(p[1])]
  // A rectangle by its corners, so two that touch still touch.
  const rect = <R extends { x: number; y: number }>(r: R, w: 'w', h: 'h' | 'd') => {
    const o = r as R & Record<'w' | 'h' | 'd', number>
    const [x2, y2] = [at(o.x + o[w]), at(o.y + o[h])]
    o.x = at(o.x)
    o.y = at(o.y)
    o[w] = toMm(x2 - o.x)
    o[h] = toMm(y2 - o.y)
  }
  plan.plot = { w: at(plan.plot.w), h: at(plan.plot.h) }
  for (const f of plan.floors) {
    for (const r of f.rooms) {
      if (r.outline) {
        r.outline = r.outline.map(pt)
        fitBox(r)
      } else {
        rect(r, 'w', 'h')
        for (const q of r.parts ?? []) rect(q, 'w', 'h')
      }
    }
    for (const w of f.walls ?? []) {
      const end = w.to ?? (w.axis === 'h' ? [w.x + w.len, w.y] : [w.x, w.y + w.len])
      const [x, y] = pt([w.x, w.y])
      const e = pt(end as Point)
      Object.assign(w, { x, y })
      if (w.to) w.to = e
      else w.len = toMm(w.axis === 'h' ? e[0] - x : e[1] - y)
    }
    for (const d of f.drawnWalls ?? []) Object.assign(d, { a: pt(d.a), b: pt(d.b) })
    for (const d of f.dimensions ?? []) Object.assign(d, { a: pt(d.a), b: pt(d.b) })
    // Everything on a wall: its line scales, and along it either both ends or the middle.
    const walls = Walls.of(f)
    for (const o of [...f.openings, ...(f.radiators ?? [])]) {
      if (o.to) {
        // At an angle its ends are not whole millimetres, so it goes back
        // onto its wall, which moved to whole millimetres, by its middle.
        const [mx, my] = openingMiddle(o)
        const u = walls.nearest(mx * k, my * k, 0.5)
        if (!u) continue
        const mid = along(u.line, [mx * k, my * k])
        const kept = onLine(u.line, mid - o.len / 2, o.len)
        const len = toMm(o.len * k)
        Object.assign(o, keepSizes && openingFits(kept, walls) ? kept : onLine(u.line, mid - len / 2, len))
        continue
      }
      const i = o.axis === 'h' ? 'x' : 'y'
      const across = o.axis === 'h' ? 'y' : 'x'
      const scaled = { [across]: at(o[across]), [i]: at(o[i]), len: toMm(at(o[i] + o.len) - at(o[i])) }
      const kept = { [across]: at(o[across]), [i]: toMm(at(o[i] + o.len / 2) - o.len / 2), len: o.len }
      Object.assign(o, keepSizes && openingFits({ ...o, ...kept }, walls) ? kept : scaled)
    }
    for (const u of f.furniture ?? []) {
      if (keepSizes) {
        u.x = toMm(at(u.x + u.w / 2) - u.w / 2)
        u.y = toMm(at(u.y + u.d / 2) - u.d / 2)
      } else rect(u, 'w', 'd')
      keepInPlot(plan, u)
    }
    for (const p of f.placements) {
      p.x = at(p.x)
      p.y = at(p.y)
      if (p.length !== undefined && !keepSizes) p.length = at(p.length)
    }
  }
}

// ─── Radiators ──────────────────────────────────────────────────────────────

const crosses = (a: [number, number], b: [number, number]) => mmOf(a[0]) < mmOf(b[1]) && mmOf(b[0]) < mmOf(a[1])

/**
 * Whether a radiator sits wholly on wall: not across a doorway or an open
 * wall, and not over another radiator on the same side. Under a window is
 * where radiators usually are, so a window is fine.
 */
export function radiatorFits(floor: HouseFloor, r: HouseRadiator): boolean {
  if (mmOf(r.len) < mmOf(1)) return false
  if (!openingFits(r, Walls.of(floor))) return false
  const l = openingLine(r)
  const span = openingSpan(r)
  const on = (x: OnWall) => sameLine(openingLine(x), l) && crosses(openingSpan(x), span)
  if (floor.openings.some((o) => o.type !== 'window' && on(o))) return false
  return !(floor.radiators ?? []).some((x) => x.id !== r.id && x.side === r.side && on(x))
}

/** The side of the wall at `u` that a point is on, as a radiator names it. */
function sideOf(u: WallUnit, x: number, y: number): HouseRadiator['side'] {
  const l = u.line
  if (l.axis === 's') return across(l, [x, y]) < 0 ? 'left' : 'right'
  return l.axis === 'h' ? (y < l.o[1] ? 'up' : 'down') : x < l.o[0] ? 'left' : 'right'
}
const flip = (s: HouseRadiator['side']): HouseRadiator['side'] =>
  ({ up: 'down', down: 'up', left: 'right', right: 'left' })[s] as HouseRadiator['side']

/**
 * Put a radiator on the wall at `u`, a metre wide, centred on the tap, on the
 * side the tap is on. A tap outside the house still puts it inside: a
 * radiator always hangs in a room.
 */
export function addRadiator(floor: HouseFloor, u: WallUnit, x: number, y: number): HouseRadiator | null {
  let side = sideOf(u, x, y)
  const [px, py] = pointAt(u.line, u.at)
  const inRoom = (s: HouseRadiator['side']) => {
    const [nx, ny] = sideNormal(u.line, s)
    return roomAt(floor, px + nx * 0.5, py + ny * 0.5)?.kind === 'room'
  }
  if (!inRoom(side)) side = flip(side)
  if (!inRoom(side)) return null
  const id = uniqueId(
    'radiator',
    (v) => (floor.radiators ?? []).some((r) => r.id === v) || floor.openings.some((o) => o.id === v),
  )
  const centre = along(u.line, [x, y])
  for (const len of [CELLS_PER_M, 1.5, 1]) {
    const r: HouseRadiator = { id, ...onLine(u.line, snapOn(floor, u, centre - len / 2), len), side }
    if (radiatorFits(floor, r)) {
      ;(floor.radiators ??= []).push(r)
      return r
    }
  }
  return null
}

/** Slide a radiator along its wall, or onto another, the way a door moves. */
export function moveRadiator(floor: HouseFloor, r: HouseRadiator, x: number, y: number, grab: number): boolean {
  const u = nearestWall(floor, x, y)
  if (!u) return false
  const next = placedOn(r, onLine(u.line, snapOn(floor, u, along(u.line, [x, y]) - grab), r.len))
  // Along the same wall it keeps its side. Onto another, it takes the side the pointer is on.
  next.side = sameLine(u.line, openingLine(r)) ? r.side : sideOf(u, x, y)
  if (!radiatorFits(floor, next)) return false
  setPlace(r, next)
  return true
}

/** Drag one end of a radiator, snapped, never under half a metre. */
export function resizeRadiator(
  floor: HouseFloor,
  r: HouseRadiator,
  end: 'start' | 'end',
  x: number,
  y: number,
): boolean {
  const next = resized(floor, r, end, x, y)
  if (!radiatorFits(floor, next)) return false
  setPlace(r, next)
  return true
}

export function removeRadiator(floor: HouseFloor, id: string): void {
  floor.radiators = (floor.radiators ?? []).filter((r) => r.id !== id)
  if (!floor.radiators.length) delete floor.radiators
}

// ─── Furniture ──────────────────────────────────────────────────────────────

export const FURNITURE_NAME: Record<HouseFurnitureKind, string> = {
  sofa: 'Sofa',
  table: 'Table',
  cabinet: 'Cabinet',
  shelves: 'Shelves',
  rug: 'Rug',
  island: 'Kitchen island',
  bed: 'Bed',
  bath: 'Bath',
  shower: 'Shower',
  toilet: 'Toilet',
  basin: 'Washbasin',
  lounger: 'Sun lounger',
  parasol: 'Parasol',
  planter: 'Planter',
  pergola: 'Pergola',
}

/** The size a new piece starts at, in cells (half a metre each). */
const FURNITURE_SIZE: Record<HouseFurnitureKind, [number, number]> = {
  sofa: [4, 2],
  table: [3, 1.5],
  cabinet: [2, 1],
  shelves: [2, 1],
  rug: [4, 3],
  island: [4, 2],
  bed: [3, 4],
  bath: [3.5, 1.5],
  shower: [2, 2],
  toilet: [1, 1.5],
  basin: [1.5, 1],
  lounger: [1.5, 4],
  parasol: [5, 5],
  planter: [1, 1],
  pergola: [8, 6],
}

const AREA_PIECES = new Set<HouseFurnitureKind>(['pergola', 'rug', 'parasol'])

const halfCell = (v: number) => snap(v, true)

/** Keep a piece inside the plot, moving it rather than shrinking it. */
function keepInPlot(plan: HousePlan, f: HouseFurniture): void {
  f.w = clamp(f.w, 0.5, plan.plot.w)
  f.d = clamp(f.d, 0.5, plan.plot.h)
  f.x = clamp(f.x, 0, plan.plot.w - f.w)
  f.y = clamp(f.y, 0, plan.plot.h - f.d)
}

/**
 * Put a piece of furniture on the floor. A drawn rectangle sets its size, a
 * tap centres one of the usual size on the tap.
 */
export function addFurniture(
  plan: HousePlan,
  floor: HouseFloor,
  kind: HouseFurnitureKind,
  at: { x: number; y: number; w?: number; d?: number },
): HouseFurniture {
  const [w0, d0] = FURNITURE_SIZE[kind]
  const sized = !!at.w && !!at.d && at.w >= 0.5 && at.d >= 0.5
  const w = sized ? (at.w as number) : w0
  const d = sized ? (at.d as number) : d0
  const id = uniqueId(kind, (v) => (floor.furniture ?? []).some((f) => f.id === v))
  const f: HouseFurniture = {
    id,
    kind,
    x: sized ? at.x : halfCell(at.x - w / 2),
    y: sized ? at.y : halfCell(at.y - d / 2),
    w,
    d,
  }
  keepInPlot(plan, f)
  ;(floor.furniture ??= []).push(f)
  return f
}

/** Move a piece, snapped, `grab` being where on it the pointer took it. */
export function moveFurniture(
  plan: HousePlan,
  f: HouseFurniture,
  x: number,
  y: number,
  grab: { x: number; y: number },
) {
  f.x = halfCell(x - grab.x)
  f.y = halfCell(y - grab.y)
  keepInPlot(plan, f)
}

/** Drag a corner of a piece, snapped, never under a quarter metre a side. */
export function resizeFurniture(
  plan: HousePlan,
  f: HouseFurniture,
  corner: string,
  start: { x1: number; y1: number; x2: number; y2: number },
  x: number,
  y: number,
) {
  let { x1, y1, x2, y2 } = start
  if (corner.includes('w')) x1 = clamp(halfCell(x), 0, x2 - 0.5)
  if (corner.includes('e')) x2 = clamp(halfCell(x), x1 + 0.5, plan.plot.w)
  if (corner.includes('n')) y1 = clamp(halfCell(y), 0, y2 - 0.5)
  if (corner.includes('s')) y2 = clamp(halfCell(y), y1 + 0.5, plan.plot.h)
  Object.assign(f, { x: x1, y: y1, w: x2 - x1, d: y2 - y1 })
}

/** A quarter turn clockwise about its centre: width and depth swap, and its back turns with it. */
export function turnFurniture(plan: HousePlan, floor: HouseFloor, f: HouseFurniture) {
  if (FURNITURE_BACK[f.kind]) f.back = clockwiseSide(furnitureBack(floor, f))
  const cx = f.x + f.w / 2
  const cy = f.y + f.d / 2
  Object.assign(f, { w: f.d, d: f.w, x: halfCell(cx - f.d / 2), y: halfCell(cy - f.w / 2) })
  keepInPlot(plan, f)
}

/** Put a piece's back (a bed's head) on the opposite side. */
export function flipFurniture(floor: HouseFloor, f: HouseFurniture) {
  f.back = oppositeSide(furnitureBack(floor, f))
}

export function removeFurniture(floor: HouseFloor, id: string): void {
  floor.furniture = (floor.furniture ?? []).filter((f) => f.id !== id)
  if (!floor.furniture.length) delete floor.furniture
}

export function removeOpening(floor: HouseFloor, id: string): void {
  floor.openings = floor.openings.filter((o) => o.id !== id)
  for (const p of floor.placements) if (p.opening === id) detach(p)
}

export function placementOf(plan: HousePlan, ref: string) {
  for (const f of plan.floors) {
    const p = f.placements.find((x) => x.ref === ref)
    if (p) return { floor: f, placement: p }
  }
  return null
}

export function unplace(plan: HousePlan, ref: string): void {
  for (const f of plan.floors) f.placements = f.placements.filter((p) => p.ref !== ref)
}

/**
 * Put a device on a floor at (x,y), snapped. A shutter dropped
 * near a window attaches to it, which is where it is drawn from then on.
 */
export function place(plan: HousePlan, floor: HouseFloor, device: LiveDevice, x: number, y: number): void {
  const existing = placementOf(plan, device.ref)?.placement
  unplace(plan, device.ref)
  const p = {
    ...(existing ?? {}),
    ref: device.ref,
    x: clamp(snap(x, true), 0, plan.plot.w),
    y: clamp(snap(y, true), 0, plan.plot.h),
  }
  detach(p)
  if (device.kind === 'shutter') {
    const o = nearestFreeWindow(floor, x, y)
    if (o) {
      p.opening = o.id
      claimCovering(floor, o, p)
    }
  }
  floor.placements.push(p)
}

/**
 * Put another plan's contents into a draft, keeping the draft object itself,
 * which the editor and the view around it both hold. For undo and redo.
 */
export function replacePlan(target: HousePlan, source: HousePlan): void {
  for (const k of Object.keys(target) as Array<keyof HousePlan>) if (!(k in source)) delete target[k]
  Object.assign(target, source)
}

/**
 * Tidy a draft before it is saved. Rooms can be moved out from under a door,
 * and a room a circuit served can be deleted. Those leftovers would fail the
 * daemon's checks, so they are dropped here, where the person is still looking.
 */
export function tidy(plan: HousePlan): HousePlan {
  const rooms = new Set(plan.floors.flatMap((f) => f.rooms.map((r) => r.id)))
  for (const f of plan.floors) {
    const walls = Walls.of(f)
    const kept = new Set<string>()
    f.openings = f.openings.filter((o) => {
      const ok = openingFits(o, walls)
      // A door turned into a window or an open wall is no longer a glass door.
      if (o.type !== 'door') delete o.glass
      if (o.type === 'open') delete o.spec
      if (o.spec && !takesShutter(o)) delete o.spec.coverings
      if (ok && takesShutter(o)) kept.add(o.id)
      return ok
    })
    if (f.radiators) {
      f.radiators = f.radiators.filter((r) => radiatorFits(f, r))
      if (!f.radiators.length) delete f.radiators
    }
    // A plot made smaller can leave a piece hanging off it.
    for (const u of f.furniture ?? []) keepInPlot(plan, u)
    for (const p of f.placements) {
      if (p.opening && !kept.has(p.opening)) detach(p)
      const on = p.opening ? f.openings.find((o) => o.id === p.opening) : undefined
      if (p.covering && !on?.spec?.coverings?.some((c) => c.id === p.covering)) delete p.covering
      if (p.circuitRooms) {
        p.circuitRooms = p.circuitRooms.filter((id) => rooms.has(id))
        if (!p.circuitRooms.length) delete p.circuitRooms
      }
      p.x = clamp(p.x, 0, plan.plot.w)
      p.y = clamp(p.y, 0, plan.plot.h)
    }
  }
  return plan
}

// ─── Drawing ────────────────────────────────────────────────────────────────

export interface EditorDrawOptions {
  selectedRoom: string | null
  selectedRef: string | null
  selectedOpening: string | null
  selectedRadiator?: string | null
  selectedFurniture?: string | null
  selectedWall?: string | null
  selectedDimension?: string | null
  /** A dimension being drawn with the Ruler. */
  draftDimension?: { a: Point; b: Point } | null
  draft: Pick<HouseRoom, 'x' | 'y' | 'w' | 'h'> | null
  /** A wall being drawn, end to end. */
  draftWall?: { a: Point; b: Point } | null
  /** A room being drawn corner by corner: the corners so far, and where the next would go. */
  draftPolygon?: { pts: Point[]; next: Point | null } | null
  /** Screen pixels per editor unit, so labels and handles keep their size. */
  unit: number
  /** How far the blueprint is zoomed in, 1 at the fitted view. Markers and handles keep their size on screen. */
  zoom?: number
  showHandles: boolean
}

/**
 * Where a piece's back is, on the blueprint: a heavy line along that edge,
 * and for a bed its pillow, so the head end is plain to see.
 */
function furnitureBackMark(floor: HouseFloor, f: HouseFurniture): string {
  if (!FURNITURE_BACK[f.kind]) return ''
  const side = furnitureBack(floor, f)
  const m = 0.12
  const [x1, y1, x2, y2] =
    side === 'up'
      ? [f.x + m, f.y + m, f.x + f.w - m, f.y + m]
      : side === 'down'
        ? [f.x + m, f.y + f.d - m, f.x + f.w - m, f.y + f.d - m]
        : side === 'left'
          ? [f.x + m, f.y + m, f.x + m, f.y + f.d - m]
          : [f.x + f.w - m, f.y + m, f.x + f.w - m, f.y + f.d - m]
  let out = `<line class="hv-efback" x1="${r1(x1 * S)}" y1="${r1(y1 * S)}" x2="${r1(x2 * S)}" y2="${r1(y2 * S)}"/>`
  if (f.kind === 'bed') {
    const t = 0.6
    const p =
      side === 'up'
        ? { x: f.x + 0.3, y: f.y + 0.3, w: f.w - 0.6, h: t }
        : side === 'down'
          ? { x: f.x + 0.3, y: f.y + f.d - 0.3 - t, w: f.w - 0.6, h: t }
          : side === 'left'
            ? { x: f.x + 0.3, y: f.y + 0.3, w: t, h: f.d - 0.6 }
            : { x: f.x + f.w - 0.3 - t, y: f.y + 0.3, w: t, h: f.d - 0.6 }
    if (p.w > 0 && p.h > 0)
      out += `<rect class="hv-efpillow" x="${r1(p.x * S)}" y="${r1(p.y * S)}" width="${r1(p.w * S)}" height="${r1(p.h * S)}" rx="3"/>`
  }
  return out
}

/** A closed loop as a path, in screen units. */
function loopPath(loop: Point[]): string {
  return loop.map((p, i) => `${i ? 'L' : 'M'}${r1(p[0] * S)},${r1(p[1] * S)}`).join('') + 'Z'
}

/** An edge as a path, in screen units. */
function spanPath(e: WallSpan): string {
  const [x1, y1, x2, y2] = e.axis === 'h' ? [e.start, e.line, e.end, e.line] : [e.line, e.start, e.line, e.end]
  return `M${r1(x1 * S)},${r1(y1 * S)}L${r1(x2 * S)},${r1(y2 * S)}`
}

const metres = (cells: number) => String(Math.round(cells * CELL_MM) / 1000)

export function renderEditor(
  plan: HousePlan,
  floor: HouseFloor,
  devices: Map<string, LiveDevice>,
  o: EditorDrawOptions,
): string {
  const pw = plan.plot.w
  const ph = plan.plot.h
  const U = o.unit
  // The size a marker or handle has at the fitted view, held on screen as it zooms.
  const Z = o.zoom ?? 1
  const fit = (min: number, k: number) => Math.max(min, k * U * Z) / Z
  const fs = fit(11, 11)
  const M = CELLS_PER_M * S
  let h =
    `<defs><pattern id="hv-egrid" width="${M}" height="${M}" patternUnits="userSpaceOnUse"><path class="hv-egl" d="M${M} 0H0V${M}"/></pattern></defs>` +
    `<rect class="hv-eplot" x="0" y="0" width="${pw * S}" height="${ph * S}" fill="url(#hv-egrid)"/>`
  const below = plan.floors.filter((f) => f.level < floor.level).sort((a, b) => b.level - a.level)[0]
  if (below) {
    for (const room of below.rooms.filter((x) => x.kind === 'room')) {
      h += `<path class="hv-eghost" d="${room.outline ? loopPath(room.outline) : roomOutline(room).map(spanPath).join('')}"/>`
    }
  }
  for (const r of roomsOutsideIn(floor.rooms)) {
    // The name sits in the largest part. An L is described by its area,
    // a rectangle by its sides.
    const rects = roomRects(r)
    const q = rects.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a))
    const nfs = Math.min(fs, (q.w * S - 10 * U) / Math.max(1, r.name.length * 0.62))
    const size =
      rects.length > 1 || r.outline ? `${metres(roomArea(r) / CELLS_PER_M)} m²` : `${metres(r.w)} × ${metres(r.h)} m`
    // A room drawn corner by corner is its outline, slanted edges and all.
    const edge = r.outline ? loopPath(r.outline) : roomOutline(r).map(spanPath).join('')
    const fill = r.outline
      ? `<polygon points="${r.outline.map((p) => `${r1(p[0] * S)},${r1(p[1] * S)}`).join(' ')}"/>`
      : rects.map((p) => `<rect x="${p.x * S}" y="${p.y * S}" width="${p.w * S}" height="${p.h * S}"/>`).join('')
    h +=
      `<g class="hv-eroom hv-k-${r.kind}${o.selectedRoom === r.id ? ' hv-sel' : ''}" data-room="${esc(r.id)}">` +
      fill +
      `<path class="hv-eedge" d="${edge}"/>` +
      `<text x="${r1(q.x * S + 7 * U)}" y="${r1(q.y * S + nfs * 1.5)}" font-size="${r1(nfs)}">${esc(r.name)}</text>` +
      (q.h * S > nfs * 3.2
        ? `<text class="hv-dim" x="${r1(q.x * S + 7 * U)}" y="${r1(q.y * S + nfs * 2.7)}" font-size="${r1(nfs * 0.85)}">${size}</text>`
        : '') +
      '</g>'
  }
  // Furniture: a dashed outline with its name, under the walls and devices.
  for (const f of floor.furniture ?? []) {
    const name = FURNITURE_NAME[f.kind]
    const ffs = Math.min(fs * 0.85, (f.w * S - 6 * U) / Math.max(1, name.length * 0.6), f.d * S * 0.45)
    h +=
      `<g class="hv-efurn${o.selectedFurniture === f.id ? ' hv-sel' : ''}" data-furniture="${esc(f.id)}">` +
      `<rect x="${f.x * S}" y="${f.y * S}" width="${f.w * S}" height="${f.d * S}" rx="${r1(Math.min(4, 3 * U))}"/>` +
      furnitureBackMark(floor, f) +
      (ffs >= 6
        ? // Pieces other things stand in (a pergola over a table, a rug under a
          // sofa) name themselves in a corner, out of the way of what is inside.
          AREA_PIECES.has(f.kind)
          ? `<text x="${r1(f.x * S + 5 * U)}" y="${r1(f.y * S + ffs * 1.3)}" font-size="${r1(ffs)}" style="text-anchor:start">${esc(name)}</text>`
          : `<text x="${r1((f.x + f.w / 2) * S)}" y="${r1((f.y + f.d / 2) * S + ffs * 0.35)}" font-size="${r1(ffs)}">${esc(name)}</text>`
        : '') +
      '</g>'
  }
  if (o.draft) {
    const d = o.draft
    h += `<rect class="hv-edraft" x="${d.x * S}" y="${d.y * S}" width="${d.w * S}" height="${d.h * S}"/>`
    if (d.w && d.h) {
      h += `<text class="hv-edraft-label" x="${r1((d.x + d.w / 2) * S)}" y="${r1((d.y + d.h / 2) * S)}" font-size="${r1(fs)}">${metres(d.w)} × ${metres(d.h)} m</text>`
    }
  }
  const walls = floorWalls(floor)
  const runs = wallRuns(floor)
  const gaps = wallGaps(runs)
  // As thick as it is built, its ends closing the corners it makes with
  // others, as the plan view draws it. A stroke only where it would be
  // thinner than two pixels on screen, so a thin wall stays visible.
  const wallPiece = (fw: FloorWall, A: Point, B: Point) => {
    const t = r1((fw.thickness / CELL_MM) * S)
    const wsel = fw.key === o.selectedWall ? ' hv-sel' : ''
    const pts = wallOutline(A, B, fw, walls, gaps)
      .map((q) => `${r1(q[0] * S)},${r1(q[1] * S)}`)
      .join(' ')
    const cc = `x1="${r1(A[0] * S)}" y1="${r1(A[1] * S)}" x2="${r1(B[0] * S)}" y2="${r1(B[1] * S)}"`
    return (
      `<polygon class="hv-ewall${wsel}" style="stroke-width:max(0px, calc(2px / var(--hv-zoom, 1) - ${t}px))" points="${pts}"/>` +
      `<line class="hv-ewhit" data-wall="${esc(fw.key)}" ${cc}/>`
    )
  }
  for (const w of runs) {
    const c =
      w.axis === 's'
        ? `x1="${r1(w.x1 * S)}" y1="${r1(w.y1 * S)}" x2="${r1(w.x2 * S)}" y2="${r1(w.y2 * S)}"`
        : `x1="${w.x1 * S}" y1="${w.y1 * S}" x2="${w.x2 * S}" y2="${w.y2 * S}"`
    const sel = w.opening && w.opening.id === o.selectedOpening ? ' hv-sel' : ''
    if (w.type === 'wall') {
      // As thick as it is built, a run of wall may be several walls (a
      // thick outside one meeting a thin one between rooms).
      for (const pc of runPieces(w, walls)) h += wallPiece(pc.w, pc.A, pc.B)
    } else if (w.type === 'window') h += `<line class="hv-ewinb" ${c}/><line class="hv-ewin${sel}" ${c}/>`
    else if (w.type === 'open') h += `<line class="hv-eopen${sel}" ${c}/>`
    else if (w.type === 'slider') {
      // Two panes, side by side and overlapping in the middle, as a plan
      // draws a sliding door.
      const [p1, p2] = sliderPanes(w, S, 3)
      h += `<line class="hv-ewinb" ${c}/><line class="hv-ewin${sel}" ${p1}/><line class="hv-ewin${sel}" ${p2}/>`
    } else if (w.opening) {
      const sw = doorSwing(w.opening)
      const len = w.opening.len * S
      h +=
        `<line class="hv-ewinb" ${c}/>` +
        `<path class="hv-edoor${w.opening.glass ? ' hv-eglassdoor' : ''}${sel}" d="M${sw.hinge[0] * S},${sw.hinge[1] * S} L${sw.open[0] * S},${sw.open[1] * S} ` +
        `A${len},${len} 0 0 ${sw.sweep} ${sw.free[0] * S},${sw.free[1] * S}"/>`
    }
    // What covers the glass, on its side: a box line for what rolls, folds at
    // the ends for curtains, a dashed line for an awning.
    if (w.opening) {
      const A: Point = [w.x1, w.y1]
      const B: Point = [w.x2, w.y2]
      for (const cd of coveringDraws(floor, w.opening, devices)) {
        const n = cd.normal
        const at = (t: number, k: number) =>
          `${r1((A[0] + (B[0] - A[0]) * t + n[0] * k) * S)},${r1((A[1] + (B[1] - A[1]) * t + n[1] * k) * S)}`
        if (cd.covering.kind === 'curtain') {
          const zig = (t0: number, t1: number) =>
            [0, 1, 2, 3, 4].map((i) => at(t0 + ((t1 - t0) * i) / 4, 0.2 + (i % 2 ? 0.12 : 0))).join(' ')
          h += `<polyline class="hv-ecover" points="${zig(0, 0.15)}"/><polyline class="hv-ecover" points="${zig(1, 0.85)}"/>`
        } else {
          const dash = cd.covering.kind === 'awning' ? ' hv-ecover--dash' : ''
          h += `<polyline class="hv-ecover${dash}" points="${at(0, 0.2)} ${at(1, 0.2)}"/>`
        }
      }
    }
    // A wide invisible line over every opening, so a finger can grab it.
    if (w.opening) h += `<line class="hv-ehit" data-opening="${esc(w.opening.id)}" ${c}/>`
  }
  // Radiators: a slim panel on the side of the wall they hang on.
  for (const r of floor.radiators ?? []) {
    const n = radiatorNormal(r)
    const d = 0.3
    const sel = o.selectedRadiator === r.id ? ' hv-sel' : ''
    const e = openingEnd(r)
    if (r.to) {
      const pts = [[r.x, r.y], e, [e[0] + n[0] * d, e[1] + n[1] * d], [r.x + n[0] * d, r.y + n[1] * d]]
      h +=
        `<polygon class="hv-erad${sel}" points="${pts.map((p) => `${r1(p[0] * S)},${r1(p[1] * S)}`).join(' ')}"/>` +
        `<line class="hv-ehit" data-radiator="${esc(r.id)}" x1="${r1(r.x * S)}" y1="${r1(r.y * S)}" x2="${r1(e[0] * S)}" y2="${r1(e[1] * S)}"/>`
      continue
    }
    const x0 = Math.min(r.x, r.x + n[0] * d)
    const y0 = Math.min(r.y, r.y + n[1] * d)
    const rw = r.axis === 'h' ? r.len : d
    const rh = r.axis === 'v' ? r.len : d
    const c = `x1="${r.x * S}" y1="${r.y * S}" x2="${e[0] * S}" y2="${e[1] * S}"`
    h +=
      `<rect class="hv-erad${sel}" x="${r1(x0 * S)}" y="${r1(y0 * S)}" width="${r1(rw * S)}" height="${r1(rh * S)}"/>` +
      `<line class="hv-ehit" data-radiator="${esc(r.id)}" ${c}/>`
  }
  const rr = fit(11, 11)
  for (const p of floor.placements) {
    const d = devices.get(p.ref)
    let x = p.x
    let y = p.y
    const attached = p.opening ? floor.openings.find((q) => q.id === p.opening) : undefined
    if (attached) [x, y] = openingMiddle(attached)
    const letter = d ? KIND_LETTER[d.kind] : '?'
    const name = d?.name ?? 'Device no longer on the bridge'
    h +=
      `<g class="hv-edev${o.selectedRef === p.ref ? ' hv-sel' : ''}${d ? '' : ' hv-missing'}" data-ref="${esc(p.ref)}" transform="translate(${x * S},${y * S})">` +
      `<title>${esc(name)}</title><circle r="${r1(rr)}"/><text font-size="${r1(rr)}" dy="${r1(rr * 0.36)}">${letter}</text></g>`
  }
  // The selected door's or window's ends, over everything, so a device
  // standing beside it never hides them.
  // Each end's handle, with the cursor for the way it slides.
  const endHandles = (x: OnWall, attr: string) => {
    const cls = x.to ? (x.to[1] < x.y ? ' hv-alt' : '') : ` hv-eoh-${x.axis}`
    const e = openingEnd(x)
    return (
      `<circle class="hv-eh${cls}" ${attr}="start" cx="${r1(x.x * S)}" cy="${r1(x.y * S)}" r="${r1(fit(6, 8))}"/>` +
      `<circle class="hv-eh${cls}" ${attr}="end" cx="${r1(e[0] * S)}" cy="${r1(e[1] * S)}" r="${r1(fit(6, 8))}"/>`
    )
  }
  const so = floor.openings.find((x) => x.id === o.selectedOpening)
  if (so) h += endHandles(so, 'data-ohandle')
  const sr = (floor.radiators ?? []).find((x) => x.id === o.selectedRadiator)
  if (sr) h += endHandles(sr, 'data-rhandle')
  const sf = (floor.furniture ?? []).find((x) => x.id === o.selectedFurniture)
  if (sf) {
    const corners: Array<[string, number, number]> = [
      ['nw', sf.x, sf.y],
      ['ne', sf.x + sf.w, sf.y],
      ['se', sf.x + sf.w, sf.y + sf.d],
      ['sw', sf.x, sf.y + sf.d],
    ]
    for (const [c, x, y] of corners) {
      h += `<circle class="hv-eh${c === 'ne' || c === 'sw' ? ' hv-alt' : ''}" data-fhandle="${c}" cx="${x * S}" cy="${y * S}" r="${r1(fit(6, 8))}"/>`
    }
  }
  // Dimension lines: a thin line with a slash at each end and its length over the middle.
  const dimension = (d: { a: Point; b: Point }, cls: string, id?: string) => {
    const len = dimensionLength(d)
    if (!len) return ''
    const [ux, uy] = [(d.b[0] - d.a[0]) / len, (d.b[1] - d.a[1]) / len]
    const t = fit(4, 5) / S
    const tick = (p: Point) =>
      `M${r1((p[0] - (ux - uy) * t) * S)},${r1((p[1] - (uy + ux) * t) * S)}L${r1((p[0] + (ux - uy) * t) * S)},${r1((p[1] + (uy + ux) * t) * S)}`
    const c = `x1="${r1(d.a[0] * S)}" y1="${r1(d.a[1] * S)}" x2="${r1(d.b[0] * S)}" y2="${r1(d.b[1] * S)}"`
    // The label reads left to right, or bottom to top, never upside down.
    let deg = (Math.atan2(uy, ux) * 180) / Math.PI
    if (deg > 90) deg -= 180
    else if (deg <= -90) deg += 180
    const [mx, my] = [((d.a[0] + d.b[0]) / 2) * S, ((d.a[1] + d.b[1]) / 2) * S]
    return (
      `<g class="${cls}"${id ? ` data-dim="${esc(id)}"` : ''}>` +
      `<line ${c}/><path d="${tick(d.a)}${tick(d.b)}"/>` +
      `<text x="${r1(mx)}" y="${r1(my - fs * 0.45)}" font-size="${r1(fs)}" transform="rotate(${r1(deg)} ${r1(mx)} ${r1(my)})">${metres(len)} m</text>` +
      (id ? `<line class="hv-ehit" ${c}/>` : '') +
      '</g>'
    )
  }
  for (const d of floor.dimensions ?? [])
    h += dimension(d, `hv-edim${d.id === o.selectedDimension ? ' hv-sel' : ''}`, d.id)
  if (o.draftDimension) h += dimension(o.draftDimension, 'hv-edim hv-edim--draft')
  const sd = (floor.dimensions ?? []).find((d) => d.id === o.selectedDimension)
  if (sd) {
    for (const [end, p] of [
      ['a', sd.a],
      ['b', sd.b],
    ] as const) {
      h += `<circle class="hv-eh" data-dhandle="${end}" cx="${r1(p[0] * S)}" cy="${r1(p[1] * S)}" r="${r1(fit(6, 8))}"/>`
    }
  }
  if (o.draftWall) {
    const { a, b } = o.draftWall
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    h += `<line class="hv-edraftwall" x1="${r1(a[0] * S)}" y1="${r1(a[1] * S)}" x2="${r1(b[0] * S)}" y2="${r1(b[1] * S)}"/>`
    if (len > 0)
      h += `<text class="hv-edraft-label" x="${r1(((a[0] + b[0]) / 2) * S)}" y="${r1(((a[1] + b[1]) / 2) * S - fs)}" font-size="${r1(fs)}">${metres(len)} m</text>`
  }
  if (o.draftPolygon) {
    const { pts, next } = o.draftPolygon
    const all = next ? [...pts, next] : pts
    h += `<polyline class="hv-edraftwall" points="${all.map((p) => `${r1(p[0] * S)},${r1(p[1] * S)}`).join(' ')}"/>`
    pts.forEach((p, i) => {
      h += `<circle class="hv-eh${i === 0 ? ' hv-alt' : ''}" cx="${r1(p[0] * S)}" cy="${r1(p[1] * S)}" r="${r1(fit(5, 6))}"/>`
    })
    const last = pts[pts.length - 1]
    if (next && last) {
      const len = Math.hypot(next[0] - last[0], next[1] - last[1])
      if (len > 0)
        h += `<text class="hv-edraft-label" x="${r1(((last[0] + next[0]) / 2) * S)}" y="${r1(((last[1] + next[1]) / 2) * S - fs)}" font-size="${r1(fs)}">${metres(len)} m</text>`
    }
  }
  const sw = walls.find((w) => w.key === o.selectedWall)?.drawn
  if (sw && o.showHandles) {
    for (const [end, p] of [
      ['a', sw.a],
      ['b', sw.b],
    ] as const) {
      h += `<circle class="hv-eh" data-whandle="${end}" cx="${r1(p[0] * S)}" cy="${r1(p[1] * S)}" r="${r1(fit(6, 8))}"/>`
    }
  }
  const sel = floor.rooms.find((r) => r.id === o.selectedRoom)
  if (sel?.outline && o.showHandles) {
    // A room drawn corner by corner: a handle on each corner, `data-corner` its index.
    sel.outline.forEach((p, i) => {
      h += `<circle class="hv-eh" data-corner="${i}" cx="${r1(p[0] * S)}" cy="${r1(p[1] * S)}" r="${r1(fit(7, 9))}"/>`
    })
  } else if (sel && o.showHandles) {
    // Every part has its own corners: `data-handle` is `<part>:<corner>`,
    // part 0 being the main rectangle.
    roomRects(sel).forEach((q, i) => {
      const corners: Array<[string, number, number]> = [
        ['nw', q.x, q.y],
        ['ne', q.x + q.w, q.y],
        ['se', q.x + q.w, q.y + q.h],
        ['sw', q.x, q.y + q.h],
      ]
      for (const [c, x, y] of corners) {
        h += `<circle class="hv-eh${c === 'ne' || c === 'sw' ? ' hv-alt' : ''}" data-handle="${i}:${c}" cx="${x * S}" cy="${y * S}" r="${r1(fit(7, 9))}"/>`
      }
    })
  }
  return h
}
