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
  openingFits,
  openingsOverlap,
  openingUnits,
  r1,
  roomArea,
  roomAt,
  roomOutline,
  roomRects,
  roomsOutsideIn,
  sliderPanes,
  takesShutter,
  unitKey,
  wallRuns,
  wallUnits,
  type Point,
  type WallUnit,
} from './geometry'
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
  plan.plot[axis] = clamp(Math.round(cells), min, 400)
}

export function removeFloor(plan: HousePlan, floorId: string): void {
  if (plan.floors.length <= 1) return
  plan.floors = plan.floors.filter((f) => f.id !== floorId)
}

/** The wall units on a room's outline, so moving a room can carry its openings along. */
function perimeter(r: HouseRoom): Set<string> {
  return new Set(roomOutline(r).map((u) => unitKey(u.x, u.y, u.axis)))
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
  const shape: HouseRect[] = [r]
  for (const q of r.parts ?? []) {
    if (q.w < 1 || q.h < 1) return false
    if (shape.some((s) => overlaps(s, q)) || !shape.some((s) => touches(s, q))) return false
    shape.push(q)
  }
  return true
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
  const within = (q: HouseRect) =>
    roomRects(r).some((p) => q.x >= p.x && q.y >= p.y && q.x + q.w <= p.x + p.w && q.y + q.h <= p.y + p.h)
  const inner = floor.rooms.filter((x) => x !== r && roomRects(x).every(within))
  const group = new Set<HouseRoom>([r, ...inner])
  const edge = new Set([...group].flatMap((x) => [...perimeter(x)]))
  return {
    rooms: inner.map((x) => ({ room: x, o: roomRects(x).map((q) => ({ ...q })) })),
    openings: floor.openings
      .filter((o) => openingUnits(o).every((k) => edge.has(k)))
      .map((o) => ({ o, x: o.x, y: o.y })),
    radiators: (floor.radiators ?? [])
      .filter((r) => spanUnits(r).every((k) => edge.has(k)))
      .map((r) => ({ o: r, x: r.x, y: r.y })),
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

/** The wall unit nearest a point, within reach of a finger. */
export function nearestWall(floor: HouseFloor, x: number, y: number, reach = 1.4): WallUnit | null {
  let best: WallUnit | null = null
  let bd = reach
  for (const u of wallUnits(floor).values()) {
    const mx = u.x + (u.axis === 'h' ? 0.5 : 0)
    const my = u.y + (u.axis === 'v' ? 0.5 : 0)
    const d = Math.hypot(x - mx, y - my)
    if (d < bd) {
      bd = d
      best = u
    }
  }
  return best
}

export function openingAt(floor: HouseFloor, u: WallUnit): HouseOpening | undefined {
  const k = unitKey(u.x, u.y, u.axis)
  return floor.openings.find((o) => openingUnits(o).includes(k))
}

/**
 * Put a door or window on the wall at `u`, a metre long and centred on the tap
 * where the wall allows. Returns null when there is no wall left there.
 */
export function addOpening(floor: HouseFloor, u: WallUnit, preset: OpeningPreset): HouseOpening | null {
  const units = wallUnits(floor)
  const taken = new Set(floor.openings.flatMap(openingUnits))
  const free = (i: number) => {
    const k = u.axis === 'h' ? unitKey(u.x + i, u.y, 'h') : unitKey(u.x, u.y + i, 'v')
    return units.has(k) && !taken.has(k)
  }
  if (!free(0)) return null
  // As wide as the preset: a sliding door two metres, the usual two panes.
  const want = presetCells(preset)
  // Grow from the tapped unit, preferring to centre on it.
  let start = 0
  let end = 1
  while (end - start < want && (free(end) || free(start - 1))) {
    if (free(start - 1) && (end - start) % 2 === 1) start--
    else if (free(end)) end++
    else start--
  }
  const id = uniqueId(preset.kind, (x) => floor.openings.some((o) => o.id === x))
  const o: HouseOpening = {
    id,
    type: preset.kind,
    axis: u.axis,
    x: u.axis === 'h' ? u.x + start : u.x,
    y: u.axis === 'v' ? u.y + start : u.y,
    len: end - start,
  }
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
    const cx = o.axis === 'h' ? clamp(x, o.x, o.x + o.len) : o.x
    const cy = o.axis === 'v' ? clamp(y, o.y, o.y + o.len) : o.y
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
  if (o.len < 1) return false
  const units = wallUnits(floor)
  return (
    openingUnits(o).every((k) => units.has(k)) && !floor.openings.some((x) => x.id !== o.id && openingsOverlap(x, o))
  )
}

/** Openings move and resize in half cells, a quarter metre. */
const quarter = (v: number) => Math.round(v * 2) / 2

/**
 * Leave the wall at `u` out: the whole stretch of it the same two rooms
 * share, up to the corners or the doors and windows already on it. Two rooms
 * that run into each other usually have nothing between them at all.
 */
export function addOpenWall(floor: HouseFloor, u: WallUnit): HouseOpening | null {
  const units = wallUnits(floor)
  const sides = (i: number) => {
    const x = u.axis === 'h' ? u.x + i : u.x
    const y = u.axis === 'v' ? u.y + i : u.y
    const a = u.axis === 'h' ? roomAt(floor, x + 0.5, y - 0.5) : roomAt(floor, x - 0.5, y + 0.5)
    const b = u.axis === 'h' ? roomAt(floor, x + 0.5, y + 0.5) : roomAt(floor, x + 0.5, y + 0.5)
    return `${a?.id ?? ''}|${b?.id ?? ''}`
  }
  const pair = sides(0)
  const probe = (i: number): HouseOpening => ({
    id: '',
    type: 'open',
    axis: u.axis,
    x: u.axis === 'h' ? u.x + i : u.x,
    y: u.axis === 'v' ? u.y + i : u.y,
    len: 1,
  })
  const free = (i: number) =>
    units.has(openingUnits(probe(i))[0]) &&
    sides(i) === pair &&
    !floor.openings.some((x) => openingsOverlap(x, probe(i)))
  if (!free(0)) return null
  let start = 0
  let end = 1
  while (free(start - 1)) start--
  while (free(end)) end++
  const id = uniqueId('open', (x) => floor.openings.some((o) => o.id === x))
  const o: HouseOpening = { ...probe(start), id, len: end - start }
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
  const start = quarter((u.axis === 'h' ? x : y) - grab)
  const next: HouseOpening = { ...o, axis: u.axis, x: u.axis === 'h' ? start : u.x, y: u.axis === 'v' ? start : u.y }
  // A side is named for the wall's direction, so a turned door opens the default way.
  if (next.axis !== o.axis) delete next.opens
  if (!fitsFree(floor, next)) return false
  Object.assign(o, next)
  if (!next.opens) delete o.opens
  return true
}

/** Drag one end of an opening along its wall, in quarter metres, never under half a metre long. */
export function resizeOpening(floor: HouseFloor, o: HouseOpening, end: 'start' | 'end', x: number, y: number): boolean {
  const at = quarter(o.axis === 'h' ? x : y)
  const s0 = o.axis === 'h' ? o.x : o.y
  const s1 = s0 + o.len
  const start = end === 'start' ? Math.min(at, s1 - 1) : s0
  const stop = end === 'end' ? Math.max(at, s0 + 1) : s1
  const next: HouseOpening = {
    ...o,
    x: o.axis === 'h' ? start : o.x,
    y: o.axis === 'v' ? start : o.y,
    len: stop - start,
  }
  if (!fitsFree(floor, next)) return false
  Object.assign(o, next)
  return true
}

// ─── Radiators ──────────────────────────────────────────────────────────────

/** The wall units a radiator covers, even partly. */
function spanUnits(r: Pick<HouseRadiator, 'x' | 'y' | 'axis' | 'len'>): string[] {
  const s = r.axis === 'h' ? r.x : r.y
  const out: string[] = []
  for (let i = Math.floor(s); i < Math.ceil(s + r.len); i++) {
    out.push(r.axis === 'h' ? unitKey(i, r.y, 'h') : unitKey(r.x, i, 'v'))
  }
  return out
}

const sameLine = (a: { axis: string; x: number; y: number }, b: { axis: string; x: number; y: number }) =>
  a.axis === b.axis && (a.axis === 'h' ? a.y === b.y : a.x === b.x)
const spanOf = (r: { axis: string; x: number; y: number; len: number }): [number, number] => {
  const s = r.axis === 'h' ? r.x : r.y
  return [s, s + r.len]
}
const crosses = (a: [number, number], b: [number, number]) => a[0] < b[1] && b[0] < a[1]

/**
 * Whether a radiator sits wholly on wall: not across a doorway or an open
 * wall, and not over another radiator on the same side. Under a window is
 * where radiators usually are, so a window is fine.
 */
export function radiatorFits(floor: HouseFloor, r: HouseRadiator): boolean {
  if (r.len < 1) return false
  const units = wallUnits(floor)
  if (!spanUnits(r).every((k) => units.has(k))) return false
  const span = spanOf(r)
  if (floor.openings.some((o) => o.type !== 'window' && sameLine(o, r) && crosses(spanOf(o), span))) return false
  return !(floor.radiators ?? []).some(
    (x) => x.id !== r.id && x.side === r.side && sameLine(x, r) && crosses(spanOf(x), span),
  )
}

/** The side of the wall at `u` that a point is on, as a radiator names it. */
function sideOf(u: WallUnit, x: number, y: number): HouseRadiator['side'] {
  return u.axis === 'h' ? (y < u.y ? 'up' : 'down') : x < u.x ? 'left' : 'right'
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
  const probe = (s: HouseRadiator['side']): HouseRadiator => ({ id: '', x: u.x, y: u.y, axis: u.axis, len: 1, side: s })
  const inRoom = (s: HouseRadiator['side']) => {
    const r = probe(s)
    const [nx, ny] = s === 'up' ? [0, -1] : s === 'down' ? [0, 1] : s === 'left' ? [-1, 0] : [1, 0]
    return (
      roomAt(floor, r.x + (r.axis === 'h' ? 0.5 : 0) + nx * 0.5, r.y + (r.axis === 'v' ? 0.5 : 0) + ny * 0.5)?.kind ===
      'room'
    )
  }
  if (!inRoom(side)) side = flip(side)
  if (!inRoom(side)) return null
  const id = uniqueId(
    'radiator',
    (v) => (floor.radiators ?? []).some((r) => r.id === v) || floor.openings.some((o) => o.id === v),
  )
  const centre = u.axis === 'h' ? x : y
  for (const len of [CELLS_PER_M, 1.5, 1]) {
    const start = Math.round((centre - len / 2) * 2) / 2
    const r: HouseRadiator = {
      id,
      axis: u.axis,
      x: u.axis === 'h' ? start : u.x,
      y: u.axis === 'v' ? start : u.y,
      len,
      side,
    }
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
  const start = Math.round(((u.axis === 'h' ? x : y) - grab) * 2) / 2
  const next: HouseRadiator = {
    ...r,
    axis: u.axis,
    x: u.axis === 'h' ? start : u.x,
    y: u.axis === 'v' ? start : u.y,
    // Along the same wall it keeps its side. Onto another, it takes the side the pointer is on.
    side: u.axis === r.axis && sameLine(u, r) ? r.side : sideOf(u, x, y),
  }
  if (!radiatorFits(floor, next)) return false
  Object.assign(r, next)
  return true
}

/** Drag one end of a radiator, in quarter metres, never under half a metre. */
export function resizeRadiator(
  floor: HouseFloor,
  r: HouseRadiator,
  end: 'start' | 'end',
  x: number,
  y: number,
): boolean {
  const at = Math.round((r.axis === 'h' ? x : y) * 2) / 2
  const [s0, s1] = spanOf(r)
  const start = end === 'start' ? Math.min(at, s1 - 1) : s0
  const stop = end === 'end' ? Math.max(at, s0 + 1) : s1
  const next: HouseRadiator = {
    ...r,
    x: r.axis === 'h' ? start : r.x,
    y: r.axis === 'v' ? start : r.y,
    len: stop - start,
  }
  if (!radiatorFits(floor, next)) return false
  Object.assign(r, next)
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

const halfCell = (v: number) => Math.round(v * 2) / 2

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

/** Move a piece in quarter metres, `grab` being where on it the pointer took it. */
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

/** Drag a corner of a piece, in quarter metres, never under a quarter metre a side. */
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
 * Put a device on a floor at (x,y), snapped to half cells. A shutter dropped
 * near a window attaches to it, which is where it is drawn from then on.
 */
export function place(plan: HousePlan, floor: HouseFloor, device: LiveDevice, x: number, y: number): void {
  const existing = placementOf(plan, device.ref)?.placement
  unplace(plan, device.ref)
  const p = {
    ...(existing ?? {}),
    ref: device.ref,
    x: clamp(Math.round(x * 2) / 2, 0, plan.plot.w),
    y: clamp(Math.round(y * 2) / 2, 0, plan.plot.h),
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
 * Tidy a draft before it is saved. Rooms can be moved out from under a door,
 * and a room a circuit served can be deleted. Those leftovers would fail the
 * daemon's checks, so they are dropped here, where the person is still looking.
 */
export function tidy(plan: HousePlan): HousePlan {
  const rooms = new Set(plan.floors.flatMap((f) => f.rooms.map((r) => r.id)))
  for (const f of plan.floors) {
    const units = wallUnits(f)
    const kept = new Set<string>()
    f.openings = f.openings.filter((o) => {
      const ok = openingFits(o, units)
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
  draft: Pick<HouseRoom, 'x' | 'y' | 'w' | 'h'> | null
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

const metres = (cells: number) => String(Math.round((cells / CELLS_PER_M) * 100) / 100)

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
      let d = ''
      for (const u of roomOutline(room)) {
        d += `M${u.x * S},${u.y * S}L${(u.axis === 'h' ? u.x + 1 : u.x) * S},${(u.axis === 'v' ? u.y + 1 : u.y) * S}`
      }
      h += `<path class="hv-eghost" d="${d}"/>`
    }
  }
  for (const r of roomsOutsideIn(floor.rooms)) {
    // The name sits in the largest part. An L is described by its area,
    // a rectangle by its sides.
    const rects = roomRects(r)
    const q = rects.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a))
    const nfs = Math.min(fs, (q.w * S - 10 * U) / Math.max(1, r.name.length * 0.62))
    const size = rects.length > 1 ? `${metres(roomArea(r) / CELLS_PER_M)} m²` : `${metres(r.w)} × ${metres(r.h)} m`
    let edge = ''
    for (const u of roomOutline(r)) {
      edge += `M${u.x * S},${u.y * S}L${(u.axis === 'h' ? u.x + 1 : u.x) * S},${(u.axis === 'v' ? u.y + 1 : u.y) * S}`
    }
    h +=
      `<g class="hv-eroom hv-k-${r.kind}${o.selectedRoom === r.id ? ' hv-sel' : ''}" data-room="${esc(r.id)}">` +
      rects.map((p) => `<rect x="${p.x * S}" y="${p.y * S}" width="${p.w * S}" height="${p.h * S}"/>`).join('') +
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
  for (const w of wallRuns(floor)) {
    const c = `x1="${w.x1 * S}" y1="${w.y1 * S}" x2="${w.x2 * S}" y2="${w.y2 * S}"`
    const sel = w.opening && w.opening.id === o.selectedOpening ? ' hv-sel' : ''
    if (w.type === 'wall') h += `<line class="hv-ewall" ${c}/>`
    else if (w.type === 'window') h += `<line class="hv-ewinb" ${c}/><line class="hv-ewin${sel}" ${c}/>`
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
    const n = r.side === 'up' ? [0, -1] : r.side === 'down' ? [0, 1] : r.side === 'left' ? [-1, 0] : [1, 0]
    const d = 0.3
    const x0 = Math.min(r.x, r.x + n[0] * d)
    const y0 = Math.min(r.y, r.y + n[1] * d)
    const rw = r.axis === 'h' ? r.len : d
    const rh = r.axis === 'v' ? r.len : d
    const sel = o.selectedRadiator === r.id ? ' hv-sel' : ''
    const c = `x1="${r.x * S}" y1="${r.y * S}" x2="${(r.axis === 'h' ? r.x + r.len : r.x) * S}" y2="${(r.axis === 'v' ? r.y + r.len : r.y) * S}"`
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
    if (attached) {
      x = attached.x + (attached.axis === 'h' ? attached.len / 2 : 0)
      y = attached.y + (attached.axis === 'v' ? attached.len / 2 : 0)
    }
    const letter = d ? KIND_LETTER[d.kind] : '?'
    const name = d?.name ?? 'Device no longer on the bridge'
    h +=
      `<g class="hv-edev${o.selectedRef === p.ref ? ' hv-sel' : ''}${d ? '' : ' hv-missing'}" data-ref="${esc(p.ref)}" transform="translate(${x * S},${y * S})">` +
      `<title>${esc(name)}</title><circle r="${r1(rr)}"/><text font-size="${r1(rr)}" dy="${r1(rr * 0.36)}">${letter}</text></g>`
  }
  // The selected door's or window's ends, over everything, so a device
  // standing beside it never hides them.
  const so = floor.openings.find((x) => x.id === o.selectedOpening)
  if (so) {
    const ends: Array<['start' | 'end', number, number]> = [
      ['start', so.x, so.y],
      ['end', so.axis === 'h' ? so.x + so.len : so.x, so.axis === 'v' ? so.y + so.len : so.y],
    ]
    for (const [end, x, y] of ends) {
      h += `<circle class="hv-eh hv-eoh-${so.axis}" data-ohandle="${end}" cx="${x * S}" cy="${y * S}" r="${r1(fit(6, 8))}"/>`
    }
  }
  const sr = (floor.radiators ?? []).find((x) => x.id === o.selectedRadiator)
  if (sr) {
    const ends: Array<['start' | 'end', number, number]> = [
      ['start', sr.x, sr.y],
      ['end', sr.axis === 'h' ? sr.x + sr.len : sr.x, sr.axis === 'v' ? sr.y + sr.len : sr.y],
    ]
    for (const [end, x, y] of ends) {
      h += `<circle class="hv-eh hv-eoh-${sr.axis}" data-rhandle="${end}" cx="${x * S}" cy="${y * S}" r="${r1(fit(6, 8))}"/>`
    }
  }
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
  const sel = floor.rooms.find((r) => r.id === o.selectedRoom)
  if (sel && o.showHandles) {
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
