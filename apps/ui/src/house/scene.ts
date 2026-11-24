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
import type {
  HouseFloor,
  HouseFurniture,
  HouseLightMount,
  HouseLook,
  HousePlacement,
  HousePlan,
  HouseRoom,
} from '@/api'
import { Grid, area as loopArea } from '@nubisco/bim/cells'
import {
  CELLS_PER_M,
  ISO_FLOOR_MATRIX,
  S,
  clamp,
  circuitPath,
  doorSwing,
  esc,
  humidityColor,
  furnitureBack,
  oppositeSide,
  type Side,
  furnitureAt,
  furnitureHeight,
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
  roomShapes,
  roomSlants,
  roomsOutsideIn,
  wallRuns,
  CELL_MM,
  waterColor,
  type Point,
  type ViewMode,
} from './geometry'
import { floorWalls, runPieces, wallGaps, wallOutline, type FloorWall } from './editor'
import { specOf } from './openings'
import { ROLLS, coveringDraws, type CoveringDraw } from './coverings'
import { formatPower, stateText, type LiveDevice } from './live'

export const WARM_LIGHT = '#ffb45e'

/** How high each kind of light sits, in metres. */
const LAMP_HEIGHT = { ceiling: 2.35, wall: 1.8, floor: 1.5, table: 0.75, pool: 0.02 } as const

/**
 * How high a light's bulb is, in metres. A table lamp stands on the
 * furniture under it, or on a low side table when there is none drawn.
 */
function lampHeight(floor: HouseFloor, p: HousePlacement, mount: HouseLightMount): number {
  if (mount !== 'table') return LAMP_HEIGHT[mount]
  const under = furnitureAt(floor, p.x, p.y)
  return (under ? furnitureHeight(under) : 0.4) + 0.35
}

/** The height of whatever a device stands on, in metres: 0 on the floor. */
function standsOn(floor: HouseFloor, p: HousePlacement): number {
  const under = furnitureAt(floor, p.x, p.y)
  return under ? furnitureHeight(under) : 0
}

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
type Box = { x0: number; y0: number; x1: number; y1: number }
const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1

/** Returns where each badge ended up on screen, so the room names can keep clear of them. */
function separate(marks: Array<{ depth: number; svg: string }>, unit: number): Box[] {
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
      const hit = boxes.find((q) => overlaps(b, q))
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
  return boxes
}

/**
 * Room names in the plan view, laid over the furniture and pipes so they stay
 * readable. A name that would sit on a badge, a piece of furniture or another
 * name moves to the nearest clear spot in its room. If there is none it stays
 * in the middle.
 */
function placeRoomNames(names: RoomName[], taken: Box[]): string {
  const placed: Box[] = []
  let out = ''
  for (const n of names) {
    const w = n.text.length * n.fs * 0.72
    const h = n.fs * 1.2
    const box = (cx: number, cy: number): Box => ({ x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 })
    const inside = (b: Box) => b.x0 >= n.area.x0 && b.x1 <= n.area.x1 && b.y0 >= n.area.y0 && b.y1 <= n.area.y1
    const clear = (b: Box) => !taken.some((q) => overlaps(b, q)) && !placed.some((q) => overlaps(b, q))
    const step = h * 0.5
    let at: [number, number] = [n.x, n.y]
    search: for (let i = 0; i <= 24; i++) {
      // Nearest first: straight up or down, then a little to either side.
      for (const [dx, dy] of i === 0
        ? [[0, 0]]
        : [
            [0, -i],
            [0, i],
            [-i, 0],
            [i, 0],
            [-i, -i],
            [i, -i],
            [-i, i],
            [i, i],
          ]) {
        const cx = n.x + dx * step * 1.5
        const cy = n.y + dy * step
        const b = box(cx, cy)
        if ((i === 0 || inside(b)) && clear(b)) {
          at = [cx, cy]
          break search
        }
      }
    }
    placed.push(box(at[0], at[1]))
    out += `<text class="hv-rlabel hv-rlabel-top" x="${r1(at[0])}" y="${r1(at[1])}" font-size="${r1(n.fs)}" stroke-width="${(n.fs * 0.3).toFixed(2)}" dy="${r1(n.fs * 0.35)}">${esc(n.text)}</text>`
  }
  return out
}

type RoomName = { text: string; x: number; y: number; fs: number; area: Box }

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
 * A circuit's pipes. With one water temperature there is one pipe in that
 * colour. When the device also reports the water coming back, there are two,
 * side by side as they are laid in a real floor: the flow, out from the pump
 * in its colour, and the return, back to it in its own, each moving its way
 * while the pump runs.
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
  const opacity = flowing ? 0.6 : 0.3
  const line = (path: Point[], color: string) => {
    const points = path.map(([x, y]) => project(o.mode, x, y, 0.04)).map((p) => `${r1(p[0])},${r1(p[1])}`)
    let s = `<polyline class="hv-pipe" points="${points.join(' ')}" stroke="${color}" stroke-width="${r1(w)}" opacity="${opacity}"/>`
    if (flowing) s += `<polyline class="hv-flow" stroke-width="${r1(w * 0.36)}" points="${points.join(' ')}"/>`
    return s
  }
  if (ret === undefined || supply === undefined) return line(pts, waterColor(supply ?? 20))
  // The return runs alongside, a little off the flow. The paths are square,
  // so one diagonal offset keeps it parallel on every leg. It is reversed so
  // its water moves back toward the pump.
  const k = 0.45
  const back = pts.map(([x, y]) => [x + k, y + k] as Point).reverse()
  return line(back, waterColor(ret)) + line(pts, waterColor(supply))
}

/**
 * Whether a heat pump that is on is resting: running its circulation with the
 * compressor idle, so the water comes back as warm as it left. Half a degree
 * covers the sensors' rounding.
 */
