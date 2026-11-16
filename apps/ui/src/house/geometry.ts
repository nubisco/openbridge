/**
 * Plan geometry for the House view: walls from rooms, the isometric
 * projection, and the colour scales. Plain functions over the plan, shared by
 * the live view and the editor, with no DOM and no Vue.
 *
 * Units are grid cells (`plan.grid` metres each, 0.5 today). `CELLS_PER_M`
 * turns the few lengths that are really metres (wall height, how high a lamp
 * hangs) into cells.
 */
import type { HouseFloor, HouseOpening, HousePlan, HouseRect, HouseRoom } from '@/api'

/** Screen pixels per cell before the stage scales to fit. */
export const S = 20
export const CELLS_PER_M = 2
const C = Math.cos(Math.PI / 6)
const SN = 0.5

export type Point = [number, number]
export type ViewMode = 'iso' | 'flat'

export const r1 = (n: number) => Math.round(n * 10) / 10
export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/** Escape text for SVG markup built as a string. */
export function esc(s: unknown): string {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )
}

/** Plan cells to stage pixels. `z` is height in cells. */
export function project(mode: ViewMode, x: number, y: number, z = 0): Point {
  return mode === 'iso' ? [(x - y) * C * S, (x + y) * SN * S - z * S] : [x * S, y * S]
}

/** The matrix that lays text flat on the floor in the isometric view. */
export const ISO_FLOOR_MATRIX = `matrix(${C},${SN},${-C},${SN},0,0)`

// ─── Walls ──────────────────────────────────────────────────────────────────

/** One cell-long piece of wall. `h` runs along x from (x,y), `v` along y. */
export interface WallUnit {
  x: number
  y: number
  axis: 'h' | 'v'
}

export const unitKey = (x: number, y: number, axis: 'h' | 'v') => `${x},${y},${axis}`

// ─── Room shapes ────────────────────────────────────────────────────────────

/** Every rectangle a room is made of, main one first. */
export function roomRects(r: HouseRoom): HouseRect[] {
  return [r, ...(r.parts ?? [])]
}

/** Whether a point is in a room, edges included. */
export function roomContains(r: HouseRoom, x: number, y: number): boolean {
  return roomRects(r).some((q) => x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.h)
}

/** Whether the cell whose corner is (cx, cy) is inside a room. */
const cellIn = (r: HouseRoom, cx: number, cy: number) =>
  roomRects(r).some((q) => cx >= q.x && cx < q.x + q.w && cy >= q.y && cy < q.y + q.h)

/** The box around a room. */
export function roomBox(r: HouseRoom): HouseRect {
  const rects = roomRects(r)
  const x = Math.min(...rects.map((q) => q.x))
  const y = Math.min(...rects.map((q) => q.y))
  return {
    x,
    y,
    w: Math.max(...rects.map((q) => q.x + q.w)) - x,
    h: Math.max(...rects.map((q) => q.y + q.h)) - y,
  }
}

/** Area in cells. Parts never overlap, so it is a plain sum. */
export const roomArea = (r: HouseRoom) => roomRects(r).reduce((a, q) => a + q.w * q.h, 0)

/**
 * The outline of a room as wall units: every rectangle edge that has the room
 * on one side only. The edge where an L's two parts meet has the room on both
 * sides, so it is not a wall.
 */
export function roomOutline(r: HouseRoom): WallUnit[] {
  const out: WallUnit[] = []
  for (const q of roomRects(r)) {
    for (let i = 0; i < q.w; i++) {
      const x = q.x + i
      if (!cellIn(r, x, q.y - 1)) out.push({ x, y: q.y, axis: 'h' })
      if (!cellIn(r, x, q.y + q.h)) out.push({ x, y: q.y + q.h, axis: 'h' })
    }
    for (let j = 0; j < q.h; j++) {
      const y = q.y + j
      if (!cellIn(r, q.x - 1, y)) out.push({ x: q.x, y, axis: 'v' })
      if (!cellIn(r, q.x + q.w, y)) out.push({ x: q.x + q.w, y, axis: 'v' })
    }
  }
  return out
}

