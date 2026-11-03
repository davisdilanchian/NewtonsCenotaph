import * as THREE from 'three';
import { loadWorld, groundHeight, CENTER, SUN } from './world.js';
import { Player, RADIUS, WALK, RUN } from './player.js';
import { clamp, lerp, SCALE } from './util.js';
import { makeSound } from './sound.js';

const $ = (id) => document.getElementById(id);
const debug = new URLSearchParams(location.search).has('debug');
const touch = matchMedia('(pointer: coarse)').matches;
if (touch) document.body.classList.add('touch');

const renderer = new THREE.WebGLRenderer({ antialias: true, reversedDepthBuffer: true, powerPreference: 'high-performance', preserveDrawingBuffer: debug });
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

const DAY = 2400;                               // seconds for the sun to cross the sky
const metres = (v) => `${Math.round(v)} m`;

// Places, as feet position and what you face on arrival.
const PLACES = [
  { name: 'The approach', note: `Reflecting basin, ${metres(730)} out`, at: [0, 0, 731], look: [0, 60, 0] },
  { name: 'The main stair', note: `${metres(42)} wide`, at: [0, 0, 172], look: [0, 40, 0] },
  { name: 'The arch', note: `The way in: ${metres(104)} level to the sarcophagus`, at: [0, 5.5, 118], look: [0, 12, 0] },
  { name: 'Inside the sphere', note: 'The sky at Newton’s birth, cut through the vault', at: [7, 14, 19], look: [0, 17, 0] },
  { name: 'The bridge', note: `${metres(46.5)} up, before the front stair block`, at: [-20, 46.5, 104], look: [0, 50, 0] },
  { name: 'The drum terrace', note: 'Four rows of cypress', at: [-66, 46.5, 64], look: [-94, 47, 0] },
  { name: 'The upper tier', note: `${metres(64)} up, against the sphere`, at: [-49, 64, 58.4], look: [40, 66, 70] },
  { name: 'The long passage', note: `${metres(119)} from the east side to the sarcophagus`, at: [123, 5.5, 0], look: [0, 7, 0] },
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

let world, player, dayClock = 0.2, shadowClock = 0, wasInVoid = false, shaftLight = 0;
const lightProbe = { color: new THREE.Color(), intensity: 1 };
const keys = new Set();
const input = { x: 0, y: 0, run: false, jump: false };
const touchMove = { x: 0, y: 0 };
const EYE = 1.63 / SCALE;
const sound = makeSound();
let pace = 0, footfall = false, landing = 0;
let time = 0, stride = 0, bob = 0, lodAt = new THREE.Vector2(1e9, 1e9), lodClock = 0, started = false;


// On a phone the screen is a window into the space: turn to look, and walk for real to move.
// A web page can't track a phone's position, but it can feel each step and which way it faces.
const gyro = { on: false, align: false, alpha: 0, beta: 0, gamma: 0, offset: 0 };
const DEG = Math.PI / 180, tilt = new THREE.Euler(), held = new THREE.Quaternion(), roll = new THREE.Quaternion(), turn = new THREE.Quaternion(), facing = new THREE.Vector3();
const flat = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2), UP = new THREE.Vector3(0, 1, 0), OUT = new THREE.Vector3(0, 0, 1);
// Each real step sets the pace from the time since the last one, and you keep walking at that pace
// for as long as the steps keep coming. When they stop, you slow to a halt over half a second.
const STRIDE = 1.1;                                  // model units a step carries you, about 3 m
const steps = { last: -1e9, gap: 0.7, speed: 0 };
function stepTaken(now) {
  const since = (now - steps.last) / 1000;
  if (since < 1.6) steps.gap += (clamp(since, 0.35, 1.2) - steps.gap) * 0.5;
  steps.last = now; footfall = true;
}
function stepPace(dt) {
  const since = (performance.now() - steps.last) / 1000, going = since < steps.gap * 1.4 + 0.15;
  steps.speed += ((going ? STRIDE / steps.gap : 0) - steps.speed) * (1 - Math.exp(-dt * (going ? 4 : 3)));
  if (steps.speed < 0.02) steps.speed = 0;
  return steps.speed;
}

