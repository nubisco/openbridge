import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DeviceEventLog, MAX_QUERY } from '../device-events.js'

const dirs: string[] = []
function makeLog() {
  const dir = mkdtempSync(join(tmpdir(), 'ob-events-'))
  dirs.push(dir)
  return { log: new DeviceEventLog(dir), dir }
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

describe('DeviceEventLog', () => {
  it('returns events newest first, which is how a timeline is read', () => {
    const { log } = makeLog()
    log.record('gate', { type: 'opened', message: 'first' })
    log.record('gate', { type: 'closed', message: 'second' })

    const events = log.read('gate')
    expect(events.map((e) => e.message)).toEqual(['second', 'first'])
  })

  it('stamps the time itself, so plugins cannot disagree about the clock', () => {
    const { log } = makeLog()
    log.record('gate', { type: 'opened', message: 'x' })
    expect(log.read('gate')[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('keeps the cause and the detail', () => {
    const { log } = makeLog()
    log.record('gate', { type: 'command', message: 'open', source: 'homekit', data: { pulses: 1 } })

    const [event] = log.read('gate')
    expect(event.source).toBe('homekit')
    expect(event.data).toEqual({ pulses: 1 })
  })

  it('keeps devices apart', () => {
    const { log } = makeLog()
    log.record('gate', { type: 'opened', message: 'gate event' })
    log.record('pool', { type: 'on', message: 'pool event' })

    expect(log.read('gate')).toHaveLength(1)
    expect(log.read('pool')[0].message).toBe('pool event')
  })

  it('is empty for a device that has never recorded anything', () => {
    const { log } = makeLog()
    expect(log.read('nothing-here')).toEqual([])
  })

  it('honours a limit, and caps it', () => {
    const { log } = makeLog()
    for (let i = 0; i < 20; i++) log.record('gate', { type: 'tick', message: `e${i}` })

    expect(log.read('gate', 5)).toHaveLength(5)
    expect(log.read('gate', 99999)).toHaveLength(Math.min(20, MAX_QUERY))
  })

  it('survives a torn line rather than failing the whole query', () => {
    const { log, dir } = makeLog()
    log.record('gate', { type: 'opened', message: 'good' })
    // A write interrupted by power loss, which is the normal way this happens.
    writeFileSync(join(dir, 'gate.jsonl'), readFileSync(join(dir, 'gate.jsonl'), 'utf8') + '{"at":"broken')

    expect(log.read('gate').map((e) => e.message)).toEqual(['good'])
  })

  it('cannot be made to write outside its directory by a device id', () => {
    const { log, dir } = makeLog()
    // Device ids come from plugins and reach the filesystem here.
    log.record('../../escaped', { type: 'x', message: 'y' })
    expect(log.read('../../escaped')).toHaveLength(1)
    expect(readFileSync(join(dir, '.._.._escaped.jsonl'), 'utf8')).toContain('"y"')
  })

  it('never throws, because a diagnostic must not break its device', () => {
    // A directory that cannot exist because a file is already in its path, so
    // every call fails with ENOTDIR. Deliberately not somewhere under /proc:
    // tests should not depend on the host's special filesystems, and doing so
    // is what hung CI for twelve minutes.
    const dir = mkdtempSync(join(tmpdir(), 'ob-events-'))
    dirs.push(dir)
    const blocked = join(dir, 'a-file', 'events')
    writeFileSync(join(dir, 'a-file'), 'not a directory')

    const log = new DeviceEventLog(blocked)
    expect(() => log.record('gate', { type: 'x', message: 'y' })).not.toThrow()
    expect(log.read('gate')).toEqual([])
  })
})