export function resting(d: { on?: boolean; supply?: number; return?: number }): boolean {
  return d.on === true && d.supply !== undefined && d.return !== undefined && Math.abs(d.supply - d.return) < 0.5
}

/**
 * The visible edges of a floor's slab: the faces toward the viewer (larger y
 * and larger x) of every cell a room covers, merged into straight runs.
 */
function slab(o: SceneOptions, floor: HouseFloor): string {
  // Rooms drawn corner by corner: the faces of their edges that face the
  // viewer (whose outside is towards +x or +y).
  let poly2 = ''
  const t0 = 0.35
  for (const r of floor.rooms) {
    if (!r.outline) continue
    const loop = loopArea(r.outline) < 0 ? r.outline.slice().reverse() : r.outline
    loop.forEach((a, i) => {
      const b = loop[(i + 1) % loop.length]
      // Clockwise on screen, the outside of a→b is (dy, -dx).
      const nx = b[1] - a[1]
      const ny = a[0] - b[0]
      if (nx <= 0 && ny <= 0) return
      poly2 += `<polygon class="hv-slab${nx > ny ? ' hv-r' : ''}" points="${poly(o, [
        [a[0], a[1], 0],
        [b[0], b[1], 0],
        [b[0], b[1], -t0],
        [a[0], a[1], -t0],
      ])}"/>`
    })
  }
  // The rest on a grid cut at every room corner, so each cell is wholly floor or not.
  const rects = floor.rooms.filter((r) => !r.outline).flatMap(roomRects)
  if (!rects.length) return poly2
  const g = Grid.of(rects, [], CELL_MM)
  const cells = g.cells(rects)
  const t = 0.35
  // Runs of exposed edge, in grid indices: [line, from, to].
  const front: Array<[number, number, number]> = []
  const side: Array<[number, number, number]> = []
  const extend = (list: Array<[number, number, number]>, line: number, at: number) => {
    const last = list[list.length - 1]
    if (last && last[0] === line && last[2] === at) last[2] = at + 1
    else list.push([line, at, at + 1])
  }
  const all = [...cells]
  for (const [i, j] of all.slice().sort((a, b) => a[1] - b[1] || a[0] - b[0]))
    if (!cells.has(i, j + 1)) extend(front, j + 1, i)
  for (const [i, j] of all.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]))
    if (!cells.has(i + 1, j)) extend(side, i + 1, j)
  let out = ''
  for (const [j, i1, i2] of front) {
    const [y, x1, x2] = [g.ys.at[j], g.xs.at[i1], g.xs.at[i2]]
    out += `<polygon class="hv-slab" points="${poly(o, [
      [x1, y, 0],
      [x2, y, 0],
      [x2, y, -t],
      [x1, y, -t],
    ])}"/>`
  }
  for (const [i, j1, j2] of side) {
    const [x, y1, y2] = [g.xs.at[i], g.ys.at[j1], g.ys.at[j2]]
    out += `<polygon class="hv-slab hv-r" points="${poly(o, [
      [x, y1, 0],
      [x, y2, 0],
      [x, y2, -t],
      [x, y1, -t],
    ])}"/>`
  }
  return out + poly2
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

/** A strip of a rectangle along one of its sides, `t` cells thick. */
function strip(f: { x: number; y: number; w: number; d: number }, side: Side, t: number) {
  t = Math.min(t, side === 'up' || side === 'down' ? f.d : f.w)
  if (side === 'up') return { x: f.x, y: f.y, w: f.w, d: t }
  if (side === 'down') return { x: f.x, y: f.y + f.d - t, w: f.w, d: t }
  if (side === 'left') return { x: f.x, y: f.y, w: t, d: f.d }
  return { x: f.x + f.w - t, y: f.y, w: t, d: f.d }
}

/** A rectangle shrunk by `m` cells on every side, never to nothing. */
function inset(f: { x: number; y: number; w: number; d: number }, m: number) {
  const mx = Math.min(m, f.w / 4)
  const my = Math.min(m, f.d / 4)
  return { x: f.x + mx, y: f.y + my, w: f.w - mx * 2, d: f.d - my * 2 }
}

type Block = { r: { x: number; y: number; w: number; d: number }; z0: number; z1: number; cls: string }

/** Blocks drawn back to front, so the nearer one covers the further. */
function blocks(o: SceneOptions, list: Block[]): string {
  return list
    .slice()
    .sort((a, b) => a.r.x + a.r.w / 2 + a.r.y + a.r.d / 2 - (b.r.x + b.r.w / 2 + b.r.y + b.r.d / 2))
    .map(({ r, z0, z1, cls }) => box(o, r.x + r.w / 2, r.y + r.d / 2, r.w, r.d, z0, z1, cls))
    .join('')
}

/** A flat rectangle at height z. */
function flat(o: SceneOptions, r: { x: number; y: number; w: number; d: number }, z: number, cls: string): string {
  return `<polygon class="${cls}" points="${poly(o, [
    [r.x, r.y, z],
    [r.x + r.w, r.y, z],
    [r.x + r.w, r.y + r.d, z],
    [r.x, r.y + r.d, z],
  ])}"/>`
}

function seg(o: SceneOptions, a: [number, number, number], b: [number, number, number], cls: string): string {
  const p = project(o.mode, ...a)
  const q = project(o.mode, ...b)
  return `<line class="${cls}" x1="${r1(p[0])}" y1="${r1(p[1])}" x2="${r1(q[0])}" y2="${r1(q[1])}"/>`
}

/**
 * A piece of furniture, as plain volumes in one quiet tone, so the plan reads
 * as the home without saying what style it is in. Pieces with a back (a bed's
 * head, a sofa's back) put it on the side `furnitureBack` names.
 */
