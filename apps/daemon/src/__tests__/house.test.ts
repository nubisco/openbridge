import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Fastify from 'fastify'
import {
  HouseConflictError,
  HouseStore,
  HouseValidationError,
  roomsByRef,
  validateHousePlan,
  type HousePlan,
} from '../house.js'
import { registerHouseRoutes } from '../house-routes.js'

function plan(): HousePlan {
  return {
    version: 1,
    grid: 0.5,
    plot: { w: 32, h: 22 },
    floors: [
      {
        id: 'g',
        name: 'Ground floor',
        level: 0,
        rooms: [
          { id: 'living', name: 'Living room', kind: 'room', x: 2, y: 2, w: 10, h: 8 },
          { id: 'kitchen', name: 'Kitchen', kind: 'room', x: 12, y: 2, w: 6, h: 8 },
          { id: 'terrace', name: 'Terrace', kind: 'outdoor', x: 2, y: 10, w: 10, h: 4 },
        ],
        openings: [
          { id: 'w1', type: 'window', axis: 'h', x: 4, y: 2, len: 2 },
          { id: 'd1', type: 'door', axis: 'h', x: 4, y: 10, len: 2 },
        ],
        placements: [
          { ref: 'device:lamp', x: 6.5, y: 5, color: '#FFB45E' },
          { ref: 'device:shutter', x: 5, y: 2, opening: 'w1' },
          { ref: 'device:heating', x: 16, y: 3, circuitRooms: ['living', 'bed'] },
        ],
      },
      {
        id: 'f1',
        name: 'First floor',
        level: 1,
        rooms: [{ id: 'bed', name: 'Bedroom', kind: 'room', x: 2, y: 2, w: 8, h: 8 }],
        openings: [],
        placements: [{ ref: 'accessory:AB-CD', x: 4, y: 4 }],
      },
    ],
  }
}

