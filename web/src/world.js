// Everything in the scene: stone from the Blender model, instanced cypresses, ground,
// basin, sky, and the star vault.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { Reflector } from './mirror.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';
import { noise3, rng, smooth, SCALE } from './util.js';
import { makeVisitors } from './visitors.js';
import { makeSunshafts } from './sunshafts.js';

export const CENTER = new THREE.Vector3(0, 73.5, 0);        // sphere centre
export const SUN = new THREE.Vector3();

/** Sun across the day, u from 0 to 1: rising on the left, over the front, setting on the right. */
export function placeSun(u) {
  const a = THREE.MathUtils.degToRad(-176 + 168 * u), e = THREE.MathUtils.degToRad(12 + 56 * Math.sin(Math.PI * u));
  return SUN.set(Math.cos(e) * Math.cos(a), Math.sin(e), -Math.cos(e) * Math.sin(a));
}

// matches the hills in scripts/build_scene.py
export function groundHeight(x, z) {
  const y = -z, d = Math.hypot(x, y), k = Math.max(0, (d - 900) / 2600);
  if (k === 0) return 0;
  return (Math.sin(x * 0.0021 + 1.3) * Math.cos(y * 0.0017 - 0.4) + 0.6 * Math.sin(x * 0.0047 + y * 0.0031)) * 70 * k ** 1.4;
}

const NOT_SOLID = new Set(['Main stair', 'Front stair block', 'Planting beds', 'Lions', 'Funeral brazier', 'Inscription',
                           'Esplanade and walks', 'Drum dentils', 'Bridge portal door', 'Sarcophagus dais', 'Passage stairs']);
// of those, the ones walked over on a slope, whose real treads the visitors stand on
const STEPPED = new Set(['Main stair', 'Front stair block', 'Esplanade and walks', 'Sarcophagus dais', 'Passage stairs']);

