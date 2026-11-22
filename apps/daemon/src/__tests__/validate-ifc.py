"""Validate an IFC file with IfcOpenShell: the schema, its rules, and every shape.

Used by the IFC export's tests (house-ifc.test.ts, beside it) when
IFC_PYTHON names a Python with ifcopenshell (and pytest, which its rule
checker needs). Prints one JSON object and exits 1 when anything is wrong.

    python validate-ifc.py house.ifc
"""

import json
import sys

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.validate

path = sys.argv[1]
log = ifcopenshell.validate.json_logger()
ifcopenshell.validate.validate(path, log, express_rules=True)
issues = [str(s)[:400] for s in log.statements]

model = ifcopenshell.open(path)
settings = ifcopenshell.geom.settings()
shapes = 0
for product in model.by_type("IfcProduct"):
    if not product.Representation:
        continue
    shapes += 1
    try:
        ifcopenshell.geom.create_shape(settings, product)
    except Exception as e:  # noqa: BLE001 - any failure is a finding
        issues.append(f"{product.is_a()} {product.GlobalId}: no shape ({e})"[:400])

counts = {}
for product in model.by_type("IfcProduct"):
    counts[product.is_a()] = counts.get(product.is_a(), 0) + 1

print(json.dumps({"issues": issues, "shapes": shapes, "counts": counts}))
sys.exit(1 if issues else 0)