/**
 * Every wall unit on a floor. Walls are the outlines of rooms that have them,
 * and an edge two rooms share is one wall, so this is a set.
 */
export function wallUnits(floor: HouseFloor): Map<string, WallUnit> {
  const units = new Map<string, WallUnit>()
  for (const r of floor.rooms) {
    if (r.kind !== 'room') continue
    for (const u of roomOutline(r)) units.set(unitKey(u.x, u.y, u.axis), u)
  }
  return units
}

/** The wall units an opening covers. */
export function openingUnits(o: HouseOpening): string[] {
  const out: string[] = []
  for (let i = 0; i < o.len; i++) {
    out.push(o.axis === 'h' ? unitKey(o.x + i, o.y, 'h') : unitKey(o.x, o.y + i, 'v'))
  }
  return out
}

/** Whether an opening still sits entirely on wall, after rooms moved under it. */
export function openingFits(o: HouseOpening, units: Map<string, WallUnit>): boolean {
  return openingUnits(o).every((k) => units.has(k))
}

export interface WallRun {
  /** `wall`, or the opening this run is. */
  type: 'wall' | 'door' | 'window'
  opening: HouseOpening | null
  axis: 'h' | 'v'
  x1: number
  y1: number
  x2: number
  y2: number
}

/**
 * Walls merged into straight runs, cut where doors and windows sit. Drawing a
 * run as one shape instead of one per cell keeps the scene to a few hundred
 * nodes and joins without seams.
 */
export function wallRuns(floor: HouseFloor): WallRun[] {
  const units = wallUnits(floor)
  const owner = new Map<string, HouseOpening>()
  for (const o of floor.openings) {
    if (!openingFits(o, units)) continue
    for (const k of openingUnits(o)) owner.set(k, o)
  }
  const runs: WallRun[] = []
  for (const axis of ['h', 'v'] as const) {
    const list = [...units.values()]
      .filter((u) => u.axis === axis)
      .sort((a, b) => (axis === 'h' ? a.y - b.y || a.x - b.x : a.x - b.x || a.y - b.y))
    let cur: WallRun | null = null
    for (const u of list) {
      const o = owner.get(unitKey(u.x, u.y, axis)) ?? null
      const x2 = axis === 'h' ? u.x + 1 : u.x
      const y2 = axis === 'h' ? u.y : u.y + 1
      if (cur && cur.opening === o && cur.x2 === u.x && cur.y2 === u.y) {
        cur.x2 = x2
        cur.y2 = y2
        continue
      }
      cur = { type: o ? o.type : 'wall', opening: o, axis, x1: u.x, y1: u.y, x2, y2 }
      runs.push(cur)
    }
  }
  return runs
}

// ─── Rooms ──────────────────────────────────────────────────────────────────

/**
 * The smallest room containing a point, ties to the room drawn first: a room
 * drawn inside another (an en-suite in a bedroom) owns what is in it. The
 * daemon's roomsByRef follows the same rule.
 */
export function innermostRoom(rooms: HouseRoom[]): HouseRoom | undefined {
  return rooms.reduce<HouseRoom | undefined>((best, r) => (!best || roomArea(r) < roomArea(best) ? r : best), undefined)
}

export function roomAt(floor: HouseFloor, x: number, y: number): HouseRoom | undefined {
  return innermostRoom(floor.rooms.filter((r) => roomContains(r, x, y)))
}

/** Rooms biggest first, the order to draw them in so inner rooms sit on top. */
export const roomsOutsideIn = (rooms: HouseRoom[]) => rooms.slice().sort((a, b) => roomArea(b) - roomArea(a))

/**
 * The room and floor a device is placed in, as the daemon derives it (see
 * roomsByRef in the daemon's house.ts): a shutter is in the walled room
 * behind its window, anything else in the first room containing it.
 */
