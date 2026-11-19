// Jackdaws, the birds of tall stone buildings, wheeling over the site in loose flocks: a sense of the
// sphere's height from something whose size everyone knows. Drawn at 1/SCALE like the visitors, so a
// bird is to the monument as it is to them: 0.67 m across the wings, flying at 12 m/s, beating its
// wings four times a second. Far off a bird is smaller than a pixel; it is then drawn one and a half
// pixels across and as faint as its true size would make it, so it neither vanishes nor flickers.
import * as THREE from 'three';
import { rng, noise3, SCALE } from './util.js';

const SPAN = 0.67, SPEED = 12 / SCALE, BEAT = 4;

/** One bird in metres, flying along +z: a body and tail, and two wings that flap at the shoulder. */
function birdGeometry() {
  const tris = [], wing = [];
  const add = (w, ...pts) => { for (const p of pts) { tris.push(...p); wing.push(w); } };
  const head = [0, 0, 0.17], shL = [-0.035, 0, 0.05], shR = [0.035, 0, 0.05], hipL = [-0.03, 0, -0.08], hipR = [0.03, 0, -0.08];
  add(0, head, shL, shR); add(0, shL, hipL, shR); add(0, shR, hipL, hipR);
  add(0, hipL, [-0.06, 0, -0.19], hipR); add(0, hipR, [-0.06, 0, -0.19], [0.06, 0, -0.19]);   // the tail fanned a little
  for (const s of [-1, 1]) {
    const rf = [0.035 * s, 0, 0.06], rb = [0.035 * s, 0, -0.06], ef = [0.17 * s, 0, 0.055], eb = [0.17 * s, 0, -0.085];
    const tf = [SPAN / 2 * s, 0, -0.01], tb = [0.3 * s, 0, -0.09];    // the outer wing swept back, its fingers spread
    add(1, rf, ef, eb); add(1, rf, eb, rb); add(1, ef, tf, tb); add(1, ef, tb, eb);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(tris, 3));
  g.setAttribute('wing', new THREE.Float32BufferAttribute(wing, 1));
  return g;
}

// Each flock wheels in loops about a point of its own, which drifts slowly round the sphere: so at any
// time some are in view, and none flies through the stone (each loop clears the sphere, the drum and
// the trees on its terraces).
const FLOCKS = [
  { n: 16, at: 0, from: 100, h: 150, loop: 22, drift: 0.008, spread: 5, seed: 3 },       // over the front of the crown
  { n: 12, at: 100, from: 95, h: 125, loop: 18, drift: 0.006, spread: 5, seed: 7 },      // the west flank
  { n: 12, at: -110, from: 110, h: 100, loop: 20, drift: -0.007, spread: 5, seed: 11 },  // the east flank, over the upper tier
  { n: 14, at: 180, from: 60, h: 175, loop: 25, drift: 0.005, spread: 6, seed: 17 },     // high over the top
  { n: 10, at: 40, from: 175, h: 72, loop: 30, drift: -0.004, spread: 7, seed: 23 },     // round the drum terrace
  { n: 10, at: 0, from: 420, h: 24, loop: 35, drift: 0, sway: 160, spread: 7, seed: 29 }, // low over the basin and the meadow
  // and low over where people walk, close enough to be seen as birds: the esplanade before the stair,
  // and above the drum terrace and the upper tier
  { n: 9, at: 0, from: 215, h: 18, loop: 25, drift: 0, sway: 20, spread: 5, seed: 31 },
  { n: 8, at: -60, from: 150, h: 62, loop: 18, drift: 0.01, spread: 4, seed: 37 },
  { n: 7, at: 60, from: 115, h: 80, loop: 15, drift: -0.012, spread: 4, seed: 41 },
];

