const BASE = '/api'

export async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
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
  enrichedMetadata?: Record<string, unknown> // Cached npm metadata (downloads, stars, sponsors, docs url)
  hapBridge?: { setupURI: string; pincode: string; port: number; name: string }
  devices?: Record<string, DeviceDescriptor>
}

export interface AccessoryCharacteristic {
  uuid: string
  name: string
  value: unknown
  format: string
  perms: string[]
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
  releaseUrl?: string
  releaseNotes?: string
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

export interface DeviceDescriptor {
  id: string
  name: string
  widgetType: string
  manufacturer?: string
  model?: string
  pluginId: string
}

export const api = {
  health: () => get<HealthResponse>('/health'),
  system: () => get<SystemInfo>('/system'),
  qr: () => get<{ setupURI: string | null; pincode: string | null }>('/qr'),
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
    get<{ devices: Array<DeviceDescriptor & { telemetry: Record<string, unknown>; pluginStatus: string }> }>(
      '/devices',
    ),
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
  updates: {
    check: () => get<UpdateStatus>('/updates/check'),
    apply: () =>
      fetch('/api/updates/apply', { method: 'POST' }).then((r) => {
        if (!r.ok) throw new Error(`Update failed: ${r.status}`)
        return r.json() as Promise<{ updating: boolean }>
      }),
    rollback: () =>
      fetch('/api/updates/rollback', { method: 'POST' }).then((r) => {
        if (!r.ok) throw new Error(`Rollback failed: ${r.status}`)
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
    uninstall: (pkg: string) =>
      fetch(`/api/marketplace/uninstall/${encodeURIComponent(pkg)}`, { method: 'DELETE' }).then((r) => {
        if (!r.ok) throw new Error(`Uninstall failed: ${r.status}`)
        return r.json()
      }),
  },
}
