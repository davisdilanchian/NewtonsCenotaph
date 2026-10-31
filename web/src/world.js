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
import { figureGeometries } from './character.js';
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
// One exposure serves the whole site, so the dark interior is set permanently to where the eye would
// settle in it, rather than changing the camera as you cross a threshold.
const INDOORS = 264, PASSAGES = 11;

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
    for (let v = 0; v < E.length; v++) { const e = (E[v] + shared) * INDOORS; baked[v * 3] = e * 0.74; baked[v * 3 + 1] = e * 0.86; baked[v * 3 + 2] = e; }
    g.setAttribute('baked', new THREE.BufferAttribute(baked, 3));
  });
}

// ----------------------------------------------------------------- vegetation
// 'Stricta' outline: a slender column drawn to a point, widest below the middle
const cypressOutline = (t) => smooth(0, 0.08, t) ** 0.5 * (1 - t ** 2.6) ** 0.8;
const CYPRESS_R = 1.42, CYPRESS_BASE = 0.55;

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
    const width = Math.max(0.12, (0.27 + r() * 0.1) * fat * (1.05 - 0.6 * t)), low = CYPRESS_BASE + t * (H - CYPRESS_BASE - length * 0.55);
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
  const bark = new THREE.MeshStandardMaterial({ color: 0x3c2a1e, roughness: 0.95 });
  const trunkGeo = new THREE.CylinderGeometry(0.11, 0.2, 1.7, 6, 1, true).translate(0, 0.75, 0);
  const trunks = new THREE.InstancedMesh(trunkGeo, bark, nTrees);
  const sets = [];
  for (let v = 0; v < VARIANTS; v++) {
    sets.push([[120, 5, 4], [46, 4, 3], [18, 3, 2]].map(([sprays, sides, rings]) => {
      const mesh = new THREE.InstancedMesh(cypressTree(sprays, sides, rings, v * 9.1, heights[v]), foliage, nTrees);
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

  // three detail levels of the same tree, by distance from the walker
  function updateLOD(x, z, nearDist) {
    const n2 = nearDist * nearDist, m2 = 9 * n2, counts = sets.map(() => [0, 0, 0]);
    for (const t of trees) {
      const d = (t.x - x) ** 2 + (t.z - z) ** 2, lod = d < n2 ? 0 : d < m2 ? 1 : 2, k = counts[t.v][lod]++, mesh = sets[t.v][lod];
      mesh.setMatrixAt(k, t.matrix); mesh.setColorAt(k, t.color);
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

function makeVisitors(scene) {
  const r = rng(5), spots = [[-8, 5.5, 132, 5], [9, 5.5, 136, 3], [-6, 5.5, 112, 4], [11, 5.5, 116, 3], [-14, 46.5, 96, 4], [10, 46.5, 98, 3],
                             [-17, 0, 178, 4], [15, 0, 188, 3], [-26, 0, 310, 2], [26, 0, 430, 3], [-24, 5.5, 150, 2], [-14, 14, -6, 4], [15, 14, 9, 4], [-9, 14, 15, 3], [16, 14, -13, 3], [4.5, 17, 3.5, 2],
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
  const vault = weathered(std({ color: LIMESTONE, map: stone, normalMap: stoneN, normalScale: nS(0.3), roughness: 0.9, dithering: true }), { courses: true, streaks: 0.6 });
  const paving = weathered(std({ color: LIMESTONE, map: T('paving', true), normalMap: T('paving_n'), normalScale: nS(0.7) }), { streaks: 0 });
  const gravel = weathered(std({ color: new THREE.Color(1.22, 1.08, 0.88), map: T('gravel', true), normalMap: T('gravel_n'), normalScale: nS(0.5), roughness: 0.94 }), { streaks: 0 });
  const soil = std({ map: T('soil', true), roughness: 0.97 });
  const leaves = T('cypress', true);
  const foliage = new THREE.MeshLambertMaterial({ map: leaves, normalMap: T('cypress_n'), normalScale: nS(1.0), vertexColors: true,   // matte: leaves don't mirror the sky
                                                  emissive: 0x4c5a4c, emissiveMap: leaves });                                          // this material ignores the sky, so its light is added here
  const grass = [T('grass', true), T('grass_n')];
  const MATS = {
    'Vault: pierced shell (star holes)': [vault, 12, true], Bore: [boreStone, 12 / SCALE], 'Limestone ashlar': [ashlar, 15.6 / SCALE], 'Limestone dressed': [dressed, 12 / SCALE], 'Limestone sphere': [sphere, 12, true],
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
      if (g.attributes.color) {
        const c = g.attributes.color, pos = g.attributes.position, baked = new Float32Array(c.count * 3);
        for (let v = 0; v < c.count; v++) {
          const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
          const inFront = Math.abs(x) < 7.3 && z > 0 && z < 110, inSide = Math.abs(z) < 3.5 && Math.abs(x) < 125;
          const depth = y < 14.1 ? (inFront ? 108 - z : inSide ? 121 - Math.abs(x) : 0) : 0, k = 1 + (PASSAGES - 1) * smooth(0, 14, depth);
          const least = name === 'Basin coping' ? 0.16 : 0;   // its sides meet the ground, where the bake's vertices went dark
          baked[v * 3] = Math.max(c.getX(v) * k, least); baked[v * 3 + 1] = Math.max(c.getY(v) * k, least); baked[v * 3 + 2] = Math.max(c.getZ(v) * k, least);
        }
        g.setAttribute('baked', new THREE.BufferAttribute(baked, 3));
        g.deleteAttribute('color');
      }
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

  return { scene, bvh, trees, water, sky, fire, sun, setSun, refresh, shadowsClose, lamps, shafts, tomb, sunStrength: () => sunStrength };

}
