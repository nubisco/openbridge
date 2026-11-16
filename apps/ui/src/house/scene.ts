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
import type { HouseFloor, HouseLook, HousePlacement, HousePlan, HouseRoom } from '@/api'
import {
  CELLS_PER_M,
  ISO_FLOOR_MATRIX,
  S,
  clamp,
  circuitPath,
  doorSwing,
  esc,
  humidityColor,
  lightMount,
  lerp,
  project,
  r1,
  radiatorEnds,
  radiatorRoom,
  roomAt,
  roomBox,
  roomTempColor,
  roomOutline,
  roomRects,
  roomsOutsideIn,
  wallRuns,
  waterColor,
  type Point,
  type ViewMode,
} from './geometry'
import { formatPower, stateText, type LiveDevice } from './live'

export const WARM_LIGHT = '#ffb45e'

/** How high each kind of light sits, in metres. */
const LAMP_HEIGHT = { ceiling: 2.35, wall: 1.8, floor: 1.5, table: 0.75, pool: 0.02 } as const

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

/**
 * Heights are drawn at about half scale, as the walls are (a 2.5 m wall
 * stands 1.35 m), so a fridge or a floor lamp does not hide the room behind
 * it. `zm` turns real metres into drawn height.
 */
const Z = 0.54
const zm = (o: Pick<SceneOptions, 'mode'>, metres: number) => (o.mode === 'iso' ? metres * CELLS_PER_M * Z : 0)

