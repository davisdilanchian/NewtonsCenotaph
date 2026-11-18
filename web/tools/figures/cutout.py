# Cut the figures out of their plates, from the plates themselves (1920 px wide, as fetched from Commons).
#   python3 -I tools/figures/cutout.py <dir of p<plate>.jpg> <work dir> [plate ...]
# A figure is everything the engraver or the colourist touched: whatever differs from the bare paper in
# colour, or is darker than the paper round it by a hair (which finds the fine line of a pale face), with
# what those lines enclose. What that also takes in and should not (the ground the figure stands on, the
# paper shut in between two figures) is taken out by hand, from shapes drawn in trace.json; what it
# misses is put back from the same file. Writes c<plate>.png, the figure on clear, and v<plate>.jpg to check it by.
import json, os, sys
import numpy as np, cv2
from scipy import ndimage

here = os.path.dirname(os.path.abspath(__file__))
src, work, *only = sys.argv[1:]
BOX = json.load(open(f'{here}/boxes.json'))
TRACE = json.load(open(f'{here}/trace.json')) if os.path.exists(f'{here}/trace.json') else {}

def disk(r):
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))

for key, (x0, y0, x1, y1) in BOX.items():
    n = f'{int(key):02d}'
    if only and n not in only or not os.path.exists(f'{src}/p{n}.jpg'): continue
    plate = cv2.imread(f'{src}/p{n}.jpg')
    if plate is None: continue
    h, w = plate.shape[:2]; sx, sy = w / 300, h / 420
    img = plate[round(y0 * sy):round(y1 * sy), round(x0 * sx):round(x1 * sx)]
    t = TRACE.get(n, {})
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB).astype(np.float32)
    L = cv2.GaussianBlur(lab[..., 0], (0, 0), 1.0)
    # the paper as it is at each place: the lightest thing near it
    paper = cv2.GaussianBlur(cv2.morphologyEx(L, cv2.MORPH_CLOSE, disk(40)), (0, 0), 25)
    ab = cv2.GaussianBlur(lab[..., 1:], (0, 0), 1.5)
    edge = np.concatenate([lab[:12].reshape(-1, 3), lab[-12:].reshape(-1, 3), lab[:, :12].reshape(-1, 3), lab[:, -12:].reshape(-1, 3)])
    tint = np.median(edge[:, 1:], axis=0)
    coloured = np.hypot(ab[..., 0] - tint[0], ab[..., 1] - tint[1]) > t.get('colour', 15)
    inked = (paper - L) > t.get('ink', 11)
    mark = (coloured | inked).astype(np.uint8)
    for poly in t.get('erase', []): cv2.fillPoly(mark, [np.array(poly, np.int32)], 0)       # the ground, a ruled line, a caption
    count, lab_, stats, _ = cv2.connectedComponentsWithStats(mark, connectivity=8)
    mark = np.isin(lab_, [i for i in range(1, count) if stats[i, cv2.CC_STAT_AREA] >= 40]).astype(np.uint8)
    shut = cv2.morphologyEx(mark, cv2.MORPH_CLOSE, disk(t.get('close', 6)))
    for poly in t.get('open', []): cv2.fillPoly(shut, [np.array(poly, np.int32)], 0)        # a way in for the paper, where two outlines shut it in
    solid = ndimage.binary_fill_holes(shut).astype(np.uint8)
    # paper the outlines shut in, between two figures or a pair of legs: each named by a point inside it
    _, holes = cv2.connectedComponents((solid & (1 - shut)).astype(np.uint8), connectivity=4)
    for x, y in t.get('paper', []):
        if holes[y, x]: solid[cv2.dilate((holes == holes[y, x]).astype(np.uint8), disk(t.get('close', 6) - 2)) > 0] = 0
    for poly in t.get('erase', []) + t.get('open', []): cv2.fillPoly(solid, [np.array(poly, np.int32)], 0)
    for poly in t.get('keep', []): cv2.fillPoly(solid, [np.array(poly, np.int32)], 1)
    solid = cv2.morphologyEx(solid, cv2.MORPH_OPEN, disk(1))
    count, lab_, stats, _ = cv2.connectedComponentsWithStats(solid, connectivity=8)
    big = max(stats[1:, cv2.CC_STAT_AREA])
    solid = np.isin(lab_, [i for i in range(1, count) if stats[i, cv2.CC_STAT_AREA] >= t.get('part', 0.02) * big]).astype(np.uint8)
    cv2.imwrite(f'{work}/m{n}.png', solid * 255)
    cv2.imwrite(f'{work}/k{n}.png', img)
    # to check by: the plate dimmed outside the cut, the cut's edge in red, and a grid to trace against
    view = img.copy(); view[solid == 0] = (view[solid == 0] * 0.45 + np.array([150, 60, 150]) * 0.55).astype(np.uint8)
    cv2.drawContours(view, cv2.findContours(solid, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)[0], -1, (0, 0, 255), 1)
    kept = ((holes > 0) & (solid > 0)).astype(np.uint8)
    cnt, hl, hs, hc = cv2.connectedComponentsWithStats(kept, connectivity=4)
    for i in range(1, cnt):                          # what was filled as enclosed: blue where it is big enough to be worth a look
        if hs[i, cv2.CC_STAT_AREA] > 500: cv2.drawContours(view, cv2.findContours((hl == i).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)[0], -1, (255, 80, 0), 1)
    for gx in range(0, view.shape[1], 100): cv2.line(view, (gx, 0), (gx, view.shape[0]), (255, 255, 0), 1); cv2.putText(view, str(gx), (gx + 3, 14), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 255), 1)
    for gy in range(0, view.shape[0], 100): cv2.line(view, (0, gy), (view.shape[1], gy), (255, 255, 0), 1); cv2.putText(view, str(gy), (3, gy + 14), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 255), 1)
    cv2.imwrite(f'{work}/v{n}.jpg', view, [cv2.IMWRITE_JPEG_QUALITY, 88])
    print(n, img.shape[1], 'x', img.shape[0], flush=True)
