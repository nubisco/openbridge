/**
 * The house plan: storeys, walls, rooms and where each device physically is.
 *
 * One JSON document per bridge, drawn by the person in the House view. It is
 * the bridge's source of rooms: a device's room is whichever room its
 * placement falls in, derived on read, so moving a room in the editor moves
 * every device in it without a second copy of the truth to update.
 *
 * Stored as plan version 2 (millimetres, walls as elements, see
 * @nubisco/bim/v2 and docs/design/house-bim.md). A version 1 plan, from the
 * file of an older OpenBridge or a tab opened before the update, is still
 * accepted and converted, keeping what version 1 cannot say from the plan it
 * replaces.
 *
 * Writes are whole-document, guarded by a revision number: a tab that saves a
 * plan it read before another tab saved gets a 409 rather than silently
 * undoing the other tab's work.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { Logger } from '@nubisco/openbridge-logger'
import { area as loopArea, inside, onEdge } from '@nubisco/bim/cells'
import { fromV1, toV1 } from '@nubisco/bim/convert'
import { PlanError, validatePlan } from '@nubisco/bim/validate'
import { LEAVES, type Covering, type Plan } from '@nubisco/bim/v2'
import {
  DEVICE_LOOKS,
  FURNITURE_KINDS,
  HOUSE_GRID,
  HOUSE_V1,
  LIGHT_MOUNTS,
  overlaps,
  roomRects,
  touches,
  type HouseFloor,
  type HouseFurniture,
  type HouseOpening,
  type HousePlacement,
  type HousePlan,
  type HouseRadiator,
  type HouseRect,
  type HouseRoom,
  type OpeningSpec,
} from '@nubisco/bim/v1'

export * from '@nubisco/bim/v1'
export type { Plan } from '@nubisco/bim/v2'

const log = Logger.create('house')

/** The version a plan is stored in. */
export const HOUSE_VERSION = 2

export interface StoredHouse {
  plan: Plan | null
  /** Bumped on every save. 0 means nothing has been saved yet. */
  rev: number
  updatedAt: string | null
}

export interface DeviceRoom {
  id: string
  name: string
  floor: { id: string; name: string; level: number }
}

/** A plan that does not hold together. One class for both versions, so callers catch one thing. */
export const HouseValidationError = PlanError
export type HouseValidationError = PlanError

// ─── Validation ─────────────────────────────────────────────────────────────

const LIMITS = {
  floors: 12,
  rooms: 300,
  openings: 600,
  placements: 500,
  radiators: 300,
  furniture: 400,
  plot: 400,
  name: 80,
}
const ID = /^[A-Za-z0-9_-]{1,64}$/
const REF = /^(device|accessory):[^\s]{1,200}$/
const COLOR = /^#[0-9a-fA-F]{6}$/

