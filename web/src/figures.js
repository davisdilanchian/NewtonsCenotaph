// Visitors as paper cut-outs: Parisians of Boullée's own years, from the engraved plates of the
// Galerie des Modes et Costumes Français (1778–1787, Rijksmuseum, CC0), printed here in one ink.
// Each stands upright and turns to face you, as a figure cut from a print would be propped up, and
// is moved like a paper puppet: it rocks from foot to foot as it walks, its hem swinging behind,
// flips over to face the way it goes, bows, and leans back to look up. The sun throws its outline
// on the ground.
import * as THREE from 'three';

// how tall each plate's figure stands, hair and hat included, in metres
const HEIGHT = { '00': 2.05, '01': 1.95, '02': 2.15, '03': 1.85, '05': 1.8, '07': 1.95, '09': 1.85, '10': 1.8, '13': 2.0, '14': 1.95, '16': 2.05 };

// the puppet's pose, shared by the paper and its shadow: x across and y up the sheet, in world units
const POSE = `
  attribute vec4 at, pose, tone, still, rect; attribute vec2 ground;
  uniform float time;
  vec2 posed(vec2 p, out vec2 size) {
    size = still.xy;
    float v = p.y, seed = rect.x * 91.0 + rect.y * 37.0 + still.x * 13.0, walk = pose.y, bow = pose.z, face = still.w;
    float x = (p.x + 0.5 - still.z) * size.x, y = v * size.y;
    float s = sin(pose.x), c = cos(pose.x);
    x *= 1.0 + walk * 0.07 * cos(2.0 * pose.x) * (1.0 - smoothstep(0.0, 0.4, v));          // the stride opens and closes
    x += walk * 0.03 * size.y * sin(pose.x - 1.1) * smoothstep(0.0, 0.1, v) * (1.0 - smoothstep(0.14, 0.5, v));   // the hem swings behind
    float rock = walk * 0.05 * s + 0.007 * sin(time * 0.7 + seed);                         // from foot to foot
    y *= 1.0 + 0.005 * sin(time * 1.3 + seed) - 0.03 * bow;                      // breath, and the knees in a bow
    y += walk * abs(c) * 0.016 * size.y;
    float up = max(v - 0.46, 0.0) * size.y;                                                // above the waist: bowing, or leaning back to look up
    x += (bow * 0.46 * face + pose.w) * up + pose.w * y * 0.4;                              // one drawn in profile bows the way it faces,
    y -= bow * mix(0.2 * up, 0.5 * up * up / size.y + 0.06 * up, abs(face));               // one drawn from the front dips its head
    return vec2(x * cos(rock) - y * sin(rock), x * sin(rock) + y * cos(rock)) * vec2(at.w, 1.0);   // and the sheet turned over
  }`;

/**
 * n cut-outs drawn from the sheet. Each has a place, a pose and a light, set every frame by set().
 * pick(i) chooses the plate for the i-th.
 */
