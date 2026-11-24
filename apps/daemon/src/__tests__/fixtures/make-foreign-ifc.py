"""
Writes foreign-house.ifc: a small house made the way Bonsai (BlenderBIM) and
other IfcOpenShell tools make one, for the IFC import tests. Millimetres,
walls with an Axis and a layered material, spaces drawn to the inside faces
of the walls with a number as Name and the room's name as LongName, and a
door and a window filling openings in the walls. The origin is not at a
corner of the house, so some coordinates are negative.

    python -I make-foreign-ifc.py foreign-house.ifc

Needs IfcOpenShell 0.8 or later. The file is committed, so the tests do not.
"""

import sys

import ifcopenshell
import ifcopenshell.api
import ifcopenshell.util.placement
import numpy as np

out = sys.argv[1]
f = ifcopenshell.file(schema="IFC4")
api = lambda usecase, **kw: ifcopenshell.api.run(usecase, f, **kw)


def place(product, matrix_mm):
    """Place a product by a matrix in millimetres. The api takes metres, and writes the file's millimetres."""
    m = np.array(matrix_mm, dtype=float)
    m[0:3, 3] /= 1000
    api("geometry.edit_object_placement", product=product, matrix=m)


project = api("root.create_entity", ifc_class="IfcProject", name="Foreign house")
api("unit.assign_unit", units=[api("unit.add_si_unit", unit_type="LENGTHUNIT", prefix="MILLI")])
model = api("context.add_context", context_type="Model")
body = api("context.add_context", context_type="Model", context_identifier="Body", target_view="MODEL_VIEW", parent=model)
axis_ctx = api("context.add_context", context_type="Model", context_identifier="Axis", target_view="GRAPH_VIEW", parent=model)

site = api("root.create_entity", ifc_class="IfcSite", name="Site")
building = api("root.create_entity", ifc_class="IfcBuilding", name="House")
api("aggregate.assign_object", products=[site], relating_object=project)
api("aggregate.assign_object", products=[building], relating_object=site)
storeys = []
for name, elevation in (("Ground", 0.0), ("Upper", 3000.0)):
    s = api("root.create_entity", ifc_class="IfcBuildingStorey", name=name)
    s.Elevation = elevation
    place(s, ifcopenshell.util.placement.a2p([0, 0, elevation], [0, 0, 1], [1, 0, 0]))
    api("aggregate.assign_object", products=[s], relating_object=building)
    storeys.append(s)
ground, upper = storeys

layers = {}


def layer_set(t):
    if t not in layers:
        mat = api("material.add_material_set", name=f"Wall {t}", set_type="IfcMaterialLayerSet")
        m = api("material.add_material", name="Brick")
        layer = api("material.add_layer", layer_set=mat, material=m)
        api("material.edit_layer", layer=layer, attributes={"LayerThickness": float(t)})
        layers[t] = mat
    return layers[t]


def wall(storey, a, b, t, h, z=0.0):
    """A wall from a to b (IFC X, Y in mm), its axis on the centre line."""
    w = api("root.create_entity", ifc_class="IfcWall", name="Basic wall")
    a = np.array(a, dtype=float)
    b = np.array(b, dtype=float)
    d = (b - a) / np.linalg.norm(b - a)
    length = float(np.linalg.norm(b - a))
    place(w, ifcopenshell.util.placement.a2p([a[0], a[1], z], [0, 0, 1], [d[0], d[1], 0]))
    # The body: a rectangle from the axis start, centred across it, and the axis itself.
    rep = api("geometry.add_wall_representation", context=body, length=length / 1000, height=h / 1000, thickness=t / 1000, offset=-t / 2000)
    api("geometry.assign_representation", product=w, representation=rep)
    ax = api("geometry.add_axis_representation", context=axis_ctx, axis=[(0.0, 0.0), (length / 1000, 0.0)])
    api("geometry.assign_representation", product=w, representation=ax)
    api("material.assign_material", products=[w], type="IfcMaterialLayerSetUsage", material=layer_set(t))
    api("spatial.assign_container", products=[w], relating_structure=storey)
    return w


def space(storey, number, name, pts, h=2600.0):
    s = api("root.create_entity", ifc_class="IfcSpace", name=number)
    s.LongName = name
    s.PredefinedType = "INTERNAL"
    place(s, ifcopenshell.util.placement.a2p([0, 0, storey.Elevation], [0, 0, 1], [1, 0, 0]))
    curve = f.createIfcPolyline([f.createIfcCartesianPoint((float(x), float(y))) for x, y in pts + [pts[0]]])
    profile = f.createIfcArbitraryClosedProfileDef("AREA", None, curve)
    solid = f.createIfcExtrudedAreaSolid(profile, f.createIfcAxis2Placement3D(f.createIfcCartesianPoint((0.0, 0.0, 0.0))), f.createIfcDirection((0.0, 0.0, 1.0)), h)
    rep = f.createIfcShapeRepresentation(body, "Body", "SweptSolid", [solid])
    s.Representation = f.createIfcProductDefinitionShape(None, None, [rep])
    api("aggregate.assign_object", products=[s], relating_object=storey)
    return s


