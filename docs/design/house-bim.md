# The house plan as a building model (BIM)

Status: agreed direction, work in stages. Decided by Jose on 2026-11-20.

## Why

The house editor (`apps/ui/src/house`, `apps/daemon/src/house.ts`) will be the
basis for Keystone, Nubisco's renovation project manager. Keystone has to
exchange drawings with architects' and engineers' software, which means BIM, and
in practice the open format IFC (ISO 16739). So the plan has to become a real
building model, not only a picture of one.

## What was decided

| Question               | Decision                                                                                                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How exact the model is | Millimetres, with walls as elements of their own (thickness, height). The 0.5 m grid becomes a snapping setting of the editor, not a limit of the data. Plans saved today are migrated on load.    |
| Where the code lives   | In OpenBridge for now. Extracting a shared package for Keystone comes later, so keep the model, geometry and IFC code free of OpenBridge specifics (devices, live state) where that costs nothing. |
| First BIM deliverable  | IFC export. Import comes after.                                                                                                                                                                    |

## The model today, and what changes

Today a plan is in grid cells of 0.5 m. A room is a rectangle (plus more
rectangles for an L or U). Walls are not stored: they are the edges of rooms,
worked out per cell edge, with no thickness. Doors, windows and radiators sit
on those cell edges.

The new model (plan version 2):

