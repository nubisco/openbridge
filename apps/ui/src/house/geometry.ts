/**
 * Plan geometry for the House view: walls from rooms, the isometric
 * projection, and the colour scales. Plain functions over the plan, shared by
 * the live view and the editor, with no DOM and no Vue.
 *
 * Units are grid cells (`plan.grid` metres each, 0.5 today). `CELLS_PER_M`
 * turns the few lengths that are really metres (wall height, how high a lamp
 * hangs) into cells.
 */
import type {
  HouseFloor,
  HouseFurniture,
  HouseFurnitureKind,
  HouseLightMount,
  HouseOpening,
  HousePlan,
  HouseRadiator,
  HouseRect,
  HouseRoom,
} from '@/api'

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

/** Where an opening starts and ends along its wall, in cells. */
export function openingSpan(o: HouseOpening): [number, number] {
  const s = o.axis === 'h' ? o.x : o.y
  return [s, s + o.len]
}

/**
 * The wall units an opening covers, even partly: one that starts a quarter
 * metre into a unit still needs that unit to be wall.
 */
export function openingUnits(o: HouseOpening): string[] {
  const [s, e] = openingSpan(o)
  const out: string[] = []
  for (let i = Math.floor(s); i < Math.ceil(e); i++) {
    out.push(o.axis === 'h' ? unitKey(i, o.y, 'h') : unitKey(o.x, i, 'v'))
  }
  return out
}

/** Whether two openings claim the same stretch of the same wall line. */
export function openingsOverlap(a: HouseOpening, b: HouseOpening): boolean {
  if (a.axis !== b.axis || (a.axis === 'h' ? a.y !== b.y : a.x !== b.x)) return false
  const [s1, e1] = openingSpan(a)
  const [s2, e2] = openingSpan(b)
  return s1 < e2 && s2 < e1
}

/** Whether an opening still sits entirely on wall, after rooms moved under it. */
export function openingFits(o: HouseOpening, units: Map<string, WallUnit>): boolean {
  return openingUnits(o).every((k) => units.has(k))
}

