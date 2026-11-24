/**
 * Doors and windows: one door and one window, with the variants plan
 * version 2 records (docs/design/house-bim.md), and the presets the editor
 * offers so nobody fills six fields to place a patio door.
 *
 * The editor still draws in cells. A door or window carries its detail in
 * `spec`, in millimetres as version 2 has it, and the daemon takes it from
 * there on save. `type` and `glass` stay what the cells say (a window, a
 * sliding door, a glass door), so the plan and the 3D view draw it as before.
 */

import type { OpeningSpec } from '@nubisco/bim/v1'
import { COVERING_KINDS, DEFAULTS, DOOR_OPERATIONS, WINDOW_OPERATIONS, type Covering } from '@nubisco/bim/v2'
import type { HouseFloor, HouseOpening, HousePlacement } from '@/api'
import { CELLS_PER_M } from './geometry'

export type { OpeningSpec }
export type CoveringKind = (typeof COVERING_KINDS)[number]

export const DOOR_OPERATION_LABEL: Record<(typeof DOOR_OPERATIONS)[number], string> = {
  swing: 'Swing',
  'double-swing': 'Double swing',
  sliding: 'Sliding',
  'lift-slide': 'Lift and slide',
  folding: 'Folding',
  pocket: 'Pocket',
}

export const WINDOW_OPERATION_LABEL: Record<(typeof WINDOW_OPERATIONS)[number], string> = {
  fixed: 'Fixed, does not open',
  casement: 'Casement',
  'tilt-turn': 'Tilt and turn',
  sliding: 'Sliding',
  awning: 'Top hung',
  hung: 'Sash',
}

export const LEAF_LABEL = { solid: 'Solid', glazed: 'Glazed', 'part-glazed': 'Part glazed' } as const

export const FRAME_LABEL = { aluminium: 'Aluminium', pvc: 'PVC', wood: 'Wood', steel: 'Steel' } as const

export const FRAME_COLOURS = [
  { label: 'White', value: '#ffffff' },
  { label: 'Brown', value: '#6b4a2b' },
  { label: 'Anthracite', value: '#383e42' },
  { label: 'Natural wood', value: '#b98a5a' },
  { label: 'Black', value: '#1d1d1d' },
]

export const COVERING_LABEL: Record<CoveringKind, string> = {
  shutter: 'Roller shutter',
  'external-blind': 'External blind',
  awning: 'Awning',
  curtain: 'Curtains',
  blind: 'Interior blind',
}

/** Where a covering usually is. */
export const COVERING_SIDE: Record<CoveringKind, 'inside' | 'outside'> = {
  shutter: 'outside',
  'external-blind': 'outside',
  awning: 'outside',
  curtain: 'inside',
  blind: 'inside',
}

const slides = (op: string | undefined) => op === 'sliding' || op === 'lift-slide'

export interface OpeningPreset {
  id: string
  label: string
  kind: 'door' | 'window'
  /** Width in metres. */
  width: number
  spec: OpeningSpec
}

/** What the Door tool can put down. The first is the default. */
export const DOOR_PRESETS: OpeningPreset[] = [
  {
    id: 'door-wood-white',
    label: 'Wooden door, white',
    kind: 'door',
    width: 1,
    spec: { kind: 'door', operation: 'swing', leaf: 'solid', frame: { material: 'wood', colour: '#ffffff' } },
  },
  {
    id: 'door-wood-brown',
    label: 'Wooden door, brown',
    kind: 'door',
    width: 1,
    spec: { kind: 'door', operation: 'swing', leaf: 'solid', frame: { material: 'wood', colour: '#6b4a2b' } },
  },
  {
    id: 'door-glazed',
    label: 'Glazed swing door',
    kind: 'door',
    width: 1,
    spec: { kind: 'door', operation: 'swing', leaf: 'glazed', frame: { material: 'aluminium' } },
  },
  {
    id: 'door-sliding',
    label: 'Sliding glass door',
    kind: 'door',
    width: 2,
    spec: { kind: 'door', operation: 'sliding', leaf: 'glazed', frame: { material: 'aluminium' } },
  },
]

/** What the Window tool can put down. The first is the default. */
export const WINDOW_PRESETS: OpeningPreset[] = [
  {
    id: 'window-sliding',
    label: 'Sliding window',
    kind: 'window',
    width: 1.5,
    spec: { kind: 'window', operation: 'sliding', frame: { material: 'aluminium' } },
  },
  {
    id: 'window-full',
    label: 'Full height fixed window',
    kind: 'window',
    width: 1,
    spec: { kind: 'window', operation: 'fixed', sill: 0, head: DEFAULTS.doorHead, frame: { material: 'aluminium' } },
  },
  {
    id: 'window-casement',
    label: 'Casement window',
    kind: 'window',
    width: 1,
    spec: { kind: 'window', operation: 'casement', frame: { material: 'aluminium' } },
  },
]

