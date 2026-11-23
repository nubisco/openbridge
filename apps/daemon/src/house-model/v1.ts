/**
 * Plan version 1, as saved up to OpenBridge 1.28: grid cells of 0.5 m, rooms
 * as rectangles, walls implied by room edges. Kept so saved plans and older
 * tabs can still be read, and because the current editor and views still
 * draw from this shape (see convert.ts).
 *
 * Pure types and helpers: no Node, no DOM, so the UI imports this too.
 */

import type { Covering, FRAME_MATERIALS, LEAVES } from './v2.js'

export const HOUSE_V1 = 1
/** Metres per grid cell. */
export const HOUSE_GRID = 0.5

/** `paved` is hard ground with no walls: a terrace, a path, the deck round a pool. */
export type HouseRoomKind = 'room' | 'outdoor' | 'paved' | 'pool'

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
  /**
   * The room's corners in order, for a room drawn corner by corner: any
   * shape, slanted edges included. Then it is the shape, `x`, `y`, `w` and
   * `h` are the box around it, and there are no parts.
   */
  outline?: Array<[number, number]>
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

export const overlaps = (a: HouseRect, b: HouseRect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** Two rectangles that do not overlap but share at least one cell of edge. */
export const touches = (a: HouseRect, b: HouseRect) => {
  const alongX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const alongY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return (
    ((a.y + a.h === b.y || b.y + b.h === a.y) && alongX >= 1) ||
    ((a.x + a.w === b.x || b.x + b.w === a.x) && alongY >= 1)
  )
}

export interface HouseOpening {
  id: string
  /**
   * `open` is a stretch with no wall at all: two rooms that run into each
   * other, such as a kitchen open to the living room. `slider` is a sliding
   * glass door: glass to door height, and a shutter can sit on it like on a
   * window.
   */
  type: 'door' | 'window' | 'open' | 'slider'
  /**
   * Start of the opening, on a wall line. Along the wall it may sit on a half
   * cell (a quarter metre), so a door can be centred on a wall of any length.
   */
  x: number
  y: number
  /** `h` runs along x, `v` along y. */
  axis: 'h' | 'v'
  /** Length in cells, in half cells. */
  len: number
  /** A door's hinge: the end at the lower x or y (`start`), or the other one. Default `start`. */
  hinge?: 'start' | 'end'
  /**
   * The side a door swings into, as seen on the plan: `up` or `down` for a
   * door in a wall running along x, `left` or `right` along y. Default
   * `down` or `right`.
   */
  opens?: 'up' | 'down' | 'left' | 'right'
  /** A door with a glass leaf, such as a French door. Glass can carry coverings. */
  glass?: boolean
  /**
   * What cells cannot say about a door or window, carried as plan version 2
   * has it (lengths in millimetres), so the cell editor can set it. `kind`
   * is the element it was written for: a door turned into a window starts
   * from a window's defaults, keeping only its frame and coverings.
   */
  spec?: OpeningSpec
}

export interface OpeningSpec {
  kind: 'door' | 'window'
  /** One of the door or window operations of version 2. */
  operation?: string
  /** A door's leaf. Only refines `glass`: a door that is not glass is solid. */
  leaf?: (typeof LEAVES)[number]
  sill?: number
  head?: number
  frame?: { material?: (typeof FRAME_MATERIALS)[number]; colour?: string }
  /** Present, it is the whole list, so an empty list takes every covering off. */
  coverings?: Covering[]
}

/** How a light hangs: from the ceiling, on a wall, or as a floor or table lamp. */
export const LIGHT_MOUNTS = ['ceiling', 'wall', 'floor', 'table', 'pool'] as const
/**
 * What a device is drawn as. The bridge sees a smart plug or a relay, and the
 * person knows it is the fridge, so they say so on the plan.
 */
export const DEVICE_LOOKS = ['outlet', 'tv', 'fridge', 'washer', 'dehumidifier', 'vacuum', 'mower', 'tap'] as const

export interface HousePlacement {
  /** `device:<id>` for a native device, `accessory:<uuid>` for a HomeKit accessory. */
  ref: string
  x: number
  y: number
  /** A shutter or blind belongs to a window, and is drawn on it. */
  opening?: string
  /** The covering of that window it drives, when the editor chose one. */
  covering?: string
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

/**
 * A radiator on a wall. It sits on a wall line like a door or window (whole
 * cells across the wall, half cells along it), and hangs on one side of it,
 * named the way a door's swing is. It is plumbing, not a device: a heating
 * circuit serving its room runs through it.
 */
export interface HouseRadiator {
  id: string
  x: number
  y: number
  axis: 'h' | 'v'
  /** Width in cells, in half cells. */
  len: number
  /** The side of the wall it hangs on: `up` or `down` along x, `left` or `right` along y. */
  side: 'up' | 'down' | 'left' | 'right'
}

/** What a piece of furniture is. Drawn as plain shapes, so the plan never imposes a style. */
export const FURNITURE_KINDS = [
  'table',
  'cabinet',
  'island',
  'bed',
  'sofa',
  'shelves',
  'rug',
  'bath',
  'shower',
  'toilet',
  'basin',
  'lounger',
  'parasol',
  'planter',
  'pergola',
] as const

/**
 * A piece of furniture: a rectangle on the floor, in half cells (a quarter
 * metre), `w` along x and `d` along y. It is there to make the plan read as
 * the home, and so a lamp put on a table stands on it.
 */
export interface HouseFurniture {
  id: string
  kind: (typeof FURNITURE_KINDS)[number]
  x: number
  y: number
  w: number
  d: number
  /** Height in metres, when it is not the usual one for its kind. */
  height?: number
  /**
   * The side its back is on (a bed's head, a sofa's back), when the person
   * set it. Unset, it is the side nearest a wall.
   */
  back?: 'up' | 'down' | 'left' | 'right'
}

/**
 * What the editor set on a wall: its thickness and height, in millimetres.
 * The wall itself follows the room edges, so this is keyed by where it is:
 * the wall on that line that overlaps it most takes it.
 */
export interface HouseWallSpec {
  axis: 'h' | 'v'
  x: number
  y: number
  len: number
  thickness: number
  height: number
  /** For a slanted wall: it runs from (x, y) to here, and `axis` and `len` mean nothing. */
  to?: [number, number]
}

/**
 * A wall drawn with the Wall tool: one that does not follow a room edge (a
 * garden wall, a partition), from `a` to `b` in cells, at any angle. One
 * along x or y runs towards +x or +y, and can hold doors and windows.
 */
export interface HouseDrawnWall {
  id: string
  a: [number, number]
  b: [number, number]
  thickness: number
  height: number
}

export interface HouseFloor {
  id: string
  name: string
  /** 0 is the ground floor. Negative is a basement. */
  level: number
  rooms: HouseRoom[]
  openings: HouseOpening[]
  placements: HousePlacement[]
  /** Absent on a plan saved before radiators existed. */
  radiators?: HouseRadiator[]
  /** Absent on a plan saved before furniture existed. */
  furniture?: HouseFurniture[]
  /** Thickness and height of walls, from version 2 or as the editor set them. */
  walls?: HouseWallSpec[]
  /** Walls drawn on their own, not following a room. */
  drawnWalls?: HouseDrawnWall[]
}

export interface HousePlan {
  version: typeof HOUSE_V1
  grid: number
  /** The plot, in cells. The ground floor's ground. */
  plot: { w: number; h: number }
  floors: HouseFloor[]
}
