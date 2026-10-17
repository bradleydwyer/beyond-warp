import * as THREE from 'three';
import { fullscreenVertex } from './shaders.js';

// A 2D incompressible fluid living on the axial/angular coordinates of the
// 3D warp shell. Velocity and dye are advected, vorticity is reinforced,
// and a pressure projection removes divergence on every simulation step.
// V wraps around the shell; U has an inlet and outlet.
export class ShellFluid {
  constructor(renderer, noiseTexture, width = 512, height = 256) {
    this.renderer = renderer;
    this.size = new THREE.Vector2(width, height);
    this.time = 0;
    this.travel = 0;
    this.accumulator = 0;
    this.scene = new THREE.Scene();
    this.camera = new THREE.Camera();
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    const target = () => new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.RepeatWrapping,
      depthBuffer: false, stencilBuffer: false,
    });
    const pair = () => ({ read: target(), write: target(), swap() { [this.read, this.write] = [this.write, this.read]; } });
    this.velocity = pair(); this.dye = pair(); this.pressure = pair();
    this.curl = target(); this.divergence = target(); this.dyeForward = target(); this.dyeBackward = target();
    const common = /* glsl */`
      precision highp sampler3D;
      varying vec2 vUv;
      uniform sampler2D uSource, uVelocity, uCurl, uPressure, uDivergence, uForward, uBackward;
      uniform sampler3D uNoise;
      uniform vec2 uTexel;
      uniform float uDt, uTime, uTravel, uSpeed, uTurbulence;
      // The shell carries ripples into the wake. Allow angular rolling, but
      // prevent vortex forces or pressure correction reversing axial flow.
      vec2 downstream(vec2 velocity) {
        return clamp(velocity, vec2((20.0+uSpeed*4.0)*.4,-100.0), vec2(170.0));
      }
      vec2 coord(vec2 p) { return vec2(clamp(p.x, uTexel.x*.5, 1.0-uTexel.x*.5), fract(p.y)); }
      vec4 sampleAt(sampler2D tex, vec2 p) { return texture2D(tex, coord(p)); }
      float n(vec3 p) { return texture(uNoise, (p+.5)/64.0).r; }
      float f(vec3 p) { return n(p)*.55 + n(p*2.03+10.0)*.28+n(p*4.1+23.0)*.12+n(p*8.2+14.0)*.05; }
      vec2 eddies(vec2 uv, float time) {
        vec2 force=vec2(0.0);
        for (int i=0;i<9;i++) {
          float fi=float(i);
          vec2 center=vec2(fract(fi*.137+.12+uTravel*.85),fract(fi*.371+.17+sin(time*.17+fi)*.04));
          vec2 delta=uv-center;
          delta.y=mod(delta.y+.5,1.0)-.5;
          delta.x*=2.0;
          float signOfVortex=mod(fi,2.0)*2.0-1.0;
          force+=vec2(-delta.y,delta.x)*exp(-dot(delta,delta)*(85.0+fi*12.0))*1600.0*signOfVortex;
        }
        return force;
      }
      vec3 sourceNoise(vec2 uv) {
        float a = uv.y*6.2831853;
        vec3 p = vec3((uv.x-uTravel)*16.0, cos(a)*5.0, sin(a)*5.0);
        float broad = f(p);
        float fine = f(p*3.7+vec3(broad*3.0));
        float density = smoothstep(.30,.72,broad);
        float thread = pow(max(0.0, 1.0-abs(fine-.53)*5.5),5.0);
        return vec3(density, thread, fine);
      }
    `;
    this.uniforms = {
      uSource: { value: null }, uVelocity: { value: null }, uCurl: { value: null },
      uPressure: { value: null }, uDivergence: { value: null }, uNoise: { value: noiseTexture },
      uForward: { value: null }, uBackward: { value: null },
      uTexel: { value: new THREE.Vector2(1/width, 1/height) }, uDt: { value: 1/60 },
      uTime: { value: 0 }, uTravel: { value: 0 }, uSpeed: { value: 8 }, uTurbulence: { value: .65 },
    };
    const material = body => new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: fullscreenVertex, fragmentShader: common + body,
      depthTest: false, depthWrite: false,
    });
    this.initVelocity = material(/* glsl */`
      void main() {
        float a=vUv.y*6.2831853;
        float base=20.0+uSpeed*4.0;
        vec2 swirl=eddies(vUv,0.0)*.6;
        gl_FragColor=vec4(downstream(vec2(base,0.0)+swirl*uTurbulence),0.0,1.0);
      }
    `);
    this.initDye = material(/* glsl */`
      void main() { gl_FragColor=vec4(sourceNoise(vUv),1.0); }
    `);
    this.zero = material('void main() { gl_FragColor=vec4(0.0); }');
    this.advectVelocity = material(/* glsl */`
      void main() {
        vec2 velocity=sampleAt(uVelocity,vUv).xy;
        vec2 p=vUv-velocity*uDt*uTexel;
        vec2 previous=sampleAt(uSource,p).xy;
        float base=20.0+uSpeed*4.0;
        float a=vUv.y*6.2831853;
        // Counter-rotating vortices travel downstream with the field.
        previous+=eddies(vUv,uTime)*uDt*uTurbulence;
        previous=mix(previous,vec2(base,0.0),uDt*.06);
        previous=mix(previous,vec2(base,sin(a*5.0+uTime)*12.0*uTurbulence), (1.0-smoothstep(.0,.04,vUv.x))*.5);
        gl_FragColor=vec4(downstream(previous),0.0,1.0);
      }
    `);
    this.computeCurl = material(/* glsl */`
      void main() {
        float l=sampleAt(uVelocity,vUv-vec2(uTexel.x,0)).y;
        float r=sampleAt(uVelocity,vUv+vec2(uTexel.x,0)).y;
        float b=sampleAt(uVelocity,vUv-vec2(0,uTexel.y)).x;
        float t=sampleAt(uVelocity,vUv+vec2(0,uTexel.y)).x;
        gl_FragColor=vec4((r-l-t+b)*.5,0,0,1);
      }
    `);
    this.confine = material(/* glsl */`
      void main() {
        float l=sampleAt(uCurl,vUv-vec2(uTexel.x,0)).x;
        float r=sampleAt(uCurl,vUv+vec2(uTexel.x,0)).x;
        float b=sampleAt(uCurl,vUv-vec2(0,uTexel.y)).x;
        float t=sampleAt(uCurl,vUv+vec2(0,uTexel.y)).x;
        float c=sampleAt(uCurl,vUv).x;
        vec2 gradient=vec2(abs(r)-abs(l),abs(t)-abs(b));
        gradient/=length(gradient)+.0001;
        vec2 force=vec2(gradient.y,-gradient.x)*c*14.0*uTurbulence;
        vec2 velocity=sampleAt(uVelocity,vUv).xy+force*uDt;
        gl_FragColor=vec4(downstream(velocity),0,1);
      }
    `);
    this.computeDivergence = material(/* glsl */`
      void main() {
        float l=sampleAt(uVelocity,vUv-vec2(uTexel.x,0)).x;
        float r=sampleAt(uVelocity,vUv+vec2(uTexel.x,0)).x;
        float b=sampleAt(uVelocity,vUv-vec2(0,uTexel.y)).y;
        float t=sampleAt(uVelocity,vUv+vec2(0,uTexel.y)).y;
        gl_FragColor=vec4((r-l+t-b)*.5,0,0,1);
      }
    `);
    this.solvePressure = material(/* glsl */`
      void main() {
        float l=sampleAt(uPressure,vUv-vec2(uTexel.x,0)).x;
        float r=sampleAt(uPressure,vUv+vec2(uTexel.x,0)).x;
        float b=sampleAt(uPressure,vUv-vec2(0,uTexel.y)).x;
        float t=sampleAt(uPressure,vUv+vec2(0,uTexel.y)).x;
        float d=sampleAt(uDivergence,vUv).x;
        gl_FragColor=vec4((l+r+b+t-d)*.25,0,0,1);
      }
    `);
    this.project = material(/* glsl */`
      void main() {
        float l=sampleAt(uPressure,vUv-vec2(uTexel.x,0)).x;
        float r=sampleAt(uPressure,vUv+vec2(uTexel.x,0)).x;
        float b=sampleAt(uPressure,vUv-vec2(0,uTexel.y)).x;
        float t=sampleAt(uPressure,vUv+vec2(0,uTexel.y)).x;
        vec2 velocity=sampleAt(uVelocity,vUv).xy-vec2(r-l,t-b)*.5;
        gl_FragColor=vec4(downstream(velocity),0,1);
      }
    `);
    this.advectDye = material(/* glsl */`
      void main() {
        vec2 v=sampleAt(uVelocity,vUv).xy;
        // Midpoint backtracing follows curved trajectories instead of Euler drift.
        vec2 middle=vUv-v*uDt*uTexel*.5;
        vec2 vm=sampleAt(uVelocity,middle).xy;
        gl_FragColor=sampleAt(uSource,vUv-vm*uDt*uTexel);
      }
    `);
    this.correctDye = material(/* glsl */`
      void main() {
        vec3 original=sampleAt(uSource,vUv).rgb;
        vec3 forward=sampleAt(uForward,vUv).rgb;
        vec3 reverse=sampleAt(uBackward,vUv).rgb;
        vec3 dye=forward+.5*(original-reverse);
        vec2 p=vUv-sampleAt(uVelocity,vUv).xy*uDt*uTexel;
        vec2 cell=(floor(p/uTexel-.5)+.5)*uTexel;
        vec3 a=sampleAt(uSource,cell).rgb;
        vec3 b=sampleAt(uSource,cell+vec2(uTexel.x,0.0)).rgb;
        vec3 c=sampleAt(uSource,cell+vec2(0.0,uTexel.y)).rgb;
        vec3 d=sampleAt(uSource,cell+uTexel).rgb;
        dye=clamp(dye,min(min(a,b),min(c,d)),max(max(a,b),max(c,d)));
        dye*=exp(-uDt*.018);
        vec3 injection=sourceNoise(vUv);
        float source=1.0-smoothstep(.008,.065,vUv.x);
        dye=mix(dye,injection,source*(1.0-exp(-uDt*8.0)));
        gl_FragColor=vec4(clamp(dye,0.0,1.0),1.0);
      }
    `);
    this.reset();
  }

  pass(material, target) {
    this.mesh.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
  }

  reset() {
    const previous = this.renderer.getRenderTarget();
    this.time = 0; this.travel = 0; this.accumulator = 0;
    this.uniforms.uTime.value = 0; this.uniforms.uTravel.value = 0;
    this.pass(this.initVelocity, this.velocity.read);
    this.pass(this.initDye, this.dye.read);
    this.pass(this.zero, this.pressure.read);
    this.renderer.setRenderTarget(previous);
  }

  update(dt, speed, turbulence) {
    this.accumulator = Math.min(this.accumulator + dt, .05);
    const previous = this.renderer.getRenderTarget();
    const u = this.uniforms;
    u.uSpeed.value = speed; u.uTurbulence.value = turbulence;
    // Fixed simulation step: results do not change with display refresh rate.
    while (this.accumulator >= 1/60) {
      const step = 1/60; this.accumulator -= step; this.time += step;
      // Integrate transport phase so changing speed never jumps the inlet pattern.
      this.travel += step * (20 + speed * 4) / this.size.x;
      u.uDt.value = step; u.uTime.value = this.time; u.uTravel.value = this.travel;
      u.uVelocity.value = this.velocity.read.texture; u.uSource.value = this.velocity.read.texture;
      this.pass(this.advectVelocity, this.velocity.write); this.velocity.swap();
      u.uVelocity.value = this.velocity.read.texture;
      this.pass(this.computeCurl, this.curl); u.uCurl.value = this.curl.texture;
      this.pass(this.confine, this.velocity.write); this.velocity.swap();
      u.uVelocity.value = this.velocity.read.texture;
      this.pass(this.computeDivergence, this.divergence); u.uDivergence.value = this.divergence.texture;
      for (let i=0; i<12; i++) {
        u.uPressure.value = this.pressure.read.texture;
        this.pass(this.solvePressure, this.pressure.write); this.pressure.swap();
      }
      u.uPressure.value = this.pressure.read.texture;
      this.pass(this.project, this.velocity.write); this.velocity.swap();
      u.uVelocity.value = this.velocity.read.texture; u.uSource.value = this.dye.read.texture;
      this.pass(this.advectDye, this.dyeForward);
      u.uSource.value = this.dyeForward.texture; u.uDt.value = -step;
      this.pass(this.advectDye, this.dyeBackward);
      u.uSource.value = this.dye.read.texture; u.uDt.value = step;
      u.uForward.value = this.dyeForward.texture; u.uBackward.value = this.dyeBackward.texture;
      this.pass(this.correctDye, this.dye.write); this.dye.swap();
    }
    this.renderer.setRenderTarget(previous);
  }

  get texture() { return this.dye.read.texture; }
  get velocityTexture() { return this.velocity.read.texture; }
}
