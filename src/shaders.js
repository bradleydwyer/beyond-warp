// All of the space, refraction and plasma are generated at runtime.
// The noise texture is a tiny, seeded 3D lookup, not a movie or a sky image.
export const fullscreenVertex = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const noise = /* glsl */`
precision highp sampler3D;
uniform sampler3D uNoise;
float noise3(vec3 p) { return texture(uNoise, (p + 0.5) / 64.0).r; }
vec3 noiseVector(vec3 p) { return texture(uNoise, (p + 0.5) / 64.0).rgb; }
float fbm(vec3 p) {
  return noise3(p) * .54 + noise3(p * 2.03 + 17.1) * .27
    + noise3(p * 4.07 + 31.7) * .13 + noise3(p * 8.13 + 11.2) * .06;
}
`;

const environment = /* glsl */`
uniform float uTravel;
// A stationary 3D cloud field in interstellar coordinates. The ship's travelled
// distance translates the environment past it, including its colours/density.
vec4 cloudAt(vec3 world) {
  vec3 p=vec3((world.x-uTravel)*.009,world.y*.020+5.4,world.z*.018+12.5);
  vec3 broad=noiseVector(p);
  float fine=noise3(p*2.07+17.0)*.72+noise3(p*4.13+31.0)*.28;
  float density=smoothstep(.30,.73,broad.r*.46+fine*.54);
  vec3 color=mix(vec3(.006,.055,.14),vec3(.012,.14,.19),smoothstep(.28,.72,broad.g));
  color=mix(color,vec3(.14,.10,.18),smoothstep(.38,.78,broad.b)*.70);
  color+=vec3(.15,.19,.21)*smoothstep(.65,.88,fine);
  return vec4(color,density);
}
`;

export const backgroundFragment = /* glsl */`
${noise}
${environment}
varying vec2 vUv;
uniform mat4 uInverseProjection;
uniform mat4 uCameraMatrix;
uniform vec3 uCameraPosition;
void main() {
  vec4 viewRay=uInverseProjection*vec4(vUv*2.0-1.0,1.0,1.0);
  vec3 ray=normalize(mat3(uCameraMatrix)*viewRay.xyz);
  vec3 col=vec3(.0006,.0012,.0016);
  for (int i=0;i<3;i++) {
    vec3 p=uCameraPosition+ray*(220.0+float(i)*130.0);
    vec4 gas=cloudAt(p);
    float band=(p.y+38.0)/90.0;
    col+=gas.rgb*gas.a*(.12+.88*exp(-band*band))*.085;
  }
  gl_FragColor=vec4(col,1.0);
}`;

export const starVertex = /* glsl */`
attribute vec4 aSeed;
uniform float uTravel;
uniform float uSpeed;
uniform float uTime;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vUv = uv;
  float speed = .55 + aSeed.w * 1.5;
  vec3 world = vec3(mod(aSeed.x + uTravel * speed, 1000.0) - 250.0, aSeed.y, aSeed.z);
  float len = (.5 + pow(aSeed.w, 4.0) * 6.0) * (.2 + uSpeed * .13);
  vec4 center = modelViewMatrix * vec4(world, 1.0);
  vec3 dir = mat3(modelViewMatrix) * vec3(1.0, 0.0, 0.0);
  vec2 side = normalize(vec2(-dir.y, dir.x) + .0001);
  center.xyz += dir * position.x * len;
  center.xy += side * position.y * (.13 + aSeed.w * .13);
  gl_Position = projectionMatrix * center;
  vColor = mix(vec3(.31, .63, .77), vec3(.86, .93, .95), aSeed.w);
  vAlpha = (.04 + pow(aSeed.w, 5.0) * .45);
}`;

export const starFragment = /* glsl */`
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 p = abs(vUv * 2.0 - 1.0);
  float glow = exp(-p.y * p.y * 7.0) * pow(max(0.0, 1.0 - p.x), 1.3);
  gl_FragColor = vec4(vColor * 1.4, glow * vAlpha);
}`;

