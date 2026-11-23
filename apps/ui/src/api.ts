import type { HouseWallSpec, OpeningSpec } from '@house-model/v1'
import type { Plan } from '@house-model/v2'
const BASE = '/api'

export async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

/**
 * The daemon's error message, or a status-code fallback.
 *
 * Fastify sends a JSON body with `message` on every error it raises, and those
 * messages are the useful half: "This npm install cannot update itself. Run:
 * ..." tells the user what to do, where "503" tells them nothing.
 */
async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json()
    const message = (body as { message?: unknown })?.message
    if (typeof message === 'string' && message.trim() !== '') return message
  } catch {
    /* not JSON, or already consumed: fall through */
  }
  return `${fallback}: ${res.status}`
}

export interface PluginInstance {
  id: string
  manifest: { name: string; version: string; description?: string; author?: string }
  status: 'idle' | 'loading' | 'running' | 'stopped' | 'error'
  error?: string
  startedAt?: string
  stoppedAt?: string
  source?: 'native' | 'homebridge'
  disabled?: boolean
  platformName?: string
  /** npm package name: how config.plugins[] keys this plugin's config. */
  packageName?: string
  enrichedMetadata?: Record<string, unknown> // Cached npm metadata (downloads, stars, sponsors, docs url)
  hapBridge?: { setupURI: string; pincode: string; port: number; name: string }
  devices?: Record<string, DeviceDescriptor>
  availableUpdate?: string
}

export interface AccessoryCharacteristic {
  uuid: string
  name: string
  value: unknown
  format: string
  perms: string[]
  /** HAP status, 0 when healthy. Non-zero means `value` is stale, not current. */
  statusCode: number
}

export interface AccessoryService {
  uuid: string
  name: string
  displayName: string
  characteristics: AccessoryCharacteristic[]
}

export interface Accessory {
  uuid: string
  displayName: string
  category: number
  services: AccessoryService[]
  reachable: boolean
  /** The HAP status behind `reachable: false`, absent when healthy. */
  statusCode?: number
}

export interface LogEntry {
  timestamp: string
  level: 'debug' | 'info' | 'warn' | 'error'
  plugin: string
  message: string
}

export interface HealthResponse {
  status: string
  version: string
  timestamp: string
}

export interface UpdateStatus {
  current: string
  latest: string | null
  updateAvailable: boolean
  updateMethod: 'self' | 'manual'
  /** What to run by hand when updateMethod is 'manual', matched to the install. */
  updateCommand: string
  /** Why self-update is unavailable, when it is. */
  updateBlockedBy?: string | null
  installMethod: 'docker' | 'homebrew' | 'npm' | 'source'
  /** Set when the deployment holds a fixed version, which disables self-update. */
  pinnedTo: string | null
  releaseUrl?: string
  releaseNotes?: string
}

/** One thing that happened to a device, for its timeline. */
export interface DeviceEvent {
  at: string
  type: string
  message: string
  source?: string
  data?: Record<string, unknown>
}

export interface SystemInfo {
  os: string
  arch: string
  hostname: string
  user: string
  nodeVersion: string
  ip: string
  configPath: string
  obPluginsDir: string
  hbPluginsDir: string
  uptimeSystem: number
  uptimeProcess: number
}

/** The anonymous install heartbeat switch. Mirrors the daemon's telemetry config. */
export interface TelemetryConfig {
  installHeartbeat: boolean
}

export interface BridgeConfig {
  name: string
  port: number
  hapPort: number
  pincode: string
  username?: string
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}

export interface MetricsSnapshot {
  t: number
  cpu: number
  cpuTemp: number
  memTotal: number
  memFree: number
  netRxSec: number
  netTxSec: number
}

export interface InstalledPackage {
  name: string
  version: string
  mainFile: string
}

export interface NpmPackage {
  name: string
  version: string
  description: string
  author?: { name: string } | string
  links?: { npm?: string; homepage?: string; repository?: string }
  date: string
  weeklyDownloads?: number
  githubStars?: number
  githubSponsorsUrl?: string
  documentationUrl?: string
  readme?: string
  badges?: string[]
}

