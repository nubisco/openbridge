import { describe, it, expect } from 'vitest'
import { serializeAccessory } from '../index.js'

/**
 * A Homebridge plugin reports an unreachable device by pushing a HapStatusError
 * into its characteristics. HAP-NodeJS records that in `statusCode` and leaves
 * `value` holding the last good reading.
 *
 * That combination is the trap these tests exist for: a WiZ bulb that had been
 * off the network for an hour still serialised as `On: false`, which the UI drew
 * as a healthy bulb that someone had simply switched off. `reachable` could not
 * correct it either, because it was derived from `acc.reachable`, a Homebridge
 * field deprecated years ago that no current plugin sets, so it was true for
 * every accessory forever.
 */

/** A characteristic as HAP-NodeJS presents one. */
function ch(name: string, value: unknown, statusCode = 0) {
  return { UUID: `uuid-${name}`, displayName: name, value, statusCode, props: { format: 'bool', perms: ['pr'] } }
}

function accessory(characteristics: ReturnType<typeof ch>[], extra: Record<string, unknown> = {}) {
  return {
    UUID: 'acc-1',
    displayName: 'Wiz RGB Bulb',
    category: 5,
    services: [{ UUID: 'svc-1', displayName: 'Lightbulb', characteristics }],
    ...extra,
  }
}

describe('serializeAccessory', () => {
  it('reports a healthy accessory as reachable and carries its values', () => {
    const out = serializeAccessory(accessory([ch('On', true), ch('Brightness', 100)]))

    expect(out.reachable).toBe(true)
    expect(out.statusCode).toBeUndefined()
    expect(out.services[0]!.characteristics.map((c) => c.value)).toEqual([true, 100])
    expect(out.services[0]!.characteristics.every((c) => c.statusCode === 0)).toBe(true)
  })

  it('reports an accessory as unreachable when a characteristic is faulted', () => {
    // -70402 is SERVICE_COMMUNICATION_FAILURE, what the WiZ plugin pushes after
    // three missed pings. `value` deliberately still reads false, as it does live.
    const out = serializeAccessory(accessory([ch('On', false, -70402), ch('Brightness', 0, -70402)]))

    expect(out.reachable).toBe(false)
    expect(out.statusCode).toBe(-70402)
  })

  it('keeps the stale value visible so callers can decide what to show', () => {
    const out = serializeAccessory(accessory([ch('On', true, -70402)]))

    // The last good reading is still worth having: the inspector shows it as
    // "last known". What must not happen is presenting it as current, and the
    // status code is what lets a caller tell the difference.
    expect(out.services[0]!.characteristics[0]!.value).toBe(true)
    expect(out.services[0]!.characteristics[0]!.statusCode).toBe(-70402)
    expect(out.reachable).toBe(false)
  })

  it('treats one faulted characteristic among healthy ones as unreachable', () => {
    // HomeKit greys out the whole tile on this basis. A device answering for
    // three of its four characteristics is not one to call fine.
    const out = serializeAccessory(accessory([ch('On', true), ch('Brightness', 50, -70402), ch('Hue', 120)]))

    expect(out.reachable).toBe(false)
    expect(out.statusCode).toBe(-70402)
  })

  it('still honours an explicit acc.reachable === false', () => {
    const out = serializeAccessory(accessory([ch('On', true)], { reachable: false }))

    expect(out.reachable).toBe(false)
  })

  it('defaults a characteristic with no statusCode to healthy', () => {
    // Not every plugin or HAP version sets the field. Absent must not read as
    // faulted, or every accessory would show as unreachable.
    const bare = { UUID: 'u', displayName: 'On', value: true, props: {} }
    const out = serializeAccessory(accessory([bare as never]))

    expect(out.reachable).toBe(true)
    expect(out.services[0]!.characteristics[0]!.statusCode).toBe(0)
  })
})
