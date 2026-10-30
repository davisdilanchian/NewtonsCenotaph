"""
Newton's Cenotaph (Étienne-Louis Boullée, 1784) - to-scale Blender model.

Run:
  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
      -P scripts/build_scene.py

Units: metres. Origin: sphere axis at natural ground level (z = 0).
Front of the monument (main stair, entrance tunnel) faces -Y.
All dimensions come from the BnF drawings (plan, elevation, section),
scaled so the sphere is 150 m in diameter. See docs/README.md.
"""
import bpy, bmesh, math, random, json, os, mathutils
from mathutils import Vector, Matrix

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
random.seed(1784)

# ---------------------------------------------------------------- dimensions
D = dict(
    sphere_R=75.0,            # outer radius of the sphere (Ø150 m)
    shell_inner_R=67.0,       # inner radius (section drawing: shell ≈ 8 m)
    sphere_cz=73.5,           # centre height above natural ground
    platform_R=157.5, platform_top=5.5,
    drum_R=118.9, drum_wall_top=43.0, drum_frieze_R=119.3,
    drum_dentil_R=120.2, drum_corona_R=121.0, drum_top=46.5,
    tier_R=82.0, tier_wall_top=62.6, tier_cornice_R=83.2, tier_top=64.0,
    stair_half_w=21.0, stair_inner_y=-139.0, stair_rise=0.06, stair_steps=92,
    tunnel_half_w=7.0, tunnel_spring=6.5,      # the arch at the sphere's foot, now a sealed door
    passage_half_w=2.2, passage_h=3.9, passage_z=0.06,   # section: 3.9 high, at terrace depth
    floor_top=9.5,                              # the flat floor round the sarcophagus
    people_scale=3.0,                           # figures drawn this much smaller, so the site reads 450 m
    v_bottom_half=39.5, v_top_half=10.3,        # front stair block: half-widths, base and top
    stair_block_y=-87.0, stair_block_back=-70.0,  # its front face, and its back, buried in the shell
    cone_r_back=72.0, cone_r_front=80.0,        # drum front cut (cone on Y axis)
    tree_spacing_note="about 3 m along each row, rows paired and staggered",
)
# Ten rows of cypress, measured from the plan (radius m, angular pitch rad,
# half-angle of the front gap in degrees, ground z, phase offset).
ROWS = []
def _band(r1, r2, pitch, gap, z):
    ROWS.append(dict(r=r1, pitch=pitch, gap=gap, z=z, phase=0.0))
    ROWS.append(dict(r=r2, pitch=pitch, gap=gap, z=z, phase=0.5))
_band(78.6, 80.9, 0.0405, None, D["tier_top"])           # upper tier
_band(101.2, 103.5, 0.0276, 23.0, D["drum_top"])         # drum, inner band
_band(108.7, 111.4, 0.0279, 23.0, D["drum_top"])         # drum, outer band
_band(139.2, 141.8, 0.0207, 24.0, D["platform_top"])     # ground terrace, inner
_band(147.0, 149.7, 0.0207, 24.0, D["platform_top"])     # ground terrace, outer

# ------------------------------------------------------------------- helpers
def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)

def coll(name, parent=None):
    c = bpy.data.collections.new(name)
    (parent or bpy.context.scene.collection).children.link(c)
    return c

def link(obj, c):
    for uc in obj.users_collection:
        uc.objects.unlink(obj)
    c.objects.link(obj)
    return obj

def mesh_obj(name, bm, c, mat=None, smooth=False):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me); bm.free()
    if smooth:
        me.shade_smooth()
    ob = bpy.data.objects.new(name, me)
    c.objects.link(ob)
    if mat:
        me.materials.append(mat)
    return ob

def annulus(r_in, r_out, z0, z1, seg=360):
    """Closed ring solid. r_in = 0 gives a solid disc."""
    bm = bmesh.new()
    def circ(r, z):
        if r <= 0:
            return [bm.verts.new((0, 0, z))]
        return [bm.verts.new((r * math.cos(2 * math.pi * i / seg),
                              r * math.sin(2 * math.pi * i / seg), z)) for i in range(seg)]
    if r_in <= 0:
        ob, ot = circ(r_out, z0), circ(r_out, z1)
        bm.faces.new(list(reversed(ob))); bm.faces.new(ot)
        for i in range(seg):
            j = (i + 1) % seg
            bm.faces.new((ob[i], ob[j], ot[j], ot[i]))
    else:
        ob, ot, ib, it = circ(r_out, z0), circ(r_out, z1), circ(r_in, z0), circ(r_in, z1)
        for i in range(seg):
            j = (i + 1) % seg
            bm.faces.new((ob[i], ob[j], ot[j], ot[i]))      # outer wall
            bm.faces.new((ib[j], ib[i], it[i], it[j]))      # inner wall
            bm.faces.new((ot[i], ot[j], it[j], it[i]))      # top
            bm.faces.new((ob[j], ob[i], ib[i], ib[j]))      # bottom
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm

def box(x0, x1, y0, y1, z0, z1, bm=None):
    bm = bm or bmesh.new()
    v = [bm.verts.new(p) for p in [(x0,y0,z0),(x1,y0,z0),(x1,y1,z0),(x0,y1,z0),
                                   (x0,y0,z1),(x1,y0,z1),(x1,y1,z1),(x0,y1,z1)]]
    for f in [(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)]:
        bm.faces.new([v[i] for i in f])
    return bm

