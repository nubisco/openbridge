/**
 * The house plan: floors, rooms and where each device physically is.
 *
 * One JSON document per bridge, drawn by the person in the House view. It is
 * the bridge's source of rooms: a device's room is whichever room its
 * placement falls in, derived on read, so moving a room in the editor moves
 * every device in it without a second copy of the truth to update.
 *
 * Geometry is in grid cells, not metres. A cell is `grid` metres (0.5 today),
 * and every room edge sits on a cell line, which keeps wall derivation exact
 * integer arithmetic in the UI. A device sits on a half cell at most.
 *
 * Writes are whole-document, guarded by a revision number: a tab that saves a
 * plan it read before another tab saved gets a 409 rather than silently
 * undoing the other tab's work.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { Logger } from '@nubisco/openbridge-logger'

const log = Logger.create('house')

export const HOUSE_VERSION = 1
/** Metres per grid cell. */
export const HOUSE_GRID = 0.5

export type HouseRoomKind = 'room' | 'outdoor' | 'pool'

export interface HouseRoom {
  id: string
  name: string
  /** A `room` has walls. An outdoor zone and a pool are ground with no walls. */
  kind: HouseRoomKind
  x: number
  y: number
  w: number
  h: number
  /**
   * More rectangles joined to the main one, for a room that is not a
   * rectangle: an L is one part, a U is two. Each shares an edge with the
   * shape before it and none overlap, so the room is one connected piece
   * with no wall inside it.
   */
  parts?: HouseRect[]
}

export interface HouseRect {
  x: number
  y: number
  w: number
  h: number
}

/** Every rectangle a room is made of, main one first. */
export function roomRects(r: HouseRoom): HouseRect[] {
  return [{ x: r.x, y: r.y, w: r.w, h: r.h }, ...(r.parts ?? [])]
}

const overlaps = (a: HouseRect, b: HouseRect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** Two rectangles that do not overlap but share at least one cell of edge. */
const touches = (a: HouseRect, b: HouseRect) => {
  const alongX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const alongY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return (
    ((a.y + a.h === b.y || b.y + b.h === a.y) && alongX >= 1) ||
    ((a.x + a.w === b.x || b.x + b.w === a.x) && alongY >= 1)
  )
}

export interface HouseOpening {
  id: string
  type: 'door' | 'window'
  /** Start of the opening, on a wall line. */
  x: number
  y: number
  /** `h` runs along x, `v` along y. */
  axis: 'h' | 'v'
  /** Length in cells. */
  len: number
  /** A door's hinge: the end at the lower x or y (`start`), or the other one. Default `start`. */
  hinge?: 'start' | 'end'
  /**
   * The side a door swings into, as seen on the plan: `up` or `down` for a
   * door in a wall running along x, `left` or `right` along y. Default
   * `down` or `right`.
   */
  opens?: 'up' | 'down' | 'left' | 'right'
}

/** How a light hangs: from the ceiling, on a wall, or as a floor or table lamp. */
export const LIGHT_MOUNTS = ['ceiling', 'wall', 'floor', 'table'] as const
/**
 * What a device is drawn as. The bridge sees a smart plug or a relay, and the
 * person knows it is the fridge, so they say so on the plan.
 */
export const DEVICE_LOOKS = ['outlet', 'tv', 'fridge', 'washer', 'dehumidifier', 'vacuum', 'mower'] as const

export interface HousePlacement {
  /** `device:<id>` for a native device, `accessory:<uuid>` for a HomeKit accessory. */
  ref: string
  x: number
  y: number
  /** A shutter or blind belongs to a window, and is drawn on it. */
  opening?: string
  /** The glow colour of a light that cannot report one (a relay driving a lamp). */
  color?: string
  /** Rooms a heating or cooling device's water circuit runs through, in order. */
  circuitRooms?: string[]
  /** A gate's width in cells. Drawn centred on (x, y). */
  length?: number
  /** Which way a gate or a TV runs: `h` along x, `v` along y. */
  axis?: 'h' | 'v'
  /** Where a light is mounted. */
  mount?: (typeof LIGHT_MOUNTS)[number]
  /** What the device is drawn as, when its type alone does not say. */
  look?: (typeof DEVICE_LOOKS)[number]
}

export interface HouseFloor {
  id: string
  name: string
  /** 0 is the ground floor. Negative is a basement. */
  level: number
  rooms: HouseRoom[]
  openings: HouseOpening[]
  placements: HousePlacement[]
}

export interface HousePlan {
  version: typeof HOUSE_VERSION
  grid: number
  /** The plot, in cells. The ground floor's ground. */
  plot: { w: number; h: number }
  floors: HouseFloor[]
}

export interface StoredHouse {
  plan: HousePlan | null
  /** Bumped on every save. 0 means nothing has been saved yet. */
  rev: number
  updatedAt: string | null
}

export interface DeviceRoom {
  id: string
  name: string
  floor: { id: string; name: string; level: number }
}

export class HouseValidationError extends Error {}

// ─── Validation ─────────────────────────────────────────────────────────────

const LIMITS = { floors: 12, rooms: 300, openings: 600, placements: 500, plot: 400, name: 80 }
const ID = /^[A-Za-z0-9_-]{1,64}$/
const REF = /^(device|accessory):[^\s]{1,200}$/
const COLOR = /^#[0-9a-fA-F]{6}$/

function fail(path: string, message: string): never {
  throw new HouseValidationError(`${path}: ${message}`)
}

function obj(v: unknown, path: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(path, 'must be an object')
  return v as Record<string, unknown>
}

function arr(v: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(v)) fail(path, 'must be a list')
  if (v.length > max) fail(path, `at most ${max} entries`)
  return v
}

