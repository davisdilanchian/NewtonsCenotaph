# Pack the inked figures into one sheet, trimmed to their outlines, each 960 px high, with their places in it.
import json, subprocess, sys
d, out = sys.argv[1], sys.argv[2]
N = ['00', '01', '02', '03', '05', '07', '09', '10', '13', '14', '16']
H, W, ROW, PAD = 960, 4096, 1024, 24
x = y = 0; places = []; layers = []
for n in N:
    subprocess.run(['magick', f'{d}/e{n}.png', '-alpha', 'background', '-bordercolor', 'none', '-border', '1', '-trim', '+repage', '-resize', f'x{H}', f'{d}/a{n}.png'], check=True)
    w = int(subprocess.check_output(['magick', 'identify', '-format', '%w', f'{d}/a{n}.png']))
    if x + w > W: x, y = 0, y + ROW
    layers += [f'{d}/a{n}.png', '-geometry', f'+{x}+{y + (ROW - H) // 2}', '-composite']
    places.append({'plate': n, 'u0': x / W, 'u1': (x + w) / W, 'v0': 1 - (y + (ROW - H) // 2 + H) / (2 * ROW), 'v1': 1 - (y + (ROW - H) // 2) / (2 * ROW), 'aspect': w / H})
    x += w + PAD
subprocess.run(['magick', '-size', f'{W}x{2 * ROW}', 'xc:none', *layers, '-define', 'webp:alpha-quality=90', '-quality', '86', f'{out}.webp'], check=True)
json.dump([{k: round(v, 5) if isinstance(v, float) else v for k, v in p.items()} for p in places], open(f'{out}.json', 'w'))
print(len(places), 'rows end at', y + ROW)