def prism_y(profile, y0, y1):
    """Closed solid: an (x, z) polygon extruded along Y."""
    bm = bmesh.new()
    f = [bm.verts.new((x, y1, z)) for x, z in profile]
    bk = [bm.verts.new((x, y0, z)) for x, z in profile]
    bm.faces.new(f); bm.faces.new(list(reversed(bk)))
    n = len(profile)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((f[i], bk[i], bk[j], f[j]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm

def passage(points):
    """Closed arched passage through (x, y, floor z) points, its sides square to the first leg."""
    a, b = Vector(points[0][:2]), Vector(points[-1][:2])
    side = Vector((-(b - a).y, (b - a).x)).normalized()
    w, h = D["passage_half_w"], D["passage_h"]
    spring = h - w * 0.55
    profile = [(-w, 0), (w, 0)] + [(w * math.cos(math.pi * k / 16), spring + w * 0.55 * math.sin(math.pi * k / 16)) for k in range(17)]
    bm = bmesh.new()
    rings = [[bm.verts.new((x + side.x * u, y + side.y * u, z + v)) for u, v in profile] for x, y, z in points]
    bm.faces.new(rings[0]); bm.faces.new(list(reversed(rings[-1])))
    n = len(profile)
    for r0, r1 in zip(rings, rings[1:]):
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((r0[i], r1[i], r1[j], r0[j]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm

def passages():
    """Two doors in the terrace wall, either side of the main stair, meeting under the sphere,
    then Boullée's ramp up through the floor to the sarcophagus. The section's slope is about 23°."""
    z = D["passage_z"]
    door_x, door_y = 30.0, -math.sqrt(D["platform_R"] ** 2 - 30.0 ** 2)
    end = (0.0, -34.0)
    legs = []
    for s in (-1, 1):
        run = Vector((end[0] - s * door_x, end[1] - door_y)).normalized()
        legs.append([(s * door_x - run.x * 3, door_y - run.y * 3, z), (end[0] + run.x * 2, end[1] + run.y * 2, z)])
    legs.append([(0, -38.0, z), (0, -26.0, z), (0, -5.0, D["floor_top"])])
    return legs

def star_holes():
    """The vault's openings as (direction, inner radius). Only where the shell stands clear of the
    upper tier does daylight reach them."""
    rnd = random.Random(1784)
    band = Vector((0.35, 0.55, 0.76)).normalized()
    moon = Vector((-0.45, 0.35, 0.82)).normalized()
    holes, tries = [(moon, 1.9)], 0
    while len(holes) < 2200 and tries < 400000:
        tries += 1
        v = Vector((rnd.uniform(-1, 1), rnd.uniform(-1, 1), rnd.uniform(-1, 1)))
        if not 0.01 < v.length_squared < 1:
            continue
        v.normalize()
        in_band = abs(v.dot(band)) < 0.11
        if v.z < -0.08 or rnd.random() > (1.0 if in_band else 0.22):
            continue
        r = 0.18 + 0.36 * rnd.random() ** 4
        if all(v.dot(d) < math.cos((2.3 * (r + q) + 0.3) / 67.0) for d, q in holes):
            holes.append((v, r))
    return holes

def hole_cutter():
    """Bores aimed at the sarcophagus and flaring inward, so the sky stays in view across the floor.
    A shell 8 m thick shows it through a radial hole only from the centre of the void."""
    bm = bmesh.new()
    eye = Vector((0, 0, D["floor_top"] + 0.6))
    for d, r in star_holes():
        q = Vector((0, 0, D["sphere_cz"])) + d * D["shell_inner_R"]
        axis = (q - eye).normalized()
        m = Matrix.Translation(q + axis * 6.0) @ Vector((0, 0, 1)).rotation_difference(axis).to_matrix().to_4x4()
        bmesh.ops.create_cone(bm, cap_ends=True, segments=10, radius1=r * 2.35, radius2=r * 0.3, depth=14.0, matrix=m)
    return bm

def uv_sphere(R, cz, seg=256, rings=128, bm=None):
    bm = bm or bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=R,
                              matrix=Matrix.Translation((0, 0, cz)))
    return bm

def boolean(target, cutter, op="DIFFERENCE", solver="EXACT"):
    m = target.modifiers.new("bool", "BOOLEAN")
    m.operation = op
    m.object = cutter
    try:
        m.solver = solver
    except TypeError:
        m.solver = "MANIFOLD"
    bpy.context.view_layer.objects.active = target
    with bpy.context.temp_override(object=target, active_object=target):
        bpy.ops.object.modifier_apply(modifier=m.name)

def temp_obj(name, bm):
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob

def kill(ob):
    me = ob.data
    bpy.data.objects.remove(ob, do_unlink=True)
    if me and me.users == 0:
        bpy.data.meshes.remove(me)

# ----------------------------------------------------------------- materials
def node_mat(name):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs[0], out.inputs[0])
    return m, nt, bsdf, out

def inp(node, *names):
    for n in names:
        if n in node.inputs:
            return node.inputs[n]
    raise KeyError(names)

def ramp(nt, stops):
    r = nt.nodes.new("ShaderNodeValToRGB")
    el = r.color_ramp.elements
    el[0].position, el[0].color = stops[0]
    el[1].position, el[1].color = stops[-1]
    for p, c in stops[1:-1]:
        e = el.new(p); e.color = c
    return r

def noise(nt, vec, scale, detail=6, rough=0.55, dim=3):
    n = nt.nodes.new("ShaderNodeTexNoise")
    n.noise_dimensions = f"{dim}D"
    n.inputs["Scale"].default_value = scale
    n.inputs["Detail"].default_value = detail
    n.inputs["Roughness"].default_value = rough
    if vec is not None:
        nt.links.new(vec, n.inputs["Vector"])
    return n

def math_node(nt, op, a=None, b=None, va=0.0, vb=0.0):
    m = nt.nodes.new("ShaderNodeMath"); m.operation = op
    m.inputs[0].default_value = va; m.inputs[1].default_value = vb
    if a is not None: nt.links.new(a, m.inputs[0])
    if b is not None: nt.links.new(b, m.inputs[1])
    return m

def bump(nt, height, strength, distance=0.05):
    b = nt.nodes.new("ShaderNodeBump")
    b.inputs["Strength"].default_value = strength
    b.inputs["Distance"].default_value = distance
    nt.links.new(height, b.inputs["Height"])
    return b

def mix_rgb(nt, fac, a, b, blend="MIX"):
    m = nt.nodes.new("ShaderNodeMix"); m.data_type = "RGBA"; m.blend_type = blend
    fac_s = [s_ for s_ in m.inputs if s_.name == "Factor" and s_.type == "VALUE"][0]
    a_s = [s_ for s_ in m.inputs if s_.name == "A" and s_.type == "RGBA"][0]
    b_s = [s_ for s_ in m.inputs if s_.name == "B" and s_.type == "RGBA"][0]
    if isinstance(fac, float): fac_s.default_value = fac
    else: nt.links.new(fac, fac_s)
    for sock, val in ((a_s, a), (b_s, b)):
        if isinstance(val, tuple): sock.default_value = val
        else: nt.links.new(val, sock)
    return m

# Paris "pierre de taille": Lutetian limestone, warm cream-grey.
LIME_A = (0.50, 0.45, 0.36, 1)
LIME_B = (0.42, 0.38, 0.30, 1)
LIME_C = (0.56, 0.51, 0.42, 1)

def mat_ashlar(name="Limestone ashlar"):
    """Coursed cut-stone masonry, mapped cylindrically so courses wrap the drum."""
    m, nt, bsdf, out = node_mat(name)
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ"); nt.links.new(tc.outputs["Object"], sep.inputs[0])
    ang = math_node(nt, "ARCTAN2", sep.outputs[1], sep.outputs[0])
    rx = math_node(nt, "MULTIPLY", sep.outputs[0], sep.outputs[0])
    ry = math_node(nt, "MULTIPLY", sep.outputs[1], sep.outputs[1])
    rr = math_node(nt, "SQRT", math_node(nt, "ADD", rx.outputs[0], ry.outputs[0]).outputs[0])
    u = math_node(nt, "MULTIPLY", ang.outputs[0], rr.outputs[0])
    # use the larger of (arc length, x) so flat tops still get a pattern
    comb = nt.nodes.new("ShaderNodeCombineXYZ")
    nt.links.new(u.outputs[0], comb.inputs[0]); nt.links.new(sep.outputs[2], comb.inputs[1])
    nt.links.new(rr.outputs[0], comb.inputs[2])
    brick = nt.nodes.new("ShaderNodeTexBrick")
    brick.offset = 0.5; brick.squash = 1.0
    brick.inputs["Scale"].default_value = 1.0
    brick.inputs["Brick Width"].default_value = 2.6      # blocks ≈ 2.6 × 1.3 m
    brick.inputs["Row Height"].default_value = 1.3
    brick.inputs["Mortar Size"].default_value = 0.035
    brick.inputs["Mortar Smooth"].default_value = 0.3
    brick.inputs["Bias"].default_value = 0.0
    brick.inputs["Color1"].default_value = LIME_A
    brick.inputs["Color2"].default_value = LIME_B
    brick.inputs["Mortar"].default_value = (0.42, 0.39, 0.33, 1)
    nt.links.new(comb.outputs[0], brick.inputs["Vector"])
    n1 = noise(nt, tc.outputs["Object"], 0.9, 8, 0.6)
    n2 = noise(nt, tc.outputs["Object"], 14.0, 10, 0.7)
    grime = ramp(nt, [(0.35, (1, 1, 1, 1)), (0.75, (0.72, 0.68, 0.62, 1))])
    nt.links.new(n1.outputs["Fac"], grime.inputs[0])
    col = mix_rgb(nt, 1.0, brick.outputs["Color"], grime.outputs[0], "MULTIPLY")
    nt.links.new(col.outputs[2], inp(bsdf, "Base Color"))
    rough = math_node(nt, "MULTIPLY_ADD", n2.outputs["Fac"], None, 0, 0.25)
    rough.inputs[1].default_value = 0.25; rough.inputs[2].default_value = 0.62
    nt.links.new(rough.outputs[0], inp(bsdf, "Roughness"))
    h = math_node(nt, "ADD", brick.outputs["Fac"], math_node(nt, "MULTIPLY", n2.outputs["Fac"], None, 0, 0.25).outputs[0])
    b = bump(nt, math_node(nt, "SUBTRACT", None, brick.outputs["Fac"], 1.0).outputs[0], 0.6, 0.06)
    b2 = bump(nt, n2.outputs["Fac"], 0.25, 0.02)
    nt.links.new(b2.outputs[0], b.inputs["Normal"])
    nt.links.new(b.outputs[0], inp(bsdf, "Normal"))
    return m

def mat_dressed(name="Limestone dressed", scale=0.35, streak=True):
    """Smooth dressed limestone: sphere, cornices, mouldings."""
    m, nt, bsdf, out = node_mat(name)
    tc = nt.nodes.new("ShaderNodeTexCoord")
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (1, 1, 0.18 if streak else 1)   # vertical rain streaks
    nt.links.new(tc.outputs["Object"], mp.inputs[0])
    n1 = noise(nt, mp.outputs[0], scale, 8, 0.62)
    n2 = noise(nt, tc.outputs["Object"], 3.0, 10, 0.65)
    n3 = noise(nt, tc.outputs["Object"], 40.0, 6, 0.7)
    r = ramp(nt, [(0.30, LIME_C), (0.55, LIME_A), (0.80, (0.47, 0.43, 0.36, 1))])
    nt.links.new(n1.outputs["Fac"], r.inputs[0])
    spec = ramp(nt, [(0.4, (1, 1, 1, 1)), (0.7, (0.9, 0.88, 0.84, 1))])
    nt.links.new(n2.outputs["Fac"], spec.inputs[0])
    col = mix_rgb(nt, 1.0, r.outputs[0], spec.outputs[0], "MULTIPLY")
    nt.links.new(col.outputs[2], inp(bsdf, "Base Color"))
    inp(bsdf, "Roughness").default_value = 0.72
    b = bump(nt, n3.outputs["Fac"], 0.12, 0.02)
    b0 = bump(nt, n2.outputs["Fac"], 0.08, 0.1)
    nt.links.new(b0.outputs[0], b.inputs["Normal"])
    nt.links.new(b.outputs[0], inp(bsdf, "Normal"))
    return m

def mat_paving(name="Limestone paving"):
    m, nt, bsdf, out = node_mat(name)
    tc = nt.nodes.new("ShaderNodeTexCoord")
    brick = nt.nodes.new("ShaderNodeTexBrick")
    brick.offset = 0.5
    brick.inputs["Scale"].default_value = 1.0
    brick.inputs["Brick Width"].default_value = 1.6
    brick.inputs["Row Height"].default_value = 0.8
    brick.inputs["Mortar Size"].default_value = 0.012
    brick.inputs["Color1"].default_value = LIME_C
    brick.inputs["Color2"].default_value = LIME_A
    brick.inputs["Mortar"].default_value = (0.35, 0.33, 0.29, 1)
    nt.links.new(tc.outputs["Object"], brick.inputs["Vector"])
    n = noise(nt, tc.outputs["Object"], 0.15, 6, 0.6)
    g = ramp(nt, [(0.35, (1, 1, 1, 1)), (0.8, (0.78, 0.75, 0.7, 1))])
    nt.links.new(n.outputs["Fac"], g.inputs[0])
    c = mix_rgb(nt, 1.0, brick.outputs["Color"], g.outputs[0], "MULTIPLY")
    nt.links.new(c.outputs[2], inp(bsdf, "Base Color"))
    inp(bsdf, "Roughness").default_value = 0.78
    b = bump(nt, math_node(nt, "SUBTRACT", None, brick.outputs["Fac"], 1.0).outputs[0], 0.4, 0.02)
    nt.links.new(b.outputs[0], inp(bsdf, "Normal"))
    return m

def mat_simple(name, color, rough=0.8, **kw):
    m, nt, bsdf, out = node_mat(name)
    inp(bsdf, "Base Color").default_value = color
    inp(bsdf, "Roughness").default_value = rough
    for k, v in kw.items():
        inp(bsdf, k).default_value = v
    return m

def mat_gravel(name="Gravel (terrace walks)"):
    m, nt, bsdf, out = node_mat(name)
    tc = nt.nodes.new("ShaderNodeTexCoord")
    v = nt.nodes.new("ShaderNodeTexVoronoi"); v.inputs["Scale"].default_value = 28
    nt.links.new(tc.outputs["Object"], v.inputs["Vector"])
    n = noise(nt, tc.outputs["Object"], 0.4, 4, 0.5)
    r = ramp(nt, [(0.0, (0.48, 0.44, 0.37, 1)), (0.5, (0.60, 0.56, 0.48, 1)), (1.0, (0.40, 0.37, 0.32, 1))])
    nt.links.new(v.outputs["Distance"], r.inputs[0])
    g = ramp(nt, [(0.3, (1, 1, 1, 1)), (0.8, (0.8, 0.78, 0.72, 1))])
    nt.links.new(n.outputs["Fac"], g.inputs[0])
    c = mix_rgb(nt, 1.0, r.outputs[0], g.outputs[0], "MULTIPLY")
    nt.links.new(c.outputs[2], inp(bsdf, "Base Color"))
    inp(bsdf, "Roughness").default_value = 0.92
    b = bump(nt, v.outputs["Distance"], 0.5, 0.02)
    nt.links.new(b.outputs[0], inp(bsdf, "Normal"))
    return m

def mat_soil(name="Planting bed (soil, needle litter)"):
    m, nt, bsdf, out = node_mat(name)
    tc = nt.nodes.new("ShaderNodeTexCoord")
    n = noise(nt, tc.outputs["Object"], 2.5, 8, 0.7)
    r = ramp(nt, [(0.3, (0.11, 0.08, 0.05, 1)), (0.7, (0.20, 0.15, 0.09, 1))])
    nt.links.new(n.outputs["Fac"], r.inputs[0])
    nt.links.new(r.outputs[0], inp(bsdf, "Base Color"))
    inp(bsdf, "Roughness").default_value = 0.95
    b = bump(nt, n.outputs["Fac"], 0.6, 0.05)
    nt.links.new(b.outputs[0], inp(bsdf, "Normal"))
    return m

def mat_grass(name="Meadow grass"):
    m, nt, bsdf, out = node_mat(name)
    tc = nt.nodes.new("ShaderNodeTexCoord")
    n1 = noise(nt, tc.outputs["Object"], 0.004, 6, 0.6)
    n2 = noise(nt, tc.outputs["Object"], 0.05, 8, 0.6)
    n3 = noise(nt, tc.outputs["Object"], 3.0, 8, 0.7)
    r = ramp(nt, [(0.25, (0.030, 0.055, 0.014, 1)), (0.5, (0.055, 0.085, 0.022, 1)), (0.75, (0.10, 0.11, 0.04, 1))])
    f = math_node(nt, "ADD", n1.outputs["Fac"], math_node(nt, "MULTIPLY", n2.outputs["Fac"], None, 0, 0.6).outputs[0])
    f2 = math_node(nt, "MULTIPLY", f.outputs[0], None, 0, 0.625)
    nt.links.new(f2.outputs[0], r.inputs[0])
    nt.links.new(r.outputs[0], inp(bsdf, "Base Color"))
    inp(bsdf, "Roughness").default_value = 0.9
    b = bump(nt, n3.outputs["Fac"], 0.5, 0.03)
    nt.links.new(b.outputs[0], inp(bsdf, "Normal"))
    return m

def mat_water(name="Basin water"):
    m, nt, bsdf, out = node_mat(name)
    tc = nt.nodes.new("ShaderNodeTexCoord")
    mp = nt.nodes.new("ShaderNodeMapping"); mp.inputs["Scale"].default_value = (1, 0.35, 1)
    nt.links.new(tc.outputs["Object"], mp.inputs[0])
    n = noise(nt, mp.outputs[0], 1.2, 4, 0.5)
    inp(bsdf, "Base Color").default_value = (0.012, 0.02, 0.022, 1)
    inp(bsdf, "Roughness").default_value = 0.025
    inp(bsdf, "IOR").default_value = 1.333
    b = bump(nt, n.outputs["Fac"], 0.05, 0.05)
    nt.links.new(b.outputs[0], inp(bsdf, "Normal"))
    return m

def mat_cypress(name="Italian cypress foliage", seed=0.0):
    """Cupressus sempervirens 'Stricta': very dark blue-green, dense scale leaves."""
    m, nt, bsdf, out = node_mat(name)
    tc = nt.nodes.new("ShaderNodeTexCoord")
    ao = nt.nodes.new("ShaderNodeAmbientOcclusion"); ao.inputs["Distance"].default_value = 0.6
    n = noise(nt, tc.outputs["Object"], 6.0, 8, 0.7)
    obj_info = nt.nodes.new("ShaderNodeObjectInfo")
    tint = ramp(nt, [(0.0, (0.010, 0.022, 0.012, 1)), (0.5, (0.016, 0.032, 0.016, 1)), (1.0, (0.026, 0.040, 0.018, 1))])
    nt.links.new(obj_info.outputs["Random"], tint.inputs[0])
    shade = ramp(nt, [(0.0, (0.25, 0.25, 0.25, 1)), (1.0, (1, 1, 1, 1))])
    nt.links.new(ao.outputs["AO"], shade.inputs[0])
    tip = ramp(nt, [(0.45, (1, 1, 1, 1)), (0.85, (1.7, 1.8, 1.25, 1))])
    nt.links.new(n.outputs["Fac"], tip.inputs[0])
    c1 = mix_rgb(nt, 1.0, tint.outputs[0], shade.outputs[0], "MULTIPLY")
    c2 = mix_rgb(nt, 1.0, c1.outputs[2], tip.outputs[0], "MULTIPLY")
    nt.links.new(c2.outputs[2], inp(bsdf, "Base Color"))
    inp(bsdf, "Roughness").default_value = 0.9
    try: inp(bsdf, "Specular IOR Level").default_value = 0.25
    except KeyError: pass
    try:
        inp(bsdf, "Subsurface Weight").default_value = 0.08
        inp(bsdf, "Subsurface Radius").default_value = (0.05, 0.12, 0.03)
    except KeyError:
        pass
    b = bump(nt, n.outputs["Fac"], 0.9, 0.08)
    nt.links.new(b.outputs[0], inp(bsdf, "Normal"))
    return m

def mat_bark():
    return mat_simple("Cypress bark", (0.12, 0.07, 0.045, 1), 0.9)

def mat_stars(name="Vault: pierced shell (star holes)"):
    """Inner face of the sphere. Boullée pierced the vault so daylight would
    read as stars; here the holes are emissive points, denser along a Milky Way band."""
    m, nt, bsdf, out = node_mat(name)
    tc = nt.nodes.new("ShaderNodeTexCoord")
    nrm = nt.nodes.new("ShaderNodeVectorMath"); nrm.operation = "NORMALIZE"
    off = nt.nodes.new("ShaderNodeVectorMath"); off.operation = "SUBTRACT"
    off.inputs[1].default_value = (0, 0, D["sphere_cz"])
    nt.links.new(tc.outputs["Object"], off.inputs[0]); nt.links.new(off.outputs[0], nrm.inputs[0])
    def star_layer(scale, size):
        v = nt.nodes.new("ShaderNodeTexVoronoi"); v.inputs["Scale"].default_value = scale
        v.inputs["Randomness"].default_value = 1.0
        nt.links.new(nrm.outputs[0], v.inputs["Vector"])
        lt = math_node(nt, "LESS_THAN", v.outputs["Distance"], None, 0, size)
        return lt, v
    s1, v1 = star_layer(22, 0.06)
    s2, v2 = star_layer(55, 0.05)
    s3, v3 = star_layer(140, 0.09)
    # Milky Way band: tilted great circle
    band = nt.nodes.new("ShaderNodeVectorMath"); band.operation = "DOT_PRODUCT"
    band.inputs[1].default_value = (0.35, 0.55, 0.76)
    nt.links.new(nrm.outputs[0], band.inputs[0])
    absb = math_node(nt, "ABSOLUTE", band.outputs["Value"])
    mw = ramp(nt, [(0.0, (1, 1, 1, 1)), (0.12, (0, 0, 0, 1))])
    nt.links.new(absb.outputs[0], mw.inputs[0])
    nmw = noise(nt, nrm.outputs[0], 6, 6, 0.6)
    mwn = math_node(nt, "MULTIPLY", mw.outputs[0], nmw.outputs["Fac"])
    s3m = math_node(nt, "MULTIPLY", s3.outputs[0], mw.outputs[0])
    tot = math_node(nt, "ADD", math_node(nt, "MULTIPLY", s1.outputs[0], None, 0, 6.0).outputs[0],
                    math_node(nt, "ADD", math_node(nt, "MULTIPLY", s2.outputs[0], None, 0, 2.5).outputs[0],
                              math_node(nt, "ADD", s3m.outputs[0],
                                        math_node(nt, "MULTIPLY", mwn.outputs[0], None, 0, 0.004).outputs[0]).outputs[0]).outputs[0])
    # the moon of Boullée's section: one larger opening
    md = nt.nodes.new("ShaderNodeVectorMath"); md.operation = "DOT_PRODUCT"
    md.inputs[1].default_value = Vector((-0.45, 0.35, 0.82)).normalized()
    nt.links.new(nrm.outputs[0], md.inputs[0])
    moon = math_node(nt, "GREATER_THAN", md.outputs["Value"], None, 0, math.cos(math.radians(1.6)))
    tot = math_node(nt, "ADD", tot.outputs[0], math_node(nt, "MULTIPLY", moon.outputs[0], None, 0, 4.0).outputs[0])
    inp(bsdf, "Base Color").default_value = (0.03, 0.035, 0.05, 1)
    inp(bsdf, "Roughness").default_value = 0.95
    inp(bsdf, "Emission Color").default_value = (0.85, 0.9, 1.0, 1)
    es = math_node(nt, "MULTIPLY", tot.outputs[0], None, 0, 25.0)
    nt.links.new(es.outputs[0], inp(bsdf, "Emission Strength"))
    return m

# ------------------------------------------------------------------- scene
def build():
    reset()
    sc = bpy.context.scene
    sc.unit_settings.system = "METRIC"
    C_MON = coll("Cenotaph")
    C_TREES = coll("Cypresses (Boullée rows)")
    C_SCENE = coll("Landscape")
    C_FIG = coll("Figures and ornaments")
    C_CAM = coll("Cameras and lights")

    M = dict(
        ashlar=mat_ashlar(), dressed=mat_dressed(), sphere=mat_dressed("Limestone sphere", 0.12, True),
        paving=mat_paving(), gravel=mat_gravel(), soil=mat_soil(), grass=mat_grass(),
        water=mat_water(), stars=mat_stars(), bark=mat_bark(),
        dark=mat_simple("Shadowed doorway", (0.01, 0.01, 0.01, 1), 1.0),
        bronze=mat_simple("Bronze", (0.25, 0.14, 0.06, 1), 0.35, **{"Metallic": 1.0}),
        fire=mat_simple("Fire", (1, 0.4, 0.1, 1), 1.0, **{"Emission Color": (1.0, 0.45, 0.12, 1), "Emission Strength": 60.0}),
        cloth=[mat_simple(f"Cloth {i}", c, 0.85) for i, c in enumerate(
            [(0.08, 0.07, 0.06, 1), (0.25, 0.2, 0.14, 1), (0.35, 0.33, 0.3, 1), (0.05, 0.06, 0.1, 1), (0.3, 0.08, 0.05, 1)])],
        skin=mat_simple("Skin", (0.55, 0.38, 0.28, 1), 0.6),
    )
    M["cypress"] = mat_cypress()

    R, CZ = D["sphere_R"], D["sphere_cz"]
    # --- cutters --------------------------------------------------------
    sph71 = temp_obj("cut_sphere71", uv_sphere(71.0, CZ, 192, 96))
    cone_bm = bmesh.new()
    bmesh.ops.create_cone(cone_bm, cap_ends=True, segments=256, radius1=D["cone_r_back"] - 0.5,
                          radius2=D["cone_r_front"] + 1.4, depth=140.0,
                          matrix=Matrix.Translation((0, -65.0, CZ)) @ Matrix.Rotation(math.radians(90), 4, "X"))
    # Note: rotating +90° about X maps cone +Z (radius2 end) to -Y, the front.
    cone = temp_obj("cut_cone", cone_bm)

    # --- platform (ground terrace) ----------------------------------------
    plat = mesh_obj("Ground terrace (platform)", annulus(0, D["platform_R"], 0, D["platform_top"]), C_MON, M["ashlar"])
    plat.data.materials.append(M["paving"])
    sh = D["stair_half_w"]
    recess = temp_obj("cut_recess", box(-sh, sh, -175, D["stair_inner_y"], -1, 7))
    boolean(plat, recess); kill(recess)
    boolean(plat, sph71)
    cutters = [temp_obj(f"cut_passage{i}", passage(leg)) for i, leg in enumerate(passages())]
    for c_ in cutters:
        boolean(plat, c_)
    # assign paving to top faces
    for p in plat.data.polygons:
        if p.normal.z > 0.9: p.material_index = 1
    # main stair
    st = bmesh.new()
    n = D["stair_steps"]; run = (D["stair_inner_y"] - (-D["platform_R"] - 0.5)) / n
    for i in range(n):
        y0 = -D["platform_R"] - 0.5 + i * run
        box(-sh, sh, y0, D["stair_inner_y"] + 0.01, 0, D["stair_rise"] * (i + 1), st)
    stairs = mesh_obj("Main stair", st, C_MON, M["paving"])
    # stair cheek walls
    cw = bmesh.new()
    for s in (-1, 1):
        box(s * sh - (0.9 if s < 0 else 0), s * sh + (0.9 if s > 0 else 0), -D["platform_R"] - 1.0,
            D["stair_inner_y"], 0, D["platform_top"] + 0.9, cw)
    mesh_obj("Stair cheek walls", cw, C_MON, M["dressed"])

    # --- drum -------------------------------------------------------------
    drum = mesh_obj("Drum (main cylinder)", annulus(0, D["drum_R"], D["platform_top"] - 0.5, D["drum_wall_top"]), C_MON, M["ashlar"])
    boolean(drum, sph71)
    boolean(drum, cone)
    # frieze + dentil core + corona (continuous: the 'bridge' across the front opening)
    fr = mesh_obj("Drum frieze", annulus(60, D["drum_frieze_R"], D["drum_wall_top"], 45.4), C_MON, M["dressed"])
    boolean(fr, sph71)
    co = mesh_obj("Drum corona and terrace", annulus(60, D["drum_corona_R"], 45.4, D["drum_top"]), C_MON, M["dressed"])
    co.data.materials.append(M["gravel"])
    boolean(co, sph71)
    for p in co.data.polygons:
        if p.normal.z > 0.9 and p.center.length > 1: p.material_index = 1
    dn = bmesh.new()
    nd = int(2 * math.pi * D["drum_frieze_R"] / 2.2)
    for i in range(nd):
        a = 2 * math.pi * i / nd
        bm1 = box(-0.4, 0.4, -0.45, 0.45, 44.6, 45.4)
        bmesh.ops.transform(bm1, matrix=Matrix.Rotation(a, 4, "Z") @ Matrix.Translation((D["drum_frieze_R"] + 0.45, 0, 0)), verts=bm1.verts)
        tmp = bpy.data.meshes.new("t"); bm1.to_mesh(tmp); bm1.free(); dn.from_mesh(tmp); bpy.data.meshes.remove(tmp)
    mesh_obj("Drum dentils", dn, C_MON, M["dressed"])

    # --- upper tier ---------------------------------------------------------
    tier = mesh_obj("Upper tier", annulus(55, D["tier_R"], D["drum_top"] - 0.2, D["tier_wall_top"]), C_MON, M["dressed"])
    tc_ = mesh_obj("Upper tier cornice and terrace", annulus(55, D["tier_cornice_R"], D["tier_wall_top"], D["tier_top"]), C_MON, M["dressed"])
    tc_.data.materials.append(M["gravel"])
    for ob in (tier, tc_):
        boolean(ob, sph71)
    for p in tc_.data.polygons:
        if p.normal.z > 0.9: p.material_index = 1

    # Front stair block: a solid stepped mass against the tier. Its trapezoid is the
    # elevation's central figure, its flanks are the two flights, and the plan's hatched
    # band sits in front of the tier wall. Each course is one 0.5 m step.
    vb, vt = D["v_bottom_half"], D["v_top_half"]
    slope = (vb - vt) / (D["tier_top"] - D["drum_top"])
    rise = D["stair_rise"]
    nsteps = int(round((D["tier_top"] - D["drum_top"]) / rise))
    vs = bmesh.new()
    for k in range(nsteps):
        zb = D["drum_top"] + k * rise
        half = vb - slope * (zb + rise - D["drum_top"])
        box(-half, half, D["stair_block_y"], D["stair_block_back"], zb, zb + rise, vs)
    mesh_obj("Front stair block", vs, C_MON, M["paving"])

    # --- sphere shell ---------------------------------------------------------
    sphere = mesh_obj("Sphere (Ø150 m shell)", uv_sphere(R, CZ, 384, 192), C_MON, M["sphere"])
    inner = temp_obj("cut_inner", uv_sphere(D["shell_inner_R"], CZ, 256, 128))
    inner.data.materials.append(M["stars"])     # boolean carries the cutter's material
    boolean(sphere, inner); kill(inner)
    # the arch at the sphere's foot, as drawn in the elevation: a sealed door
    tw, ts = D["tunnel_half_w"], D["tunnel_spring"]
    arch = [(-tw, D["platform_top"]), (tw, D["platform_top"])] + \
           [(tw * math.cos(math.pi * k / 32), ts + tw * math.sin(math.pi * k / 32)) for k in range(33)]
    tun = temp_obj("cut_tunnel", prism_y(arch, -75, -31))
    boolean(sphere, tun); kill(tun)
    mesh_obj("Sealed door", box(-tw, tw, -31.3, -31.0, D["platform_top"], ts + tw), C_MON, M["dark"])
    for c_ in cutters:
        boolean(sphere, c_)
    holes_cut = temp_obj("cut_holes", hole_cutter())
    boolean(sphere, holes_cut, solver="MANIFOLD"); kill(holes_cut)
    bore = M["sphere"].copy(); bore.name = "Bore"
    sphere.data.materials.append(M["stars"])
    sphere.data.materials.append(bore)
    i_stars, i_bore = len(sphere.data.materials) - 2, len(sphere.data.materials) - 1   # booleans leave empty slots below these
    for p in sphere.data.polygons:
        c_ = p.center - Vector((0, 0, CZ))
        if c_.length < D["shell_inner_R"] + 0.3 and c_.dot(p.normal) < 0:
            p.material_index = i_stars
        elif D["shell_inner_R"] + 0.3 <= c_.length < R - 0.05 and c_.z > -8:
            p.material_index = i_bore
    sphere.data.shade_smooth()
    # one flat floor, as in the section, with the ramp from the passages cut up through it
    floor_z = CZ - D["shell_inner_R"]
    plain = mesh_obj("Interior floor", annulus(0, 26, floor_z - 3, D["floor_top"], 128), C_MON, M["paving"])
    boolean(plain, cutters[-1])
    for c_ in cutters:
        kill(c_)
    sz = D["floor_top"]
    sar = box(-1.4, 1.4, -2.6, 2.6, sz, sz + 0.5)
    box(-1.15, 1.15, -2.35, 2.35, sz + 0.5, sz + 1.8, sar)
    box(-1.35, 1.35, -2.55, 2.55, sz + 1.8, sz + 2.2, sar)
    mesh_obj("Sarcophagus of Newton", sar, C_MON, M["dressed"])

    # bridge portal (small doorway on the drum terrace at the sphere)
    pz, py = D["drum_top"], D["stair_block_y"]
    por = box(-3.2, 3.2, py - 0.8, py + 0.2, pz, pz + 6.4)
    box(-3.8, 3.8, py - 1.2, py + 0.2, pz + 6.4, pz + 7.2, por)
    mesh_obj("Bridge portal", por, C_MON, M["dressed"])
    mesh_obj("Bridge portal door", box(-1.6, 1.6, py - 0.86, py - 0.7, pz, pz + 4.6), C_MON, M["dark"])

    # lion pedestals at the foot of the front opening
    ped = bmesh.new()
    for s in (-1, 1):
        box(s * 25.0 if s > 0 else -61.0, 61.0 if s > 0 else -25.0, -125.0, -118.0, D["platform_top"], D["platform_top"] + 3.4, ped)
    mesh_obj("Lion pedestals", ped, C_MON, M["dressed"])
    # recumbent lions on the pedestals, facing out; the drawings show them only as small dark shapes
    lion = lion_mesh()
    lions = bmesh.new()
    for x in (-47.6, -27.4, 27.4, 47.6):
        before = len(lions.verts)
        lions.from_mesh(lion)
        lions.verts.ensure_lookup_table()
        bmesh.ops.transform(lions, matrix=Matrix.Translation((x, -121.5, D["platform_top"] + 3.4)) @ Matrix.Rotation(math.radians(-90), 4, "Z"),
                            verts=lions.verts[before:])
    bpy.data.meshes.remove(lion)
    mesh_obj("Lions", lions, C_FIG, M["dressed"], smooth=True)

    # brazier with fire on the top landing (the smoke in Boullée's elevation)
    bz = D["tier_top"]; by = -D["tier_R"] + 4
    br = bmesh.new()
    bmesh.ops.create_cone(br, cap_ends=True, segments=32, radius1=0.6, radius2=1.4, depth=1.0,
                          matrix=Matrix.Translation((0, by, bz + 2.3)))
    for i in range(3):
        a = 2 * math.pi * i / 3
        bmesh.ops.create_cone(br, cap_ends=True, segments=8, radius1=0.12, radius2=0.12, depth=2.2,
                              matrix=Matrix.Translation((0.7 * math.cos(a), by + 0.7 * math.sin(a), bz + 1.1)))
    mesh_obj("Funeral brazier", br, C_FIG, M["bronze"])
    fl = bmesh.new()
    bmesh.ops.create_cone(fl, cap_ends=True, segments=24, radius1=1.1, radius2=0.0, depth=2.6,
                          matrix=Matrix.Translation((0, by, bz + 4.1)))
    fire = mesh_obj("Brazier fire", fl, C_FIG, M["fire"])
    # smoke column
    sm = bmesh.new()
    bmesh.ops.create_cone(sm, cap_ends=True, segments=24, radius1=2.5, radius2=9.0, depth=40,
                          matrix=Matrix.Translation((3, by + 6, bz + 24)) @ Matrix.Rotation(math.radians(8), 4, "Y"))
    smoke = mesh_obj("Smoke column", sm, C_FIG)
    smat = bpy.data.materials.new("Smoke"); smat.use_nodes = True
    nt = smat.node_tree; [nt.nodes.remove(n_) for n_ in list(nt.nodes)]
    o = nt.nodes.new("ShaderNodeOutputMaterial"); pv = nt.nodes.new("ShaderNodeVolumePrincipled")
    tcn = nt.nodes.new("ShaderNodeTexCoord")
    nz = noise(nt, tcn.outputs["Object"], 0.25, 6, 0.6)
    rz = ramp(nt, [(0.45, (0, 0, 0, 1)), (0.75, (1, 1, 1, 1))])
    nt.links.new(nz.outputs["Fac"], rz.inputs[0])
    # fade with height
    sep = nt.nodes.new("ShaderNodeSeparateXYZ"); nt.links.new(tcn.outputs["Generated"], sep.inputs[0])
    fade = math_node(nt, "SUBTRACT", None, sep.outputs[2], 1.0)
    dens = math_node(nt, "MULTIPLY", rz.outputs[0], fade.outputs[0])
    dens2 = math_node(nt, "MULTIPLY", dens.outputs[0], None, 0, 0.12)
    nt.links.new(dens2.outputs[0], pv.inputs["Density"])
    pv.inputs["Color"].default_value = (0.55, 0.55, 0.55, 1)
    nt.links.new(pv.outputs[0], o.inputs["Volume"])
    smoke.data.materials.append(smat)

    # --- planting beds under each tree band ---------------------------------
    beds = bmesh.new()
    for r1, r2, z, gap in [(77.2, 82.3, D["tier_top"], None), (99.8, 104.9, D["drum_top"], 23.0),
                           (107.3, 112.8, D["drum_top"], 23.0), (137.8, 143.2, D["platform_top"], 24.0),
                           (145.6, 151.1, D["platform_top"], 24.0)]:
        seg = 360
        a0 = -math.pi / 2 + math.radians(gap if gap else 0)
        a1 = -math.pi / 2 + 2 * math.pi - math.radians(gap if gap else 0)
        if gap is None:
            # top tier: beds only where the terrace exists (outside the V top)
            g = math.degrees(math.asin(min(1, (D["v_top_half"] + 1.5) / r1)))
            a0 = -math.pi / 2 + math.radians(g); a1 = -math.pi / 2 + 2 * math.pi - math.radians(g)
        nseg = int(seg * (a1 - a0) / (2 * math.pi))
        rows = []
        for (r_, zz) in [(r1, z), (r2, z), (r2, z + 0.12), (r1, z + 0.12)]:
            rows.append([beds.verts.new((r_ * math.cos(a0 + (a1 - a0) * i / nseg), r_ * math.sin(a0 + (a1 - a0) * i / nseg), zz)) for i in range(nseg + 1)])
        for i in range(nseg):
            for k in range(4):
                a_, b_ = rows[k], rows[(k + 1) % 4]
                beds.faces.new((a_[i], a_[i + 1], b_[i + 1], b_[i]))
        for rr_ in ([rows[0][0], rows[1][0], rows[2][0], rows[3][0]], [rows[3][-1], rows[2][-1], rows[1][-1], rows[0][-1]]):
            beds.faces.new(rr_)
    bmesh.ops.recalc_face_normals(beds, faces=beds.faces)
    mesh_obj("Planting beds", beds, C_MON, M["soil"])

    kill(sph71); kill(cone)

    # --- cypress variants and the 10 rows ----------------------------------
    variants = make_cypress_variants(C_SCENE, M, 8)
    tree_count = place_rows(variants, C_TREES)

    # --- landscape ------------------------------------------------------------
    build_landscape(C_SCENE, M, variants)
    build_figures(C_FIG, M)
    build_lights_cameras(C_CAM)

    # record what was built
    D["tree_rows"] = tree_count
    D["tree_total"] = sum(tree_count.values())
    os.makedirs(os.path.join(ROOT, "docs"), exist_ok=True)
    with open(os.path.join(ROOT, "docs", "dimensions.json"), "w") as f:
        json.dump(D, f, indent=2)
    print("TREES", D["tree_total"], tree_count)

def make_cypress_variants(c, M, n):
    """Columnar Italian cypress, 10–11 m tall as drawn, crown ≈ 2.6 m wide."""
    lib = coll("Cypress library", c)
    lib.hide_render = True
    out = []
    tex = bpy.data.textures.new("cypress_clumps", "VORONOI")
    tex.noise_scale = 0.18; tex.distance_metric = "DISTANCE"
    tex2 = bpy.data.textures.new("cypress_fine", "CLOUDS")
    tex2.noise_scale = 0.07; tex2.noise_depth = 2
    for v in range(n):
        rnd = random.Random(100 + v)
        H = rnd.uniform(9.6, 11.4); rmax = rnd.uniform(1.15, 1.45); base = rnd.uniform(1.0, 1.6)
        bm = bmesh.new()
        seg, rings = 40, 72
        verts = []
        for j in range(rings + 1):
            t = j / rings
            z = base - 0.3 + t * (H - base + 0.3)
            # flame profile: widest ~25% up, long taper, pointed tip
            prof = (math.sin(math.pi * t ** 0.62) ** 0.7) * (1 - 0.2 * t)
            r_ = max(rmax * prof, 0.02)
            ring = []
            for i in range(seg):
                a = 2 * math.pi * i / seg
                ring.append(bm.verts.new((r_ * math.cos(a), r_ * math.sin(a), z)))
            verts.append(ring)
        for j in range(rings):
            for i in range(seg):
                k = (i + 1) % seg
                bm.faces.new((verts[j][i], verts[j][k], verts[j + 1][k], verts[j + 1][i]))
        bm.faces.new(list(reversed(verts[0]))); bm.faces.new(verts[-1])
        me = bpy.data.meshes.new(f"cypress_{v}")
        bm.to_mesh(me); bm.free()
        ob = bpy.data.objects.new(f"cypress_src_{v}", me); lib.objects.link(ob)
        sub = ob.modifiers.new("sub", "SUBSURF"); sub.levels = 1; sub.render_levels = 1
        d1 = ob.modifiers.new("clumps", "DISPLACE"); d1.texture = tex; d1.strength = 0.38; d1.mid_level = 0.6
        d1.texture_coords = "LOCAL"
        d2 = ob.modifiers.new("fine", "DISPLACE"); d2.texture = tex2; d2.strength = 0.12; d2.mid_level = 0.5
        d2.texture_coords = "LOCAL"
        # offset texture space per variant
        tc = bpy.data.objects.new(f"cyp_texspace_{v}", None); lib.objects.link(tc)
        tc.location = (rnd.uniform(-50, 50), rnd.uniform(-50, 50), 0)
        tc.scale = (1.0, 1.0, 3.5)    # stretch the clumps vertically: flame-like sprays
        d1.texture_coords = "OBJECT"; d1.texture_coords_object = tc
        d2.texture_coords = "OBJECT"; d2.texture_coords_object = tc
        dg = bpy.context.evaluated_depsgraph_get()
        me2 = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
        me2.name = f"Cypress mesh {v}"
        # trunk
        tb = bmesh.new(); tb.from_mesh(me2)
        for p in tb.faces: p.material_index = 0
        bmesh.ops.create_cone(tb, cap_ends=True, segments=10, radius1=0.2, radius2=0.12, depth=base + 0.2,
                              matrix=Matrix.Translation((0, 0, (base + 0.2) / 2 - 0.1)))
        tb.faces.ensure_lookup_table()
        nf = len(me2.polygons)
        for i, f in enumerate(tb.faces):
            if i >= nf: f.material_index = 1
        tb.to_mesh(me2); tb.free()
        me2.materials.append(M["cypress"]); me2.materials.append(M["bark"])
        me2.shade_smooth()
        bpy.data.objects.remove(ob); bpy.data.objects.remove(tc)
        bpy.data.meshes.remove(me)
        out.append(me2)
    return out

def place_rows(variants, c):
    counts = {}
    for ri, row in enumerate(ROWS):
        r, pitch, gap, z = row["r"], row["pitch"], row["gap"], row["z"]
        n_full = int(round(2 * math.pi / pitch))
        pitch = 2 * math.pi / n_full
        if gap is None:  # top tier: terrace stops at the V-cut opening
            gap = math.degrees(math.asin((D["v_top_half"] + 1.5) / r))
        front = -math.pi / 2
        made = 0
        rc = coll(f"Row {ri + 1:02d}  r={r:.1f} m", c)
        for i in range(n_full):
            a = front + (i + row["phase"]) * pitch
            d = math.degrees(abs(math.atan2(math.sin(a - front), math.cos(a - front))))
            if d < gap:
                continue
            me = variants[random.randrange(len(variants))]
            ob = bpy.data.objects.new(f"Cypress R{ri + 1:02d}-{made + 1:03d}", me)
            j = 0.12
            ob.location = (r * math.cos(a) + random.uniform(-j, j), r * math.sin(a) + random.uniform(-j, j), z + 0.1)
            ob.rotation_euler = (random.uniform(-0.012, 0.012), random.uniform(-0.012, 0.012), random.uniform(0, 6.283))
            s = random.uniform(0.94, 1.06)
            ob.scale = (s * random.uniform(0.95, 1.05), s * random.uniform(0.95, 1.05), s)
            rc.objects.link(ob)
            made += 1
        counts[f"row{ri + 1:02d}_r{r}"] = made
    return counts

def build_landscape(c, M, variants):
    # natural ground with gentle distant hills
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=240, y_segments=240, size=4500)
    for v in bm.verts:
        d = math.hypot(v.co.x, v.co.y)
        k = max(0.0, (d - 900) / 2600)
        h = (math.sin(v.co.x * 0.0021 + 1.3) * math.cos(v.co.y * 0.0017 - 0.4) + 0.6 * math.sin(v.co.x * 0.0047 + v.co.y * 0.0031)) * 70 * k ** 1.4
        v.co.z = h - 0.02
    g = mesh_obj("Ground (meadow and hills)", bm, c, M["grass"], smooth=True)
    # gravel esplanade in front of the stair and walks along the basin
    gb = bmesh.new()
    box(-40, 40, -205, -157.0, -0.02, 0.03, gb)
    box(-30, -22, -720, -205, -0.02, 0.03, gb); box(22, 30, -720, -205, -0.02, 0.03, gb)
    box(-40, 40, -745, -720, -0.02, 0.03, gb)
    mesh_obj("Esplanade and walks", gb, c, M["gravel"])
    # reflecting basin on the axis
    cp = bmesh.new()
    box(-22, -20, -720, -205, -0.5, 0.35, cp); box(20, 22, -720, -205, -0.5, 0.35, cp)
    box(-22, 22, -207, -205, -0.5, 0.35, cp); box(-22, 22, -720, -718, -0.5, 0.35, cp)
    mesh_obj("Basin coping", cp, c, M["dressed"])
    mesh_obj("Basin water", box(-20, 20, -718, -207, -0.6, 0.12), c, M["water"])
    # distant woodland ring
    wood = coll("Distant woodland", c)
    leaf = mat_simple("Broadleaf woodland", (0.016, 0.030, 0.011, 1), 0.9)
    ctex = bpy.data.textures.new("crown", "CLOUDS"); ctex.noise_scale = 0.35; ctex.noise_depth = 3
    crowns = []
    for k in range(4):
        bl = bmesh.new()
        bmesh.ops.create_icosphere(bl, subdivisions=4, radius=1.0)
        tmpme = bpy.data.meshes.new("crown_src"); bl.to_mesh(tmpme); bl.free()
        src = bpy.data.objects.new("crown_src", tmpme); c.objects.link(src)
        src.scale = (1, 1, 0.9 + 0.1 * k)
        dm = src.modifiers.new("d", "DISPLACE"); dm.texture = ctex; dm.strength = 0.45; dm.mid_level = 0.5
        emp = bpy.data.objects.new("crown_tex", None); c.objects.link(emp); emp.location = (k * 7.3, k * 3.1, 0)
        dm.texture_coords = "OBJECT"; dm.texture_coords_object = emp
        dg = bpy.context.evaluated_depsgraph_get()
        cm = bpy.data.meshes.new_from_object(src.evaluated_get(dg)); cm.name = f"Broadleaf crown {k}"
        cm.transform(Matrix.Diagonal((1, 1, 0.9 + 0.1 * k, 1)))
        cm.shade_smooth(); cm.materials.append(leaf)
        bpy.data.objects.remove(src); bpy.data.objects.remove(emp); bpy.data.meshes.remove(tmpme)
        crowns.append(cm)
    rnd = random.Random(7)
    dg_g = g.data
    import mathutils
    kd = mathutils.kdtree.KDTree(len(dg_g.vertices))
    for i, v in enumerate(dg_g.vertices): kd.insert(v.co, i)
    kd.balance()
    from mathutils import noise as mnoise
    placed = 0
    while placed < 16000:
        a = rnd.uniform(0, 2 * math.pi)
        d = rnd.uniform(800, 3000)
        x, y = d * math.cos(a), d * math.sin(a)
        if abs(x) < 140 and y < 0:      # keep the axial view open
            continue
        if mnoise.noise(Vector((x / 420, y / 420, 0.5))) < -0.05:   # copses and clearings
            continue
        placed += 1
        co, idx, _ = kd.find((x, y, 0))
        z = dg_g.vertices[idx].co.z
        ob = bpy.data.objects.new("wood", crowns[placed % len(crowns)])
        s = rnd.uniform(4.5, 8.5)
        ob.location = (x, y, z + s * 0.6)
        ob.scale = (s, s, s * rnd.uniform(0.9, 1.3))
        wood.objects.link(ob)
    # a cypress allée flanking the basin walks (two rows each side, 6 m pitch)
    al = coll("Basin allée cypresses", c)
    for sx in (-1, 1):
        for xr in (34.0, 40.0):
            y = -215.0 + (3.0 if xr == 40 else 0)
            while y > -712:
                ob = bpy.data.objects.new("allée cypress", variants[rnd.randrange(len(variants))])
                ob.location = (sx * xr, y, 0)
                ob.rotation_euler.z = rnd.uniform(0, 6.28)
                s = rnd.uniform(0.95, 1.05); ob.scale = (s, s, s)
                al.objects.link(ob)
                y -= 6.0

def lion_mesh(name="lion"):
    """Couchant lion from primitives merged by voxel remesh, then carved. Forward +X, up +Z, feet at z=0, about 4 m long and 2.3 m tall."""
    bm = bmesh.new()

    def ell(c, r, rot=None):
        t = bmesh.ops.create_uvsphere(bm, u_segments=20, v_segments=12, radius=1.0)
        m = Matrix.Translation(c) @ (rot or Matrix.Identity(4)) @ Matrix.Diagonal((*r, 1))
        bmesh.ops.transform(bm, matrix=m, verts=t["verts"])

    def sweep(pts):
        """Smooth limb through (x, y, z, radius) points."""
        pts = [pts[0]] + pts + [pts[-1]]
        for i in range(1, len(pts) - 2):
            p0, p1, p2, p3 = [Vector(p) for p in pts[i - 1:i + 3]]
            n = max(2, int((p2.xyz - p1.xyz).length / 0.05))
            for k in range(n):
                t = k / n
                q = 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t ** 2 + (3 * p1 - p0 - 3 * p2 + p3) * t ** 3)
                ell(q.xyz, (q.w, q.w, q.w))

    # body
    sweep([(-1.3, 0, 0.66, 0.6), (-0.45, 0, 0.72, 0.68), (0.45, 0, 0.82, 0.68), (0.8, 0, 0.98, 0.58)])
    for s in (-1, 1):
        ell((-1.25, s * 0.5, 0.52), (0.76, 0.34, 0.52))                                     # haunch
        sweep([(-1.0, s * 0.72, 0.3, 0.24), (-0.45, s * 0.8, 0.17, 0.16), (-0.05, s * 0.8, 0.13, 0.13)])   # hind leg
        ell((0.18, s * 0.8, 0.12), (0.3, 0.2, 0.12))
        ell((0.42, s * 0.34, 1.1), (0.46, 0.2, 0.42))                                       # shoulder
        sweep([(0.62, s * 0.5, 0.68, 0.32), (0.56, s * 0.54, 0.26, 0.21), (1.2, s * 0.44, 0.17, 0.155), (1.72, s * 0.42, 0.15, 0.15)])   # foreleg
        ell((1.95, s * 0.42, 0.13), (0.27, 0.2, 0.13))
        for k, dy in enumerate((-0.135, -0.045, 0.045, 0.135)):
            ell((2.19 - abs(dy) * 0.4, s * 0.42 + dy, 0.09), (0.09, 0.05, 0.08))            # toes

    # neck, mane and head
    sweep([(0.72, 0, 1.08, 0.56), (1.02, 0, 1.6, 0.46)])
    ell((1.0, 0, 1.62), (0.56, 0.64, 0.76))
    ell((1.1, 0, 1.08), (0.42, 0.5, 0.56))
    ell((1.38, 0, 1.86), (0.36, 0.33, 0.32))                                                # skull
    ell((1.64, 0, 1.73), (0.27, 0.25, 0.19))                                                # muzzle
    ell((1.66, 0, 1.58), (0.2, 0.18, 0.08))                                                 # chin
    sweep([(1.42, 0, 2.03, 0.14), (1.66, 0, 1.92, 0.12), (1.84, 0, 1.8, 0.1)])              # broad nose
    ell((0.98, 0, 1.72), (0.3, 0.74, 0.82))                                                 # ruff framing the face
    for s in (-1, 1):
        ell((1.54, s * 0.19, 1.99), (0.14, 0.1, 0.05))                                      # brow
        ell((1.15, s * 0.31, 2.17), (0.09, 0.12, 0.14))                                     # ear
        ell((1.72, s * 0.12, 1.71), (0.16, 0.13, 0.12))                                     # whisker pad

    # tail, curled round the near flank
    sweep([(-1.85, 0.2, 0.55, 0.15), (-1.98, 0.62, 0.2, 0.115), (-1.55, 1.02, 0.11, 0.095), (-0.8, 1.1, 0.1, 0.085), (-0.15, 1.12, 0.1, 0.08)])
    ell((0.1, 1.13, 0.12), (0.28, 0.13, 0.12))

    src = bpy.data.meshes.new(name + "_src"); bm.to_mesh(src); bm.free()
    ob = bpy.data.objects.new(name + "_src", src); bpy.context.collection.objects.link(ob)
    r = ob.modifiers.new("r", "REMESH"); r.mode = "VOXEL"; r.voxel_size = 0.026; r.use_smooth_shade = True
    sm = ob.modifiers.new("s", "SMOOTH"); sm.factor = 0.6; sm.iterations = 12
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    bpy.data.objects.remove(ob); bpy.data.meshes.remove(src)

    # carve: mane locks, eyes, nostrils and mouth, by pushing along the normals
    bm = bmesh.new(); bm.from_mesh(me); bm.normal_update()
    axis0, axis1 = Vector((0.55, 0, 0.95)), Vector((1.25, 0, 1.95))
    def dent(p, c, r):
        d = (p - Vector(c)).length
        return max(0.0, 1 - (d / r) ** 2) ** 2
    moves = []
    for v in bm.verts:
        p, d = v.co, 0.0
        # mane: over neck and chest, stopping at the face
        ax = (axis1 - axis0).normalized()
        along = (p - axis0).dot(ax)
        off = p - axis0 - ax * along
        rad = off.length
        face = max(0.0, min(1.0, (p.x - 1.28) / 0.14))
        low = max(0.0, min(1.0, (rad - 0.3) / 0.14))
        mask = low * (1 - face) * max(0.0, min(1.0, (along + 0.75) / 0.3)) * max(0.0, min(1.0, (p.x - 0.28) / 0.28))
        if mask > 0 and p.z > 0.42:
            a = math.atan2(off.y, off.z + 1e-6)
            warp = 1.6 * mathutils.noise.noise(p * 2.2)
            lock = abs(math.sin(a * 16 + along * 2.6 + warp * 1.4))
            wave = 0.5 + 0.5 * math.sin(along * 11 + a * 5 + warp * 2)
            d += mask * (0.06 * (lock ** 0.5 - 0.5) + 0.018 * wave)
        for s in (-1, 1):
            d -= 0.06 * dent(p, (1.66, s * 0.2, 1.905), 0.085)     # eye socket
            d += 0.028 * dent(p, (1.68, s * 0.2, 1.9), 0.04)       # eyeball
            d -= 0.035 * dent(p, (1.9, s * 0.07, 1.745), 0.045)    # nostril
            d -= 0.07 * dent(p, (1.15, s * 0.32, 2.14), 0.07)      # ear hollow
        if abs(p.y) < 0.2 and 1.62 < p.z < 1.68 and p.x > 1.62:
            d -= 0.035 * max(0.0, min(1.0, (p.x - 1.62) / 0.1)) * (1 - abs(p.z - 1.65 - 0.1 * abs(p.y)) / 0.03 if abs(p.z - 1.65 - 0.1 * abs(p.y)) < 0.03 else 0)   # mouth line
        if p.x > 1.7 and abs(p.y) < 0.03 and 1.6 < p.z < 1.72:
            d -= 0.02                                              # groove below the nose
        moves.append(d)
    for v, d in zip(bm.verts, moves):
        v.co += v.normal * d
    bm.to_mesh(me); bm.free()

    ob = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(ob)
    dm = ob.modifiers.new("d", "DECIMATE"); dm.ratio = 1.0
    dg = bpy.context.evaluated_depsgraph_get()
    n = len(me.polygons)
    dm.ratio = min(1.0, 14000 / max(sum(len(p.vertices) - 2 for p in me.polygons), 1))
    dg.update()
    out = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    bpy.data.objects.remove(ob); bpy.data.meshes.remove(me)
    out.name = name
    return out