function furniturePiece(o: SceneOptions, floor: HouseFloor, f: HouseFurniture): string {
  const iso = o.mode === 'iso'
  const top = zm(o, furnitureHeight(f))
  const cm = (metres: number) => metres * CELLS_PER_M
  const back = furnitureBack(floor, f)
  const ends: Side[] = back === 'up' || back === 'down' ? ['left', 'right'] : ['up', 'down']
  switch (f.kind) {
    case 'table': {
      const t = zm(o, 0.04)
      let svg = ''
      if (iso) {
        // Legs a little in from each corner.
        const g = inset(f, 0.15)
        for (const [lx, ly] of [
          [g.x, g.y],
          [g.x + g.w, g.y],
          [g.x, g.y + g.d],
          [g.x + g.w, g.y + g.d],
        ])
          svg += seg(o, [lx, ly, 0], [lx, ly, top - t], 'hv-furnleg')
      }
      return svg + box(o, f.x + f.w / 2, f.y + f.d / 2, f.w, f.d, top - t, top, 'hv-furn')
    }
    case 'bed': {
      const frame = zm(o, 0.3)
      const mattress = inset(f, 0.08)
      // The pillow lies across the head end of the mattress.
      const pillow = inset(strip(mattress, back, cm(0.3)), 0.08)
      return blocks(o, [
        { r: f, z0: 0, z1: frame, cls: 'hv-furn' },
        { r: mattress, z0: frame, z1: top, cls: 'hv-bed' },
      ]).concat(
        box(
          o,
          pillow.x + pillow.w / 2,
          pillow.y + pillow.d / 2,
          pillow.w,
          pillow.d,
          top,
          top + zm(o, 0.08),
          'hv-pillow',
        ),
      )
    }
    case 'sofa': {
      const seat = zm(o, 0.42)
      const arms = zm(o, 0.6)
      return blocks(o, [
        { r: f, z0: 0, z1: seat, cls: 'hv-furn' },
        { r: strip(f, back, cm(0.2)), z0: seat, z1: top, cls: 'hv-furn' },
        { r: strip(f, ends[0], cm(0.18)), z0: seat, z1: arms, cls: 'hv-furn' },
        { r: strip(f, ends[1], cm(0.18)), z0: seat, z1: arms, cls: 'hv-furn' },
      ])
    }
    case 'lounger': {
      // A low frame, and a backrest raised at the head.
      return blocks(o, [
        { r: f, z0: zm(o, 0.08), z1: top, cls: 'hv-bed' },
        { r: strip(f, back, cm(0.6)), z0: top, z1: top + zm(o, 0.3), cls: 'hv-bed' },
      ])
    }
    case 'island':
      // The worktop overhangs the block a little, as an island's does.
      return (
        box(
          o,
          f.x + f.w / 2,
          f.y + f.d / 2,
          Math.max(0.2, f.w - 0.12),
          Math.max(0.2, f.d - 0.12),
          0,
          top - zm(o, 0.04),
          'hv-furn',
        ) + box(o, f.x + f.w / 2, f.y + f.d / 2, f.w, f.d, top - zm(o, 0.04), top, 'hv-worktop')
      )
    case 'shelves': {
      let svg = box(o, f.x + f.w / 2, f.y + f.d / 2, f.w, f.d, 0, top, 'hv-furn')
      // Shelves show on the open front, when the view looks at it.
      const front = oppositeSide(back)
      if (iso && (front === 'down' || front === 'right')) {
        for (let k = 1; k < 5; k++) {
          const z = (top * k) / 5
          svg +=
            front === 'down'
              ? seg(o, [f.x + 0.05, f.y + f.d, z], [f.x + f.w - 0.05, f.y + f.d, z], 'hv-shelf')
              : seg(o, [f.x + f.w, f.y + 0.05, z], [f.x + f.w, f.y + f.d - 0.05, z], 'hv-shelf')
        }
      }
      return svg
    }
    case 'rug':
      return flat(o, f, 0, 'hv-rug') + flat(o, inset(f, 0.15), 0, 'hv-rugin')
    case 'bath':
      return (
        box(o, f.x + f.w / 2, f.y + f.d / 2, f.w, f.d, 0, top, 'hv-ap') + flat(o, inset(f, cm(0.08)), top, 'hv-bathin')
      )
    case 'shower':
      // A tray, and glass to head height that the room shows through.
      return (
        box(o, f.x + f.w / 2, f.y + f.d / 2, f.w, f.d, 0, zm(o, 0.05), 'hv-ap') +
        (iso ? box(o, f.x + f.w / 2, f.y + f.d / 2, f.w, f.d, zm(o, 0.05), top, 'hv-glass') : '')
      )
    case 'toilet': {
      const cistern = strip(f, back, cm(0.18))
      const bowl = inset(f, 0.05)
      return blocks(o, [
        { r: bowl, z0: 0, z1: zm(o, 0.4), cls: 'hv-ap' },
        { r: cistern, z0: 0, z1: top, cls: 'hv-ap' },
      ])
    }
    case 'basin': {
      const counter = top - zm(o, 0.04)
      return (
        box(o, f.x + f.w / 2, f.y + f.d / 2, f.w, f.d, 0, counter, 'hv-furn') +
        box(o, f.x + f.w / 2, f.y + f.d / 2, f.w, f.d, counter, top, 'hv-ap') +
        disc(o, f.x + f.w / 2, f.y + f.d / 2, top, Math.min(f.w, f.d) * 0.3, 'hv-sink')
      )
    }
    case 'parasol': {
      const cx = f.x + f.w / 2
      const cy = f.y + f.d / 2
      const r = Math.min(f.w, f.d) / 2
      return (
        disc(o, cx, cy, 0, Math.min(0.35, r * 0.3), 'hv-furn') +
        seg(o, [cx, cy, 0], [cx, cy, top], 'hv-pole') +
        disc(o, cx, cy, top, r, 'hv-canopy')
      )
    }
    case 'planter': {
      const plant = Math.min(f.w, f.d) / 2
      return (
        box(o, f.x + f.w / 2, f.y + f.d / 2, f.w, f.d, 0, top, 'hv-furn') +
        disc(o, f.x + f.w / 2, f.y + f.d / 2, top + zm(o, 0.12), plant * 0.95, 'hv-plant') +
        disc(o, f.x + f.w / 2, f.y + f.d / 2, top + zm(o, 0.3), plant * 0.6, 'hv-plant hv-t')
      )
    }
    case 'pergola': {
      // Four posts, two beams along its length and slats across them.
      const g = inset(f, 0.1)
      const corners: Array<[number, number]> = [
        [g.x, g.y],
        [g.x + g.w, g.y],
        [g.x, g.y + g.d],
        [g.x + g.w, g.y + g.d],
      ]
      let svg = ''
      const alongX = f.w >= f.d
      if (iso) for (const [px, py] of corners.slice(0, 3)) svg += seg(o, [px, py, 0], [px, py, top], 'hv-post')
      svg += alongX
        ? seg(o, [f.x, g.y, top], [f.x + f.w, g.y, top], 'hv-beam') +
          seg(o, [f.x, g.y + g.d, top], [f.x + f.w, g.y + g.d, top], 'hv-beam')
        : seg(o, [g.x, f.y, top], [g.x, f.y + f.d, top], 'hv-beam') +
          seg(o, [g.x + g.w, f.y, top], [g.x + g.w, f.y + f.d, top], 'hv-beam')
      for (let t = 0.5; t < (alongX ? f.w : f.d); t += 0.5) {
        svg += alongX
          ? seg(o, [f.x + t, f.y, top + 0.01], [f.x + t, f.y + f.d, top + 0.01], 'hv-slat')
          : seg(o, [f.x, f.y + t, top + 0.01], [f.x + f.w, f.y + t, top + 0.01], 'hv-slat')
      }
      // The post nearest the viewer goes in front of the slats.
      if (iso) svg += seg(o, [corners[3][0], corners[3][1], 0], [corners[3][0], corners[3][1], top], 'hv-post')
      return svg
    }
    default:
      return box(o, f.x + f.w / 2, f.y + f.d / 2, f.w, f.d, 0, top, 'hv-furn')
  }
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
    case 'tap': {
      // A standpipe with its spout, and water falling from it while it runs.
      const h = zm(o, 0.65)
      const spout: [number, number, number] = [p.x + m(0.12), p.y + m(0.12), h * 0.8]
      let svg = disc(o, p.x, p.y, 0, m(0.12), 'hv-drain')
      svg += seg(o, [p.x, p.y, 0], [p.x, p.y, h], 'hv-standpipe')
      svg += seg(o, [p.x, p.y, h * 0.85], spout, 'hv-spout')
      svg += disc(o, p.x, p.y, h, m(0.05), 'hv-handle')
      if (on) {
        const a = project(o.mode, ...spout)
        const b = project(o.mode, spout[0], spout[1], 0)
        svg += `<line class="hv-tapwater" x1="${r1(a[0])}" y1="${r1(a[1])}" x2="${r1(b[0])}" y2="${r1(b[1])}"/>`
        svg += disc(o, spout[0], spout[1], 0, m(0.14), 'hv-splash')
      }
      return { svg, top: h }
    }
    case 'outlet':
      return { svg: '', top: zm(o, 0.3) }
  }
}