describe('validateHousePlan', () => {
  it('keeps the width and direction of a gate', () => {
    const p = plan()
    p.floors[0].placements.push({ ref: 'device:gate', x: 20, y: 22, length: 8, axis: 'v' })
    expect(validateHousePlan(p).floors[0].placements[3]).toEqual({
      ref: 'device:gate',
      x: 20,
      y: 22,
      length: 8,
      axis: 'v',
    })
  })

  it('keeps which way a door opens, and refuses a side its wall does not have', () => {
    const p = plan()
    Object.assign(p.floors[0].openings[1], { hinge: 'end', opens: 'up' })
    expect(validateHousePlan(p).floors[0].openings[1]).toMatchObject({ hinge: 'end', opens: 'up' })
    Object.assign(p.floors[0].openings[1], { opens: 'left' })
    expect(() => validateHousePlan(p)).toThrow(/opens: must be up or down/)
    Object.assign(p.floors[0].openings[1], { opens: 'down', hinge: 'middle' })
    expect(() => validateHousePlan(p)).toThrow(/hinge/)
  })

  it('lets a door sit a quarter metre along its wall, and a wall be left open', () => {
    const p = plan()
    Object.assign(p.floors[0].openings[1], { x: 4.5, len: 1.5 })
    p.floors[0].openings.push({ id: 'o1', type: 'open', axis: 'v', x: 12, y: 3, len: 4 })
    const out = validateHousePlan(p).floors[0].openings
    expect(out[1]).toMatchObject({ x: 4.5, len: 1.5 })
    expect(out[2].type).toBe('open')
    // Across the wall it stays on the wall's line.
    Object.assign(p.floors[0].openings[1], { x: 4, y: 10.5 })
    expect(() => validateHousePlan(p)).toThrow(/openings\[1\]\.y: must be a whole number/)
    Object.assign(p.floors[0].openings[1], { y: 10, x: 4.25 })
    expect(() => validateHousePlan(p)).toThrow(/multiple of 0\.5/)
  })

  it('keeps how a lamp is mounted and what a device is drawn as', () => {
    const p = plan()
    Object.assign(p.floors[0].placements[0], { mount: 'floor' })
    p.floors[0].placements.push({ ref: 'device:plug', x: 8, y: 4, look: 'fridge' })
    const out = validateHousePlan(p).floors[0].placements
    expect(out[0].mount).toBe('floor')
    expect(out[3].look).toBe('fridge')
    p.floors[0].placements[3].look = 'toaster' as never
    expect(() => validateHousePlan(p)).toThrow(/look: must be one of/)
    p.floors[0].placements[3].look = 'tv'
    p.floors[0].placements[0].mount = 'roof' as never
    expect(() => validateHousePlan(p)).toThrow(/mount: must be one of/)
  })

  it('accepts a sound plan and normalises it', () => {
    const out = validateHousePlan({ ...plan(), extra: 'dropped' })
    expect(out.floors).toHaveLength(2)
    expect(out.floors[0].placements[0].color).toBe('#ffb45e')
    expect('extra' in out).toBe(false)
  })

  const broken: Array<[string, (p: HousePlan) => void, RegExp]> = [
    ['a room past the plot', (p) => (p.floors[0].rooms[0].w = 40), /rooms\[0\]\.w/],
    ['a room off the grid', (p) => (p.floors[0].rooms[0].x = 2.5), /rooms\[0\]\.x/],
    ['a room id used on two floors', (p) => (p.floors[1].rooms[0].id = 'living'), /used twice/],
    ['two floors on one level', (p) => (p.floors[1].level = 0), /share level 0/],
    ['a device placed twice', (p) => p.floors[1].placements.push({ ref: 'device:lamp', x: 1, y: 1 }), /placed twice/],
    ['a shutter on a door', (p) => (p.floors[0].placements[1].opening = 'd1'), /not a window/],
    [
      'a circuit through a missing room',
      (p) => (p.floors[0].placements[2].circuitRooms = ['attic']),
      /no room 'attic'/,
    ],
    ['a device between half cells', (p) => (p.floors[0].placements[0].x = 6.2), /multiple of 0\.5/],
    ['an unknown ref kind', (p) => (p.floors[0].placements[0].ref = 'lamp'), /device:<id>/],
    ['a gate with no width', (p) => (p.floors[0].placements[0].length = 0), /length/],
    ['a gate running diagonally', (p) => ((p.floors[0].placements[0] as { axis: string }).axis = 'd'), /axis/],
    ['an empty name', (p) => (p.floors[0].rooms[0].name = '  '), /name/],
    ['a wrong version', (p) => ((p as { version: number }).version = 2), /version/],
  ]
  for (const [what, mutate, message] of broken) {
    it(`refuses ${what}`, () => {
      const p = plan()
      mutate(p)
      expect(() => validateHousePlan(p)).toThrow(HouseValidationError)
      expect(() => validateHousePlan(p)).toThrow(message)
    })
  }
})

describe('L-shaped rooms', () => {
  const withWing = (part: { x: number; y: number; w: number; h: number }) => {
    const p = plan()
    // The living room is x 2..12, y 2..10. The terrace below it goes, to leave room for a wing.
    p.floors[0].rooms = p.floors[0].rooms.filter((r) => r.id !== 'terrace')
    p.floors[0].rooms[0].parts = [part]
    return p
  }

  it('accepts a wing that shares an edge', () => {
    const out = validateHousePlan(withWing({ x: 2, y: 10, w: 4, h: 4 }))
    expect(out.floors[0].rooms[0].parts).toEqual([{ x: 2, y: 10, w: 4, h: 4 }])
  })

  it('refuses a wing that only touches at a corner, or not at all', () => {
    expect(() => validateHousePlan(withWing({ x: 12, y: 10, w: 2, h: 2 }))).toThrow(/share an edge/)
    expect(() => validateHousePlan(withWing({ x: 20, y: 16, w: 2, h: 2 }))).toThrow(/share an edge/)
  })

  it('refuses a wing that overlaps the room', () => {
    expect(() => validateHousePlan(withWing({ x: 4, y: 8, w: 4, h: 4 }))).toThrow(/overlaps/)
  })

  it('puts a device in the wing in the room', () => {
    const p = withWing({ x: 2, y: 10, w: 4, h: 4 })
    p.floors[0].placements[0] = { ref: 'device:lamp', x: 3, y: 12.5 }
    expect(roomsByRef(p).get('device:lamp')?.id).toBe('living')
  })
})