def build_figures(c, M):
    """Human figures (1.75 m) for scale, placed like those in Boullée's drawings."""
    rnd = random.Random(3)
    meshes = []
    for i, cl in enumerate(M["cloth"]):
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, segments=10, radius1=0.26, radius2=0.2, depth=1.45,
                              matrix=Matrix.Translation((0, 0, 0.725)))
        bmesh.ops.create_uvsphere(bm, u_segments=10, v_segments=8, radius=0.12, matrix=Matrix.Translation((0, 0, 1.6)))
        me = bpy.data.meshes.new(f"figure_{i}"); bm.to_mesh(me); bm.free()
        me.materials.append(cl); me.materials.append(M["skin"])
        nverts_body = 10 * 2 + 2
        for p in me.polygons:
            if p.center.z > 1.47: p.material_index = 1
        meshes.append(me)
    def group(cx, cy, z, n, spread):
        for k in range(n):
            ob = bpy.data.objects.new("figure", meshes[rnd.randrange(len(meshes))])
            ob.location = (cx + rnd.uniform(-spread, spread), cy + rnd.uniform(-spread, spread), z)
            s = rnd.uniform(0.92, 1.06) / D["people_scale"]; ob.scale = (s, s, s)
            c.objects.link(ob)
    pt, dt = D["platform_top"], D["drum_top"]
    group(0, -133, pt, 6, 6)           # at the head of the main stair
    group(-12, -175, 0.03, 7, 5)       # esplanade
    group(14, -190, 0.03, 4, 3)
    group(-6, -60, pt, 5, 4)           # before the tunnel
    group(10, -48, pt, 3, 2)
    group(-14, -96, dt, 6, 3)          # on the bridge terrace
    group(9, -96, dt, 4, 2)
    group(-26, -300, 0.03, 3, 2); group(26, -420, 0.03, 4, 2)  # along the basin
    group(4.2, -3.5, CZ_floor() + 3.0, 2, 0.6)  # inside, beside the sarcophagus

