"""
Tiling stone, ground and foliage textures for the web page, as JPEG colour + normal.
Noise is built in frequency space, so every texture wraps seamlessly.

  /Applications/Blender.app/Contents/Resources/5.0/python/bin/python3.11 scripts/make_web_textures.py
"""
import numpy as np, os, zlib, struct, subprocess

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "web", "public", "assets", "tex")
os.makedirs(OUT, exist_ok=True)
rng = np.random.default_rng(1784)


def fractal(n, beta=2.0, ax=1.0, ay=1.0):
    """Periodic 1/f^beta noise in 0..1. ax, ay stretch the grain along x, y."""
    fx = np.fft.fftfreq(n)[None, :] * n * ax
    fy = np.fft.fftfreq(n)[:, None] * n * ay
    f = np.sqrt(fx * fx + fy * fy); f[0, 0] = 1
    spec = (rng.normal(size=(n, n)) + 1j * rng.normal(size=(n, n))) / f ** (beta / 2)
    spec[0, 0] = 0
    a = np.fft.ifft2(spec).real
    lo, hi = np.percentile(a, [0.5, 99.5])
    return np.clip((a - lo) / (hi - lo), 0, 1)


def smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def normal_map(h, strength):
    dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * strength
    dy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * strength
    n = np.stack([-dx, dy, np.ones_like(h)], axis=2)
    return n / np.linalg.norm(n, axis=2, keepdims=True) * 0.5 + 0.5


def to_srgb_bytes(rgb):
    return (np.clip(rgb, 0, 1) * 255 + 0.5).astype(np.uint8)


def write(name, rgb):
    q = 62 if name.endswith("_n") else 78
    h, w = rgb.shape[:2]
    raw = b"".join(b"\0" + r.tobytes() for r in to_srgb_bytes(rgb))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    png = os.path.join(OUT, name + ".png")
    with open(png, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) +
                chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))
    subprocess.run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", str(q), png,
                    "--out", os.path.join(OUT, name + ".jpg")], check=True, capture_output=True)
    os.remove(png)
    print(name, os.path.getsize(os.path.join(OUT, name + ".jpg")) // 1024, "KB")


def tint(base, amount):
    return np.array(base)[None, None, :] * amount[..., None]


def masonry(n, cols, rows, joint, jitter, base, mortar, strength, name):
    """Running-bond blocks. joint is the mortar width as a fraction of a row."""
    y, x = np.mgrid[0:n, 0:n] / n
    r = np.floor(y * rows).astype(int)
    u = x * cols + (r % 2) * 0.5
    c = np.floor(u).astype(int) % cols
    fx, fy = u - np.floor(u), y * rows - r
    aspect = rows / cols
    d = np.minimum(np.minimum(fx, 1 - fx) / aspect, np.minimum(fy, 1 - fy))
    edge = smooth(0, joint, d)
    ids = rng.normal(0, 1, size=(rows, cols))
    block = ids[r, c]
    # each block has its own grain and dressing
    grain = fractal(n, 1.6)
    fine = fractal(n, 1.0)
    pits = smooth(0.70, 0.9, fractal(n, 0.7))
    h = edge * (0.75 + 0.02 * block) + 0.14 * grain + 0.06 * fine - 0.12 * pits * edge
    light = (1 + jitter * block) * (0.88 + 0.2 * grain) * (1 - 0.1 * pits)
    rgb = tint(base, light) * edge[..., None] + np.array(mortar)[None, None, :] * (1 - edge[..., None])
    write(name, rgb)
    write(name + "_n", normal_map(h, strength))


LIME = (0.80, 0.755, 0.665)          # Lutetian limestone, sRGB
masonry(1536, 6, 12, 0.035, 0.045, LIME, (0.55, 0.52, 0.46), 7.0, "ashlar")
masonry(1024, 4, 8, 0.02, 0.05, (0.83, 0.79, 0.71), (0.5, 0.47, 0.42), 2.5, "paving")

# dressed stone: almost plain, faint rain streaks
n = 1024
g, s, f = fractal(n, 2.2), fractal(n, 1.8, 1, 0.12), fractal(n, 0.9)
write("stone", tint(LIME, 0.93 + 0.1 * (g - 0.5) + 0.1 * (s - 0.5) + 0.03 * (f - 0.5)))
write("stone_n", normal_map(0.5 * g + 0.25 * f, 0.9))

# gravel
g, m = fractal(n, 0.55), fractal(n, 2.0)
peb = smooth(0.35, 0.7, g)
write("gravel", tint((0.74, 0.70, 0.62), 0.62 + 0.42 * peb + 0.1 * (m - 0.5)))
write("gravel_n", normal_map(peb, 3.5))

# soil with needle litter
g, nd = fractal(512, 1.2), smooth(0.6, 0.85, fractal(512, 0.8, 1, 0.25))
write("soil", tint((0.30, 0.22, 0.15), 0.6 + 0.6 * g + 0.5 * nd))

# meadow: short blades, slightly directional
b, c = fractal(n, 0.8, 1, 0.3), fractal(n, 2.2)
grass = np.stack([0.20 + 0.22 * b + 0.10 * c, 0.33 + 0.26 * b + 0.06 * c, 0.09 + 0.10 * b], axis=2)
write("grass", grass)
write("grass_n", normal_map(b, 2.0))

# cypress foliage: dense upright sprays, deep dark crevices
a, b = fractal(n, 1.2, 1, 0.22), fractal(n, 0.8, 1, 0.3)
h = 0.65 * a + 0.35 * b
deep = smooth(0.22, 0.62, h)[..., None]
leaf = np.array((0.235, 0.325, 0.165))[None, None, :] * (0.72 + 0.55 * b[..., None])
write("cypress", np.array((0.035, 0.055, 0.035))[None, None, :] * (1 - deep) + leaf * deep)
write("cypress_n", normal_map(h, 5.0))
