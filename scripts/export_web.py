"""
Light assets for the walkable web page (web/public/assets).

  Blender -b model/newtons_cenotaph.blend -P scripts/export_web.py

Writes monument.glb (Draco-compressed, no trees) and trees.bin. The page draws the
trees itself as instanced low-poly cypresses, using the exact positions from the
model. COL_* meshes are invisible walking surfaces that replace the stairs: each
real step is 0.5 m, too tall for a smooth walk.
"""
import bpy, bmesh, os, sys, math, struct
import numpy as np
from mathutils import Vector

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

# sky light, path traced into the vertices: the page adds only the moving sun on top of it
sc.render.engine = "CYCLES"
prefs = bpy.context.preferences.addons["cycles"].preferences
prefs.compute_device_type = "METAL"; prefs.get_devices()
for d in prefs.devices:
    d.use = True
sc.cycles.device = "GPU"
sc.cycles.samples = 128
sc.cycles.max_bounces = 6; sc.cycles.diffuse_bounces = 5
for o in sc.objects:
    if o.type == "LIGHT":
        o.hide_render = True
for n in sc.world.node_tree.nodes:
    if n.type == "TEX_SKY":
        n.sun_disc = False
targets = [o for o in keep if not o.name.startswith("COL_")]
# the oil lamps in the passages are real lights in the bake
lamps = []
for i, p_ in enumerate(B.passage_lamps()):
    data = bpy.data.lights.new(f"lamp{i}", "POINT")
    data.energy = 26; data.color = (1.0, 0.62, 0.3); data.shadow_soft_size = 0.12
    ob = bpy.data.objects.new(f"lamp{i}", data); ob.location = p_
    sc.collection.objects.link(ob); lamps.append(ob)
for ob in targets:
    ob.data.color_attributes.new("Baked", "FLOAT_COLOR", "POINT")
    ob.data.color_attributes.active_color_name = "Baked"
    ob.data.attributes.render_color_index = ob.data.color_attributes.find("Baked")
for ob in keep:
    if ob.name.startswith("COL_"):
        ob.select_set(False)
        ob.hide_render = True
bpy.context.view_layer.objects.active = targets[0]
bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT"}, target="VERTEX_COLORS", margin=0)

# sunlight thrown back up off the ground and terraces, baked from a midday sun: the page draws
# the direct sun itself, so only the bounce is kept
for ob in targets:
    ob.data.color_attributes.new("Bounce", "FLOAT_COLOR", "POINT")
    ob.data.color_attributes.active_color_name = "Bounce"
    ob.data.attributes.render_color_index = ob.data.color_attributes.find("Bounce")
sky = next(n for n in sc.world.node_tree.nodes if n.type == "BACKGROUND").inputs[1]
sky.default_value = 0.0
for o in lamps:
    o.hide_render = True
for o in sc.objects:
    if o.type == "LIGHT" and o not in lamps:
        o.hide_render = False
        o.rotation_euler = Vector((0.05, -0.36, 0.93)).to_track_quat("Z", "Y").to_euler()
sc.cycles.samples = 64
bpy.ops.object.bake(type="DIFFUSE", pass_filter={"INDIRECT"}, target="VERTEX_COLORS", margin=0)

# add them, and take the last of the sampling noise out along the mesh edges
for ob in targets:
    me = ob.data
    n = len(me.vertices)
    edges = np.zeros(len(me.edges) * 2, np.int32); me.edges.foreach_get("vertices", edges); edges = edges.reshape(-1, 2)
    a_, b_ = np.zeros(n * 4, np.float32), np.zeros(n * 4, np.float32)
    me.color_attributes["Baked"].data.foreach_get("color", a_); me.color_attributes["Bounce"].data.foreach_get("color", b_)
    c = (a_ + b_).reshape(-1, 4)
    for _ in range(3):
        total, weight = c.copy(), np.ones(n, np.float32)
        np.add.at(total, edges[:, 0], c[edges[:, 1]]); np.add.at(total, edges[:, 1], c[edges[:, 0]])
        np.add.at(weight, edges[:, 0], 1); np.add.at(weight, edges[:, 1], 1)
        c = total / weight[:, None]
    me.color_attributes["Baked"].data.foreach_set("color", c.ravel())
    me.color_attributes.remove(me.color_attributes["Bounce"])
    me.color_attributes.active_color_name = "Baked"
for ob in keep:
    ob.select_set(True)
print("BAKED", len(targets))

path = os.path.join(OUT, "monument.glb")
bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_apply=False, export_yup=True,
                          export_cameras=False, export_lights=False, export_texcoords=False,
                          export_vertex_color="ACTIVE", export_active_vertex_color_when_no_material=True,
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

# the vault's openings, for the sunlight that falls through them
holes = B.star_holes()
with open(os.path.join(OUT, "holes.bin"), "wb") as f:
    f.write(struct.pack("<I", len(holes)))
    for d, r in holes:
        f.write(struct.pack("<4f", d.x, d.z, -d.y, r))
print("HOLES", len(holes))
with open(os.path.join(OUT, "lamps.bin"), "wb") as f:
    spots = B.passage_lamps()
    f.write(struct.pack("<I", len(spots)))
    for x, y, z in spots:
        f.write(struct.pack("<3f", x, z, -y))
print("LAMPS", len(spots))
