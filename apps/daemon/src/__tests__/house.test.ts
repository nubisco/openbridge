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