const ICON = {
  drop: '<path d="M0,-6 C3,-2 4.5,0 4.5,2.5 A4.5,4.5 0 1 1 -4.5,2.5 C-4.5,0 -3,-2 0,-6Z" fill="#2f9fe0"/>',
  bolt: '<path d="M1.5,-7 L-4,1 H-0.5 L-1.5,7 L4,-1 H0.5 Z" fill="#e3a008"/>',
  heat: '<path d="M-4,4 C-6,0 -2,-1 -3,-6 M0,4 C-2,0 2,-1 1,-6 M4,4 C2,0 6,-1 5,-6" fill="none" stroke="#ff8a5c" stroke-width="1.5" stroke-linecap="round"/>',
  camera:
    '<rect x="-6" y="-4" width="9" height="8" rx="1.5" fill="none" stroke="#4b5563" stroke-width="1.5"/><path d="M3,-1.5 L6.5,-3.5 V3.5 L3,1.5" fill="none" stroke="#4b5563" stroke-width="1.5" stroke-linejoin="round"/>',
  gate: '<path d="M-6,4 V-4 M6,4 V-4 M-6,-1 H6 M-3,-1 V4 M0,-1 V4 M3,-1 V4" fill="none" stroke="#8a6a3d" stroke-width="1.4" stroke-linecap="round"/>',
  power: (on: boolean) =>
    `<path d="M0,-5.5 V-0.5 M-3.6,-3.4 A5,5 0 1 0 3.6,-3.4" fill="none" stroke="${on ? '#1f9d55' : '#8b8f96'}" stroke-width="1.8" stroke-linecap="round"/>`,
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

/**
 * A marker at (x,y), raised to height z. What holds it up says what it is: a
 * dotted drop line marks the spot under something hanging or floating, a pole
 * is a floor or table lamp's stand.
 */
function marker(
  o: SceneOptions,
  d: LiveDevice,
  x: number,
  y: number,
  z: number,
  inner: string,
  stem: 'dotted' | 'pole' | 'none' = 'dotted',
): string {
  const p = project(o.mode, x, y, z)
  const p0 = project(o.mode, x, y, 0)
  const drop = (p0[1] - p[1]) / o.unit
  const sel = o.selected === d.ref
  let under = ''
  if (drop > 2 && stem === 'dotted')
    under = `<line class="hv-drop" x1="0" y1="0" x2="0" y2="${r1(drop)}"/><ellipse class="hv-foot" cx="0" cy="${r1(drop)}" rx="5" ry="2.5"/>`
  if (drop > 2 && stem === 'pole')
    under = `<ellipse class="hv-lampbase" cx="0" cy="${r1(drop)}" rx="6" ry="3"/><line class="hv-pole" x1="0" y1="2" x2="0" y2="${r1(drop)}"/>`
  return (
    `<g class="hv-dev${d.reachable ? '' : ' hv-off'}" data-ref="${esc(d.ref)}" role="button" tabindex="0" ` +
    `aria-label="${label(d)}" transform="translate(${r1(p[0])},${r1(p[1])}) scale(${o.unit.toFixed(4)})">` +
    under +
    '<g class="hv-badge">' +
    '<circle class="hv-hit" r="20"/>' +
    (sel ? '<circle class="hv-selring" r="18"/>' : '') +
    inner +
    '</g></g>'
  )
}

/**
 * Markers that would overlap on screen are pulled apart. The one nearer the
 * viewer keeps its place, and one behind it rises on a longer stem until it
 * is clear, so every badge stays readable and still points at its spot.
 */
function separate(marks: Array<{ depth: number; svg: string }>, unit: number): void {
  type Box = { x0: number; y0: number; x1: number; y1: number }
  const boxes: Box[] = []
  const at = (svg: string) => {
    const m = /^<g class="hv-dev[^>]*transform="translate\(([-\d.]+),([-\d.]+)\)/.exec(svg)
    return m ? [Number(m[1]), Number(m[2])] : null
  }
  // Front first: larger screen y is nearer the viewer.
  const order = marks
    .map((m, i) => ({ m, i, p: at(m.svg) }))
    .filter((e): e is typeof e & { p: number[] } => !!e.p)
    .sort((a, b) => b.p[1] - a.p[1])
  for (const e of order) {
    const widths = [...e.m.svg.matchAll(/class="hv-pill[^"]*"[^>]*width="([\d.]+)"/g)].map((m) => Number(m[1]))
    const w = (Math.max(34, ...widths) + 6) * unit
    const h = (widths.length ? 26 : 34) * unit
    const [x, y] = e.p
    let lift = 0
    for (let tries = 0; tries < 12; tries++) {
      const b = { x0: x - w / 2, y0: y - lift - h / 2, x1: x + w / 2, y1: y - lift + h / 2 }
      const hit = boxes.find((q) => b.x0 < q.x1 && q.x0 < b.x1 && b.y0 < q.y1 && q.y0 < b.y1)
      if (!hit) {
        boxes.push(b)
        break
      }
      lift += b.y1 - hit.y0 + 3 * unit
    }
    if (lift > 0.5) {
      const L = r1(lift / unit)
      e.m.svg = e.m.svg.replace(
        '<g class="hv-badge">',
        `<line class="hv-drop hv-leader" x1="0" y1="${-L}" x2="0" y2="0"/><g class="hv-badge" transform="translate(0,${-L})">`,
      )
    }
  }
}

function poly(o: SceneOptions, pts: Array<[number, number, number]>): string {
  return pts
    .map(([x, y, z]) => {
      const p = project(o.mode, x, y, z)
      return `${r1(p[0])},${r1(p[1])}`
    })
    .join(' ')
}

/** A pool wave's length, in cells. The CSS animation moves a wave by exactly this. */
const WAVE = 1.4

/**
 * A pool's water: lit through in the colour of a light placed in it, and
 * with waves moving across it while its pump or filter runs. Still water
 * keeps a few faint, unmoving lines so it still reads as water.
 */
function poolWater(
  o: SceneOptions,
  floor: HouseFloor,
  r: HouseRoom,
  shapes: string[],
  placed: Array<{ p: HousePlacement; d: LiveDevice }>,
  lit: Array<{ p: HousePlacement; room: HouseRoom | undefined; color: string; k: number }>,
  roomOf: (p: HousePlacement) => HouseRoom | undefined,
): string {
  const cp = `hv-cp-${svgId(floor.id)}-${svgId(r.id)}`
  // The pump or filter: anything but a light in the pool, or a plain switch
  // standing beside it (within 1.5 m), which is where a pool pump usually is.
  const near = (x: number, y: number) =>
    roomRects(r).some(
      (q) => Math.hypot(x - clamp(x, q.x, q.x + q.w), y - clamp(y, q.y, q.y + q.h)) <= 1.5 * CELLS_PER_M,
    )
  const running = placed.some(
    ({ p, d }) =>
      d.on &&
      d.reachable &&
      d.kind !== 'light' &&
      (roomOf(p) === r || (d.kind === 'switch' && !p.look && near(p.x, p.y))),
  )
  const light = lit.find((l) => l.room === r)
  let out = ''
  if (light) {
    const { color, k } = light
    const id = `hv-pl-${svgId(floor.id)}-${svgId(r.id)}`
    const c = project(o.mode, light.p.x, light.p.y)
    const box = roomBox(r)
    const R = Math.max(box.w, box.h) * S * 0.8
    out +=
      `<defs><filter id="${id}-b" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="${r1(7 * o.unit + 3)}"/></filter>` +
      `<radialGradient id="${id}-g" gradientUnits="userSpaceOnUse" cx="${r1(c[0])}" cy="${r1(c[1])}" r="${r1(R)}">` +
      `<stop offset="0" stop-color="#fff" stop-opacity="${(0.35 * k).toFixed(2)}"/><stop offset="0.25" stop-color="${color}" stop-opacity="0.4"/>` +
      `<stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient></defs>` +
      // The glow spilling over the stone edge, then the water itself.
      `<g pointer-events="none" fill="none" stroke="${color}" stroke-width="${r1(16 * o.unit + 6)}" stroke-opacity="${(0.25 + 0.35 * k).toFixed(2)}" filter="url(#${id}-b)">` +
      shapes.map((pts) => `<polygon points="${pts}"/>`).join('') +
      '</g>' +
      `<g pointer-events="none" fill="${color}" fill-opacity="${(0.45 + 0.4 * k).toFixed(2)}">` +
      shapes.map((pts) => `<polygon points="${pts}"/>`).join('') +
      '</g>' +
      `<g pointer-events="none" clip-path="url(#${cp})">${shapes.map((pts) => `<polygon points="${pts}" fill="url(#${id}-g)"/>`).join('')}</g>`
  }
  // Waves are drawn flat in plan units and laid on the floor with the same
  // matrix as the room names, so they move across the water, not the screen.
  const amp = running ? 0.11 : 0.035
  let waves = ''
  let row = 0
  for (const q of roomRects(r)) {
    for (let y = q.y + 0.55; y < q.y + q.h - 0.25; y += 0.75, row++) {
      let d = ''
      for (let x = q.x - WAVE; x <= q.x + q.w + WAVE + 0.01; x += WAVE / 8) {
        const yy = y + amp * Math.sin(((x - q.x) / WAVE) * 2 * Math.PI + row * 1.7)
        d += `${d ? 'L' : 'M'}${r1(x * S)},${r1(yy * S)}`
      }
      waves += `<path class="hv-wave${row % 2 ? ' hv-w2' : ''}" d="${d}"/>`
    }
  }
  out +=
    `<g pointer-events="none" clip-path="url(#${cp})"><g transform="${o.mode === 'iso' ? ISO_FLOOR_MATRIX : ''}">` +
    `<g class="hv-waves${running ? ' hv-on' : ''}">${waves}</g></g></g>`
  return out
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
  // Under the floor, so drawn quieter than the things standing on it.
  const w = Math.max(3.5, 2 * o.unit)
  const points = pts.map(([x, y]) => project(o.mode, x, y, 0.04)).map((p) => `${r1(p[0])},${r1(p[1])}`)
  const opacity = flowing ? 0.6 : 0.3
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
 * The visible edges of a floor's slab: the faces toward the viewer (larger y
 * and larger x) of every cell a room covers, merged into straight runs.
 */
function slab(o: SceneOptions, floor: HouseFloor): string {
  const cells = new Set<string>()
  for (const r of floor.rooms)
    for (const q of roomRects(r))
      for (let x = q.x; x < q.x + q.w; x++) for (let y = q.y; y < q.y + q.h; y++) cells.add(`${x},${y}`)
  const t = 0.35
  const front = new Map<number, number[]>()
  const side = new Map<number, number[]>()
  for (const c of cells) {
    const [x, y] = c.split(',').map(Number)
    if (!cells.has(`${x},${y + 1}`)) front.set(y + 1, [...(front.get(y + 1) ?? []), x])
    if (!cells.has(`${x + 1},${y}`)) side.set(x + 1, [...(side.get(x + 1) ?? []), y])
  }
  let out = ''
  const runs = (list: number[]) => {
    const sorted = list.sort((a, b) => a - b)
    const res: Array<[number, number]> = []
    for (const v of sorted) {
      const last = res[res.length - 1]
      if (last && last[1] === v) last[1] = v + 1
      else res.push([v, v + 1])
    }
    return res
  }
  for (const [y, xs] of front)
    for (const [x1, x2] of runs(xs))
      out += `<polygon class="hv-slab" points="${poly(o, [
        [x1, y, 0],
        [x2, y, 0],
        [x2, y, -t],
        [x1, y, -t],
      ])}"/>`
  for (const [x, ys] of side)
    for (const [y1, y2] of runs(ys))
      out += `<polygon class="hv-slab hv-r" points="${poly(o, [
        [x, y1, 0],
        [x, y2, 0],
        [x, y2, -t],
        [x, y1, -t],
      ])}"/>`
  return out
}

/**
 * A box standing on the floor, centred on (cx, cy): `w` along x and `d`
 * along y in cells, from height z0 to z1. Three faces in the isometric view
 * (the ones toward the viewer), the top alone in the flat one.
 */
function box(
  o: SceneOptions,
  cx: number,
  cy: number,
  w: number,
  d: number,
  z0: number,
  z1: number,
  cls: string,
  faces: { front?: string; side?: string } = {},
): string {
  const x1 = cx - w / 2
  const x2 = cx + w / 2
  const y1 = cy - d / 2
  const y2 = cy + d / 2
  const top = `<polygon class="${cls} hv-t" points="${poly(o, [
    [x1, y1, z1],
    [x2, y1, z1],
    [x2, y2, z1],
    [x1, y2, z1],
  ])}"/>`
  if (o.mode !== 'iso') return top
  return (
    `<polygon class="${cls} hv-f ${faces.front ?? ''}" points="${poly(o, [
      [x1, y2, z0],
      [x2, y2, z0],
      [x2, y2, z1],
      [x1, y2, z1],
    ])}"/>` +
    `<polygon class="${cls} hv-s ${faces.side ?? ''}" points="${poly(o, [
      [x2, y1, z0],
      [x2, y2, z0],
      [x2, y2, z1],
      [x2, y1, z1],
    ])}"/>` +
    top
  )
}

/** A circle lying on the floor (or at height z), as the ellipse it projects to. */
function disc(o: SceneOptions, x: number, y: number, z: number, r: number, cls: string): string {
  const c = project(o.mode, x, y, z)
  const iso = o.mode === 'iso'
  return `<ellipse class="${cls}" cx="${r1(c[0])}" cy="${r1(c[1])}" rx="${r1(r * S * (iso ? 1.2247 : 1))}" ry="${r1(r * S * (iso ? 0.7071 : 1))}"/>`
}

/** A circle standing upright on the plane y = const, as polygon points (a washing machine's door). */
function uprightCircle(o: SceneOptions, x: number, y: number, z: number, r: number): string {
  const pts: Array<[number, number, number]> = []
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2
    pts.push([x + r * Math.cos(a), y, z + r * Math.sin(a)])
  }
  return poly(o, pts)
}

/** What an appliance's badge says: its power draw while it runs, when it reports one. */
function applianceText(d: LiveDevice): string {
  if (d.reachable && d.on && d.power !== undefined) return formatPower(d.power)
  return stateText(d) || d.name
}

/**
 * An appliance drawn as what it is, from the look set on the plan. Returns the
 * shape and the height its badge floats at.
 */
function appliance(o: SceneOptions, d: LiveDevice, p: HousePlacement, look: HouseLook): { svg: string; top: number } {
  const on = !!d.on && d.reachable
  const m = (metres: number) => metres * CELLS_PER_M
  switch (look) {
    case 'fridge': {
      const h = zm(o, 1.85)
      let svg = box(o, p.x, p.y, m(0.7), m(0.68), 0, h, 'hv-ap')
      if (o.mode === 'iso') {
        const a = project(o.mode, p.x - m(0.35), p.y + m(0.34), h * 0.62)
        const b = project(o.mode, p.x + m(0.35), p.y + m(0.34), h * 0.62)
        const c = project(o.mode, p.x + m(0.25), p.y + m(0.34), h * 0.8)
        const e = project(o.mode, p.x + m(0.25), p.y + m(0.34), h * 0.7)
        svg += `<line class="hv-apline" x1="${r1(a[0])}" y1="${r1(a[1])}" x2="${r1(b[0])}" y2="${r1(b[1])}"/>`
        svg += `<line class="hv-aphandle" x1="${r1(c[0])}" y1="${r1(c[1])}" x2="${r1(e[0])}" y2="${r1(e[1])}"/>`
      }
      return { svg, top: h }
    }
    case 'washer': {
      const h = zm(o, 0.85)
      let svg = box(o, p.x, p.y, m(0.6), m(0.6), 0, h, 'hv-ap')
      if (o.mode === 'iso') {
        svg += `<polygon class="hv-apdoor" points="${uprightCircle(o, p.x, p.y + m(0.3), h * 0.45, m(0.2))}"/>`
        svg += `<polygon class="hv-apdrum${on ? ' hv-spin' : ''}" points="${uprightCircle(o, p.x, p.y + m(0.3), h * 0.45, m(0.13))}"/>`
      } else svg += disc(o, p.x, p.y, 0, m(0.2), 'hv-apdoor')
      return { svg, top: h }
    }
    case 'dehumidifier': {
      const h = zm(o, 0.6)
      const svg = box(o, p.x, p.y, m(0.38), m(0.3), 0, h, 'hv-ap')
      return { svg, top: h }
    }
    case 'tv': {
      const along = (p.axis ?? 'h') === 'h'
      const w = along ? m(1.2) : m(0.08)
      const dd = along ? m(0.08) : m(1.2)
      const z0 = zm(o, 0.55)
      const z1 = zm(o, 1.25)
      const screen = on ? 'hv-screen hv-on' : 'hv-screen'
      let svg = box(o, p.x, p.y, w, dd, z0, z1, 'hv-tv', along ? { front: screen } : { side: screen })
      // The stand under it.
      svg += box(o, p.x, p.y, along ? m(0.35) : m(0.2), along ? m(0.2) : m(0.35), 0, z0, 'hv-tvstand')
      if (o.mode !== 'iso') {
        const c = project(o.mode, p.x, p.y)
        svg += `<circle cx="${r1(c[0])}" cy="${r1(c[1])}" r="3" class="${on ? 'hv-led hv-on' : 'hv-led'}"/>`
      }
      return { svg, top: z1 }
    }
    case 'vacuum': {
      const r = m(0.17)
      const h = zm(o, 0.09)
      const lo = project(o.mode, p.x, p.y, 0)
      const hi = project(o.mode, p.x, p.y, h)
      const rx = r * S * (o.mode === 'iso' ? 1.2247 : 1)
      let svg = disc(o, p.x, p.y, 0, r, 'hv-vac')
      svg += `<rect class="hv-vac" x="${r1(lo[0] - rx)}" y="${r1(hi[1])}" width="${r1(rx * 2)}" height="${r1(lo[1] - hi[1])}"/>`
      svg += disc(o, p.x, p.y, h, r, 'hv-vac hv-t')
      svg += disc(o, p.x, p.y, h, r * 0.35, on ? 'hv-vaclid hv-on' : 'hv-vaclid')
      return { svg, top: h }
    }
    case 'mower': {
      const h = zm(o, 0.28)
      let svg = box(o, p.x, p.y, m(0.6), m(0.45), zm(o, 0.04), h, 'hv-mower')
      svg += box(o, p.x - m(0.05), p.y, m(0.28), m(0.3), h, h + zm(o, 0.03), 'hv-mowerlid')
      return { svg, top: h }
    }
    case 'outlet':
      return { svg: '', top: zm(o, 0.3) }
  }
}

/**
 * Each walled room's reading for an overlay, from a sensor standing in it. A
 * heating device's temperature is its water, not the room's, so it never
 * counts. A device on a window (a shutter) is in no room.
 */
export function roomReadings(
  floor: HouseFloor,
  devices: Map<string, LiveDevice>,
  overlay: 'temperature' | 'humidity',
): Map<string, number> {
  const out = new Map<string, number>()
  for (const p of floor.placements) {
    const d = devices.get(p.ref)
    if (!d || !d.reachable || p.opening) continue
    const v = overlay === 'temperature' ? (d.kind === 'heating' ? undefined : d.temperature) : d.humidity
    if (v === undefined) continue
    const r = roomAt(floor, p.x, p.y)
    if (r?.kind === 'room' && !out.has(r.id)) out.set(r.id, v)
  }
  return out
}

export const overlayColor = (overlay: 'temperature' | 'humidity', v: number) =>
  overlay === 'temperature' ? roomTempColor(v) : humidityColor(v)
export const overlayText = (overlay: 'temperature' | 'humidity', v: number) =>
  overlay === 'temperature' ? `${v.toFixed(1)}°` : `${Math.round(v)}%`

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
  const placed = floor.placements
    .map((p) => ({ p, d: devices.get(p.ref) }))
    .filter((x): x is { p: HousePlacement; d: LiveDevice } => !!x.d)
  let defs = ''
  let base = ''
  let glow = ''
  let pipes = ''
  const items: Array<{ depth: number; svg: string }> = []

  // No plot and no grid: the floor is what was drawn on it, standing on a
  // slab like an architect's model, so the house reads as a house.
  if (iso) base += slab(o, floor)

  // Rooms, with the overlay tint from a sensor in the room.
  const roomOf = (p: HousePlacement) => roomAt(floor, p.x, p.y)
  const readings = o.overlay === 'none' ? new Map<string, number>() : roomReadings(floor, devices, o.overlay)
  let badges = ''
  // The lights that are on, each with the room it lights.
  const lit = placed
    .filter(({ d }) => d.kind === 'light' && d.on && d.reachable)
    .map(({ p, d }) => ({
      p,
      room: roomOf(p),
      color: d.color ?? p.color ?? WARM_LIGHT,
      k: clamp((d.brightness ?? 80) / 100, 0.08, 1),
    }))
  // A light in a pool lights the water, not the floor.
  let water = ''
  // Biggest first, so a room drawn inside another is painted on top of it.
  for (const r of roomsOutsideIn(floor.rooms)) {
    const rects = roomRects(r)
    const shapes = rects.map((q) =>
      poly(o, [
        [q.x, q.y, 0],
        [q.x + q.w, q.y, 0],
        [q.x + q.w, q.y + q.h, 0],
        [q.x, q.y + q.h, 0],
      ]),
    )
    defs += `<clipPath id="hv-cp-${svgId(floor.id)}-${svgId(r.id)}">${shapes.map((pts) => `<polygon points="${pts}"/>`).join('')}</clipPath>`
    // The floor is always drawn. An overlay is a tint laid over it, so the
    // house stays a house while showing temperature or humidity.
    let tint = ''
    if (o.overlay !== 'none') {
      const reading = readings.get(r.id)
      if (reading !== undefined) {
        const fill = overlayColor(o.overlay, reading)
        tint = fill
        // The reading floats over the room, above the walls, so it reads in
        // 3D as well as from above.
        const q = roomRects(r).reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a))
        const c = project(o.mode, q.x + q.w / 2, q.y + q.h / 2, zm(o, 1.6))
        const text = overlayText(o.overlay, reading)
        const w = text.length * 9 + 22
        badges +=
          `<g class="hv-reading" transform="translate(${r1(c[0])},${r1(c[1])}) scale(${o.unit.toFixed(4)})" pointer-events="none">` +
          `<rect x="${r1(-w / 2)}" y="-15" width="${r1(w)}" height="30" rx="15" fill="${fill}"/>` +
          `<text y="5.5" text-anchor="middle">${esc(text)}</text></g>`
      }
    }
    // Each part is filled on its own, with no stroke, and the room's outline
    // is drawn once over them, so an L reads as one room with no seam.
    // In the exploded view a tap on a floor's rooms brings that floor forward.
    const pick = o.all ? ` hv-pick" data-plate="${esc(floor.id)}` : ''
    // Paving is laid flat on the ground: its joints are a pattern in plan
    // units, turned onto the floor with the same matrix as the room names.
    const paveId = `hv-pave-${o.mode}`
    if (r.kind === 'paved' && !defs.includes(`id="${paveId}"`)) {
      const M = CELLS_PER_M * S
      defs +=
        `<pattern id="${paveId}" patternUnits="userSpaceOnUse" width="${M}" height="${M / 2}"${iso ? ` patternTransform="${ISO_FLOOR_MATRIX}"` : ''}>` +
        `<rect width="${M}" height="${M / 2}" fill="#ddd5c7"/>` +
        `<path d="M0,0.5H${M}M${M / 2},0V${M / 2}" stroke="#c6bcaa" stroke-width="1" fill="none"/></pattern>`
    }
    const fill = r.kind === 'paved' ? ` style="fill:url(#${paveId})"` : ''
    for (const pts of shapes) {
      base += `<polygon class="hv-room-fill hv-k-${r.kind}${pick}"${fill} points="${pts}"/>`
      if (tint) base += `<polygon class="hv-tint" fill="${tint}" fill-opacity="0.55" points="${pts}"/>`
    }
    let outline = ''
    for (const u of roomOutline(r)) {
      const a = project(o.mode, u.x, u.y)
      const b = project(o.mode, u.axis === 'h' ? u.x + 1 : u.x, u.axis === 'v' ? u.y + 1 : u.y)
      outline += `M${r1(a[0])},${r1(a[1])}L${r1(b[0])},${r1(b[1])}`
    }
    base += `<path class="hv-room-edge hv-k-${r.kind}" d="${outline}"/>`
    if (r.kind === 'pool') water += poolWater(o, floor, r, shapes, placed, lit, roomOf)
    if (o.labels) {
      // On the largest part, which is where the eye looks for the room's name.
      const q = rects.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a))
      const name = r.name
      const c = project(o.mode, q.x + q.w / 2, q.y + q.h / 2)
      const fs = Math.min(11 * o.unit, (q.w * S * 0.86) / Math.max(1, name.length * 0.72), q.h * S * 0.3)
      base += `<text class="hv-rlabel" transform="translate(${r1(c[0])},${r1(c[1])}) ${iso ? ISO_FLOOR_MATRIX : ''}" font-size="${r1(fs)}" dy="${r1(fs * 0.35)}">${esc(name)}</text>`
    }
  }

  // Light on the floor, clipped to the room the lamp is in: the whole room
  // takes the light's colour, brightest under the lamp, so a room with the
  // lights on reads as lit from across the house.
  for (const { p, room: r, color, k } of lit) {
    // An overlay's colours are data: light on the floors would read as data too.
    if (o.overlay !== 'none') break
    if (r?.kind === 'pool') continue
    const mount = lightMount(floor, p)
    if (mount === 'pool') continue
    const clip = r ? ` clip-path="url(#hv-cp-${svgId(floor.id)}-${svgId(r.id)})"` : ''
    if (r) {
      const wash = { ceiling: 0.34, wall: 0.26, floor: 0.22, table: 0.14 }[mount] * (0.35 + 0.65 * k)
      glow += `<g class="hv-wash" fill="${color}" fill-opacity="${wash.toFixed(2)}"${clip}>${roomRects(r)
        .map(
          (q) =>
            `<polygon points="${poly(o, [
              [q.x, q.y, 0],
              [q.x + q.w, q.y, 0],
              [q.x + q.w, q.y + q.h, 0],
              [q.x, q.y + q.h, 0],
            ])}"/>`,
        )
        .join('')}</g>`
    }
    // A ceiling light fills the room, a table lamp lights the corner it is in.
    const reach = { ceiling: [1.3, 2.5], wall: [1, 1.8], floor: [0.9, 1.6], table: [0.7, 1.1] }[mount]
    const R = (reach[0] + reach[1] * k) * CELLS_PER_M
    const c = project(o.mode, p.x, p.y)
    const gid = `hv-lg-${svgId(floor.id)}-${svgId(p.ref)}`
    defs +=
      `<radialGradient id="${gid}"><stop offset="0" stop-color="${color}" stop-opacity="${(0.45 + 0.5 * k).toFixed(2)}"/>` +
      `<stop offset="0.45" stop-color="${color}" stop-opacity="${(0.18 + 0.3 * k).toFixed(2)}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>`
    glow +=
      `<ellipse cx="${r1(c[0])}" cy="${r1(c[1])}" rx="${r1(R * S * (iso ? 1.2247 : 1))}" ry="${r1(R * S * (iso ? 0.7071 : 1))}" ` +
      `fill="url(#${gid})"${clip} pointer-events="none"/>`
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
      const pts = circuitPath({ x: p.x, y: p.y }, rooms, floor)
      if (!pts) continue
      pipes += pipe(o, pts, supply, d?.return, flowing)
      if (f.id !== floor.id) {
        // Where the circuit arrives from the floor its source is on.
        const at = project(o.mode, p.x, p.y)
        pipes += `<circle cx="${r1(at[0])}" cy="${r1(at[1])}" r="${r1(5 * o.unit)}" class="hv-riser" stroke="${color}" stroke-width="${r1(2 * o.unit)}"/>`
      }
    }
  }

  // Risers between floors, in the stacked view. Each is drawn with the lower
  // of its two floors, so the floor above, painted later, covers it where it
  // goes up through the slab, and it never crosses that floor's garden.
  if (iso && o.all) {
    for (const f of plan.floors) {
      for (const p of f.placements) {
        if (!p.circuitRooms?.length) continue
        const d = devices.get(p.ref)
        const color = waterColor(d?.supply ?? d?.temperature ?? 20)
        const served = plan.floors.filter((g) => g.id !== f.id && g.rooms.some((r) => p.circuitRooms!.includes(r.id)))
        for (const g of served) {
          const lower = f.level < g.level ? f : g
          const upper = lower === f ? g : f
          if (lower.id !== floor.id || !o.offsets[upper.id] || !o.offsets[floor.id]) continue
          const at = project(o.mode, p.x, p.y)
          const rise = o.offsets[upper.id][1] - o.offsets[floor.id][1]
          pipes += `<line x1="${r1(at[0])}" y1="${r1(at[1])}" x2="${r1(at[0])}" y2="${r1(at[1] + rise)}" stroke="${color}" stroke-width="4" stroke-linecap="round" opacity="0.9"/>`
        }
      }
    }
  }

  // Radiators, against their walls. One is hot while a heating circuit that
  // serves its room is running, and takes the colour of that water.
  for (const rad of floor.radiators ?? []) {
    const room = radiatorRoom(floor, rad)
    let feed: LiveDevice | undefined
    for (const f of plan.floors) {
      for (const p of f.placements) {
        if (room && p.circuitRooms?.includes(room.id)) feed = devices.get(p.ref) ?? feed
      }
    }
    const hot = !!feed?.on && !!feed.reachable
    const water = waterColor(feed?.supply ?? feed?.temperature ?? 20)
    const [a, b] = radiatorEnds(rad, 0)
    const [a2, b2] = radiatorEnds(rad)
    // Radiators stay white. Heat shows as a glow and an edge in the water's colour.
    const style = hot ? ` style="--hv-water:${water};stroke:${water}"` : ''
    const fins: string[] = []
    for (let t = 0.25; t < rad.len - 0.01; t += 0.25) {
      fins.push(rad.axis === 'h' ? `${a2[0] + t},${a2[1]}` : `${a2[0]},${a2[1] + t}`)
    }
    let svg = ''
    if (iso) {
      const z0 = zm(o, 0.15)
      const z1 = zm(o, 0.75)
      svg =
        `<polygon class="hv-rad hv-radtop${hot ? ' hv-hot' : ''}" points="${poly(o, [
          [a[0], a[1], z1],
          [b[0], b[1], z1],
          [b2[0], b2[1], z1],
          [a2[0], a2[1], z1],
        ])}"/>` +
        `<polygon class="hv-rad${hot ? ' hv-hot' : ''}"${style} points="${poly(o, [
          [a2[0], a2[1], z0],
          [b2[0], b2[1], z0],
          [b2[0], b2[1], z1],
          [a2[0], a2[1], z1],
        ])}"/>` +
        fins
          .map((f) => {
            const [fx, fy] = f.split(',').map(Number)
            const p = project(o.mode, fx, fy, z0 + 0.04)
            const q = project(o.mode, fx, fy, z1 - 0.04)
            return `<line class="hv-radfin" x1="${r1(p[0])}" y1="${r1(p[1])}" x2="${r1(q[0])}" y2="${r1(q[1])}"/>`
          })
          .join('')
    } else {
      svg =
        `<polygon class="hv-rad${hot ? ' hv-hot' : ''}"${style} points="${poly(o, [
          [a[0], a[1], 0],
          [b[0], b[1], 0],
          [b2[0], b2[1], 0],
          [a2[0], a2[1], 0],
        ])}"/>` +
        fins
          .map((f) => {
            const [fx, fy] = f.split(',').map(Number)
            const p = project(o.mode, fx, fy)
            const q = project(o.mode, fx - (a2[0] - a[0]), fy - (a2[1] - a[1]))
            return `<line class="hv-radfin" x1="${r1(p[0])}" y1="${r1(p[1])}" x2="${r1(q[0])}" y2="${r1(q[1])}"/>`
          })
          .join('')
    }
    items.push({ depth: (a2[0] + b2[0] + a2[1] + b2[1]) / 2 + 0.02, svg: `<g pointer-events="none">${svg}</g>` })
  }

  // Walls, doors, windows, and the shutters that sit on windows.
  const shutters = new Map<string, LiveDevice>()
  for (const { p, d } of placed) if (p.opening) shutters.set(p.opening, d)
  // The walls of a lit room catch its light, on the side facing into it.
  const litRooms = new Map<string, { color: string; k: number }>()
  if (o.overlay === 'none') for (const l of lit) if (l.room && l.room.kind === 'room') litRooms.set(l.room.id, l)
  for (const w of wallRuns(floor)) {
    // An open stretch is a wall that is not there: nothing to draw.
    if (w.type === 'open') continue
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
      else if (w.type === 'door' && w.opening) {
        // The leaf drawn open, and the arc its free end sweeps, on the side
        // and from the hinge the plan says.
        const sw = doorSwing(w.opening)
        const h = project(o.mode, ...sw.hinge)
        const q = project(o.mode, ...sw.open)
        const f = project(o.mode, ...sw.free)
        const len = w.opening.len * S
        svg =
          ln('hv-sill2d', a, c) +
          `<path class="hv-door2d" d="M${r1(h[0])},${r1(h[1])} L${r1(q[0])},${r1(q[1])} A${r1(len)},${r1(len)} 0 0 ${sw.sweep} ${r1(f[0])},${r1(f[1])}"/>`
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
    // The top of a wall, drawn as a thick light line with a darker rim, which
    // is what makes a wall read as solid plaster rather than a pane.
    const cap = (z: number) => {
      const p = project(o.mode, A[0], A[1], z)
      const q = project(o.mode, B[0], B[1], z)
      const c = `x1="${r1(p[0])}" y1="${r1(p[1])}" x2="${r1(q[0])}" y2="${r1(q[1])}"`
      return `<line class="hv-caprim" ${c}/><line class="hv-cap" ${c}/>`
    }
    // The view looks in from +x and +y, so the face of a wall it shows is
    // the one facing the room in front of it, at the higher x or y. That
    // room's light is what tints it.
    const mx = (A[0] + B[0]) / 2
    const my = (A[1] + B[1]) / 2
    const facing = roomAt(floor, w.axis === 'h' ? mx : mx + 0.25, w.axis === 'h' ? my + 0.25 : my)
    const glowOn = facing ? litRooms.get(facing.id) : undefined
    const tint = (z1: number, z2: number) =>
      glowOn
        ? `<polygon class="hv-walllit" fill="${glowOn.color}" fill-opacity="${(0.12 + 0.26 * glowOn.k).toFixed(2)}" points="${quad(z1, z2)}"/>`
        : ''
    if (w.type === 'wall') {
      svg = `<polygon class="hv-wall" points="${quad(0, H)}"/>${tint(0, H)}${cap(H)}`
    } else if (w.type === 'door' && w.opening) {
      const hd = Math.min(H, 1.05 * CELLS_PER_M)
      const sw = doorSwing(w.opening)
      const q = sw.at(0.78)
      svg =
        `<polygon class="hv-doorleaf" points="${poly(o, [
          [sw.hinge[0], sw.hinge[1], 0.03],
          [q[0], q[1], 0.03],
          [q[0], q[1], hd * 0.96],
          [sw.hinge[0], sw.hinge[1], hd * 0.96],
        ])}"/>` +
        `<polyline class="hv-doorframe" points="${poly(o, [
          [A[0], A[1], 0],
          [A[0], A[1], hd],
          [B[0], B[1], hd],
          [B[0], B[1], 0],
        ])}"/>`
      if (H > hd + 0.1) svg += `<polygon class="hv-wall" points="${quad(hd, H)}"/>${tint(hd, H)}${cap(H)}`
    } else {
      const z0 = H * 0.3
      svg = `<polygon class="hv-wall" points="${quad(0, z0)}"/>${tint(0, z0)}<polygon class="hv-pane" points="${quad(z0, H)}"/>${cap(H)}`
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

  // Devices standing in the rooms. What a device is (a fridge, a gate leaf)
  // is depth-sorted with the walls. Its marker and badge go on a layer
  // above every wall, so a reading is never hidden behind one.
  const marks: Array<{ depth: number; svg: string }> = []
  const push = (depth: number, svg: string) => {
    const at = svg.indexOf('<g class="hv-dev')
    if (at > 0) items.push({ depth, svg: svg.slice(0, at) })
    marks.push({ depth, svg: at >= 0 ? svg.slice(at) : svg })
  }
  for (const { p, d } of placed) {
    if (p.opening) continue
    let svg = ''
    let depth = p.x + p.y + 0.04
    const lift = (m: number) => (iso ? m * CELLS_PER_M : 0)
    const look = d.kind === 'light' || d.kind === 'shutter' || d.kind === 'gate' ? undefined : (p.look ?? d.defaultLook)
    if (look) {
      // Drawn as what it is, with its state on a badge above it.
      const a = appliance(o, d, p, look)
      const badge =
        look === 'outlet'
          ? `<rect class="hv-outlet" x="-9" y="-9" width="18" height="18" rx="4"/><circle cx="-3" cy="0" r="1.6" class="hv-outlethole"/><circle cx="3" cy="0" r="1.6" class="hv-outlethole"/><circle cx="6" cy="-6" r="2.2" class="${d.on ? 'hv-led hv-on' : 'hv-led'}"/>`
          : look === 'dehumidifier'
            ? pill(d.humidity !== undefined ? `${Math.round(d.humidity)}%` : d.on ? 'On' : 'Off', {
                icon: `<g class="${d.on ? 'hv-pulse' : ''}">${ICON.drop}</g>`,
                cls: d.on ? 'hv-on' : '',
              })
            : pill(applianceText(d), { cls: d.on && d.reachable ? 'hv-on' : '' })
      const raise = look === 'outlet' ? 0 : iso ? 0.9 : 0
      svg =
        `<g pointer-events="none">${a.svg}</g>` +
        marker(o, d, p.x, p.y, a.top + raise, badge, look === 'outlet' ? 'dotted' : 'none')
      push(depth + 0.3, svg)
      continue
    }
    switch (d.kind) {
      case 'light': {
        const lit = !!d.on && d.reachable
        const color = d.color ?? p.color ?? WARM_LIGHT
        const k = clamp((d.brightness ?? 80) / 100, 0.08, 1)
        const mount = lightMount(floor, p)
        const z = zm(o, LAMP_HEIGHT[mount])
        // A shade over the bulb for a standing lamp, a dome for one hanging,
        // a flat lens set into the side of a pool.
        const shade =
          mount === 'pool'
            ? `<ellipse class="hv-shade${lit ? ' hv-on' : ''}" rx="10" ry="5" fill-opacity="0.5"/>`
            : mount === 'floor' || mount === 'table'
              ? `<path class="hv-shade${lit ? ' hv-on' : ''}" d="M-7,-4 L7,-4 L10,5 L-10,5 Z"/>`
              : mount === 'ceiling'
                ? `<line class="hv-cord" x1="0" y1="-7" x2="0" y2="-16"/><path class="hv-shade${lit ? ' hv-on' : ''}" d="M-9,1 A9,8 0 0 1 9,1 Z"/>`
                : `<rect class="hv-shade${lit ? ' hv-on' : ''}" x="-3" y="-9" width="6" height="8" rx="1.5"/>`
        const bulb = lit
          ? `<circle r="14" fill="${color}" opacity="${(0.22 + 0.3 * k).toFixed(2)}"/><circle class="hv-bulb" r="5.5" fill="${color}"/>`
          : '<circle class="hv-bulb hv-off-bulb" r="5"/>'
        svg = marker(
          o,
          d,
          p.x,
          p.y,
          z,
          mount === 'ceiling' || mount === 'pool' ? shade + bulb : bulb + shade,
          mount === 'floor' || mount === 'table' ? 'pole' : mount === 'pool' ? 'none' : 'dotted',
        )
        depth += mount === 'ceiling' ? 0.3 : 0
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
            leaf += `<line x1="${r1(a[0])}" y1="${r1(a[1])}" x2="${r1(b[0])}" y2="${r1(b[1])}" class="hv-gatepost" stroke-width="3" stroke-linecap="round"/>`
          }
        } else {
          const a = project(o.mode, ax, ay)
          const e = project(o.mode, bx, by)
          leaf = `<line x1="${r1(a[0])}" y1="${r1(a[1])}" x2="${r1(e[0])}" y2="${r1(e[1])}" class="hv-gatepost" stroke-width="5"/>`
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
    push(depth, svg)
  }

  items.sort((a, b) => a.depth - b.depth)
  marks.sort((a, b) => a.depth - b.depth)
  separate(marks, o.unit)
  // With an overlay on, the devices step back and the rooms' readings lead.
  const markup = marks.map((i) => i.svg).join('')
  const top = o.overlay === 'none' ? markup : `<g class="hv-dimmed">${markup}</g>${badges}`
  return `<defs>${defs}</defs>${base}${water}${glow}${pipes}${items.map((i) => i.svg).join('')}${top}`
}