def CZ_floor():
    return D["sphere_cz"] - D["shell_inner_R"]

def look_at(ob, target):
    d = Vector(target) - ob.location
    ob.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()

def SKY_ROT(azim):
    # Maps a compass azimuth (radians from +X, counter-clockwise) to the sky
    # node's sun_rotation. Checked with an equirectangular render: the sky's sun
    # disc lands on the lamp direction.
    return SKY_ROT_OFFSET + SKY_ROT_SIGN * azim

SKY_ROT_OFFSET, SKY_ROT_SIGN = math.radians(90), -1.0

def build_lights_cameras(c):
    sc = bpy.context.scene
    # sun: late afternoon, light from the left as in Boullée's drawings
    sun_d = bpy.data.lights.new("Sun", "SUN"); sun_d.energy = 4.2; sun_d.angle = math.radians(0.53)
    sun_d.color = (1.0, 0.93, 0.82)
    sun = bpy.data.objects.new("Sun", sun_d); c.objects.link(sun)
    elev, azim = math.radians(28), math.radians(-160)    # sun from the left, slightly in front
    sun_dir = Vector((math.cos(elev) * math.cos(azim), math.cos(elev) * math.sin(azim), math.sin(elev)))
    sun.rotation_euler = (-sun_dir).to_track_quat("-Z", "Y").to_euler()
    # world sky
    w = bpy.data.worlds.new("Sky"); sc.world = w; w.use_nodes = True
    nt = w.node_tree
    bg = nt.nodes["Background"]
    sky = nt.nodes.new("ShaderNodeTexSky")
    for t in ("MULTIPLE_SCATTERING", "NISHITA", "SINGLE_SCATTERING", "HOSEK_WILKIE"):
        try:
            sky.sky_type = t; break
        except TypeError:
            continue
    for k, v in dict(sun_elevation=elev, sun_rotation=SKY_ROT(azim), altitude=200.0, air_density=1.0,
                     dust_density=1.0, aerosol_density=1.0, sun_disc=True, sun_direction=sun_dir).items():
        if hasattr(sky, k):
            try: setattr(sky, k, v)
            except (TypeError, ValueError): pass
    nt.links.new(sky.outputs[0], bg.inputs[0])
    bg.inputs[1].default_value = 0.16
    sun_d.energy = 3.2
    # cameras
    def cam(name, loc, target, lens=35, ortho=None):
        cd = bpy.data.cameras.new(name); cd.lens = lens; cd.clip_end = 20000; cd.clip_start = 0.1
        if ortho:
            cd.type = "ORTHO"; cd.ortho_scale = ortho
        ob = bpy.data.objects.new(name, cd); c.objects.link(ob)
        ob.location = loc; look_at(ob, target)
        if ortho:
            cd.clip_start = 1500 - 260   # skip landscape between camera and monument
        return ob
    hero = cam("CAM_Hero_aerial", (-430, -540, 150), (0, -10, 50), 50)
    cam("CAM_Approach_basin", (0, -719, 1.75), (0, 0, 56), 30)
    # ortho cameras framed to overlay Boullée's sheets 1:1 (see compare step)
    cam("CAM_Elevation_ortho", (0, -1500, 83.2), (0, 0, 83.2), ortho=301.2)
    cam("CAM_Plan_ortho", (0, 0, 1500), (0, 0, 0), ortho=335.4)
    cam("CAM_Terrace_among_cypress", (-34.5, -100.2, D["drum_top"] + 1.65), (-55, -30, 75), 16)
    cam("CAM_Interior_vault", (0, -13, 10.85), (0, 20, 42), 12)
    cam("CAM_Forecourt", (-62, -150, D["platform_top"] + 1.7), (0, -30, 44), 20)
    sc.camera = hero

if __name__ == "__main__":
    build()
    out = os.path.join(ROOT, "model", "newtons_cenotaph.blend")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=out, compress=True)
    print("SAVED", out)