function startPhoneSensors() {
  const listenTurn = () => addEventListener('deviceorientation', (e) => {
    if (e.alpha === null) return;
    Object.assign(gyro, { alpha: e.alpha, beta: e.beta, gamma: e.gamma });
    if (!gyro.on) { gyro.on = gyro.align = true; $('phone').classList.add('on'); setTimeout(() => $('phone').classList.remove('on'), 7000); }
  });
  const listenSteps = () => {
    let level = 9.8, smooth = 9.8, armed = true, last = 0;
    addEventListener('devicemotion', (e) => {
      const a = e.accelerationIncludingGravity;
      if (!a || a.x === null) return;
      const size = Math.hypot(a.x, a.y, a.z), now = performance.now();
      smooth += (size - smooth) * 0.35;              // steady the hand's jitter, so one step isn't counted twice
      level += (size - level) * 0.04;
      const rise = smooth - level;
      if (armed && rise > 1.0 && now - last > 280) { stepTaken(now); last = now; armed = false; } else if (rise < 0.2) armed = true;
    });
  };
  const askTurn = window.DeviceOrientationEvent?.requestPermission, askSteps = window.DeviceMotionEvent?.requestPermission;   // iPhones ask first, and only from a tap
  if (askTurn) askTurn.call(DeviceOrientationEvent).then((state) => { if (state === 'granted') listenTurn(); }).catch(() => {}); else listenTurn();
  if (askSteps) askSteps.call(DeviceMotionEvent).then((state) => { if (state === 'granted') listenSteps(); }).catch(() => {}); else listenSteps();
  setTimeout(() => { if (!gyro.on) document.body.classList.add('no-sensors'); }, 2500);   // no sensors: fall back to the on-screen stick
}

function gyroView() {
  const screenAngle = (screen.orientation?.angle ?? window.orientation ?? 0) * DEG;
  tilt.set(gyro.beta * DEG, gyro.alpha * DEG, -gyro.gamma * DEG, 'YXZ');
  held.setFromEuler(tilt).multiply(flat).multiply(roll.setFromAxisAngle(OUT, -screenAngle));
  if (gyro.align) {                                  // keep looking where the arrival faces, however the phone is held
    facing.set(0, 0, -1).applyQuaternion(held);
    gyro.offset = player.yaw - Math.atan2(-facing.x, -facing.z);
    gyro.align = false;
  }
  camera.quaternion.copy(turn.setFromAxisAngle(UP, gyro.offset)).multiply(held);
  facing.set(0, 0, -1).applyQuaternion(camera.quaternion);
  player.yaw = Math.atan2(-facing.x, -facing.z);     // you walk the way the phone faces
  player.pitch = Math.asin(clamp(facing.y, -1, 1));
}

function arrive(p) {
  player.place({ x: p.at[0], y: p.at[1], z: p.at[2] }, { x: p.look[0], z: p.look[2] });
  player.pitch = 0.16;
  gyro.align = true;
  show(p);
}

function teleport(i) {
  arrive(PLACES[i]);
  $('keys').classList.add('faded');
}

function show(p) { $('whereName').textContent = p.name; $('whereNote').textContent = p.note; }

// in the passages: below the terrace, or on the ramp up through the shell
function underground() {
  const { x, z } = player.pos, r = Math.hypot(x, z);
  return player.feet < 13.9 && (Math.abs(x) < 7.2 && z > 0 && z < 105 || Math.abs(z) < 3.5 && r < 119);
}

// what is underfoot, from the plan: paving and stairs, the gravel walks, or the meadow
function surface() {
  const { x, z } = player.pos, feet = player.feet, ax = Math.abs(x);
  if (inSphere() || underground()) return 'stone';
  if (feet > 63.5) return 'gravel';
  if (feet > 47) return 'stone';
  if (feet > 44) return ax < 45 && z > 95 ? 'stone' : 'gravel';
  if (feet > 0.6) return 'stone';
  if (ax < 40 && z > 157 && z < 205 || ax > 22 && ax < 30 && z > 205 && z < 720 || ax < 40 && z > 720 && z < 745) return 'gravel';
  return ax >= 20 && ax <= 22 && z > 205 && z < 720 ? 'stone' : 'grass';
}

