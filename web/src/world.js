// Everything in the scene: stone from the Blender model, instanced cypresses, ground,
// basin, sky, and the star vault.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';
import { noise3, rng, smooth } from './util.js';
import { bakedFigureGeometry } from './character.js';

export const CENTER = new THREE.Vector3(0, 73.5, 0);        // sphere centre
export const SUN = new THREE.Vector3().setFromSphericalCoords(1, Math.PI / 2 - THREE.MathUtils.degToRad(28), 0);
{ // same sun as the renders: 28° up, from the left and slightly in front
  const a = THREE.MathUtils.degToRad(-160), e = THREE.MathUtils.degToRad(28);
  SUN.set(Math.cos(e) * Math.cos(a), Math.sin(e), -Math.cos(e) * Math.sin(a));
}

// matches the hills in scripts/build_scene.py
export function groundHeight(x, z) {
  const y = -z, d = Math.hypot(x, y), k = Math.max(0, (d - 900) / 2600);
  if (k === 0) return 0;
  return (Math.sin(x * 0.0021 + 1.3) * Math.cos(y * 0.0017 - 0.4) + 0.6 * Math.sin(x * 0.0047 + y * 0.0031)) * 70 * k ** 1.4;
}

const NOT_SOLID = new Set(['Main stair', 'Front stair block', 'Dais stair', 'Planting beds', 'Sphinxes', 'Funeral brazier',
                           'Esplanade and walks', 'Drum dentils', 'Bridge portal door']);

// ------------------------------------------------------------------ texturing
function load(name, srgb, renderer, manager) {
  const t = new THREE.TextureLoader(manager).load(`assets/tex/${name}.jpg`);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
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

function vaultMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    vertexShader: `varying vec3 vDir; void main(){ vDir = position - vec3(0.0, 73.5, 0.0); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying vec3 vDir;
      void main(){ vec3 d = normalize(vDir);
        float band = exp(-pow(dot(d, normalize(vec3(0.35, 0.76, -0.55))) / 0.11, 2.0));
        float mott = 0.6 + 0.4 * sin(d.x * 19.0 + sin(d.y * 13.0) * 2.0) * sin(d.z * 17.0 + d.y * 9.0);
        gl_FragColor = vec4(vec3(0.006, 0.008, 0.014) + band * mott * vec3(0.05, 0.056, 0.075), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

/** Boullée's pierced vault: each star is a real opening at a position on the shell. */
function starVault() {
  const group = new THREE.Group(), r = rng(1784), N = 5200, R = 66.8;
  const pos = new Float32Array(N * 3), size = new Float32Array(N), bandN = new THREE.Vector3(0.35, 0.76, -0.55).normalize(), v = new THREE.Vector3();
  let i = 0;
  while (i < N) {
    v.set(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1);
    if (v.lengthSq() > 1 || v.lengthSq() < 0.01) continue;
    v.normalize();
    const inBand = Math.abs(v.dot(bandN)) < 0.11, odds = inBand ? 1 : 0.2;
    if (r() > odds || v.y < -0.72) continue;
    pos.set([v.x * R + CENTER.x, v.y * R + CENTER.y, v.z * R + CENTER.z], i * 3);
    size[i] = 0.16 + 0.75 * r() ** 5 + (inBand ? 0 : 0.1);
    i++;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('size', new THREE.BufferAttribute(size, 1));
  const pts = new THREE.Points(g, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { scale: { value: 800 } },
    vertexShader: `attribute float size; uniform float scale; varying float vA;
      void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); float px = size * scale / -mv.z; gl_PointSize = max(1.6, px); vA = min(1.0, px / 1.6);
        gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `varying float vA; void main(){ float d = length(gl_PointCoord - 0.5) * 2.0; float a = smoothstep(1.0, 0.55, d);
      gl_FragColor = vec4(vec3(0.86, 0.91, 1.0) * a * (0.55 + 0.45 * vA), a); }`,
  }));
  pts.frustumCulled = false;
  group.add(pts);
  const moon = new THREE.Mesh(new THREE.CircleGeometry(1.9, 32), new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }));
  const dir = new THREE.Vector3(-0.45, 0.82, -0.35).normalize();
  moon.position.copy(CENTER).addScaledVector(dir, R - 0.1);
  moon.lookAt(CENTER);
  group.add(moon);
  group.userData.points = pts;
  return group;
}

