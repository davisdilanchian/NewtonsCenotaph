"""
Export the monument and its 2,139 cypresses to glTF binary (model/newtons_cenotaph.glb).
Landscape, woodland and cameras are left out to keep the file light.
Procedural shaders do not survive glTF; materials export as their base values.

  Blender -b model/newtons_cenotaph.blend -P scripts/export_glb.py
"""
import bpy, os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
keep = {"Cenotaph", "Figures and ornaments"}
bpy.ops.object.select_all(action="DESELECT")
n = 0
for ob in bpy.context.scene.objects:
    names = {c.name for c in ob.users_collection}
    if ob.type == "MESH" and (names & keep or any(x.startswith("Row ") for x in names)):
        if ob.name in ("Smoke column",):
            continue
        ob.select_set(True); n += 1
out = os.path.join(ROOT, "model", "newtons_cenotaph.glb")
bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=True, export_apply=False,   # keep tree meshes shared
                          export_yup=True, export_cameras=False, export_lights=False)
print("EXPORTED", n, "objects ->", out, os.path.getsize(out) // 1024, "KB")
