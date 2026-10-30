// Everything in the scene: stone from the Blender model, instanced cypresses, ground,
// basin, sky, and the star vault.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';
import { noise3, rng, smooth, SCALE } from './util.js';
import { figureGeometries } from './character.js';

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

const NOT_SOLID = new Set(['Main stair', 'Front stair block', 'Planting beds', 'Lions', 'Funeral brazier',
                           'Esplanade and walks', 'Drum dentils', 'Bridge portal door']);

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
function weathered(mat, { streaks = 1, courses = false } = {}) {
  mat.onBeforeCompile = (s) => {
    s.uniforms.skyLevel = SKY_LEVEL;
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP, vBaked; attribute vec3 baked;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWP = (modelMatrix * vec4(position, 1.0)).xyz; vBaked = baked;');
    s.fragmentShader = s.fragmentShader.replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
      #ifdef USE_ENVMAP
        iblIrradiance = vec3(0.0);                    // diffuse sky comes from the path traced bake instead
      #endif
      irradiance += vBaked * skyLevel;`)
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
      us = pts.map((v) => Math.atan2(v.x, CENTER.y - v.y) * coneR); vs = pts.map((v) => v.z);
    } else if (radial > 0.85) {
      us = unwrap(pts.map((v) => Math.atan2(v.z, v.x)), Math.PI * 2).map((v) => v * R); vs = pts.map((v) => v.y);
    } else {
      us = pts.map((v) => (Math.abs(n.x) > Math.abs(n.z) ? v.z : v.x)); vs = pts.map((v) => v.y);
    }
    for (let k = 0; k < 3; k++) { uv[(i + k) * 2] = us[k] / tile; uv[(i + k) * 2 + 1] = vs[k] / tile; }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/**
 * Daylight reaching the inside of the sphere: each bore is a small patch of sky, summed over every
 * vertex with the form factor between them. Inside a closed sphere every patch then sees every
 * other equally, so interreflection adds the same amount everywhere: mean * albedo / (1 - albedo).
 */
function skyThroughHoles(buffer, geometries) {
  const count = new Uint32Array(buffer, 0, 1)[0], data = new Float32Array(buffer, 4, count * 4), STRIDE = 3;
  const hx = [], hy = [], hz = [], dx = [], dy = [], dz = [], area = [];
  for (let i = 0; i < count; i += STRIDE) {
    const o = i * 4, x = data[o], y = data[o + 1], z = data[o + 2], r = data[o + 3];
    dx.push(x); dy.push(y); dz.push(z);
    hx.push(x * 67 + CENTER.x); hy.push(y * 67 + CENTER.y); hz.push(z * 67 + CENTER.z);
    area.push(Math.PI * (0.9 * r) ** 2 * STRIDE);
  }
  let sum = 0, verts = 0;
  const fields = geometries.map((g) => {
    const p = g.attributes.position, n = g.attributes.normal, E = new Float32Array(p.count);
    for (let v = 0; v < p.count; v += 3) {            // one value per triangle corner set keeps this quick
      const x = p.getX(v), y = p.getY(v), z = p.getZ(v), nx = n.getX(v), ny = n.getY(v), nz = n.getZ(v);
      let e = 0;
      for (let h = 0; h < hx.length; h++) {
        const vx = hx[h] - x, vy = hy[h] - y, vz = hz[h] - z, d2 = vx * vx + vy * vy + vz * vz;
        const at = nx * vx + ny * vy + nz * vz, from = dx[h] * vx + dy[h] * vy + dz[h] * vz;
        if (at > 0 && from > 0) e += area[h] * at * from / (Math.PI * d2 * d2);
      }
      E[v] = E[v + 1] = E[v + 2] = e; sum += e; verts++;
    }
    return E;
  });
  const albedo = 0.45, shared = (sum / verts) * albedo / (1 - albedo);
  geometries.forEach((g, i) => {
    const E = fields[i], baked = new Float32Array(E.length * 3);
    for (let v = 0; v < E.length; v++) { const e = E[v] + shared; baked[v * 3] = e * 0.74; baked[v * 3 + 1] = e * 0.86; baked[v * 3 + 2] = e; }
    g.setAttribute('baked', new THREE.BufferAttribute(baked, 3));
  });
}

// ----------------------------------------------------------------- vegetation
// 'Stricta' outline: a slender column drawn to a point, widest below the middle
const cypressOutline = (t) => smooth(0, 0.1, t) ** 0.5 * (1 - t ** 2.4) ** 0.85;
const CYPRESS_R = 1.2, CYPRESS_BASE = 0.8;

function cypressGeometry(seg, rings, seed, H, core) {
  const pos = [], nor = [], uv = [], col = [], idx = [];
  const rad = (a, t, z) => {
    const n = noise3(Math.cos(a) * 1.3 + seed, z * 0.34, Math.sin(a) * 1.3 + seed) - 0.5;
    const plumes = Math.sin(a * 7 + seed + z * 0.55 + 2.2 * n);
    return Math.max(CYPRESS_R * cypressOutline(t) * (1 + 0.3 * n + 0.09 * plumes) * (core ? 0.84 : 1), 0.015);
  };
  for (let j = 0; j <= rings; j++) {
    const t = j / rings, z = CYPRESS_BASE - 0.3 + t * (H - CYPRESS_BASE + 0.3);
    for (let i = 0; i <= seg; i++) {
      const a = ((i % seg) / seg) * Math.PI * 2, r = rad(a, t, z);
      pos.push(Math.cos(a) * r, z, Math.sin(a) * r);
      uv.push((i / seg) * 3, z / 3.2);
      const shade = (0.55 + 0.45 * smooth(0, 0.32, t) * (0.72 + 0.56 * noise3(Math.cos(a) * 3 + seed, z, Math.sin(a) * 3))) * (core ? 0.42 : 1);
      col.push(shade, shade, shade);
    }
  }
  for (let j = 0; j < rings; j++) for (let i = 0; i < seg; i++) {
    const a = j * (seg + 1) + i, b = a + seg + 1;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const n = g.attributes.normal;     // close the seam
  for (let j = 0; j <= rings; j++) {
    const a = j * (seg + 1), b = a + seg;
    const x = n.getX(a) + n.getX(b), y = n.getY(a) + n.getY(b), z = n.getZ(a) + n.getZ(b), l = Math.hypot(x, y, z) || 1;
    n.setXYZ(a, x / l, y / l, z / l); n.setXYZ(b, x / l, y / l, z / l);
  }
  return g;
}

/** Up-swept foliage sprays around the core, shaded as if the crown were one soft mass. */
function cypressSprays(count, seed, H, grow = 1) {
  const r = rng(seed * 997 + 3), pos = [], nor = [], uv = [], col = [], idx = [];
  const tangent = new THREE.Vector3(), rise = new THREE.Vector3(), normal = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    const t = 0.03 + 0.95 * r() ** 0.8, a = r() * Math.PI * 2, z = CYPRESS_BASE + t * (H - CYPRESS_BASE), ca = Math.cos(a), sa = Math.sin(a);
    const radius = CYPRESS_R * cypressOutline(t) * (0.82 + 0.2 * r()), slim = 0.55 + 0.6 * (1 - t);
    const w = (0.8 + 0.35 * r()) * slim * grow, h = (1.5 + 0.7 * r()) * slim * grow, lean = -0.12 - 0.22 * t;
    tangent.set(-sa, 0, ca); rise.set(ca * lean, 1, sa * lean).normalize(); normal.set(ca, 0.28, sa).normalize();
    c.set(ca * radius, z - h * 0.4, sa * radius);
    const shade = (0.5 + 0.55 * smooth(0, 0.3, t)) * (0.78 + 0.36 * r()), base = pos.length / 3;
    for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const o = (v ? 0.14 : 0) * (1 + r());
      pos.push(c.x + tangent.x * (u - 0.5) * w + rise.x * v * h + ca * o, c.y + rise.y * v * h, c.z + tangent.z * (u - 0.5) * w + rise.z * v * h + sa * o);
      nor.push(normal.x, normal.y, normal.z);
      uv.push(u, v);
      const k = shade * (v ? 1 : 0.6);
      col.push(k, k, k);
    }
    idx.push(base, base + 1, base + 3, base, base + 3, base + 2, base + 3, base + 1, base, base + 2, base + 3, base);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

/** One foliage spray, drawn at load: overlapping scale-leaf strokes tapering to a tip. */
function sprayTexture(renderer) {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const x = c.getContext('2d'), r = rng(21);
  x.lineCap = 'round';
  for (let i = 0; i < 900; i++) {
    const v = r() ** 0.8, half = 104 * (1 - v) ** 0.62 * (0.25 + 0.75 * smooth(0, 0.14, v));
    const px = 128 + (r() * 2 - 1) * half, py = 252 - v * 244, side = Math.sign(px - 128) || 1;
    const len = 7 + r() * 16;
    x.strokeStyle = `hsl(${92 + r() * 30} ${16 + r() * 18}% ${22 + r() * 34}%)`;
    x.lineWidth = 1.6 + r() * 3.4;
    x.beginPath(); x.moveTo(px, py); x.quadraticCurveTo(px + side * len * 0.15, py - len * 0.7, px + side * len * 0.45, py - len); x.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return t;
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

function makeTrees(buffer, foliage, sprays, scene) {
  const head = new Uint32Array(buffer, 0, 2), [nTrees, nWood] = head;
  const data = new Float32Array(buffer, 8, nTrees * 6), wood = new Float32Array(buffer, 8 + nTrees * 24, nWood * 4);
  const VARIANTS = 3, heights = [10.0, 10.7, 11.2], r = rng(7), hash = new TreeHash(6);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), yAxis = new THREE.Vector3(0, 1, 0);
  const trees = [], tint = new THREE.Color();
  const bark = new THREE.MeshStandardMaterial({ color: 0x3c2a1e, roughness: 0.95 });
  const trunkGeo = new THREE.CylinderGeometry(0.11, 0.2, 1.7, 6, 1, true).translate(0, 0.75, 0);
  const trunks = new THREE.InstancedMesh(trunkGeo, bark, nTrees);
  const sets = [];
  for (let v = 0; v < VARIANTS; v++) {
    // every tree carries real foliage; further off, fewer and larger sprays stand in for the same mass
    const far = new THREE.InstancedMesh(cypressGeometry(10, 10, v * 9.1, heights[v], true), foliage, nTrees);
    const near = new THREE.InstancedMesh(cypressGeometry(24, 30, v * 9.1, heights[v], true), foliage, nTrees);
    const lean = matchMedia('(pointer: coarse)').matches ? 0.5 : 1;   // phones get half the sprays, each larger
    const fronds = new THREE.InstancedMesh(cypressSprays(420 * lean, v * 9.1, heights[v], 1 / Math.sqrt(lean)), sprays, nTrees);
    const farFronds = new THREE.InstancedMesh(cypressSprays(150 * lean, v * 9.1, heights[v], 1.65 / Math.sqrt(lean)), sprays, nTrees);
    for (const mesh of [far, near, fronds, farFronds]) { mesh.frustumCulled = false; mesh.receiveShadow = true; }
    far.castShadow = near.castShadow = true;
    near.count = fronds.count = 0;
    sets.push({ far, near, fronds, farFronds }); scene.add(far, near, fronds, farFronds);
  }
  for (let i = 0; i < nTrees; i++) {
    const o = i * 6, t = { x: data[o], y: data[o + 1], z: data[o + 2], r: 1.35, v: i % VARIANTS };   // crowns nearly touch: the rows are hedges
    p.set(t.x, t.y, t.z); q.setFromAxisAngle(yAxis, data[o + 3]); s.set(data[o + 4], data[o + 5], data[o + 4]);
    t.matrix = m.compose(p, q, s).clone();
    tint.setHSL(0.27 + r() * 0.035, 0.3 + r() * 0.12, 0.36 + r() * 0.12);
    t.color = tint.clone();
    trunks.setMatrixAt(i, t.matrix);
    trees.push(t); hash.add(t);
  }
  trunks.castShadow = true; trunks.frustumCulled = false;
  scene.add(trunks);

  // two detail levels; only trees close to the walker use the fine one
  function updateLOD(x, z, nearDist) {
    const n2 = nearDist * nearDist, counts = sets.map(() => [0, 0]);
    for (const t of trees) {
      const d = (t.x - x) ** 2 + (t.z - z) ** 2, set = sets[t.v], c = counts[t.v];
      const isNear = d < n2, mesh = isNear ? set.near : set.far, k = isNear ? c[0]++ : c[1]++;
      const leaves = isNear ? set.fronds : set.farFronds;
      mesh.setMatrixAt(k, t.matrix); mesh.setColorAt(k, t.color);
      leaves.setMatrixAt(k, t.matrix); leaves.setColorAt(k, t.color);
    }
    sets.forEach((set, v) => {
      set.near.count = set.fronds.count = counts[v][0]; set.far.count = set.farFronds.count = counts[v][1];
      for (const mesh of [set.near, set.far, set.fronds, set.farFronds]) {
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    });
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
  return { hash, updateLOD, count: nTrees, castShadows(on) { for (const s of sets) s.far.castShadow = s.near.castShadow = on; } };
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
        vec2 r = vec2(w(vW.xz, time), w(vW.zx + 7.0, time * 0.8)) * 0.0032 * smoothstep(900.0, 40.0, length(cameraPosition - vW));
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

/** The brazier: a turbulent flame, sparks and smoke, and a real light thrown on the stone round it. */
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

  const light = new THREE.PointLight(0xff9a48, 0, 70, 1.5);
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

function makeVisitors(scene) {
  const r = rng(5), spots = [[-8, 5.5, 132, 5], [9, 5.5, 136, 3], [-6, 5.5, 60, 4], [11, 5.5, 50, 3], [-14, 46.5, 96, 4], [10, 46.5, 98, 3],
                             [-17, 0, 178, 4], [15, 0, 188, 3], [-26, 0, 310, 2], [26, 0, 430, 3], [3.2, 9.5, 2.5, 2], [-24, 5.5, 150, 2], [-11, 9.5, -4, 4], [13, 9.5, 8, 4], [-8, 9.5, 12, 3], [15, 9.5, -12, 3],
                             [-30, 5.5, 140, 5], [34, 5.5, 128, 4], [0, 0, 198, 6], [6, 64, 73, 3], [-22, 46.5, 92, 3], [24, 0, 640, 3], [-27, 0, 560, 2]];
  const black = new THREE.MeshBasicMaterial({ color: 0x000000, fog: false }), list = [];
  for (const g of figureGeometries()) {
    const mesh = new THREE.InstancedMesh(g, black, 40);
    mesh.frustumCulled = false; mesh.count = 0; mesh.castShadow = true; list.push(mesh); scene.add(mesh);
  }
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
  for (const [x, y, z, n] of spots) for (let i = 0; i < n; i++) {
    p.set(x + (r() - 0.5) * 4, y, z + (r() - 0.5) * 4); q.setFromAxisAngle(up, r() * 6.28); s.setScalar((0.9 + r() * 0.1) / SCALE);
    const mesh = list[Math.floor(r() * list.length)];
    mesh.setMatrixAt(mesh.count++, m.compose(p, q, s));
  }
}

// ----------------------------------------------------------------------- load
export async function loadWorld(renderer, onProgress) {
  const manager = new THREE.LoadingManager();
  manager.onProgress = (_, done, total) => onProgress(done / total);
  const T = (name, srgb = false) => load(name, srgb, renderer, manager);

  placeSun(0.3);
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0xd3dbe3, 0.00045 * Math.sqrt(SCALE));   // aerial haze, none up close

  const std = (o) => new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0, ...o });
  const LIMESTONE = 0xe6d6b8;      // warms and tones down the neutral stone textures
  const nS = (v) => new THREE.Vector2(v, v);
  const ashlar = weathered(std({ color: LIMESTONE, map: T('ashlar', true), normalMap: T('ashlar_n'), normalScale: nS(0.9) }));
  const stone = T('stone', true), stoneN = T('stone_n');
  const dressed = weathered(std({ color: LIMESTONE, map: stone, normalMap: stoneN, normalScale: nS(0.5), roughness: 0.74 }), { streaks: 0.4 });
  const sphere = weathered(std({ color: LIMESTONE, map: stone, normalMap: stoneN, normalScale: nS(0.25), roughness: 0.72, envMapIntensity: 0.45 }), { courses: true });
  const vault = weathered(std({ color: LIMESTONE, map: stone, normalMap: stoneN, normalScale: nS(0.3), roughness: 0.9, dithering: true }), { courses: true, streaks: 0.6 });
  const paving = weathered(std({ color: LIMESTONE, map: T('paving', true), normalMap: T('paving_n'), normalScale: nS(0.7) }), { streaks: 0 });
  const gravel = weathered(std({ color: new THREE.Color(1.22, 1.08, 0.88), map: T('gravel', true), normalMap: T('gravel_n'), normalScale: nS(0.5), roughness: 0.94 }), { streaks: 0 });
  const soil = std({ map: T('soil', true), roughness: 0.97 });
  const foliage = std({ map: T('cypress', true), normalMap: T('cypress_n'), normalScale: nS(1.2), vertexColors: true, roughness: 0.86 });
  const sprays = std({ map: sprayTexture(renderer), alphaTest: 0.42, alphaToCoverage: true, vertexColors: true, roughness: 0.9 });
  const grass = [T('grass', true), T('grass_n')];
  const MATS = {
    'Vault: pierced shell (star holes)': [vault, 12, true], Bore: [dressed, 12 / SCALE], 'Limestone ashlar': [ashlar, 15.6 / SCALE], 'Limestone dressed': [dressed, 12 / SCALE], 'Limestone sphere': [sphere, 12, true],
    'Limestone paving': [paving, 6.4 / SCALE], 'Gravel (terrace walks)': [gravel, 4 / SCALE], 'Planting bed (soil, needle litter)': [soil, 3 / SCALE],
  };

  const draco = new DRACOLoader(manager).setDecoderPath('./draco/');
  const gltfLoader = new GLTFLoader(manager).setDRACOLoader(draco);
  const fileLoader = new THREE.FileLoader(manager).setResponseType('arraybuffer');
  const [gltf, treeBuf, holeBuf, lampBuf] = await Promise.all([gltfLoader.loadAsync('assets/monument.glb'), fileLoader.loadAsync('assets/trees.bin'),
    fileLoader.loadAsync('assets/holes.bin'), fileLoader.loadAsync('assets/lamps.bin')]);
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
      if (g.attributes.color) { g.setAttribute('baked', g.attributes.color); g.deleteAttribute('color'); }
      mesh.geometry = g;
      mesh.material = mat;
      if (key.startsWith('Vault') || name === 'Interior floor' || name.startsWith('Sarcophagus')) inside.push(g);
    }
    mesh.castShadow = key !== 'Planting bed (soil, needle litter)';
    mesh.receiveShadow = true;
  }
  skyThroughHoles(holeBuf, inside);
  scene.add(root);

  const collider = mergeGeometries(solids);
  const bvh = new MeshBVH(collider);

  const trees = makeTrees(treeBuf, foliage, sprays, scene);
  scene.add(makeGround(...grass));
  const water = makeBasin();
  scene.add(water);
  const sky = makeSky(renderer, scene);
  const fire = makeFire();
  scene.add(fire.group);
  makeVisitors(scene);
  const lamps = makeLamps(lampBuf);
  scene.add(lamps);


  // The sun is the only light here. Outdoors its shadow map covers the whole site; underground and
  // in the void it closes in on the shell, fine enough to resolve the bores it shines through.
  const sun = new THREE.DirectionalLight(0xffe2bf, 3.8);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(matchMedia('(pointer: coarse)').matches ? 2048 : 4096);
  sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.35; sun.shadow.radius = 2.2;
  scene.add(sun, sun.target);
  let close = false;
  const low = new THREE.Color(0xffb878), high = new THREE.Color(0xfff0dc);
  const skyUniforms = sky.material.uniforms;
  const refresh = () => {
    const cam = sun.shadow.camera, half = close ? 170 : 560;
    sun.target.position.set(0, 0, close ? 0 : 170);
    sun.position.copy(sun.target.position).addScaledVector(SUN, 1100);
    Object.assign(cam, { left: -half, right: half, top: close ? half : 520, bottom: close ? -half : -520, near: 300, far: 1900 });
    cam.updateProjectionMatrix();
    sun.shadow.bias = close ? -0.00006 : -0.0003;
    sun.shadow.normalBias = close ? 0.03 : 0.35;
    sun.shadow.radius = close ? 1 : 2.2;
    renderer.shadowMap.needsUpdate = true;
  };
  const setSun = (u) => {
    placeSun(u);
    skyUniforms.sunPosition.value.copy(SUN);
    const lift = smooth(0.1, 0.6, SUN.y);
    sun.color.lerpColors(low, high, lift);
    sun.intensity = 2.6 + 1.1 * lift;
    SKY_LEVEL.value = 0.5 + 0.5 * lift;
    sun.position.copy(sun.target.position).addScaledVector(SUN, 1100);
  };
  const shadowsClose = (on) => { if (on !== close) { close = on; trees.castShadows(!on); refresh(); } };
  refresh();

  return { scene, bvh, trees, water, sky, fire, sun, setSun, refresh, shadowsClose, lamps };

}
