/**
 * Shapes made of grid cells, and the polygons around them. Version 1 rooms
 * are rectangles of cells, version 2 spaces are polygons, and these turn one
 * into the other exactly while the polygon still sits on the grid.
 */

import type { Point } from './v2.js'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** A set of cells, each named by its top left corner. */
export class Cells {
  private readonly set = new Set<string>()
  add(x: number, y: number): void {
    this.set.add(`${x},${y}`)
  }
  delete(x: number, y: number): void {
    this.set.delete(`${x},${y}`)
  }
  has(x: number, y: number): boolean {
    return this.set.has(`${x},${y}`)
  }
  get size(): number {
    return this.set.size
  }
  *[Symbol.iterator](): IterableIterator<[number, number]> {
    for (const k of this.set) {
      const [x, y] = k.split(',').map(Number)
      yield [x, y]
    }
  }
  static of(rects: Rect[]): Cells {
    const c = new Cells()
    for (const r of rects) for (let i = 0; i < r.w; i++) for (let j = 0; j < r.h; j++) c.add(r.x + i, r.y + j)
    return c
  }
}

/**
 * The boundary of a set of cells as closed loops of corner points, with
 * straight runs merged into one edge. The outer loop of a piece runs
 * clockwise on screen (y down), and a hole anticlockwise. Loops are listed
 * largest first, so a connected shape's outline is the first.
 */
export function cellLoops(cells: Cells): Point[][] {
  // Directed unit edges with the shape on their right, keyed by start point.
  const next = new Map<string, Point[]>()
  const push = (a: Point, b: Point) => {
    const k = `${a[0]},${a[1]}`
    next.set(k, [...(next.get(k) ?? []), b])
  }
  for (const [x, y] of cells) {
    if (!cells.has(x, y - 1)) push([x, y], [x + 1, y])
    if (!cells.has(x + 1, y)) push([x + 1, y], [x + 1, y + 1])
    if (!cells.has(x, y + 1)) push([x + 1, y + 1], [x, y + 1])
    if (!cells.has(x - 1, y)) push([x, y + 1], [x, y])
  }
  const loops: Point[][] = []
  const take = (k: string, prev: Point | null): Point | undefined => {
    const list = next.get(k)
    if (!list?.length) return undefined
    // Where two loops touch at a corner, turn right, so each loop stays simple.
    let i = 0
    if (list.length > 1 && prev) {
      const [px, py] = k.split(',').map(Number)
      const din: Point = [px - prev[0], py - prev[1]]
      const right: Point = [-din[1], din[0]]
      const j = list.findIndex((p) => p[0] - px === right[0] && p[1] - py === right[1])
      if (j >= 0) i = j
    }
    const [p] = list.splice(i, 1)
    if (!list.length) next.delete(k)
    return p
  }
  while (next.size) {
    const startKey = [...next.keys()].sort((a, b) => {
      const [ax, ay] = a.split(',').map(Number)
      const [bx, by] = b.split(',').map(Number)
      return ay - by || ax - bx
    })[0]
    const start = startKey.split(',').map(Number) as Point
    const loop: Point[] = [start]
    let prev: Point | null = null
    let cur: Point = start
    for (;;) {
      const p = take(`${cur[0]},${cur[1]}`, prev)
      if (!p || (p[0] === start[0] && p[1] === start[1])) break
      loop.push(p)
      prev = cur
      cur = p
    }
    loops.push(simplify(loop))
  }
  return loops.sort((a, b) => Math.abs(area(b)) - Math.abs(area(a)))
}

/** Drop corners in the middle of a straight run. */
export function simplify(loop: Point[]): Point[] {
  const out: Point[] = []
  const n = loop.length
  for (let i = 0; i < n; i++) {
    const a = loop[(i + n - 1) % n]
    const b = loop[i]
    const c = loop[(i + 1) % n]
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
    if (cross !== 0) out.push(b)
  }
  return out
}

