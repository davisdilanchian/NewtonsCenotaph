// The visitors, each with a mind of its own, small as it is. They know the site as a net of places
// joined by ways: the walks beside the basin, the stair, the terraces, the passages, the room under
// the tomb, the floor of the sphere and the top of the dais. Each picks somewhere to go, mostly
// nearby, walks there keeping to the right and stepping round whoever is in the way, stops to look,
// falls into conversation with whoever else is standing there, and moves on. Some come in pairs and
// keep together. They bow when you come up to them, and stand aside to let you by.
import * as THREE from 'three';
import { rng, clamp, smooth, SCALE } from './util.js';
import { makeCutouts } from './figures.js';

// places: [name, x, z, radius to stand about in, height to look for the floor from, what there is to look at, how well liked]
const SPHERE = [0, 73.5, 0], TOMB = [0, 20, 0];
const PLACES = [
  // the basin walks, from the far end to its head, on either side
  ['w0', -26, 726, 5, 0, SPHERE, 2], ['e0', 26, 726, 5, 0, SPHERE, 2], ['s0', 0, 733, 6, 0, SPHERE, 3],
  ['w1', -26, 620, 2.5, 0, [0, 0, 620], 1], ['e1', 26, 620, 2.5, 0, [0, 0, 620], 1],
  ['w2', -26, 500, 2.5, 0, [0, 0, 500], 1], ['e2', 26, 500, 2.5, 0, [0, 0, 500], 1],
  ['w3', -26, 380, 2.5, 0, SPHERE, 1], ['e3', 26, 380, 2.5, 0, SPHERE, 1],
  ['w4', -26, 280, 2.5, 0, SPHERE, 1], ['e4', 26, 280, 2.5, 0, SPHERE, 1],
  ['w5', -26, 212, 3, 0, SPHERE, 2], ['e5', 26, 212, 3, 0, SPHERE, 2],
  ['head', 0, 199, 7, 0, [0, 0, 400], 4],
  ['court', 0, 180, 9, 0, SPHERE, 4], ['courtW', -17, 176, 5, 0, SPHERE, 2], ['courtE', 16, 184, 5, 0, SPHERE, 2],
  ['foot', 0, 161.5, 7, 0, SPHERE, 1], ['top', 0, 135, 7, 5.5, [0, 0, 400], 3],
  // the ground terrace before the arch
  ['fore', 0, 124, 6, 5.5, [0, 30, 100], 4], ['foreW', -24, 130, 6, 5.5, [0, 60, 60], 3], ['foreE', 26, 131, 6, 5.5, [0, 60, 60], 3],
  ['lionW', -45, 129.5, 2.6, 5.5, [-48, 12, 121], 3], ['lionE', 45, 129.5, 2.6, 5.5, [48, 12, 121], 3],
  ['arch', 0, 113.5, 1.3, 5.5, TOMB, 0],
  // the front passage, its stair, the room under the tomb and the way out into the sphere
  ['p1', 0, 80, 1.1, 5.5, TOMB, 0], ['p2', 0, 45, 1.1, 5.5, TOMB, 0], ['pFoot', 0, 19.5, 1.1, 5.5, TOMB, 0],
  ['room', 0, 0.4, 1.6, 14, [0, 14, -20], 2], ['door', 0, -16.4, 0.7, 14, [0, 40, -60], 0],
  // the side passages, from the terrace to the room
  ['mouthE', 122, 0, 1.1, 5.5, TOMB, 0], ['sideE', 70, 0, 1.1, 5.5, TOMB, 0], ['footE', 19.5, 0, 1.1, 5.5, TOMB, 0],
  ['mouthW', -122, 0, 1.1, 5.5, TOMB, 0], ['sideW', -70, 0, 1.1, 5.5, TOMB, 0], ['footW', -19.5, 0, 1.1, 5.5, TOMB, 0],
  // up the faces of the dais to the tomb
  ['daisE', 5.9, 0, 1, 18.6, TOMB, 3], ['daisW', -5.9, 0, 1, 18.6, TOMB, 3], ['daisS', 0, 5.2, 1.5, 18.6, TOMB, 3],
  ['daisSE', 5.9, 5.3, 1, 18.6, TOMB, 1], ['daisSW', -5.9, 5.3, 1, 18.6, TOMB, 1],
  // on the stair block's head, against the sphere
  ['tier', 0, 83.6, 2.4, 64, [0, 0, 400], 1],
];
const WAYS = [
  ['s0', 'w0'], ['s0', 'e0'], ['w0', 'w1'], ['w1', 'w2'], ['w2', 'w3'], ['w3', 'w4'], ['w4', 'w5'], ['e0', 'e1'], ['e1', 'e2'], ['e2', 'e3'], ['e3', 'e4'], ['e4', 'e5'],
  ['w5', 'head'], ['e5', 'head'], ['w5', 'courtW'], ['e5', 'courtE'], ['head', 'court'], ['court', 'courtW'], ['court', 'courtE'], ['court', 'foot'], ['courtW', 'foot'], ['courtE', 'foot'],
  ['foot', 'top', 'steps'], ['top', 'fore'], ['top', 'foreW'], ['top', 'foreE'], ['fore', 'foreW'], ['fore', 'foreE'], ['foreW', 'lionW'], ['foreE', 'lionE'], ['top', 'lionW'], ['top', 'lionE'],
  ['fore', 'arch'], ['arch', 'p1'], ['p1', 'p2'], ['p2', 'pFoot'], ['pFoot', 'room', 'steps'], ['room', 'door'],
  ['mouthE', 'sideE'], ['sideE', 'footE'], ['footE', 'room', 'steps'], ['mouthW', 'sideW'], ['sideW', 'footW'], ['footW', 'room', 'steps'],
  ['daisE', 'daisSE'], ['daisSE', 'daisS'], ['daisS', 'daisSW'], ['daisSW', 'daisW'],
];
// rings: the floor of the sphere round the dais, the ground terrace round the drum, and the drum terrace
const RINGS = [
  { tag: 'v', r: 22.5, n: 12, y: 14, radius: 3.2, look: [0, 100, 0], liked: 3, all: true },
  { tag: 'g', r: 128, n: 18, y: 5.5, radius: 3.5, look: null, liked: 1, all: true },
  { tag: 'd', r: 93, n: 12, y: 46.5, radius: 3, look: null, liked: 1, all: true },
];

