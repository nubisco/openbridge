import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { Logger } from '@nubisco/openbridge-logger'

const log = Logger.create('homekit')

/**
 * Per-service HomeKit type overrides.
 *
 * A plugin decides what HAP service to publish, and for a generic relay that
 * decision is necessarily a guess: a Shelly channel is a `Switch` because the
 * plugin cannot know it drives a pool light. HomeKit derives the tile, the
 * icon, the Siri grammar and the room summary from that service type, so the
 * guess is wrong in a way the user sees every day. Re-typing the accessory in
 * the Home app does not stick, because the bridge re-publishes the original
 * type on the next restart.
 *
 * Plugins can offer their own setting for this (the Shelly plugin has a
 * per-channel `type`), but only for plugins that implement it. Enforcing it
 * here covers every plugin, including Homebridge-compat ones, because both
 * paths reach the bridge through `addBridgedAccessory`: the same reasoning as
 * {@link HomeKitVisibility}, and applied at the same interception point.
 *
 * Scope is deliberately narrow: only services built around the `On`
 * characteristic can stand in for one another. Presenting a thermostat as a
 * lightbulb would drop every characteristic that gives it meaning, so those
 * conversions are rejected rather than half-performed.
 */

const ON_CHARACTERISTIC = '00000025-0000-1000-8000-0026BB765291'

/**
 * Service types that are interchangeable: each requires exactly `Name` + `On`,
 * so one can stand in for another without inventing or dropping state.
 *
 * Deliberately excluded, despite looking like near neighbours: `Fanv2` and
 * `Valve` are built on `Active` rather than `On` (and `Valve` additionally
 * requires `InUse` and `ValveType`), so they are not drop-in substitutes.
 */
export const CONVERTIBLE_SERVICES = {
  switch: { uuid: '00000049-0000-1000-8000-0026BB765291', service: 'Switch', label: 'Switch', category: 8 },
  light: { uuid: '00000043-0000-1000-8000-0026BB765291', service: 'Lightbulb', label: 'Light', category: 5 },
  outlet: { uuid: '00000047-0000-1000-8000-0026BB765291', service: 'Outlet', label: 'Outlet', category: 7 },
  fan: { uuid: '00000040-0000-1000-8000-0026BB765291', service: 'Fan', label: 'Fan', category: 3 },
} as const

export type ServiceTypeKey = keyof typeof CONVERTIBLE_SERVICES

const UUID_TO_KEY = new Map<string, ServiceTypeKey>(
  (Object.keys(CONVERTIBLE_SERVICES) as ServiceTypeKey[]).map((key) => [CONVERTIBLE_SERVICES[key].uuid, key]),
)

/** True when a service is one of the interchangeable On-based types. */
export function isConvertible(serviceUuid: string): boolean {
  return UUID_TO_KEY.has(serviceUuid)
}

/** Overrides keyed by accessory UUID, then by the service's own UUID. */
type Overrides = Record<string, Record<string, ServiceTypeKey>>

export class HomeKitServiceTypes {
  private overrides: Overrides = {}

  constructor(
    private readonly path: string,
    private hap: any = null,
  ) {
    this.load()
  }

