import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// Anamorphic streak bloom. The bright parts of the HDR frame are box-filtered
// down to a quarter of the width and half the height, then pushed through a
// chain of horizontal-only downsamples (each half as wide) and back up again.
// Every step up blends the finer level with the blurred coarser one, so the
// streak is a long, thin, exponential-looking tail with a bright core, and
// the farther it reaches the bluer it gets. Nothing here touches the frame:
// the lens pass adds the result, so 0% leaves the frame exactly as it was.
const vertexShader = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const prefilterShader = /* glsl */`
uniform sampler2D tSource;
uniform vec2 uTexel;
uniform float uThreshold, uKnee;
varying vec2 vUv;
// Soft-knee threshold on luminance, so highlights fade into the streak
// instead of popping in at a hard level. A shoulder on what passes keeps a
// big flash from throwing a streak far heavier than a bright star's.
vec3 bright(vec3 c) {
  c = min(c, vec3(64.0));
  float level = dot(c, vec3(.2126, .7152, .0722));
  float soft = clamp(level - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-5);
  float excess = max(soft, level - uThreshold);
  return c * excess / (max(level, 1e-4) * (1.0 + excess * .5));
}
void main() {
  // Each output texel covers 4x2 source texels: two bilinear taps, each the
  // exact average of a 2x2 block, so thin moving stars cannot slip between taps.
  vec3 a = texture2D(tSource, vUv - vec2(uTexel.x, 0.0)).rgb;
  vec3 b = texture2D(tSource, vUv + vec2(uTexel.x, 0.0)).rgb;
  gl_FragColor = vec4((bright(a) + bright(b)) * .5, 1.0);
}`;

const downShader = /* glsl */`
uniform sampler2D tSource;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  // Six bilinear taps (twelve texels of the finer level) with Gaussian
  // weights: a box here left flat-topped steps that showed as lumps.
  float dx = uTexel.x;
  vec3 c = (texture2D(tSource, vUv - vec2(5.0 * dx, 0.0)).rgb + texture2D(tSource, vUv + vec2(5.0 * dx, 0.0)).rgb) * .069
    + (texture2D(tSource, vUv - vec2(3.0 * dx, 0.0)).rgb + texture2D(tSource, vUv + vec2(3.0 * dx, 0.0)).rgb) * .168
    + (texture2D(tSource, vUv - vec2(dx, 0.0)).rgb + texture2D(tSource, vUv + vec2(dx, 0.0)).rgb) * .263;
  gl_FragColor = vec4(c, 1.0);
}`;

const upShader = /* glsl */`
uniform sampler2D tLow, tHigh;
uniform vec2 uLowTexel;
uniform float uStretch;
uniform vec3 uTint;
varying vec2 vUv;
void main() {
  float dx = uLowTexel.x * 1.5;
  vec3 low = texture2D(tLow, vUv - vec2(dx, 0.0)).rgb * .25 + texture2D(tLow, vUv).rgb * .5
    + texture2D(tLow, vUv + vec2(dx, 0.0)).rgb * .25;
  // The tint compounds once per level, so the core stays near white and the
  // far reaches of the streak turn blue.
  gl_FragColor = vec4(mix(texture2D(tHigh, vUv).rgb, low * uTint, uStretch), 1.0);
}`;

const flashShader = /* glsl */`
uniform vec4 uFlash[HERO_COUNT];   // screen uv, brightness, unused
uniform float uAspect;
varying vec2 vUv;
void main() {
  vec3 light = vec3(0.0);
  for (int i = 0; i < HERO_COUNT; i++) {
    if (uFlash[i].z <= 0.0) continue;
    vec2 d = (vUv - uFlash[i].xy) * vec2(uAspect, 1.0);
    float r2 = dot(d, d);
    // A hot white core and a broad, soft caustic bloom around it, a little
    // warm and pink at its edge, as in the clip's flash.
    light += uFlash[i].z * (vec3(1.0, .98, .96) * exp(-r2 * 3600.0) + vec3(1.0, .90, .94) * exp(-r2 * 130.0) * .14);
  }
  gl_FragColor = vec4(light, 1.0);
}`;

