// Daylight in the void. Each bore is a long light pipe aimed at the sarcophagus: whatever enters can
// only leave along its axis, so its column never moves and all of them meet on the tomb. Only their strength changes. The sky
// keeps each one faintly alive, and sunlight adds to it as the sun nears the bore's line, losing a
// share at every bounce off the bore wall on the way down.
import * as THREE from 'three';

const MAX = 360, C = new THREE.Vector3(0, 73.5, 0), R = 67, SHELL = 8, WALL = 0.86, SKY = 0.1;

const TOMB = new THREE.Vector3(0, 19, 0);            // must match bore_target in scripts/build_scene.py

export function makeSunshafts(holeBuffer) {
  const n = new Uint32Array(holeBuffer, 0, 1)[0], data = new Float32Array(holeBuffer, 4, n * 4), bores = [];
  for (let i = 0; i < n; i++) {
    const d = new THREE.Vector3().fromArray(data, i * 4), r = data[i * 4 + 3];
    if (r < 0.13) continue;                          // the faintest stars pass too little to see in the air
    const inner = d.clone().multiplyScalar(R).add(C), end = TOMB, axis = inner.clone().sub(end).normalize();
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
        float meet = 1.0 - 0.8 * smoothstep(0.5, 1.0, vAlong);   // they overlap as they converge: each gives way so the sum stays gentle
        gl_FragColor = vec4(tint * edge * edge * vR * vGlow * meet * 0.006, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  }));
  column.frustumCulled = false;

  // every opening glows with the daylight coming through it, however faint its star
  const seen = new THREE.BufferGeometry(), at = new Float32Array(n * 3), size = new Float32Array(n), d = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    d.fromArray(data, i * 4).multiplyScalar(R - 1).add(C);
    at.set([d.x, d.y, d.z], i * 3);
    size[i] = data[i * 4 + 3];
  }
  seen.setAttribute('position', new THREE.BufferAttribute(at, 3));
  seen.setAttribute('size', new THREE.BufferAttribute(size, 1));
  const scale = { value: 800 };
  const glows = new THREE.Points(seen, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { scale },
    vertexShader: `attribute float size; uniform float scale; varying float vBright;
      void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = clamp(size * 9.0 * scale / -mv.z, 7.0, 46.0);
        vBright = 0.35 + 1.5 * size; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `varying float vBright;
      void main(){ float d = length(gl_PointCoord - 0.5) * 2.0, core = exp(-d * d * 26.0), halo = exp(-d * d * 5.0) * (1.0 - d);
        gl_FragColor = vec4(vec3(0.82, 0.9, 1.0) * (core * 1.5 + max(halo, 0.0) * 0.3) * vBright, 1.0); }`,
  }));
  glows.frustumCulled = false;

  const mesh = new THREE.Group();
  mesh.add(column, glows);
  return {
    mesh,
    scale,
    update(sun, light) {
      let total = 0;
      bores.forEach((b, i) => {
        const cos = b.axis.dot(sun);
        let piped = 0;
        if (cos > 0.05) {
          const bounces = (b.length * Math.sqrt(1 - cos * cos)) / cos / (2 * b.r);
          piped = cos * WALL ** bounces;
        }
        const glow = SKY + piped;
        beamGlow.setX(i, glow);
        total += glow * b.r * b.r;
      });
      beamGlow.needsUpdate = true;
      uniforms.tint.value.copy(light.color).multiplyScalar(light.intensity);
      return total;                                  // what reaches the tomb, in units of bore area
    },
  };
}