/**
 * Each walled room's reading for an overlay, from a sensor standing in it. A
 * heating device's temperature is its water, not the room's, so it never
 * counts. A device on a window (a shutter) is in no room. For temperature, a
 * garden with no sensor of its own takes the outside temperature a heat pump
 * reports, wherever that heat pump stands.
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
  if (overlay === 'temperature') {
    const outside = [...devices.values()].find((d) => d.reachable && d.outside !== undefined)?.outside
    if (outside !== undefined)
      for (const r of floor.rooms) if (r.kind === 'outdoor' && !out.has(r.id)) out.set(r.id, outside)
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
// ─── Coverings ──────────────────────────────────────────────────────────────
// Each covering on a door or window is drawn by its kind, on its own side of
// the glass (coverings.ts says which), and as closed as its device reports.
// One worked by hand is drawn open. A covering a device drives is that
// device on the plan: focusable, with its position on a pill above it.

/** How far off the glass a covering hangs, in cells. */
const OFF = 0.14

/** A point along the opening from A to B at t, pushed off the wall by k cells. */
const along = (A: Point, B: Point, n: Point, t: number, k: number): Point => [
  lerp(A[0], B[0], t) + n[0] * k,
  lerp(A[1], B[1], t) + n[1] * k,
]

/** The device wrapper and pill for a driven covering, the pill at t along the opening. */
function driven(o: SceneOptions, c: CoveringDraw, svg: string, at: Point): string {
  const d = c.device
  if (!d) return svg
  return (
    `<g class="hv-dev${d.reachable ? '' : ' hv-off'}" data-ref="${esc(d.ref)}" role="button" tabindex="0" aria-label="${label(d)}">` +
    svg +
    `<g transform="translate(${r1(at[0])},${r1(at[1])}) scale(${o.unit.toFixed(4)})"><circle class="hv-hit" r="18"/>` +
    pill(`${Math.round(d.position ?? 0)}%`, { cls: o.selected === d.ref ? 'hv-on' : '' }) +
    '</g></g>'
  )
}