def fill(w, cls, at, width, sill, height, t, operation):
    """A door or window `at` mm along wall w from its start, through an opening."""
    o = api("root.create_entity", ifc_class="IfcOpeningElement", name="Opening")
    m = ifcopenshell.util.placement.get_local_placement(w.ObjectPlacement)
    place(o, m @ ifcopenshell.util.placement.a2p([at, -t / 2 - 50, sill], [0, 0, 1], [1, 0, 0]))
    profile = f.createIfcRectangleProfileDef("AREA", None, f.createIfcAxis2Placement2D(f.createIfcCartesianPoint((width / 2, (t + 100) / 2))), width, t + 100)
    solid = f.createIfcExtrudedAreaSolid(profile, f.createIfcAxis2Placement3D(f.createIfcCartesianPoint((0.0, 0.0, 0.0))), f.createIfcDirection((0.0, 0.0, 1.0)), height)
    o.Representation = f.createIfcProductDefinitionShape(None, None, [f.createIfcShapeRepresentation(body, "Body", "SweptSolid", [solid])])
    api("feature.add_feature", feature=o, element=w)
    e = api("root.create_entity", ifc_class=cls, name=cls[3:])
    e.OverallWidth = float(width)
    e.OverallHeight = float(height)
    e.PredefinedType = "DOOR" if cls == "IfcDoor" else "WINDOW"
    if cls == "IfcDoor":
        e.OperationType = operation
    else:
        e.PartitioningType = operation
    place(e, m @ ifcopenshell.util.placement.a2p([at, 0, sill], [0, 0, 1], [1, 0, 0]))
    api("spatial.assign_container", products=[e], relating_structure=ifcopenshell.util.element.get_container(w))
    api("feature.add_filling", opening=o, element=e)
    return e


import ifcopenshell.util.element  # noqa: E402

# Ground: an outside wall 300 thick round 8 m by 5 m (centre lines), the
# origin 2 m in from the left and 1 m down from the top, so x runs from -2000.
# IFC Y is north, up the plan.
x0, x1, y0, y1 = -2000.0, 6000.0, 1000.0, -4000.0
outer = [
    wall(ground, (x0, y0), (x1, y0), 300, 2700),
    wall(ground, (x1, y0), (x1, y1), 300, 2700),
    wall(ground, (x1, y1), (x0, y1), 300, 2700),
    wall(ground, (x0, y1), (x0, y0), 300, 2700),
]
# A partition 100 thick at x = 2000 between the two rooms.
part = wall(ground, (2000.0, y0), (2000.0, y1), 100, 2700)
# A garden wall, not round any room.
wall(ground, (x0, -7000.0), (x1, -7000.0), 200, 1200)

# Spaces to the inside faces: outer walls 150 in, the partition 50.
space(ground, "001", "Living room", [(x0 + 150, y0 - 150), (2000 - 50, y0 - 150), (2000 - 50, y1 + 150), (x0 + 150, y1 + 150)])
space(ground, "002", "Kitchen", [(2000 + 50, y0 - 150), (x1 - 150, y0 - 150), (x1 - 150, y1 + 150), (2000 + 50, y1 + 150)])

fill(outer[2], "IfcDoor", 1000.0, 900.0, 0.0, 2100.0, 300, "SINGLE_SWING_LEFT")
fill(outer[0], "IfcWindow", 1500.0, 1200.0, 900.0, 1200.0, 300, "SINGLE_PANEL")
fill(part, "IfcDoor", 2000.0, 800.0, 0.0, 2000.0, 100, "SINGLE_SWING_RIGHT")

# Upper: one room over the left half.
up = [
    wall(upper, (x0, y0), (2000.0, y0), 250, 2500),
    wall(upper, (2000.0, y0), (2000.0, y1), 250, 2500),
    wall(upper, (2000.0, y1), (x0, y1), 250, 2500),
    wall(upper, (x0, y1), (x0, y0), 250, 2500),
]
space(upper, "101", "Bedroom", [(x0 + 125, y0 - 125), (2000 - 125, y0 - 125), (2000 - 125, y1 + 125), (x0 + 125, y1 + 125)])

bed = api("root.create_entity", ifc_class="IfcFurniture", name="Double bed")
bed.PredefinedType = "BED"
place(bed, ifcopenshell.util.placement.a2p([-1000.0, -1000.0, 3000.0], [0, 0, 1], [1, 0, 0]))
profile = f.createIfcRectangleProfileDef("AREA", None, f.createIfcAxis2Placement2D(f.createIfcCartesianPoint((800.0, -1000.0))), 1600.0, 2000.0)
solid = f.createIfcExtrudedAreaSolid(profile, f.createIfcAxis2Placement3D(f.createIfcCartesianPoint((0.0, 0.0, 0.0))), f.createIfcDirection((0.0, 0.0, 1.0)), 500.0)
bed.Representation = f.createIfcProductDefinitionShape(None, None, [f.createIfcShapeRepresentation(body, "Body", "SweptSolid", [solid])])
api("spatial.assign_container", products=[bed], relating_structure=upper)

f.write(out)
print("wrote", out, len(f.by_type("IfcProduct")), "products")