// ------------------------------------------------------------------ texturing
function load(name, srgb, renderer, manager) {
  const t = new THREE.TextureLoader(manager).load(`assets/tex/${name}.jpg`);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const SKY_LEVEL = { value: 1 };                 // follows the height of the sun

/** Weather that repeats nowhere: broad tonal drift, rain streaks, and the sphere's stone courses. */
function weathered(mat, { streaks = 1, courses = false, level = 1, loose = false, carved = false } = {}) {
  mat.onBeforeCompile = (s) => {
    s.uniforms.skyLevel = SKY_LEVEL;
    s.vertexShader = s.vertexShader.replace('#include <common>', `#include <common>\nvarying vec3 vWP, vBaked; attribute vec3 baked;${carved ? ' attribute float cavity; varying float vCavity;' : ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvWP = (modelMatrix * vec4(position, 1.0)).xyz; vBaked = baked;${carved ? ' vCavity = cavity;' : ''}`);
    s.fragmentShader = s.fragmentShader.replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
      #ifdef USE_ENVMAP
        iblIrradiance = vec3(0.0);                    // diffuse sky comes from the path traced bake instead
        radiance = vec3(0.0);                         // and the sky isn't reflected, or it would shine indoors too
      #endif
      irradiance += vBaked * skyLevel * ${level.toFixed(3)};`)
      .replace('#include <common>', `#include <common>
      varying vec3 vWP, vBaked; uniform float skyLevel;${carved ? ' varying float vCavity;' : ''}
      float vh(vec3 p) { p = fract(p * 0.3183 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      float vn(vec3 p) { vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(vh(i), vh(i + vec3(1, 0, 0)), f.x), mix(vh(i + vec3(0, 1, 0)), vh(i + vec3(1, 1, 0)), f.x), f.y),
                   mix(mix(vh(i + vec3(0, 0, 1)), vh(i + vec3(1, 0, 1)), f.x), mix(vh(i + vec3(0, 1, 1)), vh(i + vec3(1, 1, 1)), f.x), f.y), f.z); }
      float fb(vec3 p) { return 0.55 * vn(p) + 0.3 * vn(p * 2.1 + 3.1) + 0.15 * vn(p * 4.3 + 7.7); }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
      ${loose ? `vec3 again = texture2D(map, mat2(0.8, 0.6, -0.6, 0.8) * vMapUv * 0.231 + 0.37).rgb;   // the same gravel turned and far larger, so no tile repeats
      diffuseColor.rgb = mix(diffuseColor.rgb, diffuse * again, 0.5) * (0.9 + 0.2 * fb(vWP * 0.9));` : ''}
      diffuseColor.rgb *= 0.8 + 0.3 * fb(vWP * 0.016) + 0.1 * fb(vWP * 0.13);
      ${carved ? `float hollow = clamp(vCavity, 0.0, 1.0), proud = clamp(-vCavity, 0.0, 1.0);          // carving: grime gathers in the cuts, and weather pales what stands proud
      diffuseColor.rgb = mix(diffuseColor.rgb * (1.0 + 0.3 * proud), diffuseColor.rgb * vec3(0.3, 0.29, 0.26), 0.85 * hollow * hollow + 0.3 * hollow);` : ''}
      float lng = atan(vWP.z, vWP.x), upright = 1.0 - abs(normalize(cross(dFdx(vWP), dFdy(vWP))).y);
      diffuseColor.rgb *= 1.0 - ${streaks.toFixed(1)} * 0.2 * upright * upright * smoothstep(0.52, 0.8, fb(vec3(lng * 46.0, vWP.y * 0.016, 2.0)));
      ${courses ? `vec3 sd = normalize(vWP - vec3(0.0, 73.5, 0.0));
      float lat = asin(sd.y) * 75.0, H = ${(1.5 / SCALE).toFixed(3)}, row = floor(lat / H);
      float along = lng * 75.0 * cos(asin(sd.y)) / (H * 2.4) + 0.5 * mod(row, 2.0);
      vec2 cell = abs(fract(vec2(along, lat / H)) - 0.5) * 2.0, wide = fwidth(vec2(along, lat / H));
      float seen = 1.0 - smoothstep(0.08, 0.5, max(wide.x, wide.y));
      float joint = max(smoothstep(0.965, 0.99, cell.x), smoothstep(0.93, 0.975, cell.y));
      diffuseColor.rgb *= (1.0 - 0.3 * joint * seen) * (0.97 + 0.06 * vh(vec3(floor(along), row, 1.0)) * seen);` : ''}`);
  };
  return mat;
}

/**
 * How hollow or proud the surface is at each vertex, from how far its neighbours stand above or
 * below it: about 1 in the bottom of a cut, about -1 on a ridge.
 */
function carving(g) {
  const p = g.attributes.position, n = g.attributes.normal, key = new Map(), of = new Uint32Array(p.count), near = [];
  for (let i = 0; i < p.count; i++) {
    const k = `${Math.round(p.getX(i) * 400)},${Math.round(p.getY(i) * 400)},${Math.round(p.getZ(i) * 400)}`;
    if (!key.has(k)) { key.set(k, near.length); near.push(new Set()); }
    of[i] = key.get(k);
  }
  const ix = g.index, tri = ix ? ix.count : p.count, first = new Uint32Array(near.length).fill(0xffffffff);
  for (let i = 0; i < p.count; i++) if (first[of[i]] === 0xffffffff) first[of[i]] = i;
  for (let t = 0; t < tri; t += 3) {
    const a = of[ix ? ix.getX(t) : t], b = of[ix ? ix.getX(t + 1) : t + 1], c = of[ix ? ix.getX(t + 2) : t + 2];
    near[a].add(b).add(c); near[b].add(a).add(c); near[c].add(a).add(b);
  }
  let curve = new Float32Array(near.length);
  near.forEach((set, v) => {
    const i = first[v];
    let x = 0, y = 0, z = 0, len = 0;
    for (const w of set) { const j = first[w]; x += p.getX(j) - p.getX(i); y += p.getY(j) - p.getY(i); z += p.getZ(j) - p.getZ(i); len += Math.hypot(p.getX(j) - p.getX(i), p.getY(j) - p.getY(i), p.getZ(j) - p.getZ(i)); }
    curve[v] = set.size ? (x * n.getX(i) + y * n.getY(i) + z * n.getZ(i)) / len : 0;
  });
  for (let pass = 0; pass < 3; pass++) {            // gathered over a finger's breadth, so a cut reads as a cut and not as noise
    const next = new Float32Array(near.length);
    near.forEach((set, v) => { let sum = curve[v] * 2; for (const w of set) sum += curve[w]; next[v] = sum / (set.size + 2); });
    curve = next;
  }
  const out = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) out[i] = THREE.MathUtils.clamp(curve[of[i]] * 9, -1, 1);
  g.setAttribute('cavity', new THREE.BufferAttribute(out, 1));
}

// Where the oil lamps are the light: the passages beyond the reach of day, the stairs under the dais,
// the room beneath the tomb and its way out. 0 in daylight, 1 where only the lamps reach.
function lamplit(x, y, z) {
  if (y < 17.6 && Math.abs(x) < 3.75 && z > -16.6 && z < 3.75) return 1;
  if (y > 14.2) return 0;
  const front = Math.abs(x) < 7.3 && z > 2 && z < 112, side = Math.abs(z) < 3.6 && Math.abs(x) < 125;
  return front || side ? smooth(0, 14, Math.max(front ? 108 - z : -1e9, side ? 121 - Math.abs(x) : -1e9)) : 0;
}

/**
 * The lamps' light, worked out at every corner rather than taken from the bake, whose corners along
 * the passages are too few to hold a lamp's pool of light: faces there are first cut finer. A lamp
 * lights what faces it by the inverse square of its distance, and a little of everything near it by
 * the glow thrown back off the other walls.
 */
function lampLight(g, lamps) {
  const names = Object.keys(g.attributes), src = names.map((k) => g.attributes[k]), out = names.map(() => []);
  const P = names.indexOf('position'), pos = src[P], MAX = 0.9;
  const corner = (i) => src.map((a) => { const v = []; for (let k = 0; k < a.itemSize; k++) v.push(a.array[i * a.itemSize + k]); return v; });
  const mid = (a, b) => a.map((v, k) => v.map((x, j) => (x + b[k][j]) / 2));
  const far = (a, b) => Math.hypot(a[P][0] - b[P][0], a[P][1] - b[P][1], a[P][2] - b[P][2]);
  let cut = false;
  for (let i = 0; i < pos.count; i += 3) {
    const stack = [[corner(i), corner(i + 1), corner(i + 2)]];
    while (stack.length) {
      const [a, b, c] = stack.pop(), ab = far(a, b), bc = far(b, c), ca = far(c, a), longest = Math.max(ab, bc, ca);
      const w = lamplit((a[P][0] + b[P][0] + c[P][0]) / 3, (a[P][1] + b[P][1] + c[P][1]) / 3, (a[P][2] + b[P][2] + c[P][2]) / 3);
      if (w > 0 && longest > MAX && stack.length < 64) {
        cut = true;
        if (longest === ab) { const m = mid(a, b); stack.push([a, m, c], [m, b, c]); }
        else if (longest === bc) { const m = mid(b, c); stack.push([a, b, m], [a, m, c]); }
        else { const m = mid(c, a); stack.push([a, b, m], [m, b, c]); }
      } else for (const v of [a, b, c]) v.forEach((x, k) => out[k].push(...x));
    }
  }
  if (cut) names.forEach((k, j) => g.setAttribute(k, new THREE.BufferAttribute(new Float32Array(out[j]), src[j].itemSize)));
  const p = g.attributes.position, n = g.attributes.normal, baked = g.attributes.baked;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), w = lamplit(x, y, z);
    if (w === 0) continue;
    let e = 0;
    for (let l = 0; l < lamps.length; l += 3) {
      const dx = lamps[l] - x, dy = lamps[l + 1] - y, dz = lamps[l + 2] - z, d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > 400) continue;
      const d = Math.sqrt(d2), facing = Math.max(0, (n.getX(i) * dx + n.getY(i) * dy + n.getZ(i) * dz) / d), reach = 1 - smooth(12, 20, d);
      e += LAMP * reach * (facing + 0.22) / (d2 + 0.6);
    }
    baked.setXYZ(i, baked.getX(i) * (1 - w) + e * w, baked.getY(i) * (1 - w) + e * 0.6 * w, baked.getZ(i) * (1 - w) + e * 0.27 * w);
  }
}
const LAMP = 5.5;                             // a lamp's strength, set so the stone a stride from it glows and the far end of its reach stays dim

/** World-scale UVs per triangle: courses wrap around the rings, flat tops are laid out in plan. */
function stoneUVs(source, tile, sphere) {
  const g = source.index ? source.toNonIndexed() : source;
  const p = g.attributes.position, uv = new Float32Array(p.count * 2);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), e = new THREE.Vector3();
  const pts = [a, b, c];
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
    n.subVectors(b, a).cross(e.subVectors(c, a)).normalize();
    const cx = (a.x + b.x + c.x) / 3, cy = (a.y + b.y + c.y) / 3, cz = (a.z + b.z + c.z) / 3;
    const unwrap = (angles, period) => { const m = Math.max(...angles); return angles.map((v) => (m - v > period / 2 ? v + period : v)); };
    let us, vs;
    const R = Math.hypot(cx, cz) || 1, radial = Math.abs(n.x * cx + n.z * cz) / (R * (Math.hypot(n.x, n.z) || 1));
    const coneR = Math.hypot(cx, cy - CENTER.y);
    const onCone = cz > 0 && coneR > 68 && coneR < 84 && Math.abs((n.x * cx + n.y * (cy - CENTER.y)) / coneR) > 0.6;
    if (sphere) {
      const rad = a.distanceTo(CENTER);
      us = unwrap(pts.map((v) => Math.atan2(v.z, v.x)), Math.PI * 2).map((v) => v * rad);
      vs = pts.map((v) => Math.asin(THREE.MathUtils.clamp((v.y - CENTER.y) / rad, -1, 1)) * rad);
    } else if (Math.abs(n.y) > 0.65) {
      us = pts.map((v) => v.x); vs = pts.map((v) => v.z);
    } else if (onCone) {
      us = pts.map((v) => Math.atan2(v.x, CENTER.y - v.y) * Math.hypot(v.x, v.y - CENTER.y)); vs = pts.map((v) => v.z);
    } else if (radial > 0.85 && R > 40) {            // only the great rings: near the axis a wall is a wall, and its courses run level
      us = unwrap(pts.map((v) => Math.atan2(v.z, v.x)), Math.PI * 2).map((v, k) => v * Math.hypot(pts[k].x, pts[k].z)); vs = pts.map((v) => v.y);   // each corner at its own radius, so neighbours agree
    } else {
      us = pts.map((v) => (Math.abs(n.x) > Math.abs(n.z) ? v.z : v.x)); vs = pts.map((v) => v.y);
    }
    for (let k = 0; k < 3; k++) { uv[(i + k) * 2] = us[k] / tile; uv[(i + k) * 2 + 1] = vs[k] / tile; }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/**
 * The passage a face lies in, if any, as the line its courses run along: the front passage or the
 * east-west one, each climbing under the dais at its end. Walls and vaults then take courses that
 * run along that line and climb straight over the vault, so no joint breaks between faces.
 */
function passageAxis(x, y, z, n) {
  if (y > 13.9) return null;                                                        // the room under the tomb, and the sphere's floor and all above it
  const ax = Math.abs(x);
  if (ax < 7.3 && z > 2 && z < 112 && (z < 95 || Math.abs(n.z) < 0.7)) return { along: 'z', at: 0 };
  if (Math.abs(z) < 3.6 && ax < 125 && (ax < 115 || Math.abs(n.x) < 0.7)) return { along: 'x', at: 0 };
  return null;
}

/** The faces of the dais that lie well inside it, below its steps: the walls and roofs of the stairs and the room. */
function insideDais(mesh) {
  const g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld), src = (g.index ? g.toNonIndexed() : g).attributes.position, keep = [];
  const b = 15, tread = 0.375, rise = 0.23;                                   // the dais in build_scene.py: half widths 15 to 7.5, 20 steps of 0.23
  for (let i = 0; i < src.count; i += 3) {
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < 3; k++) { x += src.getX(i + k) / 3; y += src.getY(i + k) / 3; z += src.getZ(i + k) / 3; }
    const h = Math.max(Math.abs(x), Math.abs(z)), under = 14 + Math.max(0, b - h) / tread * rise;
    if (h < b - 0.3 && y < under - 0.35) for (let k = 0; k < 3; k++) keep.push(src.getX(i + k), src.getY(i + k), src.getZ(i + k));
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(keep, 3));
  return out;
}

/** Split a mesh's passage faces out of it: floors go to paving, walls and vaults to coursed ashlar. */
function splitPassages(g, tile) {
  const p = g.attributes.position, keys = Object.keys(g.attributes);
  const out = { rest: [], floor: [], wall: [] }, wallUV = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), e = new THREE.Vector3();
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
    n.subVectors(b, a).cross(e.subVectors(c, a)).normalize();
    const axis = passageAxis((a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3, (a.z + b.z + c.z) / 3, n);
    if (!axis) { out.rest.push(i); continue; }
    if (n.y > 0.65) { out.floor.push(i); continue; }
    out.wall.push(i);
    for (const v of [a, b, c]) {
      const along = axis.along === 'z' ? v.z : v.x, across = (axis.along === 'z' ? v.x : v.z) - axis.at;
      wallUV.push(along / tile, (v.y + Math.abs(across)) / tile);      // up the wall, then on over the vault
    }
  }
  if (!out.floor.length && !out.wall.length) return null;
  const pick = (tris) => {
    if (!tris.length) return null;
    const sub = new THREE.BufferGeometry();
    for (const k of keys) {
      const src = g.attributes[k], size = src.itemSize, arr = new Float32Array(tris.length * 3 * size);
      tris.forEach((i, t) => { for (let j = 0; j < 3 * size; j++) arr[t * 3 * size + j] = src.array[i * size + j]; });
      sub.setAttribute(k, new THREE.BufferAttribute(arr, size));
    }
    return sub;
  };
  const walls = pick(out.wall);
  if (walls) walls.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(wallUV), 2));
  return { rest: pick(out.rest), floor: pick(out.floor), walls };
}

/**
 * Daylight reaching the inside of the sphere: each bore is a small patch of sky, summed over every
 * vertex with the form factor between them. Inside a closed sphere every patch then sees every
 * other equally, so interreflection adds the same amount everywhere: mean * albedo / (1 - albedo).
 */
// One exposure serves the whole site, so the dark interior is set permanently to where the eye would
// settle in it, rather than changing the camera as you cross a threshold.
const SKY_FILL = 2.1;                        // how much stronger the sky's light in the open is than the bake has it
const INDOORS = 1000, PASSAGES = 5;      // the passages stay dim, so the eye has adjusted by the time it reaches the void

// The vault is painted black, so almost all the light that bounces round the void comes off the floor
// and the tomb, a twentieth of its surface: the void as a whole reflects about this much.
const VOID_ALBEDO = 0.07;

function skyThroughHoles(buffer, geometries, painted) {
  const count = new Uint32Array(buffer, 0, 1)[0], data = new Float32Array(buffer, 4, count * 4), STRIDE = 3;
  const hx = [], hy = [], hz = [], dx = [], dy = [], dz = [], area = [];
  for (let i = 0; i < count; i += STRIDE) {
    const o = i * 4, x = data[o], y = data[o + 1], z = data[o + 2], r = data[o + 3];
    dx.push(x); dy.push(y); dz.push(z);
    hx.push(x * 67 + CENTER.x); hy.push(y * 67 + CENTER.y); hz.push(z * 67 + CENTER.z);
    area.push(Math.PI * (0.9 * r) ** 2 * STRIDE);
  }
  let sum = 0, verts = 0;
  const fields = [...geometries, ...painted].map((g, i) => {
    const counted = i < geometries.length;
    const p = g.attributes.position, n = g.attributes.normal, E = new Float32Array(p.count);
    for (let v = 0; v < p.count; v += 3) {            // one value per triangle corner set keeps this quick
      const x = p.getX(v), y = p.getY(v), z = p.getZ(v), nx = n.getX(v), ny = n.getY(v), nz = n.getZ(v);
      let e = 0;
      for (let h = 0; h < hx.length; h++) {
        const vx = hx[h] - x, vy = hy[h] - y, vz = hz[h] - z, d2 = vx * vx + vy * vy + vz * vz;
        const at = nx * vx + ny * vy + nz * vz, from = dx[h] * vx + dy[h] * vy + dz[h] * vz;
        if (at > 0 && from > 0) e += area[h] * at * from / (Math.PI * d2 * d2);
      }
      E[v] = E[v + 1] = E[v + 2] = e;
      if (counted) { sum += e; verts++; }
    }
    return E;
  });
  const shared = (sum / verts) * VOID_ALBEDO / (1 - VOID_ALBEDO);
  [...geometries, ...painted].forEach((g, i) => {
    const E = fields[i], baked = new Float32Array(E.length * 3);
    for (let v = 0; v < E.length; v++) { const e = (E[v] + shared) * INDOORS; baked[v * 3] = e * 0.74; baked[v * 3 + 1] = e * 0.86; baked[v * 3 + 2] = e; }
    g.setAttribute('baked', new THREE.BufferAttribute(baked, 3));
  });
}

// ----------------------------------------------------------------- vegetation
// 'Stricta' outline: a slender column drawn to a point, widest below the middle
const cypressOutline = (t) => smooth(0, 0.08, t) ** 0.5 * (1 - t ** 2.6) ** 0.8;
const CYPRESS_R = 1.42, CYPRESS_BASE = 0.12;     // a cypress keeps its foliage nearly to the ground

/**
 * One tree: a dense column, as an Italian cypress is, lumpy where its upright branches press
 * together, with sprays lying close against it that break its outline. The distant versions keep the
 * column and lose the sprays.
 */
function cypressTree({ sprays, sides, rings, around, up }, seed, H) {
  const r = rng(Math.round(seed * 991) + 17), pos = [], nor = [], uv = [], col = [], idx = [];
  // the column
  const lump = (a, y) => noise3(Math.cos(a) * 1.5 + seed, y * 0.55, Math.sin(a) * 1.5) * 0.7 + noise3(Math.cos(a) * 4.1, y * 1.7 + seed, Math.sin(a) * 4.1) * 0.3;
  const body = (a, t) => CYPRESS_R * cypressOutline(t) * (0.72 + 0.4 * lump(a + t * 1.3, t * H));
  for (let j = 0; j <= up; j++) {
    const t = (j / up) ** 0.9, y = CYPRESS_BASE + t * (H - CYPRESS_BASE);
    for (let k = 0; k <= around; k++) {
      const a = ((k % around) / around) * Math.PI * 2, rad = body(a, t), l = lump(a + t * 1.3, t * H);
      pos.push(Math.cos(a) * rad, y, Math.sin(a) * rad);
      nor.push(0, 0, 0);
      uv.push((k / around) * 3, y / 2.4);
      const shade = (0.5 + 0.5 * smooth(0, 0.4, t)) * (0.5 + 0.85 * l);        // dark in the folds between its branches, and under its skirt
      col.push(shade, shade, shade);
    }
  }
  for (let j = 0; j < up; j++) for (let k = 0; k < around; k++) {
    const u = j * (around + 1) + k, v = u + around + 1;
    idx.push(u, v, u + 1, v, v + 1, u + 1);
  }
  const column = new THREE.BufferGeometry();
  column.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  column.setIndex(idx);
  column.computeVertexNormals();
  const cn = column.attributes.normal;
  for (let j = 0; j <= up; j++) {                    // the seam shades as one surface
    const u = j * (around + 1), v = u + around, x = cn.getX(u) + cn.getX(v), y = cn.getY(u) + cn.getY(v), z = cn.getZ(u) + cn.getZ(v), l = Math.hypot(x, y, z) || 1;
    cn.setXYZ(u, x / l, y / l, z / l); cn.setXYZ(v, x / l, y / l, z / l);
  }
  for (let i = 0; i < cn.count; i++) { nor[i * 3] = cn.getX(i); nor[i * 3 + 1] = cn.getY(i); nor[i * 3 + 2] = cn.getZ(i); }

  // the sprays, each rising close against the column from a spiral round it
  const fat = Math.sqrt(120 / Math.max(sprays, 1)), axis = new THREE.Vector3(), side = new THREE.Vector3(), out = new THREE.Vector3(), radial = new THREE.Vector3(), p = new THREE.Vector3();
  for (let i = 0; i < sprays; i++) {
    const t = ((i + 0.5) / sprays) ** 0.9 * 0.93, a = i * 2.39996 + (r() - 0.5) * 0.5, ca = Math.cos(a), sa = Math.sin(a);
    const length = (0.9 + r() * 0.7) * (1 - 0.35 * t) * (0.8 + 0.2 * fat), low = CYPRESS_BASE + t * (H - CYPRESS_BASE), t1 = Math.min(1, t + length / H);
    const width = Math.max(0.07, (0.13 + r() * 0.06) * fat * (1.05 - 0.5 * t));
    const hip = new THREE.Vector3(ca, 0, sa).multiplyScalar(body(a, t) * 0.8).setY(low), tip = new THREE.Vector3(ca, 0, sa).multiplyScalar(body(a, t1) * 0.9 + 0.1 + r() * 0.14).setY(low + length);
    axis.subVectors(tip, hip).normalize(); side.set(-sa, 0, ca); out.crossVectors(side, axis).negate();
    const base = pos.length / 3, tone = (0.62 + 0.4 * smooth(0, 0.4, t)) * (0.8 + r() * 0.4);
    for (let j = 0; j <= rings; j++) {
      const q0 = j / rings, swell = Math.sin(Math.PI * q0 ** 0.62) ** 0.75;
      for (let k = 0; k <= sides; k++) {
        const q = ((k % sides) / sides) * Math.PI * 2, cq = Math.cos(q), sq = Math.sin(q), w = width * swell;
        p.lerpVectors(hip, tip, q0).addScaledVector(side, cq * w).addScaledVector(out, sq * w * 0.7);
        p.x += ca * 0.12 * Math.sin(Math.PI * q0); p.z += sa * 0.12 * Math.sin(Math.PI * q0);
        pos.push(p.x, p.y, p.z);
        radial.set(ca, 0.15, sa).multiplyScalar(0.8).addScaledVector(side, cq * 0.4).addScaledVector(out, sq * 0.4).normalize();
        nor.push(radial.x, radial.y, radial.z);
        uv.push((k / sides) * 1.4, (q0 * length) / 2.4 + i * 0.37);
        const shade = tone * (0.5 + 0.62 * smooth(0.05, 0.8, q0)) * (0.82 + 0.18 * sq);
        col.push(shade, shade, shade);
      }
    }
    for (let j = 0; j < rings; j++) for (let k = 0; k < sides; k++) {
      const u = base + j * (sides + 1) + k, v = u + sides + 1;
      idx.push(u, v, u + 1, v, v + 1, u + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

class TreeHash {
  constructor(cell) { this.cell = cell; this.map = new Map(); this.out = []; }
  add(t) { const k = `${Math.floor(t.x / this.cell)},${Math.floor(t.z / this.cell)}`; (this.map.get(k) ?? this.map.set(k, []).get(k)).push(t); }
  near(x, z) {
    const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell), out = this.out;
    out.length = 0;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) { const l = this.map.get(`${cx + i},${cz + j}`); if (l) out.push(...l); }
    return out;
  }
}

function makeTrees(buffer, foliage, scene) {
  const head = new Uint32Array(buffer, 0, 2), [nTrees, nWood] = head;
  const data = new Float32Array(buffer, 8, nTrees * 6), wood = new Float32Array(buffer, 8 + nTrees * 24, nWood * 4);
  const VARIANTS = 3, heights = [10.0, 10.7, 11.2], r = rng(7), hash = new TreeHash(6);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), yAxis = new THREE.Vector3(0, 1, 0);
  const trees = [], tint = new THREE.Color();
  const bark = new THREE.MeshLambertMaterial({ color: 0x241d17 });   // in the shade of its own crown
  const trunkGeo = new THREE.CylinderGeometry(0.09, 0.17, 0.9, 6, 1, true).translate(0, 0.35, 0);
  const trunks = new THREE.InstancedMesh(trunkGeo, bark, nTrees);
  // Each detail level hands over to the next across a band of distance, its pixels thinning out in a
  // fine dither as the next one's fill in, measured from the eye every frame, so no tree ever swaps.
  const bands = { value: new THREE.Vector4() }, farBand = { value: new THREE.Vector2() }, BLEND = [3, 10, 40], FAR = 300;
  const levels = [0, 1, 2, 3].map((lod) => {
    const m = foliage.clone();
    m.defines = { LOD: lod };
    m.onBeforeCompile = (s) => {
      s.uniforms.bands = bands; s.uniforms.farBand = farBand;
      s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vTreeAt;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTreeAt = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xz;');
      s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec4 bands; uniform vec2 farBand; varying vec2 vTreeAt;')
        // close up, where the crown turns away from the eye its edge breaks into tufts, not a smooth hard outline
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          #if LOD == 0
            float rim = 1.0 - abs(dot(normalize(vNormal), normalize(vViewPosition)));
            float tuft = fract(sin(dot(floor(vMapUv * vec2(70.0, 90.0)), vec2(12.9898, 78.233))) * 43758.5453);
            if (rim > 0.66 + 0.34 * tuft) discard;
          #endif`)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
          float d = distance(vTreeAt, cameraPosition.xz), n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          float a = 1.0 - smoothstep(bands.x, bands.y, d), b = 1.0 - smoothstep(bands.z, bands.w, d);
          #if LOD == 0
            if (n >= a) discard;
          #elif LOD == 1
            if (n < a || n >= b) discard;
          #else
            float c = 1.0 - smoothstep(farBand.x, farBand.y, d);
            #if LOD == 2
              if (n < b || n >= c) discard;
            #else
              if (n < c) discard;
            #endif
          #endif`);
    };
    return m;
  });
  const sets = [];
  for (let v = 0; v < VARIANTS; v++) {
    sets.push([{ sprays: 150, sides: 5, rings: 3, around: 14, up: 18 }, { sprays: 40, sides: 4, rings: 2, around: 10, up: 12 }, { sprays: 9, sides: 3, rings: 2, around: 8, up: 8 }, { sprays: 0, sides: 3, rings: 1, around: 6, up: 5 }].map((spec, lod) => {
      const mesh = new THREE.InstancedMesh(cypressTree(spec, v * 9.1, heights[v]), levels[lod], nTrees);
      mesh.frustumCulled = false; mesh.receiveShadow = true; mesh.count = 0;
      scene.add(mesh);
      return mesh;
    }));
  }
  const mats = new Float32Array(nTrees * 16), tints = new Float32Array(nTrees * 3);
  for (let i = 0; i < nTrees; i++) {
    const o = i * 6, t = { x: data[o], y: data[o + 1], z: data[o + 2], r: 1.35, v: i % VARIANTS };   // crowns nearly touch: the rows are hedges
    p.set(t.x, t.y, t.z); q.setFromAxisAngle(yAxis, data[o + 3]); s.set(data[o + 4], data[o + 5], data[o + 4]);
    m.compose(p, q, s).toArray(mats, i * 16);
    tint.setHSL(0.275 + r() * 0.035, 0.3 + r() * 0.1, 0.27 + r() * 0.07).toArray(tints, i * 3);   // the grey green of cypress, no two alike
    t.mid = t.y + 5.4 * data[o + 5];
    trunks.setMatrixAt(i, m);
    trees.push(t); hash.add(t);
  }
  trunks.frustumCulled = false;
  scene.add(trunks);
  for (const lods of sets) for (const mesh of lods) {
    mesh.castShadow = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(nTrees * 3), 3).setUsage(THREE.DynamicDrawUsage);
  }

  // Shadows come from one plain copy of every tree at its coarsest, drawn only into the sun's shadow
  // map on the frames that map is redrawn: the trees on screen can then be only the ones in view.
  const unseen = new THREE.ShaderMaterial({ vertexShader: 'void main(){ gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }', fragmentShader: 'void main(){ gl_FragColor = vec4(0.0); }', colorWrite: false, depthWrite: false, depthTest: false });
  const casters = sets.map((lods, v) => {
    const mesh = new THREE.InstancedMesh(lods[3].geometry, unseen, nTrees);
    let k = 0;
    for (let i = v; i < nTrees; i += VARIANTS) mesh.instanceMatrix.array.set(mats.subarray(i * 16, i * 16 + 16), 16 * k++);
    mesh.count = k; mesh.castShadow = true; mesh.frustumCulled = false; mesh.visible = false;
    scene.add(mesh);
    return mesh;
  });

  // Four detail levels of the same tree, by distance from the walker, and only the trees the eye can
  // see: those in its field of view, and beside the basin those whose reflection is. A tree near a
  // band belongs to both levels, and the dither shares it between them.
  const TREE_R = 6.6, WATER = 0.12, at = new THREE.Vector3(), last = new Float32Array(9).fill(1e9);
  function update(camera, x, z, nearDist, under) {
    const e = camera.matrixWorldInverse.elements, w = camera.matrixWorld.elements;
    let same = last[7] === nearDist && last[8] === (under ? 1 : 0);
    for (let k = 0; k < 7; k++) { const v = k < 3 ? w[12 + k] : k < 6 ? w[8 + k - 3] : camera.fov; if (Math.abs(last[k] - v) > 1e-5) same = false; last[k] = v; }
    if (same) return;
    last[7] = nearDist; last[8] = under ? 1 : 0;
    const near = nearDist, far = 3 * nearDist, counts = sets.map(() => [0, 0, 0, 0]);
    bands.value.set(near - BLEND[0], near + BLEND[0], far - BLEND[1], far + BLEND[1]);
    farBand.value.set(FAR - BLEND[2], FAR + BLEND[2]);
    const ty = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2 + 3)), tx = ty * camera.aspect, sy = Math.hypot(1, ty), sx = Math.hypot(1, tx);
    const inView = (px, py, pz) => {
      const vx = e[0] * px + e[4] * py + e[8] * pz + e[12], vy = e[1] * px + e[5] * py + e[9] * pz + e[13], d = -(e[2] * px + e[6] * py + e[10] * pz + e[14]);
      return d > -TREE_R && Math.abs(vx) < d * tx + TREE_R * sx && Math.abs(vy) < d * ty + TREE_R * sy;
    };
    const put = (i, v, lod) => {
      const k = counts[v][lod]++, mesh = sets[v][lod], ma = mesh.instanceMatrix.array, ca = mesh.instanceColor.array;
      for (let j = 0; j < 16; j++) ma[k * 16 + j] = mats[i * 16 + j];
      ca[k * 3] = tints[i * 3]; ca[k * 3 + 1] = tints[i * 3 + 1]; ca[k * 3 + 2] = tints[i * 3 + 2];
    };
    for (let i = 0; i < nTrees; i++) {
      const t = trees[i];
      if (under && !(Math.abs(t.x) < 70 && t.z > 110 || Math.abs(t.z) < 60 && Math.abs(t.x) > 100)) continue;   // from a passage, only what its mouth can show
      if (!inView(t.x, t.mid, t.z) && !(t.z > 200 && Math.abs(t.x) < 60 && inView(t.x, 2 * WATER - t.mid, t.z))) continue;
      const d = Math.hypot(t.x - x, t.z - z);
      if (d < near + BLEND[0]) put(i, t.v, 0);
      if (d > near - BLEND[0] && d < far + BLEND[1]) put(i, t.v, 1);
      if (d > far - BLEND[1] && d < FAR + BLEND[2]) put(i, t.v, 2);
      if (d > FAR - BLEND[2]) put(i, t.v, 3);
    }
    let drawn = 0;
    sets.forEach((lods, v) => lods.forEach((mesh, l) => {
      const n = mesh.count = counts[v][l];
      drawn += n;
      for (const a of [mesh.instanceMatrix, mesh.instanceColor]) { a.clearUpdateRanges(); a.addUpdateRange(0, n * a.itemSize); a.needsUpdate = true; }
    }));
    return drawn;
  }
  const castShadows = (on) => { for (const mesh of casters) mesh.visible = on; };

  // distant broadleaf woods
  // seen from a kilometre off, each crown is a few pixels: a lumpy twenty-sided stone is plenty
  const crown = mergeVertices(new THREE.IcosahedronGeometry(1, 0).deleteAttribute('uv').deleteAttribute('normal'));
  const cp = crown.attributes.position;
  for (let i = 0; i < cp.count; i++) {
    const x = cp.getX(i), y = cp.getY(i), z = cp.getZ(i), k = 0.85 + 0.5 * noise3(x * 2.1, y * 2.1, z * 2.1);
    cp.setXYZ(i, x * k, y * k * 0.9, z * k);
  }
  crown.computeVertexNormals();
  const woods = new THREE.InstancedMesh(crown, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 }), nWood);
  for (let i = 0; i < nWood; i++) {
    const o = i * 4, sc = wood[o + 3] * 1.7;
    p.set(wood[o], wood[o + 1], wood[o + 2]); q.identity(); s.setScalar(sc);
    woods.setMatrixAt(i, m.compose(p, q, s));
    woods.setColorAt(i, tint.setHSL(0.27 + r() * 0.05, 0.42, 0.13 + r() * 0.07));
  }
  woods.frustumCulled = false;
  scene.add(woods);
  return { hash, update, castShadows, count: nTrees };
}

