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
// PluginInspector.vue, DevicesView.vue), navItems (AppLayout.vue), the House
// view's empty state (HouseView.vue), the House editor's tools (HouseEditor.vue), Library
// (house/library.ts) and outline (HouseOutline.vue), and the
// bell's two states (NotificationBell.vue).
import { registerIcons } from '@nubisco/ui'

import * as armchair from '@nubisco/ui/icons/armchair'
import * as arrowsOutLineHorizontal from '@nubisco/ui/icons/arrows-out-line-horizontal'
import * as boundingBox from '@nubisco/ui/icons/bounding-box'
import * as columns from '@nubisco/ui/icons/columns'
import * as cursor from '@nubisco/ui/icons/cursor'
import * as doorOpen from '@nubisco/ui/icons/door-open'
import * as squaresFour from '@nubisco/ui/icons/squares-four'
import * as swimmingPool from '@nubisco/ui/icons/swimming-pool'
import * as tree from '@nubisco/ui/icons/tree'
import * as appWindow from '@nubisco/ui/icons/app-window'
import * as bell from '@nubisco/ui/icons/bell'
import * as blueprint from '@nubisco/ui/icons/blueprint'
import * as bellRinging from '@nubisco/ui/icons/bell-ringing'
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
// The House editor's Library and outline (house/library.ts, HouseOutline.vue).
import * as couch from '@nubisco/ui/icons/couch'
import * as rug from '@nubisco/ui/icons/rug'
import * as bed from '@nubisco/ui/icons/bed'
import * as bathtub from '@nubisco/ui/icons/bathtub'
import * as shower from '@nubisco/ui/icons/shower'
import * as toilet from '@nubisco/ui/icons/toilet'
import * as pottedPlant from '@nubisco/ui/icons/potted-plant'
import * as dropHalfBottom from '@nubisco/ui/icons/drop-half-bottom'
import * as gauge from '@nubisco/ui/icons/gauge'
import * as thermometerSimple from '@nubisco/ui/icons/thermometer-simple'
import * as securityCamera from '@nubisco/ui/icons/security-camera'
import * as stack from '@nubisco/ui/icons/stack'
import * as dotsThree from '@nubisco/ui/icons/dots-three'

export function registerRuntimeIcons(): void {
  registerIcons({
    armchair: armchair,
    'arrows-out-line-horizontal': arrowsOutLineHorizontal,
    'bounding-box': boundingBox,
    columns: columns,
    cursor: cursor,
    'door-open': doorOpen,
    'squares-four': squaresFour,
    'swimming-pool': swimmingPool,
    tree: tree,
    'app-window': appWindow,
    bell: bell,
    'bell-ringing': bellRinging,
    blueprint: blueprint,
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
    couch: couch,
    rug: rug,
    bed: bed,
    bathtub: bathtub,
    shower: shower,
    toilet: toilet,
    'potted-plant': pottedPlant,
    'drop-half-bottom': dropHalfBottom,
    gauge: gauge,
    'thermometer-simple': thermometerSimple,
    'security-camera': securityCamera,
    stack: stack,
    'dots-three': dotsThree,
  })
}
