# Usage, after fetch.py, with boxes.json and ground.json copied into the work dir:
#   python3 -I tools/figures/cut.py <work dir>   then   python3 -I tools/figures/atlas.py <work dir> public/assets/figures
# Cut the figures out of their plates: crop, mark everything that differs from the paper, fill the
# enclosed parts, wipe the plate's ruled border and the painted ground, keep the figure, drop stray marks,
# and print what is left as ink on paper.
import json, subprocess, sys
d = sys.argv[1]
BOX = json.load(open(f'{d}/boxes.json'))
GROUND = json.load(open(f'{d}/ground.json'))
T = sys.argv[2] if len(sys.argv) > 2 else '11'
def run(*a): subprocess.run(['magick', *a], check=True)
def out(*a): return subprocess.check_output(['magick', *a]).decode()

def read_pgm(p):
    b = open(p, 'rb').read()
    parts = b.split(maxsplit=4)
    w, h = int(parts[1]), int(parts[2])
    return w, h, bytearray(parts[4][-w * h:])

def write_pgm(p, w, h, px):
    open(p, 'wb').write(b'P5\n%d %d\n255\n' % (w, h) + bytes(px))

def clean(p, ground):
    w, h, px = read_pgm(p)
    row = lambda y: sum(px[y * w + x] > 127 for x in range(w)) / w
    col = lambda x: sum(px[y * w + x] > 127 for y in range(h)) / h
    # ruled lines along the plate's frame: long and thin, with little either side of them
    at = lambda f, i, n: f(i) if 0 <= i < n else 0
    thin = lambda f, i, n: f(i) > 0.3 and at(f, i - 6, n) < 0.2 and at(f, i + 6, n) < 0.2
    rows = [y for y in list(range(int(h * 0.1))) + list(range(int(h * 0.9), h)) if thin(row, y, h)]
    cols = [x for x in list(range(int(w * 0.1))) + list(range(int(w * 0.9), w)) if thin(col, x, w)]
    for y in rows:
        for yy in range(max(0, y - 2), min(h, y + 3)):
            for x in range(w): px[yy * w + x] = 0
    for x in cols:
        if True:
            for xx in range(max(0, x - 2), min(w, x + 3)):
                for y in range(h): px[y * w + xx] = 0
    if ground:
        yg, a, b = ground
        for y in range(int(yg * h), h):
            for x in range(w):
                if x < a * w or x > b * w: px[y * w + x] = 0
    write_pgm(p, w, h, px)

for key, (x0, y0, x1, y1) in BOX.items():
    n = int(key); src = f'{d}/f{n:02d}.jpg'
    w, h = map(int, out('identify', '-format', '%w %h', src).split())
    sx, sy = w / 300, h / 420
    crop = f'{round((x1 - x0) * sx)}x{round((y1 - y0) * sy)}+{round(x0 * sx)}+{round(y0 * sy)}'
    k = f'{d}/k{n:02d}.png'
    run(src, '-crop', crop, '+repage', k)
    # the paper is the lightest of the four corners
    corners = [out(k, '-gravity', g, '-crop', '14x14+3+3', '+repage', '-resize', '1x1!', '-format', '%[fx:luminance] %[pixel:p{0,0}]', 'info:').split(' ', 1)
               for g in ('northwest', 'northeast', 'southwest', 'southeast')]
    bg = max(corners, key=lambda c: float(c[0]))[1]
    m = f'{d}/m{n:02d}.pgm'
    run(k, '(', '+clone', '-fill', bg, '-colorize', '100', ')', '-compose', 'difference', '-composite',
        '-colorspace', 'gray', '-threshold', f'{T}%', '-depth', '8', m)
    clean(m, GROUND.get(key))                        # the ruled lines go while they are still thin
    run(m, '-morphology', 'close', 'disk:7',         # seal gaps in the engraved outline so faces and pale silk count as enclosed
        '-bordercolor', 'black', '-border', '2', '-fill', 'gray50', '-draw', 'color 0,0 floodfill',
        '-fill', 'white', '+opaque', 'gray50', '-fill', 'black', '-opaque', 'gray50', '-shave', '2', '-depth', '8', m)
    clean(m, GROUND.get(key))
    run(m, '-define', 'connected-components:area-threshold=20000', '-define', 'connected-components:mean-color=true',
        '-connected-components', '8', '-threshold', '50%', f'{d}/m{n:02d}.png')
    run(k, '(', f'{d}/m{n:02d}.png', '-morphology', 'erode', 'disk:1', '-blur', '0x0.8', ')',
        '-alpha', 'off', '-compose', 'copy-opacity', '-composite', f'{d}/c{n:02d}.png')
    run(f'{d}/c{n:02d}.png', '(', '+clone', '-alpha', 'extract', ')', '(', f'{d}/c{n:02d}.png', '-alpha', 'off', '-colorspace', 'gray',
        '-sigmoidal-contrast', '4,55%', '+level-colors', '#1d1610,#ece2cc', ')', '-delete', '0', '+swap', '-compose', 'copy-opacity', '-composite', f'{d}/e{n:02d}.png')
    print(n, bg, flush=True)