export interface WallRun {
  /** `wall`, or the opening this run is. */
  type: 'wall' | 'door' | 'window' | 'open'
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
 * nodes and joins without seams. An opening may start or end part way into a
 * cell, so the cuts fall wherever the openings say, not on the grid.
 */
export function wallRuns(floor: HouseFloor): WallRun[] {
  const units = wallUnits(floor)
  // Openings that still fit, first come first served where two overlap.
  const kept: HouseOpening[] = []
  for (const o of floor.openings) {
    if (openingFits(o, units) && !kept.some((k) => openingsOverlap(k, o))) kept.push(o)
  }
  const runs: WallRun[] = []
  for (const axis of ['h', 'v'] as const) {
    const list = [...units.values()]
      .filter((u) => u.axis === axis)
      .sort((a, b) => (axis === 'h' ? a.y - b.y || a.x - b.x : a.x - b.x || a.y - b.y))
    // Unbroken stretches of wall on one line, as [line, start, end].
    const lines: Array<[number, number, number]> = []
    for (const u of list) {
      const line = axis === 'h' ? u.y : u.x
      const at = axis === 'h' ? u.x : u.y
      const cur = lines[lines.length - 1]
      if (cur && cur[0] === line && cur[2] === at) cur[2] = at + 1
      else lines.push([line, at, at + 1])
    }
    const run = (line: number, a: number, b: number, o: HouseOpening | null): WallRun =>
      axis === 'h'
        ? { type: o ? o.type : 'wall', opening: o, axis, x1: a, y1: line, x2: b, y2: line }
        : { type: o ? o.type : 'wall', opening: o, axis, x1: line, y1: a, x2: line, y2: b }
    for (const [line, start, end] of lines) {
      const inside = kept
        .filter((o) => o.axis === axis && (axis === 'h' ? o.y : o.x) === line)
        .map((o) => ({ o, span: openingSpan(o) }))
        .filter(({ span }) => span[0] >= start && span[1] <= end)
        .sort((a, b) => a.span[0] - b.span[0])
      let at = start
      for (const { o, span } of inside) {
        if (span[0] > at) runs.push(run(line, at, span[0], null))
        runs.push(run(line, span[0], span[1], o))
        at = span[1]
      }
      if (at < end) runs.push(run(line, at, end, null))
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

// ─── Radiators ──────────────────────────────────────────────────────────────

/** How far a radiator stands off its wall, in cells. */
export const RADIATOR_DEPTH = 0.25

/** The direction a radiator faces, as a unit step across its wall. */
export function radiatorNormal(r: Pick<HouseRadiator, 'side'>): Point {
  return r.side === 'up' ? [0, -1] : r.side === 'down' ? [0, 1] : r.side === 'left' ? [-1, 0] : [1, 0]
}

/** A radiator's two ends, on the room side, where its pipes connect. */
export function radiatorEnds(r: HouseRadiator, off = RADIATOR_DEPTH): [Point, Point] {
  const [nx, ny] = radiatorNormal(r)
  const a: Point = [r.x + nx * off, r.y + ny * off]
  const b: Point = r.axis === 'h' ? [r.x + r.len + nx * off, r.y + ny * off] : [r.x + nx * off, r.y + r.len + ny * off]
  return [a, b]
}

/** The room a radiator warms: the one on the side it hangs on. */
export function radiatorRoom(floor: HouseFloor, r: HouseRadiator): HouseRoom | undefined {
  const [nx, ny] = radiatorNormal(r)
  const mx = r.x + (r.axis === 'h' ? r.len / 2 : 0) + nx * 0.5
  const my = r.y + (r.axis === 'v' ? r.len / 2 : 0) + ny * 0.5
  return roomAt(floor, mx, my)
}

/**
 * A pipe route between two points on a floor, along the grid, that keeps to
 * the house: water pipes run inside walled rooms (through the walls between
 * them), never across a pool, and over open ground only where there is no
 * other way, such as from a heat pump standing in the garden to the house.
 * A* over cells, 4-connected, so the route is made of straight runs.
 */
export function routeInside(floor: HouseFloor, from: Point, to: Point): Point[] {
  const rooms = floor.rooms
  let x0 = Math.min(from[0], to[0])
  let y0 = Math.min(from[1], to[1])
  let x1 = Math.max(from[0], to[0])
  let y1 = Math.max(from[1], to[1])
  for (const r of rooms) {
    const b = roomBox(r)
    x0 = Math.min(x0, b.x)
    y0 = Math.min(y0, b.y)
    x1 = Math.max(x1, b.x + b.w)
    y1 = Math.max(y1, b.y + b.h)
  }
  x0 = Math.floor(x0) - 2
  y0 = Math.floor(y0) - 2
  const W = Math.ceil(x1) + 2 - x0
  const H = Math.ceil(y1) + 2 - y0
  const cost = new Float64Array(W * H)
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const r = roomAt(floor, x0 + i + 0.5, y0 + j + 0.5)
      cost[j * W + i] = r?.kind === 'pool' ? Infinity : r?.kind === 'room' ? 1 : 8
    }
  }
  const cellOf = (p: Point) => {
    const i = clamp(Math.floor(p[0] - x0), 0, W - 1)
    const j = clamp(Math.floor(p[1] - y0), 0, H - 1)
    return j * W + i
  }
  const start = cellOf(from)
  const goal = cellOf(to)
  const gi = goal % W
  const gj = Math.floor(goal / W)
  const g = new Float64Array(W * H).fill(Infinity)
  const prev = new Int32Array(W * H).fill(-1)
  g[start] = 0
  // A small binary heap of [f, cell].
  const heap: Array<[number, number]> = [[0, start]]
  const push = (e: [number, number]) => {
    heap.push(e)
    let k = heap.length - 1
    while (k > 0) {
      const up = (k - 1) >> 1
      if (heap[up][0] <= heap[k][0]) break
      ;[heap[up], heap[k]] = [heap[k], heap[up]]
      k = up
    }
  }
  const pop = () => {
    const top = heap[0]
    const last = heap.pop() as [number, number]
    if (heap.length) {
      heap[0] = last
      let k = 0
      for (;;) {
        const l = 2 * k + 1
        const r = l + 1
        let m = k
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r
        if (m === k) break
        ;[heap[m], heap[k]] = [heap[k], heap[m]]
        k = m
      }
    }
    return top
  }
  while (heap.length) {
    const [, c] = pop()
    if (c === goal) break
    const ci = c % W
    const cj = Math.floor(c / W)
    for (const [di, dj] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const ni = ci + di
      const nj = cj + dj
      if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue
      const n = nj * W + ni
      // A turn costs a little, so the route prefers long straight runs.
      const turn = prev[c] >= 0 && prev[c] !== c - di - dj * W ? 0.3 : 0
      const ng = g[c] + cost[n] + turn
      if (ng < g[n]) {
        g[n] = ng
        prev[n] = c
        push([ng + Math.abs(ni - gi) + Math.abs(nj - gj), n])
      }
    }
  }
  if (g[goal] === Infinity) return [from, [to[0], from[1]], to]
  const cells: number[] = []
  for (let c = goal; c !== -1; c = prev[c]) cells.unshift(c)
  const raw: Point[] = [from]
  for (const c of cells) raw.push([x0 + (c % W) + 0.5, y0 + Math.floor(c / W) + 0.5])
  raw.push(to)
  // Straight runs only: a step that moves on both axes gets a corner.
  const out: Point[] = [raw[0]]
  for (let k = 1; k < raw.length; k++) {
    const a = out[out.length - 1]
    const b = raw[k]
    if (a[0] !== b[0] && a[1] !== b[1]) out.push([b[0], a[1]])
    out.push(b)
  }
  // Drop points in the middle of a straight run.
  return out.filter((p, k) => {
    if (k === 0 || k === out.length - 1) return true
    const a = out[k - 1]
    const b = out[k + 1]
    return !((a[0] === p[0] && p[0] === b[0]) || (a[1] === p[1] && p[1] === b[1]))
  })
}

/**
 * A plausible pipe route from a heating device through the rooms it serves on
 * one floor, as a polyline in cells.
 *
 * Not where the pipes really are: nobody knows that, and asking would make
 * the plan a plumbing survey. It is a serpentine through each room, nearest
 * room first, like underfloor heating, so the eye reads "this circuit warms
 * these rooms" and the colour along it reads supply to return. Between rooms
 * it keeps to the house (see routeInside), so it never crosses the pool or
 * the garden in the middle of a U-shaped house.
 */
export function circuitPath(origin: { x: number; y: number }, rooms: HouseRoom[], floor?: HouseFloor): Point[] | null {
  // A room with radiators is heated by them: the circuit runs through each
  // radiator, in at one end and out at the other. A room without is heated
  // underfloor, and each part of an L gets its own run of the serpentine.
  const rads = floor
    ? (floor.radiators ?? []).filter((r) => {
        const room = radiatorRoom(floor, r)
        return !!room && rooms.includes(room)
      })
    : []
  const withRads = new Set(floor ? rads.map((r) => radiatorRoom(floor, r)) : [])
  type Stop = { kind: 'rect'; r: HouseRect } | { kind: 'rad'; r: HouseRadiator }
  const stops: Stop[] = [
    ...rooms.filter((r) => !withRads.has(r)).flatMap((r) => roomRects(r).map((q) => ({ kind: 'rect' as const, r: q }))),
    ...rads.map((r) => ({ kind: 'rad' as const, r })),
  ]
  if (!stops.length) return null
  let cur = { x: origin.x, y: origin.y }
  const pts: Point[] = [[cur.x, cur.y]]
  const go = (to: Point) => {
    const from = pts[pts.length - 1]
    if (floor) pts.push(...routeInside(floor, from, to).slice(1))
    else pts.push([to[0], from[1]], to)
  }
  const left = stops.slice()
  const centre = (s: Stop): Point =>
    s.kind === 'rect'
      ? [s.r.x + s.r.w / 2, s.r.y + s.r.h / 2]
      : [s.r.x + (s.r.axis === 'h' ? s.r.len / 2 : 0), s.r.y + (s.r.axis === 'v' ? s.r.len / 2 : 0)]
  const dist = (a: { x: number; y: number }, s: Stop) => {
    const c = centre(s)
    return Math.abs(a.x - c[0]) + Math.abs(a.y - c[1])
  }
  const step = CELLS_PER_M
  while (left.length) {
    left.sort((a, b) => dist(cur, a) - dist(cur, b))
    const stop = left.shift() as Stop
    if (stop.kind === 'rad') {
      // In at the nearer end, along the radiator, out at the other.
      let [a, b] = radiatorEnds(stop.r, RADIATOR_DEPTH + 0.15)
      if (Math.hypot(cur.x - b[0], cur.y - b[1]) < Math.hypot(cur.x - a[0], cur.y - a[1])) [a, b] = [b, a]
      go(a)
      pts.push(b)
      cur = { x: b[0], y: b[1] }
      continue
    }
    const r = stop.r
    const xs = [r.x + step / 2, r.x + r.w - step / 2]
    if (xs[1] < xs[0]) xs[0] = xs[1] = r.x + r.w / 2
    const ys: number[] = []
    for (let y = r.y + step / 2; y <= r.y + r.h - step / 2 + 1e-6; y += step) ys.push(y)
    if (!ys.length) ys.push(r.y + r.h / 2)
    if (Math.abs(cur.y - ys[ys.length - 1]) < Math.abs(cur.y - ys[0])) ys.reverse()
    let xi = Math.abs(cur.x - xs[0]) <= Math.abs(cur.x - xs[1]) ? 0 : 1
    go([xs[xi], ys[0]])
    ys.forEach((y, i) => {
      if (i > 0) pts.push([xs[xi], y])
      xi = 1 - xi
      pts.push([xs[xi], y])
    })
    cur = { x: xs[xi], y: ys[ys.length - 1] }
  }
  // The return, back beside where the flow left.
  go([origin.x + 0.5, origin.y + 0.6])
  return pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1])
}

