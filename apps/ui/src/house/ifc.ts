/**
 * The house as an IFC file, from the browser. The writer is the model's own
 * (`@house-model/ifc`), which knows nothing of OpenBridge's devices. What each
 * placed device is in IFC is decided here, from its kind and how it looks on
 * the plan.
 */
import type { HouseLook } from '@/api'
import { toIfc, type IfcDevice } from '@house-model/ifc'
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
