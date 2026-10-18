import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { fullscreenVertex, filmBlurFragment, filmFragment } from './shaders.js';

// The film finish: softness and depth of field, speed dust, the grade,
// grain and the letterbox, in one pass at the very end of the chain
// (after tone mapping and FXAA, so the antialiasing cannot smear the grain).
// When every one of its controls is off, main.js disables the pass and the
// chain is exactly the one it replaced.
export class FilmPass extends Pass {
  constructor(uniforms) {
    super();
    const target = options => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, ...options });
    this.first = target();
    // Mipmapped for Stable dust light, which reads the frame's light for the
    // speed dust over broad patches (see filmFragment). Every other read is
    // of its full-resolution level, exactly as without the mipmaps.
    this.blurred = target({ minFilter: THREE.LinearMipmapLinearFilter, generateMipmaps: true });
    this.blurMaterial = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uStep: { value: new THREE.Vector2() } },
      vertexShader: fullscreenVertex, fragmentShader: filmBlurFragment, depthTest: false, depthWrite: false,
    });
    this.uniforms = { tDiffuse: { value: null }, tBlur: { value: this.blurred.texture }, ...uniforms };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: fullscreenVertex, fragmentShader: filmFragment, depthTest: false, depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
    this.size = new THREE.Vector2(1, 1);
  }

  setSize(width, height) {
    this.size.set(width, height);
    const w = Math.max(1, Math.round(width / 2)), h = Math.max(1, Math.round(height / 2));
    this.first.setSize(w, h);
    this.blurred.setSize(w, h);
  }

  // The light on the speed dust reads the blurred copy, and so does depth of
  // field once the blur passes the fine 4-tap blend (the same weights as in
  // filmFragment); Softness alone never does.
  get needsBlur() {
    const u = this.uniforms;
    const blur = Math.min(u.uSoftness.value * .4, 1) + u.uFocus.value * u.uFocusNear.value * .6;
    return blur > 1 || (u.uDust.value > 0 && u.uDustNear.value > 0);
  }

  render(renderer, writeBuffer, readBuffer) {
    if (this.needsBlur) {
      // Two passes across and none down: defocused space smears along the
      // flight, so star streaks stay long, thin and soft instead of fading
      // into round blurs (the half-resolution copy is soft enough down).
      this.quad.material = this.blurMaterial;
      const step = this.blurMaterial.uniforms.uStep.value;
      step.set(2.5 / this.size.x, 0);
      this.blurMaterial.uniforms.tDiffuse.value = readBuffer.texture;
      renderer.setRenderTarget(this.first);
      this.quad.render(renderer);
      this.blurMaterial.uniforms.tDiffuse.value = this.first.texture;
      renderer.setRenderTarget(this.blurred);
      this.quad.render(renderer);
    }
    this.quad.material = this.material;
    this.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.quad.render(renderer);
  }

  dispose() {
    this.first.dispose();
    this.blurred.dispose();
    this.blurMaterial.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}