// ─── Furniture ──────────────────────────────────────────────────────────────

/**
 * The usual height of each kind, in metres. A shelf unit is a bookcase, a
 * parasol and a pergola are their tops, and a rug lies flat.
 */
export const FURNITURE_HEIGHT: Record<HouseFurnitureKind, number> = {
  table: 0.75,
  cabinet: 0.9,
  island: 0.9,
  bed: 0.5,
  sofa: 0.8,
  shelves: 1.8,
  rug: 0.01,
  bath: 0.55,
  shower: 2,
  toilet: 0.8,
  basin: 0.86,
  lounger: 0.35,
  parasol: 2.3,
  planter: 0.5,
  pergola: 2.5,
}

export const furnitureHeight = (f: Pick<HouseFurniture, 'kind' | 'height'>) => f.height ?? FURNITURE_HEIGHT[f.kind]

/** What a lamp or a sensor can stand on. Nothing stands on a rug, a sofa or a pergola. */
const SURFACES = new Set<HouseFurnitureKind>(['table', 'cabinet', 'island', 'bed', 'shelves', 'basin'])

/** The piece of furniture a point stands on, the highest if pieces overlap. */
export function furnitureAt(floor: HouseFloor, x: number, y: number): HouseFurniture | undefined {
  let best: HouseFurniture | undefined
  for (const f of floor.furniture ?? []) {
    if (!SURFACES.has(f.kind)) continue
    if (x < f.x || x > f.x + f.w || y < f.y || y > f.y + f.d) continue
    if (!best || furnitureHeight(f) > furnitureHeight(best)) best = f
  }
  return best
}