export interface NpmSearchResult {
  objects: Array<{ package: NpmPackage; score: { final: number } }>
  total: number
}

export interface LocalPlugin {
  name: string
  version: string
  description: string
  author: string
  path: string
  platform?: string
  displayName?: string
}

export interface InterpolationDescriptor {
  inputLabel: string
  outputLabel: string
  inputMin: number
  inputMax: number
  outputMin: number
  outputMax: number
  configField: string
  configShape: { inputKey: string; outputKey: string }
}

/** One time-series a device reports, as declared by its plugin. */
export interface MetricDescriptor {
  key: string
  label: string
  unit: string
  kind: 'instant' | 'cumulative'
  precision?: number
  trackExtremes?: boolean
}

/** Mirrors DeviceActionDescriptor in @nubisco/openbridge-core. */
export interface ObservationDescriptor {
  label: string
  unit: string
  min: number
  max: number
  help?: string
}

/** One report of what a device cannot measure, with the machine state at the time. */
export interface DeviceObservation {
  at: string
  roomTemperature: number
  comfort: 'cold' | 'ok' | 'warm'
  note?: string
  context?: Record<string, unknown>
}

export interface DeviceActionDescriptor {
  id: string
  label: string
  confirm?: string
  danger?: boolean
}

/** Mirrors DeviceHealth in @nubisco/openbridge-core. */
export interface DeviceHealth {
  status: 'ok' | 'stale' | 'unknown'
  lastSeen: string | null
  silentForSeconds: number | null
  reason: string | null
}

/** The room a device is placed in on the house plan. Mirrors DeviceRoom in the daemon's house.ts. */
export interface DeviceRoom {
  id: string
  name: string
  floor: { id: string; name: string; level: number }
}

// ─── House plan ─────────────────────────────────────────────────────────────
// The server stores plan version 2 (millimetres, walls as elements). The
// editor and views below still draw version 1, in grid cells of `grid`
// metres, through the adapter in @house-model/convert. These types mirror
// apps/daemon/src/house-model/v1.ts.

export type HouseRoomKind = 'room' | 'outdoor' | 'paved' | 'pool'

export interface HouseRect {
  x: number
  y: number
  w: number
  h: number
}

export interface HouseRoom extends HouseRect {
  id: string
  name: string
  kind: HouseRoomKind
  /** More rectangles joined along an edge, for an L or U shaped room. */
  parts?: HouseRect[]
}

export interface HouseOpening {
  id: string
  /** `open` is a stretch of wall that is not there: two rooms that run into each other. */
  type: 'door' | 'window' | 'open' | 'slider'
  x: number
  y: number
  axis: 'h' | 'v'
  len: number
  /** A door's hinge end: lower x or y (`start`, the default) or the other. */
  hinge?: 'start' | 'end'
  /** The side a door swings into, on the plan. Default `down` or `right`. */
  opens?: 'up' | 'down' | 'left' | 'right'
  /** A door with a glass leaf. Glass can carry coverings. */
  glass?: boolean
  /** A door's or window's detail, in millimetres as plan version 2 has it. */
  spec?: OpeningSpec
}

export type HouseLightMount = 'ceiling' | 'wall' | 'floor' | 'table' | 'pool'
export type HouseLook = 'outlet' | 'tv' | 'fridge' | 'washer' | 'dehumidifier' | 'vacuum' | 'mower' | 'tap'

export interface HousePlacement {
  /** `device:<id>` for a native device, `accessory:<uuid>` for a HomeKit accessory. */
  ref: string
  x: number
  y: number
  opening?: string
  /** The covering of that opening it drives. */
  covering?: string
  color?: string
  circuitRooms?: string[]
  /** A gate's width in cells, centred on (x, y). */
  length?: number
  /** Which way a gate or a TV runs. */
  axis?: 'h' | 'v'
  /** Where a light is mounted. */
  mount?: HouseLightMount
  /** What the device is drawn as, when its type alone does not say. */
  look?: HouseLook
}

