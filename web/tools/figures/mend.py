# Mend two figures the cuts had damaged, in the sheet recut.py wrote: the forehead of the lady on plate 00,
# which the first threshold took for paper, and the crossed legs of the gentleman on plate 03, lost with
# the ground they stood on. The legs come back from the sheet as it was before recut.py.
#   python3 -I tools/figures/mend.py <old figures.webp> <old figures.json> public/assets/figures
import json, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage

old_path, old_json, out = sys.argv[1:]
sheet = Image.open(f'{out}.webp').convert('RGBA'); places = json.load(open(f'{out}.json'))
old = Image.open(old_path).convert('RGBA'); old_places = json.load(open(old_json))
W, H = sheet.size
box = lambda p: (round(p['u0'] * W), round((1 - p['v1']) * H), round(p['u1'] * W), round((1 - p['v0']) * H))
find = lambda ps, plate: next(p for p in ps if p['plate'] == plate)

def finish(fig):
    """Trim the edge a pixel, feather it, and carry the figure's own tone out under the clear pixels."""
    a = np.array(fig); alpha = Image.fromarray(a[..., 3]).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.7))
    solid = a[..., 3] > 128
    near = ndimage.distance_transform_edt(~solid, return_distances=False, return_indices=True)
    a[..., :3] = a[..., :3][near[0], near[1]]
    a[..., 3] = np.array(alpha)
    return Image.fromarray(a)

# plate 00: the forehead, in the tone of her cheek, with the engraver's line down its front
p = find(places, '00'); x0, y0, _, _ = box(p)
fig = sheet.crop(box(p)); a = np.array(fig)
skin = a[172:186, 232:246, :3].reshape(-1, 3).mean(0)
brow = Image.new('L', fig.size, 0)
ImageDraw.Draw(brow).polygon([(234, 141), (252, 133), (268, 141), (276, 150), (272, 159), (268, 169), (260, 169), (248, 166), (238, 161), (235, 150)], fill=255)
brow = np.array(brow.filter(ImageFilter.GaussianBlur(0.8))) / 255.0
rng = np.random.default_rng(3)
tone = skin[None, None, :] + rng.normal(0, 2.2, a.shape[:2] + (1,))
fill = brow[..., None] * (a[..., 3:4] < 200)
a[..., :3] = (a[..., :3] * (1 - fill) + tone * fill).astype(np.uint8)
a[..., 3] = np.maximum(a[..., 3], (brow * 255).astype(np.uint8))
fig = Image.fromarray(a)
ImageDraw.Draw(fig).line([(275, 150), (272, 159), (268, 168)], fill=(118, 106, 88, 255), width=1)
sheet.paste(fig, (x0, y0))

# plate 03: his legs and shoes from the old sheet, traced by hand, without the ground round them
po = find(old_places, '03'); fig = old.crop(box(po)); a = np.array(fig)
legs = [(250, 290), (560, 290), (555, 330), (500, 380), (490, 520), (495, 700), (540, 720), (550, 830), (505, 880), (525, 935), (550, 990), (550, 1020), (425, 1020), (405, 960),
        (408, 915), (350, 918), (290, 900), (300, 868), (405, 795), (418, 700), (395, 600), (340, 520), (295, 420), (265, 310)]      # on the lower 340 rows, three times enlarged
keep = Image.new('L', fig.size, 0)
ImageDraw.Draw(keep).polygon([(x / 3, y / 3 + 620) for x, y in legs], fill=255)
keep = np.array(keep) > 0
rows = np.arange(fig.height)[:, None]
a[..., 3] = np.where((rows > 716) & ~keep, 0, a[..., 3])
fig = finish(Image.fromarray(a))
p = find(places, '03'); x0, y0, x1, y1 = box(p)
sheet.paste(Image.new('RGBA', (x1 - x0, y1 - y0), (0, 0, 0, 0)), (x0, y0))
sheet.paste(fig, (x0, y0))
p['u1'] = round((x0 + fig.width) / W, 5); p['aspect'] = round(fig.width / fig.height, 5)
solid = np.array(fig)[-48:, :, 3] > 128
p['feet'] = round(float(np.nonzero(solid.any(0))[0].mean()) / fig.width, 5)

sheet.save(f'{out}.webp', quality=86, alpha_quality=92, method=6, exact=False)
json.dump(places, open(f'{out}.json', 'w'))
print('mended', p)
