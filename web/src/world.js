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
export const SUN = new THREE.Vector3().setFromSphericalCoords(1, Math.PI / 2 - THREE.MathUtils.degToRad(28), 0);
{ // low and from the left, so half the sphere falls into shadow as in Boullée's sheets
  const a = THREE.MathUtils.degToRad(-172), e = THREE.MathUtils.degToRad(22);
  SUN.set(Math.cos(e) * Math.cos(a), Math.sin(e), -Math.cos(e) * Math.sin(a));
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

/** Weather that repeats nowhere: broad tonal drift, rain streaks, and the sphere's stone courses. */
function weathered(mat, { streaks = 1, courses = false } = {}) {
  mat.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWP = (modelMatrix * vec4(position, 1.0)).xyz;');
    s.fragmentShader = s.fragmentShader.replace('#include <common>', `#include <common>
      varying vec3 vWP;
      float vh(vec3 p) { p = fract(p * 0.3183 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      float vn(vec3 p) { vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(vh(i), vh(i + vec3(1, 0, 0)), f.x), mix(vh(i + vec3(0, 1, 0)), vh(i + vec3(1, 1, 0)), f.x), f.y),
                   mix(mix(vh(i + vec3(0, 0, 1)), vh(i + vec3(1, 0, 1)), f.x), mix(vh(i + vec3(0, 1, 1)), vh(i + vec3(1, 1, 1)), f.x), f.y), f.z); }
      float fb(vec3 p) { return 0.55 * vn(p) + 0.3 * vn(p * 2.1 + 3.1) + 0.15 * vn(p * 4.3 + 7.7); }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
      diffuseColor.rgb *= 0.8 + 0.3 * fb(vWP * 0.016) + 0.1 * fb(vWP * 0.13);
      float lng = atan(vWP.z, vWP.x);
      diffuseColor.rgb *= 1.0 - ${streaks.toFixed(1)} * 0.2 * smoothstep(0.52, 0.8, fb(vec3(lng * 46.0, vWP.y * 0.016, 2.0)));
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

/** Bore walls catch the sky, so a hole stays a point of daylight from anywhere on the floor. */
function boreMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: `varying float vR; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vR = distance(w.xyz, vec3(0.0, 73.5, 0.0)); gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `varying float vR; void main(){ float t = smoothstep(66.5, 74.0, vR);
      vec3 c = mix(vec3(0.1, 0.13, 0.2), vec3(1.5, 1.7, 2.0), t * t);
      if (distance(cameraPosition, vec3(0.0, 73.5, 0.0)) > 72.0) c = vec3(0.03, 0.027, 0.025);
      gl_FragColor = vec4(c, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
  });
}

/**
 * Daylight inside the sphere. The openings are real holes in the shell, so the sky needs no help;
 * this adds what the air does with the sun: shafts crossing the void and the pools where they land.
 */
function vaultLight(buffer) {
  const group = new THREE.Group(), R = 66.9;
  const n = new Uint32Array(buffer, 0, 1)[0], data = new Float32Array(buffer, 4, n * 4);
  const scale = { value: 800 }, d = new THREE.Vector3(), from = [], to = [], width = [], spot = [], spotSize = [], glint = [], glintSize = [];
  for (let i = 0; i < n; i++) {
    d.fromArray(data, i * 4);
    const r = data[i * 4 + 3], toSun = d.dot(SUN);
    glint.push(d.x * R + CENTER.x, d.y * R + CENTER.y, d.z * R + CENTER.z); glintSize.push(r * 2);
    if (toSun < 0.9) continue;
    const a = d.clone().multiplyScalar(R).add(CENTER), b = d.clone().addScaledVector(SUN, -2 * toSun).multiplyScalar(R).add(CENTER);
    from.push(a.x, a.y, a.z); to.push(b.x, b.y, b.z); width.push(r * 1.7);
    spot.push(b.x, b.y, b.z); spotSize.push(r * 2.2);
  }

  const shafts = new THREE.InstancedBufferGeometry();
  shafts.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0, 0.5, 1, 0], 3));
  shafts.setIndex([0, 1, 3, 0, 3, 2]);
  shafts.setAttribute('from', new THREE.InstancedBufferAttribute(new Float32Array(from), 3));
  shafts.setAttribute('to', new THREE.InstancedBufferAttribute(new Float32Array(to), 3));
  shafts.setAttribute('width', new THREE.InstancedBufferAttribute(new Float32Array(width), 1));
  shafts.instanceCount = width.length;
  const beams = new THREE.Mesh(shafts, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    vertexShader: `attribute vec3 from, to; attribute float width; varying vec2 vP;
      void main(){ vec3 p = mix(from, to, position.y), axis = normalize(to - from), side = normalize(cross(axis, cameraPosition - p));
        vP = vec2(position.x * 2.0, position.y); gl_Position = projectionMatrix * viewMatrix * vec4(p + side * position.x * width, 1.0); }`,
    fragmentShader: `varying vec2 vP; void main(){ float e = 1.0 - vP.x * vP.x;
      gl_FragColor = vec4(vec3(1.0, 0.86, 0.66) * e * e * (0.075 - 0.04 * vP.y), 1.0); }`,
  }));
  beams.frustumCulled = false;

  // sprites stand flat while the wall curves behind them, so their depth is pulled off the wall
  const points = (positions, sizes, glsl, grow = '1.0') => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('size', new THREE.Float32BufferAttribute(sizes, 1));
    const pts = new THREE.Points(g, new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { scale },
      vertexShader: `attribute float size; uniform float scale;
        void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = max(1.5, size * scale / -mv.z) * ${grow};
          gl_Position = projectionMatrix * mv;
          vec4 lifted = projectionMatrix * (mv + vec4(0.0, 0.0, 1.8, 0.0)); gl_Position.z = lifted.z / lifted.w * gl_Position.w; }`,
      fragmentShader: glsl }));
    pts.frustumCulled = false;
    return pts;
  };
  group.add(beams,
    points(spot, spotSize, `void main(){ float d = length(gl_PointCoord - 0.5) * 2.0;
      gl_FragColor = vec4(vec3(1.0, 0.8, 0.55) * smoothstep(1.0, 0.5, d) * 0.2, 1.0); }`),
    points(glint, glintSize, `void main(){ float d = length(gl_PointCoord - 0.5) * 2.0;
      gl_FragColor = vec4(vec3(0.55, 0.72, 1.0) * exp(-d * d * 6.0) * 0.13, 1.0); }`, '2.4'));
  // the luminous mist round the sarcophagus in Boullée's section
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d'), g = x.createRadialGradient(64, 64, 2, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,.5)'); g.addColorStop(0.5, 'rgba(255,255,255,.14)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 128, 128);
  const map = new THREE.CanvasTexture(c), r = rng(9);
  for (let i = 0; i < 22; i++) {
    const m = new THREE.Sprite(new THREE.SpriteMaterial({ map, color: 0x9fb0c4, transparent: true, depthWrite: false, opacity: 0.05 + r() * 0.05, blending: THREE.AdditiveBlending, fog: false }));
    const a = r() * Math.PI * 2, far = 8 + r() * 30, size = 30 + r() * 42;
    m.position.set(Math.cos(a) * far, 11 + r() * 5, Math.sin(a) * far); m.scale.set(size * 1.5, size * 0.32, 1);
    group.add(m);
  }
  group.userData.scale = scale;
  return group;
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
function cypressSprays(count, seed, H) {
  const r = rng(seed * 997 + 3), pos = [], nor = [], uv = [], col = [], idx = [];
  const tangent = new THREE.Vector3(), rise = new THREE.Vector3(), normal = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    const t = 0.03 + 0.95 * r() ** 0.8, a = r() * Math.PI * 2, z = CYPRESS_BASE + t * (H - CYPRESS_BASE), ca = Math.cos(a), sa = Math.sin(a);
    const radius = CYPRESS_R * cypressOutline(t) * (0.82 + 0.2 * r()), slim = 0.55 + 0.6 * (1 - t);
    const w = (0.8 + 0.35 * r()) * slim, h = (1.5 + 0.7 * r()) * slim, lean = -0.12 - 0.22 * t;
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
    const far = new THREE.InstancedMesh(cypressGeometry(14, 14, v * 9.1, heights[v], false), foliage, nTrees);
    const near = new THREE.InstancedMesh(cypressGeometry(24, 30, v * 9.1, heights[v], true), foliage, nTrees);
    const fronds = new THREE.InstancedMesh(cypressSprays(420, v * 9.1, heights[v]), sprays, nTrees);
    far.castShadow = true; far.receiveShadow = near.receiveShadow = fronds.receiveShadow = true;
    far.frustumCulled = near.frustumCulled = fronds.frustumCulled = false;
    near.count = fronds.count = 0;
    sets.push({ far, near, fronds }); scene.add(far, near, fronds);
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
      mesh.setMatrixAt(k, t.matrix); mesh.setColorAt(k, t.color);
      if (isNear) { set.fronds.setMatrixAt(k, t.matrix); set.fronds.setColorAt(k, t.color); }
    }
    sets.forEach((set, v) => {
      set.near.count = set.fronds.count = counts[v][0]; set.far.count = counts[v][1];
      for (const mesh of [set.near, set.far, set.fronds]) {
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

function makeFire() {
  const group = new THREE.Group();
  group.position.set(0, 64, 78);
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.95, 2.6, 16, 1, true).translate(0, 4.1, 0),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(7, 2.6, 0.5), side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthWrite: false }));
  group.add(flame);
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d'), g = x.createRadialGradient(64, 64, 4, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,.75)'); g.addColorStop(0.5, 'rgba(255,255,255,.26)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 128, 128);
  const map = new THREE.CanvasTexture(c), puffs = [], r = rng(11);
  for (let i = 0; i < 30; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map, color: 0x6f6b66, transparent: true, depthWrite: false, opacity: 0 }));
    s.userData = { t: i / 30, x: r() * 2 - 1, z: r() * 2 - 1 };
    group.add(s); puffs.push(s);
  }
  return {
    group,
    update(dt, time) {
      flame.scale.set(1 + 0.12 * Math.sin(time * 13), 1 + 0.2 * Math.sin(time * 9.3) + 0.08 * Math.sin(time * 21), 1 + 0.12 * Math.cos(time * 11));
      for (const s of puffs) {
        const d = s.userData; d.t = (d.t + dt * 0.042) % 1;
        const t = d.t, y = 6 + t * 58;
        s.position.set(d.x * (1 + t * 6) + t * t * 24, y, d.z * (1 + t * 6));
        const size = 3 + t * 21; s.scale.set(size, size, 1);
        s.material.opacity = 0.5 * smooth(0, 0.06, t) * (1 - smooth(0.4, 1, t));
      }
    },
  };
}

function makeVisitors(scene) {
  const r = rng(5), spots = [[-8, 5.5, 132, 5], [9, 5.5, 136, 3], [-6, 5.5, 60, 4], [11, 5.5, 50, 3], [-14, 46.5, 96, 4], [10, 46.5, 98, 3],
                             [-17, 0, 178, 4], [15, 0, 188, 3], [-26, 0, 310, 2], [26, 0, 430, 3], [3.2, 9.5, 2.5, 2], [-24, 5.5, 150, 2], [-11, 9.5, -4, 4], [13, 9.5, 8, 4], [-8, 9.5, 12, 3], [15, 9.5, -12, 3],
                             [-30, 5.5, 140, 5], [34, 5.5, 128, 4], [0, 0, 198, 6], [6, 64, 73, 3], [-22, 46.5, 92, 3], [24, 0, 640, 3], [-27, 0, 560, 2]];
  const black = new THREE.MeshBasicMaterial({ color: 0x0b0c0f }), list = [];
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

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0xd3dbe3, 0.00045 * Math.sqrt(SCALE));   // aerial haze, none up close

  const std = (o) => new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0, ...o });
  const LIMESTONE = 0xe6d6b8;      // warms and tones down the neutral stone textures
  const nS = (v) => new THREE.Vector2(v, v);
  const ashlar = weathered(std({ color: LIMESTONE, map: T('ashlar', true), normalMap: T('ashlar_n'), normalScale: nS(0.9) }));
  const stone = T('stone', true), stoneN = T('stone_n');
  const dressed = weathered(std({ color: LIMESTONE, map: stone, normalMap: stoneN, normalScale: nS(0.5), roughness: 0.74 }), { streaks: 0.4 });
  const sphere = weathered(std({ color: LIMESTONE, map: stone, normalMap: stoneN, normalScale: nS(0.25), roughness: 0.72, envMapIntensity: 0.45 }), { courses: true });
  const vault = weathered(std({ color: 0x8a8173, map: stone, normalMap: stoneN, normalScale: nS(0.3), roughness: 0.9, envMapIntensity: 0.2, dithering: true }), { courses: true, streaks: 0.6 });
  const paving = weathered(std({ color: LIMESTONE, map: T('paving', true), normalMap: T('paving_n'), normalScale: nS(0.7) }), { streaks: 0 });
  const gravel = weathered(std({ color: new THREE.Color(1.7, 1.52, 1.24), map: T('gravel', true), normalMap: T('gravel_n'), normalScale: nS(0.5), roughness: 0.94 }), { streaks: 0 });
  const soil = std({ map: T('soil', true), roughness: 0.97 });
  const foliage = std({ map: T('cypress', true), normalMap: T('cypress_n'), normalScale: nS(1.2), vertexColors: true, roughness: 0.86 });
  const sprays = std({ map: sprayTexture(renderer), alphaTest: 0.42, vertexColors: true, roughness: 0.9 });
  const grass = [T('grass', true), T('grass_n')];
  const MATS = {
    'Vault: pierced shell (star holes)': [vault, 12, true], 'Limestone ashlar': [ashlar, 15.6 / SCALE], 'Limestone dressed': [dressed, 12 / SCALE], 'Limestone sphere': [sphere, 12, true],
    'Limestone paving': [paving, 6.4 / SCALE], 'Gravel (terrace walks)': [gravel, 4 / SCALE], 'Planting bed (soil, needle litter)': [soil, 3 / SCALE],
  };

  const draco = new DRACOLoader(manager).setDecoderPath('./draco/');
  const gltfLoader = new GLTFLoader(manager).setDRACOLoader(draco);
  const fileLoader = new THREE.FileLoader(manager).setResponseType('arraybuffer');
  const [gltf, treeBuf, holeBuf] = await Promise.all([gltfLoader.loadAsync('assets/monument.glb'), fileLoader.loadAsync('assets/trees.bin'), fileLoader.loadAsync('assets/holes.bin')]);
  draco.dispose();

  const root = gltf.scene, solids = [];
  root.updateMatrixWorld(true);
  const nameOf = (o) => { let n = o; while (n.parent && n.parent !== root) n = n.parent; return n.userData.name ?? n.name; };
  const meshes = [];
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
    if (key === 'Bore') { mesh.material = boreMaterial(); mesh.castShadow = true; continue; }
    if (MATS[key]) {
      const [mat, tile, sph] = MATS[key];
      mesh.geometry = stoneUVs(mesh.geometry, tile, sph);
      mesh.material = mat;
    }
    mesh.castShadow = key !== 'Planting bed (soil, needle litter)';
    mesh.receiveShadow = true;
  }
  scene.add(root);

  const collider = mergeGeometries(solids);
  const bvh = new MeshBVH(collider);

  const trees = makeTrees(treeBuf, foliage, sprays, scene);
  scene.add(makeGround(...grass));
  const water = makeBasin();
  scene.add(water);
  const sky = makeSky(renderer, scene);
  const stars = vaultLight(holeBuf);
  scene.add(stars);
  const fire = makeFire();
  scene.add(fire.group);
  makeVisitors(scene);

  // Sun. It never moves, so its shadow map is drawn once and kept.
  const sun = new THREE.DirectionalLight(0xffdfb8, 4.0);
  sun.target.position.set(0, 0, 170);
  sun.position.copy(sun.target.position).addScaledVector(SUN, 1100);
  sun.castShadow = true;
  const mobile = matchMedia('(pointer: coarse)').matches;
  sun.shadow.mapSize.setScalar(mobile ? 2048 : 4096);
  Object.assign(sun.shadow.camera, { left: -560, right: 560, top: 520, bottom: -520, near: 300, far: 1900 });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.35; sun.shadow.radius = 2.2;
  scene.add(sun, sun.target);

  // warm light thrown back up from the sunlit stone and ground, under the bridge especially
  const bounce = new THREE.HemisphereLight(0xa9c4ee, 0xb08f64, 0.3);
  scene.add(bounce);

  const inner = new THREE.PointLight(0xdfe4ee, 0, 0, 0);     // daylight scattered about the void, only felt indoors
  inner.position.copy(CENTER);
  scene.add(inner);

  const lantern = new THREE.PointLight(0xffc88a, 0, 16, 1.4);  // what you carry into the passages
  scene.add(lantern);

  return { scene, bvh, trees, water, stars, sky, fire, sun, inner, bounce, lantern };
}