export function placementRoom(
  plan: HousePlan | null,
  ref: string,
): { room: HouseRoom | null; floor: HouseFloor } | null {
  if (!plan) return null
  for (const f of plan.floors) {
    const p = f.placements.find((x) => x.ref === ref)
    if (!p) continue
    const o = p.opening ? f.openings.find((x) => x.id === p.opening) : undefined
    const x = o ? o.x + (o.axis === 'h' ? o.len / 2 : 0) : p.x
    const y = o ? o.y + (o.axis === 'v' ? o.len / 2 : 0) : p.y
    const inside = f.rooms.filter((r) => roomContains(r, x, y))
    const room =
      (o ? innermostRoom(inside.filter((r) => r.kind === 'room')) : undefined) ?? innermostRoom(inside) ?? null
    return { room, floor: f }
  }
  return null
}

/** The area a floor occupies: the whole plot for the ground, its rooms above it. */
export function floorBounds(plan: HousePlan, floor: HouseFloor) {
  if (floor.level === 0 || !floor.rooms.length) return { x: 0, y: 0, w: plan.plot.w, h: plan.plot.h }
  const rects = floor.rooms.flatMap(roomRects)
  const x1 = Math.min(...rects.map((r) => r.x))
  const y1 = Math.min(...rects.map((r) => r.y))
  const x2 = Math.max(...rects.map((r) => r.x + r.w))
  const y2 = Math.max(...rects.map((r) => r.y + r.h))
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

/**
 * What is drawn on a floor: its rooms and devices, not the empty plot
 * around them. The live view frames this, so a house on a big plot fills the
 * page instead of floating in a field of nothing.
 */
export function drawnBounds(plan: HousePlan, floor: HouseFloor) {
  const xs: number[] = []
  const ys: number[] = []
  for (const q of floor.rooms.flatMap(roomRects)) {
    xs.push(q.x, q.x + q.w)
    ys.push(q.y, q.y + q.h)
  }
  for (const p of floor.placements) {
    const half = (p.length ?? 0) / 2
    xs.push(p.x - (p.axis === 'v' ? 0 : half), p.x + (p.axis === 'v' ? 0 : half))
    ys.push(p.y - (p.axis === 'v' ? half : 0), p.y + (p.axis === 'v' ? half : 0))
  }
  if (!xs.length) return floorBounds(plan, floor)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(1, Math.max(...xs) - x), h: Math.max(1, Math.max(...ys) - y) }
}

// ─── Doors ──────────────────────────────────────────────────────────────────

/**
 * How a door swings: its hinge, where the leaf's free end rests when shut,
 * and where it reaches fully open, in cells. `at(t)` is the free end at a
 * share of the way open, 0 shut and 1 at a right angle.
 */
export function doorSwing(o: HouseOpening) {
  const a: Point = [o.x, o.y]
  const b: Point = o.axis === 'h' ? [o.x + o.len, o.y] : [o.x, o.y + o.len]
  const hinge = o.hinge === 'end' ? b : a
  const free = o.hinge === 'end' ? a : b
  const sign = o.opens === 'up' || o.opens === 'left' ? -1 : 1
  const open: Point = o.axis === 'h' ? [hinge[0], hinge[1] + sign * o.len] : [hinge[0] + sign * o.len, hinge[1]]
  const at = (t: number): Point => {
    const c = Math.cos((t * Math.PI) / 2)
    const s = Math.sin((t * Math.PI) / 2)
    return [
      hinge[0] + c * (free[0] - hinge[0]) + s * (open[0] - hinge[0]),
      hinge[1] + c * (free[1] - hinge[1]) + s * (open[1] - hinge[1]),
    ]
  }
  // SVG's sweep flag for the arc from the open end back to the shut end:
  // 1 when that turn is clockwise on screen, where y points down.
  const cross = (open[0] - hinge[0]) * (free[1] - hinge[1]) - (open[1] - hinge[1]) * (free[0] - hinge[0])
  return { hinge, free, open, at, sweep: cross > 0 ? 1 : 0 }
}

