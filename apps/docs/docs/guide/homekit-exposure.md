# HomeKit Exposure

Applies to **native OpenBridge plugins** (`openbridge-*`), the ones written against the
OpenBridge plugin API rather than loaded through the Homebridge compatibility layer.

A plugin usually discovers more than one device. Some of those devices belong in the Home app
and some do not, and the choice is per device, not per plugin.

The concrete case this exists for: a Shelly plugin that finds both a Pro 2PM and a 3EM energy
meter. The Pro 2PM drives pool lights and a filter pump, so its switches are genuinely useful in
HomeKit. The 3EM measures voltage, current and power per phase, none of which HomeKit can
represent. Disabling the whole plugin's HomeKit output would lose the switches to hide the
meter. Disabling nothing means cluttering the Home app with fake light sensors nobody wants.

## The convention

Native plugins expose a per-device `exposeToHomeKit` boolean in their configuration, defaulting
to `true`.

```json
{
  "name": "@nubisco/openbridge-shelly-platform",
  "config": {
    "devices": [
      { "ip": "192.168.1.178", "name": "Pool", "exposeToHomeKit": true },
      { "ip": "192.168.1.122", "name": "Home", "exposeToHomeKit": false }
    ]
  }
}
```

The two settings are independent, and that independence is the point:

| Setting                  | Effect                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `exposeToHomeKit: false` | The device is **not** published to the HAP bridge. It does not appear in the Home app.                                  |
| (always)                 | `registerDevice()` and `reportTelemetry()` still run. The device appears in OpenBridge with full telemetry and history. |

Turning HomeKit off never costs you data. Telemetry does not travel through HomeKit, so the
OpenBridge devices view, the energy history and any dashboards are unaffected.

## Implementing it

Read the flag per device entry, and skip the bridge call when it is false. Everything else
happens regardless.

```typescript
async start(ctx: PluginContext) {
  const mainBridge = ctx.getHapBridge?.()
  const hap = mainBridge?.hap ?? null
  const bridge = mainBridge?.bridge ?? null

  for (const device of devices) {
    // Always register with OpenBridge — this is what the UI and history use.
    ctx.registerDevice({
      id: device.id,
      name: device.name,
      widgetType: 'energy_meter',
    })

    // Publish to HomeKit only when asked, and only when a bridge exists.
    const expose = device.exposeToHomeKit !== false && Boolean(hap && bridge)
    if (expose) {
      const accessory = buildAccessory(hap, device)
      bridge.addBridgedAccessory(accessory)
    }
  }
}
```

Two details worth copying:

- Compare with `!== false`, not a truthy check, so an omitted flag defaults to exposed.
- Guard on the bridge existing. `ctx.getHapBridge()` returns `null` when the plugin runs without
  a HAP bridge, and a plugin should still report telemetry in that case rather than fail.

## Declaring it in `config.schema.json`

Include the flag so the OpenBridge config UI renders a toggle per device:

```json
{
  "exposeToHomeKit": {
    "title": "Expose to HomeKit",
    "type": "boolean",
    "default": true,
    "description": "Publish this device to the Home app. Turn off for devices HomeKit cannot represent usefully. OpenBridge telemetry and history are unaffected."
  }
}
```

## When to default to `false`

Default to `true`. Users expect a device they configured to show up.

Consider documenting `false` as the recommended value for device classes HomeKit has no
characteristic for, where the only way to surface a value is to misuse an unrelated one. Energy
meters are the clearest example: with no power characteristic in HAP, watts are conventionally
smuggled through a light sensor's lux field. That produces a Home app tile reading
"458 lux" for 458 watts, and it cannot carry voltage, current or power factor at all.

Say so in the plugin's own documentation rather than silently changing the default.

## Granularity

The flag belongs on whatever a user thinks of as "a device", which is normally one physical unit
in the configuration. A plugin that fans one physical unit into several OpenBridge devices (a
three-phase meter becoming a total plus three phases) should apply the flag to the whole group,
and offer separate options if the individual channels are worth controlling.

## Homebridge-compat plugins

This convention does not apply to plugins loaded through the Homebridge compatibility layer.
Those plugins only produce HAP accessories, so there is nothing left if HomeKit is switched off.
Hiding them is a host-side concern rather than a plugin setting.

## Related pages

- [Creating a Plugin](/guide/creating-a-plugin)
- [Plugin API Reference](/guide/plugin-api)
- [Homebridge Compatibility](/guide/homebridge-compatibility)

## The OpenBridge-level toggle

Everything above describes what a plugin can offer. OpenBridge also enforces
visibility itself, for every plugin, from the device inspector.

Open a device, find **HomeKit → Expose to HomeKit**, and switch it off. The
accessory is removed from the bridge immediately and will not be re-added on
restart. Its OpenBridge telemetry, history and charts are unaffected, because
none of that travels through HomeKit.

This works regardless of whether the plugin implements `exposeToHomeKit`, which
matters because Homebridge-compat plugins never will. Enforcement sits around
the HAP bridge itself, and both plugin kinds reach HomeKit through the same
`addBridgedAccessory` call.

The two mechanisms compose without conflicting:

|                                    | Set by                     | Applies to                |
| ---------------------------------- | -------------------------- | ------------------------- |
| `exposeToHomeKit` in plugin config | the plugin author's schema | that plugin's devices     |
| Inspector toggle                   | the user, at runtime       | any accessory, any plugin |

If a device is hidden by either, it does not reach HomeKit.

Preferences live in `~/.openbridge/homekit-hidden.json`, keyed by HAP accessory
UUID, the only identifier both plugin kinds share. If that file is unreadable
OpenBridge hides nothing, on the grounds that a corrupt file should not silently
strip devices out of someone's Home app.