export type Side = 'up' | 'down' | 'left' | 'right'

/**
 * Pieces with a back, and where it can be: a bed's head and a lounger's
 * backrest are at a short end, a sofa's back and a shelf unit's are along a
 * long side.
 */
export const FURNITURE_BACK: Partial<Record<HouseFurnitureKind, 'short' | 'long'>> = {
  bed: 'short',
  lounger: 'short',
  toilet: 'short',
  sofa: 'long',
  shelves: 'long',
  basin: 'long',
}

export const oppositeSide = (s: Side): Side => ({ up: 'down', down: 'up', left: 'right', right: 'left' })[s] as Side
/** A side after a quarter turn clockwise, as seen from above. */
export const clockwiseSide = (s: Side): Side => ({ up: 'right', right: 'down', down: 'left', left: 'up' })[s] as Side

/**
 * The side a piece's back is on: the one the person set, or else the
 * possible side nearest a wall of its room, which is how a bed or a sofa is
 * placed. Ties go to the side further back on the plan.
 */
export function furnitureBack(floor: HouseFloor, f: HouseFurniture): Side {
  if (f.back) return f.back
  const room = roomAt(floor, f.x + f.w / 2, f.y + f.d / 2)
  const b = room ? roomBox(room) : { x: 0, y: 0, w: f.x + f.w, h: f.y + f.d }
  const gap: Record<Side, number> = {
    up: f.y - b.y,
    down: b.y + b.h - (f.y + f.d),
    left: f.x - b.x,
    right: b.x + b.w - (f.x + f.w),
  }
  const along = FURNITURE_BACK[f.kind] ?? 'short'
  const ends: Side[] = f.d >= f.w ? ['up', 'down'] : ['left', 'right']
  const sides: Side[] = f.d >= f.w ? ['left', 'right'] : ['up', 'down']
  const options = f.w === f.d ? (['up', 'left', 'down', 'right'] as Side[]) : along === 'short' ? ends : sides
  return options.reduce((best, s) => (gap[s] < gap[best] ? s : best))
}

