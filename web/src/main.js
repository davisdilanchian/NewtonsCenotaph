import * as THREE from 'three';
import { loadWorld, groundHeight, CENTER, SUN } from './world.js';
import { makeSunshafts } from './sunshafts.js';
import { Player, RADIUS, WALK, RUN } from './player.js';
import { clamp, lerp, SCALE } from './util.js';

const $ = (id) => document.getElementById(id);
const debug = new URLSearchParams(location.search).has('debug');
const touch = matchMedia('(pointer: coarse)').matches;
if (touch) document.body.classList.add('touch');

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: debug });
renderer.setPixelRatio(Math.min(devicePixelRatio, touch ? 1.5 : 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.72;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false;
document.body.prepend(renderer.domElement);
const canvas = renderer.domElement;

let FOV = 55;                                   // vertical; [ and ] change it
try { FOV = clamp(+localStorage.getItem('fov') || FOV, 35, 100); } catch { /* storage can be blocked */ }
const camera = new THREE.PerspectiveCamera(FOV, innerWidth / innerHeight, 0.07, 24000);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const fogDay = new THREE.Color(0xd3dbe3), fogVoid = new THREE.Color(0x05070a), FOG = 0.00045 * Math.sqrt(SCALE);
const DAY = 360;                                // seconds for the sun to cross the sky
const metres = (v) => `${Math.round(v * SCALE)} m`;

// Places, as feet position and what you face on arrival.
const PLACES = [
  { name: 'The approach', note: `Reflecting basin, ${metres(730)} out`, at: [0, 0, 731], look: [0, 60, 0] },
  { name: 'The main stair', note: `${metres(42)} wide`, at: [0, 0, 172], look: [0, 40, 0] },
  { name: 'The tunnel', note: 'Down through the arch, under the sphere', at: [0, 5.5, 60], look: [0, 3, 30] },
  { name: 'Inside the sphere', note: 'Newton’s sarcophagus under the pierced vault', at: [5, 9.5, 5], look: [0, 12, -3] },
  { name: 'The bridge', note: `${metres(46.5)} up, before the front stair block`, at: [-20, 46.5, 104], look: [0, 50, 0] },
  { name: 'The drum terrace', note: 'Four rows of cypress', at: [-66, 46.5, 64], look: [-94, 47, 0] },
  { name: 'The upper tier', note: `${metres(64)} up, against the sphere`, at: [-49, 64, 58.4], look: [40, 66, 70] },
];

// Boullée's six sheets on the title screen.
const SHEETS = [
  { file: 'perspective', name: 'Perspective', alt: 'The sphere rising above its cypress-ringed terraces under a dark sky' },
  { file: 'elevation', name: 'Elevation', alt: 'Front elevation of the sphere on a stepped circular base ringed with cypresses' },
  { file: 'plan', name: 'Plan', alt: 'Plan from above, with the rings of cypresses around the sphere' },
  { file: 'section-day', name: 'Section by day', alt: 'Section through the sphere, its dark vault pierced with stars' },
  { file: 'section-night', name: 'Section by night', alt: 'Section through the sphere, lit by a blazing armillary sphere hung at its centre' },
  { file: 'interior', name: 'Interior', alt: 'The starry vault seen from inside, with tiny figures at the sarcophagus' },
];
let sheetTimer = 0;

function showSheets() {
  const pictures = [], thumbs = [];
  const pick = (n) => {
    pictures.forEach((img, i) => img.classList.toggle('on', i === n));
    thumbs.forEach((b, i) => b.setAttribute('aria-pressed', i === n));
    $('sheetName').textContent = SHEETS[n].name;
    current = n;
  };
  let current = 0;
  SHEETS.forEach((s, i) => {
    const src = `assets/sheets/${s.file}.jpg`;
    const img = new Image();
    img.src = src; img.alt = s.alt;
    $('sheet').append(img); pictures.push(img);
    const b = document.createElement('button');
    b.setAttribute('aria-label', s.name);
    b.innerHTML = `<img src="${src}" alt="">`;
    b.addEventListener('click', () => { clearInterval(sheetTimer); pick(i); });
    $('thumbs').append(b); thumbs.push(b);
  });
  pick(0);
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches)
    sheetTimer = setInterval(() => pick((current + 1) % SHEETS.length), 6000);
}

let world, player, shafts, dayClock = 0.3, shadowClock = 0;
const keys = new Set();
const input = { x: 0, y: 0, run: false, jump: false };
const touchMove = { x: 0, y: 0 };
const EYE = 1.63 / SCALE, EYE_VOID = 26, EYE_PASSAGE = 8;   // exposure once the eye has adapted
let inside = 0, tunnel = 0, time = 0, stride = 0, bob = 0, lodAt = new THREE.Vector2(1e9, 1e9), lodClock = 0, started = false;


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

// in the passages: below the terrace, or on the ramp up through the shell
function underground() {
  const r = Math.hypot(player.pos.x, player.pos.z), feet = player.feet;
  return (feet < 4.6 && r < 156 && !(Math.abs(player.pos.x) < 22 && player.pos.z > 137)) || (r < 30 && feet < 9.3 && Math.abs(player.pos.x) < 3 && player.pos.z > 4);
}

function placeLabel(feet) {
  const r = Math.hypot(player.pos.x, player.pos.z), d = player.pos.distanceTo(CENTER);
  if (d < 66.5) return PLACES[3];
  if (underground()) return PLACES[2];
  if (feet > 60) return PLACES[6];
  if (feet > 44) return r > 105 || Math.abs(player.pos.x) > 45 ? PLACES[5] : PLACES[4];
  if (feet > 4.5 && r < 160) return { name: 'The ground terrace', note: `Ø${metres(315)}, four rows of cypress` };
  if (player.pos.z > 200 && Math.abs(player.pos.x) < 45) return PLACES[0];
  return { name: 'The meadow', note: `${metres(r)} from the sphere` };
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
  stride = lerp(stride, grounded ? Math.min(1, player.speed / WALK) : 0, Math.min(1, dt * 10));
  bob += dt * Math.min(player.speed * SCALE, 9.5) * 2.1;
  camera.position.set(
    p.x + Math.cos(player.yaw) * Math.cos(bob) * 0.012 / SCALE * stride,
    p.y - RADIUS + EYE + Math.abs(Math.sin(bob)) * 0.04 / SCALE * stride - player.dip,
    p.z - Math.sin(player.yaw) * Math.cos(bob) * 0.012 / SCALE * stride);
  camera.rotation.set(player.pitch, player.yaw, 0, 'YXZ');
  const fov = FOV + clamp((player.speed - WALK * 2) / (RUN - WALK * 2), 0, 1) * 4.8;
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
  const below = underground(), isIn = below || p.distanceTo(CENTER) < 67;
  inside = lerp(inside, isIn ? 1 : 0, Math.min(1, dt * 1.6));
  tunnel = lerp(tunnel, below ? 1 : 0, Math.min(1, dt * 2.5));
  // the sun crosses the sky and back; holding T hurries it along
  dayClock += dt * (keys.has('KeyT') ? 40 : 1) / DAY;
  const leg = dayClock % 2;
  world.setSun(leg < 1 ? leg : 2 - leg);

  // nothing lights the dark but the sun and the sky: the eye adapts, as it would
  world.scene.environmentIntensity = lerp(0.42, 0, inside);
  renderer.toneMappingExposure = lerp(0.72, lerp(EYE_VOID, EYE_PASSAGE, tunnel), inside);
  world.scene.fog.density = lerp(FOG, 0.0006, inside);
  world.scene.fog.color.lerpColors(fogDay, fogVoid, inside);
  world.shadowsClose(inside > 0.4);
  shadowClock -= dt;
  if (shadowClock <= 0 || keys.has('KeyT')) { shadowClock = inside > 0.4 ? 0.2 : 1.5; world.refresh(); }

  world.water.material.uniforms.time.value = time;
  world.lamps.material.uniforms.t.value = time;
  world.lamps.material.uniforms.scale.value = renderer.domElement.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  world.sky.material.uniforms.time.value = time * 4;
  world.fire.update(dt, time, camera);

  lodClock += dt;
  if (lodClock > 0.25 && lodAt.distanceTo({ x: p.x, y: p.z }) > 6) {
    world.trees.updateLOD(p.x, p.z, 75); lodAt.set(p.x, p.z); lodClock = 0;
  }

  const label = placeLabel(player.feet);
  if ($('whereName').textContent !== label.name) show(label);
  renderer.render(world.scene, camera);
  if (inside > 0.02 && camera.position.distanceTo(CENTER) < 72) shafts.render(camera);
  adapt(dt);
}

function bindControls() {
  addEventListener('keydown', (e) => {
    if (e.repeat) return;
    keys.add(e.code);
    if (e.code === 'Space') { input.jump = true; e.preventDefault(); }
    if (e.code === 'KeyR') teleport(0);
    if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
      FOV = clamp(FOV + (e.code === 'BracketRight' ? 5 : -5), 35, 100);
      $('whereNote').textContent = `Field of view ${FOV}°`;
      try { localStorage.setItem('fov', FOV); } catch { /* storage can be blocked */ }
    }
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
  shafts = makeSunshafts(renderer, world.sun, SUN);
  bindControls();

  $('about').textContent = `Published accounts put the sphere at 150 m. This reconstruction, judged by eye from the people and cypresses in his drawings, stands it ${metres(150)} wide, with all 2,139 cypresses.`;
  arrive(PLACES[0]);
  world.trees.updateLOD(1e6, 1e6, 75);          // every tree in the shadow map
  world.fire.update(0.016, 0, camera);
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
    clearInterval(sheetTimer);
    $('intro').classList.add('gone');
    $('hud').classList.add('on');
    started = true;
    if (!touch) canvas.requestPointerLock?.()?.catch?.(() => {});
  });
}

showSheets();
start().catch((e) => {
  console.error(e);
  const box = $('err');
  box.hidden = false;
  box.textContent = 'This page needs WebGL 2. It could not start in this browser.';
});
