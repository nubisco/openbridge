import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildHeartbeat,
  HEARTBEAT_URL,
  INSTALL_FILE,
  recordInstallStart,
  sendHeartbeat,
  startInstallHeartbeat,
} from '../heartbeat.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ob-heartbeat-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  vi.useRealTimers()
})

/** A fetch that records what it was given and answers 204, like the host does. */
function fakeFetch() {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(null, { status: 204 })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe('recordInstallStart', () => {
  it('creates install.json with a v4 id on the first start, and says so', () => {
    const state = recordInstallStart(home, '1.27.4')
    expect(state.installId).toMatch(UUID)
    expect(state.firstRun).toBe(true)
    expect(state.previousVersion).toBeNull()

    const written = JSON.parse(readFileSync(join(home, INSTALL_FILE), 'utf8'))
    expect(written).toEqual({ installId: state.installId, lastVersion: '1.27.4' })
    // Same permissions as session.key.
    expect(statSync(join(home, INSTALL_FILE)).mode & 0o777).toBe(0o600)
  })

  it('keeps the same id forever and is not a first run the second time', () => {
    const first = recordInstallStart(home, '1.27.4')
    const second = recordInstallStart(home, '1.27.4')
    expect(second.installId).toBe(first.installId)
    expect(second.firstRun).toBe(false)
    expect(second.previousVersion).toBeNull()
  })

  it('reports the previous version once, on the first start after an update', () => {
    recordInstallStart(home, '1.27.3')
    const updated = recordInstallStart(home, '1.27.4')
    expect(updated.previousVersion).toBe('1.27.3')
    expect(updated.firstRun).toBe(false)
    // The next start of the same version has nothing to report.
    expect(recordInstallStart(home, '1.27.4').previousVersion).toBeNull()
  })

  it('creates the data directory when it is missing', () => {
    const nested = join(home, 'deeper', '.openbridge')
    const state = recordInstallStart(nested, '1.0.0')
    expect(JSON.parse(readFileSync(join(nested, INSTALL_FILE), 'utf8')).installId).toBe(state.installId)
  })

  it('treats a corrupt file as a new install rather than failing', () => {
    writeFileSync(join(home, INSTALL_FILE), 'not json')
    const state = recordInstallStart(home, '1.0.0')
    expect(state.installId).toMatch(UUID)
    expect(state.firstRun).toBe(true)
  })
})

describe('buildHeartbeat', () => {
  const state = { installId: '9d2a1e2c-5d1a-4a7f-8b35-6a1c2a3b4c5d', firstRun: false, previousVersion: null }
  const host = { platform: 'darwin' as const, arch: 'arm64' }

  it('sends exactly the contract fields, omitting what does not apply', () => {
    expect(buildHeartbeat(state, '1.27.4', 'homebrew', host)).toEqual({
      product: 'openbridge',
      version: '1.27.4',
      installId: state.installId,
      installMethod: 'homebrew',
      os: 'darwin',
      arch: 'arm64',
    })
  })

  it('marks a first run and a version change', () => {
    const body = buildHeartbeat({ ...state, firstRun: true, previousVersion: '1.27.3' }, '1.27.4', 'npm', host)
    expect(body.firstRun).toBe(true)
    expect(body.previousVersion).toBe('1.27.3')
  })

  it('leaves out an os or arch the contract does not list', () => {
    const body = buildHeartbeat(state, '1.0.0', 'docker', { platform: 'freebsd', arch: 'ia32' })
    expect(body).not.toHaveProperty('os')
    expect(body).not.toHaveProperty('arch')
  })
})

describe('sendHeartbeat', () => {
  it('POSTs JSON to the downloads host with a product/version user agent', async () => {
    const { fetchImpl, calls } = fakeFetch()
    const body = buildHeartbeat({ installId: 'id', firstRun: true, previousVersion: null }, '1.27.4', 'npm', {
      platform: 'linux',
      arch: 'x64',
    })
    await sendHeartbeat(body, fetchImpl)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(HEARTBEAT_URL)
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers).toEqual({ 'Content-Type': 'application/json', 'User-Agent': 'openbridge/1.27.4' })
    expect(JSON.parse(calls[0].init.body as string)).toEqual(body)
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal)
  })

  it('swallows a network failure', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    await expect(
      sendHeartbeat(buildHeartbeat({ installId: 'id', firstRun: false, previousVersion: null }, '1', 'npm'), failing),
    ).resolves.toBeUndefined()
  })

  it('ignores a non-204 answer', async () => {
    const rejecting = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    await expect(
      sendHeartbeat(buildHeartbeat({ installId: 'id', firstRun: false, previousVersion: null }, '1', 'npm'), rejecting),
    ).resolves.toBeUndefined()
  })
})

describe('startInstallHeartbeat', () => {
  it('sends once at start and again every interval, without first-run flags on the repeats', () => {
    vi.useFakeTimers()
    const { fetchImpl, calls } = fakeFetch()
    const stop = startInstallHeartbeat({
      home,
      version: '1.27.4',
      installMethod: 'docker',
      isEnabled: () => true,
      fetchImpl,
      intervalMs: 1000,
      host: { platform: 'linux', arch: 'x64' },
    })
    expect(calls).toHaveLength(1)
    expect(JSON.parse(calls[0].init.body as string).firstRun).toBe(true)

    vi.advanceTimersByTime(1000)
    expect(calls).toHaveLength(2)
    const repeat = JSON.parse(calls[1].init.body as string)
    expect(repeat).not.toHaveProperty('firstRun')
    expect(repeat).not.toHaveProperty('previousVersion')
    expect(repeat.installId).toBe(JSON.parse(calls[0].init.body as string).installId)

    vi.advanceTimersByTime(1000)
    expect(calls).toHaveLength(3)
    stop()
    vi.advanceTimersByTime(5000)
    expect(calls).toHaveLength(3)
  })

  it('sends nothing while the setting is off, and resumes when it is turned on', () => {
    vi.useFakeTimers()
    const { fetchImpl, calls } = fakeFetch()
    let enabled = false
    startInstallHeartbeat({
      home,
      version: '1.27.4',
      installMethod: 'npm',
      isEnabled: () => enabled,
      fetchImpl,
      intervalMs: 1000,
    })
    expect(calls).toHaveLength(0)
    // The install still knows itself, so turning it on later needs no restart.
    expect(JSON.parse(readFileSync(join(home, INSTALL_FILE), 'utf8')).installId).toMatch(UUID)

    vi.advanceTimersByTime(1000)
    expect(calls).toHaveLength(0)
    enabled = true
    vi.advanceTimersByTime(1000)
    expect(calls).toHaveLength(1)
  })

  it('returns before the request completes: startup never waits on the network', () => {
    let resolveFetch: () => void = () => {}
    const hanging = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = () => resolve(new Response(null, { status: 204 }))
        }),
    ) as unknown as typeof fetch
    const stop = startInstallHeartbeat({
      home,
      version: '1',
      installMethod: 'source',
      isEnabled: () => true,
      fetchImpl: hanging,
    })
    expect(hanging).toHaveBeenCalledTimes(1)
    resolveFetch()
    stop()
  })
})