// The flash of a hero source crossing the field's edge, added to the HDR frame
// before the streak and the round bloom, so both spread it like any highlight.
export class HeroFlashPass extends Pass {
  constructor(count) {
    super();
    this.needsSwap = false;
    this.flashes = Array.from({ length: count }, () => new THREE.Vector4());
    this.material = new THREE.ShaderMaterial({
      vertexShader, fragmentShader: flashShader, defines: { HERO_COUNT: count },
      uniforms: { uFlash: { value: this.flashes }, uAspect: { value: 1 } },
      // Adds light and leaves the buffer's alpha alone.
      depthTest: false, depthWrite: false, transparent: true, blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  setSize(width, height) { this.material.uniforms.uAspect.value = width / Math.max(1, height); }

  render(renderer, writeBuffer, readBuffer) {
    renderer.setRenderTarget(readBuffer);
    this.quad.render(renderer);
  }

  dispose() { this.material.dispose(); this.quad.dispose(); }
}

export class StreakBloomPass extends Pass {
  constructor() {
    super();
    this.needsSwap = false;
    this.enabled = true;
    // Luminance where streaking starts, and the width of its soft knee.
    this.threshold = .8;
    this.knee = .4;
    // 0..1: how much each level hands on to the next, i.e. the streak length.
    this.stretch = .82;
    this.tint = new THREE.Color(1, 1, 1);
    this.levels = [];
    const options = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false };
    this.options = options;
    const material = (fragmentShader, uniforms) => new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms, depthTest: false, depthWrite: false, blending: THREE.NoBlending });
    this.prefilter = material(prefilterShader, { tSource: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: this.threshold }, uKnee: { value: this.knee } });
    this.down = material(downShader, { tSource: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.up = material(upShader, { tLow: { value: null }, tHigh: { value: null }, uLowTexel: { value: new THREE.Vector2() }, uStretch: { value: this.stretch }, uTint: { value: new THREE.Vector3(1, 1, 1) } });
    this.quad = new FullScreenQuad(null);
    this.texel = new THREE.Vector2(1, 1);
  }

  // The finished streak, at a quarter of the width and half the height.
  get texture() { return this.levels.length ? this.levels[0].up.texture : null; }

  setSize(width, height) {
    for (const level of this.levels) { level.down.dispose(); level.up.dispose(); }
    this.levels = [];
    this.source = new THREE.Vector2(width, height);
    let w = Math.max(1, Math.ceil(width / 4));
    const h = Math.max(1, Math.ceil(height / 2));
    while (this.levels.length < 9) {
      this.levels.push({ width: w, height: h, down: new THREE.WebGLRenderTarget(w, h, this.options), up: new THREE.WebGLRenderTarget(w, h, this.options) });
      if (w <= 12 && this.levels.length > 1) break;
      w = Math.ceil(w / 2);
    }
    this.texel.set(1 / this.levels[0].width, 1 / this.levels[0].height);
  }

  render(renderer, writeBuffer, readBuffer) {
    if (!this.levels.length) return;
    const draw = (material, target) => { this.quad.material = material; renderer.setRenderTarget(target); this.quad.render(renderer); };
    this.prefilter.uniforms.tSource.value = readBuffer.texture;
    this.prefilter.uniforms.uTexel.value.set(1 / this.source.x, 1 / this.source.y);
    this.prefilter.uniforms.uThreshold.value = this.threshold;
    this.prefilter.uniforms.uKnee.value = this.knee;
    draw(this.prefilter, this.levels[0].down);
    for (let i = 1; i < this.levels.length; i++) {
      this.down.uniforms.tSource.value = this.levels[i - 1].down.texture;
      this.down.uniforms.uTexel.value.set(1 / this.levels[i - 1].width, 1 / this.levels[i - 1].height);
      draw(this.down, this.levels[i].down);
    }
    this.up.uniforms.uStretch.value = this.stretch;
    this.up.uniforms.uTint.value.set(this.tint.r, this.tint.g, this.tint.b);
    let low = this.levels.at(-1).down;
    for (let i = this.levels.length - 2; i >= 0; i--) {
      this.up.uniforms.tLow.value = low.texture;
      this.up.uniforms.tHigh.value = this.levels[i].down.texture;
      this.up.uniforms.uLowTexel.value.set(1 / this.levels[i + 1].width, 1 / this.levels[i + 1].height);
      draw(this.up, this.levels[i].up);
      low = this.levels[i].up;
    }
  }

  dispose() {
    for (const level of this.levels) { level.down.dispose(); level.up.dispose(); }
    this.prefilter.dispose(); this.down.dispose(); this.up.dispose(); this.quad.dispose();
  }
}