/** A zigzag from t0 to t1 along the opening: curtains gathered in folds. */
function folds(A: Point, B: Point, n: Point, t0: number, t1: number, len: number): Point[] {
  const steps = Math.max(2, Math.round((Math.abs(t1 - t0) * len) / 0.12))
  return Array.from({ length: steps + 1 }, (_, i) => along(A, B, n, lerp(t0, t1, i / steps), OFF + (i % 2 ? 0.1 : 0)))
}

/** The coverings on one opening in the plan view. */
function coverings2d(o: SceneOptions, A: Point, B: Point, len: number, list: CoveringDraw[]): string {
  const P = (q: Point) => project(o.mode, q[0], q[1])
  const pts = (qs: Point[]) => qs.map((q) => P(q).map(r1).join(',')).join(' ')
  const ln = (cls: string, p: Point, q: Point) => {
    const [a, b] = [P(p), P(q)]
    return `<line class="${cls}" x1="${r1(a[0])}" y1="${r1(a[1])}" x2="${r1(b[0])}" y2="${r1(b[1])}"/>`
  }
  return list
    .map((c, i) => {
      const n = c.normal
      const k = c.covering.kind
      let svg = ''
      if (ROLLS.has(k)) {
        // The box it rolls into, and the part rolled down over the glass.
        svg = ln('hv-box2d', along(A, B, n, 0, OFF), along(A, B, n, 1, OFF))
        if (c.closed > 0.01)
          svg += ln(k === 'blind' ? 'hv-blind2d' : 'hv-slats2d', along(A, B, n, 0, OFF), along(A, B, n, c.closed, OFF))
      } else if (k === 'curtain') {
        // Two curtains, drawn back to the sides when open, meeting when closed.
        const w = 0.12 + 0.38 * c.closed
        svg =
          `<polyline class="hv-curtain2d" points="${pts(folds(A, B, n, 0, w, len))}"/>` +
          `<polyline class="hv-curtain2d" points="${pts(folds(A, B, n, 1, 1 - w, len))}"/>`
      } else {
        // An awning: folded against the wall, or out over the opening.
        const out = 1.4 * c.closed
        svg =
          out > 0.05
            ? `<polygon class="hv-awning2d" points="${pts([along(A, B, n, 0, OFF), along(A, B, n, 1, OFF), along(A, B, n, 1, OFF + out), along(A, B, n, 0, OFF + out)])}"/>`
            : ln('hv-box2d', along(A, B, n, 0, OFF), along(A, B, n, 1, OFF))
      }
      const mid = P(along(A, B, n, (i + 1) / (list.length + 1), OFF))
      return driven(o, c, svg, [mid[0], mid[1] - 16 * o.unit])
    })
    .join('')
}

/**
 * The coverings on one opening in the 3D view, each as its own item so the
 * depth sort puts the inside ones behind the glass and the outside ones in
 * front. `z0` to `zt` is the glass, `H` the wall's top.
 */
function coverings3d(
  o: SceneOptions,
  A: Point,
  B: Point,
  len: number,
  z0: number,
  zt: number,
  H: number,
  list: CoveringDraw[],
): Array<{ depth: number; svg: string }> {
  return list.map((c, i) => {
    const n = c.normal
    const k = c.covering.kind
    const at = (t: number, off: number, z: number): [number, number, number] => [...along(A, B, n, t, off), z]
    const band = (t0: number, t1: number, z1: number, z2: number, off = OFF) =>
      poly(o, [at(t0, off, z1), at(t1, off, z1), at(t1, off, z2), at(t0, off, z2)])
    // The box sits over the glass, or at the very top where the glass runs to it.
    const zbox = Math.min(zt, H - 0.14)
    const box = `<polygon class="hv-rollbox" points="${band(0, 1, zbox, zbox + 0.14)}"/>`
    let svg = ''
    if (ROLLS.has(k)) {
      svg = box
      if (c.closed > 0.01) {
        const zb = zbox - (zbox - z0) * c.closed
        if (k === 'blind') svg += `<polygon class="hv-blind" points="${band(0, 1, zb, zbox)}"/>`
        else {
          svg += `<polygon class="hv-slats" points="${band(0, 1, zb, zbox)}"/>`
          for (let z = zbox - 0.18; z > zb + 0.04; z -= 0.18) {
            const p = project(o.mode, ...at(0, OFF, z))
            const q = project(o.mode, ...at(1, OFF, z))
            svg += `<line class="hv-slatl" x1="${r1(p[0])}" y1="${r1(p[1])}" x2="${r1(q[0])}" y2="${r1(q[1])}"/>`
          }
        }
      }
    } else if (k === 'curtain') {
      // Hung from just over the glass to the floor, or to just under a sill.
      const w = 0.12 + 0.38 * c.closed
      const top = Math.min(H - 0.02, zt + 0.1)
      const bottom = z0 > 0.3 ? Math.max(0.02, z0 - 0.25) : 0.02
      const panel = (t0: number, t1: number) => {
        let s = `<polygon class="hv-curtain" points="${band(t0, t1, bottom, top, OFF + 0.05)}"/>`
        for (let j = 1; j < 4; j++) {
          const t = lerp(t0, t1, j / 4)
          const p = project(o.mode, ...at(t, OFF + 0.05, bottom))
          const q = project(o.mode, ...at(t, OFF + 0.05, top))
          s += `<line class="hv-curtainl" x1="${r1(p[0])}" y1="${r1(p[1])}" x2="${r1(q[0])}" y2="${r1(q[1])}"/>`
        }
        return s
      }
      svg = panel(0, w) + panel(1 - w, 1)
    } else {
      const out = 1.4 * c.closed
      const z = zbox + 0.07
      svg =
        out > 0.05
          ? `<polygon class="hv-awning" points="${poly(o, [at(0, OFF, z), at(1, OFF, z), at(1, OFF + out, z - 0.45 * c.closed), at(0, OFF + out, z - 0.45 * c.closed)])}"/>`
          : box
    }
    const m = project(o.mode, ...at((i + 1) / (list.length + 1), OFF, H + 0.64))
    const mid = along(A, B, n, 0.5, OFF + (k === 'awning' ? 0.7 * c.closed : 0))
    return { depth: mid[0] + mid[1] + 0.01, svg: driven(o, c, svg, m) }
  })
}

