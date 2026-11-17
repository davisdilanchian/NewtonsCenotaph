// The picture after the scene is drawn: the scene goes to a floating-point image first, so a flame,
// a star or the sky can be far brighter than white, and that brightness spreads a little into what is
// round it, as it does in an eye or a lens. Then one pass sets the exposure, darkens the corners
// slightly, and adds a grain finer than a grey level, which keeps the dark vault from banding.
import * as THREE from 'three';

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
  const image = (w, h, samples = 0, depthBuffer = false) => new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples, depthBuffer, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter });

  const target = image(2, 2, 4, true), levels = Array.from({ length: LEVELS }, () => image(2, 2));
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
  const final = pass(`uniform sampler2D scene, spread; uniform float amount, time; varying vec2 vUv;
    void main(){ vec3 c = texture2D(scene, vUv).rgb;
      c = mix(c, texture2D(spread, vUv).rgb * ${(1 / LEVELS).toFixed(3)}, amount);
      vec2 q = vUv - 0.5; c *= 1.0 - 0.34 * smoothstep(0.25, 0.95, dot(q, q) * 2.0);
      gl_FragColor = vec4(c, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      float g = dot(gl_FragColor.rgb, vec3(0.299, 0.587, 0.114));
      gl_FragColor.rgb = mix(vec3(g), gl_FragColor.rgb, 1.06);
      float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy + fract(time) * vec2(37.0, 17.0), vec2(0.06711056, 0.00583715))));
      gl_FragColor.rgb += (n - 0.5) / 160.0; }`,
    { scene: { value: target.texture }, spread: { value: levels[0].texture }, amount: { value: 0.07 }, time: { value: 0 } }, { toneMapped: true });

  const size = new THREE.Vector2();
  const draw = (material, to) => { quad.material = material; renderer.setRenderTarget(to); renderer.render(stage, flat); };
  const post = {
    target,
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
    },
    render(scene, camera, time = 0) {
      if (!post.on) { renderer.setRenderTarget(null); renderer.render(scene, camera); return; }
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.autoClear = false;                    // every pass covers its whole image, and the way up adds to what is there
      if (post.glow) {
        let from = target;
        levels.forEach((l, i) => { src.value = from.texture; texel.value.set(0.5 / from.width, 0.5 / from.height); first.value = i ? 0 : 1; draw(down, l); from = l; });
        for (let i = LEVELS - 1; i > 0; i--) { src.value = levels[i].texture; texel.value.set(1 / levels[i].width, 1 / levels[i].height); draw(up, levels[i - 1]); }
      }
      final.uniforms.amount.value = post.glow ? 0.07 : 0;
      final.uniforms.time.value = time;
      draw(final, null);
      renderer.autoClear = true;
    },
  };
  post.setSize();
  return post;
}