export const PRESETS = [...DOOR_PRESETS, ...WINDOW_PRESETS]

/** The detail of a door or window, with what is unset filled in as the daemon would. */
export function specOf(
  o: HouseOpening,
): Required<Pick<OpeningSpec, 'kind' | 'operation' | 'sill' | 'head'>> & OpeningSpec {
  const kind = o.type === 'window' ? 'window' : 'door'
  const s = o.spec?.kind === kind ? o.spec : undefined
  const glass = o.type === 'slider' || o.glass === true
  if (kind === 'window')
    return {
      ...s,
      kind,
      operation: WINDOW_OPERATIONS.find((x) => x === s?.operation) ?? 'casement',
      sill: s?.sill ?? DEFAULTS.windowSill,
      head: s?.head ?? DEFAULTS.windowHead,
    }
  const op = DOOR_OPERATIONS.find((x) => x === s?.operation && slides(x) === (o.type === 'slider'))
  return {
    ...s,
    kind,
    operation: op ?? (o.type === 'slider' ? 'sliding' : 'swing'),
    leaf: s?.leaf !== undefined && (s.leaf !== 'solid') === glass ? s.leaf : glass ? 'glazed' : 'solid',
    sill: s?.sill ?? 0,
    head: s?.head ?? DEFAULTS.doorHead,
  }
}

/** Write the whole detail onto the opening, so the panel can edit it in place. */
export function ensureSpec(o: HouseOpening): OpeningSpec | null {
  if (o.type === 'open') return null
  const full = specOf(o)
  // Frame and coverings carry over from a door turned window and back.
  if (o.spec?.frame) full.frame = o.spec.frame
  if (o.spec?.coverings) full.coverings = o.spec.coverings
  o.spec = full
  return full
}

/** Whether glass is part of it, so it can carry coverings. */
export function isGlazed(o: HouseOpening): boolean {
  return o.type === 'window' || o.type === 'slider' || (o.type === 'door' && o.glass === true)
}

/** Make it a door or a window, keeping its frame and coverings. */
export function setOpeningKind(o: HouseOpening, kind: 'door' | 'window' | 'open'): void {
  if (kind === 'open') {
    o.type = 'open'
    delete o.glass
    delete o.spec
    return
  }
  const keep = { frame: o.spec?.frame, coverings: o.spec?.coverings }
  o.type = kind
  delete o.glass
  delete o.spec
  const s = ensureSpec(o)!
  if (keep.frame) s.frame = keep.frame
  if (keep.coverings && isGlazed(o)) s.coverings = keep.coverings
}

/** Change how a door or window opens. A sliding door is drawn as one. */
export function setOperation(o: HouseOpening, op: string): void {
  const s = ensureSpec(o)
  if (!s) return
  if (s.kind === 'door') {
    const glass = o.type === 'slider' || o.glass === true
    o.type = slides(op) ? 'slider' : 'door'
    // A sliding door is glass in the cells, so a solid one becomes glazed.
    if (o.type === 'slider') {
      delete o.glass
      if (s.leaf === 'solid') s.leaf = 'glazed'
    } else if (glass) o.glass = true
  }
  s.operation = op
}

/** Solid, glazed or part glazed. Coverings come off a door made solid. */
export function setLeaf(o: HouseOpening, leaf: 'solid' | 'glazed' | 'part-glazed'): void {
  const s = ensureSpec(o)
  if (!s || s.kind !== 'door') return
  s.leaf = leaf
  if (o.type === 'slider') return
  if (leaf === 'solid') {
    delete o.glass
    delete s.coverings
  } else o.glass = true
}

/** Put a preset's detail on an opening. Its width is left as it is. */
export function applyPreset(o: HouseOpening, p: OpeningPreset): void {
  const coverings = o.spec?.coverings
  o.type = p.kind === 'window' ? 'window' : slides(p.spec.operation) ? 'slider' : 'door'
  delete o.glass
  if (o.type === 'door' && p.spec.leaf !== 'solid') o.glass = true
  o.spec = JSON.parse(JSON.stringify(p.spec)) as OpeningSpec
  ensureSpec(o)
  if (coverings && isGlazed(o)) o.spec.coverings = coverings
}

