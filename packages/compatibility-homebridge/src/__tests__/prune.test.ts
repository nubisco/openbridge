import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { HomebridgeAPI } from '../index.js'

/**
 * Minimal hap-nodejs stand-in. Only the surface HomebridgeAPI touches.
 */
function fakeHap() {
  class Accessory {
    services: unknown[] = []
    category = 1
    constructor(
      public displayName: string,
      public UUID: string,
    ) {}
    getService() {
      return { setCharacteristic: () => ({ setCharacteristic: () => ({}) }) }
    }
    addService() {
      return {}
    }
  }
  return {
    Accessory,
    Service: { AccessoryInformation: 'info' },
    Characteristic: { Manufacturer: 'm', Model: 'mo', SerialNumber: 's', FirmwareRevision: 'f' },
    Categories: { BRIDGE: 2 },
    uuid: { generate: (s: string) => `uuid-${s}` },
  }
}

function fakeBridge() {
  return {
    added: [] as any[],
    removed: [] as any[],
    addBridgedAccessory(acc: any) {
      this.added.push(acc)
      return acc
    },
    removeBridgedAccessory(acc: any) {
      this.removed.push(acc)
    },
  }
}

let home: string
let api: HomebridgeAPI
let bridge: ReturnType<typeof fakeBridge>

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ob-prune-'))
  bridge = fakeBridge()
  api = new HomebridgeAPI(fakeHap() as any, bridge)
  // Keep the accessory cache inside the temp dir.
  api.user.cachedAccessoryPath = () => home
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** Add an accessory attributed to a platform, as loadCachedAccessories would. */
function seed(displayName: string, uuid: string, platform: string) {
  const acc: any = { displayName, UUID: uuid, _associatedPlatform: platform }
  ;(api as any)._accessories.set(uuid, acc)
  bridge.addBridgedAccessory(acc)
  return acc
}

describe('pruneOrphanedAccessories', () => {
  it('removes accessories whose platform is no longer registered', () => {
    api.registerPlatform('ShellyDS9', class {} as any)
    seed('Pool Switch 1', 'u1', 'ShellyDS9')
    seed('Home - Total', 'u2', 'Shelly3EM')
    seed('Home - Fase A', 'u3', 'Shelly3EM')

    const removed = api.pruneOrphanedAccessories()

    // The uninstalled plugin's accessories go; the installed one's stay.
    expect(removed.sort()).toEqual(['Home - Fase A', 'Home - Total'])
    expect(api.getRawAccessories().map((a: any) => a.displayName)).toEqual(['Pool Switch 1'])
    expect(bridge.removed.map((a) => a.UUID).sort()).toEqual(['u2', 'u3'])
  })

  it('keeps accessories belonging to a registered platform', () => {
    api.registerPlatform('WizSmarthome', class {} as any)
    seed('Basement 1', 'u1', 'WizSmarthome')

    expect(api.pruneOrphanedAccessories()).toEqual([])
    expect(api.getRawAccessories()).toHaveLength(1)
    expect(bridge.removed).toEqual([])
  })

  it('matches on plugin name as well as platform name', () => {
    // publishExternalAccessories attributes by plugin name, not platform name.
    api.registerPlatform('homebridge-camera-ffmpeg', 'Camera-ffmpeg', class {} as any, true)
    seed('Living Room', 'u1', 'homebridge-camera-ffmpeg')
    seed('Lobby', 'u2', 'Camera-ffmpeg')

    expect(api.pruneOrphanedAccessories()).toEqual([])
    expect(api.getRawAccessories()).toHaveLength(2)
  })

  it('leaves unattributed accessories alone', () => {
    // No owner recorded, so it cannot be attributed. Silently deleting a user's
    // HomeKit device is worse than leaving one stale entry behind.
    seed('Mystery', 'u1', '')

    expect(api.pruneOrphanedAccessories()).toEqual([])
    expect(api.getRawAccessories()).toHaveLength(1)
  })

  it('does nothing when there is nothing to prune', () => {
    api.registerPlatform('ShellyDS9', class {} as any)
    seed('Pool Switch 1', 'u1', 'ShellyDS9')
    expect(api.pruneOrphanedAccessories()).toEqual([])
  })

  it('survives a bridge that refuses the removal', () => {
    api.registerPlatform('ShellyDS9', class {} as any)
    bridge.removeBridgedAccessory = () => {
      throw new Error('not bridged')
    }
    seed('Home - Total', 'u1', 'Shelly3EM')

    // The accessory must still leave the map and the cache even if the bridge
    // never had it.
    expect(api.pruneOrphanedAccessories()).toEqual(['Home - Total'])
    expect(api.getRawAccessories()).toEqual([])
  })

  it('notifies the removal listener so the UI drops the device too', () => {
    const onRemove = vi.fn()
    api.onAccessoryRemove(onRemove)
    api.registerPlatform('ShellyDS9', class {} as any)
    seed('Home - Total', 'u1', 'Shelly3EM')

    api.pruneOrphanedAccessories()
    expect(onRemove).toHaveBeenCalledTimes(1)
  })
})
