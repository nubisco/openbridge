/**
 * Check a version 2 plan from the outside world and return a clean copy.
 * Unknown fields are dropped, not refused, so an older client cannot fail on
 * a field a newer one added, and nothing unexpected is stored.
 */

import {
  COVERING_KINDS,
  DEVICE_LOOKS,
  DOOR_OPERATIONS,
  FRAME_MATERIALS,
  FURNITURE_KINDS,
  LEAVES,
  LIGHT_MOUNTS,
  PLAN_VERSION,
  WINDOW_OPERATIONS,
  isGlazed,
  type Covering,
  type Dimension,
  type Furniture,
  type Opening,
  type Placement,
  type Plan,
  type Point,
  type Radiator,
  type Space,
  type Storey,
  type Wall,
} from './v2.js'

export class PlanError extends Error {}

const LIMITS = {
  storeys: 12,
  walls: 1500,
  spaces: 300,
  points: 400,
  openings: 600,
  coverings: 6,
  placements: 500,
  radiators: 300,
  furniture: 400,
  dimensions: 200,
  /** 200 m, in millimetres. */
  site: 200_000,
  name: 80,
}
const ID = /^[A-Za-z0-9_-]{1,64}$/
const REF = /^\S{1,220}$/
const COLOUR = /^#[0-9a-fA-F]{6}$/

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
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max)
    fail(path, `must be a whole number from ${min} to ${max}`)
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

function oneOf<T extends string>(v: unknown, list: readonly T[], path: string): T {
  if (!(list as readonly unknown[]).includes(v)) fail(path, `must be one of ${list.join(', ')}`)
  return v as T
}

function unique(seen: Set<string>, v: string, path: string): void {
  if (seen.has(v)) fail(path, `'${v}' is used twice`)
  seen.add(v)
}