/** The preset an opening matches, if it matches one. */
export function presetOf(o: HouseOpening): OpeningPreset | null {
  if (o.type === 'open') return null
  const s = specOf(o)
  return (
    PRESETS.find((p) => {
      const q = specOf({ ...o, type: p.kind === 'window' ? 'window' : o.type, spec: p.spec })
      return (
        p.kind === s.kind &&
        p.spec.operation === s.operation &&
        (q.leaf ?? null) === (s.leaf ?? null) &&
        q.sill === s.sill &&
        q.head === s.head &&
        (p.spec.frame?.material ?? null) === (s.frame?.material ?? null) &&
        (p.spec.frame?.colour ?? null) === (s.frame?.colour ?? null)
      )
    }) ?? null
  )
}

/** The name for an opening in a panel title: its preset, or what it is. */
export function openingName(o: HouseOpening): string {
  if (o.type === 'open') return 'Open wall'
  const p = presetOf(o)
  if (p) return p.label
  const s = specOf(o)
  if (s.kind === 'window') return `${WINDOW_OPERATION_LABEL[s.operation as keyof typeof WINDOW_OPERATION_LABEL]} window`
  const op = DOOR_OPERATION_LABEL[s.operation as keyof typeof DOOR_OPERATION_LABEL]
  return `${op} door${s.leaf !== 'solid' ? ', ' + LEAF_LABEL[s.leaf!].toLowerCase() : ''}`
}

/** Width in cells for a preset. */
export const presetCells = (p: OpeningPreset) => Math.round(p.width * CELLS_PER_M * 2) / 2

// ─── Coverings ──────────────────────────────────────────────────────────────

export function coveringsOf(o: HouseOpening): Covering[] {
  return isGlazed(o) ? (o.spec?.coverings ?? []) : []
}

export function addCovering(o: HouseOpening, kind: CoveringKind): Covering | null {
  const s = ensureSpec(o)
  if (!s || !isGlazed(o)) return null
  const list = (s.coverings ??= [])
  let n = list.length + 1
  while (list.some((c) => c.id === `c${n}`)) n++
  const c: Covering = { id: `c${n}`, kind, side: COVERING_SIDE[kind] }
  list.push(c)
  return c
}

/** Take a covering off, and free the device that drove it. */
export function removeCovering(floor: HouseFloor, o: HouseOpening, id: string): void {
  if (!o.spec?.coverings) return
  o.spec.coverings = o.spec.coverings.filter((c) => c.id !== id)
  for (const p of floor.placements) if (p.opening === o.id && p.covering === id) detach(p)
}

/** The placement driving a covering, if one does. */
export function driverOf(floor: HouseFloor, o: HouseOpening, id: string): HousePlacement | undefined {
  const on = floor.placements.filter((p) => p.opening === o.id)
  const named = on.find((p) => p.covering === id)
  if (named) return named
  // A device attached before coverings had names drives the first one nobody names.
  const free = coveringsOf(o).filter((c) => !on.some((p) => p.covering === c.id))
  const unnamed = on.filter((p) => !p.covering)
  const i = free.findIndex((c) => c.id === id)
  return i >= 0 ? unnamed[i] : undefined
}

/** A device stops driving whatever it drove, and stays where it is. */
export function detach(p: HousePlacement): void {
  delete p.opening
  delete p.covering
}

/**
 * Have a device drive a covering. It moves onto the opening, where it is
 * drawn from then on, and stops driving anything else.
 */
export function drive(floor: HouseFloor, o: HouseOpening, id: string, p: HousePlacement): void {
  const before = driverOf(floor, o, id)
  if (before && before !== p) detach(before)
  p.opening = o.id
  p.covering = id
  p.x = o.x + (o.axis === 'h' ? o.len / 2 : 0)
  p.y = o.y + (o.axis === 'v' ? o.len / 2 : 0)
}

/**
 * Name the covering a device just attached to an opening drives: one nobody
 * drives, a shutter first, or a new shutter. The daemon does the same for a
 * device attached without one.
 */
export function claimCovering(floor: HouseFloor, o: HouseOpening, p: HousePlacement): void {
  if (!isGlazed(o)) return
  const s = ensureSpec(o)!
  const list = (s.coverings ??= [])
  const driven = new Set(floor.placements.filter((x) => x !== p && x.opening === o.id).map((x) => x.covering))
  const free = list.filter((c) => !driven.has(c.id))
  const c = free.find((x) => x.kind === 'shutter') ?? free[0] ?? addCovering(o, 'shutter')!
  p.covering = c.id
}
