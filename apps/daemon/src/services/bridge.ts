/**
 * What the bridge knows about its devices, as plain functions.
 *
 * The REST routes in server.ts and the MCP tools in mcp/tools.ts are two thin
 * adapters over these, side by side in one process. Every check lives here, so
 * an agent can never do more than the same request through the HTTP API (see
 * "MCP servers" in the workspace AGENTS.md).
 *
 * A refusal is a ServiceError carrying the HTTP status the route answers with.
 * Fastify sends it as it does any error with a statusCode, and the MCP layer
 * turns it into a result the model reads.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import type { DeviceDescriptor, DeviceHealth, PluginRegistry } from '@nubisco/openbridge-core'
import { Logger, type LogEntry, type LogLevel } from '@nubisco/openbridge-logger'
import type { HomebridgeAPI } from '@nubisco/openbridge-compatibility-homebridge'
import { assessDeviceHealth } from '../device-health.js'
import type { DeviceEvent, DeviceEventLog } from '../device-events.js'
import type { DeviceObservation, ObservationStore } from '../observations.js'
import { DeviceSeries, type Point } from '../timeseries.js'
import type { HomeKitServiceTypes } from '../homekit-service-type.js'

export type ControlHandler = (value: unknown) => void | Promise<void>

export class ServiceError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message)
  }
}

export function isServiceError(err: unknown): err is ServiceError {
  return err instanceof ServiceError
}

/** Everything the functions below read, handed over once by createServer. */
export interface BridgeContext {
  registry: PluginRegistry
  home: string
  hapAPI: HomebridgeAPI | null
  controls: Map<string, ControlHandler>
  restrictedControls: Set<string>
  deviceEvents: DeviceEventLog | null
  observations: ObservationStore | null
  homekitServiceTypes: HomeKitServiceTypes | null
  nativeAccessoryUuid: ((deviceId: string) => string | null) | null
}

export type DeviceView = DeviceDescriptor & {
  telemetry: Record<string, unknown>
  pluginStatus: string
  homekitType: string | null
  health: DeviceHealth
}

function customNames(home: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(join(home, 'device-names.json'), 'utf8'))
  } catch {
    return {}
  }
}

/** Find a registered device by id across every plugin. */
export function findDevice(registry: PluginRegistry, deviceId: string): DeviceDescriptor | null {
  for (const instance of registry.getAll()) {
    const device = instance.devices?.[deviceId]
    if (device) return device
  }
  return null
}

/** Every device across every plugin, with its latest telemetry and health. */
export function listDevices(ctx: BridgeContext): DeviceView[] {
  const names = customNames(ctx.home)
  const devices: DeviceView[] = []
  for (const instance of ctx.registry.getAll()) {
    if (!instance.devices) continue
    for (const device of Object.values(instance.devices)) {
      const telemetry = instance.telemetry?.[device.id] ?? {}
      const name = names[device.id] ?? device.name

      // What the device is *presented* as, which may differ from the widget
      // type its plugin declared. Sent so the card can show a relay driving a
      // lamp as a light rather than contradicting the inspector next to it.
      const accessoryUuid = ctx.nativeAccessoryUuid?.(device.id) ?? null
      const homekitType = accessoryUuid ? (ctx.homekitServiceTypes?.typeForAccessory(accessoryUuid) ?? null) : null

      // Derived here rather than stored, so it is always current and there
      // is no second copy of the truth to go stale on its own.
      const health = assessDeviceHealth({
        telemetry,
        intervalSeconds: device.telemetryIntervalSeconds,
        pluginStatus: instance.status,
      })

      devices.push({ ...device, name, telemetry, pluginStatus: instance.status, homekitType, health })
    }
  }
  return devices
}

export function getDevice(ctx: BridgeContext, deviceId: string): DeviceView {
  const device = listDevices(ctx).find((d) => d.id === deviceId)
  if (!device) throw new ServiceError(404, `Device '${deviceId}' not found`)
  return device
}

/** The controls a plugin registered for a device, and whether each is restricted. */
export function deviceControls(ctx: BridgeContext, deviceId: string): Array<{ id: string; restricted: boolean }> {
  const prefix = `${deviceId}::`
  const out: Array<{ id: string; restricted: boolean }> = []
  for (const key of ctx.controls.keys()) {
    if (!key.startsWith(prefix)) continue
    out.push({ id: key.slice(prefix.length), restricted: ctx.restrictedControls.has(key) })
  }
  return out
}

/** Run one control. A restricted control is refused here, for every caller. */
export async function controlDevice(
  ctx: BridgeContext,
  deviceId: string,
  control: string,
  value: unknown,
): Promise<void> {
  const key = `${deviceId}::${control}`
  if (ctx.restrictedControls.has(key)) {
    throw new ServiceError(403, `Control '${control}' is restricted for device '${deviceId}'`)
  }
  const handler = ctx.controls.get(key)
  if (!handler) throw new ServiceError(404, `No control '${control}' registered for device '${deviceId}'`)
  await handler(value)
}

