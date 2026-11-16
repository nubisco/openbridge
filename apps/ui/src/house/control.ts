/**
 * Operating a device from the House view, whichever side of the bridge it
 * came from. Native devices take the controls their plugin registered (the
 * same ones the Devices page uses). HomeKit accessories take a write to the
 * characteristic, the same as the device inspector.
 */
import { api } from '@/api'
import { characteristic, type LiveDevice } from './live'

async function writeHap(d: LiveDevice, name: string, value: unknown): Promise<void> {
  if (d.source.type !== 'hap') return
  const { accessory, service } = d.source
  const ch = characteristic(service, name)
  if (!ch || !ch.perms.includes('pw')) throw new Error(`${d.name} cannot set ${name}`)
  await api.setCharacteristic(accessory.uuid, service.uuid, ch.uuid, value)
}

function hapWritable(d: LiveDevice, name: string): boolean {
  if (d.source.type !== 'hap') return false
  const ch = characteristic(d.source.service, name)
  return !!ch && ch.perms.includes('pw')
}

/** What the inspector can offer for a device, so it never shows a control that would fail. */
export function capabilities(d: LiveDevice) {
  const native = d.source.type === 'native'
  const t = native ? (d.source as { device: { telemetry: Record<string, unknown> } }).device.telemetry : {}
  return {
    power: native ? t.active !== undefined && d.kind !== 'meter' : hapWritable(d, 'On') || hapWritable(d, 'Active'),
    brightness: native ? d.kind === 'light' && t.brightness !== undefined : hapWritable(d, 'Brightness'),
    target: native ? d.kind === 'heating' && t.targetTemperature !== undefined : hapWritable(d, 'TargetTemperature'),
    position: !native && hapWritable(d, 'TargetPosition'),
    gate: native ? d.kind === 'gate' : hapWritable(d, 'TargetDoorState'),
  }
}

export async function setPower(d: LiveDevice, on: boolean): Promise<void> {
  if (d.source.type === 'native') return void (await api.controlDevice(d.source.device.id, 'active', on))
  if (hapWritable(d, 'On')) return writeHap(d, 'On', on ? 1 : 0)
  return writeHap(d, 'Active', on ? 1 : 0)
}

export async function setBrightness(d: LiveDevice, pct: number): Promise<void> {
  if (d.source.type === 'native') return void (await api.controlDevice(d.source.device.id, 'brightness', pct))
  return writeHap(d, 'Brightness', Math.round(pct))
}

export async function setTarget(d: LiveDevice, degrees: number): Promise<void> {
  if (d.source.type === 'native')
    return void (await api.controlDevice(d.source.device.id, 'targetTemperature', degrees))
  return writeHap(d, 'TargetTemperature', degrees)
}

export async function setPosition(d: LiveDevice, pct: number): Promise<void> {
  return writeHap(d, 'TargetPosition', Math.round(pct))
}

export async function setGate(d: LiveDevice, target: 'open' | 'closed'): Promise<void> {
  if (d.source.type === 'native') return void (await api.controlDevice(d.source.device.id, 'target', target))
  // HomeKit's garage door: 0 is open, 1 is closed.
  return writeHap(d, 'TargetDoorState', target === 'open' ? 0 : 1)
}

/** A tap on the plan acts only where acting is safe and obvious: lights and plain switches. */
/**
 * Whether a tap on the plan switches the device. Only lights and plain
 * switches do. Anything drawn as an appliance or an outlet never does: a
 * plug drawn as the fridge switched off by a stray tap is a spoiled fridge.
 * Those open their controls instead.
 */
export function tapToggles(d: LiveDevice, look?: string): boolean {
  if (look) return false
  return (d.kind === 'light' || d.kind === 'switch') && d.reachable && capabilities(d).power
}