function makeGround(grassMap, grassNormal) {
  const g = new THREE.PlaneGeometry(9000, 9000, 220, 220).rotateX(-Math.PI / 2);
  const p = g.attributes.position, col = new Float32Array(p.count * 3), uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    p.setY(i, groundHeight(x, z) - 0.02);
    const n = noise3(x * 0.006, 3, z * 0.006) * 0.65 + noise3(x * 0.03, 8, z * 0.03) * 0.35;
    const k = 0.8 + 0.42 * n;
    col.set([k * (0.98 + 0.25 * (n - 0.5)), k, k * 0.92], i * 3);
    uv.setXY(i, x / 7 * SCALE, z / 7 * SCALE);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ map: grassMap, normalMap: grassNormal, normalScale: new THREE.Vector2(0.5, 0.5), vertexColors: true, roughness: 0.96 });
  // a second, much larger sampling hides the tiling at a distance, and the meadow is no lawn: it
  // drifts between lush and dry in patches a few strides across and in long sweeps
  mat.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vField;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvField = position.xz;');
    s.fragmentShader = s.fragmentShader.replace('#include <common>', `#include <common>
      varying vec2 vField;
      float fh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float fn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(fh(i), fh(i + vec2(1, 0)), f.x), mix(fh(i + vec2(0, 1)), fh(i + vec2(1, 1)), f.x), f.y); }
      float ff(vec2 p) { return 0.5 * fn(p) + 0.3 * fn(p * 2.3 + 5.1) + 0.2 * fn(p * 5.1 + 9.7); }`)
      .replace('#include <map_fragment>',
      `vec4 g1 = texture2D(map, vMapUv); vec4 g2 = texture2D(map, vMapUv * 0.073 + 0.31);
       float patches = ff(vField * 0.21), sweeps = ff(vField * 0.011 + 3.0), tufts = fn(vField * 2.6);
       vec3 turf = mix(g1.rgb, g2.rgb, 0.55) * mix(vec3(0.6, 0.7, 0.5), vec3(1.0, 1.0, 0.86), patches);
       turf = mix(turf, turf * vec3(1.3, 1.08, 0.62), 0.6 * smoothstep(0.42, 0.72, sweeps));
       diffuseColor.rgb *= turf * (0.84 + 0.2 * tufts) * vec3(0.8, 0.7, 0.6);`);
  };
  const mesh = new THREE.Mesh(g, mat);
  mesh.receiveShadow = true;
  return mesh;
}

