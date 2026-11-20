/**
 * The marks along a ruler, for a scale in screen pixels per metre. The step
 * between numbered marks is the smallest of 1, 2 or 5 times a power of ten
 * that leaves room for its number, and the marks between them are as fine as
 * still reads (tenths, fifths, halves or none).
 */
export interface RulerTick {
  /** Screen position along the ruler, in pixels from its start. */
  at: number
  /** The distance in metres, on a numbered mark only. */
  label?: string
  /** 1 for a numbered mark, 0.5 for a halfway mark, 0.3 for the rest. */
  size: number
}

/** A ruler's thickness, in pixels. */
export const RULER_SIZE = 20

/** The least room a number gets, in pixels. */
const MIN_LABEL_PX = 56
/** The least room between two small marks, in pixels. */
const MIN_TICK_PX = 5

export function rulerStep(pxPerM: number): number {
  for (let exp = -3; exp <= 6; exp++) {
    for (const m of [1, 2, 5]) {
      const step = m * 10 ** exp
      if (step * pxPerM >= MIN_LABEL_PX) return step
    }
  }
  return 10 ** 6
}

function subdivisions(step: number, pxPerM: number): number {
  const lead = Math.round(step / 10 ** Math.floor(Math.log10(step) + 1e-9))
  const options = lead === 2 ? [4, 2] : lead === 5 ? [5] : [10, 5, 2]
  return options.find((n) => (step / n) * pxPerM >= MIN_TICK_PX) ?? 1
}

/** A distance as the ruler prints it: no trailing zeros, no float noise. */
export function rulerLabel(metres: number, step: number): string {
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9))
  const v = Number(metres.toFixed(decimals))
  return String(Object.is(v, -0) ? 0 : v)
}

/**
 * The marks along a ruler `length` pixels long, where metre 0 is at `origin`
 * pixels from its start.
 */
export function rulerTicks(pxPerM: number, origin: number, length: number): RulerTick[] {
  if (!(pxPerM > 0) || !(length > 0)) return []
  const step = rulerStep(pxPerM)
  const n = subdivisions(step, pxPerM)
  const minor = step / n
  const first = Math.ceil(-origin / pxPerM / minor)
  const last = Math.floor((length - origin) / pxPerM / minor)
  const ticks: RulerTick[] = []
  for (let i = first; i <= last; i++) {
    const metres = i * minor
    const at = origin + metres * pxPerM
    if (i % n === 0) ticks.push({ at, label: rulerLabel(metres, step), size: 1 })
    else ticks.push({ at, size: n % 2 === 0 && i % (n / 2) === 0 ? 0.5 : 0.3 })
  }
  return ticks
}