/**
 * How a light is mounted. Unset means the ceiling, except in a pool, where a
 * light is underwater (nobody hangs a lamp over the water), and on a piece
 * of furniture, where it is a lamp standing on it.
 */
export function lightMount(floor: HouseFloor, p: { x: number; y: number; mount?: HouseLightMount }): HouseLightMount {
  if (p.mount) return p.mount
  if (roomAt(floor, p.x, p.y)?.kind === 'pool') return 'pool'
  return furnitureAt(floor, p.x, p.y) ? 'table' : 'ceiling'
}

// ─── Turning the view ───────────────────────────────────────────────────────

/**
 * The plan turned a quarter turn clockwise, as seen from above, `turns`
 * times. The isometric view always looks in from the same corner, so turning
 * the house is done by turning the plan before drawing it: walls, doors and
 * devices all keep their depth order and face the right way. Ids and refs
 * are unchanged, so a tap still names the same device.
 */
export function rotatePlan(plan: HousePlan, turns: number): HousePlan {
  let out = plan
  for (let t = 0; t < ((turns % 4) + 4) % 4; t++) out = quarterTurn(out)
  return out
}

function quarterTurn(plan: HousePlan): HousePlan {
  // (x, y) goes to (H - y, x): what ran along x now runs along y.
  const H = plan.plot.h
  const rect = <T extends HouseRect>(r: T): T => ({ ...r, x: H - (r.y + r.h), y: r.x, w: r.h, h: r.w })
  const opening = (o: HouseOpening): HouseOpening => {
    if (o.axis === 'h') {
      // Along x becomes along y, same direction: the start end stays the start.
      const opens = o.opens === 'up' ? 'right' : 'left'
      return { ...o, axis: 'v', x: H - o.y, y: o.x, opens }
    }
    // Along y becomes along x, reversed: the start end becomes the end.
    const opens = o.opens === 'left' ? 'up' : 'down'
    const hinge = o.hinge === 'end' ? 'start' : 'end'
    return { ...o, axis: 'h', x: H - o.y - o.len, y: o.x, hinge, opens }
  }
  return {
    ...plan,
    plot: { w: plan.plot.h, h: plan.plot.w },
    floors: plan.floors.map((f) => ({
      ...f,
      rooms: f.rooms.map((r) => ({ ...rect(r), parts: r.parts?.map(rect) })),
      openings: f.openings.map(opening),
      radiators: f.radiators?.map((r) => {
        if (r.axis === 'h')
          return {
            ...r,
            axis: 'v' as const,
            x: H - r.y,
            y: r.x,
            side: r.side === 'up' ? ('right' as const) : ('left' as const),
          }
        return {
          ...r,
          axis: 'h' as const,
          x: H - r.y - r.len,
          y: r.x,
          side: r.side === 'left' ? ('up' as const) : ('down' as const),
        }
      }),
      furniture: f.furniture?.map((u) => ({
        ...u,
        x: H - (u.y + u.d),
        y: u.x,
        w: u.d,
        d: u.w,
        ...(u.back ? { back: clockwiseSide(u.back) } : {}),
      })),
      placements: f.placements.map((p) => ({
        ...p,
        x: H - p.y,
        y: p.x,
        ...(p.axis ? { axis: p.axis === 'h' ? ('v' as const) : ('h' as const) } : {}),
      })),
    })),
  }
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
