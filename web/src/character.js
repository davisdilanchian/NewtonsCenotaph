// Visitors of 1784: frock coat, breeches, tricorne. Built from primitives, so the page
// needs no character download.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const part = (geo, color, x = 0, y = 0, z = 0) => { geo.translate(x, y, z); return { geo, color }; };

function tricorne() {
  // three-cornered brim, its sides pinched inward
  const s = new THREE.Shape();
  const pts = [0, 1, 2].map((i) => { const a = Math.PI / 2 + i * 2 * Math.PI / 3; return [Math.cos(a) * 0.235, Math.sin(a) * 0.235]; });
  s.moveTo(...pts[0]);
  [1, 2, 0].forEach((i, k) => { const p = pts[k], q = pts[i]; s.quadraticCurveTo((p[0] + q[0]) * 0.28, (p[1] + q[1]) * 0.28, q[0], q[1]); });
  const brim = new THREE.ExtrudeGeometry(s, { depth: 0.03, bevelEnabled: false, curveSegments: 8 });
  brim.deleteAttribute('uv');
  brim.rotateX(-Math.PI / 2);
  return brim;
}

function figureParts(coat, hat) {
  const stocking = 0xe6dfcf, breech = 0xcbbf9f, boot = 0x17130f, skin = 0xd9a988;
  const body = [
    // coat skirt and body, a lathe from hem to shoulders
    part(new THREE.LatheGeometry([[0.3, 0], [0.25, 0.2], [0.195, 0.42], [0.185, 0.56], [0.215, 0.72], [0.13, 0.8], [0.06, 0.82]].map(([x, y]) => new THREE.Vector2(x, y)), 14), coat, 0, 0.68, 0),
    part(new THREE.CapsuleGeometry(0.052, 0.07, 3, 8), skin, 0, 1.53, 0),
    part(new THREE.SphereGeometry(0.105, 14, 10), skin, 0, 1.635, 0),
    part(new THREE.SphereGeometry(0.11, 12, 8), 0xd8d3c8, 0, 1.655, -0.022),       // powdered hair
    part(new THREE.CylinderGeometry(0.098, 0.112, 0.085, 12), hat, 0, 1.745, 0),
    part(tricorne(), hat, 0, 1.70, 0),
  ];
  const leg = [
    part(new THREE.CapsuleGeometry(0.075, 0.28, 3, 8), breech, 0, -0.2, 0),
    part(new THREE.CapsuleGeometry(0.058, 0.3, 3, 8), stocking, 0, -0.55, 0),
    part(new THREE.BoxGeometry(0.1, 0.07, 0.25), boot, 0, -0.8, 0.055),
  ];
  const arm = [
    part(new THREE.CapsuleGeometry(0.06, 0.44, 3, 8), coat, 0, -0.27, 0),
    part(new THREE.SphereGeometry(0.046, 8, 6), skin, 0, -0.57, 0),
  ];
  return { body, leg, arm };
}

/** One static figure merged into a single geometry with vertex colours, for instancing. */
export function bakedFigureGeometry(coat, hat) {
  const { body, leg, arm } = figureParts(coat, hat);
  const placed = [...body];
  const add = (parts, x, y, rx) => {
    for (const p of parts) placed.push({ geo: p.geo.clone().rotateX(rx).translate(x, y, 0), color: p.color });
  };
  add(leg, -0.1, 0.84, 0.05); add(leg, 0.1, 0.84, -0.05);
  add(arm, -0.24, 1.42, 0); add(arm, 0.24, 1.42, 0);
  const c = new THREE.Color();
  const geos = placed.map(({ geo, color }) => {
    const g = (geo.index ? geo.toNonIndexed() : geo.clone());
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    c.set(color);
    const col = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < col.length; i += 3) { col[i] = c.r; col[i + 1] = c.g; col[i + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
  });
  return mergeGeometries(geos);
}
