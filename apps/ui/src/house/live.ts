/**
 * Every device the bridge knows, in the one shape the House view draws.
 *
 * Two sources feed it: native devices (a widget type and free-form telemetry)
 * and HomeKit accessories from Homebridge plugins (services and
 * characteristics). Both become a `LiveDevice` with a kind that decides how it
 * is drawn, the readings that kind needs, and how to operate it.
 *
 * Telemetry keys follow what the plugins report today: `active` and
 * `brightness` (WiZ, Shelly), `currentTemperature` and `targetTemperature`
 * (Tuya heating), `supplyTemperature` and `returnTemperature` (any heating
 * plugin that reads both pipes), `currentHumidity` (Tuya dehumidifier), `power` (Shelly
 * meters) and the gate's `state` and `target` (Shelly gate).
 */
import type { Accessory, AccessoryCharacteristic, AccessoryService, DeviceDescriptor, HouseLook } from '@/api'
import { hueSatColor } from './geometry'

export type LiveKind =
  | 'light'
  | 'switch'
  | 'heating'
  | 'dehumidifier'
  | 'meter'
  | 'gate'
  | 'shutter'
  | 'sensor'
  | 'camera'
  | 'other'

export type NativeDevice = DeviceDescriptor & { telemetry: Record<string, unknown>; pluginStatus: string }

export interface LiveDevice {
  ref: string
  name: string
  kind: LiveKind
  /** False when the device stopped answering. Drawn dimmed, never as "off". */
  reachable: boolean
  on?: boolean
  /** 0-100 */
  brightness?: number
  /** The colour a light reports, when it reports one. */
  color?: string
  /** Shutter open share, 0-100. */
  position?: number
  temperature?: number
  /** Water leaving and coming back, for a heating device that reports both. */
  supply?: number
  return?: number
  target?: number
  humidity?: number
  power?: number
  gateState?: 'open' | 'closed' | 'opening' | 'closing' | 'stopped'
  /** What it is drawn as when the plan does not say: a socket for an outlet, and so on. */
  defaultLook?: HouseLook
  /** Where it lives, for the device page link and for controls. */
  source: { type: 'native'; device: NativeDevice } | { type: 'hap'; accessory: Accessory; service: AccessoryService }
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : undefined
}

const NATIVE_KIND: Record<string, LiveKind> = {
  light: 'light',
  switch: 'switch',
  thermostat: 'heating',
  dehumidifier: 'dehumidifier',
  energy_meter: 'meter',
  gate: 'gate',
  sensor: 'sensor',
  camera: 'camera',
  shutter: 'shutter',
  outlet: 'switch',
  valve: 'switch',
}

/** What a relay was re-presented as in HomeKit beats the plugin's own guess. */
const PRESENTED_KIND: Record<string, LiveKind> = { light: 'light', switch: 'switch', outlet: 'switch', fan: 'switch' }

export function fromNative(d: NativeDevice & { homekitType?: string | null }): LiveDevice {
  const t = d.telemetry ?? {}
  const kind = (d.homekitType && PRESENTED_KIND[d.homekitType]) || NATIVE_KIND[d.widgetType] || 'other'
  const health = d.health?.status
  const out: LiveDevice = {
    ref: `device:${d.id}`,
    name: d.name,
    kind,
    reachable: t.reachable !== false && health !== 'stale' && d.pluginStatus !== 'error',
    source: { type: 'native', device: d },
  }
  if (t.active !== undefined) out.on = !!t.active
  out.brightness = num(t.brightness)
  out.temperature = num(t.currentTemperature)
  out.target = num(t.targetTemperature)
  out.supply = num(t.supplyTemperature) ?? num(t.flowTemperature)
  out.return = num(t.returnTemperature)
  out.humidity = num(t.currentHumidity)
  out.power = num(t.power)
  out.position = num(t.position)
  const hue = num(t.hue)
  const sat = num(t.saturation)
  if (hue !== undefined && sat !== undefined) out.color = hueSatColor(hue, sat)
  if (kind === 'gate' && typeof t.state === 'string') out.gateState = t.state as LiveDevice['gateState']
  if (d.homekitType === 'outlet' || (!d.homekitType && d.widgetType === 'outlet')) out.defaultLook = 'outlet'
  if (kind === 'dehumidifier') out.defaultLook = 'dehumidifier'
  if (d.widgetType === 'valve') out.defaultLook = 'tap'
  return out
}

const SKIP_SERVICES = new Set([
  'AccessoryInformation',
  '0000003E-0000-1000-8000-0026BB765291',
  'ProtocolInformation',
  '000000A2-0000-1000-8000-0026BB765291',
])

const HAP_KIND: Record<string, LiveKind> = {
  Lightbulb: 'light',
  Switch: 'switch',
  Outlet: 'switch',
  Fan: 'switch',
  Fanv2: 'switch',
  WindowCovering: 'shutter',
  TemperatureSensor: 'sensor',
  HumiditySensor: 'sensor',
  Thermostat: 'heating',
  HeaterCooler: 'heating',
  HumidifierDehumidifier: 'dehumidifier',
  GarageDoorOpener: 'gate',
  CameraRTPStreamManagement: 'camera',
  // A water timer on a garden tap, or a sprinkler controller.
  Valve: 'switch',
  IrrigationSystem: 'switch',
}

export function primaryService(acc: Accessory): AccessoryService | undefined {
  return acc.services.find((s) => !SKIP_SERVICES.has(s.name) && !SKIP_SERVICES.has(s.uuid))
}

