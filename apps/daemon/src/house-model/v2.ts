/**
 * Plan version 2: the house as a building model. See docs/design/house-bim.md.
 *
 * Every length is a whole number of millimetres. x grows to the right and y
 * grows down the plan, as drawn on screen, with (0, 0) at the plot's top left
 * corner. Walls are elements of their own, rooms are polygons, and doors and
 * windows are hosted by a wall.
 *
 * Pure types and helpers: no Node, no DOM, no OpenBridge devices beyond a
 * device reference string, so this can move to a package Keystone shares.
 */

export const PLAN_VERSION = 2

/** A point on the plan, in millimetres. */
export type Point = [number, number]

export interface Plan {
  version: typeof PLAN_VERSION
  unit: 'mm'
  /** The plot, the ground floor's ground. */
  site: { w: number; h: number }
  /** The editor's snapping step. A setting of the editor, not a limit of the data. */
  snap: number
  storeys: Storey[]
}

export interface Storey {
  id: string
  name: string
  /** 0 is the ground floor. Negative is a basement. */
  level: number
  /** Height of its floor above the ground floor's floor. */
  elevation: number
  /** Floor to floor height. */
  height: number
  walls: Wall[]
  spaces: Space[]
  openings: Opening[]
  radiators: Radiator[]
  furniture: Furniture[]
  placements: Placement[]
}

/**
 * A wall: a straight centre line from `a` to `b`, with a thickness spread
 * evenly either side of it. Its left side is the one on the left standing at
 * `a` looking at `b`, on the plan as drawn.
 */
export interface Wall {
  id: string
  a: Point
  b: Point
  thickness: number
  height: number
}

/** `paved` is hard ground with no walls: a terrace, a path, the deck round a pool. */
export type SpaceKind = 'room' | 'outdoor' | 'paved' | 'pool'

/** A room or an outdoor zone: a simple polygon, its corners in order. */
export interface Space {
  id: string
  name: string
  kind: SpaceKind
  /** Clockwise on the plan as drawn (y down). */
  outline: Point[]
  /** Courtyards and the like: areas inside the outline that are not part of it. */
  holes?: Point[][]
  /**
   * The rectangles the editor drew this shape as, main one first, while the
   * editor still draws rooms as rectangles. A hint for that editor only: the
   * outline is the shape, and a hint that no longer covers it is ignored.
   */
  rects?: Array<{ x: number; y: number; w: number; h: number }>
}

export const DOOR_OPERATIONS = ['swing', 'double-swing', 'sliding', 'lift-slide', 'folding', 'pocket'] as const
export const WINDOW_OPERATIONS = ['fixed', 'casement', 'tilt-turn', 'sliding', 'awning', 'hung'] as const
export type DoorOperation = (typeof DOOR_OPERATIONS)[number]
export type WindowOperation = (typeof WINDOW_OPERATIONS)[number]

export const LEAVES = ['solid', 'glazed', 'part-glazed'] as const
export const FRAME_MATERIALS = ['aluminium', 'pvc', 'wood', 'steel'] as const
export const COVERING_KINDS = ['shutter', 'external-blind', 'awning', 'curtain', 'blind'] as const

/** Something that covers glass. Motorised when a device placement is hosted by it. */
export interface Covering {
  id: string
  kind: (typeof COVERING_KINDS)[number]
  side: 'inside' | 'outside'
}

interface OpeningBase {
  id: string
  /** The wall it is in. */
  wall: string
  /** Distance from the wall's `a` end to the opening's near end, along the wall. */
  at: number
  width: number
}

/** A stretch of wall that is not there: two rooms that run into each other. */
export interface Gap extends OpeningBase {
  kind: 'gap'
}

interface Glazed {
  /** Height of the bottom of the opening above the storey's floor. */
  sill: number
  /** Height of its top above the storey's floor. */
  head: number
  frame?: { material?: (typeof FRAME_MATERIALS)[number]; colour?: string }
  /** Only on glass: a window, or a door with a glazed or part glazed leaf. */
  coverings?: Covering[]
  /** The end the leaf is hinged at, for kinds that swing: nearer the wall's `a` (`start`) or `b`. */
  hinge?: 'start' | 'end'
  /** The side of the wall it opens to, for kinds that swing, as for a wall's sides. */
  opens?: 'left' | 'right'
}

export interface Door extends OpeningBase, Glazed {
  kind: 'door'
  operation: DoorOperation
  leaf: (typeof LEAVES)[number]
}

export interface Window extends OpeningBase, Glazed {
  kind: 'window'
  operation: WindowOperation
}

export type Opening = Gap | Door | Window

/** Whether glass is part of an opening, so it can carry coverings. */
export function isGlazed(o: Opening): o is Door | Window {
  return o.kind === 'window' || (o.kind === 'door' && o.leaf !== 'solid')
}

/**
 * A radiator: a straight run from `a` to `b` along a wall face, hanging on
 * one side of that line (as for a wall's sides).
 */
export interface Radiator {
  id: string
  a: Point
  b: Point
  side: 'left' | 'right'
}

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

/** A piece of furniture: a rectangle on the floor, `w` along x and `d` along y. */
export interface Furniture {
  id: string
  kind: (typeof FURNITURE_KINDS)[number]
  x: number
  y: number
  w: number
  d: number
  height?: number
  back?: 'up' | 'down' | 'left' | 'right'
}

export const LIGHT_MOUNTS = ['ceiling', 'wall', 'floor', 'table', 'pool'] as const
export const DEVICE_LOOKS = ['outlet', 'tv', 'fridge', 'washer', 'dehumidifier', 'vacuum', 'mower', 'tap'] as const

/**
 * Where a device is. `ref` is opaque here (OpenBridge uses `device:<id>` and
 * `accessory:<uuid>`). A device that belongs to a building element (a shutter
 * motor to a covering, a lock to a door) names it in `host`.
 */
export interface Placement {
  ref: string
  x: number
  y: number
  host?: { opening: string; covering?: string }
  color?: string
  circuitRooms?: string[]
  /** A gate's width, centred on (x, y). */
  length?: number
  axis?: 'h' | 'v'
  mount?: (typeof LIGHT_MOUNTS)[number]
  look?: (typeof DEVICE_LOOKS)[number]
}

/** Defaults for what version 1 did not record. */
export const DEFAULTS = {
  storeyHeight: 2800,
  wallHeight: 2500,
  /** A wall with a room on one side only. */
  outerWall: 300,
  /** A wall between two rooms. */
  innerWall: 100,
  doorHead: 2100,
  windowSill: 900,
  windowHead: 2100,
} as const
