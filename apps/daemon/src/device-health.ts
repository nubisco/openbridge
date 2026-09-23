/**
 * Is a device still answering?
 *
 * This exists because of a real outage. Two Shellys and six bulbs lost their
 * DHCP reservations, moved, and went unreachable for thirty-six hours. The
 * daemon knew the whole time, in the sense that its log filled with timeouts
 * and its poll loops stopped reporting, but the UI showed a tidy list of
 * devices and said nothing at all. The failure was discovered from HomeKit.
 *
 * The signal was already being recorded and nobody was reading it.
 * `reportTelemetry` stamps `_updatedAt` on every device of every plugin, so a
 * device that has stopped answering is a device whose stamp has stopped
 * moving. That is worth more than asking plugins to report health, because it
 * needs no cooperation: a plugin that fails to poll cannot forget to say so,
 * and a plugin written before this existed is covered anyway.
 *
 * Deliberately a pure function over a clock. Anything that decides whether to
 * raise an alarm has to be testable without waiting for real time to pass.
 */
import type { DeviceHealth } from '@nubisco/openbridge-core'

/**
 * Silence below this is never interesting, whatever the device's interval.
 *
 * A poll can be late for reasons that are not a fault: a slow device, a
 * retried request, a busy host. Flagging a device that is one cycle behind
 * would make the indicator meaningless within a day, and an indicator people
 * learn to ignore is worse than no indicator, because it also discredits the
 * true ones next to it.
 */
export const MIN_SILENCE_SECONDS = 120

/**
 * How many expected intervals of silence before saying so.
 *
 * Four rather than two: a device is allowed to miss a poll and still be
 * healthy, and the cost of noticing an outage a minute later is far lower than
 * the cost of an indicator that flickers.
 */
export const SILENT_INTERVALS = 4

/** Default assumed reporting interval when a plugin does not declare one. */
export const DEFAULT_INTERVAL_SECONDS = 30

export interface HealthInput {
  /** The device's telemetry, as reported. `_updatedAt` is the field read. */
  telemetry?: Record<string, unknown>
  /** `telemetryIntervalSeconds` from the descriptor, when declared. */
  intervalSeconds?: number
  /** The owning plugin's status, which overrides everything below it. */
  pluginStatus?: string
  /** Now, injected so this is testable. */
  now?: number
}

/** Seconds of silence tolerated for a device before it is called stale. */
export function silenceThresholdSeconds(intervalSeconds?: number): number {
  const interval = intervalSeconds && intervalSeconds > 0 ? intervalSeconds : DEFAULT_INTERVAL_SECONDS
  return Math.max(MIN_SILENCE_SECONDS, interval * SILENT_INTERVALS)
}

function humanDuration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} seconds`
  const minutes = seconds / 60
  if (minutes < 90) return `${Math.round(minutes)} minutes`
  const hours = minutes / 60
  if (hours < 48) return `${Math.round(hours)} hours`
  return `${Math.round(hours / 24)} days`
}

export function assessDeviceHealth(input: HealthInput): DeviceHealth {
  const now = input.now ?? Date.now()

  // A plugin that is not running explains every one of its devices at once,
  // and says something more useful than "silent for 3 hours" would. Checked
  // first for that reason: the device is not the problem.
  if (input.pluginStatus && input.pluginStatus !== 'running') {
    return {
      status: 'stale',
      lastSeen: readStamp(input.telemetry),
      silentForSeconds: silentFor(input.telemetry, now),
      reason: `Its plugin is ${input.pluginStatus}, so nothing is polling this device.`,
    }
  }

  const lastSeen = readStamp(input.telemetry)
  if (!lastSeen) {
    return {
      status: 'unknown',
      lastSeen: null,
      silentForSeconds: null,
      reason: null,
    }
  }

  const silent = silentFor(input.telemetry, now) ?? 0
  const threshold = silenceThresholdSeconds(input.intervalSeconds)
  if (silent < threshold) {
    return { status: 'ok', lastSeen, silentForSeconds: silent, reason: null }
  }

  return {
    status: 'stale',
    lastSeen,
    silentForSeconds: silent,
    reason: `No response for ${humanDuration(silent)}. It may be powered off, or its address may have changed.`,
  }
}

function readStamp(telemetry?: Record<string, unknown>): string | null {
  const raw = telemetry?._updatedAt
  if (typeof raw !== 'string') return null
  return Number.isNaN(Date.parse(raw)) ? null : raw
}

function silentFor(telemetry: Record<string, unknown> | undefined, now: number): number | null {
  const stamp = readStamp(telemetry)
  if (!stamp) return null
  // Clamped at zero: a device whose clock runs ahead of the host would
  // otherwise report negative silence, which reads as nonsense in the UI.
  return Math.max(0, (now - Date.parse(stamp)) / 1000)
}