/** A radiator on a wall: placed like a door or window, hanging on one side of it. */
export interface HouseRadiator {
  id: string
  x: number
  y: number
  axis: 'h' | 'v'
  len: number
  side: 'up' | 'down' | 'left' | 'right'
}

export type HouseFurnitureKind =
  | 'table'
  | 'cabinet'
  | 'island'
  | 'bed'
  | 'sofa'
  | 'shelves'
  | 'rug'
  | 'bath'
  | 'shower'
  | 'toilet'
  | 'basin'
  | 'lounger'
  | 'parasol'
  | 'planter'
  | 'pergola'

/** A piece of furniture: a rectangle in half cells, `w` along x and `d` along y. */
export interface HouseFurniture {
  id: string
  kind: HouseFurnitureKind
  x: number
  y: number
  w: number
  d: number
  /** Height in metres, when it is not the usual one for its kind. */
  height?: number
  /** The side its back is on (a bed's head, a sofa's back), when set. Unset, the side nearest a wall. */
  back?: 'up' | 'down' | 'left' | 'right'
}

export interface HouseFloor {
  id: string
  name: string
  level: number
  rooms: HouseRoom[]
  openings: HouseOpening[]
  placements: HousePlacement[]
  radiators?: HouseRadiator[]
  furniture?: HouseFurniture[]
  walls?: HouseWallSpec[]
}

export interface HousePlan {
  version: 1
  grid: number
  plot: { w: number; h: number }
  floors: HouseFloor[]
}

/** The plan as stored: version 2, in millimetres (apps/daemon/src/house-model/v2.ts). */
export type HouseModel = Plan

export interface StoredHouse {
  plan: HouseModel | null
  rev: number
  updatedAt: string | null
}

export interface DeviceDescriptor {
  id: string
  name: string
  widgetType: string
  manufacturer?: string
  model?: string
  pluginId: string
  interpolation?: InterpolationDescriptor
  observations?: ObservationDescriptor
  metrics?: MetricDescriptor[]
  actions?: DeviceActionDescriptor[]
  telemetryIntervalSeconds?: number
  health?: DeviceHealth
  /** Video OpenBridge can show: a snapshot, or a live stream too. */
  video?: 'snapshot' | 'live'
}

/** A token that opens the MCP endpoint. The secret itself is shown once, at creation. */
export interface AccessToken {
  id: string
  name: string
  access: 'read' | 'control'
  /** Who created it, null when dashboard sign-in was off. */
  owner: string | null
  createdAt: string
  lastUsedAt: string | null
}

/** An application connected through OAuth, one row however many times it was approved. */
export interface AccessConnection {
  clientId: string
  name: string
  access: 'read' | 'control'
  owners: string[]
  connectedAt: string
  lastUsedAt: string | null
}

async function sendJson<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    let message = `${method} ${path} failed: ${res.status}`
    try {
      const data = (await res.json()) as { error?: string; message?: string }
      message = data.error ?? data.message ?? message
    } catch {
      /* not JSON */
    }
    throw new Error(message)
  }
  return res.json() as Promise<T>
}

