import * as THREE from 'three';
import { loadWorld, groundHeight, CENTER } from './world.js';
import { Player, RADIUS } from './player.js';
import { clamp, lerp } from './util.js';

const $ = (id) => document.getElementById(id);
const debug = new URLSearchParams(location.search).has('debug');
const touch = matchMedia('(pointer: coarse)').matches;
if (touch) document.body.classList.add('touch');

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: debug });
renderer.setPixelRatio(Math.min(devicePixelRatio, touch ? 1.5 : 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.8;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false;
document.body.prepend(renderer.domElement);
const canvas = renderer.domElement;

const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.1, 24000);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// Places, as feet position and what you face on arrival.
const PLACES = [
  { name: 'The approach', note: 'Reflecting basin, 730 m out', at: [0, 0, 731], look: [0, 60, 0] },
  { name: 'The main stair', note: '42 m wide', at: [0, 0, 172], look: [0, 40, 0] },
  { name: 'The tunnel', note: 'The way in', at: [0, 5.5, 66], look: [0, 12, 0] },
  { name: 'Inside the sphere', note: 'Newton’s sarcophagus under the pierced vault', at: [0, 9.5, 8], look: [0, 12, -3] },
  { name: 'The bridge', note: '46.5 m up, before the front stair block', at: [-20, 46.5, 104], look: [0, 50, 0] },
  { name: 'The drum terrace', note: 'Four rows of cypress', at: [-66, 46.5, 64], look: [-94, 47, 0] },
  { name: 'The upper tier', note: '64 m up, against the sphere', at: [-49, 64, 58.4], look: [40, 66, 70] },
];

let world, player;
const keys = new Set();
const input = { x: 0, y: 0, run: false, jump: false };
const touchMove = { x: 0, y: 0 };
const EYE = 1.63;
let inside = 0, time = 0, stride = 0, bob = 0, lodAt = new THREE.Vector2(1e9, 1e9), lodClock = 0, started = false;


function arrive(p) {
  player.place({ x: p.at[0], y: p.at[1], z: p.at[2] }, { x: p.look[0], z: p.look[2] });
  player.pitch = 0.16;
  show(p);
}

function teleport(i) {
  arrive(PLACES[i]);
  $('keys').classList.add('faded');
}

function show(p) { $('whereName').textContent = p.name; $('whereNote').textContent = p.note; }

function placeLabel(feet) {
  const r = Math.hypot(player.pos.x, player.pos.z), d = player.pos.distanceTo(CENTER);
  if (d < 66.5) return PLACES[3];
  if (Math.abs(player.pos.x) < 7.5 && player.pos.z > 5 && player.pos.z < 46 && feet < 16) return PLACES[2];
  if (feet > 60) return PLACES[6];
  if (feet > 44) return r > 105 || Math.abs(player.pos.x) > 45 ? PLACES[5] : PLACES[4];
  if (feet > 4.5 && r < 160) return { name: 'The ground terrace', note: 'Ø315 m, four rows of cypress' };
  if (player.pos.z > 200 && Math.abs(player.pos.x) < 45) return PLACES[0];
  return { name: 'The meadow', note: `${Math.round(r)} m from the sphere` };
}

function look(dx, dy) {
  player.yaw -= dx * 0.0022;
  player.pitch = clamp(player.pitch - dy * 0.0022, -1.5, 1.5);
}

function readInput() {
  const k = (...c) => c.some((v) => keys.has(v));
  input.y = (k('KeyW', 'ArrowUp') ? 1 : 0) - (k('KeyS', 'ArrowDown') ? 1 : 0) + touchMove.y;
  input.x = (k('KeyD', 'ArrowRight') ? 1 : 0) - (k('KeyA', 'ArrowLeft') ? 1 : 0) + touchMove.x;
  input.run = k('ShiftLeft', 'ShiftRight') || Math.hypot(touchMove.x, touchMove.y) > 0.92;
}

function updateCamera(dt) {
  const p = player.pos, grounded = player.airTime < 0.12;
  stride = lerp(stride, grounded ? Math.min(1, player.speed / 3.2) : 0, Math.min(1, dt * 10));
  bob += dt * player.speed * 2.1;
  camera.position.set(
    p.x + Math.cos(player.yaw) * Math.cos(bob) * 0.012 * stride,
    p.y - RADIUS + EYE + Math.abs(Math.sin(bob)) * 0.04 * stride - player.dip,
    p.z - Math.sin(player.yaw) * Math.cos(bob) * 0.012 * stride);
  camera.rotation.set(player.pitch, player.yaw, 0, 'YXZ');
  const fov = 72 + clamp(player.speed - 4, 0, 6) * 0.8;
  if (Math.abs(camera.fov - fov) > 0.05) { camera.fov = lerp(camera.fov, fov, Math.min(1, dt * 6)); camera.updateProjectionMatrix(); }
}

// lower the resolution a step if the machine can't hold a good frame rate
let frames = 0, fpsClock = 0, ratio = renderer.getPixelRatio();
function adapt(dt) {
  frames++; fpsClock += dt;
  if (fpsClock < 2) return;
  const fps = frames / fpsClock;
  if (debug) window.walk.fps = fps;
  frames = 0; fpsClock = 0;
  if (fps < 38 && ratio > 0.75) { ratio = Math.max(0.75, ratio - 0.25); renderer.setPixelRatio(ratio); }
}

const timer = new THREE.Timer();
function frame() {
  requestAnimationFrame(frame);
  timer.update();
  tick(Math.min(timer.getDelta(), 0.05));
}

function simulate(dt) {
  readInput();
  player.update(dt, input);
}

function tick(dt) {
  time += dt;
  if (started) simulate(dt);
  updateCamera(dt);

  // adjust to the dark when entering the shell
  const p = player.pos;
  const isIn = p.distanceTo(CENTER) < 67 || (Math.abs(p.x) < 8 && p.z > 0 && p.z < 46 && p.y < 16);
  inside = lerp(inside, isIn ? 1 : 0, Math.min(1, dt * 1.6));
  world.scene.environmentIntensity = lerp(0.34, 0.03, inside);
  world.inner.intensity = 0.55 * inside;
  renderer.toneMappingExposure = lerp(0.8, 2.0, inside);
  world.bounce.intensity = lerp(0.62, 0.02, inside);
  world.stars.visible = camera.position.distanceTo(CENTER) < 125;
  world.stars.userData.points.material.uniforms.scale.value = renderer.domElement.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));

  world.water.material.uniforms.time.value = time;
  world.sky.material.uniforms.time.value = time * 4;
  world.fire.update(dt, time);

  lodClock += dt;
  if (lodClock > 0.25 && lodAt.distanceTo({ x: p.x, y: p.z }) > 6) {
    world.trees.updateLOD(p.x, p.z, 75); lodAt.set(p.x, p.z); lodClock = 0;
  }

  const label = placeLabel(player.feet);
  if ($('whereName').textContent !== label.name) show(label);
  renderer.render(world.scene, camera);
  adapt(dt);
}

