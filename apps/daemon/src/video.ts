import type { VideoSource } from '@nubisco/openbridge-core'

/**
 * The video sources plugins registered, by device id. One place, read by the
 * plugin context (which fills it), the HTTP routes (which serve it) and the
 * device list (which says which devices have video).
 */
const sources = new Map<string, VideoSource>()

/**
 * Live viewers per device. Each viewer is its own decoder process on the
 * bridge, so a camera is capped rather than letting a few open tabs take the
 * machine down.
 */
const viewers = new Map<string, number>()
export const MAX_VIEWERS_PER_DEVICE = 3

export const videoSources = {
  set(deviceId: string, source: VideoSource): void {
    sources.set(deviceId, source)
  },
  get(deviceId: string): VideoSource | undefined {
    return sources.get(deviceId)
  },
  has(deviceId: string): boolean {
    return sources.has(deviceId)
  },
  /** Take a viewer slot, or say there is none left. */
  enter(deviceId: string): boolean {
    const n = viewers.get(deviceId) ?? 0
    if (n >= MAX_VIEWERS_PER_DEVICE) return false
    viewers.set(deviceId, n + 1)
    return true
  },
  leave(deviceId: string): void {
    const n = (viewers.get(deviceId) ?? 1) - 1
    if (n <= 0) viewers.delete(deviceId)
    else viewers.set(deviceId, n)
  },
}