describe('rooms within rooms', () => {
  it('puts a device in the smallest room around it', () => {
    const p = plan()
    // A pantry drawn inside the living room, and the whole plot as a garden around the house.
    p.floors[0].rooms.push({ id: 'pantry', name: 'Pantry', kind: 'room', x: 8, y: 6, w: 4, h: 4 })
    p.floors[0].rooms.unshift({ id: 'garden', name: 'Garden', kind: 'outdoor', x: 0, y: 0, w: 32, h: 22 })
    p.floors[0].placements[0] = { ref: 'device:lamp', x: 10, y: 8 }
    p.floors[0].placements.push({ ref: 'device:fridge', x: 4, y: 4 }, { ref: 'device:mower', x: 28, y: 18 })
    const rooms = roomsByRef(validateHousePlan(p))
    expect(rooms.get('device:lamp')?.id).toBe('pantry')
    expect(rooms.get('device:fridge')?.id).toBe('living')
    expect(rooms.get('device:mower')?.id).toBe('garden')
    // A shutter stays in the walled room behind its window, not the garden.
    expect(rooms.get('device:shutter')?.id).toBe('living')
  })
})

describe('roomsByRef', () => {
  it('puts each device in the room its placement falls in, across floors', () => {
    const rooms = roomsByRef(plan())
    expect(rooms.get('device:lamp')).toEqual({
      id: 'living',
      name: 'Living room',
      floor: { id: 'g', name: 'Ground floor', level: 0 },
    })
    expect(rooms.get('accessory:AB-CD')?.id).toBe('bed')
    expect(rooms.get('device:heating')?.id).toBe('kitchen')
  })

  it('puts a shutter in the room behind its window', () => {
    expect(roomsByRef(plan()).get('device:shutter')?.id).toBe('living')
  })

  it('puts a window between a room and the garden in the room', () => {
    const p = plan()
    p.floors[0].openings.push({ id: 'w2', type: 'window', axis: 'h', x: 4, y: 10, len: 2 })
    p.floors[0].openings = p.floors[0].openings.filter((o) => o.id !== 'd1')
    p.floors[0].placements[1].opening = 'w2'
    expect(roomsByRef(p).get('device:shutter')?.id).toBe('living')
  })

  it('leaves out a device outside every room', () => {
    const p = plan()
    p.floors[0].placements[0].x = 30
    expect(roomsByRef(p).has('device:lamp')).toBe(false)
  })
})

describe('HouseStore', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ob-house-'))
    path = join(dir, 'house.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('starts empty, saves, and reads back after a restart', () => {
    const store = new HouseStore(path)
    expect(store.get()).toEqual({ plan: null, rev: 0, updatedAt: null })
    const saved = store.set(plan(), 0)
    expect(saved.rev).toBe(1)
    expect(existsSync(`${path}.tmp`)).toBe(false)

    const again = new HouseStore(path)
    expect(again.get().rev).toBe(1)
    expect(again.get().plan?.floors[1].rooms[0].name).toBe('Bedroom')
    expect(again.roomOf('device:lamp')?.name).toBe('Living room')
  })

  it('refuses a save based on an old revision', () => {
    const store = new HouseStore(path)
    store.set(plan(), 0)
    expect(() => store.set(plan(), 0)).toThrow(HouseConflictError)
    expect(store.get().rev).toBe(1)
  })

  it('keeps the old plan when the new one is invalid', () => {
    const store = new HouseStore(path)
    store.set(plan(), 0)
    const bad = plan()
    bad.floors[0].rooms[0].w = 99
    expect(() => store.set(bad, 1)).toThrow(HouseValidationError)
    expect(store.get().rev).toBe(1)
    expect(JSON.parse(readFileSync(path, 'utf8')).rev).toBe(1)
  })

  it('updates rooms as soon as a room moves', () => {
    const store = new HouseStore(path)
    store.set(plan(), 0)
    const moved = plan()
    moved.floors[0].rooms[1].name = 'Cuisine'
    store.set(moved, 1)
    expect(store.roomOf('device:heating')?.name).toBe('Cuisine')
  })

  it('survives a corrupt file and leaves it in place', () => {
    writeFileSync(path, '{ not json')
    const store = new HouseStore(path)
    expect(store.get().plan).toBeNull()
    expect(readFileSync(path, 'utf8')).toBe('{ not json')
  })
})

