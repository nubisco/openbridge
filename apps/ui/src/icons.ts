// Icons this app resolves at runtime rather than naming as a literal.
//
// Needed for @nubisco/ui 4.x: the Vite plugin rewrites literal names such as
// `<NbIcon name="gear" />` into an import of that one glyph, but it cannot see
// through `widgetIcon(dev.widgetType)`, `categoryInfo(cat).icon` or `item.icon`.
// An unresolved name throws on first render, so every value those helpers can
// return is registered here instead. The set is bounded (widget types, HomeKit
// accessory categories and the nav items), so we register exactly it rather
// than importing the whole ~1,500-icon catalogue.
//
// Keep in sync with WIDGET_ICON / CATEGORY_INFO (DeviceInspector.vue,
// PluginInspector.vue, DevicesView.vue) and navItems (AppLayout.vue).
import { registerIcons } from '@nubisco/ui'

import * as appWindow from '@nubisco/ui/icons/app-window'
import * as bell from '@nubisco/ui/icons/bell'
import * as bracketsCurly from '@nubisco/ui/icons/brackets-curly'
import * as broadcast from '@nubisco/ui/icons/broadcast'
import * as camera from '@nubisco/ui/icons/camera'
import * as cube from '@nubisco/ui/icons/cube'
import * as devices from '@nubisco/ui/icons/devices'
import * as door from '@nubisco/ui/icons/door'
import * as drop from '@nubisco/ui/icons/drop'
import * as fan from '@nubisco/ui/icons/fan'
import * as gameController from '@nubisco/ui/icons/game-controller'
import * as garage from '@nubisco/ui/icons/garage'
import * as gear from '@nubisco/ui/icons/gear'
import * as house from '@nubisco/ui/icons/house'
import * as intersect from '@nubisco/ui/icons/intersect'
import * as lamp from '@nubisco/ui/icons/lamp'
import * as lightbulb from '@nubisco/ui/icons/lightbulb'
import * as lightning from '@nubisco/ui/icons/lightning'
import * as lock from '@nubisco/ui/icons/lock'
import * as plugs from '@nubisco/ui/icons/plugs'
import * as pulse from '@nubisco/ui/icons/pulse'
import * as puzzlePiece from '@nubisco/ui/icons/puzzle-piece'
import * as rows from '@nubisco/ui/icons/rows'
import * as shield from '@nubisco/ui/icons/shield'
import * as sliders from '@nubisco/ui/icons/sliders'
import * as snowflake from '@nubisco/ui/icons/snowflake'
import * as speakerHifi from '@nubisco/ui/icons/speaker-hifi'
import * as speakerHigh from '@nubisco/ui/icons/speaker-high'
import * as television from '@nubisco/ui/icons/television'
import * as terminal from '@nubisco/ui/icons/terminal'
import * as thermometer from '@nubisco/ui/icons/thermometer'
import * as thermometerHot from '@nubisco/ui/icons/thermometer-hot'
import * as toggleRight from '@nubisco/ui/icons/toggle-right'
import * as wind from '@nubisco/ui/icons/wind'

export function registerRuntimeIcons(): void {
  registerIcons({
    'app-window': appWindow,
    bell: bell,
    'brackets-curly': bracketsCurly,
    broadcast: broadcast,
    camera: camera,
    cube: cube,
    devices: devices,
    door: door,
    drop: drop,
    fan: fan,
    'game-controller': gameController,
    garage: garage,
    gear: gear,
    house: house,
    intersect: intersect,
    lamp: lamp,
    lightbulb: lightbulb,
    lightning: lightning,
    lock: lock,
    plugs: plugs,
    pulse: pulse,
    'puzzle-piece': puzzlePiece,
    rows: rows,
    shield: shield,
    sliders: sliders,
    snowflake: snowflake,
    'speaker-hifi': speakerHifi,
    'speaker-high': speakerHigh,
    television: television,
    terminal: terminal,
    thermometer: thermometer,
    'thermometer-hot': thermometerHot,
    'toggle-right': toggleRight,
    wind: wind,
  })
}
