import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { HomeKitServiceTypes, CONVERTIBLE_SERVICES, isConvertible } from '../homekit-service-type.js'
import { HomeKitVisibility } from '../homekit-visibility.js'

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ob-hkst-'))
  path = join(dir, 'homekit-service-types.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const SWITCH = CONVERTIBLE_SERVICES.switch.uuid
const LIGHT = CONVERTIBLE_SERVICES.light.uuid
const ON = '00000025-0000-1000-8000-0026BB765291'
const THERMOSTAT = '0000004A-0000-1000-8000-0026BB765291'

/**
 * Minimal stand-ins for the hap-nodejs surface the swap touches: a
 * characteristic that records writes and notifies `change` listeners, and a
 * service holding one.
 */
function fakeCharacteristic(uuid: string, value: unknown = false) {
  const listeners: Array<(e: { newValue: unknown }) => void> = []
  return {
    UUID: uuid,
    value,
    sets: [] as unknown[],
    getHandler: null as null | (() => unknown),
    setHandler: null as null | ((v: unknown) => unknown),
    setValue(v: unknown) {
      this.sets.push(v)
      this.value = v
      return this
    },
    updateValue(v: unknown) {
      this.value = v
      return this
    },
    on(event: string, cb: (e: { newValue: unknown }) => void) {
      if (event === 'change') listeners.push(cb)
      return this
    },
    onGet(cb: () => unknown) {
      this.getHandler = cb
      return this
    },
    onSet(cb: (v: unknown) => unknown) {
      this.setHandler = cb
      return this
    },
    emitChange(newValue: unknown) {
      this.value = newValue
      listeners.forEach((cb) => cb({ newValue }))
    },
  }
}

function fakeService(uuid: string, displayName: string, charUuid = ON) {
  const characteristics = [fakeCharacteristic(charUuid)]
  return {
    UUID: uuid,
    displayName,
    subtype: undefined as string | undefined,
    characteristics,
    getCharacteristic() {
      return characteristics[0]
    },
  }
}

function fakeAccessory(uuid: string, services: any[]) {
  return {
    UUID: uuid,
    displayName: uuid,
    category: 8,
    services,
    addService(svc: any) {
      this.services.push(svc)
      return svc
    },
    removeService(svc: any) {
      this.services = this.services.filter((s: any) => s !== svc)
    },
  }
}

/** hap-nodejs stand-in exposing just Service.<Name> and Characteristic.On. */
function fakeHap() {
  class Svc {
    UUID: string
    displayName: string
    subtype?: string
    characteristics: any[]
    constructor(uuid: string, displayName: string, subtype?: string) {
      this.UUID = uuid
      this.displayName = displayName
      this.subtype = subtype
      this.characteristics = [fakeCharacteristic(ON)]
    }
    getCharacteristic() {
      return this.characteristics[0]
    }
  }
  return {
    Characteristic: { On: { UUID: ON } },
    Service: {
      Lightbulb: class extends Svc {
        constructor(name: string, subtype?: string) {
          super(LIGHT, name, subtype)
        }
      },
      Switch: class extends Svc {
        constructor(name: string, subtype?: string) {
          super(SWITCH, name, subtype)
        }
      },
    },
  }
}

describe('convertibility', () => {
  it('accepts the On-based service family', () => {
    for (const def of Object.values(CONVERTIBLE_SERVICES)) {
      expect(isConvertible(def.uuid)).toBe(true)
    }
  })

  it('rejects services that are not built on On', () => {
    // A thermostat has no On characteristic, so presenting it as a lightbulb
    // would silently drop everything that makes it a thermostat.
    expect(isConvertible(THERMOSTAT)).toBe(false)
  })
})

describe('persistence', () => {
  it('round trips an override across instances', () => {
    const a = new HomeKitServiceTypes(path)
    a.set('pool', SWITCH, 'light')

    expect(existsSync(path)).toBe(true)
    expect(new HomeKitServiceTypes(path).get('pool', SWITCH)).toBe('light')
  })

  it('clearing an override removes the entry rather than storing a null', () => {
    const s = new HomeKitServiceTypes(path)
    s.set('pool', SWITCH, 'light')
    s.set('pool', SWITCH, null)

    expect(s.get('pool', SWITCH)).toBeNull()
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({})
  })

  it('treats selecting the service’s own type as clearing it', () => {
    const s = new HomeKitServiceTypes(path)
    s.set('pool', SWITCH, 'switch')
    expect(s.get('pool', SWITCH)).toBeNull()
  })

  it('survives a corrupt store by falling back to plugin defaults', () => {
    const s = new HomeKitServiceTypes(join(dir, 'missing.json'))
    expect(s.all()).toEqual({})
  })
})

describe('applying an override', () => {
  it('presents a Switch as a Lightbulb and re-categorises the accessory', () => {
    const s = new HomeKitServiceTypes(path, fakeHap())
    s.set('pool', SWITCH, 'light')

    const acc = fakeAccessory('pool', [fakeService(SWITCH, 'Pool Light')])
    s.apply(acc)

    expect(acc.services).toHaveLength(1)
    expect(acc.services[0].UUID).toBe(LIGHT)
    expect(acc.services[0].displayName).toBe('Pool Light')
    expect(acc.category).toBe(CONVERTIBLE_SERVICES.light.category)
  })

  it('forwards HomeKit writes to the original characteristic, so the plugin still acts on them', async () => {
    const s = new HomeKitServiceTypes(path, fakeHap())
    s.set('pool', SWITCH, 'light')

    const original = fakeService(SWITCH, 'Pool Light')
    const originalOn = original.characteristics[0]
    const acc = fakeAccessory('pool', [original])
    s.apply(acc)

    await acc.services[0].getCharacteristic().setHandler!(true)
    expect(originalOn.sets).toEqual([true])
  })

  it('mirrors plugin-side updates onto the replacement service', () => {
    const s = new HomeKitServiceTypes(path, fakeHap())
    s.set('pool', SWITCH, 'light')

    const original = fakeService(SWITCH, 'Pool Light')
    const acc = fakeAccessory('pool', [original])
    s.apply(acc)

    original.characteristics[0].emitChange(true)
    expect(acc.services[0].getCharacteristic().value).toBe(true)
  })

  it('leaves non-convertible services alone', () => {
    const s = new HomeKitServiceTypes(path, fakeHap())
    // Written directly: set() would accept this, but apply() must refuse it.
    s.set('thermo', THERMOSTAT, 'light')

    const acc = fakeAccessory('thermo', [fakeService(THERMOSTAT, 'Heating', 'other')])
    s.apply(acc)

    expect(acc.services[0].UUID).toBe(THERMOSTAT)
    expect(acc.category).toBe(8)
  })

  it('leaves accessories with no override untouched', () => {
    const s = new HomeKitServiceTypes(path, fakeHap())
    const acc = fakeAccessory('other', [fakeService(SWITCH, 'Garden Tap')])
    s.apply(acc)

    expect(acc.services[0].UUID).toBe(SWITCH)
  })
})

describe('bridge integration', () => {
  it('applies overrides on the way to the bridge, before HomeKit sees the accessory', () => {
    const types = new HomeKitServiceTypes(path, fakeHap())
    types.set('pool', SWITCH, 'light')

    const bridge = {
      added: [] as any[],
      addBridgedAccessory(acc: any) {
        this.added.push(acc)
        return acc
      },
      removeBridgedAccessory() {},
    }

    const wrapped = new HomeKitVisibility(join(dir, 'hidden.json'), null, types).wrapBridge(bridge)
    wrapped.addBridgedAccessory(fakeAccessory('pool', [fakeService(SWITCH, 'Pool Light')]))

    expect(bridge.added[0].services[0].UUID).toBe(LIGHT)
  })

  it('does not bother re-typing an accessory that is hidden anyway', () => {
    const types = new HomeKitServiceTypes(path, fakeHap())
    types.set('pool', SWITCH, 'light')

    const hiddenPath = join(dir, 'hidden.json')
    const visibility = new HomeKitVisibility(hiddenPath, null, types)
    visibility.setVisible('pool', false)

    const bridge = {
      added: [] as any[],
      addBridgedAccessory(acc: any) {
        this.added.push(acc)
        return acc
      },
      removeBridgedAccessory() {},
    }

    const acc = fakeAccessory('pool', [fakeService(SWITCH, 'Pool Light')])
    visibility.wrapBridge(bridge).addBridgedAccessory(acc)

    expect(bridge.added).toHaveLength(0)
    expect(acc.services[0].UUID).toBe(SWITCH)
  })
})
