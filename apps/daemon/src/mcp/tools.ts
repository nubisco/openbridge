/**
 * The MCP tools. Each one is a record: name, description, zod schema, the
 * scope it needs, and a handler that calls the same service functions as the
 * REST routes (services/bridge.ts). The JSON Schema in tools/list is generated
 * from the zod schema, never written by hand.
 *
 * Designed for an agent's context window, not as a mirror of the REST API:
 * `overview` orients in one call, reads are compact unless asked for more, and
 * history comes back with its summary already computed, so the model reports
 * numbers the code worked out rather than doing arithmetic over raw points.
 */

import { z } from 'zod'
import os from 'os'
import type { SerializedAccessory } from '@nubisco/openbridge-compatibility-homebridge'
import {
  ServiceError,
  controlDevice,
  deviceControls,
  deviceEvents,
  deviceMetrics,
  deviceObservations,
  getDevice,
  listAccessories,
  listDevices,
  readLogs,
  setCharacteristic,
  type BridgeContext,
  type DeviceView,
} from '../services/bridge.js'
import { CONTROL_SCOPE, READ_SCOPE, type Credential, type Scope } from '../access.js'
import { OPENBRIDGE_VERSION } from '../version.js'
import type { Point } from '../timeseries.js'

export interface McpContext {
  bridge: BridgeContext
  credential: Credential
  /** Public origin of this bridge, for url_templates and icons. */
  origin: string
  /** Bridge name from config, for the overview. */
  bridgeName: () => string | null
}

export interface McpTool {
  name: string
  description: string
  schema: z.ZodType
  scope: Scope
  write: boolean
  handler: (args: never, ctx: McpContext) => unknown | Promise<unknown>
}

/** A refusal the model must read: becomes `isError: true`, not a protocol error. */
export class Refusal extends Error {}

export function isRefusal(err: unknown): err is Error {
  return err instanceof Refusal || err instanceof ServiceError
}

export function toolInputSchema(tool: McpTool): unknown {
  const schema = z.toJSONSchema(tool.schema, { io: 'input' }) as Record<string, unknown>
  delete schema.$schema
  return schema
}

// ── Compact shapes ──────────────────────────────────────────────────────────

/** Telemetry without bookkeeping keys, with long values cut so one device cannot flood the context. */
function compactTelemetry(t: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(t)) {
    if (k.startsWith('_')) continue
    if (typeof v === 'string') out[k] = v.length > 160 ? `${v.slice(0, 160)}…` : v
    else if (v !== null && typeof v === 'object') {
      const s = JSON.stringify(v)
      out[k] = s.length > 240 ? `${s.slice(0, 240)}…` : v
    } else out[k] = v
  }
  return out
}

function compactDevice(d: DeviceView, ctx: McpContext) {
  return {
    id: d.id,
    name: d.name,
    type: d.homekitType ?? d.widgetType,
    plugin: d.pluginId,
    health: d.health.status,
    ...(d.health.reason ? { health_reason: d.health.reason } : {}),
    last_seen: d.health.lastSeen,
    telemetry: compactTelemetry(d.telemetry),
    ...(d.metrics?.length ? { metrics: d.metrics.map((m) => m.key) } : {}),
    ...(() => {
      const controls = deviceControls(ctx.bridge, d.id)
        .filter((c) => !c.restricted)
        .map((c) => c.id)
      return controls.length ? { controls } : {}
    })(),
  }
}

/** HomeKit service and characteristic names that say nothing about the device's state. */
const NOISE_SERVICES = new Set(['AccessoryInformation', 'Accessory Information', 'ProtocolInformation'])
const NOISE_CHARS = new Set(['Name', 'Identify', 'ConfiguredName'])

function compactAccessory(a: SerializedAccessory) {
  const state: Record<string, unknown> = {}
  for (const s of a.services) {
    if (NOISE_SERVICES.has(s.name) || NOISE_SERVICES.has(s.displayName)) continue
    for (const c of s.characteristics) {
      if (NOISE_CHARS.has(c.name)) continue
      state[`${s.displayName || s.name}.${c.name}`] = c.value
    }
  }
  return { uuid: a.uuid, name: a.displayName, reachable: a.reachable, state }
}