describe('house routes', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ob-house-routes-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  async function app() {
    const a = Fastify()
    registerHouseRoutes(a, new HouseStore(join(dir, 'house.json')))
    await a.ready()
    return a
  }

  it('reads, saves, and refuses a stale or broken save', async () => {
    const a = await app()
    const empty = await a.inject({ method: 'GET', url: '/api/house' })
    expect(empty.json()).toMatchObject({ plan: null, rev: 0 })

    const saved = await a.inject({ method: 'PUT', url: '/api/house', payload: { plan: plan(), rev: 0 } })
    expect(saved.statusCode).toBe(200)
    expect(saved.json().rev).toBe(1)

    const stale = await a.inject({ method: 'PUT', url: '/api/house', payload: { plan: plan(), rev: 0 } })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().rev).toBe(1)

    const bad = plan()
    bad.plot.w = 0
    const invalid = await a.inject({ method: 'PUT', url: '/api/house', payload: { plan: bad, rev: 1 } })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json().error).toMatch(/plot\.w/)

    const missing = await a.inject({ method: 'PUT', url: '/api/house', payload: { plan: plan() } })
    expect(missing.statusCode).toBe(400)

    const cleared = await a.inject({ method: 'PUT', url: '/api/house', payload: { plan: null, rev: 1 } })
    expect(cleared.json()).toMatchObject({ plan: null, rev: 2 })
    await a.close()
  })
})

describe('houseView, what an agent reads', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ob-house-view-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  async function bridge(withPlan: boolean) {
    const { PluginRegistry } = await import('@nubisco/openbridge-core')
    const { houseView, listDevices } = await import('../services/bridge.js')
    const registry = new PluginRegistry()
    const instance = registry.register({ manifest: { name: 'p', version: '1.0.0' } })
    instance.devices = {
      lamp: { id: 'lamp', name: 'Reading lamp', widgetType: 'light', pluginId: 'p' },
      heating: { id: 'heating', name: 'Heat pump', widgetType: 'thermostat', pluginId: 'p' },
      meter: { id: 'meter', name: 'Meter', widgetType: 'energy_meter', pluginId: 'p' },
    }
    const house = new HouseStore(join(dir, 'house.json'))
    if (withPlan) house.set(plan(), 0)
    const ctx = {
      registry,
      home: dir,
      hapAPI: null,
      controls: new Map(),
      restrictedControls: new Set<string>(),
      deviceEvents: null,
      observations: null,
      homekitServiceTypes: null,
      nativeAccessoryUuid: null,
      house,
    }
    return { view: houseView(ctx), devices: listDevices(ctx) }
  }

  it('says there is no plan yet', async () => {
    expect((await bridge(false)).view).toEqual({ drawn: false })
  })

  it('lists rooms in metres with their devices, circuits by room name, and what is not placed', async () => {
    const { view, devices } = await bridge(true)
    if (!view.drawn) throw new Error('expected a plan')
    const ground = view.floors[0]
    expect(ground.rooms[0]).toEqual({
      name: 'Living room',
      kind: 'room',
      width_m: 5,
      depth_m: 4,
      area_m2: 20,
      devices: [{ id: 'lamp', name: 'Reading lamp', type: 'light' }],
    })
    expect(ground.rooms[1].devices.map((d) => d.name)).toEqual(['Heat pump'])
    expect(view.heating_circuits).toEqual([{ device: 'Heat pump', rooms: ['Living room', 'Bedroom'] }])
    expect(view.not_on_plan).toEqual(['Meter'])
    // The same rooms reach the device list.
    expect(devices.find((d) => d.id === 'lamp')?.room?.name).toBe('Living room')
    expect(devices.find((d) => d.id === 'meter')?.room).toBeNull()
  })
})