/** Signed area by the shoelace formula, positive for clockwise on screen (y down). */
export function area(loop: Point[]): number {
  let s = 0
  for (let i = 0; i < loop.length; i++) {
    const [x1, y1] = loop[i]
    const [x2, y2] = loop[(i + 1) % loop.length]
    s += x1 * y2 - x2 * y1
  }
  return s / 2
}

/** Whether a point is inside a polygon (even-odd rule), not counting its edge. */
export function inside(p: Point, loop: Point[]): boolean {
  let hit = false
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [xi, yi] = loop[i]
    const [xj, yj] = loop[j]
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

/** The cells of a size `cell` whose centres are inside an outline and outside its holes. */
export function cellsIn(outline: Point[], holes: Point[][], cell: number): Cells {
  const xs = outline.map((p) => p[0])
  const ys = outline.map((p) => p[1])
  const out = new Cells()
  for (let x = Math.floor(Math.min(...xs) / cell); x < Math.ceil(Math.max(...xs) / cell); x++) {
    for (let y = Math.floor(Math.min(...ys) / cell); y < Math.ceil(Math.max(...ys) / cell); y++) {
      const c: Point = [(x + 0.5) * cell, (y + 0.5) * cell]
      if (inside(c, outline) && !holes.some((h) => inside(c, h))) out.add(x, y)
    }
  }
  return out
}

/**
 * Split a connected set of cells into as few rectangles as this greedy finds:
 * the largest first, then each time the largest that shares an edge with
 * what is taken. Ties go to the top, then the left, so the answer is stable.
 */
export function rectangles(cells: Cells): Rect[] {
  const left = new Cells()
  for (const [x, y] of cells) left.add(x, y)
  const out: Rect[] = []
  const taken = new Cells()
  while (left.size) {
    const r = largest(left, out.length ? taken : null)
    if (!r) break
    out.push(r)
    for (let i = 0; i < r.w; i++)
      for (let j = 0; j < r.h; j++) {
        left.delete(r.x + i, r.y + j)
        taken.add(r.x + i, r.y + j)
      }
  }
  return out
}

function largest(cells: Cells, touching: Cells | null): Rect | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const [x, y] of cells) {
    x0 = Math.min(x0, x)
    y0 = Math.min(y0, y)
    x1 = Math.max(x1, x + 1)
    y1 = Math.max(y1, y + 1)
  }
  const W = x1 - x0
  const H = y1 - y0
  // Prefix sums, so whether a rectangle is all cells is one lookup.
  const sum = new Int32Array((W + 1) * (H + 1))
  const at = (i: number, j: number) => j * (W + 1) + i
  for (let j = 1; j <= H; j++)
    for (let i = 1; i <= W; i++)
      sum[at(i, j)] =
        (cells.has(x0 + i - 1, y0 + j - 1) ? 1 : 0) + sum[at(i - 1, j)] + sum[at(i, j - 1)] - sum[at(i - 1, j - 1)]
  const full = (i: number, j: number, w: number, h: number) =>
    sum[at(i + w, j + h)] - sum[at(i, j + h)] - sum[at(i + w, j)] + sum[at(i, j)] === w * h
  const touches = (r: Rect) => {
    if (!touching) return true
    for (let i = 0; i < r.w; i++) if (touching.has(r.x + i, r.y - 1) || touching.has(r.x + i, r.y + r.h)) return true
    for (let j = 0; j < r.h; j++) if (touching.has(r.x - 1, r.y + j) || touching.has(r.x + r.w, r.y + j)) return true
    return false
  }
  let best: Rect | null = null
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      if (!cells.has(x0 + i, y0 + j)) continue
      for (let h = 1; j + h <= H; h++) {
        if (!full(i, j, 1, h)) break
        for (let w = 1; i + w <= W; w++) {
          if (!full(i, j, w, h)) break
          if (best && w * h <= best.w * best.h) continue
          const r = { x: x0 + i, y: y0 + j, w, h }
          if (touches(r)) best = r
        }
      }
    }
  return best
}
