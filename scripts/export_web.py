"""
Light assets for the walkable web page (web/public/assets).

  Blender -b model/newtons_cenotaph.blend -P scripts/export_web.py

Writes monument.glb (Draco-compressed, no trees) and trees.bin. The page draws the
trees itself as instanced low-poly cypresses, using the exact positions from the
model. COL_* meshes are invisible walking surfaces that replace the stairs: each
real step is 0.5 m, too tall for a smooth walk.
"""
import bpy, bmesh, os, sys, math, struct

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import build_scene as B

OUT = os.path.join(ROOT, "web", "public", "assets")
os.makedirs(OUT, exist_ok=True)
D = B.D
sc = bpy.context.scene
col = bpy.data.collections["Cenotaph"]


def ramp_mesh(name, quads):
    """Open sheet of quads, each four (x, y, z) corners."""
    bm = bmesh.new()
    for q in quads:
        bm.faces.new([bm.verts.new(p) for p in q])
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.001)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me); col.objects.link(ob)
    return ob


# main stair
sh, top = D["stair_half_w"], D["platform_top"]
y_low, y_high = -D["platform_R"] - 0.5, D["stair_inner_y"] - 1.6
cols = [ramp_mesh("COL_main_stair", [[(-sh, y_low - 0.6, 0), (sh, y_low - 0.6, 0), (sh, y_high, top), (-sh, y_high, top)],
                                     [(-sh, y_high, top), (sh, y_high, top), (sh, D["stair_inner_y"] + 0.5, top), (-sh, D["stair_inner_y"] + 0.5, top)]])]

# front stair block: one solid slope per flank, wall to front face
vb, vt, yf, yb = D["v_bottom_half"], D["v_top_half"], D["stair_block_y"], D["stair_block_back"]
z0, z1 = D["drum_top"] - 0.1, D["tier_top"]
corners = lambda y: [(-vb, y, z0), (vb, y, z0), (vt, y, z1), (-vt, y, z1)]
f, b = corners(yf), corners(yb)
cols.append(ramp_mesh("COL_front_stair_block", [f, [f[0], f[3], b[3], b[0]], [f[1], b[1], b[2], f[2]], [f[3], f[2], b[2], b[3]]]))

# steer walkers out from under the tier cornice near the top of each flight
for s_ in (-1, 1):
    cols.append(ramp_mesh(f"COL_cornice_guide_{'L' if s_ < 0 else 'R'}",
                          [[(s_ * 30, -76.0, 49), (s_ * 10.3, -84.6, 49), (s_ * 10.3, -84.6, 67), (s_ * 30, -76.0, 67)]]))

# dais stair
y0, y1 = B.DAIS_STAIR_Y, B.DAIS_STAIR_Y + B.DAIS_STEPS * B.DAIS_TREAD
z1 = top + B.DAIS_STEPS * B.DAIS_RISE
cols.append(ramp_mesh("COL_dais_stair", [[(-3.5, y0, top), (3.5, y0, top), (3.5, y1, z1), (-3.5, y1, z1)],
                                         [(-3.5, y1, z1), (3.5, y1, z1), (3.5, -5.0, z1), (-3.5, -5.0, z1)]]))

# what the page draws
extra = ["Lions", "Funeral brazier", "Esplanade and walks", "Basin coping"]
bpy.ops.object.select_all(action="DESELECT")
keep = [o for o in col.objects if o.type == "MESH"] + [bpy.data.objects[n] for n in extra]
for ob in keep:
    if not ob.name.startswith("COL_"):
        ob.data.shade_smooth()
        ob.data.set_sharp_from_angle(angle=math.radians(35))
    ob.select_set(True)
bpy.context.view_layer.objects.active = keep[0]
path = os.path.join(OUT, "monument.glb")
bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_apply=False, export_yup=True,
                          export_cameras=False, export_lights=False, export_texcoords=False,
                          export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6,
                          export_draco_position_quantization=15, export_draco_normal_quantization=10)
print("MONUMENT", len(keep), "objects", os.path.getsize(path) // 1024, "KB")

# tree and woodland positions, in the page's axes (x, up, -y)
def rows():
    for c in bpy.data.collections:
        if c.name.startswith("Row ") or c.name == "Basin allée cypresses":
            yield c
trees = [o for c in rows() for o in c.objects]
wood = list(bpy.data.collections["Distant woodland"].objects)[::3]
with open(os.path.join(OUT, "trees.bin"), "wb") as f:
    f.write(struct.pack("<II", len(trees), len(wood)))
    for o in trees:
        x, y, z = o.location
        f.write(struct.pack("<6f", x, z, -y, o.rotation_euler.z, o.scale.x, o.scale.z))
    for o in wood:
        x, y, z = o.location
        f.write(struct.pack("<4f", x, z, -y, o.scale.x))
print("TREES", len(trees), "WOOD", len(wood))
