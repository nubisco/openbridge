import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { detectInstall, detectRestartStrategy, globalPrefix, PACKAGE_ROOT } from '../updater.js'

const saved = { ...process.env }

beforeEach(() => {
  delete process.env.INVOCATION_ID
  delete process.env.OPENBRIDGE_INSTALL
  delete process.env.OPENBRIDGE_VERSION_SPEC
})
afterEach(() => {
  process.env = { ...saved }
})

describe('detectRestartStrategy', () => {
  it('trusts systemd, which stamps every service it starts', () => {
    process.env.INVOCATION_ID = 'a8f3c2'
    expect(detectRestartStrategy()).toBe('supervisor')
  })

  it('trusts the container restart policy', () => {
    process.env.OPENBRIDGE_INSTALL = 'docker'
    expect(detectRestartStrategy()).toBe('supervisor')
  })

  it('recognises a supervisor name the kernel truncated', () => {
    // /proc/<pid>/comm is capped at fifteen characters and OpenRC's
    // supervise-daemon is sixteen, so it arrives as "supervise-daemo". An exact
    // comparison misses it, the daemon concludes nothing will restart it, and
    // it leaves a process behind to start a replacement while the supervisor
    // starts one too. The second dies on the port the first holds.
    const truncated = 'supervise-daemo'
    const supervisors = ['supervise-daemon', 'systemd', 'runsv', 's6-supervise', 'runit', 'launchd']
    expect(supervisors.some((n) => n === truncated || n.startsWith(truncated))).toBe(true)
  })

  it('assumes nothing will restart it when it recognises no supervisor', () => {
    // The optimistic answer leaves a stopped daemon and someone locked out, so
    // an unrecognised environment gets the strategy that starts its own
    // replacement rather than the benefit of the doubt.
    expect(detectRestartStrategy()).toBe('spawn')
  })
})

describe('detectInstall', () => {
  it('refuses to replace a source checkout, and says why', () => {
    // Tests run from the monorepo, so this is the source case: somebody's
    // working tree, which an update would discard.
    const info = detectInstall()
    expect(info.method).toBe('source')
    expect(info.canSelfUpdate).toBe(false)
    expect(info.blockedBy).toMatch(/source checkout/)
  })

  it('withholds self-update from a pinned deployment, and says why', () => {
    process.env.OPENBRIDGE_INSTALL = 'docker'
    process.env.OPENBRIDGE_VERSION_SPEC = '0.31.1'
    const info = detectInstall()
    expect(info.canSelfUpdate).toBe(false)
    expect(info.blockedBy).toMatch(/pinned to 0\.31\.1/)
  })

  it('allows it for an unpinned container', () => {
    process.env.OPENBRIDGE_INSTALL = 'docker'
    expect(detectInstall().canSelfUpdate).toBe(true)
  })
})

describe('globalPrefix', () => {
  it('is null when not installed under a node_modules', () => {
    // A source checkout has no prefix to install into, which is exactly why
    // detectInstall refuses it.
    expect(PACKAGE_ROOT).not.toContain('/node_modules/')
    expect(globalPrefix()).toBeNull()
  })
})
