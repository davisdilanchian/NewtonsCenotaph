# Give the gentleman on plate 05 his own head back. The first threshold took his forehead and the bridge of his
# nose for paper, and mend.py filled them with a flat tone; here they come from the plate itself, laid over the
# sheet where it belongs, with the profile traced by hand along the engraver's line and the crown of the wig,
# which the first cut had shaved, standing four rows higher. The colour under the sheet's clear pixels, lost when
# mend.py saved it, is carried out from the figures again, so their edges don't darken at a distance.
# Run it once, on the sheet as mend.py left it, with f05.jpg from fetch.py in the work dir.
#   python3 -I tools/figures/plate05.py <work dir> public/assets/figures
import json, sys
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as nd

work, out = sys.argv[1:]
sheet = Image.open(f'{out}.webp').convert('RGBA'); places = json.load(open(f'{out}.json'))
W, H = sheet.size
p = next(p for p in places if p['plate'] == '05')
x0, y0, x1, y1 = round(p['u0'] * W), round((1 - p['v1']) * H), round(p['u1'] * W), round((1 - p['v0']) * H)
UP, DOWN = 4, 140                                # rows added above the figure, and how far down the head is looked at
SCALE, DX, DY = 0.598001, 453.7714, 314.1895     # the 1920 px plate onto the figure's place in the sheet, found by matching the two

# the plate's head at the sheet's size, printed in the one ink as cut.py prints it, and as soft as the sheet
w, h = x1 - x0, UP + DOWN
plate = Image.open(f'{work}/f05.jpg').convert('RGB')
grey = np.asarray(plate.resize((w, h), Image.LANCZOS, box=(DX / SCALE, (DY - UP) / SCALE, (DX + w) / SCALE, (DY + DOWN) / SCALE)), np.float32) @ [0.2126, 0.7152, 0.0722] / 255
s = lambda v: 1 / (1 + np.exp(-4 * (v - 0.55)))
grey = nd.gaussian_filter((s(grey) - s(0)) / (s(1) - s(0)), 0.6)[..., None]
ink = np.array([0x1d, 0x16, 0x10]) * (1 - grey) + np.array([0xec, 0xe2, 0xcc]) * grey

# his profile from the crown of the wig to the chin, a little outside the line, closed through the solid of the head
PROFILE = [(216, 14), (210, 9), (205, 6), (200, 3.5), (195, 1.5), (190, -0.5), (185, -2.5), (180, -3), (170, -3.2), (160, -2.2), (155, -1), (150, 0.3), (145.5, 3), (141.5, 6.5),
           (139, 10), (137.5, 14.5), (135.8, 18.5), (134.5, 22.5), (133, 25.5), (130.5, 29), (126.8, 35.5), (123.8, 41.5), (120.8, 46.5), (118.6, 50.5), (118, 54), (118, 58),
           (117.6, 62), (116.5, 65.5), (113.3, 69.5), (110.3, 73.5), (107.3, 77.5), (105.3, 81), (105.3, 84.5), (107, 87), (110, 88.3), (113.8, 89.5), (114, 92.5), (114.3, 96),
           (114.5, 100), (116, 104), (116.3, 108), (116.3, 112.5), (118, 116.5), (121, 119.5), (125, 121), (216, 121)]
def mask(poly, k=4):
    m = Image.new('L', (w * k, h * k), 0)
    ImageDraw.Draw(m).polygon([(x * k, (y + UP) * k) for x, y in poly], fill=255)
    return np.asarray(m.resize((w, h), Image.BOX), np.float32) / 255
FOUR = nd.generate_binary_structure(2, 1)
keep = mask(PROFILE) > 0.5
edge = np.clip((nd.gaussian_filter(nd.binary_erosion(keep, FOUR).astype(np.float32), 0.8) - 0.12) / 0.76, 0, 1) * 255

head = np.zeros((h, w, 4), np.float32)
head[UP:] = np.asarray(sheet.crop((x0, y0, x1, y0 + DOWN)), np.float32)
# the outline is his from the brow up and across the crown, and eases into the old cut at the chin
mine = nd.gaussian_filter(np.maximum(mask([(90, -UP), (216, -UP), (216, 12), (150, 12), (150, 112), (90, 112)]), 0), 2)
alpha = edge * mine + head[..., 3] * (1 - mine)
# and nothing inside it is left clear: the mend's seam was, in places
ys, xs = np.mgrid[-UP:DOWN, 0:w]
alpha = np.maximum(alpha, edge * np.clip((214 - xs) / 10, 0, 1) * np.clip((118 - ys) / 10, 0, 1))
# the plate's own paper and ink wherever the cut had lost them or the mend had painted
PAINTED = [[(139, 19), (152, 27), (154, 46), (141, 57), (126, 58), (127, 50), (131, 36), (136, 24)], [(128, 65), (122, 74), (114, 82), (111, 86), (119, 89), (126, 88), (128, 78), (131, 70)]]
lost = (head[..., 3] < 250) | (mask(PAINTED[0]) > 0) | (mask(PAINTED[1]) > 0)
fresh = nd.gaussian_filter(nd.binary_dilation(lost & keep, iterations=5).astype(np.float32), 1.5)[..., None]
head[..., :3] = ink * fresh + head[..., :3] * (1 - fresh)
head[..., 3] = alpha
sheet.paste(Image.fromarray(head.round().astype(np.uint8), 'RGBA'), (x0, y0 - UP))
p['v1'] = round(1 - (y0 - UP) / H, 5); p['aspect'] = round(w / (y1 - y0 + UP), 5)

# every figure's own tone carried out under the clear pixels round it
a = np.array(sheet); solid = a[..., 3] > 128
far, near = nd.distance_transform_edt(~solid, return_indices=True)
bled = a[..., :3][near[0], near[1]]
a[..., :3] = np.where((a[..., 3:] == 0) & (far[..., None] < 24), bled, a[..., :3])
Image.fromarray(a, 'RGBA').save(f'{out}.webp', quality=86, alpha_quality=95, method=6, exact=True)
json.dump(places, open(f'{out}.json', 'w'))
print('restored', p)
