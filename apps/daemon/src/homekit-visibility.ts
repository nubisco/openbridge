import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { Logger } from '@nubisco/openbridge-logger'

const log = Logger.create('homekit')

/**
 * Per-accessory HomeKit visibility.
 *
 * Some devices have no useful HomeKit representation. An energy meter is the
 * clearest case: HAP has no characteristic for electrical power, so watts can
 * only be smuggled through a light sensor's lux field, and voltage, current and
 * power factor cannot be expressed at all. Users want those devices in
 * OpenBridge and out of the Home app, without losing the sibling devices the
 * same plugin provides (a Shelly plugin may serve both a pool switch worth
 * exposing and a meter that is not).
 *
 * Plugins can offer their own `exposeToHomeKit` config, but that only works for
 * plugins that implement it. Enforcing it here covers every plugin, including
 * Homebridge-compat ones that have no such setting, because both paths reach
 * the bridge through `addBridgedAccessory`.
 *
 * Visibility is keyed by HAP accessory UUID, the only identifier both plugin
 * kinds share.
 */
export class HomeKitVisibility {
  private hidden = new Set<string>()
  /** Accessories seen by the bridge, so a hidden one can be restored later. */
  private known = new Map<string, unknown>()

  constructor(
    private readonly path: string,
    private bridge: any = null,
  ) {
    this.load()
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) return
      const raw = JSON.parse(readFileSync(this.path, 'utf8'))
      if (Array.isArray(raw)) this.hidden = new Set(raw.filter((v) => typeof v === 'string'))
    } catch (err) {
      log.warn(`Could not read HomeKit visibility list, treating all accessories as visible: ${err}`)
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, JSON.stringify([...this.hidden], null, 2))
    } catch (err) {
      log.warn(`Could not persist HomeKit visibility list: ${err}`)
    }
  }

  isHidden(uuid: string): boolean {
    return this.hidden.has(uuid)
  }

  hiddenList(): string[] {
    return [...this.hidden]
  }

  /**
   * Wrap the HAP bridge so hidden accessories never reach it.
   *
   * A Proxy is used rather than subclassing because the bridge is a hap-nodejs
   * instance shared with plugins: everything except the two intercepted methods
   * must behave exactly as before.
   */
  wrapBridge(bridge: any): any {
    this.bridge = bridge

    return new Proxy(bridge, {
      get: (target, prop, receiver) => {
        if (prop === 'addBridgedAccessory') {
          return (accessory: any, ...rest: unknown[]) => {
            const uuid = accessory?.UUID
            if (uuid) {
              this.known.set(uuid, accessory)
              if (this.hidden.has(uuid)) {
                log.debug(`Not exposing "${accessory.displayName}" to HomeKit (hidden by user)`)
                return accessory
              }
            }
            return target.addBridgedAccessory(accessory, ...rest)
          }
        }

        if (prop === 'removeBridgedAccessory') {
          return (accessory: any, ...rest: unknown[]) => {
            const uuid = accessory?.UUID
            // A hidden accessory was never added, so asking hap-nodejs to
            // remove it would throw.
            if (uuid && this.hidden.has(uuid)) return
            return target.removeBridgedAccessory(accessory, ...rest)
          }
        }

        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }

  /**
   * Change visibility and apply it immediately.
   *
   * Applying at runtime matters: without it the Home app keeps showing a device
   * the user just hid until the next restart, which reads as the toggle being
   * broken.
   */
  setVisible(uuid: string, visible: boolean): { changed: boolean; applied: boolean } {
    const wasHidden = this.hidden.has(uuid)
    if (wasHidden === !visible) return { changed: false, applied: true }

    if (visible) this.hidden.delete(uuid)
    else this.hidden.add(uuid)
    this.save()

    const accessory = this.known.get(uuid)
    if (!accessory || !this.bridge) return { changed: true, applied: false }

    try {
      if (visible) this.bridge.addBridgedAccessory(accessory)
      else this.bridge.removeBridgedAccessory(accessory, false)
      return { changed: true, applied: true }
    } catch (err) {
      // The preference is saved regardless, so a restart still honours it.
      log.warn(`Visibility saved but could not be applied live for ${uuid}: ${err}`)
      return { changed: true, applied: false }
    }
  }

  /** Record an accessory without going through the bridge (used on restore). */
  track(uuid: string, accessory: unknown): void {
    if (uuid) this.known.set(uuid, accessory)
  }
}