function fail(path: string, message: string): never {
  throw new PlanError(`${path}: ${message}`)
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
 * Check a version 1 plan from the outside world and return a clean copy.
 *
 * Unknown fields are dropped rather than refused, so an older UI saving a
 * plan cannot fail on a field a newer one added, and nothing unexpected ends
 * up on disk.
 */
/**
 * A door's or window's detail as the cell editor sends it. Checked for shape
 * here, and for sense once converted, by validatePlan.
 */
function openingSpec(raw: unknown, at: string): OpeningSpec {
  const s = obj(raw, at)
  if (s.kind !== 'door' && s.kind !== 'window') fail(`${at}.kind`, 'must be door or window')
  const out: OpeningSpec = { kind: s.kind }
  if (s.operation !== undefined) {
    if (typeof s.operation !== 'string' || s.operation.length > 20) fail(`${at}.operation`, 'must be a short string')
    out.operation = s.operation
  }
  if (s.leaf !== undefined) {
    if (!(LEAVES as readonly unknown[]).includes(s.leaf)) fail(`${at}.leaf`, `must be ${LEAVES.join(', ')}`)
    out.leaf = s.leaf as OpeningSpec['leaf']
  }
  if (s.sill !== undefined) out.sill = int(s.sill, `${at}.sill`, 0, 20_000)
  if (s.head !== undefined) out.head = int(s.head, `${at}.head`, 1, 20_000)
  if (s.frame !== undefined) out.frame = obj(s.frame, `${at}.frame`) as OpeningSpec['frame']
  if (s.coverings !== undefined) out.coverings = arr(s.coverings, `${at}.coverings`, 6) as Covering[]
  return out
}

export function validateHousePlan(raw: unknown): HousePlan {
  const p = obj(raw, 'plan')
  if (p.version !== HOUSE_V1) fail('plan.version', `must be ${HOUSE_V1}`)
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
      if (kind !== 'room' && kind !== 'outdoor' && kind !== 'paved' && kind !== 'pool')
        fail(`${rp}.kind`, 'must be room, outdoor, paved or pool')
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
      if (o.type !== 'door' && o.type !== 'window' && o.type !== 'open' && o.type !== 'slider')
        fail(`${op}.type`, 'must be door, window, open or slider')
      if (o.axis !== 'h' && o.axis !== 'v') fail(`${op}.axis`, 'must be h or v')
      if (o.glass !== undefined && (o.type !== 'door' || typeof o.glass !== 'boolean'))
        fail(`${op}.glass`, 'only a door can be glass, and it is true or false')
      if (o.type === 'window' || o.type === 'slider' || (o.type === 'door' && o.glass === true)) windows.add(oid)
      // On the wall's line in whole cells, along it in half cells.
      const x = (o.axis === 'h' ? half : int)(o.x, `${op}.x`, 0, plot.w)
      const y = (o.axis === 'v' ? half : int)(o.y, `${op}.y`, 0, plot.h)
      const len = half(o.len, `${op}.len`, 1, o.axis === 'h' ? plot.w - x : plot.h - y)
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
      if (o.glass === true) out.glass = true
      if (o.spec !== undefined && o.type !== 'open') out.spec = openingSpec(o.spec, `${op}.spec`)
      return out
    })

    const radiators =
      f.radiators === undefined
        ? []
        : arr(f.radiators, `${fp}.radiators`, LIMITS.radiators).map((rRaw, ri): HouseRadiator => {
            const rp = `${fp}.radiators[${ri}]`
            const r = obj(rRaw, rp)
            const rid = id(r.id, `${rp}.id`)
            if (openingIds.has(rid)) fail(`${rp}.id`, `'${rid}' is used twice`)
            openingIds.add(rid)
            if (r.axis !== 'h' && r.axis !== 'v') fail(`${rp}.axis`, 'must be h or v')
            const x = (r.axis === 'h' ? half : int)(r.x, `${rp}.x`, 0, plot.w)
            const y = (r.axis === 'v' ? half : int)(r.y, `${rp}.y`, 0, plot.h)
            const len = half(r.len, `${rp}.len`, 1, r.axis === 'h' ? plot.w - x : plot.h - y)
            const sides = r.axis === 'h' ? ['up', 'down'] : ['left', 'right']
            if (typeof r.side !== 'string' || !sides.includes(r.side))
              fail(`${rp}.side`, `must be ${sides.join(' or ')}`)
            return { id: rid, x, y, axis: r.axis, len, side: r.side as HouseRadiator['side'] }
          })

    const furnitureIds = new Set<string>()
    const furniture =
      f.furniture === undefined
        ? []
        : arr(f.furniture, `${fp}.furniture`, LIMITS.furniture).map((uRaw, ui): HouseFurniture => {
            const up = `${fp}.furniture[${ui}]`
            const u = obj(uRaw, up)
            const uid = id(u.id, `${up}.id`)
            if (furnitureIds.has(uid)) fail(`${up}.id`, `'${uid}' is used twice`)
            furnitureIds.add(uid)
            if (!(FURNITURE_KINDS as readonly unknown[]).includes(u.kind))
              fail(`${up}.kind`, `must be one of ${FURNITURE_KINDS.join(', ')}`)
            const x = half(u.x, `${up}.x`, 0, plot.w - 0.5)
            const y = half(u.y, `${up}.y`, 0, plot.h - 0.5)
            const out: HouseFurniture = {
              id: uid,
              kind: u.kind as HouseFurniture['kind'],
              x,
              y,
              w: half(u.w, `${up}.w`, 0.5, plot.w - x),
              d: half(u.d, `${up}.d`, 0.5, plot.h - y),
            }
            if (u.height !== undefined) {
              if (typeof u.height !== 'number' || !Number.isFinite(u.height) || u.height < 0.1 || u.height > 3)
                fail(`${up}.height`, 'must be from 0.1 to 3 metres')
              out.height = Math.round(u.height * 100) / 100
            }
            if (u.back !== undefined) {
              if (u.back !== 'up' && u.back !== 'down' && u.back !== 'left' && u.back !== 'right')
                fail(`${up}.back`, 'must be up, down, left or right')
              out.back = u.back
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
        if (!windows.has(oid))
          fail(`${pp}.opening`, `'${oid}' is not a window, sliding door or glass door on this floor`)
        out.opening = oid
        if (pl.covering !== undefined) out.covering = id(pl.covering, `${pp}.covering`)
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

    const floor: HouseFloor = { id: fid, name: name(f.name, `${fp}.name`), level, rooms, openings, placements }
    if (radiators.length) floor.radiators = radiators
    if (furniture.length) floor.furniture = furniture
    return floor
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

  return { version: HOUSE_V1, grid: HOUSE_GRID, plot, floors }
}

// ─── Rooms of devices ───────────────────────────────────────────────────────

const area = (r: HouseRoom) =>
  r.outline ? Math.abs(loopArea(r.outline)) : roomRects(r).reduce((a, q) => a + q.w * q.h, 0)

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
  if (r.outline) return inside([x, y], r.outline) || onEdge([x, y], r.outline)
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
export function roomsByRef(stored: HousePlan | Plan | null): Map<string, DeviceRoom> {
  const out = new Map<string, DeviceRoom>()
  if (!stored) return out
  // Version 2 is read through its version 1 view until rooms of any shape need more.
  const plan = stored.version === HOUSE_V1 ? stored : toV1(stored)
  for (const f of plan.floors) {
    const floor = { id: f.id, name: f.name, level: f.level }
    for (const pl of f.placements) {
      let x = pl.x
      let y = pl.y
      const opening = pl.opening ? f.openings.find((o) => o.id === pl.opening) : undefined
      if (opening?.to) {
        // In a slanted wall: halfway to its far end.
        x = (opening.x + opening.to[0]) / 2
        y = (opening.y + opening.to[1]) / 2
      } else if (opening) {
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
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StoredHouse> & { plan?: unknown }
      const rev = typeof raw.rev === 'number' && raw.rev >= 0 ? raw.rev : 0
      const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null
      const version = (raw.plan as { version?: unknown } | null | undefined)?.version
      if (raw.plan && version === HOUSE_V1) {
        // Converted once, with the version 1 file kept beside it the first
        // time, so going back to an older OpenBridge loses nothing.
        const { plan, dropped } = fromV1(validateHousePlan(raw.plan))
        const backup = `${this.path}.v1.json`
        if (!existsSync(backup)) copyFileSync(this.path, backup)
        this.state = { plan: validatePlan(plan), rev, updatedAt }
        this.save()
        log.info(`Converted the house plan to version 2. The version 1 file is kept as ${backup}.`)
        if (dropped.length) log.warn(`Left out openings that sat on no wall: ${dropped.join(', ')}`)
      } else {
        this.state = { plan: raw.plan ? validatePlan(raw.plan) : null, rev, updatedAt }
      }
      this.rooms = roomsByRef(this.state.plan)
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
    const previous = this.state
    const plan = raw === null ? null : this.accept(raw, previous.plan)
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

  /**
   * A plan of either version, as version 2. A version 1 plan comes from the
   * editor that still draws in cells (or a tab opened before the update), so
   * what it cannot say is kept from the plan it replaces.
   */
  private accept(raw: unknown, previous: Plan | null): Plan {
    const version = (raw as { version?: unknown } | null)?.version
    if (version === HOUSE_V1) return validatePlan(fromV1(validateHousePlan(raw), previous).plan)
    return validatePlan(raw)
  }

  /** The room a device is placed in, if it is on the plan. */
  roomOf(ref: string): DeviceRoom | null {
    return this.rooms.get(ref) ?? null
  }
}