// a footfall for each step taken, one for each real step on a phone, and a heavier one on landing
function footsteps(dt) {
  if (!started) return;
  if (player.airTime > 0.25) landing = Math.max(landing, player.airTime);
  else if (landing && player.airTime === 0) { sound.step(surface(), clamp(0.8 + landing, 1, 1.6)); landing = 0; pace = 0; }
  if (footfall) { footfall = false; sound.step(surface(), 0.9); return; }
  if (steps.speed > 0 || player.airTime > 0.12 || player.speed < 0.2 * WALK) { pace = 0.5; return; }
  pace += dt * Math.min((player.speed * SCALE) / 1.5, 3.4);     // a pace of about 1.5 m, at most 3.4 a second
  if (pace >= 1) { pace -= 1; sound.step(surface(), clamp(0.6 + (0.4 * player.speed) / RUN, 0.6, 1)); }
}

// in the void: anywhere above the floor inside the shell, right out to its foot
function inSphere() { return player.pos.distanceTo(CENTER) < 67 && !underground(); }

function placeLabel(feet) {
  const r = Math.hypot(player.pos.x, player.pos.z);
  if (inSphere()) return PLACES[3];
  if (underground()) return PLACES[2];
  if (feet > 60) return PLACES[6];
  if (feet > 44) return r > 105 || Math.abs(player.pos.x) > 45 ? PLACES[5] : PLACES[4];
  if (feet > 4.5 && r < 160) return { name: 'The ground terrace', note: `Ø${metres(315)}, four rows of cypress` };
  if (player.pos.z > 200 && Math.abs(player.pos.x) < 45) return PLACES[0];
  return { name: 'The meadow', note: `${metres(r)} from the sphere` };
}

function look(dx, dy) {
  if (gyro.on) { gyro.offset -= dx * 0.0022; return; }
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
  if (gyro.on) gyroView(); else camera.rotation.set(player.pitch, player.yaw, 0, 'YXZ');
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
  const paced = stepPace(dt);
  if (paced > 0) { input.y = 1; input.speed = paced; } else input.speed = undefined;
  player.update(dt, input);
}

