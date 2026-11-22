/**
 * The editor's Library: what can be put on the plan, as one list of items,
 * and the icon each one shows. Icons follow docs/design/house-icons.md. Where
 * that names a bespoke icon not drawn yet, the item's tool icon stands in.
 */
import type { HouseFurnitureKind } from '@/api'
import type { LiveKind } from './live'
import type { OpeningPreset } from './openings'

export type LibraryItem =
  | { type: 'opening'; preset: OpeningPreset }
  | { type: 'furniture'; kind: HouseFurnitureKind }
  | { type: 'device'; ref: string }

export const libraryKey = (i: LibraryItem) =>
  i.type === 'opening' ? `opening:${i.preset.id}` : i.type === 'furniture' ? `furniture:${i.kind}` : `device:${i.ref}`

export const FURNITURE_ICON: Record<HouseFurnitureKind, string> = {
  sofa: 'couch',
  table: 'armchair',
  cabinet: 'armchair',
  shelves: 'armchair',
  rug: 'rug',
  island: 'armchair',
  bed: 'bed',
  bath: 'bathtub',
  shower: 'shower',
  toilet: 'toilet',
  basin: 'armchair',
  lounger: 'armchair',
  parasol: 'armchair',
  planter: 'potted-plant',
  pergola: 'armchair',
}

export const DEVICE_ICON: Record<LiveKind, string> = {
  light: 'lightbulb',
  switch: 'devices',
  heating: 'thermometer-hot',
  dehumidifier: 'drop-half-bottom',
  meter: 'gauge',
  gate: 'devices',
  shutter: 'devices',
  sensor: 'thermometer-simple',
  camera: 'security-camera',
  other: 'devices',
}

export function presetIcon(p: OpeningPreset): string {
  if (p.kind === 'window') return 'app-window'
  if (p.spec.operation === 'sliding' || p.spec.operation === 'lift-slide') return 'columns'
  return p.spec.leaf && p.spec.leaf !== 'solid' ? 'door' : 'door-open'
}
