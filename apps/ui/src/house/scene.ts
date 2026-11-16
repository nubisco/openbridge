/**
 * The live House view as SVG markup, one floor at a time.
 *
 * Built as a string, not as Vue nodes: a floor is a few hundred shapes that
 * all change together every poll, depth-sorted for the isometric view, which
 * a template cannot express without a component per shape. Every piece of
 * text that reaches the markup goes through `esc`. Devices are real focusable
 * elements (`role="button"`, a label, `data-ref`), and the view handles taps
 * and keys on the stage by delegation.
 */
import type { HouseFloor, HousePlacement, HousePlan } from '@/api'
import {
  CELLS_PER_M,
  ISO_FLOOR_MATRIX,
  S,
  clamp,
  circuitPath,
  esc,
  floorBounds,
  humidityColor,
  lerp,
  project,
  r1,
  roomAt,
  roomTempColor,
  wallRuns,
  waterColor,
  type Point,
  type ViewMode,
} from './geometry'
import { formatPower, stateText, type LiveDevice } from './live'

export const WARM_LIGHT = '#ffb45e'

export interface SceneOptions {
  mode: ViewMode
  walls: 'up' | 'low'
  overlay: 'none' | 'temperature' | 'humidity'
  labels: boolean
  selected: string | null
  /** Screen pixels per stage unit, so markers keep their size at any zoom. */
  unit: number
  /** Narrow stage: shorter badges. */
  compact: boolean
  /** Vertical offset of each floor on the stage, for drawing risers between them. */
  offsets: Record<string, Point>
  /** Every floor is on screen (the exploded view). */
  all: boolean
}

export const wallHeight = (o: Pick<SceneOptions, 'mode' | 'walls'>) =>
  o.mode === 'flat' ? 0 : o.walls === 'up' ? 1.35 * CELLS_PER_M : 0.4 * CELLS_PER_M

const ICON = {
  drop: '<path d="M0,-6 C3,-2 4.5,0 4.5,2.5 A4.5,4.5 0 1 1 -4.5,2.5 C-4.5,0 -3,-2 0,-6Z" fill="#6fd0ff"/>',
  bolt: '<path d="M1.5,-7 L-4,1 H-0.5 L-1.5,7 L4,-1 H0.5 Z" fill="#ffd24d"/>',
  heat: '<path d="M-4,4 C-6,0 -2,-1 -3,-6 M0,4 C-2,0 2,-1 1,-6 M4,4 C2,0 6,-1 5,-6" fill="none" stroke="#ff8a5c" stroke-width="1.5" stroke-linecap="round"/>',
  camera:
    '<rect x="-6" y="-4" width="9" height="8" rx="1.5" fill="none" stroke="#9fd0ff" stroke-width="1.5"/><path d="M3,-1.5 L6.5,-3.5 V3.5 L3,1.5" fill="none" stroke="#9fd0ff" stroke-width="1.5" stroke-linejoin="round"/>',
  gate: '<path d="M-6,4 V-4 M6,4 V-4 M-6,-1 H6 M-3,-1 V4 M0,-1 V4 M3,-1 V4" fill="none" stroke="#ffc76b" stroke-width="1.4" stroke-linecap="round"/>',
  power: (on: boolean) =>
    `<path d="M0,-5.5 V-0.5 M-3.6,-3.4 A5,5 0 1 0 3.6,-3.4" fill="none" stroke="${on ? '#57d98a' : '#8fa3c4'}" stroke-width="1.8" stroke-linecap="round"/>`,
}

function pill(text: string, opt: { icon?: string; cls?: string } = {}): string {
  const w = text.length * 6.3 + 18 + (opt.icon ? 15 : 0)
  return (
    `<rect class="hv-pill ${opt.cls ?? ''}" x="${r1(-w / 2)}" y="-11" width="${r1(w)}" height="22" rx="11"/>` +
    (opt.icon ? `<g transform="translate(${r1(-w / 2 + 13)},0)">${opt.icon}</g>` : '') +
    `<text class="hv-pilltxt" x="${opt.icon ? 7 : 0}" y="4" text-anchor="middle">${esc(text)}</text>`
  )
}