// How much light a visitor stands in: full daylight outside, little in the passages, less in the void.
function lightAt(x, y, z) {
  if (y < 13.9 && (Math.abs(x) < 7.3 && z > 2 && z < 100 || Math.abs(z) < 3.6 && Math.abs(x) < 112)) return 0.3;
  if (y < 17.5 && Math.abs(x) < 3.6 && z > -16 && z < 3.6) return 0.3;                // the room under the tomb and its way out
  return Math.hypot(x, y - 73.5, z) < 67 ? 0.16 : 1;
}

function buildNet(standOn, ray) {
  const nodes = [], byName = new Map();
  const add = (name, x, z, radius, hint, look, liked) => {
    const node = { name, x, z, y: standOn(x, hint + 1.5, z, ray), radius, look, liked, ways: [] };
    byName.set(name, node); nodes.push(node);
    return node;
  };
  for (const p of PLACES) add(...p);
  const join = (a, b, steps) => {
    const A = byName.get(a), B = byName.get(b), length = Math.hypot(B.x - A.x, B.z - A.z), way = { a: A, b: B, length, heights: null };
    if (steps) {                                     // feet on every tread: the floor sampled along it
      const n = Math.ceil(length / 0.1), heights = new Float32Array(n + 1);
      let y = A.y;
      for (let j = 0; j <= n; j++) heights[j] = y = standOn(A.x + (B.x - A.x) * j / n, y + 1.2, A.z + (B.z - A.z) * j / n, ray);
      way.heights = heights;
    }
    A.ways.push(way); B.ways.push(way);
  };
  for (const w of WAYS) join(...w);
  for (const ring of RINGS) {
    for (let k = 0; k < ring.n; k++) {
      const a = (k / ring.n) * Math.PI * 2;        // k = 0 is at the front
      add(ring.tag + k, Math.sin(a) * ring.r, Math.cos(a) * ring.r, ring.radius, ring.y, ring.look ?? [Math.sin(a) * 400, 20, Math.cos(a) * 400], ring.liked);
    }
    for (let k = 0; k < ring.n; k++) join(ring.tag + k, ring.tag + ((k + 1) % ring.n));
  }
  join('fore', 'g0'); join('foreW', 'g17'); join('foreE', 'g1'); join('lionW', 'g17'); join('lionE', 'g1');
  join('mouthE', 'g4'); join('mouthE', 'g5'); join('mouthW', 'g13'); join('mouthW', 'g14');        // g4.5 and g13.5 would be due east and west
  join('door', 'v6'); join('door', 'v5'); join('door', 'v7');
  join('v3', 'daisE', true); join('v9', 'daisW', true); join('v0', 'daisS', true);
  // which nodes can reach which, so nobody sets out for a terrace with no stair to it
  let part = 0;
  for (const n of nodes) {
    if (n.part !== undefined) continue;
    const todo = [n];
    n.part = part;
    while (todo.length) for (const w of todo.pop().ways) for (const m of [w.a, w.b]) if (m.part === undefined) { m.part = part; todo.push(m); }
    part++;
  }
  return { nodes, byName };
}

