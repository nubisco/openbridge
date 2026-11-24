/**
 * The house as an IFC file, from the browser, and an IFC file read back as a drawing. The writer is the model's own
 * (`@house-model/ifc`), which knows nothing of OpenBridge's devices. What each
 * placed device is in IFC is decided here, from its kind and how it looks on
 * the plan.
 */
import type { HouseLook } from '@/api'
import { toIfc, type IfcDevice } from '@house-model/ifc'
import { adoptIds, fromIfc } from '@house-model/ifc-read'
import { toV1 } from '@house-model/convert'
import type { HousePlan as HousePlanV1 } from '@house-model/v1'
import type { Plan } from '@house-model/v2'
import type { LiveDevice } from './live'

/** What a plug or switch powers, as IFC sees it. */
const BY_LOOK: Record<HouseLook, Omit<IfcDevice, 'name'>> = {
  outlet: { ifcClass: 'IfcOutlet', predefined: 'POWEROUTLET' },
  tv: { ifcClass: 'IfcAudioVisualAppliance', predefined: 'DISPLAY' },
  fridge: { ifcClass: 'IfcElectricAppliance', predefined: 'REFRIGERATOR' },
  washer: { ifcClass: 'IfcElectricAppliance', predefined: 'WASHINGMACHINE' },
  dehumidifier: { ifcClass: 'IfcUnitaryEquipment', predefined: 'DEHUMIDIFIER' },
  vacuum: { ifcClass: 'IfcElectricAppliance', predefined: 'USERDEFINED', objectType: 'Robot vacuum' },
  mower: { ifcClass: 'IfcElectricAppliance', predefined: 'USERDEFINED', objectType: 'Lawn mower' },
  tap: { ifcClass: 'IfcActuator', predefined: 'USERDEFINED', objectType: 'Garden tap valve' },
}

export function ifcDevice(d: LiveDevice, look: HouseLook | undefined): IfcDevice {
  const name = d.name
  const shown = look ?? d.defaultLook
  if (shown && d.kind !== 'light' && d.kind !== 'shutter' && d.kind !== 'gate') return { name, ...BY_LOOK[shown] }
  switch (d.kind) {
    case 'light':
      return { name, ifcClass: 'IfcLightFixture', predefined: 'POINTSOURCE' }
    case 'switch':
      return { name, ifcClass: 'IfcSwitchingDevice', predefined: 'TOGGLESWITCH' }
    case 'heating':
      return { name, ifcClass: 'IfcUnitaryEquipment', predefined: 'USERDEFINED', objectType: 'Heating' }
    case 'dehumidifier':
      return { name, ifcClass: 'IfcUnitaryEquipment', predefined: 'DEHUMIDIFIER' }
    case 'meter':
      return { name, ifcClass: 'IfcFlowMeter', predefined: 'ENERGYMETER' }
    case 'gate':
      return { name, ifcClass: 'IfcActuator', predefined: 'USERDEFINED', objectType: 'Gate motor' }
    case 'shutter':
      return { name, ifcClass: 'IfcActuator', predefined: 'ELECTRICACTUATOR' }
    case 'sensor':
      return {
        name,
        ifcClass: 'IfcSensor',
        predefined:
          d.temperature !== undefined
            ? 'TEMPERATURESENSOR'
            : d.humidity !== undefined
              ? 'HUMIDITYSENSOR'
              : 'NOTDEFINED',
      }
    case 'camera':
      return { name, ifcClass: 'IfcAudioVisualAppliance', predefined: 'CAMERA' }
    default:
      return { name, ifcClass: 'IfcBuildingElementProxy', predefined: 'NOTDEFINED' }
  }
}

/** The IFC file for a plan, with every placed device the bridge knows. */
export function houseIfc(plan: Plan, devices: Map<string, LiveDevice>, name: string): string {
  const named: Record<string, IfcDevice> = {}
  for (const s of plan.storeys)
    for (const p of s.placements) {
      const d = devices.get(p.ref)
      if (d) named[p.ref] = ifcDevice(d, p.look)
    }
  const day = new Date().toISOString().slice(0, 10)
  return toIfc(plan, {
    name,
    fileName: `${fileStem(name)}-${day}.ifc`,
    application: 'OpenBridge',
    devices: named,
  })
}

export const fileStem = (name: string) =>
  name
    .normalize('NFKD')
    .replace(/[^\w-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'house'

/** Hand the file to the browser to save. */
export function downloadIfc(ifc: string, name: string) {
  const url = URL.createObjectURL(new Blob([ifc], { type: 'application/x-step' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `${fileStem(name)}-${new Date().toISOString().slice(0, 10)}.ifc`
  a.click()
  URL.revokeObjectURL(url)
}

export interface IfcRead {
  /** The drawing the file gives, with the devices that were on the plan put back. */
  plan: HousePlanV1
  snap: number
  /** One line on what the file holds, for the confirm step. */
  summary: string
  /** What was left out or moved, one line each. */
  notes: string[]
}

/**
 * Read an IFC file as the drawing to edit, in place of `current`. Floors and
 * rooms keep the ids they had where the file has the same level and name, so
 * heating circuits still name their rooms. Devices stay where they are on the
 * floor at the same level, since a building model does not know them. One on
 * a floor the file does not have goes back to "Not on the plan yet".
 */
export function readIfc(text: string, current: HousePlanV1): IfcRead {
  const { plan, notes } = fromIfc(text)
  adoptIds(plan, { storeys: current.floors.map((f) => ({ id: f.id, level: f.level, spaces: f.rooms })) })
  const view = toV1(plan)
  const rooms = new Set(view.floors.flatMap((f) => f.rooms.map((r) => r.id)))
  let dropped = 0
  for (const f of current.floors) {
    const to = view.floors.find((g) => g.level === f.level)
    if (!to) {
      dropped += f.placements.length
      continue
    }
    to.placements = f.placements.map((p) => {
      const q = { ...p, x: Math.min(p.x, view.plot.w), y: Math.min(p.y, view.plot.h) }
      // A device on a window keeps it only if the file has that window.
      if (q.opening && !to.openings.some((o) => o.id === q.opening)) {
        delete q.opening
        delete q.covering
      }
      if (q.circuitRooms) {
        q.circuitRooms = q.circuitRooms.filter((id) => rooms.has(id))
        if (!q.circuitRooms.length) delete q.circuitRooms
      }
      return q
    })
  }
  if (dropped)
    notes.push(
      `${dropped} device${dropped === 1 ? ' was' : 's were'} on a floor the file does not have, and went back to "Not on the plan yet".`,
    )
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  const floors = plan.storeys
  const summary = [
    count(floors.length, 'floor', 'floors'),
    count(
      floors.reduce((n, s) => n + s.spaces.length, 0),
      'room or area',
      'rooms and areas',
    ),
    count(
      floors.reduce((n, s) => n + s.walls.length, 0),
      'wall',
      'walls',
    ),
    count(
      floors.reduce((n, s) => n + s.openings.length, 0),
      'door, window or opening',
      'doors, windows and openings',
    ),
  ].join(', ')
  return { plan: view, snap: plan.snap, summary, notes }
}