/** A ref or id made safe for an SVG id and a url(#...) reference. */
const svgId = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_')

function label(d: LiveDevice): string {
  const s = stateText(d)
  return esc(s ? `${d.name}, ${s}` : d.name)
}

/** A marker that stands on the floor at (x,y), raised to height z with a drop line. */
function marker(o: SceneOptions, d: LiveDevice, x: number, y: number, z: number, inner: string): string {
  const p = project(o.mode, x, y, z)
  const p0 = project(o.mode, x, y, 0)
  const drop = (p0[1] - p[1]) / o.unit
  const sel = o.selected === d.ref
  return (
    `<g class="hv-dev${d.reachable ? '' : ' hv-off'}" data-ref="${esc(d.ref)}" role="button" tabindex="0" ` +
    `aria-label="${label(d)}" transform="translate(${r1(p[0])},${r1(p[1])}) scale(${o.unit.toFixed(4)})">` +
    (drop > 2
      ? `<line class="hv-drop" x1="0" y1="0" x2="0" y2="${r1(drop)}"/><ellipse class="hv-foot" cx="0" cy="${r1(drop)}" rx="5" ry="2.5"/>`
      : '') +
    '<circle class="hv-hit" r="20"/>' +
    (sel ? '<circle class="hv-selring" r="18"/>' : '') +
    inner +
    '</g>'
  )
}

function poly(o: SceneOptions, pts: Array<[number, number, number]>): string {
  return pts
    .map(([x, y, z]) => {
      const p = project(o.mode, x, y, z)
      return `${r1(p[0])},${r1(p[1])}`
    })
    .join(' ')
}

/**
 * A circuit's pipe. With one water temperature the pipe is that colour along
 * its length. With supply and return it shades from one to the other, cut
 * into short pieces so the shading follows the pipe round every bend.
 */
function pipe(
  o: SceneOptions,
  pts: Point[],
  supply: number | undefined,
  ret: number | undefined,
  flowing: boolean,
): string {
  const w = Math.max(5, 2.6 * o.unit)
  const points = pts.map(([x, y]) => project(o.mode, x, y, 0.04)).map((p) => `${r1(p[0])},${r1(p[1])}`)
  const opacity = flowing ? 0.95 : 0.5
  let s = ''
  if (supply !== undefined && ret !== undefined) {
    const lens = pts.slice(1).map((p, i) => Math.abs(p[0] - pts[i][0]) + Math.abs(p[1] - pts[i][1]))
    const total = lens.reduce((a, b) => a + b, 0) || 1
    let acc = 0
    let pieces = ''
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]
      const b = pts[i]
      const n = Math.max(1, Math.ceil(lens[i - 1]))
      for (let j = 0; j < n; j++) {
        const p = project(o.mode, lerp(a[0], b[0], j / n), lerp(a[1], b[1], j / n), 0.04)
        const q = project(o.mode, lerp(a[0], b[0], (j + 1) / n), lerp(a[1], b[1], (j + 1) / n), 0.04)
        const t = (acc + ((j + 0.5) / n) * lens[i - 1]) / total
        pieces += `<line x1="${r1(p[0])}" y1="${r1(p[1])}" x2="${r1(q[0])}" y2="${r1(q[1])}" stroke="${waterColor(lerp(supply, ret, t))}"/>`
      }
      acc += lens[i - 1]
    }
    s = `<g class="hv-pipe" stroke-width="${r1(w)}" opacity="${opacity}">${pieces}</g>`
  } else {
    const color = waterColor(supply ?? 20)
    s = `<polyline class="hv-pipe" points="${points.join(' ')}" stroke="${color}" stroke-width="${r1(w)}" opacity="${opacity}"/>`
  }
  if (flowing) s += `<polyline class="hv-flow" stroke-width="${r1(w * 0.36)}" points="${points.join(' ')}"/>`
  return s
}

/**
 * One floor. `devices` holds every live device by ref, and the floor's own
 * placements decide which of them appear here.
 */
