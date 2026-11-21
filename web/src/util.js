// Small shared helpers.
import * as THREE from 'three';
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// The monument is its published 150 m. Screens shrink the sense of size, so the walker, the visitors,
// the stone courses and the ground grain are drawn at 1/SCALE, which puts the camera lower and slows
// it. Try another with ?scale=2, or ?scale=1 for true eye height.
export const SCALE = clamp(+new URLSearchParams(location.search).get('scale') || 3, 1, 8);

export function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const hash = (x, y, z) => { const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return s - Math.floor(s); };

/** Smooth value noise in 0..1. */
export function noise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const f = (t) => t * t * (3 - 2 * t);
  const u = f(x - xi), v = f(y - yi), w = f(z - zi);
  const c = (a, b, d) => hash(xi + a, yi + b, zi + d);
  return lerp(lerp(lerp(c(0, 0, 0), c(1, 0, 0), u), lerp(c(0, 1, 0), c(1, 1, 0), u), v),
              lerp(lerp(c(0, 0, 1), c(1, 0, 1), u), lerp(c(0, 1, 1), c(1, 1, 1), u), v), w);
}

// How open to the sky each pixel of the picture is, measured from the depth of the stone and ground
// before they are drawn (post.js), and read by them as they are drawn, so it dims the sky's light in
// corners and leaves the sun's alone. While it is off, or for a reflection, it reads as fully open.
export const SHADE = { map: { value: null }, texel: { value: new THREE.Vector2(1, 1) }, on: { value: 0 } };
export const OCCLUDERS = 2;                       // the layer of what is measured for it

// The plan of what lies under the sphere's floor, as scripts/build_scene.py builds it, in the page's axes
// (the front is +z). The crypt under the tomb is a cross of four arms, each with a way out through
// a face of the dais; four passages run in to it, the front one from the arch and wider at its mouth.
export function cryptPlan(x, z, pad = 0) {
  const ax = Math.abs(x), az = Math.abs(z), lo = Math.min(ax, az), hi = Math.max(ax, az);
  return (hi < 8.4 + pad && lo < 4 + pad) || (lo < 1.2 + pad && hi < 16 + pad);
}
/** How far into a passage a point is, from where daylight ends at its mouth; -Infinity outside them all. */
export function passageDepth(x, z) {
  const ax = Math.abs(x), az = Math.abs(z);
  let depth = -Infinity;
  if (ax < 7.3 && z > 2 && z < 112) depth = 103.5 - z;                      // from just inside the wall's face, so the face itself stays in daylight
  if (az < 3.6 && ax < 125) depth = Math.max(depth, 118.5 - ax);
  if (ax < 3.6 && z < -2 && z > -125) depth = Math.max(depth, 118.5 + z);
  return depth;
}