export function makeCutouts(sheet, places, n, { scale, rand, sun, pick }) {
  const at = new Float32Array(n * 4), pose = new Float32Array(n * 4), tone = new Float32Array(n * 4), ground = new Float32Array(n * 2);
  const still = new Float32Array(n * 4), rect = new Float32Array(n * 4), who = [];
  for (let i = 0; i < n; i++) {
    const p = pick ? pick(i) : places[Math.floor(rand() * places.length)], h = (HEIGHT[p.plate] * (0.94 + rand() * 0.08)) / scale;
    still.set([h * p.aspect, h, p.feet ?? 0.5, p.face ?? 0], i * 4);
    rect.set([p.u0, p.v0, p.u1, p.v1], i * 4);
    at[i * 4 + 3] = 1; tone.set([1, 1, 1, 1], i * 4);
    who.push({ face: p.face ?? 0, height: h, width: h * p.aspect, plate: p.plate });
  }
  const moving = [new THREE.InstancedBufferAttribute(at, 4), new THREE.InstancedBufferAttribute(pose, 4), new THREE.InstancedBufferAttribute(tone, 4), new THREE.InstancedBufferAttribute(ground, 2)];
  for (const a of moving) a.setUsage(THREE.DynamicDrawUsage);
  const fixed = [new THREE.InstancedBufferAttribute(still, 4), new THREE.InstancedBufferAttribute(rect, 4)];
  const geo = (base) => {
    const g = new THREE.InstancedBufferGeometry().copy(base);
    g.instanceCount = n;
    ['at', 'pose', 'tone', 'ground'].forEach((k, i) => g.setAttribute(k, moving[i]));
    g.setAttribute('still', fixed[0]); g.setAttribute('rect', fixed[1]);
    return g;
  };
  const time = { value: 0 };

  sheet.colorSpace = THREE.SRGBColorSpace;
  sheet.anisotropy = 4;
  const paper = new THREE.Mesh(geo(new THREE.PlaneGeometry(1, 1, 4, 12).translate(0, 0.5, 0)), new THREE.ShaderMaterial({
    fog: true, alphaToCoverage: true, side: THREE.DoubleSide, uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), map: { value: sheet }, time },
    vertexShader: `${POSE} varying vec2 vUv; varying vec3 vTone;
      #include <fog_pars_vertex>
      void main(){ vec3 e = cameraPosition - at.xyz; e.y = 0.0; vec3 right = normalize(vec3(e.z, 0.0, -e.x) + 1e-5);
        vec2 size, q = posed(position.xy, size);
        vec3 p = at.xyz + right * q.x + vec3(0.0, q.y, 0.0);
        vUv = vec2(mix(rect.x, rect.z, uv.x), mix(rect.y, rect.w, uv.y)); vTone = tone.rgb;
        vec4 mvPosition = viewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `uniform sampler2D map; varying vec2 vUv; varying vec3 vTone;
      #include <fog_pars_fragment>
      void main(){ vec4 c = texture2D(map, vUv);
        float a = clamp((c.a - 0.5) / max(fwidth(c.a), 1e-4) + 0.5, 0.0, 1.0);          // a clean cut edge at any distance
        if (a <= 0.0) discard;
        gl_FragColor = vec4(c.rgb * vTone, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  }));
  paper.frustumCulled = false;

  // The sun throws each one's own outline on the ground, sharp at the feet and softer toward the head,
  // laid along the slope it stands on. Under a roof there is only the dimness round the feet.
  const cast = new THREE.Mesh(geo(new THREE.PlaneGeometry(1, 1, 1, 6).translate(0, 0.5, 0)), new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    uniforms: { map: { value: sheet }, time, sun },
    vertexShader: `${POSE} uniform vec3 sun; varying vec2 vUv; varying float vDark, vUp;
      void main(){ vec3 e = cameraPosition - at.xyz; e.y = 0.0; vec3 right = normalize(vec3(e.z, 0.0, -e.x) + 1e-5);
        vec2 size, q = posed(position.xy, size);
        vec2 fall = -sun.xz / max(sun.y, 0.2);                                         // how far a unit of height throws
        vec2 off = right.xz * q.x + fall * q.y;
        vec3 p = at.xyz + vec3(off.x, 0.012 + dot(ground, off), off.y);
        vUv = vec2(mix(rect.x, rect.z, uv.x), mix(rect.y, rect.w, uv.y)); vUp = position.y;
        vDark = tone.a * 0.78 / (1.0 + 0.1 * length(fall));
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0); }`,
    fragmentShader: `uniform sampler2D map; varying vec2 vUv; varying float vDark, vUp;
      void main(){ float a = texture2D(map, vUv, 1.0 + 3.5 * vUp).a;
        gl_FragColor = vec4(0.02, 0.025, 0.04, smoothstep(0.25, 0.75, a) * vDark * (1.0 - 0.35 * vUp)); }`,
  }));
  cast.frustumCulled = false;

  const dim = new THREE.Mesh(geo(new THREE.PlaneGeometry(1, 1)), new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    vertexShader: `attribute vec4 at, tone, still; attribute vec2 ground; varying vec2 vP; varying float vDark;
      void main(){ vP = position.xy * 2.0; vec2 off = vec2(position.x * still.x * 1.1, position.y * still.x * 0.7); vDark = 0.34 - 0.14 * tone.a;
        gl_Position = projectionMatrix * viewMatrix * vec4(at.xyz + vec3(off.x, 0.01 + dot(ground, off), off.y), 1.0); }`,
    fragmentShader: `varying vec2 vP; varying float vDark; void main(){ float r = dot(vP, vP); gl_FragColor = vec4(0.0, 0.0, 0.0, vDark * (1.0 - smoothstep(0.2, 1.0, r))); }`,
  }));
  dim.frustumCulled = false;
  dim.renderOrder = 1; cast.renderOrder = 2;

  return {
    meshes: [paper, dim, cast],
    who,
    time,
    /** where i stands, which way up the sheet is turned (-1 to 1), and the slope under it */
    place(i, x, y, z, turned, sx, sz) { at[i * 4] = x; at[i * 4 + 1] = y; at[i * 4 + 2] = z; at[i * 4 + 3] = turned; ground[i * 2] = sx; ground[i * 2 + 1] = sz; },
    /** its stride (phase, and how fully it is walking), how deep a bow, and a lean along its own sheet */
    pose(i, phase, walk, bow, lean) { pose[i * 4] = phase; pose[i * 4 + 1] = walk; pose[i * 4 + 2] = bow; pose[i * 4 + 3] = lean; },
    /** the light on it, and how much direct sun, which is what casts its shadow */
    light(i, r, g, b, sunlit) { tone[i * 4] = r; tone[i * 4 + 1] = g; tone[i * 4 + 2] = b; tone[i * 4 + 3] = sunlit; },
    moved() { for (const a of moving) a.needsUpdate = true; },
  };
}
