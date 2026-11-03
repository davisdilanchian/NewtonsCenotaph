// Visitors as paper cut-outs: Parisians of Boullée's own years, from the engraved plates of the
// Galerie des Modes et Costumes Français (1778–1787, Rijksmuseum, CC0), printed here in one ink.
// Each stands upright and turns to face you, as a figure cut from a print would be propped up.
// Some stand about; others walk, and move() carries them along.
import * as THREE from 'three';

// how tall each plate's figure stands, hair and hat included, in metres
const HEIGHT = { '00': 2.05, '01': 1.95, '02': 2.15, '03': 1.85, '05': 1.8, '07': 1.95, '09': 1.85, '10': 1.8, '13': 2.0, '14': 1.95, '16': 2.05 };

export function makeCutouts(sheet, places, spots, { scale, rand, light }) {
  const n = spots.length, at = new Float32Array(n * 3), size = new Float32Array(n * 2), rect = new Float32Array(n * 4), shade = new Float32Array(n);
  spots.forEach(([x, y, z, light], i) => {
    const p = places[Math.floor(rand() * places.length)], h = (HEIGHT[p.plate] * (0.94 + rand() * 0.08)) / scale, flip = rand() < 0.5;
    at.set([x, y, z], i * 3);
    size.set([h * p.aspect, h], i * 2);
    rect.set(flip ? [p.u1, p.v0, p.u0, p.v1] : [p.u0, p.v0, p.u1, p.v1], i * 4);
    shade[i] = light;
  });
  const moving = [];
  const geo = (base) => {
    const g = new THREE.InstancedBufferGeometry().copy(base);
    g.instanceCount = n;
    g.setAttribute('at', new THREE.InstancedBufferAttribute(at, 3));
    g.setAttribute('shade', new THREE.InstancedBufferAttribute(shade, 1));
    moving.push(g.attributes.at, g.attributes.shade);
    g.setAttribute('size', new THREE.InstancedBufferAttribute(size, 2));
    g.setAttribute('rect', new THREE.InstancedBufferAttribute(rect, 4));
    return g;
  };

  sheet.colorSpace = THREE.SRGBColorSpace;
  sheet.anisotropy = 4;
  const paper = new THREE.Mesh(geo(new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0)), new THREE.ShaderMaterial({
    fog: true, uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), map: { value: sheet }, light },
    vertexShader: `attribute vec3 at; attribute vec2 size; attribute vec4 rect; attribute float shade; varying vec2 vUv; varying float vShade;
      #include <fog_pars_vertex>
      void main(){ vec3 e = cameraPosition - at; e.y = 0.0; vec3 right = normalize(vec3(e.z, 0.0, -e.x) + 1e-5);
        vec3 p = at + right * position.x * size.x + vec3(0.0, position.y * size.y, 0.0);
        vUv = vec2(mix(rect.x, rect.z, uv.x), mix(rect.y, rect.w, uv.y)); vShade = shade;
        vec4 mvPosition = viewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `uniform sampler2D map; uniform float light; varying vec2 vUv; varying float vShade;
      #include <fog_pars_fragment>
      void main(){ vec4 c = texture2D(map, vUv); if (c.a < 0.5) discard;
        gl_FragColor = vec4(c.rgb * vShade * light, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  }));
  paper.frustumCulled = false;

  // a soft shadow on the ground at each one's feet, so they stand rather than float
  const shadow = new THREE.Mesh(geo(new THREE.PlaneGeometry(1, 1)), new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    vertexShader: `attribute vec3 at; attribute vec2 size; varying vec2 vP;
      void main(){ vP = position.xy * 2.0; gl_Position = projectionMatrix * viewMatrix * vec4(at + vec3(position.x * size.x * 1.1, 0.01, position.y * size.x * 0.7), 1.0); }`,
    fragmentShader: `varying vec2 vP; void main(){ float r = dot(vP, vP); gl_FragColor = vec4(0.0, 0.0, 0.0, 0.32 * (1.0 - smoothstep(0.2, 1.0, r))); }`,
  }));
  shadow.frustumCulled = false;
  return {
    meshes: [paper, shadow],
    move(i, x, y, z, light) { at[i * 3] = x; at[i * 3 + 1] = y; at[i * 3 + 2] = z; shade[i] = light; },
    moved() { for (const a of moving) a.needsUpdate = true; },
  };
}
