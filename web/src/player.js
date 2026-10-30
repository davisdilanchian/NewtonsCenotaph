// Capsule character controller over a triangle BVH, with an analytic ground and cylinder
// trees. The collision step follows the three-mesh-bvh character example (MIT).
import * as THREE from 'three';
import { SCALE } from './util.js';

export const RADIUS = 0.32 / SCALE, HEIGHT = 1.75 / SCALE, WALK = 2.2 / SCALE, RUN = 9.5 / Math.sqrt(SCALE);
const GRAVITY = 22 / SCALE, JUMP = 6.4 / SCALE, WORLD_R = 790, SUBSTEPS = 4;

const box = new THREE.Box3(), seg = new THREE.Line3(), triPt = new THREE.Vector3(), capPt = new THREE.Vector3();
const delta = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);

export class Player {
  constructor({ bvh, groundHeight, treeHash }) {
    Object.assign(this, { bvh, groundHeight, treeHash });
    this.pos = new THREE.Vector3();          // centre of the capsule's lower sphere
    this.vel = new THREE.Vector3();
    this.moveX = 0; this.moveZ = 0;          // horizontal walking velocity
    this.grounded = false; this.airTime = 0; this.speed = 0; this.dip = 0;
    this.yaw = 0; this.pitch = 0.1;          // pitch > 0 looks up
  }

  /** Stand on a point given as feet position, optionally facing another point. */
  place(feet, look) {
    this.pos.set(feet.x, feet.y + RADIUS + 0.05, feet.z);
    this.vel.set(0, 0, 0);
    this.moveX = this.moveZ = 0;
    if (look) this.yaw = Math.atan2(feet.x - look.x, feet.z - look.z);
  }

  get feet() { return this.pos.y - RADIUS; }

  update(dt, input) {
    const fwd = input.y, side = input.x, len = Math.hypot(fwd, side);
    const target = (input.speed ?? (input.run ? RUN : WALK)) * Math.min(1, len);
    const nx = len ? side / Math.max(1, len) : 0, nz = len ? fwd / Math.max(1, len) : 0;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const dirX = -sin * nz + cos * nx, dirZ = -cos * nz - sin * nx;
    const grip = 1 - Math.exp(-dt * (this.grounded ? 13 : 2.5));
    this.moveX += (dirX * target - this.moveX) * grip;
    this.moveZ += (dirZ * target - this.moveZ) * grip;

    if (input.jump && this.airTime < 0.12) { this.vel.y = JUMP; this.airTime = 1; this.grounded = false; }
    input.jump = false;

    const start = this.pos.clone(), h = dt / SUBSTEPS;
    for (let i = 0; i < SUBSTEPS; i++) this.step(h);
    this.treePush(); this.treePush();        // twice: a hedge gap is two trees pushing at once
    this.bounds();

    this.speed = Math.hypot(this.pos.x - start.x, this.pos.z - start.z) / Math.max(dt, 1e-4);
    if (this.grounded && this.airTime > 0.3) this.dip = Math.min(0.2, this.airTime * 0.12) / SCALE;   // knees take the landing
    this.dip *= Math.exp(-dt * 9);
    this.airTime = this.grounded ? 0 : this.airTime + dt;
    if (this.pos.y < -30) this.place({ x: 0, y: 0, z: 190 });
  }

  step(h) {
    this.vel.y -= GRAVITY * h;
    this.pos.addScaledVector(this.vel, h);
    this.pos.x += this.moveX * h;
    this.pos.z += this.moveZ * h;

    // push the capsule out of every triangle it touches
    seg.start.copy(this.pos);
    seg.end.copy(this.pos).addScaledVector(up, HEIGHT - RADIUS * 2);
    box.makeEmpty().expandByPoint(seg.start).expandByPoint(seg.end);
    box.min.addScalar(-RADIUS); box.max.addScalar(RADIUS);
    this.bvh.shapecast({
      intersectsBounds: (b) => b.intersectsBox(box),
      intersectsTriangle: (tri) => {
        const dist = tri.closestPointToSegment(seg, triPt, capPt);
        if (dist < RADIUS) {
          const depth = RADIUS - dist;
          const dir = capPt.sub(triPt).normalize();
          seg.start.addScaledVector(dir, depth);
          seg.end.addScaledVector(dir, depth);
        }
      },
    });
    delta.subVectors(seg.start, this.pos);
    const push = delta.length();
    const dn = push > 1e-6 ? delta.y / push : 0;
    let onGround = dn > 0.6 && delta.y > Math.abs(h * this.vel.y * 0.25);
    this.pos.copy(seg.start);

    const floor = this.groundHeight(this.pos.x, this.pos.z) + RADIUS;
    if (this.pos.y <= floor) { this.pos.y = floor; onGround = true; }

    if (onGround) this.vel.set(0, 0, 0);
    else if (push > 1e-6) { delta.divideScalar(push); this.vel.addScaledVector(delta, -delta.dot(this.vel)); }
    this.grounded = onGround;
  }

  treePush() {
    const { pos, treeHash } = this;
    const near = treeHash.near(pos.x, pos.z);
    for (const t of near) {
      if (this.feet > t.y + 9 || pos.y + HEIGHT < t.y) continue;
      const dx = pos.x - t.x, dz = pos.z - t.z, d = Math.hypot(dx, dz), min = RADIUS + t.r;
      if (d < min && d > 1e-4) { pos.x += dx / d * (min - d); pos.z += dz / d * (min - d); }
    }
  }

  bounds() {
    const d = Math.hypot(this.pos.x, this.pos.z);
    if (d > WORLD_R) { const k = WORLD_R / d; this.pos.x *= k; this.pos.z *= k; }
  }
}