export interface MetricQuery {
  metric?: string
  /** Unix seconds. Defaults to a day before `to`. */
  from?: number
  /** Unix seconds. Defaults to now. */
  to?: number
  maxPoints?: number
}

export interface MetricSeries {
  metric: NonNullable<DeviceDescriptor['metrics']>[number]
  resolution: number
  tier: string
  from: number
  to: number
  points: Point[]
}

/**
 * A device's recorded history for one metric over a range. Without a metric it
 * reports what the device offers, so a caller can choose without a second read.
 */
export function deviceMetrics(
  ctx: BridgeContext,
  deviceId: string,
  q: MetricQuery,
): { deviceId: string; metrics: NonNullable<DeviceDescriptor['metrics']>; series: MetricSeries | null } {
  const device = findDevice(ctx.registry, deviceId)
  if (!device) throw new ServiceError(404, `Device '${deviceId}' not found`)
  const metrics = device.metrics ?? []
  if (metrics.length === 0) return { deviceId, metrics: [], series: null }
  if (!q.metric) return { deviceId, metrics, series: null }

  const descriptor = metrics.find((m) => m.key === q.metric)
  if (!descriptor) throw new ServiceError(404, `Device '${deviceId}' does not report '${q.metric}'`)

  const now = Math.floor(Date.now() / 1000)
  const toSec = q.to ?? now
  const fromSec = q.from ?? toSec - 86400
  if (!Number.isFinite(fromSec) || !Number.isFinite(toSec) || fromSec >= toSec) {
    throw new ServiceError(400, 'Invalid from/to range')
  }

  const series = new DeviceSeries(join(ctx.home, 'metrics'), deviceId, metrics)
  const points = Math.min(5000, Math.max(10, q.maxPoints || 720))
  const result = series.query(descriptor.key, fromSec, toSec, points)

  return {
    deviceId,
    metrics,
    series: {
      metric: descriptor,
      resolution: result.tier.interval,
      tier: result.tier.name,
      from: fromSec,
      to: toSec,
      points: result.points,
    },
  }
}

export function deviceEvents(ctx: BridgeContext, deviceId: string, limit = 100): DeviceEvent[] {
  if (!ctx.deviceEvents) throw new ServiceError(503, 'event log unavailable')
  return ctx.deviceEvents.read(deviceId, Number.isFinite(limit) ? limit : 100)
}

export function deviceObservations(
  ctx: BridgeContext,
  deviceId: string,
  limit = 100,
): { observations: DeviceObservation[]; total: number } {
  if (!ctx.observations) throw new ServiceError(503, 'observation store unavailable')
  return {
    observations: ctx.observations.list(deviceId, Number.isFinite(limit) ? limit : 100),
    total: ctx.observations.count(deviceId),
  }
}

export interface LogQuery {
  plugin?: string
  limit?: number
  /** Only this level and above. */
  minLevel?: LogLevel
  /** Case-insensitive substring of the message. */
  contains?: string
  /** ISO timestamp: only entries after it. */
  since?: string
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

/** The daemon's in-memory log buffer, oldest first, newest `limit` kept. */
export function readLogs(q: LogQuery): LogEntry[] {
  const limit = q.limit ?? 200
  // The REST route never filtered, so it asks for the buffer as it always did.
  if (!q.minLevel && !q.contains && !q.since) return Logger.getEntries(q.plugin, limit)

  const needle = q.contains?.toLowerCase()
  const floor = q.minLevel ? LEVEL_ORDER[q.minLevel] : 0
  return Logger.getEntries(q.plugin, Number.MAX_SAFE_INTEGER)
    .filter(
      (e) =>
        LEVEL_ORDER[e.level] >= floor &&
        (!q.since || e.timestamp > q.since) &&
        (!needle || e.message.toLowerCase().includes(needle)),
    )
    .slice(-limit)
}

/** Accessories published by Homebridge-compatible plugins, with their characteristic values. */
export function listAccessories(ctx: BridgeContext) {
  return ctx.hapAPI ? ctx.hapAPI.getAccessories() : []
}

/** Write one HomeKit characteristic, which runs the plugin's onSet handler. */
export function setCharacteristic(
  ctx: BridgeContext,
  uuid: string,
  serviceUuid: string,
  charUuid: string,
  value: unknown,
): void {
  if (!ctx.hapAPI) throw new ServiceError(503, 'HAP not available')
  const raw = ctx.hapAPI.getRawAccessories()
  const acc = raw.find((a: any) => a.UUID === uuid)
  if (!acc) throw new ServiceError(404, `Accessory '${uuid}' not found`)

  const svc = acc.services?.find((s: any) => s.UUID === serviceUuid)
  if (!svc) throw new ServiceError(404, `Service '${serviceUuid}' not found`)

  const ch = svc.characteristics?.find((c: any) => c.UUID === charUuid)
  if (!ch) throw new ServiceError(404, `Characteristic '${charUuid}' not found`)

  try {
    ch.setValue(value)
  } catch (err) {
    throw new ServiceError(500, `setValue failed: ${err}`)
  }
}
