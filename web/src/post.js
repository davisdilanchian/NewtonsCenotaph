// The picture after the scene is drawn: the scene goes to a floating-point image first, so a flame,
// a star or the sky can be far brighter than white, and that brightness spreads a little into what is
// round it, as it does in an eye or a lens. Then one pass sets the exposure, darkens the corners
// slightly, and adds a grain finer than a grey level, which keeps the dark vault from banding.
// Where the machine can afford it, the sky's light is dimmed in corners and crevices as it is in fact:
// ambient occlusion. The stone and ground are first drawn as depth alone at half size; from that each
// pixel finds how much of the sky above its surface the surfaces round it hide (the horizon-based
// method of Jimenez et al., GTAO), the speckle of its few samples is smoothed without crossing edges,
// and the stone then reads it as it is drawn, dimming only its light from the sky, never the sun's.
import * as THREE from 'three';
import { SHADE, OCCLUDERS } from './util.js';

const VERT = 'varying vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }';
const LEVELS = 5;

export function makePost(renderer) {
  // without a float colour buffer the scene is drawn straight to the screen, as it always could be
  const ok = renderer.capabilities.isWebGL2 !== false && (renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float'));
  if (!ok) return { target: null, on: false, glow: false, set() {}, setSize() {}, render(scene, camera) { renderer.setRenderTarget(null); renderer.render(scene, camera); } };

  const tri = new THREE.BufferGeometry();
  tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const quad = new THREE.Mesh(tri), flat = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), stage = new THREE.Scene();
  quad.frustumCulled = false;
  stage.add(quad);
  const pass = (fragmentShader, uniforms, extra = {}) => new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false, toneMapped: false, ...extra });
  const image = (w, h, samples = 0, depthBuffer = false) => new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples, depthBuffer, stencilBuffer: depthBuffer, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter });

  const target = image(2, 2, 4, true), levels = Array.from({ length: LEVELS }, () => image(2, 2));
  const deep = new THREE.WebGLRenderTarget(2, 2, { depthBuffer: true });
  deep.depthTexture = new THREE.DepthTexture(2, 2, THREE.FloatType);
  const rough = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter }), shade = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter });
  const eye = new THREE.PerspectiveCamera(), solid = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
  const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); white.needsUpdate = true;
  SHADE.map.value = white;
  const view = { proj: { value: new THREE.Matrix4() }, projInv: { value: new THREE.Matrix4() } }, reversed = { value: 0 }, depthTexel = { value: new THREE.Vector2() };
  const AT = `uniform sampler2D depth; uniform mat4 proj, projInv; uniform float reversed; uniform vec2 texel; varying vec2 vUv;
    bool open(float d) { return reversed > 0.5 ? d <= 0.0 : d >= 1.0; }
    vec3 at(vec2 uv, float d) { vec4 v = projInv * vec4(uv * 2.0 - 1.0, reversed > 0.5 ? d : d * 2.0 - 1.0, 1.0); return v.xyz / v.w; }
    vec3 at(vec2 uv) { return at(uv, texture2D(depth, uv).r); }`;
  // two slices through the hemisphere over each point, each walked both ways out to RADIUS, turned and
  // offset per pixel in a pattern four pixels square that the smoothing below then averages away
  const RADIUS = 8.0;                               // metres of the model: a storey of the cenotaph, twenty-four at the walker's scale (util.js)
  const occlusion = pass(`${AT}
    const float PI = 3.14159265, HALF = 1.5707963;
    void main() {
      float d = texture2D(depth, vUv).r;
      if (open(d)) { gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0); return; }
      vec3 p = at(vUv, d), v = normalize(-p);
      // the surface's slope from whichever neighbour each way lies nearer it, so an edge doesn't bend it
      vec3 l = at(vUv - vec2(texel.x, 0.0)), r = at(vUv + vec2(texel.x, 0.0)), b = at(vUv - vec2(0.0, texel.y)), t = at(vUv + vec2(0.0, texel.y));
      vec3 n = normalize(cross(abs(r.z - p.z) < abs(p.z - l.z) ? r - p : p - l, abs(t.z - p.z) < abs(p.z - b.z) ? t - p : p - b));
      if (dot(n, v) < 0.0) n = -n;
      float across = ${RADIUS.toFixed(2)} * proj[1][1] * 0.5 / (-p.z * texel.y);     // the radius in pixels at this depth
      if (across < 1.5) { gl_FragColor = vec4(1.0, -p.z, 0.0, 1.0); return; }
      across = min(across, 0.3 / texel.y);
      vec2 cell = mod(floor(gl_FragCoord.xy), 4.0);
      float turn = (cell.x + cell.y * 4.0) * 0.0625, jitter = fract(turn * 7.0 + 0.5 * mod(cell.x + cell.y, 2.0) + 0.125);
      float seen = 0.0;
      for (int k = 0; k < 2; k++) {
        float phi = (float(k) + turn) * 0.5 * PI;
        vec2 omega = vec2(cos(phi), sin(phi));
        vec3 dir = vec3(omega, 0.0), ortho = dir - dot(dir, v) * v, axis = normalize(cross(ortho, v));
        vec3 pn = n - axis * dot(n, axis);
        float pl = length(pn), cn = clamp(dot(pn, v) / pl, 0.0, 1.0), na = sign(dot(ortho, pn)) * acos(cn);
        float low0 = cos(na + HALF), low1 = cos(na - HALF), h0 = low0, h1 = low1;
        for (int j = 0; j < 5; j++) {
          float s = (float(j) + jitter) / 5.0; s = s * s * across + 1.0;
          vec2 off = omega * s * texel, u0 = (floor((vUv + off) / texel) + 0.5) * texel, u1 = (floor((vUv - off) / texel) + 0.5) * texel;   // at pixel centres, where their depths are
          float d0 = texture2D(depth, u0).r, d1 = texture2D(depth, u1).r;
          vec3 e0 = at(u0, d0) - p, e1 = at(u1, d1) - p;
          float l0 = length(e0), l1 = length(e1);
          float w0 = open(d0) ? 0.0 : clamp((1.0 - l0 / ${RADIUS.toFixed(2)}) / 0.6, 0.0, 1.0), w1 = open(d1) ? 0.0 : clamp((1.0 - l1 / ${RADIUS.toFixed(2)}) / 0.6, 0.0, 1.0);
          h0 = max(h0, mix(low0, dot(e0 / l0, v), w0)); h1 = max(h1, mix(low1, dot(e1 / l1, v), w1));
        }
        float a0 = na + clamp(-acos(h1) - na, -HALF, HALF), a1 = na + clamp(acos(h0) - na, -HALF, HALF);
        seen += pl * 0.25 * ((cn + 2.0 * a0 * sin(na) - cos(2.0 * a0 - na)) + (cn + 2.0 * a1 * sin(na) - cos(2.0 * a1 - na)));
      }
      gl_FragColor = vec4(pow(clamp(seen * 0.5, 0.0, 1.0), 2.0), -p.z, 0.0, 1.0); }   // squared, as GTAO's authors do, for the light that corners also lose between their own walls`, { depth: { value: deep.depthTexture }, proj: view.proj, projInv: view.projInv, reversed, texel: depthTexel });
  // smoothed over the four-pixel pattern, weighing each neighbour by how near its depth is to the
  // surface's own plane there, so ground seen at a slant is smoothed along with its slope, but the
  // shade of a near edge doesn't bleed onto the far wall behind it; and a little light still comes
  // into a corner off its own pale walls, which keeps the deepest shade from going black
  const settle = pass(`uniform sampler2D src; uniform vec2 texel; varying vec2 vUv;
    void main() {
      vec2 c = texture2D(src, vUv).rg;
      if (c.y <= 0.0) { gl_FragColor = vec4(1.0); return; }
      float l = texture2D(src, vUv - vec2(texel.x, 0.0)).g, r = texture2D(src, vUv + vec2(texel.x, 0.0)).g;
      float b = texture2D(src, vUv - vec2(0.0, texel.y)).g, t = texture2D(src, vUv + vec2(0.0, texel.y)).g;
      vec2 slope = vec2(abs(r - c.y) < abs(c.y - l) ? r - c.y : c.y - l, abs(t - c.y) < abs(c.y - b) ? t - c.y : c.y - b);
      float sum = 0.0, wt = 0.0;
      for (int y = -2; y < 2; y++) for (int x = -2; x < 2; x++) {
        vec2 o = texture2D(src, vUv + vec2(x, y) * texel).rg;
        float w = o.y > 0.0 ? max(0.0, 1.0 - abs(o.y - c.y - dot(vec2(x, y), slope)) / (0.01 * c.y + 0.02)) : 0.0;
        sum += o.x * w; wt += w;
      }
      float a = wt > 0.0 ? sum / wt : c.x, k = 0.3;                     // k: the walls' own paleness, for the light they pass on
      a = max(a, ((a * (2.04 * k - 0.33) + (-4.8 * k + 0.64)) * a + (2.75 * k + 0.69)) * a);
      gl_FragColor = vec4(vec3(a), 1.0); }`, { src: { value: rough.texture }, texel: { value: new THREE.Vector2() } });
  const src = { value: null }, texel = { value: new THREE.Vector2() }, first = { value: 0 };
  // down: each level is the one above at half the size, through a soft 4-tap box; the first weighs
  // each tap down by its own brightness, so one glinting pixel does not flicker across the picture
  const down = pass(`uniform sampler2D src; uniform vec2 texel; uniform float first; varying vec2 vUv;
    void main(){ vec3 a = texture2D(src, vUv + texel * vec2(-1.0, -1.0)).rgb, b = texture2D(src, vUv + texel * vec2(1.0, -1.0)).rgb,
                      c = texture2D(src, vUv + texel * vec2(-1.0, 1.0)).rgb, d = texture2D(src, vUv + texel * vec2(1.0, 1.0)).rgb;
      vec4 w = mix(vec4(1.0), 1.0 / (1.0 + vec4(dot(a, vec3(0.3)), dot(b, vec3(0.3)), dot(c, vec3(0.3)), dot(d, vec3(0.3)))), first);
      gl_FragColor = vec4(min((a * w.x + b * w.y + c * w.z + d * w.w) / (w.x + w.y + w.z + w.w), vec3(60.0)), 1.0); }`, { src, texel, first });
  // up: each level is added, through a tent, onto the one above it
  const up = pass(`uniform sampler2D src; uniform vec2 texel; varying vec2 vUv;
    void main(){ vec3 s = texture2D(src, vUv).rgb * 4.0;
      s += (texture2D(src, vUv + texel * vec2(-1.0, 0.0)).rgb + texture2D(src, vUv + texel * vec2(1.0, 0.0)).rgb + texture2D(src, vUv + texel * vec2(0.0, -1.0)).rgb + texture2D(src, vUv + texel * vec2(0.0, 1.0)).rgb) * 2.0;
      s += texture2D(src, vUv + texel * vec2(-1.0, -1.0)).rgb + texture2D(src, vUv + texel * vec2(1.0, -1.0)).rgb + texture2D(src, vUv + texel * vec2(-1.0, 1.0)).rgb + texture2D(src, vUv + texel * vec2(1.0, 1.0)).rgb;
      gl_FragColor = vec4(s / 16.0, 1.0); }`, { src, texel }, { blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation });
  const final = pass(`uniform sampler2D scene, spread, shade; uniform float amount, time, shadeView; varying vec2 vUv;
    void main(){ vec3 c = texture2D(scene, vUv).rgb;
      if (shadeView > 0.5) c = texture2D(shade, vUv).rgb * 0.5;
      c = mix(c, texture2D(spread, vUv).rgb * ${(1 / LEVELS).toFixed(3)}, amount);
      vec2 q = vUv - 0.5; c *= 1.0 - 0.34 * smoothstep(0.25, 0.95, dot(q, q) * 2.0);
      gl_FragColor = vec4(c, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      float g = dot(gl_FragColor.rgb, vec3(0.299, 0.587, 0.114));
      gl_FragColor.rgb = mix(vec3(g), gl_FragColor.rgb, 0.94 * mix(0.35, 1.0, smoothstep(0.03, 0.3, g)));   // as on film, the deepest shade loses its colour
      gl_FragColor.rgb = gl_FragColor.rgb * gl_FragColor.rgb / (gl_FragColor.rgb + 0.035) * 1.035;   // and a toe, so the dark vault reads black
      gl_FragColor.rgb += mix(vec3(-0.012, 0.0, 0.016), vec3(0.022, 0.008, -0.022), smoothstep(0.2, 0.8, g)) * smoothstep(0.02, 0.18, g);   // a print's split: cool shade, warm light; black stays black
      float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy + fract(time) * vec2(37.0, 17.0), vec2(0.06711056, 0.00583715))));
      gl_FragColor.rgb += (n - 0.5) * (1.0 / 160.0 + 0.022 * g * (1.0 - g)); }`,
    { scene: { value: target.texture }, spread: { value: levels[0].texture }, shade: { value: shade.texture }, shadeView: { value: new URLSearchParams(location.search).has('aoview') ? 1 : 0 }, amount: { value: 0.15 }, time: { value: 0 } }, { toneMapped: true });

  const size = new THREE.Vector2();
  const draw = (material, to) => { quad.material = material; renderer.setRenderTarget(to); renderer.render(stage, flat); };
  const post = {
    target, shade, rough,
    on: true,                                        // off, the scene goes straight to the screen: the plainest picture, for the weakest machines
    glow: true,                                      // the spread of light: the first thing to go on a machine that can't keep up
    set(on, glow, samples) {
      post.on = on; post.glow = glow;
      if (target.samples !== samples) { target.samples = samples; target.dispose(); }
      post.setSize();
    },
    setSize() {
      renderer.getDrawingBufferSize(size);
      target.setSize(size.x, size.y);
      let w = size.x, h = size.y;
      for (const l of levels) { w = Math.max(2, w >> 1); h = Math.max(2, h >> 1); l.setSize(w, h); }
      const w2 = Math.max(2, size.x >> 1), h2 = Math.max(2, size.y >> 1);
      deep.setSize(w2, h2); rough.setSize(w2, h2); shade.setSize(w2, h2);
      depthTexel.value.set(1 / w2, 1 / h2); settle.uniforms.texel.value.set(1 / w2, 1 / h2);
      SHADE.texel.value.set(1 / size.x, 1 / size.y);
    },
    render(scene, camera, time = 0) {
      SHADE.on.value = 0;
      if (!post.on) { renderer.setRenderTarget(null); renderer.render(scene, camera); return; }
      if (post.glow) {                                // the machines that can spread light can also afford the shade in corners
        eye.copy(camera, false); eye.layers.set(OCCLUDERS);
        scene.overrideMaterial = solid;
        renderer.setRenderTarget(deep);
        renderer.render(scene, eye);
        scene.overrideMaterial = null;
        view.proj.value.copy(camera.projectionMatrix); view.projInv.value.copy(camera.projectionMatrixInverse);
        reversed.value = renderer.state.buffers.depth.getReversed() ? 1 : 0;
        draw(occlusion, rough);
        draw(settle, shade);
        SHADE.map.value = shade.texture; SHADE.on.value = 1;
      }
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.autoClear = false;                    // every pass covers its whole image, and the way up adds to what is there
      if (post.glow) {
        let from = target;
        levels.forEach((l, i) => { src.value = from.texture; texel.value.set(0.5 / from.width, 0.5 / from.height); first.value = i ? 0 : 1; draw(down, l); from = l; });
        for (let i = LEVELS - 1; i > 0; i--) { src.value = levels[i].texture; texel.value.set(1 / levels[i].width, 1 / levels[i].height); draw(up, levels[i - 1]); }
      }
      final.uniforms.amount.value = post.glow ? 0.15 : 0;
      final.uniforms.time.value = time;
      draw(final, null);
      renderer.autoClear = true;
    },
  };
  post.setSize();
  return post;
}
