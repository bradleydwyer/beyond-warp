import * as THREE from 'three';

// World units are ship-scale: the ship is ~1.6 units long, the wide shot
// covers ~260. These landmarks are fitted to the last decoded video frame.
export const FIELD_LENGTH = 390;
const samples = 1024;
const resting = [[22, 15.5, 23.5], [39, 19, 28.5], [49, 31, 33], [60, 35, 39]];
const smoothMax = (a, b) => .5 * (a + b + Math.sqrt((a-b)**2 + .01));
const lerp = (a, b, t) => a + (b-a)*t;
const smooth = t => t*t*(3-2*t);

function spline(points) {
  const n = points.length, slopes = new Float64Array(n);
  const d = points.slice(1).map((p, i) => (p[1]-points[i][1])/(p[0]-points[i][0]));
  slopes[0] = d[0]; slopes[n-1] = d[n-2];
  for (let i=1; i<n-1; i++) {
    if (d[i-1]*d[i] <= 0) continue;
    const h0=points[i][0]-points[i-1][0], h1=points[i+1][0]-points[i][0];
    const w0=2*h1+h0, w1=h1+2*h0;
    slopes[i]=(w0+w1)/(w0/d[i-1]+w1/d[i]);
  }
  return x => {
    let i=0;
    while (i<n-2 && x>points[i+1][0]) i++;
    const [x0,y0]=points[i], [x1,y1]=points[i+1], h=x1-x0;
    const t=THREE.MathUtils.clamp((x-x0)/h,0,1), t2=t*t, t3=t2*t;
    const y=(2*t3-3*t2+1)*y0+(t3-2*t2+t)*h*slopes[i]+(-2*t3+3*t2)*y1+(t3-t2)*h*slopes[i+1];
    const dy=((6*t2-6*t)*y0+(-6*t2+6*t)*y1)/h+(3*t2-4*t+1)*slopes[i]+(3*t2-2*t)*slopes[i+1];
    return [y,dy];
  };
}

export class WarpField {
  constructor(noiseTexture) {
    this.noise = noiseTexture.image.data;
    this.data = new Float32Array(samples*4);
    this.derivatives = new Float32Array(samples*4);
    const texture = data => {
      const t = new THREE.DataTexture(data, samples, 1, THREE.RGBAFormat, THREE.FloatType);
      t.minFilter = t.magFilter = THREE.LinearFilter;
      t.needsUpdate = true; return t;
    };
    this.texture = texture(this.data);
    this.derivativeTexture = texture(this.derivatives);
    this.lobes = [];
    this.update(12);
  }

  // Same seeded world cloud as the GLSL environment, sampled on the CPU for
  // pressure. Cubic interpolation keeps envelope motion differentiable.
  noiseAt(x, y, z, channel=0) {
    const ix=Math.floor(x), iy=Math.floor(y), iz=Math.floor(z);
    const fx=smooth(x-ix), fy=smooth(y-iy), fz=smooth(z-iz);
    const n=(a,b,c)=>this.noise[(((c&63)*64+(b&63))*64+(a&63))*4+channel]/255;
    const a=lerp(lerp(n(ix,iy,iz),n(ix+1,iy,iz),fx),lerp(n(ix,iy+1,iz),n(ix+1,iy+1,iz),fx),fy);
    const b=lerp(lerp(n(ix,iy,iz+1),n(ix+1,iy,iz+1),fx),lerp(n(ix,iy+1,iz+1),n(ix+1,iy+1,iz+1),fx),fy);
    return lerp(a,b,fz);
  }
  pressureAt(x, travel) {
    return this.noiseAt((x-travel)*.009,5.4,12.5);
  }
  update(travel) {
    if (travel === this.lastTravel) return;
    this.lastTravel = travel;
    let edge=50, previousWidth=0, previousUpper=0, previousLower=0;
    this.lobes = resting.map(([width,up,low], i) => {
      const restCenter=[72,133,221,330][i];
      const pressure=this.pressureAt(restCenter,travel)-this.pressureAt(restCenter,12);
      const stretch=1+pressure*.22, swell=1+pressure*.28;
      const halfLength=smoothMax(width*stretch,previousWidth+4);
      const upper=smoothMax(up*swell,previousUpper+.75);
      const lower=smoothMax(low*(1+pressure*.14),previousLower+.6);
      const lobe={ center: edge+halfLength, halfLength, radius:(upper+lower)*.5, upper, lower };
      edge+=2*halfLength; previousWidth=halfLength; previousUpper=upper; previousLower=lower;
      return lobe;
    });
    const top=[[0,0],[5,Math.sqrt(13.5)],[10,Math.sqrt(27)],[20,8.0],[35,10.5],[50,11.7]];
    const bottom=[[0,0],[5,Math.sqrt(13.5)],[10,Math.sqrt(27)],[20,11],[35,18],[50,20.5]];
    this.lobes.forEach((a,i)=>{
      top.push([a.center,a.upper]); bottom.push([a.center,a.lower]);
      const b=this.lobes[i+1];
      const fraction=b?a.halfLength/(a.halfLength+b.halfLength):0;
      top.push([a.center+a.halfLength,b?lerp(a.upper,b.upper,fraction)*.76:0]);
      bottom.push([a.center+a.halfLength,b?lerp(a.lower,b.lower,fraction)*.99:0]);
    });
    const last=this.lobes.at(-1);
    this.tail={ start:last.center-last.halfLength, center:last.center,
      end:Math.min(FIELD_LENGTH,last.center+last.halfLength), upper:last.upper, lower:last.lower };
    const upper=spline(top), lower=spline(bottom);
    for (let i=0; i<samples; i++) {
      const x=i/(samples-1)*FIELD_LENGTH;
      let [u,du]=upper(x), [l,dl]=lower(x);
      if (x<10) { u=l=Math.sqrt(Math.max(.00001,2.7*x)); du=dl=1.35/u; }
      if (x>=this.tail.center) {
        // An ellipsoidal rear cap has a horizontal tangent at the last crest
        // and a rounded, vertical tangent at the shared closing point.
        const length=this.tail.end-this.tail.center;
        const t=THREE.MathUtils.clamp((x-this.tail.center)/length,0,1);
        const cap=Math.sqrt(Math.max(.00000001,1-t*t));
        u=last.upper*cap; l=last.lower*cap;
        du=-last.upper*t/(length*cap); dl=-last.lower*t/(length*cap);
      }
      this.data.set([u,l,(u+l)*.5,0],i*4);
      this.derivatives.set([du,dl,(du+dl)*.5,0],i*4);
    }
    this.texture.needsUpdate=true; this.derivativeTexture.needsUpdate=true;
  }
}
