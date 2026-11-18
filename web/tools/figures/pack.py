# Print the cut figures in one ink and pack them into the page's sheet, each 960 px high, with their places in it.
#   python3 -I tools/figures/pack.py <work dir> public/assets/figures
# The plates are hand-coloured; the page shows them as cut from an uncoloured print: grey, with the
# contrast drawn up, in a brown-black ink on cream paper. Each figure's edge is taken in a pixel and
# softened, and its own tone is carried out under the clear pixels round it, so that no pale or dark
# fringe shows when the sheet is drawn small.
import json, sys
import numpy as np, cv2
from scipy import ndimage

work, out = sys.argv[1:]
N = ['00', '01', '02', '03', '05', '07', '09', '10', '13', '14', '16']
FACE = {'00': 1, '01': 1, '02': 0, '03': 0, '05': -1, '07': -1, '09': 1, '10': 0, '13': 1, '14': 0, '16': -1}   # which way each looks on its plate
H, W, ROW, PAD = 960, 4096, 1024, 24
INK, PAPER = np.array([0x10, 0x16, 0x1d], np.float32), np.array([0xcc, 0xe2, 0xec], np.float32)                    # BGR

figs = []
for n in N:
    img, mask = cv2.imread(f'{work}/k{n}.png'), cv2.imread(f'{work}/m{n}.png', cv2.IMREAD_GRAYSCALE)
    ys, xs = np.nonzero(mask)
    img, mask = img[ys.min():ys.max() + 1, xs.min():xs.max() + 1], mask[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    grey = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255
    white = np.percentile(grey[mask > 0], 97)                               # the plate's own paper, wherever it shows in the figure
    grey = np.clip(grey / white, 0, 1)
    s = lambda x: 1 / (1 + np.exp(-5 * (x - 0.6)))
    tone = (s(grey) - s(0)) / (s(1) - s(0))
    ink = INK + (PAPER - INK) * tone[..., None]
    k = H / mask.shape[0]
    w = max(1, round(mask.shape[1] * k))
    ink = cv2.resize(ink, (w, H), interpolation=cv2.INTER_AREA)
    a = cv2.resize(mask, (w, H), interpolation=cv2.INTER_AREA)
    solid = a > 127
    alpha = cv2.GaussianBlur(cv2.erode(solid.astype(np.uint8) * 255, np.ones((3, 3), np.uint8)), (0, 0), 0.7)
    near = ndimage.distance_transform_edt(~solid, return_distances=False, return_indices=True)
    ink = ink[near[0], near[1]]
    feet = np.nonzero(solid[-48:].any(0))[0]
    figs.append((n, np.dstack([ink, alpha]).astype(np.uint8), float(feet.mean()) / w))

total = sum(f.shape[1] + PAD for _, f, _ in figs)
assert total <= 2 * W, f'the figures are {total} px wide together: more than two rows hold'
sheet = np.zeros((2 * ROW, W, 4), np.uint8); x = y = 0; places = []
for n, f, feet in figs:
    w = f.shape[1]
    if x + w > W: x, y = 0, y + ROW
    assert y < 2 * ROW, 'a third row would be needed'
    top = y + (ROW - H) // 2
    sheet[top:top + H, x:x + w] = f
    places.append({'plate': n, 'u0': round(x / W, 5), 'u1': round((x + w) / W, 5), 'v0': round(1 - (top + H) / (2 * ROW), 5), 'v1': round(1 - top / (2 * ROW), 5),
                   'aspect': round(w / H, 5), 'face': FACE[n], 'feet': round(feet, 5)})
    x += w + PAD
cv2.imwrite(f'{out}.webp', sheet, [cv2.IMWRITE_WEBP_QUALITY, 86])
json.dump(places, open(f'{out}.json', 'w'))
print(len(places), 'figures,', total, 'px across')
