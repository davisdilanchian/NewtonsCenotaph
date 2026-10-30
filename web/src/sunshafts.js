// Sunlight in the air of the void. For the sun's present direction each bore is tested as the real
// tapering hole it is, and the light that gets through is drawn as a cylinder whose brightness at
// each pixel is the exact length of the view ray inside it. No sampling, so no noise.
import * as THREE from 'three';

const MAX = 220, C = new THREE.Vector3(0, 73.5, 0), R = 67, SHELL = 8;

export function makeSunshafts(holeBuffer, eye) {
  const n = new Uint32Array(holeBuffer, 0, 1)[0], data = new Float32Array(holeBuffer, 4, n * 4);
  const bores = [];
  for (let i = 0; i < n; i++) {
    const d = new THREE.Vector3().fromArray(data, i * 4), r = data[i * 4 + 3];
    const inner = d.clone().multiplyScalar(R).add(C), axis = inner.clone().sub(eye).normalize();
    const length = SHELL / Math.max(0.3, axis.dot(d));
    bores.push({ inner, axis, length, inR: r * 2.2, outR: Math.max(r * (2.2 - 0.164 * length), 0.02), outer: inner.clone().addScaledVector(axis, length) });
  }

  const geo = new THREE.InstancedBufferGeometry();
  geo.copy(new THREE.CylinderGeometry(1, 1, 1, 10, 1, true).translate(0, 0.5, 0));
  geo.instanceCount = 0;
  const attr = (name, size) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(MAX * size), size); a.setUsage(THREE.DynamicDrawUsage); geo.setAttribute(name, a); return a; };
  const from = attr('from', 3), to = attr('to', 3), shape = attr('shape', 2);
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.BackSide,
    uniforms: { sun: { value: new THREE.Vector3() }, tint: { value: new THREE.Color() } },
    vertexShader: `attribute vec3 from, to; attribute vec2 shape; varying vec3 vWorld, vA, vB; varying vec2 vShape;
      void main(){ vec3 axis = normalize(to - from), u = normalize(cross(axis, vec3(0.31, 0.17, 0.93))), v = cross(axis, u);
        vec3 p = mix(from, to, position.y) + (u * position.x + v * position.z) * shape.x * 1.15;
        vWorld = p; vA = from; vB = to; vShape = shape; gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0); }`,
    fragmentShader: `uniform vec3 sun, tint; varying vec3 vWorld, vA, vB; varying vec2 vShape;
      void main(){ vec3 d = normalize(vWorld - cameraPosition), ax = normalize(vB - vA), oc = cameraPosition - vA;
        float da = dot(d, ax), oa = dot(oc, ax), a = max(1.0 - da * da, 0.0001), b = dot(d, oc) - da * oa, c = dot(oc, oc) - oa * oa - vShape.x * vShape.x, h = b * b - a * c;
        if (h <= 0.0) discard;
        float chord = 2.0 * sqrt(h) / a, g = 0.5, mu = dot(d, sun), phase = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5);
        gl_FragColor = vec4(tint * chord * phase * vShape.y * 0.0065, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;

  const a = new THREE.Vector3(), b = new THREE.Vector3(), toward = new THREE.Vector3();
  return {
    mesh,
    update(sun, light) {
      let count = 0;
      for (const bore of bores) {
        const cos = bore.axis.dot(sun);
        if (cos < 0.9) continue;
        const shift = bore.length * Math.sqrt(1 - cos * cos) / cos, open = (bore.inR + bore.outR - shift) / (2 * bore.outR);
        if (open <= 0 || count >= MAX) continue;
        a.copy(bore.outer).addScaledVector(sun, -bore.length / cos);
        const reach = 2 * toward.subVectors(a, C).dot(sun);
        b.copy(a).addScaledVector(sun, -Math.max(reach, 1));
        if (b.y < 14) b.lerpVectors(a, b, (a.y - 14) / (a.y - b.y));
        from.setXYZ(count, a.x, a.y, a.z); to.setXYZ(count, b.x, b.y, b.z);
        shape.setXY(count, bore.outR, Math.min(open, 1));
        count++;
      }
      geo.instanceCount = count;
      from.needsUpdate = to.needsUpdate = shape.needsUpdate = true;
      material.uniforms.sun.value.copy(sun);
      material.uniforms.tint.value.copy(light.color).multiplyScalar(light.intensity);
      return count;
    },
  };
}
