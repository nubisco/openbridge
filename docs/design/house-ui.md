# The House page layout

Status: agreed direction. Decided by Jose on 2026-11-21, after a layout study
modelled on Live Home 3D. Icons for every element are in
[house-icons.md](house-icons.md).

## The frame

The app's rail on the left, the top bar and the shell's inspector on the right
are given. The canvas fills everything else, in view and in edit mode, and
controls float over it:

- Drawing tools at the top of the canvas, grouped: pointer (Select, Pan,
  Ruler), build (Wall, Area, Door, Window, Gap, later Stairs), fit out
  (Radiator, Furniture), history (Undo, Redo).
- The floor menu on the left edge, the same in both modes. Editing adds a +
  button and a menu to rename or delete a floor (shipped in 1.30.x, PR #46).
- View controls bottom right: zoom, fit, turn, 2D or 3D, and one "Show" menu
  for devices, temperature, humidity, room names and walls up or low.
- A status strip along the bottom while editing: what the tool does, where
  the pointer is in metres, and the snapping step (shipped in stage 4).

## The inspector while editing

Resizable from its left edge (PR #46). It has:

- **A permanent 3D preview** at the top, of the floor being edited, updating
  as you draw. Not a side by side split of the canvas.
- Three tabs below it: **Properties** (the selection, or the floor when nothing
  is selected), **Library** (door and window presets, furniture, devices not
  on the plan yet, all draggable onto the canvas), **House** (an outline of
  floors, rooms and what is in each).

Shipped in stage 2: the preview is `HouseStage` in its preview mode, handed a
copy of the draft a moment after each change (not on a phone, where the
blueprint is the only room there is). The Library is
`components/house/HouseLibrary.vue`: tap an item and the next tap on the plan
puts it down, or drag it there. Picking the Door, Window or Furniture tool
opens the Library, and something put down from it opens Properties. The House
tab is `components/house/HouseOutline.vue`, and picking a row selects it on
the plan without leaving the outline.

## Doors and windows

Shipped first (stage 2, `apps/ui/src/house/openings.ts`): one Door tool and
one Window tool, and a door and window panel with the Coverings section. Their
presets moved from the toolbar to the Library tab when it shipped. Every covering is
drawn by its kind on its own side of the glass (`apps/ui/src/house/coverings.ts`
works out which side is inside): a box and slats for what rolls, curtains in
folds, an awning's canvas. A covering a device drives is drawn as the device
reports it, one worked by hand is drawn open.

Doors, windows, open walls and radiators go in any wall, at any angle (since
2026-11-24). On a slanted wall the panel says the hinge is at the left or right
end and the door opens up or down the plan, as a wall running left to right
has its sides.

One Door tool and one Window tool. Presets in the Library: wooden door (white),
wooden door (brown), glazed swing door, sliding glass door, sliding window,
full height fixed window, casement window. Anything glazed gets a Coverings
section in Properties: kind, inside or outside, manual or the device that
drives it. Coverings are a requirement of the model, not an option of a door.

## The ruler

Pick Ruler, drag from one point to another. It snaps to wall ends, corners and
openings and stays on the plan as a dimension line. Typing a different length
in Properties offers "Resize the plan to match", with the factor shown. It
multiplies every horizontal position and length, walls, rooms, openings,
radiators, furniture and devices, as one undo step. Heights do not change.
The confirm step has "Keep door, window and furniture sizes", which moves them
without resizing. It ships with the editor in millimetres (stage 4), because
the 0.5 m grid would round the result.

Shipped in stage 4. The resize is about the plot's corner, on every floor,
and the plot grows with it. Wall thicknesses stay, as heights do. "Keep
sizes" also keeps radiators and gates, and a door or radiator that would no
longer fit its wall at its old size is scaled after all. The Ruler sits next
to Select, and Select picks a dimension line too.
