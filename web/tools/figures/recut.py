# Usage, on the sheet that cut.py and atlas.py make (written to a work dir as <work dir>/figures.webp and .json):
#   python3 -I tools/figures/recut.py <work dir>/figures tools/figures/recut.json public/assets/figures [<preview dir>]
# Trim each figure to its engraved outline: peel the paper left round it back to the first inked line,
# take out the ground, the paper trapped between figures and the stray marks by the hand-drawn shapes in
# recut.json, soften the edge, and carry the figure's own tone out past it so no pale fringe is drawn.
# Shapes are in each figure's own pixels on the 960 px high sheet: "cut" removes everything inside and
# then runs on a few pixels over bare paper to the inked line, "paper" removes every pale pixel inside, "flood" the pale pixels joined to what is already gone, and "keep"
# guards pale cloth and stockings from them. "face" is the way the figure looks on the sheet: -1 left, 1 right, 0 out
# at you; it is written to the places with "feet", how far across the figure its feet or hem stand. Needs numpy, scipy and Pillow.
import json, sys
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as nd

src, shapes, out = sys.argv[1:4]
preview = sys.argv[4] if len(sys.argv) > 4 else None
SHAPES = json.load(open(shapes))
H, W, ROW, PAD = 960, 4096, 1024, 24
PALE, PEEL, GROW, SPECK = 196, 0, 10, 260                 # what counts as bare paper, how far in the peel may go, the smallest piece kept
FOUR = nd.generate_binary_structure(2, 1)

def area(size, polys):
    m = Image.new('1', size, 0)
    for p in polys: ImageDraw.Draw(m).polygon([tuple(q) for q in p], fill=1)
    return np.array(m, bool)

def recut(im, s):
    rgb = np.asarray(im.convert('RGB'), np.float32); a = np.asarray(im.getchannel('A')) > 127
    lum = rgb @ np.array([0.299, 0.587, 0.114], np.float32)
    get = lambda k: area(im.size, s.get(k, []))
    pale = (lum > s.get('pale', PALE)) & ~get('keep')
    cut = get('cut')
    cut = nd.binary_dilation(cut, FOUR, iterations=s.get('grow', GROW), mask=cut | pale)   # each cut runs on over bare paper to the inked line
    gone = ~a | cut | (get('paper') & pale)
    if s.get('peel', PEEL): gone = nd.binary_dilation(gone, FOUR, iterations=s.get('peel', PEEL), mask=gone | pale)   # back toward the first inked line
    fl = get('flood')
    if fl.any(): gone = nd.binary_dilation(gone, FOUR, iterations=0, mask=gone | (pale & fl))
    keep = ~gone
    keep = nd.binary_opening(keep, FOUR) | (keep & get('thin'))            # whiskers of ground hatching; canes and fans are marked thin
    lab, n = nd.label(keep, np.ones((3, 3)))
    if n > 1:
        sizes = nd.sum(keep, lab, range(1, n + 1))
        keep = np.isin(lab, [i + 1 for i, v in enumerate(sizes) if v >= SPECK])
    holes = nd.binary_fill_holes(keep) & ~keep                             # pinholes the peel opened inside the ink
    hl, hn = nd.label(holes)
    if hn:
        hs = nd.sum(holes, hl, range(1, hn + 1))
        keep |= np.isin(hl, [i + 1 for i, v in enumerate(hs) if v < 30])
    # a soft edge just inside the outline, and the figure's own tone carried out past it
    soft = nd.gaussian_filter(nd.binary_erosion(keep, FOUR).astype(np.float32), 0.8)
    alpha = np.clip((soft - 0.12) / 0.76, 0, 1)
    solid = nd.binary_erosion(keep, FOUR, iterations=2)
    idx = nd.distance_transform_edt(~solid, return_distances=False, return_indices=True)
    bled = rgb[idx[0], idx[1]]
    for c in range(3): bled[..., c] = np.where(solid, rgb[..., c], nd.gaussian_filter(bled[..., c], 1.5))
    res = Image.fromarray(np.dstack([bled, alpha * 255]).round().astype(np.uint8), 'RGBA')
    ys, xs = np.nonzero(alpha > 0.5)
    return res, (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)

sheet = Image.open(src + '.webp').convert('RGBA'); SW, SH = sheet.size
atlas = Image.new('RGBA', (W, 2 * ROW), (0, 0, 0, 0)); places = []; x = y = 0
for p in json.load(open(src + '.json')):
    n = p['plate']; s = SHAPES.get(n, {})
    fig = sheet.crop((round(p['u0'] * SW), round((1 - p['v1']) * SH), round(p['u1'] * SW), round((1 - p['v0']) * SH)))
    full, box = recut(fig, s); cut = full.crop(box)
    if preview:
        for name, im in (('before', fig), ('after', full)):
            bg = Image.new('RGBA', im.size, (30, 110, 220, 255)); bg.alpha_composite(im); bg.convert('RGB').save(f'{preview}/{name}{n}.png')
    w = round(cut.width * H / cut.height); cut = cut.resize((w, H), Image.LANCZOS)
    if x + w > W: x, y = 0, y + ROW
    top = y + (ROW - H) // 2
    atlas.paste(cut, (x, top))
    low = np.nonzero(np.asarray(cut.getchannel('A'))[int(H * 0.95):] > 127)[1]          # where the feet or the hem stand
    places.append({'plate': n, 'u0': x / W, 'u1': (x + w) / W, 'v0': 1 - (top + H) / (2 * ROW), 'v1': 1 - top / (2 * ROW), 'aspect': w / H,
                   'face': s.get('face', 0), 'feet': s.get('feet', float(low.mean()) / w)})
    x += w + PAD
# colour under clear pixels is kept, so the sheet's smaller copies don't darken at the edges
atlas.save(out + '.webp', quality=86, alpha_quality=95, method=6, exact=True)
json.dump([{k: round(v, 5) if isinstance(v, float) else v for k, v in p.items()} for p in places], open(out + '.json', 'w'))
print(len(places), 'figures, rows end at', y + ROW)
