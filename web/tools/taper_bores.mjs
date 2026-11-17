// Taper the vault's bores in the shipped monument.glb: each stays as wide as it was where it opens
// into the void, and narrows to a pinhole on the outside of the sphere, so the stone reads whole from
// the terraces. scripts/build_scene.py cuts the same cones; this patches the mesh without a rebuild.
//   node tools/taper_bores.mjs            (from web/; refuses a file that is already tapered)
import { readFileSync, statSync } from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';

const GLB = 'public/assets/monument.glb', HOLES = 'public/assets/holes.bin';
const C = [0, 73.5, 0], TOMB = [0, 19, 0], R_IN = 67, R_OUT = 75;
export const outerRadius = (r) => Math.max(0.035, 0.28 * r);       // must match bore_mouth in scripts/build_scene.py
const H0 = -1.5, H1 = 14, innerRing = (r) => (r * 1.35 + 0.05) * 1.04;   // the old cutter: a 12-gon from this, to r at H1
const wallAt = (b, h) => b.a + (b.r - b.a) * (h - H0) / (H1 - H0);

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const mad = (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s], len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

const buf = readFileSync(HOLES), n = buf.readUInt32LE(0), bores = [];
for (let i = 0; i < n; i++) {
  const d = [0, 1, 2].map((k) => buf.readFloatLE(4 + (i * 4 + k) * 4)), r = buf.readFloatLE(4 + (i * 4 + 3) * 4);
  const q = mad(C, d, R_IN), axis = unit(sub(q, TOMB));
  bores.push({ i, d, r, q, axis, a: innerRing(r), out: outerRadius(r), alt: Math.asin(d[1]) * 180 / Math.PI, tilt: Math.acos(dot(axis, d)) * 180 / Math.PI,
               moved: { sphere: 0, bore: 0 }, inner: 0, rim: [] });
}

/** Where the line p + e*s + axis*h (h free) meets the sphere of radius R: the larger root, on the bore's way out. */
function onSphere(base, axis, R) {
  const o = sub(base, C), b = dot(o, axis), c = dot(o, o) - R * R, disc = b * b - c;
  return mad(base, axis, -b + Math.sqrt(Math.max(disc, 0)));
}

/** The bore a point lies on the wall of, if any, with its place on that wall. */
function wallOf(p, loose = 1) {
  let best = null;
  for (const b of bores) {
    const v = sub(p, b.q), h = dot(v, b.axis);
    if (h < -3 || h > 16) continue;
    const radial = mad(v, b.axis, -h), rho = len(radial), w = wallAt(b, h);
    if (rho > w + 0.006 * loose) continue;
    if (!best || rho / w < best.k) best = { b, h, rho, w, k: rho / w, e: unit(radial) };
  }
  return best;
}

/** The new cone's generator through a wall point: from where the old wall met the vault, kept, to the pinhole outside. */
function generator({ b, k, e }) {
  // old generator at this angle: q + axis*h + e*k*wallAt(h); find where it crossed the inner sphere
  let h = 0;
  for (let it = 0; it < 8; it++) {
    const base = mad(b.q, e, k * wallAt(b, h)), o = sub(base, C), bb = dot(o, b.axis), cc = dot(o, o) - R_IN * R_IN;
    h = -bb + Math.sqrt(Math.max(bb * bb - cc, 0));
  }
  const inner = mad(mad(b.q, e, k * wallAt(b, h)), b.axis, h);
  const outer = onSphere(mad(b.q, e, b.out), b.axis, R_OUT);        // a true circle: the old 12-gon's corners, 5 mm apart in a compressed mesh, would cross
  const g = unit(sub(outer, inner)), t = cross(b.axis, e);
  let nrm = unit(cross(t, g));
  if (dot(nrm, e) > 0) nrm = nrm.map((v) => -v);                    // the wall faces the axis, and leans toward the void
  return { inner, outer, nrm };
}

const io = new NodeIO().registerExtensions([KHRDracoMeshCompression])
  .registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule(), 'draco3d.encoder': await draco3d.createEncoderModule() });
const before = statSync(GLB).size, doc = await io.read(GLB);
const mesh = doc.getRoot().listNodes().find((x) => x.getName().startsWith('Sphere'))?.getMesh();
if (!mesh) throw new Error('no sphere in ' + GLB);
const prim = (name) => mesh.listPrimitives().find((p) => p.getMaterial()?.getName() === name);
const sphere = prim('Limestone sphere'), bore = prim('Bore');
const names = doc.getRoot().listNodes().map((x) => x.getName()).join('|');

// already done? then the outer surface has no vertex left on any old rim
const sp = sphere.getAttribute('POSITION'), spArr = sp.getArray().slice(), p = [0, 0, 0];
let oldRim = 0, inHole = 0;
const hits = new Array(sp.getCount());
for (let v = 0; v < sp.getCount(); v++) {
  sp.getElement(v, p);
  if (Math.abs(len(sub(p, C)) - R_OUT) > 0.05) continue;
  const w = wallOf(p);
  if (!w) continue;
  if (w.k < 0.94 && w.rho < w.w - 0.03) { inHole++; continue; }
  hits[v] = w; oldRim++;
}
if (oldRim < bores.length * 6) { console.log(`already tapered: ${oldRim} vertices on old rims (${inHole} inside old holes). Nothing done.`); process.exit(0); }

