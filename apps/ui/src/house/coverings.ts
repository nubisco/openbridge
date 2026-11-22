/**
 * Where the coverings on a door or window are drawn, and how far each is
 * closed. Shared by the house views (scene.ts) and the editor's blueprint
 * (editor.ts), so the two never disagree about which side a curtain hangs on.
 *
 * A covering a device drives is drawn as the device reports it. One driven by
 * hand has no state the bridge can know, so it is drawn open: curtains drawn
 * back to the sides, a blind or shutter rolled up into its box, an awning
 * folded against the wall.
 */
import type { HouseFloor, HouseOpening } from '@/api'
import type { Covering } from '@house-model/v2'
import { clamp, roomAt, type Point } from './geometry'
import type { LiveDevice } from './live'
import { coveringsOf, driverOf } from './openings'

export interface CoveringDraw {
  covering: Covering
  /** Unit vector, in plan cells, from the wall to the side the covering is on. */
  normal: Point
  /** The device that drives it, if one does. */
  device?: LiveDevice
  /** 0 open, 1 fully closed (or, for an awning, fully out). */
  closed: number
}

/** The kinds that roll down from a box over the opening. */
export const ROLLS = new Set<Covering['kind']>(['shutter', 'external-blind', 'blind'])

/**
 * Which way is inside: towards the walled room. A wall between two rooms, or
 * with none on either side, takes the side with the higher x or y.
 */
export function insideNormal(floor: HouseFloor, o: HouseOpening): Point {
  const mx = o.x + (o.axis === 'h' ? o.len / 2 : 0)
  const my = o.y + (o.axis === 'v' ? o.len / 2 : 0)
  const n: Point = o.axis === 'h' ? [0, 1] : [1, 0]
  const walled = (k: number) => roomAt(floor, mx + n[0] * k * 0.25, my + n[1] * k * 0.25)?.kind === 'room'
  return walled(-1) && !walled(1) ? [-n[0], -n[1]] : n
}

/** Every covering on an opening, with its side and state, in the order the plan lists them. */
export function coveringDraws(floor: HouseFloor, o: HouseOpening, devices: Map<string, LiveDevice>): CoveringDraw[] {
  const inside = insideNormal(floor, o)
  const outside: Point = [-inside[0], -inside[1]]
  const list = coveringsOf(o)
  // A device on an opening whose coverings were never listed drives a shutter.
  const attached = floor.placements.filter((p) => p.opening === o.id)
  const all: Covering[] =
    list.length || !attached.length ? list : [{ id: '', kind: 'shutter', side: 'outside' } as Covering]
  return all.map((c) => {
    const p = c.id ? driverOf(floor, o, c.id) : attached[0]
    const device = p ? devices.get(p.ref) : undefined
    const closed = device ? 1 - clamp(device.position ?? 100, 0, 100) / 100 : 0
    return { covering: c, normal: c.side === 'inside' ? inside : outside, device, closed }
  })
}