function makeBasin() {
  const shader = {
    name: 'BasinWater',
    uniforms: { color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null }, time: { value: 0 } },
    vertexShader: `uniform mat4 textureMatrix; varying vec4 vUv; varying vec3 vW;
      void main(){ vUv = textureMatrix * vec4(position, 1.0); vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `uniform sampler2D tDiffuse; uniform float time; varying vec4 vUv; varying vec3 vW;
      float w(vec2 p, float t){ return sin(p.x * 0.9 + t) * sin(p.y * 0.33 - t * 0.6) + 0.5 * sin(p.x * 2.3 - t * 1.3 + p.y * 1.1); }
      void main(){
        vec3 v = normalize(cameraPosition - vW);
        float far = length(cameraPosition - vW);
        vec2 r = vec2(w(vW.xz, time), w(vW.zx + 7.0, time * 0.8)) * 0.0022 * smoothstep(420.0, 15.0, far)
               * smoothstep(0.0, 1.2, 20.0 - abs(vW.x));   // still against the coping, or the ripple shows sky along its foot
        vec4 at = vUv + vec4(r * vUv.w, 0.0, 0.0);
        float soft = vUv.w * (0.0015 + 0.004 * smoothstep(20.0, 300.0, far));   // a reflection drawn out a little along the eye's line, as on real water
        vec3 c = (texture2DProj(tDiffuse, at).rgb * 2.0 + texture2DProj(tDiffuse, at + vec4(0.0, soft, 0.0, 0.0)).rgb + texture2DProj(tDiffuse, at - vec4(0.0, soft, 0.0, 0.0)).rgb
                + texture2DProj(tDiffuse, at + vec4(0.0, 2.2 * soft, 0.0, 0.0)).rgb * 0.5 + texture2DProj(tDiffuse, at - vec4(0.0, 2.2 * soft, 0.0, 0.0)).rgb * 0.5) / 5.0;
        float f = 0.06 + 0.94 * pow(1.0 - clamp(v.y, 0.0, 1.0), 4.0);
        gl_FragColor = vec4(mix(vec3(0.012, 0.024, 0.028), c, clamp(f + 0.32, 0.0, 1.0)), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  };
  const water = new Reflector(new THREE.PlaneGeometry(40, 511), { textureWidth: 1024, textureHeight: 1024, clipBias: 0.002, shader, multisample: 0 });
  water.rotation.x = -Math.PI / 2;
  water.position.set(0, 0.12, 462.5);
  return water;
}

function makeSky(renderer, scene) {
  const sky = new Sky();
  sky.scale.setScalar(16000);
  const u = sky.material.uniforms;
  u.turbidity.value = 3.2; u.rayleigh.value = 1.3; u.mieCoefficient.value = 0.004; u.mieDirectionalG.value = 0.8;
  u.sunPosition.value.copy(SUN);
  u.cloudCoverage.value = 0.34; u.cloudDensity.value = 0.42; u.cloudScale.value = 0.00024; u.cloudElevation.value = 0.42;
  const envScene = new THREE.Scene();
  envScene.add(sky);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(envScene, 0, 1, 20000).texture;
  scene.environmentIntensity = 0.42;
  pmrem.dispose();
  scene.add(sky);
  return sky;
}

/** The small flames of the passage lamps. Their light on the stone is in the bake. */
function makeLamps(buffer) {
  const n = new Uint32Array(buffer, 0, 1)[0], g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buffer, 4, n * 3), 3));
  const flames = new THREE.Points(g, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { t: { value: 0 }, scale: { value: 800 } },
    vertexShader: `uniform float scale; varying float vSeed;
      void main(){ vSeed = position.x + position.z; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = 0.42 * scale / -mv.z; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform float t; varying float vSeed;
      void main(){ vec2 p = gl_PointCoord - vec2(0.5, 0.62); p.x += 0.05 * sin(t * 9.0 + vSeed) * (0.6 - p.y);
        float w = 0.2 * (1.0 - smoothstep(-0.5, 0.45, -p.y)) + 0.015, a = (1.0 - smoothstep(0.0, 1.0, abs(p.x) / w)) * smoothstep(0.62, 0.3, abs(p.y));
        gl_FragColor = vec4(vec3(2.6, 1.1, 0.26) * a * a, 1.0); }`,
  }));
  flames.frustumCulled = false;
  return flames;
}

