import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

/**
 * What a person reported about a room, with the machine's own numbers attached.
 *
 * Some devices control a variable they cannot measure. A heat pump with no room
 * sensor is told what temperature water to send out, and whether that actually
 * keeps the house warm is knowable only to whoever lives there. Everything else
 * in that loop is inference: the "current temperature" a heat pump reports is
 * usually its own return water, not the room.
 *
 * So this is the one real measurement in the chain, and it arrives by someone
 * typing it in. Each report is stored with the machine state at that moment, so
 * it can later be read as a labelled sample: at this outside temperature, with
 * this setpoint, the house was actually this.
 *
 * Deliberately never rolled. The event log next door caps and rotates because
 * it is a high-volume timeline; these are sparse (a handful a month at most),
 * span seasons, and a calibration dataset that silently discarded last winter
 * would be worse than none. The size guard exists only to catch a bug writing
 * in a loop.
 */
export interface DeviceObservation {
  /** ISO-8601, set here so a client cannot disagree about the clock. */
  at: string
  /** What the person reported the room actually is. */
  roomTemperature: number
  /**
   * Their verdict, which is often worth more than the number.
   *
   * A thermometer can be two degrees off and the reading still useless on its
   * own, but "this is too cold" is never wrong about the thing that matters.
   * It also makes "about right" samples identifiable, and those are the ones a
   * curve most needs and a frustrated user least often files.
   */
  comfort: 'cold' | 'ok' | 'warm'
  /** Anything the person wants to add: "sunny all afternoon", "window open". */
  note?: string
  /**
   * Machine state captured at submit time, supplied by the plugin.
   *
   * Without this a report is unusable. A house at 24 degrees with cold
   * radiators on a sunny afternoon and a house at 24 degrees that the heating
   * worked to reach are the same number and opposite evidence.
   */
  context?: Record<string, unknown>
}

/** Refuse to grow past this; reaching it means something is writing in a loop. */
const MAX_BYTES = 4 * 1024 * 1024
/** Most a single query returns, newest first. */
export const MAX_QUERY = 1000

export class ObservationStore {
  private dir: string

  constructor(home: string) {
    this.dir = join(home, 'observations')
  }

  private fileFor(deviceId: string): string {
    // Device ids come from plugins and reach the filesystem here, so anything
    // that could climb out of the directory is replaced rather than trusted.
    const safe = deviceId.replace(/[^A-Za-z0-9._-]/g, '_')
    return join(this.dir, `${safe}.jsonl`)
  }

  /**
   * Records one observation.
   *
   * JSON lines rather than a JSON array: appending to an array means reading
   * and rewriting the whole file every time, which is what made the energy
   * history slow enough to need rewriting.
   */
  append(deviceId: string, observation: DeviceObservation): void {
    mkdirSync(this.dir, { recursive: true })
    const file = this.fileFor(deviceId)

    if (existsSync(file) && statSync(file).size > MAX_BYTES) {
      throw new Error(`Observation log for ${deviceId} has exceeded ${MAX_BYTES} bytes and was not appended to`)
    }

    appendFileSync(file, JSON.stringify(observation) + '\n', 'utf8')
  }

  /** Observations for a device, newest first. */
  list(deviceId: string, limit = 100): DeviceObservation[] {
    const file = this.fileFor(deviceId)
    if (!existsSync(file)) return []

    const capped = Math.min(Math.max(1, limit), MAX_QUERY)
    const lines = readFileSync(file, 'utf8').split('\n')
    const out: DeviceObservation[] = []

    // Backwards, so a long history does not cost a full parse to show ten rows.
    for (let i = lines.length - 1; i >= 0 && out.length < capped; i--) {
      const line = lines[i]?.trim()
      if (!line) continue
      try {
        out.push(JSON.parse(line) as DeviceObservation)
      } catch {
        // One torn line, from a power cut mid-append, must not take the rest
        // of the history with it.
      }
    }
    return out
  }

  /** How many observations exist, for showing whether there is enough to judge. */
  count(deviceId: string): number {
    const file = this.fileFor(deviceId)
    if (!existsSync(file)) return 0
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim()).length
  }
}

/** Rejects anything that would poison the dataset, returning why. */
export function validateObservation(
  body: unknown,
): { ok: true; value: DeviceObservation } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'body must be an object' }
  const b = body as Record<string, unknown>

  const temp = Number(b.roomTemperature)
  if (!Number.isFinite(temp)) return { ok: false, error: 'roomTemperature must be a number' }
  // Wide on purpose: this is a sanity bound against a typo or a Fahrenheit
  // reading, not an opinion about what a comfortable room is.
  if (temp < -20 || temp > 60) return { ok: false, error: 'roomTemperature must be between -20 and 60' }

  const comfort = b.comfort
  if (comfort !== 'cold' && comfort !== 'ok' && comfort !== 'warm') {
    return { ok: false, error: "comfort must be 'cold', 'ok' or 'warm'" }
  }

  const note = b.note === undefined || b.note === null ? undefined : String(b.note).slice(0, 500)

  return {
    ok: true,
    value: {
      at: new Date().toISOString(),
      roomTemperature: temp,
      comfort,
      ...(note ? { note } : {}),
    },
  }
}
