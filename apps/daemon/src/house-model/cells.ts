/**
 * Shapes made of grid cells, and the polygons around them. Version 1 rooms
 * are rectangles, version 2 spaces are polygons, and these turn one into the
 * other exactly.
 *
 * The cells are not a fixed size. A `Grid` cuts the plane at every x and y a
 * shape has a corner at, so a rectangle of any size is a block of whole
 * cells, and the algorithms here walk a few dozen cells however finely the
 * shape is measured. Cells are named by their index in the grid, and the
 * grid turns indices back into coordinates.
 */

import type { Point } from './v2.js'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * The coordinates a grid is cut at along one axis. Values that differ by
 * less than a thousandth of a millimetre at the scale they are given in are
 * the same cut, so sums like x + w land on the cut they mean.
 */
export class Axis {
  readonly at: number[]
  private readonly index = new Map<number, number>()
  constructor(
    values: number[],
    private readonly scale = 1,
  ) {
    const keyed = new Map<number, number>()
    for (const v of values) {
      const k = this.key(v)
      if (!keyed.has(k)) keyed.set(k, v)
    }
    this.at = [...keyed.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)
    this.at.forEach((v, i) => this.index.set(this.key(v), i))
  }
  private key(v: number): number {
    return Math.round(v * this.scale * 1000)
  }
  /** The index of a cut. Throws for a value the grid was not cut at, which is a bug. */
  i(v: number): number {
    const i = this.index.get(this.key(v))
    if (i === undefined) throw new Error(`No cut at ${v}`)
    return i
  }
  get length(): number {
    return this.at.length
  }
}

/** A plane cut at every corner of some shapes. */
export class Grid {
  constructor(
    readonly xs: Axis,
    readonly ys: Axis,
  ) {}

  /**
   * Cut at every edge of these rectangles and corner of these loops.
   * `scale` is how many millimetres one unit is, so cuts closer than a
   * micrometre merge (1 for millimetres, 500 for version 1 cells).
   */
  static of(rects: Rect[], loops: Point[][] = [], scale = 1): Grid {
    const xs = [...rects.flatMap((r) => [r.x, r.x + r.w]), ...loops.flat().map((p) => p[0])]
    const ys = [...rects.flatMap((r) => [r.y, r.y + r.h]), ...loops.flat().map((p) => p[1])]
    return new Grid(new Axis(xs, scale), new Axis(ys, scale))
  }

  /** The cells these rectangles cover. Each must sit on the grid's cuts. */
  cells(rects: Rect[]): Cells {
    const c = new Cells()
    for (const r of rects) {
      const [i0, i1, j0, j1] = [this.xs.i(r.x), this.xs.i(r.x + r.w), this.ys.i(r.y), this.ys.i(r.y + r.h)]
      for (let i = i0; i < i1; i++) for (let j = j0; j < j1; j++) c.add(i, j)
    }
    return c
  }

  point([i, j]: Point): Point {
    return [this.xs.at[i], this.ys.at[j]]
  }

  rect(r: Rect): Rect {
    const x = this.xs.at[r.x]
    const y = this.ys.at[r.y]
    return { x, y, w: this.xs.at[r.x + r.w] - x, h: this.ys.at[r.y + r.h] - y }
  }

  /** How large a block of cells is, in real units. */
  area(r: Rect): number {
    return (this.xs.at[r.x + r.w] - this.xs.at[r.x]) * (this.ys.at[r.y + r.h] - this.ys.at[r.y])
  }

  /** The cells whose centres are inside an outline and outside its holes. */
  inside(outline: Point[], holes: Point[][]): Cells {
    const out = new Cells()
    for (let i = 0; i + 1 < this.xs.length; i++)
      for (let j = 0; j + 1 < this.ys.length; j++) {
        const c: Point = [(this.xs.at[i] + this.xs.at[i + 1]) / 2, (this.ys.at[j] + this.ys.at[j + 1]) / 2]
        if (inside(c, outline) && !holes.some((h) => inside(c, h))) out.add(i, j)
      }
    return out
  }
}

/** The outline of some rectangles and its holes, in their own units: `cellLoops` on a grid cut to fit. */
export function rectLoops(rects: Rect[], scale = 1): Point[][] {
  const g = Grid.of(rects, [], scale)
  return cellLoops(g.cells(rects)).map((loop) => loop.map((p) => g.point(p)))
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

/**
 * Split a connected set of cells into as few rectangles as this greedy finds:
 * the largest first (by real area, given the grid the cells are on), then each time the largest that shares an edge with
 * what is taken. Ties go to the top, then the left, so the answer is stable.
 */
export function rectangles(cells: Cells, grid?: Grid): Rect[] {
  const left = new Cells()
  for (const [x, y] of cells) left.add(x, y)
  const out: Rect[] = []
  const taken = new Cells()
  while (left.size) {
    const r = largest(left, out.length ? taken : null, grid)
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

function largest(cells: Cells, touching: Cells | null, grid?: Grid): Rect | null {
  const size = (r: Rect) => (grid ? grid.area(r) : r.w * r.h)
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
          const r = { x: x0 + i, y: y0 + j, w, h }
          if (best && size(r) <= size(best)) continue
          if (touches(r)) best = r
        }
      }
    }
  return best
}