export function renderFloor(
  plan: HousePlan,
  floor: HouseFloor,
  devices: Map<string, LiveDevice>,
  o: SceneOptions,
): string {
  const iso = o.mode === 'iso'
  const H = wallHeight(o)
  const b = floorBounds(plan, floor)
  const placed = floor.placements
    .map((p) => ({ p, d: devices.get(p.ref) }))
    .filter((x): x is { p: HousePlacement; d: LiveDevice } => !!x.d)
  let defs = ''
  let base = ''
  let glow = ''
  let pipes = ''
  const items: Array<{ depth: number; svg: string }> = []

  // Ground plate, edges and grid (one line per metre).
  if (iso) {
    const t = 0.4
    base += `<polygon class="hv-plate-side" points="${poly(o, [
      [b.x, b.y + b.h, 0],
      [b.x + b.w, b.y + b.h, 0],
      [b.x + b.w, b.y + b.h, -t],
      [b.x, b.y + b.h, -t],
    ])}"/>`
    base += `<polygon class="hv-plate-side" points="${poly(o, [
      [b.x + b.w, b.y, 0],
      [b.x + b.w, b.y + b.h, 0],
      [b.x + b.w, b.y + b.h, -t],
      [b.x + b.w, b.y, -t],
    ])}"/>`
  }
  base += `<polygon class="hv-plate${o.all ? ' hv-pick' : ''}" data-plate="${esc(floor.id)}" points="${poly(o, [
    [b.x, b.y, 0],
    [b.x + b.w, b.y, 0],
    [b.x + b.w, b.y + b.h, 0],
    [b.x, b.y + b.h, 0],
  ])}"/>`
  let grid = ''
  const line = (x1: number, y1: number, x2: number, y2: number) => {
    const p = project(o.mode, x1, y1)
    const q = project(o.mode, x2, y2)
    grid += `M${r1(p[0])},${r1(p[1])}L${r1(q[0])},${r1(q[1])}`
  }
  for (let x = b.x + CELLS_PER_M; x < b.x + b.w; x += CELLS_PER_M) line(x, b.y, x, b.y + b.h)
  for (let y = b.y + CELLS_PER_M; y < b.y + b.h; y += CELLS_PER_M) line(b.x, y, b.x + b.w, y)
  base += `<path class="hv-grid" d="${grid}"/>`

  // Rooms, with the overlay tint from a sensor in the room.
  const roomOf = (p: HousePlacement) => roomAt(floor, p.x, p.y)
  for (const r of floor.rooms) {
    const pts = poly(o, [
      [r.x, r.y, 0],
      [r.x + r.w, r.y, 0],
      [r.x + r.w, r.y + r.h, 0],
      [r.x, r.y + r.h, 0],
    ])
    defs += `<clipPath id="hv-cp-${svgId(floor.id)}-${svgId(r.id)}"><polygon points="${pts}"/></clipPath>`
    let style = ''
    let extra = ''
    if (o.overlay !== 'none' && r.kind === 'room') {
      const reading = placed
        .filter(({ p, d }) => d.reachable && roomOf(p) === r && !p.opening)
        .map(({ d }) => (o.overlay === 'temperature' ? (d.kind === 'heating' ? undefined : d.temperature) : d.humidity))
        .find((v) => v !== undefined)
      if (reading !== undefined) {
        const fill = o.overlay === 'temperature' ? roomTempColor(reading) : humidityColor(reading)
        style = ` style="fill:${fill};fill-opacity:0.42"`
        extra = o.overlay === 'temperature' ? ` ${reading.toFixed(1)}°` : ` ${Math.round(reading)}%`
      } else style = ' style="fill-opacity:0.04"'
    }
    base += `<polygon class="hv-room hv-k-${r.kind}"${style} points="${pts}"/>`
    if (r.kind === 'pool') {
      const running = placed.some(({ p, d }) => roomOf(p) === r && d.on && d.kind !== 'light')
      for (let yy = r.y + 1.2; yy < r.y + r.h - 0.4; yy += 1.6) {
        const a = project(o.mode, r.x + 0.6, yy)
        const c = project(o.mode, r.x + r.w - 0.6, yy)
        base += `<path class="hv-ripple${running ? ' hv-on' : ''}" d="M${r1(a[0])},${r1(a[1])}L${r1(c[0])},${r1(c[1])}"/>`
      }
    }
    if (o.labels || extra) {
      const name = (o.labels ? r.name : '').concat(extra).trim()
      const c = project(o.mode, r.x + r.w / 2, r.y + r.h / 2)
      const fs = Math.min(11 * o.unit, (r.w * S * 0.86) / Math.max(1, name.length * 0.72), r.h * S * 0.3)
      base += `<text class="hv-rlabel" transform="translate(${r1(c[0])},${r1(c[1])}) ${iso ? ISO_FLOOR_MATRIX : ''}" font-size="${r1(fs)}" dy="${r1(fs * 0.35)}">${esc(name)}</text>`
    }
  }

  // Light pools on the floor, clipped to the room the lamp is in.
  for (const { p, d } of placed) {
    if (d.kind !== 'light' || !d.on || !d.reachable) continue
    const k = clamp((d.brightness ?? 80) / 100, 0.08, 1)
    const color = d.color ?? p.color ?? WARM_LIGHT
    const r = roomOf(p)
    const R = (1.3 + 2.5 * k) * CELLS_PER_M
    const c = project(o.mode, p.x, p.y)
    const gid = `hv-lg-${svgId(floor.id)}-${svgId(p.ref)}`
    defs +=
      `<radialGradient id="${gid}"><stop offset="0" stop-color="${color}" stop-opacity="${(0.3 + 0.6 * k).toFixed(2)}"/>` +
      `<stop offset="0.5" stop-color="${color}" stop-opacity="${(0.1 + 0.22 * k).toFixed(2)}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>`
    glow +=
      `<ellipse cx="${r1(c[0])}" cy="${r1(c[1])}" rx="${r1(R * S * (iso ? 1.2247 : 1))}" ry="${r1(R * S * (iso ? 0.7071 : 1))}" ` +
      `fill="url(#${gid})"${r ? ` clip-path="url(#hv-cp-${svgId(floor.id)}-${svgId(r.id)})"` : ''} pointer-events="none"/>`
  }

  // Heating circuits. A device on one floor can serve rooms on another, so
  // every placement on every floor is checked for rooms on this one.
  for (const f of plan.floors) {
    for (const p of f.placements) {
      if (!p.circuitRooms?.length) continue
      const d = devices.get(p.ref)
      const rooms = p.circuitRooms
        .map((id) => floor.rooms.find((r) => r.id === id))
        .filter((r): r is NonNullable<typeof r> => !!r)
      if (!rooms.length) continue
      const flowing = !!d?.on && !!d.reachable
      const supply = d?.supply ?? d?.temperature
      const color = waterColor(supply ?? 20)
      // On another floor the circuit rises at the same spot, so it starts there.
      const pts = circuitPath({ x: p.x, y: p.y }, rooms)
      if (!pts) continue
      pipes += pipe(o, pts, supply, d?.return, flowing)
      if (f.id !== floor.id) {
        // The riser: where the circuit arrives from the floor its source is on.
        const at = project(o.mode, p.x, p.y)
        if (iso && o.all && o.offsets[f.id] && o.offsets[floor.id]) {
          const len = o.offsets[f.id][1] - o.offsets[floor.id][1] - 0.8 * CELLS_PER_M * S
          pipes += `<line x1="${r1(at[0])}" y1="${r1(at[1])}" x2="${r1(at[0])}" y2="${r1(at[1] + len)}" stroke="${color}" stroke-width="4" stroke-linecap="round" opacity="0.9"/>`
        }
        pipes += `<circle cx="${r1(at[0])}" cy="${r1(at[1])}" r="${r1(5 * o.unit)}" fill="#0a1830" stroke="${color}" stroke-width="${r1(2 * o.unit)}"/>`
      }
    }
  }

  // Walls, doors, windows, and the shutters that sit on windows.
  const shutters = new Map<string, LiveDevice>()
  for (const { p, d } of placed) if (p.opening) shutters.set(p.opening, d)
  for (const w of wallRuns(floor)) {
    const depth = (w.x1 + w.x2 + w.y1 + w.y2) / 2
    const A: Point = [w.x1, w.y1]
    const B: Point = [w.x2, w.y2]
    const sh = w.opening ? shutters.get(w.opening.id) : undefined
    let svg = ''
    if (!iso) {
      const a = project(o.mode, A[0], A[1])
      const c = project(o.mode, B[0], B[1])
      const ln = (cls: string, p: Point, q: Point, extra = '') =>
        `<line class="${cls}" x1="${r1(p[0])}" y1="${r1(p[1])}" x2="${r1(q[0])}" y2="${r1(q[1])}"${extra}/>`
      if (w.type === 'wall') svg = ln('hv-wall2d', a, c)
      else if (w.type === 'door') {
        const len = Math.hypot(c[0] - a[0], c[1] - a[1])
        const corner = w.axis === 'h' ? `${r1(a[0])},${r1(a[1] + len)}` : `${r1(a[0] + len)},${r1(a[1])}`
        svg = `<path class="hv-door" d="M${r1(a[0])},${r1(a[1])} L${corner} A${r1(len)},${r1(len)} 0 0 ${w.axis === 'h' ? 0 : 1} ${r1(c[0])},${r1(c[1])}"/>`
      } else {
        svg = ln('hv-wall2d hv-glass2d', a, c) + ln('hv-pane2d', a, c)
        if (sh) {
          const closed = 1 - clamp(sh.position ?? 100, 0, 100) / 100
          const m: Point = [lerp(a[0], c[0], closed), lerp(a[1], c[1], closed)]
          const mid: Point = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2]
          svg =
            `<g class="hv-dev${sh.reachable ? '' : ' hv-off'}" data-ref="${esc(sh.ref)}" role="button" tabindex="0" aria-label="${label(sh)}">` +
            svg +
            (closed > 0.01 ? ln('hv-slats2d', a, m) : '') +
            `<circle class="hv-hit" cx="${r1(mid[0])}" cy="${r1(mid[1])}" r="${r1(18 * o.unit)}"/></g>` +
            `<g transform="translate(${r1(mid[0])},${r1(mid[1] - 16 * o.unit)}) scale(${o.unit.toFixed(4)})" pointer-events="none">` +
            pill(`${Math.round(sh.position ?? 0)}%`, { cls: o.selected === sh.ref ? 'hv-on' : '' }) +
            '</g>'
        }
      }
      items.push({ depth, svg })
      continue
    }
    const quad = (z1: number, z2: number) =>
      poly(o, [
        [A[0], A[1], z1],
        [B[0], B[1], z1],
        [B[0], B[1], z2],
        [A[0], A[1], z2],
      ])
    if (w.type === 'wall') {
      svg = `<polygon class="hv-wall" points="${quad(0, H)}"/><polygon class="hv-walledge" points="${quad(0, H)}"/>`
    } else if (w.type === 'door') {
      const hd = Math.min(H, 1.05 * CELLS_PER_M)
      svg = `<polyline class="hv-door" points="${poly(o, [
        [A[0], A[1], 0],
        [A[0], A[1], hd],
        [B[0], B[1], hd],
        [B[0], B[1], 0],
      ])}"/>`
      if (H > hd + 0.1)
        svg += `<polygon class="hv-wall" points="${quad(hd, H)}"/><polygon class="hv-walledge" points="${quad(hd, H)}"/>`
    } else {
      const z0 = H * 0.3
      svg = `<polygon class="hv-wall" points="${quad(0, z0)}"/><polygon class="hv-walledge" points="${quad(0, H)}"/><polygon class="hv-pane" points="${quad(z0, H)}"/>`
      if (sh) {
        const closed = 1 - clamp(sh.position ?? 100, 0, 100) / 100
        const zb = H - (H - z0) * closed
        let slats = ''
        if (closed > 0.01) {
          slats = `<polygon class="hv-slats" points="${quad(zb, H)}"/>`
          for (let z = H - 0.18; z > zb + 0.04; z -= 0.18) {
            const p = project(o.mode, A[0], A[1], z)
            const q = project(o.mode, B[0], B[1], z)
            slats += `<line class="hv-slatl" x1="${r1(p[0])}" y1="${r1(p[1])}" x2="${r1(q[0])}" y2="${r1(q[1])}"/>`
          }
        }
        const mid = project(o.mode, (A[0] + B[0]) / 2, (A[1] + B[1]) / 2, H + 0.64)
        svg =
          `<g class="hv-dev${sh.reachable ? '' : ' hv-off'}" data-ref="${esc(sh.ref)}" role="button" tabindex="0" aria-label="${label(sh)}">` +
          svg +
          slats +
          `<g transform="translate(${r1(mid[0])},${r1(mid[1])}) scale(${o.unit.toFixed(4)})"><circle class="hv-hit" r="18"/>` +
          pill(`${Math.round(sh.position ?? 0)}%`, { cls: o.selected === sh.ref ? 'hv-on' : '' }) +
          '</g></g>'
      }
    }
    items.push({ depth, svg })
  }

  // Devices standing in the rooms.
  for (const { p, d } of placed) {
    if (p.opening) continue
    let svg = ''
    let depth = p.x + p.y + 0.04
    const lift = (m: number) => (iso ? m * CELLS_PER_M : 0)
    switch (d.kind) {
      case 'light': {
        const lit = !!d.on && d.reachable
        const color = d.color ?? p.color ?? WARM_LIGHT
        const k = clamp((d.brightness ?? 80) / 100, 0.08, 1)
        svg = marker(
          o,
          d,
          p.x,
          p.y,
          iso ? Math.min(0.8 * CELLS_PER_M, H + 0.25 * CELLS_PER_M) : 0,
          lit
            ? `<circle r="13" fill="${color}" opacity="${(0.18 + 0.3 * k).toFixed(2)}"/><circle r="6.5" fill="${color}" stroke="#fff" stroke-width="1.2"/>`
            : '<circle r="6" fill="#0d1c38" stroke="#7f95bb" stroke-width="1.4"/>',
        )
        break
      }
      case 'sensor': {
        const parts: string[] = []
        if (d.temperature !== undefined) parts.push(`${d.temperature.toFixed(1)}°`)
        if (d.humidity !== undefined && !o.compact) parts.push(`${Math.round(d.humidity)}%`)
        svg = marker(o, d, p.x, p.y, lift(0.55), pill(parts.join('  ') || d.name))
        break
      }
      case 'switch':
        svg = marker(
          o,
          d,
          p.x,
          p.y,
          lift(0.45),
          `<rect class="hv-pill${d.on ? ' hv-on' : ''}" x="-11" y="-11" width="22" height="22" rx="6"/>${ICON.power(!!d.on)}`,
        )
        break
      case 'dehumidifier':
        svg = marker(
          o,
          d,
          p.x,
          p.y,
          lift(0.5),
          pill(d.humidity !== undefined ? `${Math.round(d.humidity)}%` : d.on ? 'On' : 'Off', {
            icon: `<g class="${d.on ? 'hv-pulse' : ''}">${ICON.drop}</g>`,
            cls: d.on ? 'hv-on' : '',
          }),
        )
        break
      case 'meter': {
        const w = d.power ?? 0
        const dur = clamp(2400 / Math.max(200, Math.abs(w)), 0.35, 3)
        svg = marker(
          o,
          d,
          p.x,
          p.y,
          lift(0.55),
          pill(d.power !== undefined ? formatPower(w) : '-', {
            icon: `<g class="hv-pulse" style="animation-duration:${dur.toFixed(2)}s">${ICON.bolt}</g>`,
            cls: 'hv-warn',
          }),
        )
        break
      }
      case 'heating': {
        const x1 = p.x - 0.8
        const x2 = p.x + 0.8
        const y1 = p.y - 0.7
        const y2 = p.y + 0.7
        const hz = iso ? 1.6 : 0
        let box = ''
        if (iso) {
          box =
            `<polygon class="hv-box" points="${poly(o, [
              [x1, y2, 0],
              [x2, y2, 0],
              [x2, y2, hz],
              [x1, y2, hz],
            ])}"/>` +
            `<polygon class="hv-box hv-r" points="${poly(o, [
              [x2, y1, 0],
              [x2, y2, 0],
              [x2, y2, hz],
              [x2, y1, hz],
            ])}"/>` +
            `<polygon class="hv-box hv-t" points="${poly(o, [
              [x1, y1, hz],
              [x2, y1, hz],
              [x2, y2, hz],
              [x1, y2, hz],
            ])}"/>`
        } else {
          box = `<polygon class="hv-box hv-t" points="${poly(o, [
            [x1, y1, 0],
            [x2, y1, 0],
            [x2, y2, 0],
            [x1, y2, 0],
          ])}"/>`
        }
        const text = d.on === false ? 'Off' : d.temperature !== undefined ? `${d.temperature.toFixed(0)}°` : 'On'
        svg =
          `<g pointer-events="none">${box}</g>` +
          marker(o, d, p.x, p.y, iso ? 2.6 : 0, pill(text, { icon: ICON.heat, cls: d.on ? 'hv-on' : '' }))
        depth += 0.6
        break
      }
      case 'gate': {
        // A sliding leaf as wide as the gate, centred on its placement, that
        // moves aside as the gate opens. Half open while it is moving, since
        // the gate reports where it is going, not how far it got.
        const open = d.gateState === 'open' ? 1 : d.gateState === 'opening' || d.gateState === 'closing' ? 0.5 : 0
        const len = p.length ?? 4
        const along = (p.axis ?? 'h') === 'h'
        const at = (t: number): [number, number] => (along ? [p.x - len / 2 + t, p.y] : [p.x, p.y - len / 2 + t])
        // It slides along its fence toward whichever side of the plot has
        // more room, so an open gate never leaves the plot.
        const centre = along ? p.x : p.y
        const span = along ? plan.plot.w : plan.plot.h
        const slide = open * len * 0.94 * (centre > span / 2 ? -1 : 1)
        const gh = iso ? 0.55 * CELLS_PER_M : 0
        const [ax, ay] = at(slide)
        const [bx, by] = at(len + slide)
        let leaf = ''
        if (iso) {
          leaf = `<polygon class="hv-leaf" points="${poly(o, [
            [ax, ay, 0.08],
            [bx, by, 0.08],
            [bx, by, gh],
            [ax, ay, gh],
          ])}"/>`
          for (const [px, py] of [at(0), at(len)]) {
            const a = project(o.mode, px, py, 0)
            const b = project(o.mode, px, py, 0.75 * CELLS_PER_M)
            leaf += `<line x1="${r1(a[0])}" y1="${r1(a[1])}" x2="${r1(b[0])}" y2="${r1(b[1])}" stroke="#ffc76b" stroke-width="3" stroke-linecap="round"/>`
          }
        } else {
          const a = project(o.mode, ax, ay)
          const e = project(o.mode, bx, by)
          leaf = `<line x1="${r1(a[0])}" y1="${r1(a[1])}" x2="${r1(e[0])}" y2="${r1(e[1])}" stroke="#ffc76b" stroke-width="5"/>`
        }
        svg =
          `<g pointer-events="none">${leaf}</g>` +
          marker(o, d, p.x, p.y, lift(1), pill(stateText(d) || 'Gate', { icon: ICON.gate, cls: open ? 'hv-warn' : '' }))
        break
      }
      case 'camera':
        svg = marker(
          o,
          d,
          p.x,
          p.y,
          lift(1.1),
          `<rect class="hv-pill" x="-12" y="-11" width="24" height="22" rx="6"/>${ICON.camera}`,
        )
        break
      case 'shutter':
        // A shutter not attached to a window yet: drawn where it was dropped.
        svg = marker(o, d, p.x, p.y, lift(0.5), pill(stateText(d) || d.name))
        break
      default:
        svg = marker(o, d, p.x, p.y, lift(0.45), pill(stateText(d) || d.name))
    }
    items.push({ depth, svg })
  }

  items.sort((a, b) => a.depth - b.depth)
  return `<defs>${defs}</defs>${base}${glow}${pipes}${items.map((i) => i.svg).join('')}`
}