// ── Time ────────────────────────────────────────────────────────────────────

const DURATION = /^(\d+(?:\.\d+)?)\s*(m|h|d|w|y)$/i
const UNIT_SECONDS: Record<string, number> = { m: 60, h: 3600, d: 86400, w: 7 * 86400, y: 365 * 86400 }

function parseDuration(s: string): number {
  const m = DURATION.exec(s.trim())
  if (!m) throw new Refusal(`"${s}" is not a duration. Use a number and a unit: 90m, 24h, 7d, 4w, 1y`)
  return Math.round(Number(m[1]) * UNIT_SECONDS[m[2]!.toLowerCase()]!)
}

function parseInstant(s: string, field: string): number {
  const ms = Date.parse(s)
  if (Number.isNaN(ms)) throw new Refusal(`${field}: "${s}" is not an ISO 8601 date or time`)
  return Math.floor(ms / 1000)
}

const isoOf = (t: number) => new Date(t * 1000).toISOString()

/** What a person asks about a series, worked out here so the model never has to. */
function summarise(points: Point[], kind: 'instant' | 'cumulative') {
  const valued = points.filter((p): p is Point & { value: number } => typeof p.value === 'number')
  if (valued.length === 0) return { count: 0 }
  const first = valued[0]!
  const last = valued[valued.length - 1]!
  let lo = first
  let hi = first
  let sum = 0
  for (const p of valued) {
    const pMin = p.min ?? p.value
    const pMax = p.max ?? p.value
    if (pMin < (lo.min ?? lo.value)) lo = p
    if (pMax > (hi.max ?? hi.value)) hi = p
    sum += p.value
  }
  return {
    count: valued.length,
    first: { at: isoOf(first.t), value: first.value },
    last: { at: isoOf(last.t), value: last.value },
    min: { at: isoOf(lo.t), value: lo.min ?? lo.value },
    max: { at: isoOf(hi.t), value: hi.max ?? hi.value },
    ...(kind === 'cumulative' ? { delta: last.value - first.value } : { mean: sum / valued.length }),
  }
}

// ── Write replay ────────────────────────────────────────────────────────────

/**
 * Results of control ops, by caller and op_id, so a retry after a timeout gets
 * the first answer back instead of pressing the gate button a second time.
 */
const REPLAY_TTL_MS = 24 * 60 * 60 * 1000
const REPLAY_MAX = 5000
const replays = new Map<string, { at: number; result: unknown }>()

function replayed(key: string): unknown | undefined {
  const hit = replays.get(key)
  if (!hit) return undefined
  if (Date.now() - hit.at > REPLAY_TTL_MS) {
    replays.delete(key)
    return undefined
  }
  return hit.result
}

function remember(key: string, result: unknown): void {
  if (replays.size >= REPLAY_MAX) {
    const cutoff = Date.now() - REPLAY_TTL_MS
    for (const [k, v] of replays) if (v.at < cutoff || replays.size >= REPLAY_MAX) replays.delete(k)
  }
  replays.set(key, { at: Date.now(), result })
}

/** For tests: forget every remembered op. */
export function clearReplays(): void {
  replays.clear()
}

// ── Schemas ─────────────────────────────────────────────────────────────────

const deviceId = z.string().min(1).describe('Device id, as `overview` lists it')

const overviewArgs = z.object({
  detail: z
    .enum(['compact', 'full'])
    .default('compact')
    .describe('compact (default) is enough to answer most questions. full adds descriptors and every characteristic'),
})

const deviceGetArgs = z.object({ device: deviceId })