function bindControls() {
  addEventListener('keydown', (e) => {
    if (e.repeat) return;
    keys.add(e.code);
    if (e.code === 'Space') { input.jump = true; e.preventDefault(); }
    if (e.code === 'KeyR') teleport(0);
    const n = +e.key;
    if (n >= 1 && n <= PLACES.length) teleport(n - 1);
    if (e.code.startsWith('Key') || e.code.startsWith('Arrow')) $('keys').classList.add('faded');
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());

  // mouse: pointer lock when offered, plain drag otherwise
  let dragging = false;
  canvas.addEventListener('mousedown', () => { dragging = true; if (!touch && document.pointerLockElement !== canvas) canvas.requestPointerLock?.()?.catch?.(() => {}); });
  addEventListener('mouseup', () => { dragging = false; });
  addEventListener('mousemove', (e) => { if (document.pointerLockElement === canvas || dragging) look(e.movementX, e.movementY); });

  // touch: left stick, drag anywhere else to look
  const stick = $('stick'), nub = stick.firstElementChild;
  let stickId = null, lookId = null, lx = 0, ly = 0;
  const moveNub = (t) => {
    const r = stick.getBoundingClientRect(), max = r.width / 2;
    let x = t.clientX - r.left - max, y = t.clientY - r.top - max; const l = Math.hypot(x, y);
    if (l > max) { x *= max / l; y *= max / l; }
    nub.style.transform = `translate(${x}px,${y}px)`;
    touchMove.x = x / max; touchMove.y = -y / max;
  };
  stick.addEventListener('touchstart', (e) => { stickId = e.changedTouches[0].identifier; moveNub(e.changedTouches[0]); e.preventDefault(); }, { passive: false });
  canvas.addEventListener('touchstart', (e) => { const t = e.changedTouches[0]; lookId = t.identifier; lx = t.clientX; ly = t.clientY; }, { passive: true });
  addEventListener('touchmove', (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === stickId) moveNub(t);
      if (t.identifier === lookId) { look((t.clientX - lx) * 2.2, (t.clientY - ly) * 2.2); lx = t.clientX; ly = t.clientY; }
    }
  }, { passive: true });
  addEventListener('touchend', (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === stickId) { stickId = null; touchMove.x = touchMove.y = 0; nub.style.transform = ''; }
      if (t.identifier === lookId) lookId = null;
    }
  });
  $('jump').addEventListener('touchstart', (e) => { input.jump = true; e.preventDefault(); }, { passive: false });

  PLACES.forEach((p, i) => {
    const b = document.createElement('button');
    b.innerHTML = `${p.name}<kbd>${i + 1}</kbd>`;
    b.addEventListener('click', () => teleport(i));
    $('places').append(b);
  });
}

async function start() {
  world = await loadWorld(renderer, (f) => { $('bar').firstElementChild.style.width = `${Math.round(f * 100)}%`; });
  player = new Player({ bvh: world.bvh, groundHeight, treeHash: world.trees.hash });
  bindControls();

  arrive(PLACES[0]);
  world.trees.updateLOD(1e6, 1e6, 75);          // every tree in the shadow map
  world.fire.update(0.016, 0);
  renderer.shadowMap.needsUpdate = true;
  renderer.compile(world.scene, camera);
  updateCamera(0.016);
  renderer.render(world.scene, camera);
  if (debug) window.walk = { player, keys, input, world, camera, teleport, renderer, fps: 0, PLACES, simulate, tick, look };
  frame();

  $('bar').style.display = 'none';
  const enter = $('enter');
  enter.hidden = false;
  enter.focus();
  enter.addEventListener('click', () => {
    $('intro').classList.add('gone');
    $('hud').classList.add('on');
    started = true;
    if (!touch) canvas.requestPointerLock?.()?.catch?.(() => {});
  });
}

start().catch((e) => {
  console.error(e);
  const box = $('err');
  box.hidden = false;
  box.textContent = 'This page needs WebGL 2. It could not start in this browser.';
});
