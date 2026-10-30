// Visitors as flat dark silhouettes, like the specks in Boullée's sheets: frock coats,
// tricornes and wide skirts. Built from primitives, so the page needs no character download.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const lathe = (pts, y) => new THREE.LatheGeometry(pts.map(([r, h]) => new THREE.Vector2(r, h)), 12).translate(0, y, 0);

function tricorne(y) {
  // three-cornered brim, its sides pinched inward
  const s = new THREE.Shape();
  const pts = [0, 1, 2].map((i) => { const a = Math.PI / 2 + i * 2 * Math.PI / 3; return [Math.cos(a) * 0.235, Math.sin(a) * 0.235]; });
  s.moveTo(...pts[0]);
  [1, 2, 0].forEach((i, k) => { const p = pts[k], q = pts[i]; s.quadraticCurveTo((p[0] + q[0]) * 0.28, (p[1] + q[1]) * 0.28, q[0], q[1]); });
  return new THREE.ExtrudeGeometry(s, { depth: 0.03, bevelEnabled: false, curveSegments: 6 }).rotateX(-Math.PI / 2).translate(0, y, 0);
}

const limb = (r, length, x, y, swing) => new THREE.CapsuleGeometry(r, length, 3, 8).translate(0, -length / 2 - r, 0).rotateX(swing).translate(x, y, 0);

function man(stride, arm, cane) {
  const parts = [
    lathe([[0.3, 0], [0.25, 0.2], [0.195, 0.42], [0.185, 0.56], [0.215, 0.72], [0.13, 0.8], [0.06, 0.82]], 0.68),
    new THREE.SphereGeometry(0.105, 12, 8).translate(0, 1.635, 0),
    new THREE.CylinderGeometry(0.098, 0.112, 0.085, 10).translate(0, 1.745, 0),
    tricorne(1.7),
    limb(0.075, 0.68, -0.1, 0.84, stride),
    limb(0.075, 0.68, 0.1, 0.84, -stride),
    limb(0.06, 0.5, -0.24, 1.42, -arm),
    limb(0.06, 0.5, 0.24, 1.42, arm),
  ];
  if (cane) parts.push(new THREE.CylinderGeometry(0.014, 0.014, 0.98, 5).translate(0.34, 0.49, 0.18));
  return parts;
}

function woman() {
  return [
    lathe([[0.48, 0], [0.47, 0.18], [0.4, 0.5], [0.27, 0.8], [0.13, 0.98], [0.15, 1.2], [0.11, 1.34], [0.05, 1.38]], 0),
    new THREE.SphereGeometry(0.1, 12, 8).translate(0, 1.52, 0),
    new THREE.SphereGeometry(0.11, 10, 8).scale(1, 1.15, 1).translate(0, 1.63, -0.02),
    limb(0.05, 0.46, -0.2, 1.32, -0.25),
    limb(0.05, 0.46, 0.2, 1.32, 0.25),
  ];
}

/** Three figures, each one flat geometry for instancing. */
export function figureGeometries() {
  return [man(0.05, 0.04, false), man(0.3, 0.28, false), man(0.12, 0.08, true), woman()].map((parts) => mergeGeometries(parts.map((g) => {
    const flat = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(flat.attributes)) if (k !== 'position') flat.deleteAttribute(k);
    return flat;
  })));
}