function tick(dt) {
  time += dt;
  if (started) simulate(dt);
  updateCamera(dt);
  footsteps(dt);

  const p = player.pos;
  // the sun crosses the sky and back; holding T hurries it along
  dayClock += dt * (keys.has('KeyT') ? 120 : 1) / DAY;
  const leg = dayClock % 2;
  world.setSun(leg < 1 ? leg : 2 - leg);

  const inVoid = inSphere();
  sound.setRoom(inVoid ? 'void' : underground() ? 'passage' : 'open');
  if (inVoid !== wasInVoid) { wasInVoid = inVoid; shadowClock = 0; }
  world.shadowsClose(inVoid);
  // the bores' light rises and falls over a second and a half, seen from the passage as well as inside
  const near = inVoid || (underground() && Math.hypot(p.x, p.z) < 90);
  shaftLight = clamp(shaftLight + (near ? dt : -dt) / 1.5, 0, 1);
  world.shafts.fade.value = shaftLight * shaftLight * (3 - 2 * shaftLight);
  world.shafts.mesh.visible = shaftLight > 0;
  if (shaftLight > 0) {
    lightProbe.color.copy(world.sun.color); lightProbe.intensity = world.sunStrength();
    world.tomb.intensity = world.shafts.update(SUN, lightProbe) * 14 * world.shafts.fade.value;
  } else world.tomb.intensity = 0;
  // outdoors the sun's shadows follow it in steps too small to see
  shadowClock -= dt;
  if (!inVoid && (shadowClock <= 0 || keys.has('KeyT'))) { shadowClock = 0.5; world.refresh(); }

  world.water.material.uniforms.time.value = time;
  world.lamps.material.uniforms.t.value = time;
  world.shafts.scale.value = renderer.domElement.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  world.lamps.material.uniforms.scale.value = renderer.domElement.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  world.sky.material.uniforms.time.value = time;
  world.fire.update(dt, time, camera);

  lodClock += dt;
  const moved = lodAt.distanceTo({ x: p.x, y: p.z });
  if (moved > 3 && (lodClock > 0.25 || moved > 12)) {                     // at once after a jump
    world.trees.updateLOD(p.x, p.z, 45); lodAt.set(p.x, p.z); lodClock = 0;
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
    if (e.code === 'KeyM') toggleMusic();
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

  $('music').addEventListener('click', toggleMusic);
  showMusic();
  const openPlaces = (open) => { $('places').classList.toggle('open', open); $('placesBtn').setAttribute('aria-expanded', open); };
  $('placesBtn').addEventListener('click', () => openPlaces(!$('places').classList.contains('open')));
  PLACES.forEach((p, i) => {
    const b = document.createElement('button');
    b.innerHTML = `${p.name}<kbd>${i + 1}</kbd>`;
    b.addEventListener('click', () => { teleport(i); openPlaces(false); });
    $('places').append(b);
  });
  // full screen where the browser allows it; an iPhone instead runs full screen from the home screen
  const root = document.documentElement, request = root.requestFullscreen ?? root.webkitRequestFullscreen;
  if (request) {
    $('full').hidden = false;
    $('full').addEventListener('click', () => (document.fullscreenElement || document.webkitFullscreenElement) ? (document.exitFullscreen ?? document.webkitExitFullscreen).call(document) : fullScreen());
  }
}

function fullScreen() {
  const root = document.documentElement, request = root.requestFullscreen ?? root.webkitRequestFullscreen;
  try { request?.call(root, { navigationUI: 'hide' })?.catch?.(() => {}); } catch { /* refused: carry on in the page */ }
}

function showMusic() { $('music').setAttribute('aria-pressed', sound.musicOn); }
function toggleMusic() {
  const on = sound.toggleMusic();
  showMusic();
  $('whereNote').textContent = on ? 'Music: Haydn, The Creation, “Chaos” and “Let there be light”' : 'Music off';
}

async function start() {
  world = await loadWorld(renderer, (f) => { $('bar').firstElementChild.style.width = `${Math.round(f * 100)}%`; });
  player = new Player({ bvh: world.bvh, groundHeight, treeHash: world.trees.hash });
  bindControls();

  $('about').innerHTML = SCALE === 1
    ? 'You stand here at true eye height against the 150 m sphere. Screens make large things look small, so it feels smaller than it would in person. <a href="./">Use the corrected camera</a>.'
    : 'Screens make large things look small, so the camera here stands lower and moves slower to give back the sense of size. <a href="?scale=1">See it at true eye height</a>.';
  arrive(PLACES[0]);
  world.trees.updateLOD(player.pos.x, player.pos.z, 45); lodAt.set(player.pos.x, player.pos.z);
  world.fire.update(0.016, 0, camera);
  renderer.shadowMap.needsUpdate = true;
  renderer.compile(world.scene, camera);
  updateCamera(0.016);
  renderer.render(world.scene, camera);
  if (debug) window.walk = { player, keys, input, world, camera, teleport, renderer, fps: 0, PLACES, simulate, tick, look, gyro, sound, surface, step: () => stepTaken(performance.now()), steps };
  frame();

  $('bar').style.display = 'none';
  const enter = $('enter');
  enter.hidden = false;
  enter.focus({ preventScroll: true });
  enter.addEventListener('click', () => {
    clearInterval(sheetTimer);
    $('intro').classList.add('gone');
    $('hud').classList.add('on');
    started = true;
    sound.start();
    if (touch) { fullScreen(); startPhoneSensors(); }
    else canvas.requestPointerLock?.()?.catch?.(() => {});
  });
}

showSheets();
start().catch((e) => {
  console.error(e);
  const box = $('err');
  box.hidden = false;
  box.textContent = 'This page needs WebGL 2. It could not start in this browser.';
});