export function characteristic(svc: AccessoryService, name: string): AccessoryCharacteristic | undefined {
  return svc.characteristics.find((c) => c.name === name)
}

/** HAP's garage door states, which are what a gate is in HomeKit. */
const DOOR_STATE: Record<number, LiveDevice['gateState']> = {
  0: 'open',
  1: 'closed',
  2: 'opening',
  3: 'closing',
  4: 'stopped',
}

export function fromAccessory(acc: Accessory): LiveDevice | null {
  const svc = primaryService(acc)
  if (!svc) return null
  // A camera publishes its stream manager next to a motion sensor or doorbell.
  const isCamera = acc.services.some((s) => s.name === 'CameraRTPStreamManagement') || acc.category === 17
  const kind: LiveKind = isCamera ? 'camera' : (HAP_KIND[svc.name] ?? 'other')
  const v = (name: string) => characteristic(svc, name)?.value
  const out: LiveDevice = {
    ref: `accessory:${acc.uuid}`,
    name: acc.displayName,
    kind,
    reachable: acc.reachable,
    source: { type: 'hap', accessory: acc, service: svc },
  }
  const onValue = v('On') ?? v('Active')
  if (onValue !== undefined) out.on = !!onValue
  out.brightness = num(v('Brightness'))
  const hue = num(v('Hue'))
  const sat = num(v('Saturation'))
  if (hue !== undefined && sat !== undefined) out.color = hueSatColor(hue, sat)
  out.position = num(v('CurrentPosition'))
  out.temperature = num(v('CurrentTemperature'))
  out.target = num(v('TargetTemperature')) ?? num(v('HeatingThresholdTemperature'))
  out.humidity = num(v('CurrentRelativeHumidity'))
  if (svc.name === 'Outlet') out.defaultLook = 'outlet'
  if (svc.name === 'Valve' || svc.name === 'IrrigationSystem') out.defaultLook = 'tap'
  if (kind === 'dehumidifier') out.defaultLook = 'dehumidifier'
  const door = num(v('CurrentDoorState'))
  if (door !== undefined) out.gateState = DOOR_STATE[door]
  // A temperature sensor that also carries humidity does so on a sibling service.
  if (out.humidity === undefined) {
    const h = acc.services.find((s) => s.name === 'HumiditySensor')
    out.humidity = h ? num(characteristic(h, 'CurrentRelativeHumidity')?.value) : undefined
  }
  return out
}

export function liveDevices(native: NativeDevice[], accessories: Accessory[]): LiveDevice[] {
  const out = native.map(fromNative)
  for (const acc of accessories) {
    const d = fromAccessory(acc)
    if (d) out.push(d)
  }
  return out
}

/** Whether a device is doing something, for the list's state dot. */
export function isActive(d: LiveDevice): boolean {
  if (d.kind === 'shutter') return (d.position ?? 0) > 0
  if (d.kind === 'gate') return d.gateState !== undefined && d.gateState !== 'closed'
  return !!d.on
}

export function stateText(d: LiveDevice): string {
  if (!d.reachable) return 'Not responding'
  switch (d.kind) {
    case 'light':
      if (d.on === undefined) return ''
      return d.on ? (d.brightness !== undefined ? `${Math.round(d.brightness)}%` : 'On') : 'Off'
    case 'shutter':
      if (d.position === undefined) return ''
      return d.position <= 0 ? 'Closed' : d.position >= 100 ? 'Open' : `${Math.round(d.position)}% open`
    case 'sensor': {
      const parts: string[] = []
      if (d.temperature !== undefined) parts.push(`${d.temperature.toFixed(1)}°`)
      if (d.humidity !== undefined) parts.push(`${Math.round(d.humidity)}%`)
      return parts.join(' · ')
    }
    case 'heating':
      if (d.on === false) return 'Off'
      return d.temperature !== undefined ? `${d.temperature.toFixed(1)}°` : 'On'
    case 'dehumidifier':
      if (d.on === false) return 'Off'
      return d.humidity !== undefined ? `${Math.round(d.humidity)}%` : 'On'
    case 'meter':
      return d.power !== undefined ? formatPower(d.power) : ''
    case 'gate':
      return d.gateState ? d.gateState[0].toUpperCase() + d.gateState.slice(1) : ''
    case 'camera':
      return 'Camera'
    default:
      return d.on === undefined ? '' : d.on ? 'On' : 'Off'
  }
}

export function formatPower(w: number): string {
  return Math.abs(w) >= 1000 ? `${(w / 1000).toFixed(2)} kW` : `${Math.round(w)} W`
}

/** One letter per kind for the editor's device markers. */
export const KIND_LETTER: Record<LiveKind, string> = {
  light: 'L',
  switch: 'S',
  heating: 'H',
  dehumidifier: 'D',
  meter: 'E',
  gate: 'G',
  shutter: 'B',
  sensor: 'T',
  camera: 'C',
  other: '?',
}

export const LOOK_LABEL: Record<HouseLook, string> = {
  outlet: 'Power outlet',
  tv: 'TV',
  fridge: 'Fridge',
  washer: 'Washing machine',
  dehumidifier: 'Dehumidifier',
  vacuum: 'Robot vacuum',
  mower: 'Lawn mower',
  tap: 'Garden tap',
}

export const KIND_LABEL: Record<LiveKind, string> = {
  light: 'Light',
  switch: 'Switch',
  heating: 'Heating',
  dehumidifier: 'Dehumidifier',
  meter: 'Energy meter',
  gate: 'Gate',
  shutter: 'Shutter',
  sensor: 'Sensor',
  camera: 'Camera',
  other: 'Device',
}
