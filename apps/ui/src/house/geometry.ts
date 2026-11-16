/**
 * Plan geometry for the House view: walls from rooms, the isometric
 * projection, and the colour scales. Plain functions over the plan, shared by
 * the live view and the editor, with no DOM and no Vue.
 *
 * Units are grid cells (`plan.grid` metres each, 0.5 today). `CELLS_PER_M`
 * turns the few lengths that are really metres (wall height, how high a lamp
 * hangs) into cells.
 */
import type { HouseFloor, HouseOpening, HousePlan, HouseRoom } from '@/api'

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

/**
 * Every wall unit on a floor. Walls are the edges of rooms that have them, and
 * an edge two rooms share is one wall, so this is a set.
 */
export function wallUnits(floor: HouseFloor): Map<string, WallUnit> {
  const units = new Map<string, WallUnit>()
  const add = (x: number, y: number, axis: 'h' | 'v') => units.set(unitKey(x, y, axis), { x, y, axis })
  for (const r of floor.rooms) {
    if (r.kind !== 'room') continue
    for (let i = 0; i < r.w; i++) {
      add(r.x + i, r.y, 'h')
      add(r.x + i, r.y + r.h, 'h')
    }
    for (let j = 0; j < r.h; j++) {
      add(r.x, r.y + j, 'v')
      add(r.x + r.w, r.y + j, 'v')
    }
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

export function roomAt(floor: HouseFloor, x: number, y: number): HouseRoom | undefined {
  return floor.rooms.find((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)
}

/** The area a floor occupies: the whole plot for the ground, its rooms above it. */
export function floorBounds(plan: HousePlan, floor: HouseFloor) {
  if (floor.level === 0 || !floor.rooms.length) return { x: 0, y: 0, w: plan.plot.w, h: plan.plot.h }
  const x1 = Math.min(...floor.rooms.map((r) => r.x))
  const y1 = Math.min(...floor.rooms.map((r) => r.y))
  const x2 = Math.max(...floor.rooms.map((r) => r.x + r.w))
  const y2 = Math.max(...floor.rooms.map((r) => r.y + r.h))
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
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
  if (!rooms.length) return null
  let cur = { x: origin.x, y: origin.y }
  const pts: Point[] = [[cur.x, cur.y]]
  const left = rooms.slice()
  const dist = (a: { x: number; y: number }, r: HouseRoom) =>
    Math.abs(a.x - (r.x + r.w / 2)) + Math.abs(a.y - (r.y + r.h / 2))
  const step = CELLS_PER_M
  while (left.length) {
    left.sort((a, b) => dist(cur, a) - dist(cur, b))
    const r = left.shift() as HouseRoom
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