- **Lengths in millimetres**, integers, everywhere.
- **Storeys** (today's floors) with an elevation and a height.
- **Walls** stored as elements: a centre line from one point to another, a
  thickness and a height. Rooms no longer imply walls.
- **Spaces** (today's rooms) as polygons, so a room can have any shape. A
  room's kind (room, garden, paving, pool) stays.
- **Openings** (doors, windows, sliders, glass doors, open stretches) hosted by
  a wall: distance along it, width, sill height and head height.
- **Furniture, radiators and devices** keep what they have, in millimetres.

### Doors and windows: two elements, many variants

Decided by Jose on 2026-11-20: there is one door and one window, not a tool per
kind. What makes a sliding glass door different from a white wooden door is a
set of properties on the same element, and those properties are what IFC
records anyway (`IfcDoor` and `IfcWindow` with an operation type, a lining and
a panel material).

An opening in plan version 2:

| Property             | Door                                                          | Window                                                                           |
| -------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| How it opens         | swing, double swing, sliding, lift and slide, folding, pocket | fixed, casement, tilt and turn, sliding, awning, hung                            |
| Leaf                 | solid, glazed, part glazed                                    | always glazed                                                                    |
| Frame                | aluminium, PVC, wood, steel                                   | the same                                                                         |
| Colour               | free, with presets (white, brown, anthracite, natural wood)   | the same                                                                         |
| Sill and head        | sill 0, head 2100 mm by default                               | sill 900, head 2100 by default. A full height fixed pane is a window with sill 0 |
| Hinge and swing side | for swing kinds                                               | for casement and tilt and turn                                                   |

Jose's house as the test case: sliding glass windows and sliding glass doors in
aluminium frames, full height fixed panes beside a glazed aluminium swing door,
and solid wooden doors in brown and in white. Each is one door or window with
the right variant, and the editor offers presets for these common ones so
nobody fills six fields to place a patio door.

An opening without wall (two rooms that run into each other) stays a third
kind, `gap`. It is not a door or window and has no variants.

### What covers the glass

Anything glazed (a window, or a door with a glazed or part glazed leaf) can
carry **coverings**, each on the inside or the outside:

- roller shutter, external blind (slats), awning
- curtains, interior blinds (roller, venetian, pleated)

A covering is manual, or motorised and then linked to the device that drives
it. Today a shutter is a device placed "on" a window. In version 2 it becomes a
covering of that window that names its device, so a window can have an outside
shutter and inside curtains at once, both automated or not. The migration turns
every shutter placed on a window into such a covering. In IFC a covering is an
`IfcShadingDevice` (shutter, jalousie, awning, or user defined for curtains).

### Devices that belong to the building

The same idea goes further, and it is where the IoT side of the app is thin
today: many devices are part of a building element, not a dot on the floor.
Version 2 lets an element host them:

- a door: a smart lock, a contact sensor, a motor (gate, garage door)
- a window: a contact sensor, a motor (roof windows, skylights)
- a covering: its motor
- a radiator: its thermostatic valve

The live view then shows state where it is in the house (the door drawn open
when its sensor says so, the shutter drawn half down), and the IFC export puts
each device in its element's space with the link kept.

### Migration

Migration from version 1 is exact: every value is a whole number of cells, so it
converts to millimetres without rounding, and each room edge that today draws a
wall becomes a wall element of the default thickness. The daemon keeps a copy of
the version 1 file the first time it migrates one (`house.json.v1.json`).

How it is built (stage 1, in OpenBridge first, now the package `@nubisco/bim`):

- Decided by Jose on 2026-11-24: the model is its own package,
  `@nubisco/bim` (github.com/nubisco/bim, MIT), so Keystone can use it too.
  OpenBridge depends on it from npm, the daemon and the UI alike
  (`@nubisco/bim/convert`, `@nubisco/bim/v2` and so on). Its tests, the
  IFC fixtures and the IfcOpenShell check live there.
- `v1.ts` and `v2.ts` are the two formats, `convert.ts` goes between them,
  `validate.ts` checks a version 2 plan, `cells.ts` turns cells into outlines
  and back. All pure TypeScript, with no Node.
- Walls are the room edges merged into straight runs, cut where a wall changes
  from inner (100 mm, rooms both sides) to outer (300 mm). Height 2500 mm,
  storeys 2800 mm floor to floor.
- Until the editor draws in millimetres, it still saves version 1. The daemon
  converts that against the stored plan, keeping by id everything version 1
  cannot say (wall thickness by overlap, frames, operation, coverings).
- A door or window in version 1 carries its version 2 detail in `spec` (how
  it opens, the leaf, frame, sill and head in millimetres, and its coverings),
  and a device on glass names the covering it drives in `covering`. That is
  how the cell editor sets them (stage 2). The cells stay authoritative for
  what they can say: whether it is a window, whether it slides, whether it
  is glass. Detail that contradicts them is ignored, and an empty
  `coverings` list takes every covering off.
- A space keeps the rectangles the editor drew it as (`rects`), so the editor
  shows the same parts it had. The outline is the shape.
- A device on a building element names it in `host` (an opening, and the
  covering it drives).
- Checked on the real plan: version 1 to 2 and back is exact, and converting
  twice gives the same plan.

## The IFC export

IFC4 (ADD2 TC1), written as a STEP file (`.ifc`) by our own TypeScript writer,
which needs no WebAssembly and runs in the browser and in the daemon.

| Plan                             | IFC                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------- |
| The plan                         | `IfcProject`, with metres as the length unit                                    |
| The plot                         | `IfcSite`                                                                       |
| The house                        | `IfcBuilding`                                                                   |
| A floor                          | `IfcBuildingStorey`, with its elevation                                         |
| A room                           | `IfcSpace`, with its outline and height                                         |
| A garden, paving                 | `IfcSpace` (external), or `IfcGeographicElement`                                |
| A pool                           | `IfcSpace` with a pool predefined type                                          |
| A wall                           | `IfcWall`, an extruded rectangle, with a material layer for its thickness       |
| A door, sliding door, glass door | `IfcDoor`, filling an `IfcOpeningElement` that voids the wall                   |
| A window                         | `IfcWindow`, the same way                                                       |
| The floor slab                   | `IfcSlab` per storey                                                            |
| Furniture                        | `IfcFurniture` (or `IfcSanitaryTerminal` for a bath, shower, toilet, basin)     |
| A radiator                       | `IfcSpaceHeater`                                                                |
| A heating circuit                | `IfcPipeSegment`s in an `IfcDistributionSystem`                                 |
| A device                         | `IfcSensor`, `IfcController`, `IfcLightFixture`, `IfcOutlet` and so on, by kind |

Every element gets a stable `GlobalId` derived from its id in the plan, so a
second export of the same plan names the same things, which other software
relies on to track changes.

**How it is checked:** every export in the tests is validated with IfcOpenShell
(schema and geometry), and the exported real plan is opened in Bonsai
(BlenderBIM) with screenshots compared against the editor.

Shipped in stage 3:

- The writer and the mapping are `ifc.ts` in `@nubisco/bim`
  (`toIfc`). What a placed device is in IFC is the caller's to say: the UI
  decides it from the device's kind and look in `apps/ui/src/house/ifc.ts`.
- "Export IFC" is on the House page, in view and while editing. Editing, it
  exports what is drawn, saved or not. The file is built in the browser.
- Plan (x, y) is IFC (x, -y) in metres, so the house is the same way round.
  A wall's placement runs along it, so its left side is local +Y, which is
  where the side of a radiator or a covering is worked out.
- Coverings are `IfcShadingDevice`s connected to their door or window
  (`IfcRelConnectsElements`), and a device that drives one is connected to
  it the same way. Detail the IFC classes have no place for (how an opening
  works, its frame, a covering's side, whether it has a motor) is in the
  property sets `House_Opening`, `House_Covering` and `House_Device`.
- Not exported yet: heating circuits as pipes.
- `@nubisco/bim`'s `test/ifc.test.ts` runs IfcOpenShell (`validate-ifc.py`) on
  every CI run: the schema, its rules, and building every shape. The real
  plan and every device mapping were checked the same way when it shipped.
  Opening the export in Bonsai is still to do.

## The IFC import

Decided by Jose on 2026-11-24: our own reader, like the writer (no
WebAssembly), and an import replaces the drawing while keeping the devices.

- `ifc-read.ts` in `@nubisco/bim` (`fromIfc`): a STEP reader, then
  the building read from the structures the common tools write. Units from
  the project (millimetres, metres, feet). Storeys by height, the one nearest
  0 being the ground floor. Walls by their Axis, or the middle of an extruded
  rectangle or of their footprint, with their thickness and height from the
  body (a material layer set when there is no body). Spaces by their
  footprint, named by LongName before Name. Doors and windows through the
  openings that void a wall (`IfcRelVoidsElement`, `IfcRelFillsElement`),
  measured along it. Radiators (`IfcSpaceHeater`), furniture and sanitary
  terminals by type or name. Meshes count by the box round them. Devices are
  not read.
- A room drawn to the inside faces of its walls, as most tools draw one, is
  moved out onto the walls' middle lines, as the plan draws rooms.
- A house off the plan's corner, or at negative coordinates, is moved onto
  the plot by whole half metres with a 1 m margin.
- Our own export carries the plot and the snapping step in `House_Site` on
  `IfcSite`, and how openings work and coverings in its property sets, so an
  export read back is the same building (tested, and checked on the real
  plan). Floors and rooms keep their ids by level and name (`adoptIds`).
- "Import IFC" is on the House page while editing. The file is read in the
  browser and replaces the drawing as one step that Undo takes back. Devices
  stay where they are on the floor at the same level, and one on a floor the
  file does not have goes back to "Not on the plan yet".
- Left out, and said so after the import: curtain walls, recesses that are
  not doors or windows, doors and windows in no wall, shapes the reader does
  not understand. Doors and windows on slanted walls come in and show like
  any other. A space edge with no wall in the file becomes a wall,
  because the editor's rooms are walled.
- Tested in `@nubisco/bim` with `test/fixtures/foreign-house.ifc`, made by IfcOpenShell the way
  Bonsai makes a file (`test/fixtures/make-foreign-ifc.py`): millimetres, an
  origin off the house, spaces to the inside faces, indexed poly curves.

## Stages

Each stage ships on its own, and the live house view keeps working at every
step.

1. **Model version 2.** The types, the daemon's validation, the migration from
   version 1 with tests on real plans, and an adapter so the current editor and
   3D view keep drawing from it unchanged. Nothing changes on screen.
   This includes the door and window variants and the coverings above, with
   today's four opening tools mapped onto them.
2. **One door, one window.** The editor gets a single Door tool and a single
   Window tool with presets, the variant and frame in the inspector, and
   coverings (manual or linked to a device) on anything glazed.
3. **IFC export.** The writer, the mapping above, an "Export IFC" action in the
   editor, validated as described.
4. **The editor in millimetres.** Walls drawn and edited as walls, thickness and
   height in the inspector, exact numbers typed in, snapping chosen (0.5 m,
   10 cm, 1 cm, off), measurements shown while drawing. It ships in four
   steps, each usable on its own:
   1. Undo and redo (shipped). A step is the plan once a change settles: each
      tap or drag when it ends, typing when it pauses. Whole copies of the
      plan, in `@nubisco/bim/history`.
   2. Millimetres everywhere (shipped). Decided by Jose on 2026-11-23: the
      editor keeps drawing version 1's shapes (rectangles, walls along room
      edges) first, with every value exact to the millimetre, and real wall
      elements follow in step 3. Snapping is chosen in the status strip
      (0.5 m, 10 cm, 1 cm, off) and saved as the plan's `snap`. The editor
      saves version 2, converting in the browser against the stored plan.
      Shapes are no longer walked cell by cell: `Grid` in
      `@nubisco/bim/cells` cuts the plane at every corner, so the same
      algorithms work on any measurements, and the UI's walls are stretches
      along a line (`Walls` in `house/geometry.ts`). The live view and 3D
      draw the exact values too.
   3. Walls as walls. Decided by Jose on 2026-11-23 to start with selectable
      walls on the current editor (shipped): tap a wall with Select to set
      its thickness and height, walls drawn as thick as they are built, and
      a room's width and depth typed in. Walls still follow room edges, so
      the editor keeps what is set on one in the floor's `walls` (version 1,
      by where the wall is), and the saved plan's wall that overlaps it most
      takes it. Next, the Wall tool (shipped): walls drawn on their own, a
      garden wall, a partition, a fence, at any angle, with their own
      thickness and height. A version 1 floor carries them as `drawnWalls`,
      and the plan's walls that follow no room edge come back as them. It
      holds doors, windows and radiators at any angle, which move with it.
      Then rooms of any shape (shipped). Decided by Jose on 2026-11-23: any
      polygon. With a room tool, a drag still draws a rectangle, and taps put
      down corners one by one (tap the first again, or Enter, to close).
      Corners are dragged afterwards. A version 1 room carries them as
      `outline`, the rectangle being the box around it. Walls are now found
      from room edges rather than cells (`@nubisco/bim/edges`), so slanted
      edges are walls too, settable like any other, and since 2026-11-24
      they take doors, windows and radiators (see "Doors on slanted walls"
      below). A space
      that is not a rectangle and has no rectangles hint comes back as a
      room drawn corner by corner.
   4. The ruler, and resizing the plan to match it (see house-ui.md),
      shipped. Dimension lines are kept on their storey as `dimensions`
      (version 2, optional, ends in millimetres) and on a version 1 floor
      the same way, in cells. They are notes on the drawing, not part of
      the building, so IFC export leaves them out. Their ends catch on
      corners, wall ends and the ends of doors, windows and radiators, all
      on wall centre lines, so a length measured inside a room is short by
      half of each wall.
5. **The 3D view in millimetres.** Walls drawn with their real thickness, rooms
   of any shape.
   Started on 2026-11-23 (Jose chose it after stage 4). Walls are solids
   standing on their outline: as thick as they are built and as high as
   their own height (at the drawing's half scale, or no higher than the cut
   with the walls low), so a garden wall stands lower than the house.
   Corners are mitred where two walls meet, at any angle and either
   thickness. A wall between rooms stops at a corner of outside walls, one
   against the side of another reaches into it, and a corner whose other
   wall is a door or window there is closed square. Doors and windows sit in
   the middle of the wall's thickness, with solid wall above and below. The
   2D live plan draws the same outlines, so it shows real thickness too,
   and so does the editor (since 1.44), so its corners close the same way.
   Rooms of any shape already draw, slanted edges included, since stage 4.
6. **IFC import.** Shipped, see "The IFC import". Then, extracting the
   shared package for Keystone (shipped as `@nubisco/bim`).
7. **Doors on slanted walls.** Shipped on 2026-11-24, chosen by Jose after
   the package. Doors, windows, open walls and radiators go in walls at any
   angle, room edges and drawn walls alike.
   - Version 2 always could: an opening is a wall and a distance along it.
     Version 1, which the editor draws, gains `to` on an opening or radiator:
     its far end, the near one being (x, y). It always runs towards +x, and
     its sides are `left` and `right` as version 2 names them (the right of
     a wall running towards +x faces down the plan). Its ends are not whole
     millimetres, so `len` keeps the width exact and the converter finds the
     wall within a millimetre and gives back `at` exactly, turning hinge and
     side round when the wall runs towards -x (`@nubisco/bim` 1.1.0).
   - The editor measures every wall line the same way (`Line` in
     `apps/ui/src/house/geometry.ts`: a point and a unit direction, a place
     on it being its dot product with the direction), so along x or y the
     numbers are what they always were. On a slanted wall a door snaps by
     its distance from the stretch's first end, not to the grid.
   - Turning the 3D view now turns rooms drawn corner by corner, drawn walls,
     wall thicknesses and dimension lines too. Before, only rectangles and
     what sat on walls along x or y turned.
