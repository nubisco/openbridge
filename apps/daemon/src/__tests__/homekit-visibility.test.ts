import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { HomeKitVisibility } from '../homekit-visibility.js'

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ob-hk-'))
  path = join(dir, 'homekit-hidden.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Minimal stand-in for the hap-nodejs Bridge surface this code touches. */
function fakeBridge() {
  return {
    added: [] as any[],
    removed: [] as any[],
    displayName: 'OpenBridge',
    addBridgedAccessory(acc: any) {
      this.added.push(acc)
      return acc
    },
    removeBridgedAccessory(acc: any) {
      this.removed.push(acc)
    },
    getService() {
      return { setCharacteristic: () => ({ setCharacteristic: () => ({}) }) }
    },
  }
}

const accessory = (uuid: string, displayName = uuid) => ({ UUID: uuid, displayName })

describe('bridge wrapping', () => {
  it('passes visible accessories straight through', () => {
    const v = new HomeKitVisibility(path)
    const bridge = fakeBridge()
    const wrapped = v.wrapBridge(bridge)

    wrapped.addBridgedAccessory(accessory('pool-switch'))
    expect(bridge.added.map((a) => a.UUID)).toEqual(['pool-switch'])
  })

  it('blocks hidden accessories from reaching HomeKit', () => {
    writeFileSync(path, JSON.stringify(['meter-total']))
    const v = new HomeKitVisibility(path)
    const bridge = fakeBridge()
    const wrapped = v.wrapBridge(bridge)

    wrapped.addBridgedAccessory(accessory('meter-total'))
    wrapped.addBridgedAccessory(accessory('pool-switch'))

    // The meter never reaches the bridge; its sibling switch still does. That
    // separation is the whole point: one plugin, two different answers.
    expect(bridge.added.map((a) => a.UUID)).toEqual(['pool-switch'])
  })

  it('leaves every other bridge method untouched', () => {
    const v = new HomeKitVisibility(path)
    const bridge = fakeBridge()
    const wrapped = v.wrapBridge(bridge)

    expect(wrapped.displayName).toBe('OpenBridge')
    expect(typeof wrapped.getService).toBe('function')
    expect(() => wrapped.getService()).not.toThrow()
  })

  it('does not ask hap-nodejs to remove an accessory it never received', () => {
    writeFileSync(path, JSON.stringify(['meter-total']))
    const v = new HomeKitVisibility(path)
    const bridge = fakeBridge()
    const wrapped = v.wrapBridge(bridge)

    wrapped.addBridgedAccessory(accessory('meter-total'))
    wrapped.removeBridgedAccessory(accessory('meter-total'))
    expect(bridge.removed).toEqual([])
  })

  it('tolerates accessories with no UUID', () => {
    const v = new HomeKitVisibility(path)
    const wrapped = v.wrapBridge(fakeBridge())
    expect(() => wrapped.addBridgedAccessory({ displayName: 'nameless' })).not.toThrow()
  })
})

describe('toggling', () => {
  it('removes a live accessory immediately when hidden', () => {
    const v = new HomeKitVisibility(path)
    const bridge = fakeBridge()
    const wrapped = v.wrapBridge(bridge)
    const acc = accessory('meter-total')
    wrapped.addBridgedAccessory(acc)

    const result = v.setVisible('meter-total', false)

    // Without applying live, the Home app keeps showing a device the user just
    // hid until the next restart, which reads as a broken toggle.
    expect(result).toEqual({ changed: true, applied: true })
    expect(bridge.removed.map((a) => a.UUID)).toEqual(['meter-total'])
  })

  it('re-adds an accessory when shown again', () => {
    const v = new HomeKitVisibility(path)
    const bridge = fakeBridge()
    const wrapped = v.wrapBridge(bridge)
    wrapped.addBridgedAccessory(accessory('meter-total'))

    v.setVisible('meter-total', false)
    v.setVisible('meter-total', true)

    expect(bridge.added.map((a) => a.UUID)).toEqual(['meter-total', 'meter-total'])
  })

  it('reports no change when the state already matches', () => {
    const v = new HomeKitVisibility(path)
    expect(v.setVisible('never-seen', true)).toEqual({ changed: false, applied: true })
  })

  it('persists the preference even when it cannot be applied live', () => {
    const v = new HomeKitVisibility(path)
    // Never wrapped a bridge, so there is nothing running to update.
    const result = v.setVisible('meter-total', false)

    expect(result).toEqual({ changed: true, applied: false })
    expect(v.isHidden('meter-total')).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(['meter-total'])
  })

  it('keeps the preference when the bridge throws', () => {
    const v = new HomeKitVisibility(path)
    const bridge = fakeBridge()
    bridge.removeBridgedAccessory = () => {
      throw new Error('not bridged')
    }
    const wrapped = v.wrapBridge(bridge)
    wrapped.addBridgedAccessory(accessory('meter-total'))

    const result = v.setVisible('meter-total', false)
    expect(result).toEqual({ changed: true, applied: false })
    // A restart must still honour it.
    expect(v.isHidden('meter-total')).toBe(true)
  })
})

describe('persistence', () => {
  it('survives a restart', () => {
    new HomeKitVisibility(path).setVisible('meter-total', false)

    const reloaded = new HomeKitVisibility(path)
    expect(reloaded.isHidden('meter-total')).toBe(true)
    expect(reloaded.hiddenList()).toEqual(['meter-total'])
  })

  it('hides nothing when the file is absent', () => {
    const v = new HomeKitVisibility(join(dir, 'does-not-exist.json'))
    expect(v.hiddenList()).toEqual([])
  })

  it('falls back to showing everything when the file is corrupt', () => {
    writeFileSync(path, 'not json at all')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // Failing open is deliberate: a bad file should not silently strip a
      // user's HomeKit devices.
      expect(new HomeKitVisibility(path).hiddenList()).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  it('ignores non-string entries', () => {
    writeFileSync(path, JSON.stringify(['ok', 42, null, { uuid: 'x' }]))
    expect(new HomeKitVisibility(path).hiddenList()).toEqual(['ok'])
  })

  it('creates the file on first write', () => {
    expect(existsSync(path)).toBe(false)
    new HomeKitVisibility(path).setVisible('x', false)
    expect(existsSync(path)).toBe(true)
  })
})
