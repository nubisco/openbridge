import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, existsSync } from 'fs'
import { join } from 'path'

/**
 * A per-device record of things that happened.
 *
 * Distinct from the metric history next door, which stores numbers on a clock:
 * volts every five minutes, charted as a line. An event is discrete and has a
 * cause. "Opened, because HomeKit asked" is not a sample of anything, and
 * forcing it into fixed-width floats would lose the only part worth keeping.
 *
 * The daemon log is not a substitute. It is one text stream for every plugin at
 * once, it has no structure, and on the reference install it reached 102 MB, so
 * finding the four lines about a gate means grepping a file that is mostly
 * something else. This is queryable, per device, and bounded.
 *
 * Stored as JSON lines rather than a JSON array, because appending to an array
 * means reading and rewriting the whole file on every event. The energy history
 * did exactly that and it is why the metric store was rewritten.
 */

export interface DeviceEvent {
  /** ISO-8601, set here so plugins cannot disagree about the clock. */
  at: string
  /**
   * A short machine-readable kind, e.g. "opened", "command", "fault". Free-form
   * by design: a plugin knows what its device does and the UI only groups by it.
   */
  type: string
  /** One line, written for a person reading a timeline. */
  message: string
  /** What caused it, when that is known: "homekit", "schedule", "device". */
  source?: string
  /** Anything structured worth keeping, small. */
  data?: Record<string, unknown>
}

/** Above this, the file is rolled to `.1` and started again. */
const MAX_BYTES = 1024 * 1024
/** Most a single query will return, newest first. */
export const MAX_QUERY = 500

export class DeviceEventLog {
  constructor(private readonly dir: string) {}

  /**
   * Append one event.
   *
   * Never throws. A device event is a diagnostic, and a plugin that cannot
   * write one must still be able to run the device it belongs to.
   */
  record(deviceId: string, event: Omit<DeviceEvent, 'at'> & { at?: string }): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      const path = this.pathFor(deviceId)
      this.rollIfLarge(path)
      const line: DeviceEvent = {
        at: event.at ?? new Date().toISOString(),
        type: event.type,
        message: event.message,
        ...(event.source ? { source: event.source } : {}),
        ...(event.data ? { data: event.data } : {}),
      }
      appendFileSync(path, JSON.stringify(line) + '\n')
    } catch {
      /* diagnostics must not break the device they describe */
    }
  }

  /**
   * The most recent events, newest first.
   *
   * Reads the rolled file too when the current one is short, so a query right
   * after a roll does not look like the device just appeared.
   */
  read(deviceId: string, limit = 100): DeviceEvent[] {
    const capped = Math.min(Math.max(limit, 1), MAX_QUERY)
    const lines = [...this.linesOf(`${this.pathFor(deviceId)}.1`), ...this.linesOf(this.pathFor(deviceId))]
    const events: DeviceEvent[] = []
    for (const line of lines) {
      try {
        events.push(JSON.parse(line) as DeviceEvent)
      } catch {
        /* a torn write at the tail: skip it rather than fail the query */
      }
    }
    return events.slice(-capped).reverse()
  }

  private linesOf(path: string): string[] {
    try {
      return readFileSync(path, 'utf8').split('\n').filter(Boolean)
    } catch {
      return []
    }
  }

  private pathFor(deviceId: string): string {
    // Device ids come from plugins and reach the filesystem here, so anything
    // that could climb out of the directory is flattened rather than trusted.
    return join(this.dir, `${deviceId.replace(/[^a-zA-Z0-9._-]/g, '_')}.jsonl`)
  }

  private rollIfLarge(path: string): void {
    try {
      if (!existsSync(path) || statSync(path).size <= MAX_BYTES) return
      renameSync(path, `${path}.1`)
    } catch {
      /* keep appending rather than lose the event */
    }
  }
}