/** The door side flipped: the same door, opening into the other room. */
export function flippedSide(o: HouseOpening): HouseOpening['opens'] {
  if (o.axis === 'h') return o.opens === 'up' ? 'down' : 'up'
  return o.opens === 'left' ? 'right' : 'left'
}

// ─── Heating circuits ───────────────────────────────────────────────────────

/**
 * A plausible pipe route from a heating device through the rooms it serves on
 * one floor, as a polyline in cells.
 *
 * Not where the pipes really are: nobody knows that, and asking would make
 * the plan a plumbing survey. It is a serpentine through each room, nearest
 * room first, like underfloor heating, so the eye reads "this circuit warms
 * these rooms" and the colour along it reads supply to return.
 */
export function circuitPath(origin: { x: number; y: number }, rooms: HouseRoom[]): Point[] | null {
  // Each part of an L-shaped room gets its own run of the serpentine.
  const rects: HouseRect[] = rooms.flatMap(roomRects)
  if (!rects.length) return null
  let cur = { x: origin.x, y: origin.y }
  const pts: Point[] = [[cur.x, cur.y]]
  const left = rects.slice()
  const dist = (a: { x: number; y: number }, r: HouseRect) =>
    Math.abs(a.x - (r.x + r.w / 2)) + Math.abs(a.y - (r.y + r.h / 2))
  const step = CELLS_PER_M
  while (left.length) {
    left.sort((a, b) => dist(cur, a) - dist(cur, b))
    const r = left.shift() as HouseRect
    const xs = [r.x + step / 2, r.x + r.w - step / 2]
    if (xs[1] < xs[0]) xs[0] = xs[1] = r.x + r.w / 2
    const ys: number[] = []
    for (let y = r.y + step / 2; y <= r.y + r.h - step / 2 + 1e-6; y += step) ys.push(y)
    if (!ys.length) ys.push(r.y + r.h / 2)
    if (Math.abs(cur.y - ys[ys.length - 1]) < Math.abs(cur.y - ys[0])) ys.reverse()
    let xi = Math.abs(cur.x - xs[0]) <= Math.abs(cur.x - xs[1]) ? 0 : 1
    pts.push([xs[xi], cur.y], [xs[xi], ys[0]])
    ys.forEach((y, i) => {
      if (i > 0) pts.push([xs[xi], y])
      xi = 1 - xi
      pts.push([xs[xi], y])
    })
    cur = { x: xs[xi], y: ys[ys.length - 1] }
  }
  pts.push([cur.x, origin.y + 0.6], [origin.x + 0.5, origin.y + 0.6])
  return pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1])
}

// ─── Colour scales ──────────────────────────────────────────────────────────

/** Water temperature: blue when cold, through violet, to red when hot. */
export function waterColor(t: number, lo = 20, hi = 55): string {
  const k = clamp((t - lo) / (hi - lo), 0, 1)
  return `hsl(${Math.round((215 + 150 * k) % 360)} 88% 57%)`
}

/** Room temperature for the overlay: same scale, comfortable range. */
export const roomTempColor = (t: number) => waterColor(t, 16, 26)

/** Humidity: dry is amber, damp is blue-green. */
export function humidityColor(h: number): string {
  const k = clamp((h - 35) / 45, 0, 1)
  return `hsl(${Math.round(45 + 165 * k)} 85% 55%)`
}

/** HomeKit hue (0-360) and saturation (0-100) as a CSS colour, at full value. */
export function hueSatColor(hue: number, sat: number): string {
  return `hsl(${Math.round(hue)} ${Math.round(clamp(sat, 0, 100))}% ${Math.round(100 - clamp(sat, 0, 100) / 2)}%)`
}
