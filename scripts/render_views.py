"""
Render the camera views of model/newtons_cenotaph.blend with Cycles.

  Blender -b model/newtons_cenotaph.blend -P scripts/render_views.py -- \
      [--cams CAM_Hero_aerial,CAM_Plan_ortho] [--samples 128] [--pct 100] [--out renders]
"""
import bpy, sys, os, argparse

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument("--cams", default="")
ap.add_argument("--samples", type=int, default=128)
ap.add_argument("--pct", type=int, default=100)
ap.add_argument("--out", default="renders")
ap.add_argument("--suffix", default="")
a = ap.parse_args(argv)

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sc = bpy.context.scene
sc.render.engine = "CYCLES"
prefs = bpy.context.preferences.addons["cycles"].preferences
for dev_type in ("METAL", "OPTIX", "CUDA", "HIP", "ONEAPI"):
    try:
        prefs.compute_device_type = dev_type
        prefs.get_devices()
        if any(d.type == dev_type for d in prefs.devices):
            for d in prefs.devices:
                d.use = d.type == dev_type
            sc.cycles.device = "GPU"
            break
    except TypeError:
        continue
cy = sc.cycles
cy.samples = a.samples
cy.use_adaptive_sampling = True
cy.adaptive_threshold = 0.02
cy.use_denoising = True
cy.max_bounces = 6; cy.diffuse_bounces = 3; cy.glossy_bounces = 3
cy.transmission_bounces = 4; cy.volume_bounces = 1
cy.caustics_reflective = False; cy.caustics_refractive = False
sc.render.film_transparent = False
sc.view_settings.view_transform = "AgX"
try:
    sc.view_settings.look = "AgX - Medium High Contrast"
except TypeError:
    pass
sc.render.image_settings.file_format = "PNG"
sc.render.use_persistent_data = True

# per-view framing (resolution, exposure)
VIEW = {
    "CAM_Hero_aerial": ((1920, 1080), 0.0),
    "CAM_Approach_basin": ((1920, 1080), 0.0),
    "CAM_Forecourt": ((1920, 1080), 0.0),
    "CAM_Terrace_among_cypress": ((1920, 1080), 0.0),
    "CAM_Interior_vault": ((1920, 1080), 10.0),
    "CAM_Elevation_ortho": ((1536, 921), 0.0),      # same pixel grid as Boullée sheet 03
    "CAM_Plan_ortho": ((1024, 1024), 0.0),          # same pixel grid as Boullée sheet 01
}
cams = [c for c in a.cams.split(",") if c] or list(VIEW)
outdir = os.path.join(ROOT, a.out)
os.makedirs(outdir, exist_ok=True)
for name in cams:
    (w, h), ev = VIEW[name]
    sc.camera = bpy.data.objects[name]
    sc.render.resolution_x, sc.render.resolution_y = w, h
    sc.render.resolution_percentage = a.pct
    sc.view_settings.exposure = ev
    # interior smoke only matters outside; hide nothing else
    path = os.path.join(outdir, name.replace("CAM_", "").lower() + a.suffix + ".png")
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print("RENDERED", path, flush=True)
