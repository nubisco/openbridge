/**
 * Straight edges at any angle, in whole millimetres: which lie on one line,
 * how far they overlap, and the walls a set of room outlines makes.
 *
 * Exact for integer coordinates. A line is named by its direction (the
 * smallest whole vector along it, pointing towards +x, or +y when it runs
 * along y) and its offset, the cross product of that direction with any
 * point on it, so two edges are on one line when their names match.
 */

import { inside } from './cells.js'
import type { Point } from './v2.js'

export interface LineKey {
  /** Direction, the smallest whole vector along the line. */
  d: Point
  /** d × p for any point p on the line. */
  off: number
  key: string
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : Math.abs(a))

/** The line through a and b, or null when they are the same point. */
export function lineOf(a: Point, b: Point): LineKey | null {
  let dx = b[0] - a[0]
  let dy = b[1] - a[1]
  if (!dx && !dy) return null
  const g = gcd(Math.abs(dx), Math.abs(dy))
  dx /= g
  dy /= g
  if (dx < 0 || (dx === 0 && dy < 0)) {
    dx = -dx
    dy = -dy
  }
  const off = dx * a[1] - dy * a[0]
  return { d: [dx, dy], off, key: `${dx},${dy},${off}` }
}

/** How far along a line's direction a point is (scaled by the direction's length). */
export const along = (l: LineKey, p: Point): number => l.d[0] * p[0] + l.d[1] * p[1]

/** The point on a line at `t` along it, rounded to the millimetre. */
export function pointAt(l: LineKey, t: number): Point {
  const n = l.d[0] * l.d[0] + l.d[1] * l.d[1]
  return [Math.round((t * l.d[0] - l.off * l.d[1]) / n), Math.round((t * l.d[1] + l.off * l.d[0]) / n)]
}

/** How long two segments overlap, in millimetres. 0 when they are not on one line. */
export function overlapLength(a: [Point, Point], b: [Point, Point]): number {
  const la = lineOf(a[0], a[1])
  const lb = lineOf(b[0], b[1])
  if (!la || !lb || la.key !== lb.key) return 0
  const [a0, a1] = [along(la, a[0]), along(la, a[1])].sort((x, y) => x - y)
  const [b0, b1] = [along(la, b[0]), along(la, b[1])].sort((x, y) => x - y)
  const t = Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))
  return t / Math.hypot(la.d[0], la.d[1])
}

export interface WallLine {
  /** `h` along x, `v` along y, null at an angle. */
  axis: 'h' | 'v' | null
  /** For `h` the y, for `v` the x. 0 at an angle. */
  line: number
  /** Along the line: x for `h`, y for `v`. 0 at an angle. */
  start: number
  end: number
  /** The ends, `a` first along the line's direction. */
  a: Point
  b: Point
  /** Between two rooms, rather than with a room on one side only. */
  inner: boolean
}

/** Whether a point is inside a room given as its outline and holes. */
export function inRoom(p: Point, loops: Point[][]): boolean {
  const [outline, ...holes] = loops
  return !!outline && inside(p, outline) && !holes.some((h) => inside(p, h))
}

/**
 * The walls of rooms, each given as its loops (outline first, then holes),
 * in millimetres: every stretch of room edge, cut where it changes from
 * between two rooms (inner) to one with a room on one side only, and merged
 * into straight runs otherwise. Along x first, then along y, then at an
 * angle, each by line and then along it.
 */
export function wallLinesOf(rooms: Point[][][]): WallLine[] {
  const groups = new Map<string, { l: LineKey; spans: Array<[number, number]> }>()
  for (const loops of rooms)
    for (const loop of loops)
      loop.forEach((a, i) => {
        const b = loop[(i + 1) % loop.length]
        const l = lineOf(a, b)
        if (!l) return
        const g = groups.get(l.key) ?? { l, spans: [] }
        const [t0, t1] = [along(l, a), along(l, b)].sort((x, y) => x - y)
        g.spans.push([t0, t1])
        groups.set(l.key, g)
      })
  const inAny = (p: Point) => rooms.some((loops) => inRoom(p, loops))
  const out: Array<WallLine & { order: [number, number, number, number] }> = []
  for (const { l, spans } of groups.values()) {
    const cuts = [...new Set(spans.flat())].sort((x, y) => x - y)
    const n = Math.hypot(l.d[0], l.d[1])
    // Half a millimetre either side of the line.
    const nx = (-l.d[1] / n) * 0.5
    const ny = (l.d[0] / n) * 0.5
    const axis: WallLine['axis'] = l.d[1] === 0 ? 'h' : l.d[0] === 0 ? 'v' : null
    let cur: { t0: number; t1: number; inner: boolean } | null = null
    const flush = () => {
      if (!cur) return
      const a = pointAt(l, cur.t0)
      const b = pointAt(l, cur.t1)
      out.push({
        axis,
        line: axis === 'h' ? a[1] : axis === 'v' ? a[0] : 0,
        start: axis === 'h' ? a[0] : axis === 'v' ? a[1] : 0,
        end: axis === 'h' ? b[0] : axis === 'v' ? b[1] : 0,
        a,
        b,
        inner: cur.inner,
        order: [
          axis === 'h' ? 0 : axis === 'v' ? 1 : 2,
          axis ? (axis === 'h' ? a[1] : a[0]) : 0,
          axis ? 0 : l.off,
          cur.t0,
        ],
      })
      cur = null
    }
    for (let i = 0; i + 1 < cuts.length; i++) {
      const [t0, t1] = [cuts[i], cuts[i + 1]]
      if (!spans.some(([s, e]) => s <= t0 && t1 <= e)) {
        flush()
        continue
      }
      // The middle of this stretch, exactly, and a point either side of it.
      const t = (t0 + t1) / 2
      const mid: Point = [(t * l.d[0] - l.off * l.d[1]) / (n * n), (t * l.d[1] + l.off * l.d[0]) / (n * n)]
      const inner = inAny([mid[0] + nx, mid[1] + ny]) && inAny([mid[0] - nx, mid[1] - ny])
      if (cur && cur.t1 === t0 && cur.inner === inner) cur.t1 = t1
      else {
        flush()
        cur = { t0, t1, inner }
      }
    }
    flush()
  }
  out.sort((x, y) => {
    for (let i = 0; i < 4; i++) if (x.order[i] !== y.order[i]) return x.order[i] - y.order[i]
    return 0
  })
  return out.map(({ order: _order, ...w }) => w)
}