// ----------------------------------------------------------------- vegetation
function cypressGeometry(seg, rings, seed, H) {
  const rmax = 1.32, base = 1.2, pos = [], nor = [], uv = [], col = [], idx = [];
  const rad = (a, t, z) => {
    const prof = Math.sin(Math.PI * t ** 0.62) ** 0.7 * (1 - 0.2 * t);
    const n = noise3(Math.cos(a) * 1.3 + seed, z * 0.34, Math.sin(a) * 1.3 + seed) - 0.5;
    return Math.max(rmax * prof * (1 + 0.42 * n), 0.015);
  };
  for (let j = 0; j <= rings; j++) {
    const t = j / rings, z = base - 0.3 + t * (H - base + 0.3);
    for (let i = 0; i <= seg; i++) {
      const a = ((i % seg) / seg) * Math.PI * 2, r = rad(a, t, z);
      pos.push(Math.cos(a) * r, z, Math.sin(a) * r);
      uv.push((i / seg) * 3, z / 3.2);
      const shade = 0.5 + 0.5 * smooth(0, 0.32, t) * (0.72 + 0.56 * noise3(Math.cos(a) * 3 + seed, z, Math.sin(a) * 3));
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
    const far = new THREE.InstancedMesh(cypressGeometry(9, 9, v * 9.1, heights[v]), foliage, nTrees);
    const near = new THREE.InstancedMesh(cypressGeometry(30, 46, v * 9.1, heights[v]), foliage, nTrees);
    far.castShadow = true; far.receiveShadow = near.receiveShadow = true;
    far.frustumCulled = near.frustumCulled = false;
    near.count = 0;
    sets.push({ far, near }); scene.add(far, near);
  }
  for (let i = 0; i < nTrees; i++) {
    const o = i * 6, t = { x: data[o], y: data[o + 1], z: data[o + 2], r: 1.35, v: i % VARIANTS };   // crowns nearly touch: the rows are hedges
    p.set(t.x, t.y, t.z); q.setFromAxisAngle(yAxis, data[o + 3]); s.set(data[o + 4], data[o + 5], data[o + 4]);
    t.matrix = m.compose(p, q, s).clone();
    tint.setHSL(0.27 + r() * 0.035, 0.26 + r() * 0.1, 0.5 + r() * 0.16);
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
    }
    sets.forEach((set, v) => {
      set.near.count = counts[v][0]; set.far.count = counts[v][1];
      set.near.instanceMatrix.needsUpdate = set.far.instanceMatrix.needsUpdate = true;
      if (set.near.instanceColor) set.near.instanceColor.needsUpdate = true;
      if (set.far.instanceColor) set.far.instanceColor.needsUpdate = true;
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
    uv.setXY(i, x / 7, z / 7);
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
  u.turbidity.value = 2.4; u.rayleigh.value = 1.0; u.mieCoefficient.value = 0.003; u.mieDirectionalG.value = 0.78;
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
                             [-17, 0, 178, 4], [15, 0, 188, 3], [-26, 0, 310, 2], [26, 0, 430, 3], [3.2, 9.5, 2.5, 2], [-24, 5.5, 150, 2]];
  const coats = [0x4c3a2b, 0x35404f, 0x5a2f24, 0x3e3f32], list = [];
  coats.forEach((coat, i) => {
    const mesh = new THREE.InstancedMesh(bakedFigureGeometry(coat, 0x17130f), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }), 40);
    mesh.frustumCulled = false; mesh.count = 0; list.push(mesh); scene.add(mesh);
  });
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
  for (const [x, y, z, n] of spots) for (let i = 0; i < n; i++) {
    p.set(x + (r() - 0.5) * 4, y, z + (r() - 0.5) * 4); q.setFromAxisAngle(up, r() * 6.28); s.setScalar(0.94 + r() * 0.1);
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
  scene.fog = new THREE.FogExp2(0xc7d5e4, 0.00011);

  const std = (o) => new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0, ...o });
  const LIMESTONE = 0xe6d6b8;      // warms and tones down the neutral stone textures
  const nS = (v) => new THREE.Vector2(v, v);
  const ashlar = std({ color: LIMESTONE, map: T('ashlar', true), normalMap: T('ashlar_n'), normalScale: nS(0.9) });
  const stone = T('stone', true), stoneN = T('stone_n');
  const dressed = std({ color: LIMESTONE, map: stone, normalMap: stoneN, normalScale: nS(0.5), roughness: 0.74 });
  const sphere = std({ color: LIMESTONE, map: stone, normalMap: stoneN, normalScale: nS(0.35), roughness: 0.7 });
  const paving = std({ color: LIMESTONE, map: T('paving', true), normalMap: T('paving_n'), normalScale: nS(0.7) });
  const gravel = std({ map: T('gravel', true), normalMap: T('gravel_n'), roughness: 0.94 });
  const soil = std({ map: T('soil', true), roughness: 0.97 });
  const foliage = std({ map: T('cypress', true), normalMap: T('cypress_n'), normalScale: nS(1.2), vertexColors: true, roughness: 0.86 });
  const grass = [T('grass', true), T('grass_n')];
  const MATS = {
    'Limestone ashlar': [ashlar, 15.6], 'Limestone dressed': [dressed, 12], 'Limestone sphere': [sphere, 12, true],
    'Limestone paving': [paving, 6.4], 'Gravel (terrace walks)': [gravel, 4], 'Planting bed (soil, needle litter)': [soil, 3],
  };

  const draco = new DRACOLoader(manager).setDecoderPath('./draco/');
  const gltfLoader = new GLTFLoader(manager).setDRACOLoader(draco);
  const fileLoader = new THREE.FileLoader(manager).setResponseType('arraybuffer');
  const [gltf, treeBuf] = await Promise.all([gltfLoader.loadAsync('assets/monument.glb'), fileLoader.loadAsync('assets/trees.bin')]);
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
    if (key.startsWith('Vault')) { mesh.material = vaultMaterial(); continue; }
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

  const trees = makeTrees(treeBuf, foliage, scene);
  scene.add(makeGround(...grass));
  const water = makeBasin();
  scene.add(water);
  const stars = starVault();
  scene.add(stars);
  const sky = makeSky(renderer, scene);
  const fire = makeFire();
  scene.add(fire.group);
  makeVisitors(scene);

  // Sun. It never moves, so its shadow map is drawn once and kept.
  const sun = new THREE.DirectionalLight(0xffeed8, 2.7);
  sun.target.position.set(0, 0, 170);
  sun.position.copy(sun.target.position).addScaledVector(SUN, 1100);
  sun.castShadow = true;
  const mobile = matchMedia('(pointer: coarse)').matches;
  sun.shadow.mapSize.setScalar(mobile ? 2048 : 4096);
  Object.assign(sun.shadow.camera, { left: -560, right: 560, top: 520, bottom: -520, near: 300, far: 1900 });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.35; sun.shadow.radius = 1.6;
  scene.add(sun, sun.target);

  // warm light thrown back up from the sunlit stone and ground, under the bridge especially
  const bounce = new THREE.HemisphereLight(0xcfdcf0, 0xc2a57c, 0.62);
  scene.add(bounce);

  const inner = new THREE.PointLight(0xa9bbe0, 0, 0, 0);     // starlight, only felt indoors
  inner.position.copy(CENTER);
  scene.add(inner);

  return { scene, bvh, trees, water, stars, sky, fire, sun, inner, bounce };
}