const historyArgs = z.object({
  device: deviceId,
  metric: z
    .string()
    .optional()
    .describe('Metric key from the device (see `overview` or `device_get`). Omit to list what the device records'),
  last: z
    .string()
    .optional()
    .describe('Window ending now (or at `to`): 90m, 24h, 7d, 4w, 1y. Default 24h. Ignored when `from` is set'),
  from: z.string().optional().describe('ISO 8601 start, e.g. 2026-10-01 or 2026-10-01T06:00:00Z'),
  to: z.string().optional().describe('ISO 8601 end. Default now'),
  max_points: z
    .number()
    .int()
    .min(0)
    .max(2000)
    .default(120)
    .describe('Most points to return (default 120). 0 returns the summary only'),
})

const eventsArgs = z.object({
  device: deviceId,
  limit: z.number().int().min(1).max(500).default(50),
  since: z.string().optional().describe('ISO 8601: only events after this'),
})

const observationsArgs = z.object({
  device: deviceId,
  limit: z.number().int().min(1).max(1000).default(50),
})

const logsArgs = z.object({
  plugin: z.string().optional().describe('Only this plugin (or "system" for the daemon itself)'),
  level: z.enum(['debug', 'info', 'warn', 'error']).optional().describe('This level and above'),
  contains: z.string().optional().describe('Case-insensitive text the message must contain'),
  since: z.string().optional().describe('ISO 8601: only entries after this'),
  limit: z.number().int().min(1).max(1000).default(100).describe('Newest entries kept (default 100)'),
})

const opId = z.string().min(1).max(200).describe('Client id for this op. Re-sending it replays the first result')

const controlOp = z.union([
  z.object({
    op_id: opId,
    device: deviceId,
    control: z.string().min(1).describe('Control id from the device'),
    value: z.unknown().optional().describe('What the control takes: true/false for a switch, a number for a setpoint'),
  }),
  z.object({
    op_id: opId,
    accessory: z.string().min(1).describe('Accessory uuid from `overview`'),
    service: z.string().min(1).describe('Service name or uuid, e.g. "Switch"'),
    characteristic: z.string().min(1).describe('Characteristic name or uuid, e.g. "On"'),
    value: z.unknown(),
  }),
])

const controlArgs = z.object({ ops: z.array(controlOp).min(1).max(100) })

// ── Tools ───────────────────────────────────────────────────────────────────

function tool<S extends z.ZodType>(t: {
  name: string
  description: string
  schema: S
  scope: Scope
  write?: boolean
  handler: (args: z.output<S>, ctx: McpContext) => unknown | Promise<unknown>
}): McpTool {
  return { write: false, ...t, handler: t.handler as McpTool['handler'] }
}