  setHap(hap: any): void {
    this.hap = hap
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) return
      const raw = JSON.parse(readFileSync(this.path, 'utf8'))
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) this.overrides = raw
    } catch (err) {
      log.warn(`Could not read HomeKit service type overrides, using plugin defaults: ${err}`)
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, JSON.stringify(this.overrides, null, 2))
    } catch (err) {
      log.warn(`Could not persist HomeKit service type overrides: ${err}`)
    }
  }

  all(): Overrides {
    return this.overrides
  }

  get(accessoryUuid: string, serviceUuid: string): ServiceTypeKey | null {
    return this.overrides[accessoryUuid]?.[serviceUuid] ?? null
  }

  /**
   * The type an accessory is presented as, ignoring which service carries it.
   *
   * A device maps to a single accessory and only one of its services is
   * convertible, so the first override is the accessory's effective type. Used
   * to label and icon the device card, which has no notion of services.
   */
  typeForAccessory(accessoryUuid: string): ServiceTypeKey | null {
    const forAccessory = this.overrides[accessoryUuid]
    if (!forAccessory) return null
    return Object.values(forAccessory)[0] ?? null
  }

  /**
   * Record an override. Passing the service's own type (or null) clears it.
   *
   * Not applied live: an accessory already published to HomeKit cannot change
   * service type in place: controllers cache the shape at pairing. The caller
   * is expected to tell the user a restart is needed, as the visibility toggle
   * does when it cannot apply immediately.
   */
  set(accessoryUuid: string, serviceUuid: string, type: ServiceTypeKey | null): void {
    const isNoOp = type === null || CONVERTIBLE_SERVICES[type]?.uuid === serviceUuid

    if (isNoOp) {
      const forAccessory = this.overrides[accessoryUuid]
      if (!forAccessory) return
      delete forAccessory[serviceUuid]
      if (Object.keys(forAccessory).length === 0) delete this.overrides[accessoryUuid]
    } else {
      this.overrides[accessoryUuid] ??= {}
      this.overrides[accessoryUuid][serviceUuid] = type
    }

    this.save()
  }

  /**
   * Swap overridden services on an accessory before it reaches the bridge.
   *
   * The original service is not mutated. Rewriting `service.UUID` in place
   * would be shorter, but the plugin looks its own services up by type
   * (`accessory.getService(Service.Switch)`), so a plugin that re-resolves
   * after startup would stop finding it. Instead a new service of the target
   * type is added and the two are kept in sync: plugin-side updates flow out
   * through `change` events, and HomeKit writes flow back into the original
   * characteristic so the plugin's own `onSet` handler still runs.
   */
  apply(accessory: any): void {
    const forAccessory = this.overrides[accessory?.UUID]
    if (!forAccessory || !this.hap) return

    for (const [serviceUuid, targetKey] of Object.entries(forAccessory)) {
      const target = CONVERTIBLE_SERVICES[targetKey]
      if (!target || serviceUuid === target.uuid) continue

      const original = (accessory.services ?? []).find((s: any) => s.UUID === serviceUuid)
      if (!original) continue

      if (!isConvertible(serviceUuid)) {
        log.warn(
          `Not re-typing "${original.displayName}": ${serviceUuid} is not an On-based service, ` +
            `so presenting it as a ${target.label} would drop its characteristics`,
        )
        continue
      }

      try {
        this.swap(accessory, original, target)
        log.info(`Presenting "${original.displayName}" to HomeKit as a ${target.label}`)
      } catch (err) {
        // The accessory is still perfectly usable with its original type, so a
        // failure here degrades rather than breaks.
        log.warn(`Could not re-type "${original.displayName}" as a ${target.label}: ${err}`)
      }
    }
  }

  private swap(accessory: any, original: any, target: (typeof CONVERTIBLE_SERVICES)[ServiceTypeKey]): void {
    const ServiceCtor = this.hap.Service[target.service]
    if (!ServiceCtor) throw new Error(`hap-nodejs has no Service.${target.service}`)

    const replacement = new ServiceCtor(original.displayName, original.subtype)

    const originalOn = original.characteristics?.find((c: any) => c.UUID === ON_CHARACTERISTIC)
    const replacementOn = replacement.getCharacteristic(this.hap.Characteristic.On)
    if (!originalOn || !replacementOn) throw new Error('missing On characteristic on one side of the swap')

    // Seed, then keep the two in step in both directions.
    replacementOn.updateValue(originalOn.value)
    originalOn.on('change', ({ newValue }: { newValue: unknown }) => replacementOn.updateValue(newValue))
    replacementOn.onSet(async (value: unknown) => {
      originalOn.setValue(value)
    })
    replacementOn.onGet(() => originalOn.value)

    accessory.removeService(original)
    accessory.addService(replacement)

    // HomeKit picks the tile glyph from the accessory category, so leaving it
    // as SWITCH would show a switch icon on a service that now says light.
    accessory.category = target.category
  }
}
