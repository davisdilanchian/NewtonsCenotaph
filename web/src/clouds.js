// Clouds with depth. A flat picture of noise on the sky reads as a smear, so these are a layer of real
// volume a kilometre and a half up: cumulus with level bases that billow upward where their plan is
// thicker, marched through along each line of sight and lit by how much cloud lies between each part
// and the sun. That is far too much to work out for every pixel of sky on every frame, and clouds
// change slowly, so they are painted into a picture of the whole dome a few rows a frame; the sky then
// only looks its clouds up. Each finished picture fades in over the one before it, so their drift on
// the wind and the turning of their light show no steps.
import * as THREE from 'three';

const VERT = 'varying vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }';
export const DOME = 2.04;                         // the dome is laid flat as a disc: uv = 0.5 + direction.xz / (1 + direction.y) / DOME
const FRAG = (steps) => `uniform vec3 sun; uniform float time, coverage, seed; varying vec2 vUv;
  const float BASE = 1.5, THICK = 1.7;            // kilometres: the clouds' level bases, and the tallest of them
  float h1(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
  float n2(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h1(i), h1(i + vec2(1, 0)), f.x), mix(h1(i + vec2(0, 1)), h1(i + vec2(1, 1)), f.x), f.y); }
  float h3(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
  float n3(vec3 p) { vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(h3(i), h3(i + vec3(1, 0, 0)), f.x), mix(h3(i + vec3(0, 1, 0)), h3(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(h3(i + vec3(0, 0, 1)), h3(i + vec3(1, 0, 1)), f.x), mix(h3(i + vec3(0, 1, 1)), h3(i + vec3(1, 1, 1)), f.x), f.y), f.z); }
  // the clouds in plan: above zero where a column of cloud stands, and greater the taller it is
  float plan(vec2 xz) {
    vec2 q = mat2(0.8, -0.6, 0.6, 0.8) * xz * 0.66 + vec2(0.008, 0.003) * time;
    q += 0.6 * vec2(n2(q * 0.7 + 3.1), n2(q * 0.7 + 7.7)) - 0.3;
    float f = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { f += a * n2(q); q = mat2(0.8, 0.6, -0.6, 0.8) * q * 2.03; a *= 0.5; }
    return f - mix(0.74, 0.46, coverage) - (0.5 - n2(xz * 0.07 + 5.0)) * 0.16;      // open sky here, banks of cloud there
  }
  // its broad form: a level base, and a top that rises with the column
  float form(vec3 p) {
    float hn = (p.y - BASE) / THICK;
    if (hn <= 0.0 || hn >= 1.0) return 0.0;
    float col = plan(p.xz);
    if (col <= 0.0) return 0.0;
    float top = min(sqrt(col * 3.2), 1.0) * 0.8;      // domed, not peaked: it rises fast at a cloud's edge and levels toward its middle
    if (top < 0.1) return 0.0;                        // and a column barely there has no height, so no veil hangs between the clouds
    return smoothstep(0.0, 0.05, col) * smoothstep(0.0, 0.1, hn) * (1.0 - smoothstep(top * 0.5, top, hn));
  }
  // and its surface, eaten into billows
  float billows(vec3 p, float d) {
    vec3 q = p * 2.6 + vec3(0.0, -0.03 * time, 0.0);
    float e = (0.55 * n3(q) + 0.3 * n3(q * 2.7 + 5.0) + 0.15 * n3(q * 6.1 + 9.0)) * 0.62;
    return clamp((d - e) / (1.0 - e), 0.0, 1.0);
  }
  void main() {
    vec2 p = (vUv - 0.5) * ${DOME.toFixed(2)};
    float r2 = dot(p, p), dy = (1.0 - r2) / (1.0 + r2), low = smoothstep(0.03, 0.13, dy);                 // the farthest of them are lost in the haze at the horizon
    if (low <= 0.0) { gl_FragColor = vec4(0.0); return; }
    vec3 d = vec3(p.x * (1.0 + dy), dy, p.y * (1.0 + dy));
    // Long strides through the open air, and short ones wherever there is cloud: on meeting one the
    // march goes back a stride and comes on again finely, so a cloud's face is found to within a short
    // step. Where each pixel starts differs, which turns what steps remain into a grain the sky smooths.
    float t0 = BASE / dy, far = t0 + THICK / dy, stride = THICK / dy / ${(steps / 3.2).toFixed(1)}, step = stride / 4.0;
    float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy + seed * 5.588, vec2(0.06711056, 0.00583715))));
    float t = t0 + stride * jitter, fineTo = -1.0, through = 1.0, lit = 0.0, sky = 0.0;
    for (int i = 0; i < ${steps}; i++) {
      if (t >= far) break;
      vec3 q = d * t;
      float dn = form(q);
      if (dn <= 0.0) { t += t < fineTo ? step : stride; continue; }
      if (t >= fineTo) { fineTo = t + step; t = max(t0, t - stride + step * jitter); continue; }
      fineTo = t + 2.5 * step;
      t += step;
      dn = billows(q, dn);
      if (dn <= 0.01) continue;
      float before = form(q + sun * 0.07) * 0.1 + form(q + sun * 0.2) * 0.16 + form(q + sun * 0.45) * 0.3;      // the cloud between here and the sun
      float a = 1.0 - exp(-dn * step * 18.0);
      lit += through * a * (0.75 * exp(-before * 9.0) + 0.25 * exp(-before * 2.0));    // the sun straight through, and what the cloud scatters round
      sky += through * a * mix(0.42, 1.0, clamp((q.y - BASE) / THICK * 1.6, 0.0, 1.0));  // the sky's light, less at the base
      through *= 1.0 - a;
      if (through < 0.02) break;
    }
    // cirrus, far above: a thin sheet combed into streaks
    vec2 high = d.xz * (8.0 / max(dy, 0.06)) + vec2(0.02, 0.006) * time, streak = vec2(high.x * 0.1 + high.y * 0.06, high.y * 0.8 - high.x * 0.1);
    float s = 0.5 * n2(streak) + 0.3 * n2(streak * 2.1 + 3.0) + 0.2 * n2(streak * 4.3 + 7.0);
    float cirrus = smoothstep(0.52, 0.85, s) * smoothstep(0.5, 0.75, n2(high * 0.05 + 11.0)) * 0.22;
    gl_FragColor = vec4(lit, sky, cirrus, 1.0 - through) * low;
  }`;