export function makeBirds() {
  const flocks = [], r = rng(1784);
  for (const f of FLOCKS) {
    const birds = [];
    for (let i = 0; i < f.n; i++) birds.push({ p: [r() * 6.28, r() * 6.28, r() * 6.28], w: [0.1 + r() * 0.12, 0.08 + r() * 0.1, 0.1 + r() * 0.12], beat: r() * 6.28, rate: BEAT * (0.88 + r() * 0.24), lag: r() * 2 });
    flocks.push({ ...f, birds, phase: r() * 6.28, turn: r() < 0.5 ? 1 : -1 });
  }
  const count = flocks.reduce((s, f) => s + f.n, 0);
  const geometry = birdGeometry();
  const flap = new THREE.InstancedBufferAttribute(new Float32Array(count * 2), 2);
  flap.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('flap', flap);

  const focal = { value: 1000 };
  const material = new THREE.MeshBasicMaterial({ color: 0x23211e, side: THREE.DoubleSide, transparent: true });
  material.onBeforeCompile = (s) => {
    s.uniforms.focal = focal;
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float wing; attribute vec2 flap; uniform float focal; varying float vCover;')
      .replace('#include <begin_vertex>', `vec3 transformed = position;
        float span = abs(position.x) - 0.035;
        if (wing > 0.5) {            // the wing turns up and down at the shoulder, the hand a little further than the arm
          float a = 0.14 + flap.y * sin(flap.x) * (1.0 + 0.5 * smoothstep(0.1, 0.3, span));
          transformed.x = sign(position.x) * (0.035 + span * cos(a));
          transformed.y += span * sin(a);
        }`)
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 centre = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        float px = ${SPAN.toFixed(2)} * length(instanceMatrix[0].xyz) * focal / max(-centre.z, 1e-3), grow = max(1.5 / px, 1.0);
        mvPosition = centre + (mvPosition - centre) * grow;
        gl_Position = projectionMatrix * mvPosition;
        vCover = 1.0 / (grow * grow);`);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vCover;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vCover;');
  };
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;

  const at = (f, t, out) => {          // where a flock's centre is at time t
    const home = (f.at * Math.PI) / 180 + f.drift * t, z = f.sway ? f.sway * Math.sin(t * 0.02 + f.seed) : 0;
    const a = f.phase + f.turn * t * SPEED / f.loop;
    return out.set(Math.sin(home) * f.from + Math.sin(a) * f.loop, f.h + 4 * Math.sin(a * 2 + f.seed), Math.cos(home) * f.from + z + Math.cos(a) * f.loop);
  };
  const where = (f, b, t, out) => {    // and one bird, drifting about it, a little behind or ahead
    at(f, t - b.lag, out);
    return out.add(off.set(Math.sin(t * b.w[0] + b.p[0]), 0.45 * Math.sin(t * b.w[1] + b.p[1]), Math.sin(t * b.w[2] + b.p[2])).multiplyScalar(f.spread));
  };
  const was = new THREE.Vector3(), next = new THREE.Vector3(), off = new THREE.Vector3();
  const p = new THREE.Vector3(), ahead = new THREE.Vector3(), behind = new THREE.Vector3(), fwd = new THREE.Vector3(), side = new THREE.Vector3(), up = new THREE.Vector3();
  const m = new THREE.Matrix4(), UP = new THREE.Vector3(0, 1, 0), bank = new THREE.Quaternion(), basis = new THREE.Quaternion(), size = new THREE.Vector3().setScalar(1 / SCALE);

  return {
    mesh,
    focal,
    update(dt, time) {
      let i = 0;
      for (const f of flocks) for (const b of f.birds) {
        where(f, b, time, p); where(f, b, time + 0.25, ahead); where(f, b, time - 0.25, behind);
        fwd.subVectors(ahead, behind).normalize();
        const turn = was.subVectors(p, behind).normalize().cross(next.subVectors(ahead, p).normalize()).y;   // + when turning left
        side.crossVectors(UP, fwd).normalize(); up.crossVectors(fwd, side);    // side is the left wing
        m.makeBasis(side, up, fwd);
        basis.setFromRotationMatrix(m);
        bank.setFromAxisAngle(fwd, THREE.MathUtils.clamp(-turn * 6, -0.45, 0.45));   // into the turn, inner wing down
        m.compose(p, bank.multiply(basis), size);
        mesh.setMatrixAt(i, m);
        // mostly beating, now and then a glide on held wings
        b.beat += dt * b.rate * Math.PI * 2;
        const glide = noise3(time * 0.35 + b.p[0] * 10, b.lag * 7, f.seed);
        flap.setXY(i, b.beat, 0.62 * THREE.MathUtils.smoothstep(glide, 0.3, 0.5));
        i++;
      }
      mesh.instanceMatrix.needsUpdate = true;
      flap.needsUpdate = true;
    },
  };
}
