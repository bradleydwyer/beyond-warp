import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { fullscreenVertex, gasFlowFragment } from './shaders.js';
import { WarpField } from './field.js';

// The field's shape changes slowly as it travels; the far-field flow table
// is redrawn for it once every this many units of travel (every few frames
// at warp), from the shape at that exact, rounded distance.
const STEP = 32;

// The steady flow of the surrounding gas around the field (Effects › Gas),
// tabulated per field shape: for each position along the axis and each
// distance from it, the field's smoothed cross-section and how far the gas
// lags behind the undisturbed stream (see gasFlowFragment). 128 × 32 texels,
// 32 profile taps each. Within about a radius of the surface the shaders
// follow the live profile instead, so this smooth, far-field table can be
// coarse and a little behind: it is drawn from its own copy of the field,
// shaped for the travelled distance rounded down to STEP. That keeps it a pure
// function of the travelled distance (a paused or replayed frame reads exactly
// the same table) while it is redrawn only every few frames.
export class GasFlow {
  constructor(noiseTexture) {
    this.field = new WarpField(noiseTexture);
    this.tail = new THREE.Vector2();
    this.target = new THREE.WebGLRenderTarget(128, 32, {
      type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, generateMipmaps: false,
    });
    this.material = new THREE.ShaderMaterial({
      uniforms: { uProfile: { value: this.field.texture }, uTailFade: { value: this.tail } },
      vertexShader: fullscreenVertex, fragmentShader: gasFlowFragment, depthTest: false, depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
    this.key = NaN;
  }

  get texture() { return this.target.texture; }

  update(renderer, travel) {
    const key = Math.floor(travel / STEP) * STEP;
    if (key === this.key) return;
    this.key = key;
    this.field.update(key);
    this.tail.set(this.field.tail.start, this.field.tail.end);
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer);
    renderer.setRenderTarget(previous);
  }
}