// triangle facing before, to prove none folds
const idx = sphere.getIndices().getArray(), facing = (arr, i) => {
  const P = (k) => [arr[idx[i + k] * 3], arr[idx[i + k] * 3 + 1], arr[idx[i + k] * 3 + 2]], a = P(0), b = P(1), c = P(2);
  const nrm = cross(sub(b, a), sub(c, a)), mid = sub(a.map((x, k) => (x + b[k] + c[k]) / 3), C);
  return { s: Math.sign(dot(nrm, mid)), area: len(nrm) / 2 };
};
const was = [];
for (let i = 0; i < idx.length; i += 3) was.push(facing(spArr, i).s);

// Rim vertices a few millimetres apart would swap places once the rim shrinks, folding the sliver between
// them, so each such cluster lands on one point, the same in both parts of the mesh.
const CELL = 0.012;
function land(w, p) {
  const list = (w.b.seen ??= []);
  for (const s of list) if (Math.hypot(s.p[0] - p[0], s.p[1] - p[1], s.p[2] - p[2]) < Math.max(CELL, 0.06 * w.b.r)) return s.g;
  const g = generator(w);
  list.push({ p: [...p], g });
  return g;
}
for (let v = 0; v < sp.getCount(); v++) {
  const w = hits[v];
  if (!w) continue;
  sp.getElement(v, p);
  const g = land(w, p);
  sp.setElement(v, g.outer); w.b.moved.sphere++; w.b.rim.push(g.outer);
}
const bp = bore.getAttribute('POSITION'), bn = bore.getAttribute('NORMAL');
let between = 0, unmatched = 0;
for (let v = 0; v < bp.getCount(); v++) {
  bp.getElement(v, p);
  const rad = len(sub(p, C)), w = wallOf(p);
  if (!w || w.k < 0.9) { unmatched++; continue; }
  const g = Math.abs(rad - R_OUT) < 0.05 ? land(w, p) : generator(w);
  if (Math.abs(rad - R_OUT) < 0.05) { bp.setElement(v, g.outer); w.b.moved.bore++; }
  else if (Math.abs(rad - R_IN) < 0.05) w.b.inner++;
  else { between++; continue; }
  bn.setElement(v, g.nrm);
}

const now = sp.getArray();
// Round each rim, every triangle of the outer surface should face out. The compressed mesh already has
// slivers along the old rims that don't; a fold is one that faced out before and faces in now. A few
// slivers between three rim points always remain, each under a square centimetre or so.
let inBefore = 0, inAfter = 0, folded = 0, worst = 0, i3 = 0;
for (let i = 0; i < idx.length; i += 3, i3++) {
  if (!hits[idx[i]] && !hits[idx[i + 1]] && !hits[idx[i + 2]]) continue;
  const f = facing(now, i);
  if (was[i3] < 0) inBefore++;
  if (f.s < 0 && f.area > 1e-6) { inAfter++; if (was[i3] > 0) { folded++; worst = Math.max(worst, f.area); } }
}

// report: the Moon, the faintest, and the most tilted bores
const stat = (b) => {
  const rho = b.rim.map((o) => { const v = sub(o, b.q); return len(mad(v, b.axis, -dot(v, b.axis))); }), off = b.rim.map((o) => Math.abs(len(sub(o, C)) - R_OUT));
  return `#${b.i} r=${b.r.toFixed(3)} alt=${b.alt.toFixed(0)}° tilt=${b.tilt.toFixed(0)}° moved sphere/bore=${b.moved.sphere}/${b.moved.bore} inner=${b.inner} `
    + `rim ${Math.min(...rho).toFixed(4)}..${Math.max(...rho).toFixed(4)} (want ${b.out.toFixed(4)}) off sphere ${Math.max(...off).toExponential(1)}`;
};
const byTilt = [...bores].sort((a, b) => b.tilt - a.tilt), byR = [...bores].sort((a, b) => a.r - b.r);
for (const b of [bores[0], byR[0], byR[1], byTilt[0], byTilt[1], byTilt[2], bores[Math.floor(bores.length / 2)]]) console.log(stat(b));
const few = bores.filter((b) => b.moved.sphere < 12 || b.moved.bore < 12);
console.log(`${bores.length} bores; ${oldRim} outer-surface rim vertices moved; ${inHole} outer vertices were inside an old hole; rim triangles facing in: ${inBefore} before, ${inAfter} after, ${folded} of them newly folded (largest ${worst.toExponential(1)} m²); `
  + `bore vertices between the rims ${between}, off any wall ${unmatched}; bores with under 12 moved in either part: ${few.length}${few.length ? ' (' + few.slice(0, 12).map((b) => `#${b.i}:${b.moved.sphere}/${b.moved.bore}`).join(' ') + ')' : ''}`);
if (worst > 1e-3) throw new Error('a triangle folded: not written');

doc.createExtension(KHRDracoMeshCompression).setRequired(true)
  .setEncoderOptions({ method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER, encodeSpeed: 3, decodeSpeed: 5,
                       quantizationBits: { POSITION: 15, NORMAL: 10, COLOR: 10, TEX_COORD: 12, GENERIC: 12 }, quantizationVolume: 'mesh' });   // as Blender exported it
await io.write(GLB, doc);
const after = doc.getRoot().listNodes().map((x) => x.getName()).join('|');
if (after !== names) throw new Error('node names changed');
console.log(`wrote ${GLB}: ${before} -> ${statSync(GLB).size} bytes`);
