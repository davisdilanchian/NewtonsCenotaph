// Everything in the scene: stone from the Blender model, instanced cypresses, ground,
// basin, sky, and the star vault.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { Reflector } from './mirror.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';
import { noise3, rng, smooth, SCALE } from './util.js';
import { makeCutouts } from './figures.js';
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

// ------------------------------------------------------------------ texturing
function load(name, srgb, renderer, manager) {
  const t = new THREE.TextureLoader(manager).load(`assets/tex/${name}.jpg`);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const SKY_LEVEL = { value: 1 };                 // follows the height of the sun
const FIGURE_LIGHT = { value: 1 };              // the paper visitors, lit like the stone around them

/** Weather that repeats nowhere: broad tonal drift, rain streaks, and the sphere's stone courses. */
function weathered(mat, { streaks = 1, courses = false, level = 1 } = {}) {
  mat.onBeforeCompile = (s) => {
    s.uniforms.skyLevel = SKY_LEVEL;
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP, vBaked; attribute vec3 baked;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWP = (modelMatrix * vec4(position, 1.0)).xyz; vBaked = baked;');
    s.fragmentShader = s.fragmentShader.replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
      #ifdef USE_ENVMAP
        iblIrradiance = vec3(0.0);                    // diffuse sky comes from the path traced bake instead
        radiance = vec3(0.0);                         // and the sky isn't reflected, or it would shine indoors too
      #endif
      irradiance += vBaked * skyLevel * ${level.toFixed(3)};`)
      .replace('#include <common>', `#include <common>
      varying vec3 vWP, vBaked; uniform float skyLevel;
      float vh(vec3 p) { p = fract(p * 0.3183 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      float vn(vec3 p) { vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(vh(i), vh(i + vec3(1, 0, 0)), f.x), mix(vh(i + vec3(0, 1, 0)), vh(i + vec3(1, 1, 0)), f.x), f.y),
                   mix(mix(vh(i + vec3(0, 0, 1)), vh(i + vec3(1, 0, 1)), f.x), mix(vh(i + vec3(0, 1, 1)), vh(i + vec3(1, 1, 1)), f.x), f.y), f.z); }
      float fb(vec3 p) { return 0.55 * vn(p) + 0.3 * vn(p * 2.1 + 3.1) + 0.15 * vn(p * 4.3 + 7.7); }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
      diffuseColor.rgb *= 0.8 + 0.3 * fb(vWP * 0.016) + 0.1 * fb(vWP * 0.13);
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
    } else if (radial > 0.85) {
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
 * The passage a face lies in, if any, as the line its courses run along: the front passage, the
 * curved one that carries it round, or the east-west one that climbs under the dais. Walls and
 * vaults then take courses that run along that line and climb straight over the vault, so no joint
 * breaks between faces.
 */
const RING_R = 26;
function passageAxis(x, y, z, n) {
  if (y > 13.9) return null;                                                        // the room under the tomb, and the sphere's floor and all above it
  const ax = Math.abs(x), r = Math.hypot(x, z);
  if (z > -3 && Math.abs(r - RING_R) < 3 && !(ax < 3 && z > RING_R)) return { ring: true };
  if (ax < 7.3 && z > 23 && z < 112 && (z < 95 || Math.abs(n.z) < 0.7)) return { along: 'z', at: 0 };
  if (Math.abs(z) < 3.6 && ax < 125 && (ax < 115 || Math.abs(n.x) < 0.7)) return { along: 'x', at: 0 };
  return null;
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
      const along = axis.ring ? Math.atan2(v.x, v.z) * RING_R : axis.along === 'z' ? v.z : v.x;
      const across = axis.ring ? Math.hypot(v.x, v.z) - RING_R : (axis.along === 'z' ? v.x : v.z) - axis.at;
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
 * One tree, one body: upright flame-shaped sprays packed round the trunk on a spiral, the way
 * cypress foliage really grows. Fewer, broader sprays make the distant versions of the same tree.
 */
function cypressTree(sprays, sides, rings, seed, H) {
  const r = rng(Math.round(seed * 991) + 17), pos = [], nor = [], uv = [], col = [], idx = [];
  const fat = Math.sqrt(120 / sprays), axis = new THREE.Vector3(), side = new THREE.Vector3(), out = new THREE.Vector3(), radial = new THREE.Vector3(), p = new THREE.Vector3();
  for (let i = 0; i < sprays; i++) {
    const t = ((i + 0.5) / sprays) ** 0.86, a = i * 2.39996 + (r() - 0.5) * 0.5, ca = Math.cos(a), sa = Math.sin(a);
    const edge = CYPRESS_R * cypressOutline(Math.min(t + 0.06, 1)), length = (1.9 + r() * 1.0) * (1 - 0.42 * t) * (0.75 + 0.25 * fat);
    const width = Math.max(0.1, (0.2 + r() * 0.08) * fat * (1.05 - 0.6 * t)), low = CYPRESS_BASE + t * (H - CYPRESS_BASE - length * 0.55);
    const hip = new THREE.Vector3(ca * edge * 0.3, low, sa * edge * 0.3), tip = new THREE.Vector3(ca * edge * (0.72 + r() * 0.26), low + length, sa * edge * (0.72 + r() * 0.26));
    axis.subVectors(tip, hip).normalize(); side.set(-sa, 0, ca); out.crossVectors(side, axis).negate();
    const base = pos.length / 3, tone = (0.6 + 0.46 * smooth(0, 0.4, t)) * (0.78 + r() * 0.42);
    for (let j = 0; j <= rings; j++) {
      const s = j / rings, swell = Math.sin(Math.PI * s ** 0.62) ** 0.75, wobble = 1 + 0.16 * Math.sin(s * 9 + i);
      for (let k = 0; k <= sides; k++) {
        const q = ((k % sides) / sides) * Math.PI * 2, cq = Math.cos(q), sq = Math.sin(q), w = width * swell * wobble;
        p.lerpVectors(hip, tip, s).addScaledVector(side, cq * w).addScaledVector(out, sq * w * 0.8);
        p.x += ca * 0.28 * Math.sin(Math.PI * s); p.z += sa * 0.28 * Math.sin(Math.PI * s);
        pos.push(p.x, p.y, p.z);
        radial.set(ca, 0.12, sa).multiplyScalar(0.72).addScaledVector(side, cq * 0.5).addScaledVector(out, sq * 0.5).normalize();
        nor.push(radial.x, radial.y, radial.z);
        uv.push((k / sides) * 1.4, (s * length) / 2.4 + i * 0.37);
        const shade = tone * (0.34 + 0.8 * smooth(0.1, 0.85, s)) * (0.78 + 0.22 * sq);
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
  const bands = { value: new THREE.Vector4() }, BLEND = [3, 10];
  const levels = [0, 1, 2].map((lod) => {
    const m = foliage.clone();
    m.defines = { LOD: lod };
    m.onBeforeCompile = (s) => {
      s.uniforms.bands = bands;
      s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vTreeAt;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTreeAt = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xz;');
      s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec4 bands; varying vec2 vTreeAt;')
        // close up, where the crown turns away from the eye its edge breaks into tufts, not a smooth hard outline
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          #if LOD == 0
            float rim = 1.0 - abs(dot(normalize(vNormal), normalize(vViewPosition)));
            float tuft = fract(sin(dot(floor(vMapUv * vec2(26.0, 34.0)), vec2(12.9898, 78.233))) * 43758.5453);
            if (rim > 0.42 + 0.5 * tuft) discard;
          #endif`)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
          float d = distance(vTreeAt, cameraPosition.xz), n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          float a = 1.0 - smoothstep(bands.x, bands.y, d), b = 1.0 - smoothstep(bands.z, bands.w, d);
          #if LOD == 0
            if (n >= a) discard;
          #elif LOD == 1
            if (n < a || n >= b) discard;
          #else
            if (n < b) discard;
          #endif`);
    };
    return m;
  });
  const sets = [];
  for (let v = 0; v < VARIANTS; v++) {
    sets.push([[170, 5, 4], [46, 4, 3], [18, 3, 2]].map(([sprays, sides, rings], lod) => {
      const mesh = new THREE.InstancedMesh(cypressTree(sprays, sides, rings, v * 9.1, heights[v]), levels[lod], nTrees);
      mesh.frustumCulled = false; mesh.receiveShadow = mesh.castShadow = true; mesh.count = 0;
      scene.add(mesh);
      return mesh;
    }));
  }
  for (let i = 0; i < nTrees; i++) {
    const o = i * 6, t = { x: data[o], y: data[o + 1], z: data[o + 2], r: 1.35, v: i % VARIANTS };   // crowns nearly touch: the rows are hedges
    p.set(t.x, t.y, t.z); q.setFromAxisAngle(yAxis, data[o + 3]); s.set(data[o + 4], data[o + 5], data[o + 4]);
    t.matrix = m.compose(p, q, s).clone();
    tint.setHSL(0.3 + r() * 0.03, 0.5 + r() * 0.12, 0.3 + r() * 0.08);
    t.color = tint.clone();
    trunks.setMatrixAt(i, t.matrix);
    trees.push(t); hash.add(t);
  }
  trunks.castShadow = true; trunks.frustumCulled = false;
  scene.add(trunks);

  // three detail levels of the same tree, by distance from the walker. A tree near a band belongs to
  // both levels, with room to spare for the walker moving on before the next update.
  function updateLOD(x, z, nearDist, spare = 5) {
    const near = nearDist, far = 3 * nearDist, counts = sets.map(() => [0, 0, 0]);
    bands.value.set(near - BLEND[0], near + BLEND[0], far - BLEND[1], far + BLEND[1]);
    const put = (t, lod) => { const k = counts[t.v][lod]++, mesh = sets[t.v][lod]; mesh.setMatrixAt(k, t.matrix); mesh.setColorAt(k, t.color); };
    for (const t of trees) {
      const d = Math.hypot(t.x - x, t.z - z);
      if (d < near + BLEND[0] + spare) put(t, 0);
      if (d > near - BLEND[0] - spare && d < far + BLEND[1] + spare) put(t, 1);
      if (d > far - BLEND[1] - spare) put(t, 2);
    }
    sets.forEach((lods, v) => lods.forEach((mesh, l) => {
      mesh.count = counts[v][l];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }));
  }

  // distant broadleaf woods
  const crown = new THREE.IcosahedronGeometry(1, 2);
  const cp = crown.attributes.position;
  for (let i = 0; i < cp.count; i++) {
    const x = cp.getX(i), y = cp.getY(i), z = cp.getZ(i), k = 0.8 + 0.5 * noise3(x * 2.1, y * 2.1, z * 2.1);
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
  return { hash, updateLOD, count: nTrees };
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
  // a second, much larger sampling hides the tiling at a distance
  mat.onBeforeCompile = (s) => {
    s.fragmentShader = s.fragmentShader.replace('#include <map_fragment>',
      `vec4 g1 = texture2D(map, vMapUv); vec4 g2 = texture2D(map, vMapUv * 0.073 + 0.31);
       diffuseColor.rgb *= mix(g1.rgb, g2.rgb, 0.55) * 1.0;`);
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
        vec2 r = vec2(w(vW.xz, time), w(vW.zx + 7.0, time * 0.8)) * 0.0032 * smoothstep(900.0, 40.0, length(cameraPosition - vW))
               * smoothstep(0.0, 1.2, 20.0 - abs(vW.x));   // still against the coping, or the ripple shows sky along its foot
        vec3 c = texture2DProj(tDiffuse, vUv + vec4(r * vUv.w, 0.0, 0.0)).rgb;
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

// How much light a visitor stands in: full daylight outside, little in the passages, less in the void.
function lightAt(x, y, z) {
  if (y < 13.9 && (Math.abs(x) < 7.3 && z > 23 && z < 100 || Math.abs(z) < 3.6 && Math.abs(x) < 112 || z > -3 && Math.abs(Math.hypot(x, z) - RING_R) < 3)) return 0.3;
  if (y < 17.5 && Math.abs(x) < 3.6 && z > -3.6 && z < 16) return 0.3;                // the room under the tomb and its way out
  return Math.hypot(x, y - CENTER.y, z) < 67 ? 0.16 : 1;
}

// The floor under a point, found by looking down from a little above it. Starting just above the
// last floor keeps the search under a passage's vault rather than on the terrace over it.
function floorBelow(bvh, x, y, z, ray = new THREE.Ray()) {
  ray.origin.set(x, y, z); ray.direction.set(0, -1, 0);
  const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
  return hit ? hit.point.y : y - 1;
}

// Tourists' way in: up from the esplanade, through the arch and along the passage, round the curved
// passage to the east one, up the stair under the dais to the room beneath the tomb, and out of its
// doorway into the sphere.
const ROUTE = [[0, 206], [0, 160], [0, 126], [0, 112], [0, 96],
  ...Array.from({ length: 10 }, (_, k) => [RING_R * Math.sin((Math.PI / 2) * k / 9), RING_R * Math.cos((Math.PI / 2) * k / 9)]),
  [18.5, 0], [3.2, 0], [0, 1.5], [0, 17], [7, 23], [15, 21]];

function makeVisitors(scene, sheet, places, bvh) {
  const r = rng(5), ray = new THREE.Ray(), spots = [[-8, 5.5, 132, 5], [9, 5.5, 136, 3], [-6, 5.5, 112, 4], [11, 5.5, 116, 3], [-14, 46.5, 96, 4], [10, 46.5, 98, 3],
                             [-17, 0, 178, 4], [15, 0, 188, 3], [-26, 0, 310, 2], [26, 0, 430, 3], [-24, 5.5, 150, 2], [-14, 14, -20, 4], [19, 14, 9, 4], [-9, 14, 21, 3], [21, 14, -13, 3], [4.5, 18.6, 3.5, 2],
                             [-30, 5.5, 140, 5], [34, 5.5, 128, 4], [0, 0, 198, 6], [6, 64, 73, 3], [-22, 46.5, 92, 3], [24, 0, 640, 3], [-27, 0, 560, 2]];
  const people = [];
  for (const [x, y, z, n] of spots) for (let i = 0; i < n; i++) {
    const px = x + (r() - 0.5) * 4, pz = z + (r() - 0.5) * 4, py = floorBelow(bvh, px, y + 3, pz, ray);   // standing on whatever is there
    people.push([px, py, pz, lightAt(px, py, pz)]);
  }

  // the route sampled every half metre, each sample on the floor beneath it
  const path = [];
  let y = 1;
  for (let k = 1; k < ROUTE.length; k++) {
    const [x0, z0] = ROUTE[k - 1], [x1, z1] = ROUTE[k], n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.5);
    for (let j = k === 1 ? 0 : 1; j <= n; j++) {
      const x = x0 + (x1 - x0) * j / n, z = z0 + (z1 - z0) * j / n;
      y = floorBelow(bvh, x, y + 1.2, z, ray);
      path.push([x, y, z]);
    }
  }
  const WALKERS = 14, first = people.length, walkers = [];
  for (let i = 0; i < WALKERS; i++) {
    walkers.push({ s: (i / WALKERS) * path.length * 2, side: (r() - 0.5) * 0.5, speed: (0.85 + r() * 0.3) * 1.3 / SCALE, phase: r() * 6 });
    people.push([0, 0, 0, 1]);
  }
  const cut = makeCutouts(sheet, places, people, { scale: SCALE, rand: r, light: FIGURE_LIGHT });
  scene.add(...cut.meshes);
  return {
    // each walks the route in, turns, and walks it out again, keeping to the right
    update(dt) {
      for (const [i, w] of walkers.entries()) {
        w.s = (w.s + dt * w.speed * 2) % (path.length * 2);
        const back = w.s >= path.length, at = back ? path.length * 2 - 1 - w.s : w.s;
        const k = Math.max(0, Math.min(path.length - 2, Math.floor(at))), f = at - k, p0 = path[k], p1 = path[k + 1];
        const dx = p1[0] - p0[0], dz = p1[2] - p0[2], l = Math.hypot(dx, dz) || 1, keep = (back ? -1 : 1) * (0.35 + w.side) / SCALE;
        const x = p0[0] + dx * f - (dz / l) * keep, z = p0[2] + dz * f + (dx / l) * keep;
        const yy = p0[1] + (p1[1] - p0[1]) * f + Math.abs(Math.sin(w.s * 6.2 + w.phase)) * 0.025 / SCALE;   // a step's lift
        cut.move(first + i, x, yy, z, lightAt(x, yy, z));
      }
      cut.moved();
    },
  };
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
  const boreStone = weathered(std({ color: LIMESTONE, map: stone, normalMap: stoneN, normalScale: nS(0.3), roughness: 0.8 }), { streaks: 0, level: 1.5 });   // the bake's vertices are too few for these narrow bores
  const sphere = weathered(std({ color: LIMESTONE, map: stone, normalMap: stoneN, normalScale: nS(0.25), roughness: 0.72, envMapIntensity: 0.45 }), { courses: true });
  const vault = weathered(std({ color: new THREE.Color(0.05, 0.05, 0.053), map: stone, normalMap: stoneN, normalScale: nS(0.3), roughness: 0.88, dithering: true }), { courses: true, streaks: 0 });   // painted black, so the stars stand out
  const paving = weathered(std({ color: LIMESTONE, map: T('paving', true), normalMap: T('paving_n'), normalScale: nS(0.7) }), { streaks: 0 });
  const gravel = weathered(std({ color: new THREE.Color(1.22, 1.08, 0.88), map: T('gravel', true), normalMap: T('gravel_n'), normalScale: nS(0.5), roughness: 0.94 }), { streaks: 0 });
  const soil = std({ map: T('soil', true), roughness: 0.97 });
  const leaves = T('cypress', true);
  const foliage = new THREE.MeshLambertMaterial({ map: leaves, normalMap: T('cypress_n'), normalScale: nS(1.0), vertexColors: true,   // matte: leaves don't mirror the sky
                                                  emissive: 0x3c4a40, emissiveMap: leaves });                                          // this material ignores the sky, so its light is added here
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
  const meshes = [], inside = [];
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  for (const mesh of meshes) {
    const name = nameOf(mesh), isHelper = name.startsWith('COL_');
    if (!NOT_SOLID.has(name)) {
      const g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      for (const k of Object.keys(g.attributes)) if (k !== 'position') g.deleteAttribute(k);
      solids.push(g.index ? g.toNonIndexed() : g);
    }
    if (isHelper) { mesh.visible = false; continue; }
    const key = mesh.material.name;
    if (MATS[key]) {
      const [mat, tile, sph] = MATS[key];
      const g = stoneUVs(mesh.geometry, tile, sph);
      if (g.attributes.color) {
        const c = g.attributes.color, pos = g.attributes.position, baked = new Float32Array(c.count * 3);
        for (let v = 0; v < c.count; v++) {
          const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
          const inFront = Math.abs(x) < 7.3 && z > 23 && z < 110, inSide = Math.abs(z) < 3.5 && Math.abs(x) < 125;
          const inRing = z > -3 && Math.abs(Math.hypot(x, z) - RING_R) < 3;
          const depth = y < 14.1 ? (inFront ? 108 - z : inSide ? 121 - Math.abs(x) : inRing ? 30 : 0) : 0, k = 1 + (PASSAGES - 1) * smooth(0, 14, depth);
          const least = name === 'Basin coping' ? 0.55 : 0;   // its sides meet the ground, where the bake's vertices went dark
          baked[v * 3] = Math.max(c.getX(v) * k, least); baked[v * 3 + 1] = Math.max(c.getY(v) * k, least); baked[v * 3 + 2] = Math.max(c.getZ(v) * k, least);
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
    mesh.castShadow = key !== 'Planting bed (soil, needle litter)' && name !== 'Esplanade and walks' && name !== 'Basin coping';   // low and flat, they would shadow only themselves, in stripes
    mesh.receiveShadow = true;
  }
  const figures = makeFigures(figureList);
  skyThroughHoles(holeBuf, inside, [figures.geometry]);
  scene.add(root, figures);

  const collider = mergeGeometries(solids);
  const bvh = new MeshBVH(collider);

  const outdoors = new THREE.Group();                // none of this can be seen from inside the sphere
  scene.add(outdoors);
  const trees = makeTrees(treeBuf, foliage, outdoors);
  outdoors.add(makeGround(...grass));
  const water = makeBasin();
  outdoors.add(water);
  const sky = makeSky(renderer, scene);
  sky.material.depthTest = false; sky.renderOrder = -1;   // it sits at the far plane, which the reversed depth buffer would put in front
  const fire = makeFire();
  scene.add(fire.group);
  const visitors = makeVisitors(scene, figureSheet, figurePlaces, bvh);
  const lamps = makeLamps(lampBuf);
  scene.add(lamps, makeSconces(lampBuf, bvh));


  // The sun is the only light here. Outdoors its shadow map covers the whole site; underground and
  // in the void it closes in on the shell, fine enough to resolve the bores it shines through.
  const sun = new THREE.DirectionalLight(0xffe2bf, 3.8);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(matchMedia('(pointer: coarse)').matches ? 2048 : 4096);
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
    sun.shadow.radius = close ? 1.6 : 2.2;
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
    FIGURE_LIGHT.value = 0.55 + 0.25 * lift;
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

  const shafts = makeSunshafts(holeBuf);
  const tomb = new THREE.PointLight(0xfff0d8, 0, 42, 1.6);   // the light of all the bores, arriving together on the sarcophagus
  tomb.position.set(0, 28, 0);
  scene.add(tomb);
  shafts.mesh.visible = false;
  scene.add(shafts.mesh);

  return { scene, bvh, trees, water, sky, fire, visitors, sun, setSun, refresh, shadowsClose, lamps, shafts, tomb, sunStrength: () => sunStrength };

}