export const volumeFragment = /* glsl */`
${noise}
${environment}
varying vec2 vUv;
uniform sampler2D tScene, uFluid, uProfile, uProfileSlope;
uniform mat4 uInverseProjection, uProjection, uCameraMatrix;
uniform vec3 uCameraPosition;
uniform float uTurbulence, uIntensity, uEntrance, uLensing;
const float TAU=6.2831853;
const float LENGTH=390.0;

struct Shape { vec4 size; vec4 slope; };
Shape profile(float x) {
  Shape s;
  float uv=(clamp(x/LENGTH,0.0,1.0)*1023.0+.5)/1024.0;
  s.size=texture2D(uProfile,vec2(uv,.5));
  s.slope=texture2D(uProfileSlope,vec2(uv,.5));
  // Analytic paraboloid at the bow: a vertical tangent at the nose, not a
  // smoothstep cusp. Preserves roundness even in the close-up camera.
  if (x<10.0) {
    float r=sqrt(max(.00001,2.7*x));
    s.size=vec4(r,r,r,0.0); s.slope=vec4(vec3(1.35/r),0.0);
  }
  return s;
}
vec2 intersectBox(vec3 ro, vec3 rd) {
  vec3 inv=1.0/(rd+vec3(.000001));
  vec3 a=(vec3(-3.0,-65.0,-70.0)-ro)*inv;
  vec3 b=(vec3(390.0,65.0,70.0)-ro)*inv;
  vec3 lo=min(a,b),hi=max(a,b);
  return vec2(max(max(lo.x,lo.y),lo.z),min(min(hi.x,hi.y),hi.z));
}
float displacement(vec3 dye) { return (dye.r-.44)*1.35+(dye.b-.50)*.60; }
vec2 projectDirection(vec3 direction) {
  vec3 view=vec3(dot(direction,uCameraMatrix[0].xyz),dot(direction,uCameraMatrix[1].xyz),dot(direction,uCameraMatrix[2].xyz));
  vec4 projected=uProjection*vec4(view,0.0);
  return projected.xy/max(projected.w,.1)*.5+.5;
}
vec3 backgroundAt(vec2 uv) { return texture2D(tScene,clamp(uv,vec2(.001),vec2(.999))).rgb; }

void main() {
  vec4 vr=uInverseProjection*vec4(vUv*2.0-1.0,1.0,1.0);
  vec3 direction=normalize(mat3(uCameraMatrix)*vr.xyz);
  vec3 ro=uCameraPosition;
  vec2 bounds=intersectBox(ro,direction);
  float nearT=max(0.0,bounds.x),farT=bounds.y;
  if (farT<=nearT) { gl_FragColor=vec4(backgroundAt(vUv),1.0); return; }
  vec3 p=ro+direction*nearT;
  vec3 radiance=vec3(0.0);
  float transmittance=1.0,travelled=nearT;
  vec4 gas=vec4(0.0);
  for (int i=0;i<STEPS;i++) {
    if (travelled>=farT) break;
    Shape shape=profile(p.x);
    float depth=max(shape.size.z,.002);
    bool upper=p.y>=shape.size.w;
    float height=upper?shape.size.x:shape.size.y;
    float heightSlope=upper?shape.slope.x:shape.slope.y;
    float scale=height/depth;
    float scaleSlope=(heightSlope*depth-height*shape.slope.z)/(depth*depth);
    float y=p.y-shape.size.w;
    vec2 radial=vec2(y/max(scale,.001),p.z);
    float r=max(length(radial),.001);
    // Implicit ellipse gradient stays finite at the rounded bow's apex.
    vec3 gradient=vec3(-2.0*y*shape.slope.w/(scale*scale)-2.0*y*y*scaleSlope/(scale*scale*scale)-2.0*depth*shape.slope.z,2.0*y/(scale*scale),2.0*p.z);
    float implicitDistance=dot(radial,radial)-depth*depth;
    if (p.x<10.0) { implicitDistance=dot(p.yz,p.yz)-2.7*p.x; gradient=vec3(-2.7,2.0*p.y,2.0*p.z); }
    float baseDistance=implicitDistance/max(length(gradient),.001);
    vec3 baseNormal=gradient/max(length(gradient),.0001);
    float wake=smoothstep(8.0,130.0,p.x);
    float minStep=.035+max(p.x,0.0)*.0012;
    float stepSize=min(clamp(abs(baseDistance)*.42,minStep,(farT-nearT)/22.0),farT-travelled);
    // Resolve a real, thin internal shear sheet, not a fixed centre guide line.
    float sheetExtent=1.0-smoothstep(depth*.70,depth*.98,abs(p.z));
    if (p.x>1.0 && sheetExtent>.001) stepSize=min(stepSize,max(minStep,abs(y)*.45)/max(abs(direction.y),.18));
    vec3 nextDirection=direction;
    float axialFade=smoothstep(-1.5,.1,p.x)*(1.0-smoothstep(345.0,390.0,p.x));
    if (i-4*(i/4)==0) gas=cloudAt(p);
    float bandCoordinate=(p.y+27.0)/43.0;
    float cloudBand=.10+.90*exp(-bandCoordinate*bandCoordinate);
    float gasBounds=(1.0-smoothstep(52.0,65.0,abs(p.y)))*(1.0-smoothstep(58.0,70.0,abs(p.z)));
    float grazing=pow(max(0.0,1.0-abs(dot(baseNormal,direction))),2.0);
    float lowerWake=smoothstep(0.0,20.0,-p.y);
    float compressedDistance=(baseDistance-.7-lowerWake*wake*2.0)/(1.0+wake*(5.0+lowerWake*7.0));
    float compression=exp(-compressedDistance*compressedDistance)*(.035+grazing)*uIntensity*uEntrance;
    float outside=smoothstep(-1.5,2.5,baseDistance);
    float gasDensity=gas.a*cloudBand*gasBounds*axialFade*(.0030*outside*(.10+.90*grazing)+compression*.023);
    float gasAlpha=1.0-exp(-gasDensity*stepSize);
    vec3 litGas=gas.rgb+vec3(.08,.10,.12)*smoothstep(.65,.95,gas.a);
    radiance+=transmittance*litGas*gasAlpha*(1.4+compression*.7);
    transmittance*=1.0-gasAlpha*.25;

    vec2 uv=vec2(clamp(p.x/LENGTH,.001,.999),fract(atan(radial.y,radial.x)/TAU+.5));
    if (axialFade>0.0 && abs(baseDistance)<(3.0+wake*8.0)) {
      vec3 surface=texture2D(uFluid,uv).rgb;
      float deform=(.32+wake*2.9)*uTurbulence;
      float d=baseDistance-displacement(surface)*deform;
      vec2 du=vec2(.004,0.0),dv=vec2(0.0,.009);
      float dx=(displacement(texture2D(uFluid,uv+du).rgb)-displacement(texture2D(uFluid,uv-du).rgb))/(.008*LENGTH);
      float da=(displacement(texture2D(uFluid,uv+dv).rgb)-displacement(texture2D(uFluid,uv-dv).rgb))/(.018*TAU);
      vec3 angularGradient=vec3(0.0,-radial.y/(r*r*scale),radial.x/(r*r));
      vec3 rippleGradient=deform*(vec3(dx,0.0,0.0)+da*angularGradient);
      vec3 normal=normalize(baseNormal-rippleGradient*.4);
      float lensWidth=.18+max(p.x,0.0)*.009;
      float opticalRipple=mix(.22,.08,wake);
      float lensDistance=baseDistance-displacement(surface)*deform*opticalRipple;
      float edge=clamp((lensDistance+lensWidth)/(lensWidth*2.0),0.0,1.0);
      float strength=.085*uLensing*uEntrance*axialFade;
      float index=1.0+strength*(1.0-edge*edge*(3.0-2.0*edge));
      vec3 gradLogIndex=-strength*6.0*edge*(1.0-edge)/(lensWidth*2.0)*(baseNormal-rippleGradient*opticalRipple)/index;
      nextDirection=normalize(direction+(gradLogIndex-direction*dot(direction,gradLogIndex))*stepSize);
      if (uIntensity>.001) {
        vec3 dye=texture2D(uFluid,vec2(uv.x,fract(uv.y+d*.018))).rgb;
        float tracer=smoothstep(.15,.85,dye.g);
        float foldPattern=.5+.5*sin(dye.r*15.0+dye.b*8.0);
        float filaments=pow(foldPattern,4.0);
        float thickness=max(.08+wake*.85,minStep*.8);
        float sheet=d/thickness;
        float outer=(d-.24-wake*1.7)/(.11+wake*1.25);
        float inner=(d+.18+wake*1.1)/(.10+wake*.95);
        float rim=exp(-sheet*sheet);
        float folds=exp(-outer*outer)*filaments+exp(-inner*inner)*tracer*.65;
        float facing=.003+.997*pow(max(0.0,1.0-abs(dot(normal,direction))),2.5);
        float density=(rim*(.045+tracer*.40+filaments*.25)+folds*.18)*facing;
        density*=axialFade*uIntensity*uEntrance*(.18+gas.a*2.0)/(1.0+wake*4.0);
        vec3 color=mix(vec3(.008,.07,.13),vec3(.24,.37,.43),tracer*.5+filaments*.5);
        color=mix(color,litGas*2.0,.55);
        vec3 film=.5+.5*cos(vec3(0.0,2.1,4.2)+surface.r*9.0+surface.b*5.0);
        color+=film*.12*(1.0-wake)*rim;
        float alpha=1.0-exp(-density*stepSize*2.0);
        radiance+=transmittance*color*alpha*(.70+facing*.55);
        transmittance*=1.0-alpha*.40;
      }
    }
    if (p.x>1.0 && sheetExtent>.001 && uIntensity>.001) {
      vec2 sheetUv=vec2(uv.x,fract(.5+p.z/(depth*2.0)*.30));
      vec3 dye=texture2D(uFluid,sheetUv).rgb;
      float roll=(dye.r-.45)*(.12+wake*8.0)+(dye.b-.5)*wake*4.0;
      float sheetWidth=.06+wake*.32;
      float sd=(y-roll)/sheetWidth;
      float filament=.5+.5*sin(dye.r*22.0+dye.b*11.0);
      float secondary=(y-roll-(dye.b-.40)*wake*4.0-1.2*wake)/(sheetWidth*1.35);
      float folds=exp(-sd*sd)+.55*exp(-secondary*secondary);
      float density=folds*sheetExtent*(.002+dye.g*.024+filament*.012)*(.15+gas.a*3.0);
      density*=smoothstep(1.0,8.0,p.x)*axialFade*uIntensity*uEntrance;
      float alpha=1.0-exp(-density*stepSize);
      vec3 color=mix(vec3(.035,.09,.14),vec3(.24,.32,.34),filament*dye.g);
      radiance+=transmittance*mix(color,litGas*1.6,.50)*alpha;
    }
    p+=normalize(direction+nextDirection)*stepSize;
    direction=nextDirection; travelled+=stepSize;
  }
  vec2 offset=projectDirection(direction)-vUv;
  vec2 edgeDistance=min(vUv,1.0-vUv);
  float screenFade=smoothstep(.0,.055,min(edgeDistance.x,edgeDistance.y));
  vec2 refractedUv=vUv+clamp(offset,vec2(-.22),vec2(.22))*screenFade;
  vec3 refracted=backgroundAt(refractedUv);
  gl_FragColor=vec4(refracted*(.90+.10*transmittance)+radiance,1.0);
}`;

export const lensFragment = /* glsl */`
uniform sampler2D tDiffuse;
uniform float uTime;
uniform vec2 uResolution;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec2 p = vUv - .5;
  vec2 aberration = p * dot(p, p) * .0016;
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  c.r = texture2D(tDiffuse, vUv + aberration).r;
  c.b = texture2D(tDiffuse, vUv - aberration).b;
  // A faint horizontal optical bloom; the main bloom is handled in HDR.
  vec3 flare = vec3(0.0);
  for (int i = 1; i <= 5; i++) {
    vec2 o = vec2(float(i) * .012, 0.0);
    flare += max(texture2D(tDiffuse, vUv + o).rgb - .52, 0.0) / float(i + 1);
    flare += max(texture2D(tDiffuse, vUv - o).rgb - .52, 0.0) / float(i + 1);
  }
  c += flare * vec3(.04, .08, .15);
  c *= 1.0 - .45 * dot(p * vec2(.85, 1.0), p);
  // No animated grain: stable highlights matter more than a film overlay here.
  gl_FragColor = vec4(max(c, vec3(0.0)), 1.0);
}`;