export const MCP_TOOLS: McpTool[] = [
  tool({
    name: 'overview',
    description:
      'Start here. One call returns the bridge, its plugins, every device with its current telemetry, health and ' +
      'metric and control ids, and the HomeKit accessories of Homebridge plugins with their current state. ' +
      'Health is ok, stale (stopped reporting) or unknown (never reported). `url_templates.device` links a device page.',
    schema: overviewArgs,
    scope: READ_SCOPE,
    handler: (args, ctx) => {
      const devices = listDevices(ctx.bridge)
      const accessories = listAccessories(ctx.bridge)
      const counts = new Map<string, number>()
      for (const d of devices) counts.set(d.pluginId, (counts.get(d.pluginId) ?? 0) + 1)
      return {
        bridge: {
          name: ctx.bridgeName(),
          version: OPENBRIDGE_VERSION,
          host: os.hostname(),
          uptime_seconds: Math.round(process.uptime()),
          now: new Date().toISOString(),
        },
        url_templates: { device: `${ctx.origin}/devices/{id}` },
        plugins: ctx.bridge.registry.getAll().map((p) => ({
          id: p.manifest.name,
          status: p.status,
          ...(p.disabled ? { disabled: true } : {}),
          ...(p.source ? { source: p.source } : {}),
          devices: counts.get(p.manifest.name) ?? 0,
        })),
        devices:
          args.detail === 'full'
            ? devices.map((d) => ({ ...d, controls: deviceControls(ctx.bridge, d.id) }))
            : devices.map((d) => compactDevice(d, ctx)),
        accessories: args.detail === 'full' ? accessories : accessories.map(compactAccessory),
      }
    },
  }),

  tool({
    name: 'device_get',
    description:
      'One device in full: its descriptor, all current telemetry, health, the metrics it records (with units and ' +
      'whether each is instant or cumulative), its controls and one-shot actions (with any confirmation text the ' +
      'plugin wants shown first), the observation form it offers, and its 10 most recent events.',
    schema: deviceGetArgs,
    scope: READ_SCOPE,
    handler: (args, ctx) => {
      const device = getDevice(ctx.bridge, args.device)
      let recentEvents: unknown[] = []
      try {
        recentEvents = deviceEvents(ctx.bridge, args.device, 10)
      } catch {
        // The event log is optional; a device is still worth describing without it.
      }
      let observationCount: number | null = null
      try {
        observationCount = deviceObservations(ctx.bridge, args.device, 1).total
      } catch {
        // Same: optional.
      }
      return {
        ...device,
        url: `${ctx.origin}/devices/${encodeURIComponent(device.id)}`,
        controls: deviceControls(ctx.bridge, device.id),
        observation_count: observationCount,
        recent_events: recentEvents,
      }
    },
  }),

  tool({
    name: 'device_history',
    description:
      'Recorded history of one metric. Pick the window with `last` (24h, 7d...) or `from`/`to` in ISO 8601. ' +
      'Returns a computed summary (first, last, min and max with when they happened, plus mean for instant metrics ' +
      'or delta for cumulative ones such as energy, where delta is the amount used in the window) and up to ' +
      '`max_points` points as [unix_seconds, value] or [unix_seconds, mean, min, max]. Quote the summary rather ' +
      'than recomputing it. Storage keeps 10 s detail for 48 h, 1 min for 30 days, 5 min for a year and hourly ' +
      'for five years; `resolution_seconds` says which answered. Without `metric`, lists what the device records.',
    schema: historyArgs,
    scope: READ_SCOPE,
    handler: (args, ctx) => {
      const to = args.to ? parseInstant(args.to, 'to') : Math.floor(Date.now() / 1000)
      const from = args.from ? parseInstant(args.from, 'from') : to - parseDuration(args.last ?? '24h')
      if (!args.metric) {
        const { metrics } = deviceMetrics(ctx.bridge, args.device, {})
        return { device: args.device, metrics }
      }
      const result = deviceMetrics(ctx.bridge, args.device, {
        metric: args.metric,
        from,
        to,
        maxPoints: Math.max(args.max_points, 10),
      })
      const s = result.series!
      const withExtremes = s.points.some((p) => p.min != null || p.max != null)
      return {
        device: args.device,
        metric: s.metric,
        from: isoOf(s.from),
        to: isoOf(s.to),
        resolution_seconds: s.resolution,
        summary: summarise(s.points, s.metric.kind),
        ...(args.max_points === 0
          ? {}
          : {
              points: s.points
                .slice(-args.max_points)
                .map((p) => (withExtremes ? [p.t, p.value, p.min ?? null, p.max ?? null] : [p.t, p.value])),
            }),
      }
    },
  }),

  tool({
    name: 'device_events',
    description:
      'What happened to a device and what caused it, newest first: a gate opening, a command, a fault. ' +
      'Each event has `at`, `type`, a one-line `message` and, when known, `source` (homekit, schedule, device...).',
    schema: eventsArgs,
    scope: READ_SCOPE,
    handler: (args, ctx) => {
      const since = args.since ? new Date(parseInstant(args.since, 'since') * 1000).toISOString() : null
      const events = deviceEvents(ctx.bridge, args.device, args.limit)
      return { device: args.device, events: since ? events.filter((e) => e.at > since) : events }
    },
  }),

  tool({
    name: 'device_observations',
    description:
      'What people reported about a room a device controls but cannot measure (for a heat pump: the room ' +
      'temperature and whether it felt cold, ok or warm), newest first, each with the machine state captured ' +
      'when it was filed. `total` is how many exist.',
    schema: observationsArgs,
    scope: READ_SCOPE,
    handler: (args, ctx) => ({ device: args.device, ...deviceObservations(ctx.bridge, args.device, args.limit) }),
  }),

  tool({
    name: 'logs',
    description:
      'Recent daemon and plugin log entries, oldest first, from the in-memory buffer (the last 1000 entries ' +
      'since the daemon started). Filter by plugin, minimum level, text and time.',
    schema: logsArgs,
    scope: READ_SCOPE,
    handler: (args) => ({
      entries: readLogs({
        plugin: args.plugin,
        limit: args.limit,
        minLevel: args.level,
        contains: args.contains,
        since: args.since ? new Date(parseInstant(args.since, 'since') * 1000).toISOString() : undefined,
      }).map((e) => ({ at: e.timestamp, level: e.level, plugin: e.plugin, message: e.message })),
    }),
  }),

  tool({
    name: 'device_control',
    description:
      'Operates devices. These move physical things: confirm with the person before opening, unlocking or ' +
      'switching anything they did not explicitly ask for, and before any action whose `confirm` text ' +
      '`device_get` shows. Up to 100 ops, run in order, each answered on its own with `ok` or an `error`. ' +
      'An op is either a plugin control ({device, control, value}, ids from `device_get`) or a HomeKit ' +
      'characteristic of a Homebridge accessory ({accessory, service, characteristic, value}, names as ' +
      '`overview` shows them, e.g. service "Switch", characteristic "On"). Re-sending an op_id returns the ' +
      'first result without running it again. Needs a token with control access.',
    schema: controlArgs,
    scope: CONTROL_SCOPE,
    write: true,
    handler: async (args, ctx) => {
      const results: unknown[] = []
      for (const op of args.ops) {
        const key = `${ctx.credential.id}\u0000${op.op_id}`
        const earlier = replayed(key)
        if (earlier !== undefined) {
          results.push({ ...(earlier as object), replayed: true })
          continue
        }
        let result: unknown
        try {
          if ('device' in op) {
            await controlDevice(ctx.bridge, op.device, op.control, op.value)
          } else {
            const target = resolveCharacteristic(ctx, op.accessory, op.service, op.characteristic)
            setCharacteristic(ctx.bridge, op.accessory, target.service, target.characteristic, op.value)
          }
          result = { op_id: op.op_id, ok: true }
        } catch (err) {
          if (!isRefusal(err)) throw err
          result = { op_id: op.op_id, ok: false, error: err.message }
        }
        remember(key, result)
        results.push(result)
      }
      return { results }
    },
  }),
]

/** Service and characteristic by uuid, display name or name. Ambiguity is refused, never guessed. */
function resolveCharacteristic(
  ctx: McpContext,
  accessoryUuid: string,
  service: string,
  characteristic: string,
): { service: string; characteristic: string } {
  const acc = listAccessories(ctx.bridge).find((a) => a.uuid === accessoryUuid)
  if (!acc) throw new Refusal(`Accessory '${accessoryUuid}' not found`)
  const svcMatches = acc.services.filter((s) => s.uuid === service || s.displayName === service || s.name === service)
  if (svcMatches.length === 0) throw new Refusal(`Accessory '${acc.displayName}' has no service '${service}'`)
  if (svcMatches.length > 1) {
    throw new Refusal(
      `'${service}' matches ${svcMatches.length} services on '${acc.displayName}'; pass one of their uuids: ` +
        svcMatches.map((s) => s.uuid).join(', '),
    )
  }
  const svc = svcMatches[0]!
  const ch = svc.characteristics.find((c) => c.uuid === characteristic || c.name === characteristic)
  if (!ch) throw new Refusal(`Service '${svc.displayName || svc.name}' has no characteristic '${characteristic}'`)
  return { service: svc.uuid, characteristic: ch.uuid }
}