function int(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    fail(path, `must be a whole number from ${min} to ${max}`)
  }
  return v
}

/** A device sits on a half cell at most, so a light can hang in the middle of one. */
function half(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || !Number.isInteger(v * 2)) {
    fail(path, `must be a multiple of 0.5 from ${min} to ${max}`)
  }
  return v
}

function id(v: unknown, path: string): string {
  if (typeof v !== 'string' || !ID.test(v)) fail(path, 'must be 1 to 64 letters, digits, - or _')
  return v
}

function name(v: unknown, path: string): string {
  if (typeof v !== 'string') fail(path, 'must be text')
  const s = v.trim()
  if (!s || s.length > LIMITS.name) fail(path, `must be 1 to ${LIMITS.name} characters`)
  return s
}

/**
 * Check a plan from the outside world and return a clean copy.
 *
 * Unknown fields are dropped rather than refused, so an older UI saving a
 * plan cannot fail on a field a newer one added, and nothing unexpected ends
 * up on disk.
 */
export function validateHousePlan(raw: unknown): HousePlan {
  const p = obj(raw, 'plan')
  if (p.version !== HOUSE_VERSION) fail('plan.version', `must be ${HOUSE_VERSION}`)
  const plotRaw = obj(p.plot, 'plan.plot')
  const plot = { w: int(plotRaw.w, 'plan.plot.w', 1, LIMITS.plot), h: int(plotRaw.h, 'plan.plot.h', 1, LIMITS.plot) }

  const floorIds = new Set<string>()
  const levels = new Set<number>()
  const roomIds = new Set<string>()
  const refs = new Set<string>()

  const floors = arr(p.floors, 'plan.floors', LIMITS.floors).map((fRaw, fi): HouseFloor => {
    const fp = `plan.floors[${fi}]`
    const f = obj(fRaw, fp)
    const fid = id(f.id, `${fp}.id`)
    if (floorIds.has(fid)) fail(`${fp}.id`, `'${fid}' is used twice`)
    floorIds.add(fid)
    const level = int(f.level, `${fp}.level`, -5, 20)
    if (levels.has(level)) fail(`${fp}.level`, `two floors cannot share level ${level}`)
    levels.add(level)

    const rooms = arr(f.rooms, `${fp}.rooms`, LIMITS.rooms).map((rRaw, ri): HouseRoom => {
      const rp = `${fp}.rooms[${ri}]`
      const r = obj(rRaw, rp)
      const rid = id(r.id, `${rp}.id`)
      // Rooms are the bridge's rooms, so an id names one room in the whole house.
      if (roomIds.has(rid)) fail(`${rp}.id`, `'${rid}' is used twice`)
      roomIds.add(rid)
      const kind = r.kind
      if (kind !== 'room' && kind !== 'outdoor' && kind !== 'pool') fail(`${rp}.kind`, 'must be room, outdoor or pool')
      const x = int(r.x, `${rp}.x`, 0, plot.w - 1)
      const y = int(r.y, `${rp}.y`, 0, plot.h - 1)
      const w = int(r.w, `${rp}.w`, 1, plot.w - x)
      const h = int(r.h, `${rp}.h`, 1, plot.h - y)
      const room: HouseRoom = { id: rid, name: name(r.name, `${rp}.name`), kind, x, y, w, h }
      if (r.parts !== undefined) {
        const shape: HouseRect[] = [{ x, y, w, h }]
        room.parts = arr(r.parts, `${rp}.parts`, 8).map((partRaw, ki) => {
          const kp = `${rp}.parts[${ki}]`
          const k = obj(partRaw, kp)
          const px = int(k.x, `${kp}.x`, 0, plot.w - 1)
          const py = int(k.y, `${kp}.y`, 0, plot.h - 1)
          const part = { x: px, y: py, w: int(k.w, `${kp}.w`, 1, plot.w - px), h: int(k.h, `${kp}.h`, 1, plot.h - py) }
          if (shape.some((q) => overlaps(q, part))) fail(kp, 'overlaps the rest of the room')
          if (!shape.some((q) => touches(q, part))) fail(kp, 'must share an edge with the rest of the room')
          shape.push(part)
          return part
        })
        if (!room.parts.length) delete room.parts
      }
      return room
    })

    const openingIds = new Set<string>()
    const windows = new Set<string>()
    const openings = arr(f.openings, `${fp}.openings`, LIMITS.openings).map((oRaw, oi): HouseOpening => {
      const op = `${fp}.openings[${oi}]`
      const o = obj(oRaw, op)
      const oid = id(o.id, `${op}.id`)
      if (openingIds.has(oid)) fail(`${op}.id`, `'${oid}' is used twice`)
      openingIds.add(oid)
      if (o.type !== 'door' && o.type !== 'window') fail(`${op}.type`, 'must be door or window')
      if (o.axis !== 'h' && o.axis !== 'v') fail(`${op}.axis`, 'must be h or v')
      if (o.type === 'window') windows.add(oid)
      const x = int(o.x, `${op}.x`, 0, plot.w)
      const y = int(o.y, `${op}.y`, 0, plot.h)
      const len = int(o.len, `${op}.len`, 1, o.axis === 'h' ? plot.w - x : plot.h - y)
      const out: HouseOpening = { id: oid, type: o.type, axis: o.axis, x, y, len }
      if (o.hinge !== undefined) {
        if (o.hinge !== 'start' && o.hinge !== 'end') fail(`${op}.hinge`, 'must be start or end')
        out.hinge = o.hinge
      }
      if (o.opens !== undefined) {
        const sides = o.axis === 'h' ? ['up', 'down'] : ['left', 'right']
        if (typeof o.opens !== 'string' || !sides.includes(o.opens))
          fail(`${op}.opens`, `must be ${sides.join(' or ')}`)
        out.opens = o.opens as HouseOpening['opens']
      }
      return out
    })

    const placements = arr(f.placements, `${fp}.placements`, LIMITS.placements).map((plRaw, pi): HousePlacement => {
      const pp = `${fp}.placements[${pi}]`
      const pl = obj(plRaw, pp)
      if (typeof pl.ref !== 'string' || !REF.test(pl.ref)) fail(`${pp}.ref`, 'must be device:<id> or accessory:<uuid>')
      // One device is in one place. Two placements would give it two rooms.
      if (refs.has(pl.ref)) fail(`${pp}.ref`, `'${pl.ref}' is placed twice`)
      refs.add(pl.ref)
      const out: HousePlacement = {
        ref: pl.ref,
        x: half(pl.x, `${pp}.x`, 0, plot.w),
        y: half(pl.y, `${pp}.y`, 0, plot.h),
      }
      if (pl.opening !== undefined) {
        const oid = id(pl.opening, `${pp}.opening`)
        if (!windows.has(oid)) fail(`${pp}.opening`, `'${oid}' is not a window on this floor`)
        out.opening = oid
      }
      if (pl.color !== undefined) {
        if (typeof pl.color !== 'string' || !COLOR.test(pl.color)) fail(`${pp}.color`, 'must be a #rrggbb colour')
        out.color = pl.color.toLowerCase()
      }
      if (pl.length !== undefined) out.length = int(pl.length, `${pp}.length`, 1, 40)
      if (pl.axis !== undefined) {
        if (pl.axis !== 'h' && pl.axis !== 'v') fail(`${pp}.axis`, 'must be h or v')
        out.axis = pl.axis
      }
      if (pl.mount !== undefined) {
        if (!(LIGHT_MOUNTS as readonly unknown[]).includes(pl.mount))
          fail(`${pp}.mount`, `must be one of ${LIGHT_MOUNTS.join(', ')}`)
        out.mount = pl.mount as HousePlacement['mount']
      }
      if (pl.look !== undefined) {
        if (!(DEVICE_LOOKS as readonly unknown[]).includes(pl.look))
          fail(`${pp}.look`, `must be one of ${DEVICE_LOOKS.join(', ')}`)
        out.look = pl.look as HousePlacement['look']
      }
      if (pl.circuitRooms !== undefined) {
        out.circuitRooms = arr(pl.circuitRooms, `${pp}.circuitRooms`, 50).map((c, ci) =>
          id(c, `${pp}.circuitRooms[${ci}]`),
        )
      }
      return out
    })

    return { id: fid, name: name(f.name, `${fp}.name`), level, rooms, openings, placements }
  })

  // Checked once every floor is read, because a circuit can serve rooms on
  // another floor: one heat pump feeds the radiators upstairs.
  floors.forEach((f, fi) =>
    f.placements.forEach((pl, pi) =>
      pl.circuitRooms?.forEach((rid, ci) => {
        if (!roomIds.has(rid)) fail(`plan.floors[${fi}].placements[${pi}].circuitRooms[${ci}]`, `no room '${rid}'`)
      }),
    ),
  )

  return { version: HOUSE_VERSION, grid: HOUSE_GRID, plot, floors }
}