export const api = {
  access: {
    get: () =>
      get<
        { enabled: false } | { enabled: true; endpoint: string; tokens: AccessToken[]; connections: AccessConnection[] }
      >('/access'),
    createToken: (name: string, access: 'read' | 'control') =>
      sendJson<{ id: string; token: string }>('POST', '/access/tokens', { name, access }),
    revokeToken: (id: string) => sendJson<{ ok: true }>('DELETE', `/access/tokens/${encodeURIComponent(id)}`),
    revokeConnection: (clientId: string) =>
      sendJson<{ ok: true }>('DELETE', `/access/connections/${encodeURIComponent(clientId)}`),
  },
  health: () => get<HealthResponse>('/health'),
  system: () => get<SystemInfo>('/system'),
  qr: () => get<{ setupURI: string | null; pincode: string | null; error?: string }>('/qr'),
  deviceEvents: (id: string, limit = 100) =>
    get<{ events: DeviceEvent[] }>(`/devices/${encodeURIComponent(id)}/events?limit=${limit}`),
  deviceObservations: (id: string, limit = 50) =>
    get<{ observations: DeviceObservation[]; total: number }>(
      `/devices/${encodeURIComponent(id)}/observations?limit=${limit}`,
    ),
  reportObservation: (id: string, body: { roomTemperature: number; comfort: string; note?: string }) =>
    fetch(`/api/devices/${encodeURIComponent(id)}/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async (r) => {
      if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? `HTTP ${r.status}`)
      return r.json() as Promise<{ observation: DeviceObservation; total: number }>
    }),
  plugins: () => get<{ plugins: PluginInstance[] }>('/plugins'),
  pluginsRefresh: () =>
    fetch('/api/plugins/refresh', { method: 'POST' }).then((r) => r.json() as Promise<{ plugins: PluginInstance[] }>),
  plugin: (id: string) => get<PluginInstance>(`/plugins/${id}`),
  setPluginDisabled: (id: string, disabled: boolean) =>
    fetch(`/api/plugins/${id}/disabled`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled }),
    }).then((r) => {
      if (!r.ok) throw new Error(`Set disabled failed: ${r.status}`)
      return r.json() as Promise<PluginInstance>
    }),
  bridge: () => get<BridgeConfig>('/bridge'),
  saveBridge: (config: Partial<BridgeConfig>) =>
    fetch('/api/bridge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    }).then((r) => {
      if (!r.ok) throw new Error(`Save failed: ${r.status}`)
      return r.json()
    }),
  accessories: () => get<{ accessories: Accessory[] }>('/accessories'),
  devices: () =>
    get<{
      devices: Array<
        DeviceDescriptor & { telemetry: Record<string, unknown>; pluginStatus: string; room?: DeviceRoom | null }
      >
    }>('/devices'),
  house: {
    get: () => get<StoredHouse>('/house'),
    /**
     * Replace the plan. Resolves to `conflict` with the server's current state
     * when somebody saved since `rev` was read, so the caller can reload rather
     * than overwrite their work.
     */
    save: async (
      plan: HouseModel | HousePlan | null,
      rev: number,
    ): Promise<{ ok: true; house: StoredHouse } | { ok: false; conflict: StoredHouse }> => {
      const res = await fetch(`${BASE}/house`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan, rev }),
      })
      const data = (await res.json().catch(() => null)) as (StoredHouse & { error?: string }) | null
      if (res.status === 409 && data) return { ok: false, conflict: data }
      if (!res.ok || !data) throw new Error(data?.error ?? `Saving the house plan failed: ${res.status}`)
      return { ok: true, house: data }
    },
  },
  controlDevice: (deviceId: string, control: string, value: unknown) =>
    fetch(`/api/devices/${encodeURIComponent(deviceId)}/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ control, value }),
    }).then((r) => {
      if (!r.ok) throw new Error(`Control failed: ${r.status}`)
      return r.json()
    }),
  renameDevice: (deviceId: string, name: string) =>
    fetch(`/api/devices/${encodeURIComponent(deviceId)}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }).then((r) => {
      if (!r.ok) throw new Error(`Rename failed: ${r.status}`)
      return r.json()
    }),
  deviceHistory: (deviceId: string, period: 'day' | 'month' | 'year', date?: string) => {
    const params = new URLSearchParams({ period })
    if (date) params.set('date', date)
    return get<{
      period: string
      date: string
      buckets: Array<{ label: string; kwh: number | null }>
      totalKwh: number
    }>(`/devices/${encodeURIComponent(deviceId)}/history?${params}`)
  },
  /**
   * Metric history. Called without `metric` it lists what the device reports,
   * which is how the chart populates its selector without pulling a range.
   */
  deviceMetrics: (
    deviceId: string,
    options: { metric?: string; from?: number; to?: number; maxPoints?: number } = {},
  ) => {
    const params = new URLSearchParams()
    if (options.metric) params.set('metric', options.metric)
    if (options.from !== undefined) params.set('from', String(options.from))
    if (options.to !== undefined) params.set('to', String(options.to))
    if (options.maxPoints !== undefined) params.set('maxPoints', String(options.maxPoints))
    const query = params.toString()
    return get<{
      deviceId: string
      metrics: MetricDescriptor[]
      series: {
        metric: MetricDescriptor
        resolution: number
        tier: string
        from: number
        to: number
        points: Array<{ t: number; value: number | null; min?: number | null; max?: number | null }>
      } | null
    }>(`/devices/${encodeURIComponent(deviceId)}/metrics${query ? `?${query}` : ''}`)
  },
  homekitHidden: () => get<{ hidden: string[] }>('/homekit/hidden'),
  setHomekitVisibility: (uuid: string, visible: boolean) =>
    fetch(`/api/homekit/visibility/${encodeURIComponent(uuid)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visible }),
    }).then((r) => {
      if (!r.ok) throw new Error(`Visibility change failed: ${r.status}`)
      return r.json() as Promise<{ uuid: string; visible: boolean; changed: boolean; applied: boolean }>
    }),

  /**
   * Per-service HomeKit type overrides: what a service is *presented* as,
   * regardless of what the plugin published. `available` is served by the
   * daemon so the picker can't drift from what it will accept.
   */
  /**
   * The HAP accessory a native plugin published for a device, if any. Native
   * plugins bypass the compat layer, so these never appear in /accessories.
   */
  deviceAccessory: (deviceId: string) =>
    get<{ accessory: Accessory | null }>(`/devices/${encodeURIComponent(deviceId)}/accessory`),

  homekitServiceTypes: () =>
    get<{
      overrides: Record<string, Record<string, string>>
      available: Array<{ key: string; label: string; serviceUuid: string }>
    }>('/homekit/service-types'),
  setHomekitServiceType: (uuid: string, serviceUuid: string, type: string | null) =>
    fetch(`/api/homekit/service-type/${encodeURIComponent(uuid)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceUuid, type }),
    }).then(async (r) => {
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.message ?? `Type change failed: ${r.status}`)
      return r.json() as Promise<{ uuid: string; serviceUuid: string; type: string | null; applied: boolean }>
    }),
  setCharacteristic: (uuid: string, serviceUuid: string, charUuid: string, value: unknown) =>
    fetch(`/api/accessories/${uuid}/characteristics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceUuid, charUuid, value }),
    }).then((r) => {
      if (!r.ok) throw new Error(`Set failed: ${r.status}`)
      return r.json()
    }),
  logs: (plugin?: string, limit = 200) => {
    const q = new URLSearchParams({ limit: String(limit) })
    if (plugin) q.set('plugin', plugin)
    return get<{ entries: LogEntry[] }>(`/logs?${q}`)
  },
  pluginTelemetry: (id: string) =>
    get<{ telemetry: Record<string, Record<string, unknown>> }>(`/plugins/${encodeURIComponent(id)}/telemetry`),
  config: {
    get: () => get<{ content: string }>('/config'),
    save: (content: string) =>
      fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      }).then((r) => {
        if (!r.ok) throw new Error(`Save failed: ${r.status}`)
        return r.json()
      }),
    getPlatform: (name: string) =>
      get<{ config: Record<string, unknown> | null }>(`/config/platform/${encodeURIComponent(name)}`),
    savePlatform: (platform: Record<string, unknown>) =>
      fetch('/api/config/platform', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform }),
      }).then((r) => {
        if (!r.ok) throw new Error(`Save failed: ${r.status}`)
        return r.json()
      }),
    /**
     * Homebridge-compat plugin config, resolved across config.platforms[] and
     * config.plugins[]. `location` reports which one held it so the save goes
     * back to the place the daemon actually reads.
     */
    getHbPlugin: (name: string, packageName?: string) =>
      get<{ config: Record<string, unknown> | null; location: 'platforms' | 'plugins' | null }>(
        `/config/hb-plugin/${encodeURIComponent(name)}${packageName ? `?packageName=${encodeURIComponent(packageName)}` : ''}`,
      ),
    saveHbPlugin: (name: string, config: Record<string, unknown>, packageName?: string) =>
      fetch('/api/config/hb-plugin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, packageName, config }),
      }).then((r) => {
        if (!r.ok) throw new Error(`Save failed: ${r.status}`)
        return r.json()
      }),
    getPlugin: (name: string) =>
      get<{ config: Record<string, unknown> | null }>(`/config/plugin/${encodeURIComponent(name)}`),
    savePlugin: (name: string, config: Record<string, unknown>) =>
      fetch('/api/config/plugin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, config }),
      }).then((r) => {
        if (!r.ok) throw new Error(`Save failed: ${r.status}`)
        return r.json()
      }),
  },
  pluginInfo: (name: string) =>
    get<{ name: string; version: string; mainFile: string; platforms: string[] }>(
      `/marketplace/plugin-info/${encodeURIComponent(name)}`,
    ),
  daemon: {
    restart: () =>
      fetch('/api/daemon/restart', { method: 'POST' }).then((r) => {
        if (!r.ok) throw new Error(`Restart failed: ${r.status}`)
        return r.json()
      }),
  },
  telemetry: {
    get: () => get<TelemetryConfig>('/telemetry'),
    set: (installHeartbeat: boolean) =>
      sendJson<{ saved: true; installHeartbeat: boolean }>('POST', '/telemetry', { installHeartbeat }),
  },
  updates: {
    check: () => get<UpdateStatus>('/updates/check'),
    apply: () =>
      fetch('/api/updates/apply', { method: 'POST' }).then(async (r) => {
        if (!r.ok) throw new Error(await errorMessage(r, 'Update failed'))
        return r.json() as Promise<{ updating: boolean }>
      }),
    rollback: () =>
      fetch('/api/updates/rollback', { method: 'POST' }).then(async (r) => {
        if (!r.ok) throw new Error(await errorMessage(r, 'Rollback failed'))
        return r.json() as Promise<{ rollingBack: boolean; version: string }>
      }),
  },
  marketplace: {
    search: (q = '', from = 0, size = 20) => {
      const params = new URLSearchParams({ q, from: String(from), size: String(size) })
      return get<NpmSearchResult>(`/marketplace/search?${params}`)
    },
    enriched: (name: string) =>
      fetch(`/api/marketplace/enriched/${encodeURIComponent(name)}`).then((r) =>
        r.ok ? (r.json() as Promise<NpmPackage>) : Promise.reject(new Error(`Enrichment failed: ${r.status}`)),
      ),
    installed: () => get<{ packages: InstalledPackage[] }>('/marketplace/installed'),
    local: () => get<{ plugins: LocalPlugin[] }>('/marketplace/local'),
    install: (pkg: string) =>
      fetch('/api/marketplace/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ package: pkg }),
      }).then((r) => {
        if (!r.ok) throw new Error(`Install failed: ${r.status}`)
        return r.json()
      }),
    update: (name: string) =>
      fetch(`/api/marketplace/update/${encodeURIComponent(name)}`, { method: 'POST' }).then((r) => {
        if (!r.ok) throw new Error(`Update failed: ${r.status}`)
        return r.json() as Promise<{ updated: string; version: string; needsRestart: boolean }>
      }),
    uninstall: (pkg: string) =>
      fetch(`/api/marketplace/uninstall/${encodeURIComponent(pkg)}`, { method: 'DELETE' }).then((r) => {
        if (!r.ok) throw new Error(`Uninstall failed: ${r.status}`)
        return r.json()
      }),
  },
}
