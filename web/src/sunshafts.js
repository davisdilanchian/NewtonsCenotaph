// Sunlight in the air of the void. Each pixel's ray is marched through the sphere and tested
// against the sun's shadow map, so a shaft exists only where the sun really passes a bore.
import * as THREE from 'three';

const STEPS = 44;

export function makeSunshafts(renderer, sun, sunDir) {
  const target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false });
  const screen = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const plane = new THREE.PlaneGeometry(2, 2);
  const vertexShader = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

  const march = new THREE.ShaderMaterial({
    depthTest: false, depthWrite: false,
    uniforms: {
      tShadow: { value: null }, shadowMatrix: { value: new THREE.Matrix4() }, frame: { value: 0 },
      camPos: { value: new THREE.Vector3() }, invProj: { value: new THREE.Matrix4() }, camWorld: { value: new THREE.Matrix4() },
      sun: { value: sunDir }, tint: { value: new THREE.Color() },
    },
    vertexShader,
    fragmentShader: `precision highp float; precision highp sampler2DShadow;
      uniform sampler2DShadow tShadow; uniform mat4 shadowMatrix, invProj, camWorld; uniform vec3 camPos, sun, tint; uniform float frame;
      varying vec2 vUv;
      const vec3 C = vec3(0.0, 73.5, 0.0);
      void main(){
        vec4 v = invProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
        vec3 dir = normalize((camWorld * vec4(v.xyz / v.w, 0.0)).xyz);
        vec3 oc = camPos - C; float b = dot(oc, dir), c = dot(oc, oc) - 67.0 * 67.0, h = b * b - c;
        float end = h > 0.0 ? -b + sqrt(h) : 0.0;
        if (dir.y < 0.0) end = min(end, (9.5 - camPos.y) / dir.y);
        if (end <= 0.0) { gl_FragColor = vec4(0.0); return; }
        float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy + 5.588 * frame, vec2(0.06711056, 0.00583715))));
        float seen = 0.0, step = end / float(${STEPS});
        for (int i = 0; i < ${STEPS}; i++) {
          vec3 p = camPos + dir * (float(i) + noise) * step;
          vec4 s = shadowMatrix * vec4(p, 1.0);
          seen += texture(tShadow, vec3(s.xy / s.w, s.z / s.w - 0.00004));
        }
        float g = 0.55, mu = dot(dir, sun), phase = (1.0 - g * g) / (12.566 * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
        gl_FragColor = vec4(tint * seen * step * phase * 0.016, 1.0);
      }`,
  });
  const marchScene = new THREE.Scene();
  const marchQuad = new THREE.Mesh(plane, march); marchQuad.frustumCulled = false;
  marchScene.add(marchQuad);

  const add = new THREE.ShaderMaterial({
    depthTest: false, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending,
    uniforms: { tLight: { value: target.texture }, texel: { value: new THREE.Vector2() } },
    vertexShader,
    fragmentShader: `uniform sampler2D tLight; uniform vec2 texel; varying vec2 vUv;
      void main(){ vec3 c = vec3(0.0); float w = 0.0;       // a small blur takes out the march's jitter
        for (int x = -2; x <= 2; x++) for (int y = -2; y <= 2; y++) { float k = 1.0 / (1.0 + float(x * x + y * y)); c += texture2D(tLight, vUv + vec2(x, y) * texel).rgb * k; w += k; }
        gl_FragColor = vec4(c / w, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const addScene = new THREE.Scene();
  const addQuad = new THREE.Mesh(plane, add); addQuad.frustumCulled = false;
  addScene.add(addQuad);

  let frame = 0;
  return {
    render(camera) {
      const map = sun.shadow.map;
      if (!map?.depthTexture) return;
      const size = renderer.getDrawingBufferSize(new THREE.Vector2()), w = Math.ceil(size.x / 2), h = Math.ceil(size.y / 2);
      if (target.width !== w || target.height !== h) target.setSize(w, h);
      const u = march.uniforms;
      u.tShadow.value = map.depthTexture;
      u.shadowMatrix.value.copy(sun.shadow.matrix);
      u.camPos.value.setFromMatrixPosition(camera.matrixWorld);
      u.invProj.value.copy(camera.projectionMatrixInverse);
      u.camWorld.value.copy(camera.matrixWorld);
      u.tint.value.copy(sun.color).multiplyScalar(sun.intensity);
      u.frame.value = frame = (frame + 1) % 64;
      add.uniforms.texel.value.set(1 / w, 1 / h);
      renderer.setRenderTarget(target);
      renderer.render(marchScene, screen);
      renderer.setRenderTarget(null);
      const auto = renderer.autoClear;
      renderer.autoClear = false;
      renderer.render(addScene, screen);
      renderer.autoClear = auto;
    },
  };
}