// ─── Rooms of devices ───────────────────────────────────────────────────────

const area = (r: HouseRoom) => roomRects(r).reduce((a, q) => a + q.w * q.h, 0)

/**
 * The room a point is in. Rooms can sit inside rooms (an en-suite drawn in a
 * bedroom, a house drawn on its garden), so the smallest room containing the
 * point wins: that is the one the point is really in. Ties go to the room
 * drawn first, which keeps the answer stable.
 */
function innermost(rooms: HouseRoom[]): HouseRoom | undefined {
  return rooms.reduce<HouseRoom | undefined>((best, r) => (!best || area(r) < area(best) ? r : best), undefined)
}

function contains(r: HouseRoom, x: number, y: number): boolean {
  return roomRects(r).some((q) => x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.h)
}

/**
 * Which room every placed device is in, keyed by its ref.
 *
 * The smallest room containing a device is its room, so a device in a room
 * drawn inside another is in the inner one. A point on a wall two equal rooms
 * share goes to the room drawn first, which is stable. A shutter is in the
 * room behind its window: the one with walls, not the garden.
 */
export function roomsByRef(plan: HousePlan | null): Map<string, DeviceRoom> {
  const out = new Map<string, DeviceRoom>()
  if (!plan) return out
  for (const f of plan.floors) {
    const floor = { id: f.id, name: f.name, level: f.level }
    for (const pl of f.placements) {
      let x = pl.x
      let y = pl.y
      const opening = pl.opening ? f.openings.find((o) => o.id === pl.opening) : undefined
      if (opening) {
        x = opening.x + (opening.axis === 'h' ? opening.len / 2 : 0)
        y = opening.y + (opening.axis === 'v' ? opening.len / 2 : 0)
      }
      const inside = f.rooms.filter((r) => contains(r, x, y))
      const room = (opening ? innermost(inside.filter((r) => r.kind === 'room')) : undefined) ?? innermost(inside)
      if (room) out.set(pl.ref, { id: room.id, name: room.name, floor })
    }
  }
  return out
}