// ─── Walls as solids ────────────────────────────────────────────────────────

const unit = (a: Point, b: Point): Point => {
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
  return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]
}
const leftOf = (d: Point): Point => [-d[1], d[0]]

/** A plain outline for a piece of wall in a door's or window's run: square both ends. */
function squareOutline(A: Point, B: Point, half: number): Point[] {
  const n = leftOf(unit(A, B))
  const at = (q: Point, k: number): Point => [q[0] + n[0] * k, q[1] + n[1] * k]
  return [at(A, half), at(B, half), at(B, -half), at(A, -half)]
}

/**
 * A wall as the solid it is, from z1 to z2, standing on its outline: the
 * faces the view sees and the top. `glow` gives the light of the room a seen
 * long face looks into, if it is lit.
 */
function solidWall(
  o: SceneOptions,
  outline: Point[],
  z1: number,
  z2: number,
  glow?: (x: number, y: number) => { color: string; k: number } | undefined,
): string {
  const c: Point = [outline.reduce((t, q) => t + q[0], 0) / 4, outline.reduce((t, q) => t + q[1], 0) / 4]
  let svg = ''
  if (z2 > z1) {
    outline.forEach((p, i) => {
      const q = outline[(i + 1) % 4]
      const len = Math.hypot(q[0] - p[0], q[1] - p[1])
      if (len < 1e-6) return
      // Its outward normal. The view looks in from +x and +y, so it sees the faces turned that way.
      let m: Point = [-(q[1] - p[1]) / len, (q[0] - p[0]) / len]
      const mid: Point = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]
      if (m[0] * (mid[0] - c[0]) + m[1] * (mid[1] - c[1]) < 0) m = [-m[0], -m[1]]
      if (m[0] + m[1] <= 0) return
      const face = poly(o, [
        [p[0], p[1], z1],
        [q[0], q[1], z1],
        [q[0], q[1], z2],
        [p[0], p[1], z2],
      ])
      const long = i % 2 === 0
      svg += `<polygon class="hv-wall${long ? '' : ' hv-wallend'}" points="${face}"/>`
      const g = long ? glow?.(mid[0] + m[0] * 0.25, mid[1] + m[1] * 0.25) : undefined
      if (g)
        svg += `<polygon class="hv-walllit" fill="${g.color}" fill-opacity="${(0.12 + 0.26 * g.k).toFixed(2)}" points="${face}"/>`
    })
  }
  svg += `<polygon class="hv-walltop" points="${poly(
    o,
    outline.map((q): [number, number, number] => [q[0], q[1], z2]),
  )}"/>`
  return svg
}

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
  let rugs = ''
  const items: Array<{ depth: number; svg: string }> = []

  // No plot and no grid: the floor is what was drawn on it, standing on a
  // slab like an architect's model, so the house reads as a house.
  if (iso) base += slab(o, floor)

  // Rooms, with the overlay tint from a sensor in the room.
  const roomOf = (p: HousePlacement) => roomAt(floor, p.x, p.y)
  const readings = o.overlay === 'none' ? new Map<string, number>() : roomReadings(floor, devices, o.overlay)
  let badges = ''
  // In the plan view the names go on top of everything but the badges.
  const names: RoomName[] = []
  // What a name should not sit on, besides the badges: the furniture.
  const furnitureBoxes: Box[] = []
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
    const shapes = roomShapes(r).map((loop) =>
      poly(
        o,
        loop.map(([x, y]): [number, number, number] => [x, y, 0]),
      ),
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
        // A garden usually has the house standing in its middle, so its
        // reading sits near its front-left corner instead, and says what it is.
        const q = roomRects(r).reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a))
        const outdoor = r.kind === 'outdoor'
        const c = outdoor
          ? project(o.mode, q.x + Math.min(2.5, q.w / 2), q.y + Math.max(q.h - 1.5, q.h / 2), zm(o, 0.4))
          : project(o.mode, q.x + q.w / 2, q.y + q.h / 2, zm(o, 1.6))
        const text = (outdoor ? 'Outside ' : '') + overlayText(o.overlay, reading)
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
    for (const e of roomOutline(r)) {
      const a = e.axis === 'h' ? project(o.mode, e.start, e.line) : project(o.mode, e.line, e.start)
      const b = e.axis === 'h' ? project(o.mode, e.end, e.line) : project(o.mode, e.line, e.end)
      outline += `M${r1(a[0])},${r1(a[1])}L${r1(b[0])},${r1(b[1])}`
    }
    for (const [p, q] of roomSlants(r)) {
      const a = project(o.mode, p[0], p[1])
      const b = project(o.mode, q[0], q[1])
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
      if (!iso) {
        const [x0, y0] = project(o.mode, q.x, q.y)
        const [x1, y1] = project(o.mode, q.x + q.w, q.y + q.h)
        names.push({ text: name, x: c[0], y: c[1], fs, area: { x0, y0, x1, y1 } })
      } else
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
      glow += `<g class="hv-wash" fill="${color}" fill-opacity="${wash.toFixed(2)}"${clip}>${roomShapes(r)
        .map(
          (loop) =>
            `<polygon points="${poly(
              o,
              loop.map(([x, y]): [number, number, number] => [x, y, 0]),
            )}"/>`,
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

  // Furniture, depth-sorted with the walls and appliances by its centre.
  for (const f of floor.furniture ?? []) {
    // A rug lies on the floor, over the pipes under it and under everything
    // standing on it, and lets the room's light through.
    if (f.kind === 'rug') {
      rugs += furniturePiece(o, floor, f)
      continue
    }
    if (!iso) {
      const [x0, y0] = project(o.mode, f.x, f.y)
      const [x1, y1] = project(o.mode, f.x + f.w, f.y + f.d)
      furnitureBoxes.push({ x0, y0, x1, y1 })
    }
    items.push({
      depth: f.x + f.w / 2 + f.y + f.d / 2,
      svg: `<g pointer-events="none">${furniturePiece(o, floor, f)}</g>`,
    })
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
    // Radiators stay white. Heat shows as a glow and an edge in the water's
    // colour. With the water coming back known, the edge runs from the flow's
    // colour at one end to the return's at the other, as the water cools
    // crossing it.
    let edge = water
    if (hot && feed?.return !== undefined && feed.supply !== undefined) {
      const gid = `hv-rg-${svgId(floor.id)}-${svgId(rad.id)}`
      const p = project(o.mode, a2[0], a2[1])
      const q = project(o.mode, b2[0], b2[1])
      defs +=
        `<linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="${r1(p[0])}" y1="${r1(p[1])}" x2="${r1(q[0])}" y2="${r1(q[1])}">` +
        `<stop offset="0" stop-color="${water}"/><stop offset="1" stop-color="${waterColor(feed.return)}"/></linearGradient>`
      edge = `url(#${gid})`
    }
    const style = hot ? ` style="--hv-water:${water};stroke:${edge}"` : ''
    const fins: string[] = []
    const fd = unit(a2, b2)
    for (let t = 0.25; t < rad.len - 0.01; t += 0.25) fins.push(`${a2[0] + t * fd[0]},${a2[1] + t * fd[1]}`)
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

  // Walls, doors and windows, and what covers the glass.
  // The walls of a lit room catch its light, on the side facing into it.
  const litRooms = new Map<string, { color: string; k: number }>()
  if (o.overlay === 'none') for (const l of lit) if (l.room && l.room.kind === 'room') litRooms.set(l.room.id, l)
  const walls = floorWalls(floor)
  const runs = wallRuns(floor)
  // Where the walls are not: doors, windows and open stretches.
  const gaps = wallGaps(runs)
  for (const w of runs) {
    // An open stretch is a wall that is not there: nothing to draw.
    if (w.type === 'open') continue
    const depth = (w.x1 + w.x2 + w.y1 + w.y2) / 2
    const A: Point = [w.x1, w.y1]
    const B: Point = [w.x2, w.y2]
    let svg = ''
    if (!iso) {
      const a = project(o.mode, A[0], A[1])
      const c = project(o.mode, B[0], B[1])
      const ln = (cls: string, p: Point, q: Point, extra = '') =>
        `<line class="${cls}" x1="${r1(p[0])}" y1="${r1(p[1])}" x2="${r1(q[0])}" y2="${r1(q[1])}"${extra}/>`
      if (w.type === 'wall') {
        // As thick as it is built, each wall of the run its own thickness,
        // its ends closing the corners it makes with others.
        for (const pc of runPieces(w, walls)) {
          const pts = wallOutline(pc.A, pc.B, pc.w, walls, gaps).map((q) => project(o.mode, q[0], q[1]))
          svg += `<polygon class="hv-wallsolid2d" points="${pts.map((q) => `${r1(q[0])},${r1(q[1])}`).join(' ')}"/>`
        }
      } else {
        if (w.type === 'door' && w.opening) {
          // The leaf drawn open, and the arc its free end sweeps, on the side
          // and from the hinge the plan says. A glass leaf is drawn as glass.
          const sw = doorSwing(w.opening)
          const h = project(o.mode, ...sw.hinge)
          const q = project(o.mode, ...sw.open)
          const f = project(o.mode, ...sw.free)
          const len = w.opening.len * S
          svg =
            ln('hv-sill2d', a, c) +
            `<path class="hv-door2d${w.opening.glass ? ' hv-glassdoor2d' : ''}" d="M${r1(h[0])},${r1(h[1])} L${r1(q[0])},${r1(q[1])} A${r1(len)},${r1(len)} 0 0 ${sw.sweep} ${r1(f[0])},${r1(f[1])}"/>`
        } else if (w.type === 'slider') {
          // Two leaves on their own tracks, overlapping in the middle.
          const g = 0.12
          // Set off across the wall: along x that is y, along y it is x.
          const n: Point = w.axis === 'h' ? [0, 1] : w.axis === 'v' ? [1, 0] : leftOf(unit(A, B))
          const at = (t: number, k: number) =>
            project(o.mode, lerp(A[0], B[0], t) + n[0] * k * g, lerp(A[1], B[1], t) + n[1] * k * g)
          svg =
            ln('hv-sill2d', a, c) +
            ln('hv-pane2d hv-slide2d', at(0, -1), at(0.55, -1)) +
            ln('hv-pane2d hv-slide2d', at(0.45, 1), at(1, 1))
        } else svg = ln('hv-wall2d hv-glass2d', a, c) + ln('hv-pane2d', a, c)
        if (w.opening) svg += coverings2d(o, A, B, w.opening.len, coveringDraws(floor, w.opening, devices))
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
    const glow = (x: number, y: number) => {
      const r = roomAt(floor, x, y)
      return r ? litRooms.get(r.id) : undefined
    }
    // Each wall stands as high as it is built (at the drawing's half scale),
    // or no higher than the cut when the walls are drawn low.
    const tall = (fw: FloorWall) => {
      const real = zm(o, fw.height / 1000)
      return o.walls === 'up' ? real : Math.min(H, real)
    }
    const pieces = runPieces(w, walls)
    if (w.type === 'wall') {
      for (const pc of pieces) {
        svg += solidWall(o, wallOutline(pc.A, pc.B, pc.w, walls, gaps), 0, tall(pc.w), glow)
      }
    } else {
      // The wall the opening is in: its thickness frames it, and what is
      // above and below it is solid wall.
      const host = pieces[0]?.w
      const half = host ? host.thickness / 2 / CELL_MM : 0
      const HW = host ? tall(host) : H
      const solid = (z1: number, z2: number) => solidWall(o, squareOutline(A, B, half), z1, z2, glow)
      // A window is glass over a low wall, up to the top. A sliding door is
      // glass from the floor to door height, in a frame with a mullion where
      // its two leaves meet, and wall above. A door is its leaf, swung open,
      // in a frame with wall above, and a glass door's leaf is glass. A full
      // height window is a sliding door that does not open: glass from the
      // floor to its head, with no mullion.
      const door = w.type === 'door' && !!w.opening
      const slider = w.type === 'slider'
      const win = w.type === 'window' && w.opening ? specOf(w.opening) : null
      const full = !!win && win.sill === 0
      // Heights drawn at half scale, as a door's 2.1 m head is drawn 1.05 m.
      const head = full ? (win.head / 1000) * 0.5 * CELLS_PER_M : 1.05 * CELLS_PER_M
      const z0 = slider || door || full ? 0 : HW * 0.3
      const zt = slider || door || full ? Math.min(HW, head) : HW
      if (door && w.opening) {
        const hd = zt
        const sw = doorSwing(w.opening)
        const q = sw.at(0.78)
        // A solid leaf takes the colour the plan gives its door, a white
        // wooden door white. Unsaid, it is the usual wood.
        const colour = !w.opening.glass ? w.opening.spec?.frame?.colour : undefined
        const fill = colour && /^#[0-9a-f]{6}$/i.test(colour) ? ` style="fill:${colour}"` : ''
        svg =
          `<polygon class="hv-doorleaf${w.opening.glass ? ' hv-glassleaf' : ''}"${fill} points="${poly(o, [
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
        if (HW > hd + 0.1) svg += solid(hd, HW)
      } else if (slider || full) {
        const m1 = project(o.mode, (A[0] + B[0]) / 2, (A[1] + B[1]) / 2, 0)
        const m2 = project(o.mode, (A[0] + B[0]) / 2, (A[1] + B[1]) / 2, zt)
        svg =
          `<polygon class="hv-pane" points="${quad(0, zt)}"/>` +
          (slider
            ? `<line class="hv-slideframe" x1="${r1(m1[0])}" y1="${r1(m1[1])}" x2="${r1(m2[0])}" y2="${r1(m2[1])}"/>`
            : '') +
          `<polyline class="hv-slideframe" points="${poly(o, [
            [A[0], A[1], 0],
            [A[0], A[1], zt],
            [B[0], B[1], zt],
            [B[0], B[1], 0],
          ])}"/>`
        if (HW > zt + 0.1) svg += solid(zt, HW)
      } else {
        // The sill wall, the glass in the middle of the wall's thickness, and the head on top.
        svg = `${solid(0, z0)}<polygon class="hv-pane" points="${quad(z0, HW)}"/>${solid(HW, HW)}`
        // A sliding window shows where its two panes meet.
        if (win?.operation === 'sliding') {
          const m1 = project(o.mode, (A[0] + B[0]) / 2, (A[1] + B[1]) / 2, z0)
          const m2 = project(o.mode, (A[0] + B[0]) / 2, (A[1] + B[1]) / 2, HW)
          svg += `<line class="hv-slideframe" x1="${r1(m1[0])}" y1="${r1(m1[1])}" x2="${r1(m2[0])}" y2="${r1(m2[1])}"/>`
        }
      }
      if (w.opening)
        items.push(...coverings3d(o, A, B, w.opening.len, z0, zt, HW, coveringDraws(floor, w.opening, devices)))
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
        const z = zm(o, lampHeight(floor, p, mount))
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
        svg = marker(
          o,
          d,
          p.x,
          p.y,
          lift(Math.max(0.55, standsOn(floor, p) * Z + 0.2)),
          pill(parts.join('  ') || d.name),
        )
        break
      }
      case 'switch':
        svg = marker(
          o,
          d,
          p.x,
          p.y,
          lift(Math.max(0.45, standsOn(floor, p) * Z + 0.2)),
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
        // The water going out to the house, when the unit reports it: a heat
        // pump's bare "current" reading is often its hot water tank.
        const water = d.supply ?? d.temperature
        const text =
          d.on === false
            ? 'Off'
            : resting(d)
              ? `${water!.toFixed(0)}° resting`
              : water !== undefined && d.return !== undefined
                ? `${water.toFixed(0)}° → ${d.return.toFixed(0)}°`
                : water !== undefined
                  ? `${water.toFixed(0)}°`
                  : 'On'
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
        svg = marker(o, d, p.x, p.y, lift(Math.max(0.45, standsOn(floor, p) * Z + 0.2)), pill(stateText(d) || d.name))
    }
    push(depth, svg)
  }

  items.sort((a, b) => a.depth - b.depth)
  marks.sort((a, b) => a.depth - b.depth)
  const taken = separate(marks, o.unit)
  const roomNames = names.length ? placeRoomNames(names, [...taken, ...furnitureBoxes]) : ''
  // With an overlay on, the devices step back and the rooms' readings lead.
  const markup = marks.map((i) => i.svg).join('')
  const top = o.overlay === 'none' ? markup : `<g class="hv-dimmed">${markup}</g>${badges}`
  return `<defs>${defs}</defs>${base}${water}${glow}${pipes}${rugs ? `<g class="hv-rugs" pointer-events="none">${rugs}</g>` : ''}${items.map((i) => i.svg).join('')}${roomNames}${top}`
}