/**
 * Ptolemy's constellations painted on the black vault in pale gold: lines from star to star that stop
 * short of each opening, as on a star chart, and their Latin names in Roman capitals.
 */
function makeFigures(list) {
  const R = 66.9, HALF = 0.11, GAP = 1.1, LETTER = 1.6, pos = [], uv = [], nor = [];
  const dir = (d) => new THREE.Vector3(d[0], d[2], -d[1]).normalize();
  const solid = [0.996, 0.002];                     // a white corner of the lettering atlas
  const quad = (a, b, c, d, ua, ub, uc, ud) => {        // corners relative to the sphere's centre
    for (const [p, t] of [[a, ua], [b, ub], [c, uc], [a, ua], [c, uc], [d, ud]]) {
      pos.push(p.x + CENTER.x, p.y + CENTER.y, p.z + CENTER.z); uv.push(t[0], t[1]);
      const n = p.clone().normalize().negate(); nor.push(n.x, n.y, n.z);
    }
  };
  const p = new THREE.Vector3(), q = new THREE.Vector3(), side = new THREE.Vector3();
  for (const c of list) for (const [a, b, real] of c.segs) {
    const A = dir(a), B = dir(b), w = A.angleTo(B), t0 = real[0] ? GAP / R / w : 0, t1 = 1 - (real[1] ? GAP / R / w : 0);
    if ((t1 - t0) * w * R < 0.4) continue;
    const steps = Math.max(1, Math.ceil(((t1 - t0) * w) / 0.012));
    const at = (t) => new THREE.Vector3().copy(A).multiplyScalar(Math.sin((1 - t) * w)).addScaledVector(B, Math.sin(t * w)).divideScalar(Math.sin(w)).multiplyScalar(R);
    for (let i = 0; i < steps; i++) {
      p.copy(at(t0 + ((t1 - t0) * i) / steps)); q.copy(at(t0 + ((t1 - t0) * (i + 1)) / steps));
      side.subVectors(q, p).cross(p).normalize().multiplyScalar(HALF);
      quad(p.clone().sub(side), q.clone().sub(side), q.clone().add(side), p.clone().add(side), solid, solid, solid, solid);
    }
  }

  // the names, drawn into one atlas and bent onto the sphere
  const named = list.filter((c) => c.name), ROW = 80, canvas = document.createElement('canvas');
  canvas.width = 1024; canvas.height = 2048;
  const x = canvas.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(1016, 2040, 8, 8);
  x.font = `500 ${ROW * 0.72}px Didot, "Bodoni 72", Georgia, "Times New Roman", serif`;
  x.textBaseline = 'middle';
  const up = new THREE.Vector3(0, 1, 0), north = new THREE.Vector3(0, 0, -1), U = new THREE.Vector3(), Rt = new THREE.Vector3();
  named.forEach((c, row) => {
    let width = 0;
    const spacing = ROW * 0.16, glyphs = [...c.name].map((ch) => { const w = x.measureText(ch).width; const g = { ch, at: width }; width += w + spacing; return g; });
    width -= spacing;
    const scale = Math.min(1, 1000 / width);
    x.save(); x.translate(12, row * ROW + ROW / 2); x.scale(scale, 1);
    for (const g of glyphs) x.fillText(g.ch, g.at, 0);
    x.restore();
    const u1 = (12 + width * scale) / 1024, v0 = 1 - ((row + 1) * ROW) / 2048, v1 = v0 + ROW / 2048;
    const D = dir(c.at);
    U.copy(up).addScaledVector(D, -D.dot(up));
    if (U.length() < 0.2) U.copy(north).addScaledVector(D, -D.dot(north));
    U.normalize(); Rt.crossVectors(D, U).normalize();
    const H = LETTER / 0.72, W = (H * width) / ROW, cols = Math.ceil(W / 1.2);
    const onSphere = (s, h) => D.clone().multiplyScalar(R).addScaledVector(Rt, (s - 0.5) * W).addScaledVector(U, (h - 0.5) * H).setLength(R);
    for (let i = 0; i < cols; i++) {
      const s0 = i / cols, s1 = (i + 1) / cols, a = (12 / 1024) + (u1 - 12 / 1024) * s0, b = (12 / 1024) + (u1 - 12 / 1024) * s1;
      quad(onSphere(s0, 0), onSphere(s1, 0), onSphere(s1, 1), onSphere(s0, 1), [a, v0], [b, v0], [b, v1], [a, v1]);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  const atlas = new THREE.CanvasTexture(canvas);
  atlas.colorSpace = THREE.SRGBColorSpace; atlas.anisotropy = 4;
  const paint = weathered(new THREE.MeshStandardMaterial({ color: new THREE.Color(0.8, 0.6, 0.3), map: atlas, alphaTest: 0.35, roughness: 0.6, metalness: 0 }), { streaks: 0 });
  return new THREE.Mesh(g, paint);
}

/** The brazier: a turbulent flame, sparks and smoke, and a real light thrown on the stone round it. */
/**
 * A wrought-iron sconce under each flame: a cup to hold it, an arm and a brace back to the nearest
 * wall, and a plate fixed to the stone. The flame's own light is painted onto the iron.
 */
function makeSconces(buffer, bvh) {
  const n = new Uint32Array(buffer, 0, 1)[0], pos = new Float32Array(buffer, 4, n * 3), parts = [];
  const ray = new THREE.Ray(), m = new THREE.Matrix4(), q = new THREE.Quaternion(), flame = new THREE.Vector3(), out = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const rod = (a, b, r) => {                         // a round bar from a to b, in the sconce's frame
    const d = b.clone().sub(a), g = new THREE.CylinderGeometry(r, r, d.length(), 6, 1, true);
    return g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, d.normalize())).translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  };
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  for (let i = 0; i < n; i++) {
    flame.fromArray(pos, i * 3);
    let best = null;                                 // the nearest wall, looking all round at flame height
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      ray.set(flame, V(Math.cos(a), 0, Math.sin(a)));
      const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
      if (hit && hit.distance < 1.5 && (!best || hit.distance < best.distance)) best = { distance: hit.distance, dir: ray.direction.clone() };
    }
    if (!best) continue;
    const D = best.distance;                         // local frame: flame at the origin, wall at z = -D
    const cup = new THREE.LatheGeometry([[0.0, -0.27], [0.035, -0.27], [0.07, -0.23], [0.095, -0.17], [0.105, -0.16]].map(([r, h]) => new THREE.Vector2(r, h)), 10);
    const ring = new THREE.TorusGeometry(0.105, 0.01, 4, 12).rotateX(Math.PI / 2).translate(0, -0.16, 0);
    const knob = new THREE.SphereGeometry(0.025, 6, 4).translate(0, -0.29, 0);
    const arm = rod(V(0, -0.27, 0), V(0, -0.27, -D), 0.014);
    const brace = rod(V(0, -0.27, -0.05), V(0, -0.55, -D), 0.011);
    const plate = new THREE.BoxGeometry(0.13, 0.42, 0.025).translate(0, -0.4, -D + 0.012);
    q.setFromUnitVectors(V(0, 0, -1), best.dir);
    m.compose(flame, q, V(1, 1, 1));
    for (const g of [cup, ring, knob, arm, brace, plate]) {
      const flat = g.index ? g.toNonIndexed() : g;
      flat.deleteAttribute('uv');
      flat.computeVertexNormals();
      // lit from the flame above: iron, with a warm edge where it faces the light
      const p = flat.attributes.position, nrm = flat.attributes.normal, c = new Float32Array(p.count * 3);
      for (let j = 0; j < p.count; j++) {
        out.set(-p.getX(j), 0.05 - p.getY(j), -p.getZ(j));
        const d2 = out.lengthSq(), face = Math.max(0, (nrm.getX(j) * out.x + nrm.getY(j) * out.y + nrm.getZ(j) * out.z) / Math.sqrt(d2));
        const k = 0.05 + (1.4 * face) / (1 + 14 * d2);
        c.set([0.11 * k + 0.012, 0.075 * k + 0.009, 0.045 * k + 0.007], j * 3);
      }
      flat.setAttribute('color', new THREE.BufferAttribute(c, 3));
      parts.push(flat.applyMatrix4(m));
    }
  }
  return new THREE.Mesh(mergeGeometries(parts), new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
}

function makeFire() {
  const group = new THREE.Group();
  group.position.set(0, 66.75, 78);

  const flame = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 10.5).translate(0, 5.1, 0), new THREE.ShaderMaterial({
    transparent: true, premultipliedAlpha: true, depthWrite: false, side: THREE.DoubleSide, uniforms: { t: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform float t; varying vec2 vUv;
      float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
      float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * n(p); p = p * 2.03 + 11.7; a *= 0.5; } return s; }
      void main(){
        float y = vUv.y, x = vUv.x - 0.5;
        x += (fbm(vec2(vUv.x * 2.2, y * 1.9 - t * 1.25)) - 0.5) * 0.85 * y;           // the whole body sways
        x += (n(vec2(y * 5.0 - t * 2.6, 3.0)) - 0.5) * 0.16 * y;
        float width = 0.36 * pow(max(1.0 - y, 0.0), 0.9) * smoothstep(-0.03, 0.08, y) + 0.002;
        float body = 1.0 - abs(x) / width;
        float tongues = fbm(vec2(vUv.x * 8.5 + t * 0.2, y * 5.2 - t * 3.3));         // licks that tear free as they rise
        float heat = body + (tongues - 0.52) * (0.9 + 2.4 * y) - y * 0.32;
        float cover = smoothstep(0.02, 0.2, heat);
        vec3 c = mix(vec3(0.72, 0.07, 0.0), vec3(1.0, 0.36, 0.02), smoothstep(0.08, 0.42, heat));
        c = mix(c, vec3(1.0, 0.8, 0.28), smoothstep(0.42, 0.85, heat));
        c = mix(c, vec3(1.0, 0.95, 0.68), smoothstep(0.85, 1.2, heat) * (1.0 - y));
        gl_FragColor = vec4(c * cover, cover * 0.94);
      }`,
  }));
  group.add(flame);

  const light = new THREE.PointLight(0xff9a48, 0, 34, 1.5);    // it has no shadows: this reach stops short of the vault inside
  light.position.y = 3.5;
  group.add(light);

  // sparks carried up by the heat
  const SPARKS = 90, spark = new Float32Array(SPARKS * 3), seed = [], r = rng(11);
  for (let i = 0; i < SPARKS; i++) seed.push({ t: r(), a: r() * 6.28, s: 0.5 + r(), w: r() * 2 - 1 });
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(spark, 3));
  const sparks = new THREE.Points(sg, new THREE.PointsMaterial({ color: new THREE.Color(6, 2.2, 0.4), size: 0.16, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
  sparks.frustumCulled = false;
  group.add(sparks);

  // smoke drawn as lumpy billows rather than soft discs
  const c = document.createElement('canvas'); c.width = c.height = 192;
  const x = c.getContext('2d');
  for (let i = 0; i < 46; i++) {
    const a = r() * 6.28, d = r() ** 1.5 * 56, px = 96 + Math.cos(a) * d, py = 96 + Math.sin(a) * d, rad = 18 + r() * 26;
    const g = x.createRadialGradient(px, py, 1, px, py, rad);
    g.addColorStop(0, 'rgba(255,255,255,.2)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, 192, 192);
  }
  const map = new THREE.CanvasTexture(c), puffs = [];
  for (let i = 0; i < 42; i++) {
    const m = new THREE.Sprite(new THREE.SpriteMaterial({ map, color: 0x4a4744, transparent: true, depthWrite: false, opacity: 0, rotation: r() * 6.28 }));
    m.userData = { t: i / 42, x: r() * 2 - 1, z: r() * 2 - 1, spin: (r() - 0.5) * 0.3 };
    group.add(m); puffs.push(m);
  }
  return {
    group,
    light,
    update(dt, time, camera) {
      group.rotation.y = Math.atan2(camera.position.x - group.position.x, camera.position.z - group.position.z);
      flame.material.uniforms.t.value = time;
      light.intensity = 900 * (0.8 + 0.2 * Math.sin(time * 11.3) * Math.sin(time * 7.1) + 0.12 * Math.sin(time * 23));
      seed.forEach((k, i) => {
        k.t = (k.t + dt * 0.11 * k.s) % 1;
        const y = 1.5 + k.t * k.t * 34, spread = 0.7 + k.t * 7;
        spark.set([Math.sin(k.a + k.t * 9) * spread * k.w + k.t * k.t * 16, y, Math.cos(k.a + k.t * 7) * spread * k.w], i * 3);
      });
      sg.attributes.position.needsUpdate = true;
      for (const m of puffs) {
        const d = m.userData; d.t = (d.t + dt * 0.03) % 1;
        const t = d.t, y = 6 + t * 74;
        m.position.set(d.x * (1 + t * 9) + t * t * 42, y, d.z * (1 + t * 9));
        const size = 4 + t * 34; m.scale.set(size, size, 1);
        m.material.rotation += d.spin * dt;
        m.material.opacity = 0.34 * smooth(0, 0.07, t) * (1 - smooth(0.35, 1, t));
      }
    },
  };
}

// The floor under a point, found by looking down from a little above it. Starting just above the
// last floor keeps the search under a passage's vault rather than on the terrace over it.
function floorBelow(bvh, x, y, z, ray = new THREE.Ray()) {
  ray.origin.set(x, y, z); ray.direction.set(0, -1, 0);
  const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
  return hit ? hit.point.y : -Infinity;
}

// What a visitor stands on: the first solid below, or the ground, which the collider leaves out; but
// where that is an invisible slope laid over steps, the real tread beneath it.
function standOn({ bvh, slopes, treads }, x, y, z, ray) {
  const solid = Math.max(floorBelow(bvh, x, y, z, ray), groundHeight(x, z)), tread = floorBelow(treads, x, y, z, ray);
  if (Math.abs(floorBelow(slopes, x, y, z, ray) - solid) < 1e-3) return tread > solid - 0.8 ? tread : solid;
  return Math.max(solid, tread);
}

// ----------------------------------------------------------------------- load
export async function loadWorld(renderer, onProgress) {
  const manager = new THREE.LoadingManager();
  manager.onProgress = (_, done, total) => onProgress(done / total);
  const T = (name, srgb = false) => load(name, srgb, renderer, manager);

  placeSun(0.2);
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0xd3dbe3, 0.00045 * Math.sqrt(SCALE));   // aerial haze, none up close

  const std = (o) => new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0, ...o });
  const LIMESTONE = 0xe6d6b8;      // warms and tones down the neutral stone textures
  const nS = (v) => new THREE.Vector2(v, v);
  const ashlar = weathered(std({ color: LIMESTONE, map: T('ashlar', true), normalMap: T('ashlar_n'), normalScale: nS(0.9) }));
  const stone = T('stone', true), stoneN = T('stone_n');
  const dressed = weathered(std({ color: LIMESTONE, map: stone, normalMap: stoneN, normalScale: nS(0.5), roughness: 0.74 }), { streaks: 0.4 });
  const hollow = std({ color: 0x1c1813, roughness: 0.95, envMapIntensity: 0.25 });
  const cutLip = std({ color: 0x75694c, roughness: 0.85, envMapIntensity: 0.35 });
  const lionStone = weathered(std({ color: 0xefe3cc, map: stone, normalMap: stoneN, normalScale: nS(0.35), roughness: 0.66 }), { streaks: 0.6, carved: true });   // a finer, paler block, cut deep
  const boreStone = weathered(std({ color: LIMESTONE, map: stone, normalMap: stoneN, normalScale: nS(0.3), roughness: 0.8 }), { streaks: 0, level: 1.5 });   // the bake's vertices are too few for these narrow bores
  const sphere = weathered(std({ color: LIMESTONE, map: stone, normalMap: stoneN, normalScale: nS(0.25), roughness: 0.72, envMapIntensity: 0.45 }), { courses: true });
  const vault = weathered(std({ color: new THREE.Color(0.05, 0.05, 0.053), map: stone, normalMap: stoneN, normalScale: nS(0.3), roughness: 0.88, dithering: true }), { courses: true, streaks: 0 });   // painted black, so the stars stand out
  const paving = weathered(std({ color: LIMESTONE, map: T('paving', true), normalMap: T('paving_n'), normalScale: nS(0.7) }), { streaks: 0 });
  const gravel = weathered(std({ color: new THREE.Color(1.22, 1.08, 0.88), map: T('gravel', true), normalMap: T('gravel_n'), normalScale: nS(0.3), roughness: 0.94 }), { streaks: 0, loose: true });
  const soil = std({ map: T('soil', true), roughness: 0.97 });
  const leaves = T('cypress', true);
  const foliage = new THREE.MeshLambertMaterial({ map: leaves, normalMap: T('cypress_n'), normalScale: nS(1.0), vertexColors: true,   // matte: leaves don't mirror the sky
                                                  emissive: 0x56665a, emissiveMap: leaves });                                          // this material ignores the sky, so its light is added here
  const grass = [T('grass', true), T('grass_n')];
  const MATS = {
    'Vault: pierced shell (star holes)': [vault, 12, true], Bore: [boreStone, 12 / SCALE], 'Limestone ashlar': [ashlar, 15.6 / SCALE], 'Limestone dressed': [dressed, 12 / SCALE], 'Limestone sphere': [sphere, 12, true],
    'Limestone paving': [paving, 6.4 / SCALE], 'Gravel (terrace walks)': [gravel, 4 / SCALE], 'Planting bed (soil, needle litter)': [soil, 3 / SCALE],
  };

  const draco = new DRACOLoader(manager).setDecoderPath('./draco/');
  const gltfLoader = new GLTFLoader(manager).setDRACOLoader(draco);
  const fileLoader = new THREE.FileLoader(manager).setResponseType('arraybuffer');
  const json = new THREE.FileLoader(manager).setResponseType('json');
  const [gltf, treeBuf, holeBuf, lampBuf, figureList, figureSheet, figurePlaces] = await Promise.all([gltfLoader.loadAsync('assets/monument.glb'), fileLoader.loadAsync('assets/trees.bin'),
    fileLoader.loadAsync('assets/holes.bin'), fileLoader.loadAsync('assets/lamps.bin'), json.loadAsync('assets/constellations.json'),
    new THREE.TextureLoader(manager).loadAsync('assets/figures.webp'), json.loadAsync('assets/figures.json')]);
  draco.dispose();

  const root = gltf.scene, solids = [];
  root.updateMatrixWorld(true);
  const nameOf = (o) => { let n = o; while (n.parent && n.parent !== root) n = n.parent; return n.userData.name ?? n.name; };
  const meshes = [], inside = [], slopes = [], treads = [], vaults = [];
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const flat = (mesh) => {
    const g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    for (const k of Object.keys(g.attributes)) if (k !== 'position') g.deleteAttribute(k);
    return g.index ? g.toNonIndexed() : g;
  };
  for (const mesh of meshes) {
    const name = nameOf(mesh), isHelper = name.startsWith('COL_');
    if (!NOT_SOLID.has(name)) solids.push(flat(mesh));
    else if (name === 'Sarcophagus dais') solids.push(insideDais(mesh));   // its steps are walked over, but its rooms are walled
    if (isHelper) slopes.push(flat(mesh));
    if (STEPPED.has(name)) treads.push(flat(mesh));
    if (isHelper) { mesh.visible = false; continue; }
    const key = mesh.material.name;
    if (name === 'Inscription') {
      // Cut into the wall, not set on it: the modelled letters stand proud, so they are pressed flat
      // against the stone as the shadowed hollow of each cut, with its lit lower lip showing under it.
      const flat = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld), fp = flat.attributes.position, fn = flat.attributes.normal;
      let wall = Infinity;
      for (let i = 0; i < fp.count; i++) wall = Math.min(wall, Math.hypot(fp.getX(i), fp.getZ(i)));
      for (let i = 0; i < fp.count; i++) {
        const x = fp.getX(i), z = fp.getZ(i), r = Math.hypot(x, z), k = (wall + 0.012) / r;
        fp.setXYZ(i, x * k, fp.getY(i), z * k); fn.setXYZ(i, x / r, 0, z / r);
      }
      flat.deleteAttribute('color');
      const cut = new THREE.Mesh(flat, hollow), lip = new THREE.Mesh(flat, cutLip);
      lip.position.y = -0.035; lip.scale.set(0.99995, 1, 0.99995);
      cut.receiveShadow = lip.receiveShadow = true;
      scene.add(lip, cut);
      mesh.visible = false;
    }
    if (MATS[key]) {
      const [mat0, tile, sph] = MATS[key], mat = name === 'Lions' ? lionStone : mat0;
      if (name === 'Lions') carving(mesh.geometry);
      const g = stoneUVs(mesh.geometry, tile, sph);
      if (g.attributes.color) {
        const c = g.attributes.color, pos = g.attributes.position, baked = new Float32Array(c.count * 3);
        for (let v = 0; v < c.count; v++) {
          const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
          const inFront = Math.abs(x) < 7.3 && z > 2 && z < 110, inSide = Math.abs(z) < 3.5 && Math.abs(x) < 125;
          const depth = y < 14.1 ? (inFront ? 108 - z : inSide ? 121 - Math.abs(x) : 0) : 0, k = 1 + (PASSAGES - 1) * smooth(0, 14, depth);
          const wallHead = name.startsWith('Drum (main cylinder)') || name.startsWith('Drum_(main_cylinder)');
          const least = name === 'Basin coping' ? 0.55 : 0;   // its sides meet the ground, where the bake's vertices went dark
          const open = 1 - smooth(0, 14, depth);              // under the open sky, where shade is lit by the whole blue of it
          let r = c.getX(v) * k, g = c.getY(v) * k, b = c.getZ(v) * k;
          // The wall behind the inscription has corners only at its head and foot, and the bake left one
          // bright patches at its head and foot, which its great faces drew out into wedges of light: it is
          // given the plain shade of a wall under an overhang instead, deepening toward the top.
          if (wallHead && z > 90 && Math.abs(x) < 45 && y > 5 && Math.abs(Math.hypot(x, z) - 104) < 1.5) { r = g = b = 0.2 + 0.2 * (1 - smooth(5.5, 43, y)); }
          const most = open > 0.99 ? 0.7 / Math.max(g, 0.7) : 1;      // and no shade in the open is lit harder than the sky and the ground can light it
          r *= most; g *= most; b *= most;
          baked[v * 3] = Math.max(r * (1 + open * (SKY_FILL * 0.9 - 1)), least); baked[v * 3 + 1] = Math.max(g * (1 + open * (SKY_FILL - 1)), least); baked[v * 3 + 2] = Math.max(b * (1 + open * (SKY_FILL * 1.14 - 1)), least);
        }
        g.setAttribute('baked', new THREE.BufferAttribute(baked, 3));
        g.deleteAttribute('color');
      }
      mesh.geometry = g;
      mesh.material = mat;
      // every passage in one stone, whatever solid it was cut through: paved floors, coursed walls and vaults
      const split = splitPassages(g, 15.6 / SCALE);
      if (split) {
        if (split.rest) mesh.geometry = split.rest; else mesh.visible = false;
        for (const [geo, m, tile] of [[split.floor, paving, 6.4 / SCALE], [split.walls, ashlar, 0]]) {
          if (!geo) continue;
          if (tile) {
            const pos = geo.attributes.position, uv = new Float32Array(pos.count * 2);
            for (let v = 0; v < pos.count; v++) { uv[v * 2] = pos.getX(v) / tile; uv[v * 2 + 1] = pos.getZ(v) / tile; }
            geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
          }
          const part = new THREE.Mesh(geo, m);
          part.position.copy(mesh.position); part.quaternion.copy(mesh.quaternion); part.scale.copy(mesh.scale);
          part.castShadow = part.receiveShadow = true;
          mesh.parent.add(part);
        }
      }
      if (key.startsWith('Vault') || name === 'Interior floor' || name.startsWith('Sarcophagus')) inside.push(mesh.geometry);
    }
    const indoors = key.startsWith('Vault') || key === 'Bore' || name === 'Interior floor' || name.startsWith('Sarcophagus') || name === 'Passage stairs';
    if (indoors) mesh.layers.set(1);
    if (key.startsWith('Vault') || key === 'Bore') vaults.push(mesh);                   // the basin's reflection is drawn without what it could never show
    mesh.castShadow = !indoors && name !== 'Inscription' && key !== 'Planting bed (soil, needle litter)' && name !== 'Esplanade and walks' && name !== 'Basin coping';   // low and flat, they would shadow only themselves, in stripes
    mesh.receiveShadow = true;
  }
  const figures = makeFigures(figureList);
  skyThroughHoles(holeBuf, inside, [figures.geometry]);
  scene.add(root, figures);

  // the lamps relight everything that stands in their light, last of all
  const lampAt = new Float32Array(lampBuf, 4, new Uint32Array(lampBuf, 0, 1)[0] * 3);
  root.traverse((o) => { if (o.isMesh && o.visible && o.geometry.attributes.baked && !o.geometry.index) lampLight(o.geometry, lampAt); });

  const collider = mergeGeometries(solids);
  const bvh = new MeshBVH(collider);

  const outdoors = new THREE.Group();                // none of this can be seen from inside the sphere
  scene.add(outdoors);
  const trees = makeTrees(treeBuf, foliage, outdoors);
  outdoors.add(makeGround(...grass));
  const water = makeBasin();
  // where a second drawing of the whole scene is too much to ask, the basin shows the sky's colour alone
  const stillWater = new THREE.Mesh(water.geometry, new THREE.ShaderMaterial({
    uniforms: { skyLevel: SKY_LEVEL },
    vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: `uniform float skyLevel; varying vec3 vW;
      void main(){ vec3 v = normalize(cameraPosition - vW); float f = 0.38 + 0.62 * pow(1.0 - clamp(v.y, 0.0, 1.0), 4.0);
        gl_FragColor = vec4(mix(vec3(0.012, 0.024, 0.028), mix(vec3(1.5, 1.7, 1.9), vec3(0.45, 0.75, 1.45), clamp(v.y * 3.0, 0.0, 1.0)) * skyLevel, f), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  }));
  stillWater.rotation.copy(water.rotation); stillWater.position.copy(water.position); stillWater.visible = false;
  outdoors.add(water, stillWater);
  const sky = makeSky(renderer, scene);
  sky.material.depthTest = false; sky.renderOrder = -1;   // it sits at the far plane, which the reversed depth buffer would put in front
  const fire = makeFire();
  scene.add(fire.group);
  const lamps = makeLamps(lampBuf);
  const sconces = makeSconces(lampBuf, bvh);
  lamps.layers.set(1); sconces.layers.set(1);
  scene.add(lamps, sconces);


  // The sun is the only light here. Outdoors its shadow map covers the whole site; underground and
  // in the void it closes in on the shell, fine enough to resolve the bores it shines through.
  const sun = new THREE.DirectionalLight(0xffe2bf, 3.8);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(2048);
  sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.35; sun.shadow.radius = 2.2;
  scene.add(sun, sun.target);
  let close = false, sunStrength = 3;
  const low = new THREE.Color(0xffb878), high = new THREE.Color(0xfff0dc);
  const skyUniforms = sky.material.uniforms;
  const refresh = () => {
    const cam = sun.shadow.camera, half = close ? 84 : 560;
    sun.target.position.set(0, close ? 73.5 : 0, close ? 0 : 170);
    sun.position.copy(sun.target.position).addScaledVector(SUN, 1100);
    Object.assign(cam, { left: -half, right: half, top: close ? half : 520, bottom: close ? -half : -520, near: 300, far: 1900 });
    cam.updateProjectionMatrix();
    sun.shadow.bias = close ? -0.0001 : -0.0003;
    sun.shadow.normalBias = close ? 0.05 : 0.35;
    sun.shadow.radius = close ? 1.6 : 1.6;
    if (close) return;                               // the sun is off in the void: its light arrives only down the bores
    trees.castShadows(true);
    renderer.shadowMap.needsUpdate = true;
  };
  const setSun = (u) => {
    placeSun(u);
    skyUniforms.sunPosition.value.copy(SUN);
    const lift = smooth(0.1, 0.6, SUN.y);
    sun.color.lerpColors(low, high, lift);
    sunStrength = 2.6 + 1.1 * lift;
    sun.intensity = close ? 0 : sunStrength;     // inside, sunlight arrives only down the bores
    SKY_LEVEL.value = 0.5 + 0.5 * lift;
    sun.position.copy(sun.target.position).addScaledVector(SUN, 1100);
  };
  // in the void only the shell and what stands inside it can matter, so nothing else is drawn or shadowed
  const casters = [];
  root.traverse((o) => { if (o.isMesh && o.castShadow && !/^Sphere|^Sarcophagus|^Interior/.test(nameOf(o))) casters.push(o); });
  const shadowsClose = (on) => {
    if (on === close) return;
    close = on; outdoors.visible = !on;
    for (const o of casters) o.castShadow = !on;
    refresh();
  };
  refresh();

  const visitors = makeVisitors(scene, figureSheet, figurePlaces, { bvh, slopes: new MeshBVH(mergeGeometries(slopes)), treads: new MeshBVH(mergeGeometries(treads)) },
    { standOn, sun: { value: SUN }, sunLight: () => ({ strength: sunStrength, sky: SKY_LEVEL.value, color: sun.color }) });
  scene.add(...visitors.meshes);

  const shafts = makeSunshafts(holeBuf);
  const tomb = new THREE.PointLight(0xfff0d8, 0, 42, 1.6);   // the light of all the bores, arriving together on the sarcophagus
  tomb.position.set(0, 28, 0);
  scene.add(tomb);
  shafts.mesh.visible = false;
  for (const o of shafts.mesh.children) o.layers.set(1);
  scene.add(shafts.mesh);

  // the painted vault and the bores' walls can be seen only from inside the shell or from the ways into it
  // From outside, a pinhole shows only darkness: a plain black ball inside the shell stands in for the void.
  const dark = new THREE.Mesh(new THREE.SphereGeometry(74.6, 48, 24).translate(0, CENTER.y, 0), new THREE.MeshBasicMaterial({ color: 0x030303, fog: false }));
  dark.layers.set(1);
  scene.add(dark);
  const showVault = (on) => { for (const o of vaults) o.visible = on; figures.visible = on; dark.visible = !on; };
  const setQuality = (q) => {
    if (sun.shadow.mapSize.x !== q.shadow) { sun.shadow.mapSize.setScalar(q.shadow); sun.shadow.map?.dispose(); sun.shadow.map = null; }
    water.visible = q.mirror > 0; stillWater.visible = !water.visible;
    if (q.mirror) water.getRenderTarget().setSize(q.mirror, q.mirror);
    shafts.setMax(q.shafts);
    visitors.meshes[2].visible = q.casts;            // their outlines on the ground
    refresh();
  };
  return { scene, bvh, trees, showVault, setQuality, water, sky, fire, visitors, sun, setSun, refresh, shadowsClose, lamps, shafts, tomb, sunStrength: () => sunStrength };

}
