import { describe, it, expect } from 'vitest'
import {
  assessDeviceHealth,
  silenceThresholdSeconds,
  MIN_SILENCE_SECONDS,
  DEFAULT_INTERVAL_SECONDS,
  SILENT_INTERVALS,
} from '../device-health.js'

const NOW = Date.parse('2026-09-23T12:00:00.000Z')
const agoSeconds = (s: number) => new Date(NOW - s * 1000).toISOString()

describe('silenceThresholdSeconds', () => {
  it('never drops below the floor, however fast the device polls', () => {
    // A gate polled every second must not be called stale four seconds later.
    expect(silenceThresholdSeconds(1)).toBe(MIN_SILENCE_SECONDS)
    expect(silenceThresholdSeconds(10)).toBe(MIN_SILENCE_SECONDS)
  })

  it('scales with a slow device so it is not permanently accused', () => {
    // Five minutes between reports is healthy for some devices. A fixed
    // two-minute threshold would mark it stale essentially always.
    expect(silenceThresholdSeconds(300)).toBe(300 * SILENT_INTERVALS)
  })

  it('falls back to a default when the plugin declares nothing', () => {
    expect(silenceThresholdSeconds()).toBe(Math.max(MIN_SILENCE_SECONDS, DEFAULT_INTERVAL_SECONDS * SILENT_INTERVALS))
  })
})

describe('assessDeviceHealth', () => {
  it('is ok while telemetry is arriving', () => {
    const health = assessDeviceHealth({
      telemetry: { _updatedAt: agoSeconds(5) },
      pluginStatus: 'running',
      now: NOW,
    })
    expect(health.status).toBe('ok')
    expect(health.reason).toBeNull()
  })

  it('tolerates a missed poll rather than flickering', () => {
    // One interval late, on a 10s device. Well inside the floor.
    const health = assessDeviceHealth({
      telemetry: { _updatedAt: agoSeconds(20) },
      intervalSeconds: 10,
      pluginStatus: 'running',
      now: NOW,
    })
    expect(health.status).toBe('ok')
  })

  it('reports a device that has gone quiet, and says how long for', () => {
    // The shape of the real outage: the plugin kept running, the device
    // stopped answering, and nothing in the UI said so for 36 hours.
    const health = assessDeviceHealth({
      telemetry: { _updatedAt: agoSeconds(36 * 3600) },
      intervalSeconds: 10,
      pluginStatus: 'running',
      now: NOW,
    })
    expect(health.status).toBe('stale')
    expect(health.silentForSeconds).toBeCloseTo(36 * 3600, 0)
    expect(health.reason).toMatch(/36 hours/)
    // The two causes actually seen, named so the reader has somewhere to start.
    expect(health.reason).toMatch(/address/i)
  })

  it('blames the plugin when the plugin is the reason, not the device', () => {
    const health = assessDeviceHealth({
      telemetry: { _updatedAt: agoSeconds(99999) },
      pluginStatus: 'error',
      now: NOW,
    })
    expect(health.status).toBe('stale')
    expect(health.reason).toMatch(/plugin is error/)
    // Saying "silent for a day" would be true and useless: nothing is polling.
    expect(health.reason).not.toMatch(/No response/)
  })

  it('treats a device that has never reported as unknown, not as broken', () => {
    // Covers both a device still starting up and a plugin that reports no
    // telemetry at all. Neither is a fault, and neither should raise an alarm.
    const health = assessDeviceHealth({ telemetry: {}, pluginStatus: 'running', now: NOW })
    expect(health.status).toBe('unknown')
    expect(health.reason).toBeNull()
    expect(health.lastSeen).toBeNull()
  })

  it('ignores a stamp it cannot parse instead of inventing an age', () => {
    const health = assessDeviceHealth({
      telemetry: { _updatedAt: 'not a date' },
      pluginStatus: 'running',
      now: NOW,
    })
    expect(health.status).toBe('unknown')
  })

  it('never reports negative silence when a device clock runs ahead', () => {
    const health = assessDeviceHealth({
      telemetry: { _updatedAt: new Date(NOW + 60_000).toISOString() },
      pluginStatus: 'running',
      now: NOW,
    })
    expect(health.status).toBe('ok')
    expect(health.silentForSeconds).toBe(0)
  })
})