export function makeClouds(renderer) {
  const tri = new THREE.BufferGeometry();
  tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const uniforms = { sun: { value: new THREE.Vector3(0, 1, 0) }, time: { value: 0 }, coverage: { value: 0.3 }, seed: { value: 0 } };
  const quad = new THREE.Mesh(tri, null), stage = new THREE.Scene(), flat = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  quad.frustumCulled = false;
  stage.add(quad);
  const picture = (size) => new THREE.WebGLRenderTarget(size, size, { depthBuffer: false, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter, generateMipmaps: false });
  let size = 0, rows = 96, pictures = [], shown = [0, 0], next = 1, row = 0, baked = false;
  const taken = { sun: new THREE.Vector3(), time: 0 }, lit = new THREE.Vector3();   // the sun and the moment the picture being painted is of
  const paint = (to, from, count) => {
    const was = renderer.getRenderTarget(), clear = renderer.autoClear;
    const y0 = Math.floor(from * size / rows), y1 = Math.floor((from + count) * size / rows);
    to.scissorTest = true; to.scissor.set(0, y0, size, y1 - y0);
    uniforms.sun.value.copy(taken.sun); uniforms.time.value = taken.time;
    renderer.autoClear = true;
    renderer.setRenderTarget(to); renderer.render(stage, flat);
    renderer.setRenderTarget(was); renderer.autoClear = clear;
  };
  const clouds = {
    a: { value: null }, b: { value: null }, fade: { value: 1 }, texel: { value: 1 / 1536 },         // the sky shows a fading into b
    /** The size of the picture and how finely it is marched and how many frames it is spread over: less of each on a weaker machine. */
    setSize(n, steps, frames) {
      if (n === size) return;
      for (const p of pictures) p.dispose();
      quad.material?.dispose();
      quad.material = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG(steps), uniforms, depthTest: false, depthWrite: false, toneMapped: false });
      size = n; rows = frames; clouds.texel.value = 1 / n; pictures = [picture(n), picture(n), picture(n)]; baked = false;
    },
    /** Paint the whole sky at once, for the first frame and for a jump of the sun. */
    whole(sun, time) {
      taken.sun.copy(sun); taken.time = time; lit.copy(sun);
      paint(pictures[0], 0, rows);
      shown = [0, 0]; next = 1; row = 0; baked = true;
      clouds.a.value = clouds.b.value = pictures[0].texture; clouds.fade.value = 1;
    },
    /** A few rows more of the next picture, each frame. */
    update(sun, time) {
      if (!baked || lit.angleTo(sun) > 0.8) { clouds.whole(sun, time); return; }
      if (row === 0) { taken.sun.copy(sun); taken.time = time; uniforms.seed.value = (uniforms.seed.value + 1) % 16; }
      paint(pictures[next], row, 1);
      row++;
      clouds.fade.value = Math.min(1, row / rows);
      if (row >= rows) {                             // done: it becomes the picture faded toward, and the oldest is painted over next
        lit.copy(taken.sun);
        const spare = [0, 1, 2].find((k) => k !== next && k !== shown[1]);
        shown = [shown[1], next]; next = spare; row = 0;
        clouds.a.value = pictures[shown[0]].texture; clouds.b.value = pictures[shown[1]].texture; clouds.fade.value = 0;
      }
    },
  };
  clouds.setSize(1536, 72, 96);
  return clouds;
}
