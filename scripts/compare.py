"""
Side-by-side and overlay of Boullée's sheets against the orthographic renders.
The ortho cameras use the same pixel grid as the scans, so the overlay is a direct
check of scale and proportion.

  Blender -b --factory-startup -P scripts/compare.py
"""
import bpy, os, numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PAIRS = [("references/boullee_03.jpg", "renders/elevation_ortho.png", "compare_elevation"),
         ("references/boullee_01.jpg", "renders/plan_ortho.png", "compare_plan")]

def load(path):
    img = bpy.data.images.load(os.path.join(ROOT, path))
    w, h = img.size
    a = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)
    return a

def save(arr, path):
    h, w = arr.shape[:2]
    img = bpy.data.images.new(os.path.basename(path), w, h, alpha=True)
    img.pixels[:] = arr.ravel()
    img.filepath_raw = os.path.join(ROOT, path)
    img.file_format = "PNG"
    img.save()

for ref, ren, name in PAIRS:
    a, b = load(ref), load(ren)
    h = min(a.shape[0], b.shape[0]); w = min(a.shape[1], b.shape[1])
    a, b = a[:h, :w], b[:h, :w]
    gap = np.ones((h, 16, 4), np.float32)
    save(np.concatenate([a, gap, b], axis=1), f"renders/{name}_side_by_side.png")
    # overlay: drawing in red/cyan anaglyph style so offsets are easy to see
    ga = a[..., :3].mean(axis=2); gb = b[..., :3].mean(axis=2)
    ov = np.stack([ga, gb, gb, np.ones_like(ga)], axis=2)
    save(ov, f"renders/{name}_overlay.png")
    print("WROTE", name)
