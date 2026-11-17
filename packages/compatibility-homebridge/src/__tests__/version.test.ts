import { describe, it, expect } from 'vitest'
import { HomebridgeAPI, compareVersions } from '../index.js'

const hap = {
  Accessory: class {},
  Service: {},
  Characteristic: {},
  Categories: {},
  uuid: { generate: (s: string) => s },
}
const bridge = { addBridgedAccessory: (a: unknown) => a, removeBridgedAccessory: () => {} }

describe('compareVersions', () => {
  it('orders by major, minor and patch', () => {
    expect(compareVersions('2.6.0', '1.4.0')).toBeGreaterThan(0)
    expect(compareVersions('1.4.0', '1.10.0')).toBeLessThan(0)
    expect(compareVersions('1.4.0', '1.4.0')).toBe(0)
  })

  it('ignores a leading v and pre-release suffixes', () => {
    expect(compareVersions('2.6.0', 'v1.3.0-beta.23')).toBeGreaterThan(0)
    expect(compareVersions('v2.6.0', '2.6.0-beta.1')).toBe(0)
  })
})

describe('versionGreaterOrEqual', () => {
  const api = new HomebridgeAPI(hap as any, bridge)

  it('answers for the Homebridge version it presents', () => {
    // homebridge-meross refuses to start unless this is true for 1.4.0.
    expect(api.versionGreaterOrEqual('1.4.0')).toBe(true)
    expect(api.versionGreaterOrEqual(api.version)).toBe(true)
    expect(api.versionGreaterOrEqual('99.0.0')).toBe(false)
  })
})