/** The ways from one place to another, shortest first: plain Dijkstra over a net this small. */
function route(net, from, to) {
  const dist = new Map([[from, 0]]), via = new Map(), open = new Set([from]);
  while (open.size) {
    let best = null;
    for (const n of open) if (!best || dist.get(n) < dist.get(best)) best = n;
    if (best === to) break;
    open.delete(best);
    for (const w of best.ways) {
      const next = w.a === best ? w.b : w.a, d = dist.get(best) + w.length;
      if (d < (dist.get(next) ?? Infinity)) { dist.set(next, d); via.set(next, w); open.add(next); }
    }
  }
  const ways = [];
  for (let n = to; n !== from;) { const w = via.get(n); if (!w) return null; ways.unshift(w); n = w.a === n ? w.b : w.a; }
  return ways;
}

export function makeVisitors(scene, sheet, places, floors, { standOn, sun, sunLight }) {
  const r = rng(5), ray = new THREE.Ray(), net = buildNet((x, y, z, q) => standOn(floors, x, y, z, q), ray);
  const liked = net.nodes.filter((n) => n.liked > 0);

  // who is where to begin with: most about the forecourt and terrace, some in the void, a few far off
  const START = [['court', 5], ['courtW', 3], ['courtE', 3], ['head', 4], ['fore', 5], ['foreW', 4], ['foreE', 4], ['lionW', 2], ['lionE', 2], ['top', 3], ['w5', 2], ['e5', 2],
                 ['w3', 2], ['e2', 2], ['e4', 2], ['w1', 2], ['s0', 3], ['room', 2], ['p1', 2], ['p2', 1], ['sideE', 1], ['v0', 2], ['v2', 3], ['v4', 2], ['v6', 3], ['v8', 2], ['v10', 3], ['daisS', 2], ['daisE', 1],
                 ['g3', 2], ['g6', 1], ['g9', 2], ['g12', 1], ['g15', 2], ['d0', 3], ['d1', 2], ['d11', 2], ['d4', 1], ['d8', 2], ['tier', 3]];
  const people = [];
  for (const [name, n] of START) for (let i = 0; i < n; i++) people.push({ home: net.byName.get(name) });
  const N = people.length;
  const cut = makeCutouts(sheet, places, N, { scale: SCALE, rand: r, sun });

  const spot = (node, out) => { const a = r() * 6.283, d = Math.sqrt(r()) * node.radius; out.x = node.x + Math.cos(a) * d; out.z = node.z + Math.sin(a) * d; return out; };
  const REACH = 0.34, PACE = 1.3 / SCALE;             // an arm's length between strangers, and a walking pace
  people.forEach((p, i) => {
    const me = cut.who[i];
    Object.assign(p, {
      i, node: p.home, way: null, ways: [], goal: null, x: 0, z: 0, y: p.home.y, hx: 0, hz: 1, target: { x: 0, z: 0 },
      state: 'stand', wait: 2 + r() * 70, speed: PACE * (0.82 + r() * 0.36), now: 0, phase: r() * 6.28, keep: 0.25 + r() * 0.55,
      face: me.face, turned: r() < 0.5 ? -1 : 1, turnTo: 1, bow: 0, bowing: 0, greeted: -1e9, lean: 0, gaze: 0,
      partner: null, lead: null, r: 0.1 + me.width * 0.22, lit: 1, sunny: 1, shade: r() * 0.5, tone: [1, 1, 1], slopeX: 0, slopeZ: 0, seed: r() * 100,
    });
    spot(p.home, p); p.turnTo = p.turned;
    p.target.x = p.x; p.target.z = p.z;
  });
  // some came together: the second keeps to the first's side wherever it goes
  for (let i = 1; i < N; i++) if (people[i].home === people[i - 1].home && !people[i - 1].lead && r() < 0.42) {
    const a = people[i - 1], b = people[i];
    b.lead = a; b.side = r() < 0.5 ? -1 : 1; b.speed = a.speed * 1.12;
    b.x = a.x + 0.4; b.z = a.z + 0.3;
  }

  const heightOn = (way, x, z) => {
    const dx = way.b.x - way.a.x, dz = way.b.z - way.a.z, t = clamp(((x - way.a.x) * dx + (z - way.a.z) * dz) / (way.length * way.length), 0, 1);
    if (!way.heights) return way.a.y + (way.b.y - way.a.y) * t;
    const f = t * (way.heights.length - 1), k = Math.min(way.heights.length - 2, Math.floor(f));
    return way.heights[k] + (way.heights[k + 1] - way.heights[k]) * (f - k);
  };

  function setOut(p) {
    // somewhere else worth going, the nearer the likelier
    let total = 0, pick = null;
    for (const n of liked) {
      if (n === p.node || n.part !== p.node.part) continue;
      const w = n.liked / (1 + Math.hypot(n.x - p.node.x, n.z - p.node.z) / 22) ** 3;
      total += w;
      if (r() * total < w) pick = n;
    }
    const ways = pick && route(net, p.node, pick);
    if (!ways || !ways.length) { p.wait = 3 + r() * 6; return; }
    p.ways = ways; p.goal = pick; p.partner = null;
    nextWay(p);
  }

  function nextWay(p) {
    const way = p.ways.shift();
    if (!way) { arrive(p); return; }
    const to = way.a === p.node ? way.b : way.a, dx = to.x - p.node.x, dz = to.z - p.node.z, l = Math.hypot(dx, dz) || 1;
    p.way = way; p.to = to; p.state = 'walk';
    if (to === p.goal) spot(to, p.target);
    else { const k = p.keep * Math.min(to.radius, 2.2); p.target.x = to.x - (dz / l) * k; p.target.z = to.z + (dx / l) * k; }   // keeping to the right
  }

  // someone standing here alone, not too far off: go over and talk
  function meet(p) {
    for (const q of people) {
      if (q === p || q.node !== p.node || q.state !== 'stand' || q.partner || q.lead || Math.hypot(q.x - p.x, q.z - p.z) > 5) continue;
      p.partner = q; q.partner = p; q.wait = Math.max(q.wait, p.wait = 14 + r() * 30);
      const a = Math.atan2(p.z - q.z, p.x - q.x) + (r() - 0.5), gap = 0.22 + p.r + q.r;
      p.target.x = q.x + Math.cos(a) * gap; p.target.z = q.z + Math.sin(a) * gap; p.state = 'step';
      return true;
    }
    return false;
  }

  function arrive(p) {
    p.state = 'stand'; p.way = null; p.goal = null;
    p.wait = 20 + r() * 60;
    if (!p.lead && r() < 0.8) meet(p);
  }

  const cam = new THREE.Vector3();
  let clock = 0;
  return {
    net, people,
    update(dt, camera, me) {
      clock += dt; cut.time.value = clock;
      cam.copy(camera.position);
      const mx = me ? me.x : 1e9, mz = me ? me.z : 1e9, myFeet = me ? me.feet : 0;
      for (const p of people) {
        // --- what to do
        let wantX = 0, wantZ = 0, pace = 0;
        const toMe = Math.hypot(mx - p.x, mz - p.z), close = toMe < 1.5 && Math.abs(myFeet - p.y) < 1.2;
        if (p.lead) {                                // keep at the other's side
          const a = p.lead, sx = -a.hz * p.side, sz = a.hx * p.side;
          p.node = a.node; p.way = a.way; p.to = a.to;
          const gap = 0.16 + a.r + p.r;                // shoulder to shoulder, with room for a skirt
          p.target.x = a.x + sx * gap - a.hx * 0.08; p.target.z = a.z + sz * gap - a.hz * 0.08;
          const d = Math.hypot(p.target.x - p.x, p.target.z - p.z);
          p.state = d > (p.state === 'stand' ? 0.22 : 0.06) ? 'walk' : 'stand';
          if (p.state === 'walk') { wantX = (p.target.x - p.x) / d; wantZ = (p.target.z - p.z) / d; pace = Math.min(1, d / 0.3) * (a.state === 'walk' ? 1 : 0.7); }
        } else if (p.state === 'walk' || p.state === 'step') {
          const dx = p.target.x - p.x, dz = p.target.z - p.z, d = Math.hypot(dx, dz);
          if (d < 0.12) {
            if (p.state === 'step') p.state = 'stand';
            else { p.node = p.to; nextWay(p); }
          } else { wantX = dx / d; wantZ = dz / d; pace = p.state === 'step' ? 0.7 : 1; }
        } else {
          p.wait -= dt;
          if (p.partner && (p.partner.partner !== p || p.partner.state === 'walk')) p.partner = null;
          if (p.wait <= 0 && p.bowing <= 0) {
            if (p.partner) { p.partner.partner = null; p.partner.wait = Math.min(p.partner.wait, 1 + r() * 3); p.partner = null; }
            if (r() < 0.3 && meet(p)) { /* found company */ }
            else if (r() < 0.3 && p.node.radius > 2) { spot(p.node, p.target); p.state = 'step'; p.wait = 8 + r() * 25; }   // a few steps to see it from over there
            else setOut(p);
          }
        }
        // --- manners: bow to the walker who comes up, once, and let them by
        if (close && clock - p.greeted > 25 && p.bowing <= 0 && (p.state === 'stand' || toMe < 0.8)) { p.bowing = 1.7; p.greeted = clock; }
        if (p.bowing > 0) { p.bowing -= dt; pace = 0; }
        p.bow += ((p.bowing > 0 ? Math.sin(Math.PI * clamp(p.bowing / 1.7, 0, 1)) ** 0.8 : 0) - p.bow) * Math.min(1, dt * 10);

        // --- stepping round each other and the walker
        let pushX = 0, pushZ = 0, ahead = 1;
        if (pace > 0) {
          for (const q of people) {
            if (q === p || q.lead === p || p.lead === q || Math.abs(q.y - p.y) > 1) continue;
            const dx = p.x - q.x, dz = p.z - q.z, d = Math.hypot(dx, dz), min = p.r + q.r + REACH * 0.5;
            if (d > min || d < 1e-4) continue;
            const k = (min - d) / min;
            pushX += (dx / d) * k - wantZ * k * 0.6; pushZ += (dz / d) * k + wantX * k * 0.6;      // away, and round to the right
            if (-(dx * wantX + dz * wantZ) > 0.6 * d && q.state !== 'walk') ahead = Math.min(ahead, 0.55 + 0.45 * d / min);
          }
          if (toMe < 0.75 && Math.abs(myFeet - p.y) < 1.2) {
            const dx = p.x - mx, dz = p.z - mz, k = (0.75 - toMe) / 0.75;
            pushX += (dx / toMe) * k * 1.6 - wantZ * k; pushZ += (dz / toMe) * k * 1.6 + wantX * k;
            if (-(dx * wantX + dz * wantZ) > 0.5 * toMe) ahead = Math.min(ahead, toMe < 0.4 ? 0 : 0.5);   // after you
          }
        }
        let vx = wantX + pushX * 1.4, vz = wantZ + pushZ * 1.4;
        const vl = Math.hypot(vx, vz);
        if (vl > 1) { vx /= vl; vz /= vl; }
        const speed = p.speed * pace * ahead;
        p.now += (speed - p.now) * Math.min(1, dt * 5);
        const going = p.now / p.speed;
        if (pace > 0) {
          const nx = p.x + vx * p.now * dt, nz = p.z + vz * p.now * dt;
          // never off the way it is on: in a passage that is the walls
          const w = p.way, wide = w ? Math.max(Math.min(w.a.radius, w.b.radius), 0.9) : p.node.radius + 0.5;
          let ok = true;
          if (w) {
            const dx = w.b.x - w.a.x, dz = w.b.z - w.a.z, t = clamp(((nx - w.a.x) * dx + (nz - w.a.z) * dz) / (w.length * w.length), 0, 1);
            ok = Math.hypot(nx - w.a.x - dx * t, nz - w.a.z - dz * t) < wide * 1.4;
          }
          if (ok) { p.x = nx; p.z = nz; } else { p.x += wantX * p.now * dt; p.z += wantZ * p.now * dt; }
          p.phase += p.now * dt * SCALE * 4.3 / (0.75 + 0.25 * cut.who[p.i].height * SCALE / 1.9);
        }
        const before = p.y, floor = p.way ? heightOn(p.way, p.x, p.z) : p.node.y;
        p.y += (floor - p.y) * Math.min(1, dt * 14);
        if (p.now > 0.02 && p.way?.heights) { const run = Math.max(p.now * dt, 1e-4), s = clamp((p.y - before) / run, -0.8, 0.8); p.slopeX += (vx * s - p.slopeX) * 0.2; p.slopeZ += (vz * s - p.slopeZ) * 0.2; }
        else { p.slopeX *= 0.9; p.slopeZ *= 0.9; }

        // --- which way it faces: where it is going, whom it is talking to, who has come up, or the view
        let fx = p.hx, fz = p.hz, gaze = 0;
        if (going > 0.25) { fx = vx; fz = vz; }
        else if (p.bowing > 0 || (close && toMe < 1.1)) { fx = mx - p.x; fz = mz - p.z; }
        else if (p.partner) { fx = p.partner.x - p.x; fz = p.partner.z - p.z; }
        else if (p.lead && p.lead.state === 'stand' && p.lead.now < 0.02 && Math.sin(clock * 0.21 + p.seed) > 0.2) { fx = p.lead.x - p.x; fz = p.lead.z - p.z; }
        else if (p.node.look) { fx = p.node.look[0] - p.x; fz = p.node.look[2] - p.z; gaze = clamp((p.node.look[1] - p.y) / (Math.hypot(fx, fz) + 1), 0, 1.2); }
        const fl = Math.hypot(fx, fz) || 1;
        p.hx += (fx / fl - p.hx) * Math.min(1, dt * 6); p.hz += (fz / fl - p.hz) * Math.min(1, dt * 6);
        const ex = cam.x - p.x, ez = cam.z - p.z, el = Math.hypot(ex, ez) || 1, across = (p.hx * ez - p.hz * ex) / el;   // along the sheet's right, as seen
        if (p.face && Math.abs(across) > 0.3) p.turnTo = Math.sign(across) * p.face;
        p.turned = clamp(p.turned + Math.sign(p.turnTo - p.turned) * dt * 5.5, -1, 1);
        if (Math.abs(p.turned) < 0.06 && p.turnTo !== 0) p.turned = 0.06 * Math.sign(p.turnTo - p.turned || 1);          // never edge-on for longer than a frame
        const dir = p.face;                                              // one drawn in profile leans back, away from where it faces, to look up
        // talk is a nod now and then; a view is taken in leaning back a little
        const nod = p.partner || (p.lead && p.state === 'stand') ? 0.07 * Math.max(0, Math.sin(clock * 1.7 + p.seed)) ** 6 : 0;
        p.gaze += ((going < 0.1 && !p.partner && p.bowing <= 0 ? -0.13 * Math.min(gaze, 1) : 0) - p.gaze) * Math.min(1, dt * 2);
        p.lean += ((going * 0.045 * clamp(across * 1.5, -1, 1)) / Math.max(Math.abs(p.turned), 0.3) * Math.sign(p.turned) - p.lean) * Math.min(1, dt * 6);

        // --- the light it stands in: the sun unless something is in its way, looked for now and then
        const lit = lightAt(p.x, p.y, p.z);
        p.lit += (lit - p.lit) * Math.min(1, dt * 3);
        p.shade -= dt;
        if (p.shade <= 0) {
          p.shade = 0.5 + r() * 0.2;
          p.sunny = 0;
          if (lit === 1) { ray.origin.set(p.x, p.y + cut.who[p.i].height * 0.6, p.z); ray.direction.copy(sun.value); p.sunny = floors.bvh.raycastFirst(ray, THREE.DoubleSide) ? 0 : 1; }
        }
        const out = smooth(0.3, 1, p.lit);
        p.sun = (p.sun ?? p.sunny) + (p.sunny - (p.sun ?? p.sunny)) * Math.min(1, dt * 4);
        const s = sunLight(), direct = p.sun * out * s.strength * 0.26, sky = out * s.sky * 0.5, lamp = (1 - out) * p.lit;
        cut.place(p.i, p.x, p.y, p.z, p.turned, p.slopeX, p.slopeZ);
        cut.pose(p.i, p.phase, smooth(0.05, 0.8, going), p.bow + nod, p.lean + p.gaze * dir);
        cut.light(p.i, direct * s.color.r + sky * 0.86 + lamp * 1.0, direct * s.color.g + sky * 0.93 + lamp * 0.86, direct * s.color.b + sky * 1.0 + lamp * 0.7, p.sun * out);
      }
      cut.moved();
    },
    meshes: cut.meshes,
  };
}