// ─── Store ──────────────────────────────────────────────────────────────────

export class HouseConflictError extends Error {}

export class HouseStore {
  private state: StoredHouse = { plan: null, rev: 0, updatedAt: null }
  private rooms = new Map<string, DeviceRoom>()

  constructor(private readonly path: string) {
    this.load()
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) return
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StoredHouse>
      const plan = raw.plan ? validateHousePlan(raw.plan) : null
      this.state = {
        plan,
        rev: typeof raw.rev === 'number' && raw.rev >= 0 ? raw.rev : 0,
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
      }
      this.rooms = roomsByRef(plan)
    } catch (err) {
      // The file is left where it is, so the plan can still be recovered by
      // hand. The next save replaces it.
      log.warn(`Could not read the house plan, starting without one: ${err}`)
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    // Written aside and renamed, so a power cut mid-write leaves the old plan
    // rather than half of a new one. Unlike the bell, a failed save is the
    // person's work lost, so it is thrown back to the request that made it.
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state, null, 2))
    renameSync(tmp, this.path)
  }

  get(): StoredHouse {
    return this.state
  }

  /**
   * Replace the plan. `baseRev` is the revision the caller read. A mismatch
   * means somebody saved in between, and is refused.
   */
  set(raw: unknown, baseRev: number): StoredHouse {
    if (baseRev !== this.state.rev) {
      throw new HouseConflictError('The house plan was changed elsewhere. Reload it before saving.')
    }
    const plan = raw === null ? null : validateHousePlan(raw)
    const previous = this.state
    this.state = { plan, rev: previous.rev + 1, updatedAt: new Date().toISOString() }
    try {
      this.save()
    } catch (err) {
      this.state = previous
      throw err
    }
    this.rooms = roomsByRef(plan)
    return this.state
  }

  /** The room a device is placed in, if it is on the plan. */
  roomOf(ref: string): DeviceRoom | null {
    return this.rooms.get(ref) ?? null
  }
}
