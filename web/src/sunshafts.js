// Daylight in the void. Each bore is a long light pipe: whatever enters can only leave along its
// axis, so its column and its pool on the floor never move. Only their strength changes. The sky
// keeps each one faintly alive, and sunlight adds to it as the sun nears the bore's line, losing a
// share at every bounce off the bore wall on the way down.
import * as THREE from 'three';

const MAX = 360, C = new THREE.Vector3(0, 73.5, 0), R = 67, SHELL = 8, WALL = 0.86, SKY = 0.1;

/** Must match bore_target in scripts/build_scene.py. */
function landing(d) {
  const h = Math.hypot(d.x, d.z) || 1, reach = 12 + 17 * (1 - d.y);
  return new THREE.Vector3((d.x / h) * reach, 14, (d.z / h) * reach);
}

export function makeSunshafts(holeBuffer) {
  const n = new Uint32Array(holeBuffer, 0, 1)[0], data = new Float32Array(holeBuffer, 4, n * 4), bores = [];
  for (let i = 0; i < n; i++) {
    const d = new THREE.Vector3().fromArray(data, i * 4), r = data[i * 4 + 3];
    if (r < 0.13) continue;                          // the faintest stars pass too little to see in the air
    const inner = d.clone().multiplyScalar(R).add(C), end = landing(d), axis = inner.clone().sub(end).normalize();
    bores.push({ inner, end, axis, r, length: SHELL / Math.max(0.3, axis.dot(d)) });
  }
  bores.sort((a, b) => b.r - a.r);
  bores.length = Math.min(bores.length, MAX);

  const pack = (geo, name, size, fill) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(bores.length * size), size); bores.forEach((b, i) => fill(a, i, b)); geo.setAttribute(name, a); return a; };

  const beams = new THREE.InstancedBufferGeometry();
  beams.copy(new THREE.CylinderGeometry(1, 1, 1, 10, 1, true).translate(0, 0.5, 0));
  beams.instanceCount = bores.length;
  pack(beams, 'from', 3, (a, i, b) => a.setXYZ(i, b.inner.x, b.inner.y, b.inner.z));
  pack(beams, 'to', 3, (a, i, b) => a.setXYZ(i, b.end.x, b.end.y, b.end.z));
  pack(beams, 'radius', 1, (a, i, b) => a.setX(i, b.r * 1.5));
  const beamGlow = pack(beams, 'glow', 1, () => {});
  const uniforms = { tint: { value: new THREE.Color() } };
  const column = new THREE.Mesh(beams, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.BackSide, uniforms,
    vertexShader: `attribute vec3 from, to; attribute float radius, glow; varying vec3 vWorld, vA, vB; varying float vR, vGlow, vAlong;
      void main(){ vec3 axis = normalize(to - from), u = normalize(cross(axis, vec3(0.31, 0.17, 0.93))), v = cross(axis, u);
        vec3 p = mix(from, to, position.y) + (u * position.x + v * position.z) * radius * 1.15;
        vWorld = p; vA = from; vB = to; vR = radius; vGlow = glow; vAlong = position.y; gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0); }`,
    fragmentShader: `uniform vec3 tint; varying vec3 vWorld, vA, vB; varying float vR, vGlow, vAlong;
      void main(){ vec3 d = normalize(vWorld - cameraPosition), ax = normalize(vB - vA), oc = cameraPosition - vA;
        float da = dot(d, ax), oa = dot(oc, ax), a = max(1.0 - da * da, 0.0001), b = dot(d, oc) - da * oa, c = dot(oc, oc) - oa * oa - vR * vR, h = b * b - a * c;
        if (h <= 0.0) discard;
        float edge = sqrt(h) / (a * vR);             // 1 down the middle of the column, 0 at its edge
        gl_FragColor = vec4(tint * edge * edge * vR * vGlow * (1.0 - 0.45 * vAlong) * 0.00042, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  }));
  column.frustumCulled = false;

  const discs = new THREE.InstancedBufferGeometry();
  discs.copy(new THREE.CircleGeometry(1, 24).rotateX(-Math.PI / 2));
  discs.instanceCount = bores.length;
  pack(discs, 'spot', 3, (a, i, b) => a.setXYZ(i, b.end.x, 14.015, b.end.z));
  pack(discs, 'radius', 2, (a, i, b) => a.setXY(i, (b.r * 1.5) / Math.max(b.axis.y, 0.3), b.r * 1.5));
  const poolGlow = pack(discs, 'glow', 1, () => {});
  const pools = new THREE.Mesh(discs, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms,
    vertexShader: `attribute vec3 spot; attribute vec2 radius; attribute float glow; varying vec2 vP; varying float vGlow;
      void main(){ vP = position.xz; vGlow = glow; vec2 out_ = normalize(spot.xz + 0.001), side = vec2(-out_.y, out_.x);
        vec2 q = out_ * position.x * radius.x + side * position.z * radius.y;
        gl_Position = projectionMatrix * viewMatrix * vec4(spot.x + q.x, spot.y, spot.z + q.y, 1.0); }`,
    fragmentShader: `uniform vec3 tint; varying vec2 vP; varying float vGlow;
      void main(){ float d = dot(vP, vP);
        gl_FragColor = vec4(tint * smoothstep(1.0, 0.55, d) * vGlow * 0.0028, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  }));
  pools.frustumCulled = false;

  const mesh = new THREE.Group();
  mesh.add(column, pools);
  return {
    mesh,
    update(sun, light) {
      bores.forEach((b, i) => {
        const cos = b.axis.dot(sun);
        let piped = 0;
        if (cos > 0.05) {
          const bounces = (b.length * Math.sqrt(1 - cos * cos)) / cos / (2 * b.r);
          piped = cos * WALL ** bounces;
        }
        const glow = SKY + piped;
        beamGlow.setX(i, glow); poolGlow.setX(i, glow);
      });
      beamGlow.needsUpdate = poolGlow.needsUpdate = true;
      uniforms.tint.value.copy(light.color).multiplyScalar(light.intensity);
    },
  };
}