export function validatePlan(raw: unknown): Plan {
  const p = obj(raw, 'plan')
  if (p.version !== PLAN_VERSION) fail('plan.version', `must be ${PLAN_VERSION}`)
  if (p.unit !== 'mm') fail('plan.unit', 'must be mm')
  const siteRaw = obj(p.site, 'plan.site')
  const site = {
    w: int(siteRaw.w, 'plan.site.w', 1, LIMITS.site),
    h: int(siteRaw.h, 'plan.site.h', 1, LIMITS.site),
  }
  const snap = int(p.snap, 'plan.snap', 1, 10_000)
  // Anything may stand a little outside the plot (a wall's thickness), never far.
  const reach = 10_000
  const point = (v: unknown, path: string): Point => {
    const a = arr(v, path, 2)
    if (a.length !== 2) fail(path, 'must be [x, y]')
    return [int(a[0], `${path}[0]`, -reach, site.w + reach), int(a[1], `${path}[1]`, -reach, site.h + reach)]
  }
  const loop = (v: unknown, path: string): Point[] => {
    const pts = arr(v, path, LIMITS.points).map((q, i) => point(q, `${path}[${i}]`))
    if (pts.length < 3) fail(path, 'needs at least 3 corners')
    return pts
  }

  const storeyIds = new Set<string>()
  const levels = new Set<number>()
  const spaceIds = new Set<string>()
  const refs = new Set<string>()

  const storeys = arr(p.storeys, 'plan.storeys', LIMITS.storeys).map((sRaw, si): Storey => {
    const sp = `plan.storeys[${si}]`
    const s = obj(sRaw, sp)
    const sid = id(s.id, `${sp}.id`)
    unique(storeyIds, sid, `${sp}.id`)
    const level = int(s.level, `${sp}.level`, -5, 20)
    if (levels.has(level)) fail(`${sp}.level`, `two storeys cannot share level ${level}`)
    levels.add(level)
    const elevation = int(s.elevation, `${sp}.elevation`, -50_000, 200_000)
    const height = int(s.height, `${sp}.height`, 1000, 20_000)

    const elementIds = new Set<string>()
    const walls = arr(s.walls, `${sp}.walls`, LIMITS.walls).map((wRaw, wi): Wall => {
      const wp = `${sp}.walls[${wi}]`
      const w = obj(wRaw, wp)
      const wid = id(w.id, `${wp}.id`)
      unique(elementIds, wid, `${wp}.id`)
      const a = point(w.a, `${wp}.a`)
      const b = point(w.b, `${wp}.b`)
      if (a[0] === b[0] && a[1] === b[1]) fail(wp, 'its ends are the same point')
      return {
        id: wid,
        a,
        b,
        thickness: int(w.thickness, `${wp}.thickness`, 10, 2000),
        height: int(w.height, `${wp}.height`, 100, 20_000),
      }
    })
    const wallById = new Map(walls.map((w) => [w.id, w]))

    const spaces = arr(s.spaces, `${sp}.spaces`, LIMITS.spaces).map((rRaw, ri): Space => {
      const rp = `${sp}.spaces[${ri}]`
      const r = obj(rRaw, rp)
      const rid = id(r.id, `${rp}.id`)
      // Spaces are the bridge's rooms, so an id names one in the whole house.
      unique(spaceIds, rid, `${rp}.id`)
      const out: Space = {
        id: rid,
        name: name(r.name, `${rp}.name`),
        kind: oneOf(r.kind, ['room', 'outdoor', 'paved', 'pool'] as const, `${rp}.kind`),
        outline: loop(r.outline, `${rp}.outline`),
      }
      if (r.holes !== undefined) {
        const holes = arr(r.holes, `${rp}.holes`, 20).map((h, hi) => loop(h, `${rp}.holes[${hi}]`))
        if (holes.length) out.holes = holes
      }
      if (r.rects !== undefined) {
        const rects = arr(r.rects, `${rp}.rects`, 9).map((qRaw, qi) => {
          const qp = `${rp}.rects[${qi}]`
          const q = obj(qRaw, qp)
          return {
            x: int(q.x, `${qp}.x`, -reach, site.w + reach),
            y: int(q.y, `${qp}.y`, -reach, site.h + reach),
            w: int(q.w, `${qp}.w`, 1, site.w + reach),
            h: int(q.h, `${qp}.h`, 1, site.h + reach),
          }
        })
        if (rects.length) out.rects = rects
      }
      return out
    })

    const glazed = new Map<string, Set<string>>()
    const openings = arr(s.openings, `${sp}.openings`, LIMITS.openings).map((oRaw, oi): Opening => {
      const op = `${sp}.openings[${oi}]`
      const o = obj(oRaw, op)
      const oid = id(o.id, `${op}.id`)
      unique(elementIds, oid, `${op}.id`)
      const wall = wallById.get(id(o.wall, `${op}.wall`))
      if (!wall) fail(`${op}.wall`, `no wall '${o.wall}' on this storey`)
      const length = Math.round(Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]))
      const at = int(o.at, `${op}.at`, 0, length - 1)
      const width = int(o.width, `${op}.width`, 1, length - at)
      const base = { id: oid, wall: wall.id, at, width }
      const kind = oneOf(o.kind, ['door', 'window', 'gap'] as const, `${op}.kind`)
      if (kind === 'gap') return { ...base, kind }
      const sill = int(o.sill, `${op}.sill`, 0, 20_000)
      const head = int(o.head, `${op}.head`, sill + 1, 20_000)
      const glass =
        kind === 'door'
          ? {
              kind,
              operation: oneOf(o.operation, DOOR_OPERATIONS, `${op}.operation`),
              leaf: oneOf(o.leaf, LEAVES, `${op}.leaf`),
            }
          : { kind, operation: oneOf(o.operation, WINDOW_OPERATIONS, `${op}.operation`) }
      const out = { ...base, ...glass, sill, head } as Opening & { kind: 'door' | 'window' }
      if (o.hinge !== undefined) out.hinge = oneOf(o.hinge, ['start', 'end'] as const, `${op}.hinge`)
      if (o.opens !== undefined) out.opens = oneOf(o.opens, ['left', 'right'] as const, `${op}.opens`)
      if (o.frame !== undefined) {
        const f = obj(o.frame, `${op}.frame`)
        const frame: NonNullable<typeof out.frame> = {}
        if (f.material !== undefined) frame.material = oneOf(f.material, FRAME_MATERIALS, `${op}.frame.material`)
        if (f.colour !== undefined) {
          if (typeof f.colour !== 'string' || !COLOUR.test(f.colour)) fail(`${op}.frame.colour`, 'must be #rrggbb')
          frame.colour = f.colour.toLowerCase()
        }
        if (frame.material || frame.colour) out.frame = frame
      }
      if (o.coverings !== undefined) {
        const list = arr(o.coverings, `${op}.coverings`, LIMITS.coverings)
        if (list.length && !isGlazed(out)) fail(`${op}.coverings`, 'only glass can be covered')
        const ids = new Set<string>()
        const coverings = list.map((cRaw, ci): Covering => {
          const cp = `${op}.coverings[${ci}]`
          const c = obj(cRaw, cp)
          const cid = id(c.id, `${cp}.id`)
          unique(ids, cid, `${cp}.id`)
          return {
            id: cid,
            kind: oneOf(c.kind, COVERING_KINDS, `${cp}.kind`),
            side: oneOf(c.side, ['inside', 'outside'] as const, `${cp}.side`),
          }
        })
        if (coverings.length) out.coverings = coverings
      }
      if (isGlazed(out)) glazed.set(oid, new Set((out.coverings ?? []).map((c) => c.id)))
      return out
    })
    const openingIds = new Set(openings.map((o) => o.id))

    const radiators = arr(s.radiators, `${sp}.radiators`, LIMITS.radiators).map((rRaw, ri): Radiator => {
      const rp = `${sp}.radiators[${ri}]`
      const r = obj(rRaw, rp)
      const rid = id(r.id, `${rp}.id`)
      unique(elementIds, rid, `${rp}.id`)
      const a = point(r.a, `${rp}.a`)
      const b = point(r.b, `${rp}.b`)
      if (a[0] === b[0] && a[1] === b[1]) fail(rp, 'its ends are the same point')
      return { id: rid, a, b, side: oneOf(r.side, ['left', 'right'] as const, `${rp}.side`) }
    })

    const furnitureIds = new Set<string>()
    const furniture = arr(s.furniture, `${sp}.furniture`, LIMITS.furniture).map((uRaw, ui): Furniture => {
      const up = `${sp}.furniture[${ui}]`
      const u = obj(uRaw, up)
      const uid = id(u.id, `${up}.id`)
      unique(furnitureIds, uid, `${up}.id`)
      const x = int(u.x, `${up}.x`, 0, site.w - 1)
      const y = int(u.y, `${up}.y`, 0, site.h - 1)
      const out: Furniture = {
        id: uid,
        kind: oneOf(u.kind, FURNITURE_KINDS, `${up}.kind`),
        x,
        y,
        w: int(u.w, `${up}.w`, 1, site.w - x),
        d: int(u.d, `${up}.d`, 1, site.h - y),
      }
      if (u.height !== undefined) out.height = int(u.height, `${up}.height`, 100, 3000)
      if (u.back !== undefined) out.back = oneOf(u.back, ['up', 'down', 'left', 'right'] as const, `${up}.back`)
      return out
    })

    const placements = arr(s.placements, `${sp}.placements`, LIMITS.placements).map((plRaw, pi): Placement => {
      const pp = `${sp}.placements[${pi}]`
      const pl = obj(plRaw, pp)
      if (typeof pl.ref !== 'string' || !REF.test(pl.ref)) fail(`${pp}.ref`, 'must be a device reference')
      // One device is in one place. Two placements would give it two rooms.
      unique(refs, pl.ref, `${pp}.ref`)
      const out: Placement = { ref: pl.ref, x: int(pl.x, `${pp}.x`, 0, site.w), y: int(pl.y, `${pp}.y`, 0, site.h) }
      if (pl.host !== undefined) {
        const h = obj(pl.host, `${pp}.host`)
        const oid = id(h.opening, `${pp}.host.opening`)
        if (!openingIds.has(oid)) fail(`${pp}.host.opening`, `no opening '${oid}' on this storey`)
        out.host = { opening: oid }
        if (h.covering !== undefined) {
          const cid = id(h.covering, `${pp}.host.covering`)
          if (!glazed.get(oid)?.has(cid)) fail(`${pp}.host.covering`, `'${oid}' has no covering '${cid}'`)
          out.host.covering = cid
        }
      }
      if (pl.color !== undefined) {
        if (typeof pl.color !== 'string' || !COLOUR.test(pl.color)) fail(`${pp}.color`, 'must be #rrggbb')
        out.color = pl.color.toLowerCase()
      }
      if (pl.length !== undefined) out.length = int(pl.length, `${pp}.length`, 1, 20_000)
      if (pl.axis !== undefined) out.axis = oneOf(pl.axis, ['h', 'v'] as const, `${pp}.axis`)
      if (pl.mount !== undefined) out.mount = oneOf(pl.mount, LIGHT_MOUNTS, `${pp}.mount`)
      if (pl.look !== undefined) out.look = oneOf(pl.look, DEVICE_LOOKS, `${pp}.look`)
      if (pl.circuitRooms !== undefined)
        out.circuitRooms = arr(pl.circuitRooms, `${pp}.circuitRooms`, 50).map((c, ci) =>
          id(c, `${pp}.circuitRooms[${ci}]`),
        )
      return out
    })

    const dimensionIds = new Set<string>()
    const dimensions =
      s.dimensions === undefined
        ? []
        : arr(s.dimensions, `${sp}.dimensions`, LIMITS.dimensions).map((dRaw, di): Dimension => {
            const dp = `${sp}.dimensions[${di}]`
            const d = obj(dRaw, dp)
            const did = id(d.id, `${dp}.id`)
            unique(dimensionIds, did, `${dp}.id`)
            const a = point(d.a, `${dp}.a`)
            const b = point(d.b, `${dp}.b`)
            if (a[0] === b[0] && a[1] === b[1]) fail(dp, 'its ends are the same point')
            return { id: did, a, b }
          })

    return {
      id: sid,
      name: name(s.name, `${sp}.name`),
      level,
      elevation,
      height,
      walls,
      spaces,
      openings,
      radiators,
      furniture,
      placements,
      ...(dimensions.length ? { dimensions } : {}),
    }
  })

  // Checked once every storey is read: one heat pump feeds rooms upstairs too.
  storeys.forEach((s, si) =>
    s.placements.forEach((pl, pi) =>
      pl.circuitRooms?.forEach((rid, ci) => {
        if (!spaceIds.has(rid)) fail(`plan.storeys[${si}].placements[${pi}].circuitRooms[${ci}]`, `no space '${rid}'`)
      }),
    ),
  )

  return { version: PLAN_VERSION, unit: 'mm', site, snap, storeys }
}
