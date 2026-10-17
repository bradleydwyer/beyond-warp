// All of the space, reflections and refraction are generated at runtime.
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
  // Large cloud regions carry their own colour and coverage. Warping the
  // smaller scales through them breaks up the uniform soft fog into banks,
  // stretched wisps, and darker lanes, all fixed in the passing world.
  vec3 region=noiseVector(p*vec3(.23,.31,.27)+vec3(37.0,9.0,21.0));
  vec3 q=p+(region-.5)*vec3(2.2,1.6,2.4);
  float detail=noise3(q*vec3(1.7,2.8,2.1)+17.0);
  float wisps=1.0-abs(noise3(q*vec3(.65,4.0,2.6)+31.0)*2.0-1.0);
  float fine=detail*.72+wisps*.28;
  float density=smoothstep(.34,.74,broad.r*.32+fine*.46+region.r*.22);
  density*=mix(.25,1.3,smoothstep(.25,.75,region.r));
  density*=1.0-.65*smoothstep(.60,.80,broad.b);
  float hue=smoothstep(.25,.75,region.g*.65+broad.g*.35);
  vec3 color=mix(vec3(.006,.04,.13),vec3(.01,.16,.13),hue);
  color=mix(color,vec3(.12,.045,.16),smoothstep(.50,.75,region.b*.7+broad.b*.3)*.75);
  color+=vec3(.12,.16,.17)*smoothstep(.66,.88,fine);
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
    col+=gas.rgb*gas.a*(.08+.92*exp(-band*band))*.12;
  }
  gl_FragColor=vec4(col,1.0);
}`;

export const starVertex = /* glsl */`
attribute vec4 aSeed;
uniform float uTravel;
uniform float uVelocity;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
varying float vForeground;
void main() {
  vUv = uv;
  float speed = .55 + aSeed.w * 1.5;
  // Recycle well outside the camera so fast stars never pop into the frame.
  vec3 world = vec3(mod(aSeed.x + uTravel * speed, 3200.0) - 1400.0, aSeed.y, aSeed.z);
  // Stars live on both sides of the field. Those between the camera and the
  // field are composited afterwards, so the background lens cannot bend them.
  vec3 toStar=world-cameraPosition;
  vec3 inv=1.0/(normalize(toStar)+vec3(.000001));
  vec3 entry=(vec3(-3.0,-65.0,-70.0)-cameraPosition)*inv;
  vec3 exit=(vec3(390.0,65.0,70.0)-cameraPosition)*inv;
  vec3 lo=min(entry,exit),hi=max(entry,exit);
  float nearT=max(max(lo.x,lo.y),lo.z),farT=min(min(hi.x,hi.y),hi.z);
  vForeground=farT>max(nearT,0.0) && length(toStar)<nearT ? 1.0 : 0.0;
  // Integrated shutter trail: its length follows actual world-space velocity.
  float len = max(.35, .5 * uVelocity * speed * .028);
  vec4 center = modelViewMatrix * vec4(world, 1.0);
  vec3 dir = mat3(modelViewMatrix) * vec3(1.0, 0.0, 0.0);
  vec2 side = normalize(vec2(-dir.y, dir.x) + .0001);
  center.xyz += dir * position.x * len;
  center.xy += side * position.y * (.65 + pow(aSeed.w, 4.0) * 1.65);
  gl_Position = projectionMatrix * center;
  vColor = mix(vec3(.26, .64, .85), vec3(.98, 1.0, .90), aSeed.w);
  // A sparse bright tail: most stars stay below the bloom threshold, with
  // only occasional hot highlights lighting up the wide optical halo.
  vAlpha = .004 + pow(aSeed.w, 4.0)*.025 + pow(aSeed.w, 100.0)*.5;
}`;

export const starFragment = /* glsl */`
uniform float uBloom, uForeground;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
varying float vForeground;
void main() {
  if (abs(vForeground-uForeground)>.5) discard;
  vec2 p = abs(vUv * 2.0 - 1.0);
  float tail = pow(max(0.0, 1.0 - p.x), 1.3);
  // Filter the bright core over a pixel footprint to prevent subpixel sparkle.
  float width = sqrt(.0036 + pow(fwidth(vUv.y*2.0), 2.0) / 12.0);
  float core = exp(-p.y*p.y/(width*width)) * (.06/width);
  float halo = exp(-p.y*p.y*6.0);
  float radiance = tail * (core*12.0 + halo*.55*(uBloom/.65));
  gl_FragColor = vec4(vColor*radiance, vAlpha);
}`;

// The visible view sits inside a larger background capture. A camera-centred
// cube capture continues it in all directions when rays leave that guard area.
const sceneSampling = /* glsl */`
uniform samplerCube uOffscreenScene;
uniform float uSceneScale;
uniform vec2 uTailFade;
uniform vec4 uTailCap;
float tailFade(float x) { return 1.0-smoothstep(uTailFade.x,uTailFade.y,x); }
vec2 sceneUv(vec2 uv) { return (uv-.5)/uSceneScale+.5; }
float sceneCoverage(vec2 uv) {
  vec2 edge=min(uv,1.0-uv);
  return smoothstep(0.0,.04,min(edge.x,edge.y));
}
vec3 sceneRay(vec2 uv) {
  vec4 view=uInverseProjection*vec4(uv*2.0-1.0,1.0,1.0);
  return normalize(mat3(uCameraMatrix)*view.xyz);
}
vec3 backgroundAt(vec2 uv) {
  vec2 capture=sceneUv(uv);
  vec3 wide=texture2D(tScene,clamp(capture,vec2(.001),vec2(.999))).rgb;
  vec3 beyond=textureLod(uOffscreenScene,sceneRay(uv),0.0).rgb;
  return mix(beyond,wide,sceneCoverage(capture));
}
vec3 backgroundAlong(vec3 direction) {
  vec3 view=vec3(dot(direction,uCameraMatrix[0].xyz),dot(direction,uCameraMatrix[1].xyz),dot(direction,uCameraMatrix[2].xyz));
  if (view.z>=-.05) return textureLod(uOffscreenScene,direction,0.0).rgb;
  vec4 projected=uProjection*vec4(view,0.0);
  return backgroundAt(projected.xy/projected.w*.5+.5);
}
vec3 backgroundGrad(vec2 uv,vec2 along,vec2 across) {
  vec2 capture=sceneUv(uv);
  vec3 wide=textureGrad(tScene,clamp(capture,vec2(.001),vec2(.999)),along/uSceneScale,across/uSceneScale).rgb;
  vec3 beyond=textureLod(uOffscreenScene,sceneRay(uv),2.0).rgb;
  return mix(beyond,wide,sceneCoverage(capture));
}
vec3 backgroundLod(vec2 uv,float level) {
  vec2 capture=sceneUv(uv);
  vec3 wide=textureLod(tScene,clamp(capture,vec2(.001),vec2(.999)),level).rgb;
  vec3 beyond=textureLod(uOffscreenScene,sceneRay(uv),level).rgb;
  return mix(beyond,wide,sceneCoverage(capture));
}
`;

export const fluidVolumeFragment = /* glsl */`
${noise}
${environment}
varying vec2 vUv;
uniform sampler2D tScene, uFluid, uProfile, uProfileSlope;
uniform mat4 uInverseProjection, uProjection, uCameraMatrix;
uniform vec3 uCameraPosition;
uniform float uTurbulence, uIntensity, uEntrance, uLensing;
${sceneSampling}
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
    if (p.x>=uTailCap.x) {
      vec3 radii=vec3(uTailCap.y-uTailCap.x,p.y>=0.0?uTailCap.z:uTailCap.w,(uTailCap.z+uTailCap.w)*.5);
      vec3 q=(p-vec3(uTailCap.x,0.0,0.0))/radii;
      implicitDistance=dot(q,q)-1.0;
      gradient=2.0*q/radii;
    }
    float baseDistance=implicitDistance/max(length(gradient),.001);
    vec3 baseNormal=gradient/max(length(gradient),.0001);
    float wake=smoothstep(8.0,130.0,p.x);
    float minStep=.035+max(p.x,0.0)*.0012;
    float stepSize=min(clamp(abs(baseDistance)*.42,minStep,(farT-nearT)/22.0),farT-travelled);
    // Resolve a real, thin internal shear sheet, not a fixed centre guide line.
    float sheetExtent=1.0-smoothstep(depth*.70,depth*.98,abs(p.z));
    if (p.x>1.0 && sheetExtent>.001) stepSize=min(stepSize,max(minStep,abs(y)*.45)/max(abs(direction.y),.18));
    vec3 nextDirection=direction;
    float axialFade=smoothstep(-1.5,.1,p.x)*tailFade(p.x);
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
  vec3 refracted=backgroundAlong(direction);
  gl_FragColor=vec4(refracted*(.90+.10*transmittance)+radiance,1.0);
}`;

export const volumeFragment = /* glsl */`
varying vec2 vUv;
uniform sampler2D tScene, uFluid, uProfile, uProfileSlope;
uniform samplerCube uSurroundings;
uniform mat4 uInverseProjection, uProjection, uCameraMatrix;
uniform vec3 uCameraPosition;
uniform vec2 uResolution;
uniform float uTurbulence, uIntensity, uEntrance, uLensing, uBloom, uBandGlow, uEdgeGlow, uProjectionWidth;
${sceneSampling}
const float TAU=6.2831853;
const float LENGTH=390.0;

struct Shape { vec4 size; vec4 slope; };
Shape profile(float x) {
  Shape s;
  float uv=(clamp(x/LENGTH,0.0,1.0)*1023.0+.5)/1024.0;
  s.size=texture2D(uProfile,vec2(uv,.5));
  s.slope=texture2D(uProfileSlope,vec2(uv,.5));
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
vec3 toView(vec3 direction) {
  return vec3(dot(direction,uCameraMatrix[0].xyz),dot(direction,uCameraMatrix[1].xyz),dot(direction,uCameraMatrix[2].xyz));
}
vec2 projectDirection(vec3 direction) {
  vec4 projected=uProjection*vec4(toView(direction),0.0);
  return projected.xy/max(projected.w,.1)*.5+.5;
}
vec2 projectPosition(vec3 p) { return projectDirection(p-uCameraPosition); }
vec3 compressedSpace(vec2 normal, float across, float halfWidthPixels) {
  // Compress almost the full background across the band. Tangential motion
  // is preserved: stars continue past the ship instead of a smoke texture
  // crawling independently over the field. The normal follows the round bow.
  vec2 source=vUv+normal*(dot(vec2(.5)-vUv,normal)+across*.46);
  vec2 tangent=vec2(normal.y,-normal.x);
  // Filter across the compression, preserving detail along the band.
  vec2 along=tangent/uResolution;
  vec2 crossBand=normal*.46/max(halfWidthPixels,1.0);
  return backgroundGrad(source,along,crossBand);
}

vec3 projectedSpace(float across, float halfWidthPixels) {
  // Repeat the same background column in every ribbon. Only its vertical
  // coordinate is compressed; a star keeps its horizontal position in all
  // three copies. Split the filtering footprint to preserve long star streaks
  // instead of allowing a large mip to blur the uncompressed dimension too.
  vec2 source=vec2(vUv.x,.5+across*.48);
  vec2 along=vec2(1.0/uResolution.x,0.0);
  vec2 footprint=vec2(0.0,.48/max(halfWidthPixels,1.0));
  vec3 light=vec3(0.0);
  for (int j=0;j<8;j++) {
    light+=backgroundGrad(source+footprint*((float(j)+.5)/8.0-.5),along,footprint/8.0);
  }
  return light/8.0;
}

vec3 surroundingLight(vec2 screenNormal, vec3 worldNormal) {
  // The final mip of each face contains its average radiance. All six faces
  // contribute, so bright space beside/behind the camera can light the band.
  vec3 ambient=textureLod(uSurroundings,vec3(1,0,0),6.0).rgb
    +textureLod(uSurroundings,vec3(-1,0,0),6.0).rgb
    +textureLod(uSurroundings,vec3(0,1,0),6.0).rgb
    +textureLod(uSurroundings,vec3(0,-1,0),6.0).rgb
    +textureLod(uSurroundings,vec3(0,0,1),6.0).rgb
    +textureLod(uSurroundings,vec3(0,0,-1),6.0).rgb;
  ambient/=6.0;
  vec3 directional=textureLod(uSurroundings,worldNormal,3.5).rgb;
  // Gather a broad strip of the visible background too, retaining changes
  // along the wake instead of colouring the entire rim uniformly.
  vec2 middle=vUv+screenNormal*dot(vec2(.5)-vUv,screenNormal);
  vec3 local=vec3(0.0);
  for (int j=0;j<7;j++) {
    vec2 uv=middle+screenNormal*(float(j)/6.0-.5)*.9;
    local+=backgroundLod(uv,4.0);
  }
  return ambient*.40+directional*.20+local*(.40/7.0);
}
vec3 bandLight(vec3 source, float concentration) {
  vec3 energy=source*concentration;
  // A luminance shoulder limits isolated hot stars without bleaching the
  // nebula colour or adding an independently coloured/emitting material.
  return energy/(1.0+dot(energy,vec3(.2126,.7152,.0722))*.45);
}
vec3 illuminateBand(vec3 base, vec2 screenNormal, vec3 worldNormal,
                    float across, float halfWidthPixels, float fade, float strength, float edgeGlow) {
  if (abs(across)>4.0 || fade<=0.0 || uIntensity<=0.0) return base;
  float opacity=(1.0-smoothstep(.65,1.0,abs(across)))*fade*uEntrance*min(1.0,uIntensity*.5);
  if (uBandGlow<.5) {
    float mask=1.0-smoothstep(.88,1.0,abs(across));
    float visibility=fade*uEntrance*min(1.0,uIntensity*.5);
    vec3 projected=projectedSpace(clamp(across,-1.0,1.0),halfWidthPixels);
    // Recover light lost to minification, retaining the actual projected
    // stars/nebula rather than filling the ribbons with average ambient light.
    float compression=.48*uResolution.y/max(halfWidthPixels,1.0);
    float gain=clamp(sqrt(compression)*1.3,4.0,18.0)*mix(.75,1.0,strength);
    vec3 detail=bandLight(projected,gain*(1.0+edgeGlow*2.0));
    vec3 color=mix(base,detail,mask*visibility);
    if (edgeGlow>0.0) {
      // Bloom only the projected outer ribbons. The five samples integrate
      // their colours across the band; nothing is added when space is dark.
      vec3 halo=vec3(0.0);
      float spread=.55+edgeGlow*.3;
      for (int j=0;j<5;j++) {
        float offset=(float(j)-2.0)*.4;
        float distance=(across-offset)/spread;
        halo+=bandLight(projectedSpace(offset,halfWidthPixels),gain)*exp(-distance*distance*.5);
      }
      color+=halo*(edgeGlow*.18)*(1.0-smoothstep(3.0,4.0,abs(across)))*visibility;
    }
    return color;
  }
  vec3 compressed=compressedSpace(screenNormal,clamp(across,-1.0,1.0),halfWidthPixels);
  vec3 gathered=surroundingLight(screenNormal,worldNormal);
  // Concentrating a wide strip into a few pixels must also concentrate light.
  float compression=.46*length(screenNormal*uResolution)/max(halfWidthPixels,1.0);
  float gain=clamp(sqrt(compression)*2.2,10.0,32.0);
  vec3 detail=bandLight(compressed,gain)*strength;
  vec3 glow=bandLight(gathered,40.0);
  float core=exp(-across*across*1.8);
  float halo=exp(-across*across*.32)*uBloom*.38;
  vec3 color=mix(base,detail,opacity*.70);
  return color+glow*(core+halo)*fade*uEntrance*uIntensity*strength;
}

void main() {
  vec4 vr=uInverseProjection*vec4(vUv*2.0-1.0,1.0,1.0);
  vec3 originalDirection=normalize(mat3(uCameraMatrix)*vr.xyz);
  vec3 direction=originalDirection;
  vec3 ro=uCameraPosition;
  vec2 bounds=intersectBox(ro,direction);
  float nearT=max(0.0,bounds.x),farT=bounds.y;
  if (farT<=nearT) { gl_FragColor=vec4(backgroundAt(vUv),1.0); return; }
  vec3 p=ro+direction*nearT;
  float travelled=nearT;
  float closest=1e5;
  vec3 rimPoint=p, rimNormal=vec3(0.0,1.0,0.0);
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
    vec3 gradient=vec3(-2.0*y*shape.slope.w/(scale*scale)-2.0*y*y*scaleSlope/(scale*scale*scale)-2.0*depth*shape.slope.z,2.0*y/(scale*scale),2.0*p.z);
    float implicitDistance=dot(radial,radial)-depth*depth;
    if (p.x<10.0) { implicitDistance=dot(p.yz,p.yz)-2.7*p.x; gradient=vec3(-2.7,2.0*p.y,2.0*p.z); }
    if (p.x>=uTailCap.x) {
      vec3 radii=vec3(uTailCap.y-uTailCap.x,p.y>=0.0?uTailCap.z:uTailCap.w,(uTailCap.z+uTailCap.w)*.5);
      vec3 q=(p-vec3(uTailCap.x,0.0,0.0))/radii;
      implicitDistance=dot(q,q)-1.0;
      gradient=2.0*q/radii;
    }
    float baseDistance=implicitDistance/max(length(gradient),.001);
    vec3 baseNormal=gradient/max(length(gradient),.0001);
    if (baseDistance<closest) {
      closest=baseDistance; rimPoint=p; rimNormal=baseNormal;
    }
    float wake=smoothstep(8.0,130.0,p.x);
    float minStep=.035+max(p.x,0.0)*.0012;
    float stepSize=min(clamp(abs(baseDistance)*.42,minStep,(farT-nearT)/22.0),farT-travelled);
    vec3 nextDirection=direction;
    float axialFade=smoothstep(-1.5,.1,p.x)*tailFade(p.x);
    if (axialFade>0.0 && abs(baseDistance)<(3.0+wake*8.0)) {
      vec2 uv=vec2(clamp(p.x/LENGTH,.001,.999),fract(atan(radial.y,radial.x)/TAU+.5));
      vec3 surface=texture2D(uFluid,uv).rgb;
      float deform=(.32+wake*2.9)*uTurbulence;
      vec2 du=vec2(.004,0.0),dv=vec2(0.0,.009);
      float dx=(displacement(texture2D(uFluid,uv+du).rgb)-displacement(texture2D(uFluid,uv-du).rgb))/(.008*LENGTH);
      float da=(displacement(texture2D(uFluid,uv+dv).rgb)-displacement(texture2D(uFluid,uv-dv).rgb))/(.018*TAU);
      vec3 angularGradient=vec3(0.0,-radial.y/(r*r*scale),radial.x/(r*r));
      vec3 rippleGradient=deform*(vec3(dx,0.0,0.0)+da*angularGradient);
      float lensWidth=.18+max(p.x,0.0)*.009;
      float opticalRipple=mix(.22,.08,wake);
      float lensDistance=baseDistance-displacement(surface)*deform*opticalRipple;
      float edge=clamp((lensDistance+lensWidth)/(lensWidth*2.0),0.0,1.0);
      float strength=.085*uLensing*uEntrance*axialFade;
      float index=1.0+strength*(1.0-edge*edge*(3.0-2.0*edge));
      vec3 gradLogIndex=-strength*6.0*edge*(1.0-edge)/(lensWidth*2.0)*(baseNormal-rippleGradient*opticalRipple)/index;
      nextDirection=normalize(direction+(gradLogIndex-direction*dot(direction,gradLogIndex))*stepSize);
    }
    p+=normalize(direction+nextDirection)*stepSize;
    direction=nextDirection; travelled+=stepSize;
  }
  vec3 color=backgroundAlong(direction);

  // A thin optical ribbon at the silhouette; no emitting gas or dye shading.
  float worldPixel=2.0*length(rimPoint-ro)/(uProjection[1][1]*uResolution.y);
  float width=max(.045+smoothstep(8.0,150.0,rimPoint.x)*1.15,worldPixel*1.25);
  if (uBandGlow<.5) width=max(width*1.8,worldPixel*4.0)*uProjectionWidth;
  float across=closest/width;
  float fade=smoothstep(-.5,1.0,rimPoint.x)*tailFade(rimPoint.x);
  vec2 normal=normalize((projectPosition(rimPoint+rimNormal)-projectPosition(rimPoint))*uResolution+vec2(.00001));
  color=illuminateBand(color,normal,rimNormal,across,width/worldPixel,fade,1.0,uEdgeGlow);

  // Project the field axis and compress the same background into its narrow
  // central ribbon. There is no separate luminous fluid stream here either.
  float axisT=-dot(ro.yz,originalDirection.yz)/max(dot(originalDirection.yz,originalDirection.yz),.0001);
  vec3 axisRay=ro+originalDirection*max(0.0,axisT);
  vec3 axis=vec3(axisRay.x,0.0,0.0);
  vec2 axisUv=projectPosition(axis);
  vec2 axisNormal=normalize((projectPosition(axis+vec3(0,1,0))-axisUv)*uResolution+vec2(.00001));
  float axisPixel=2.0*length(axis-ro)/(uProjection[1][1]*uResolution.y);
  float halfWidth=max(.05+smoothstep(8.0,150.0,axis.x)*.49,axisPixel*1.35)/axisPixel;
  if (uBandGlow<.5) halfWidth=max(halfWidth*1.8,3.0)*uProjectionWidth;
  float centerAcross=dot((vUv-axisUv)*uResolution,axisNormal)/halfWidth;
  // The ship's stern is at x≈5.82. Leave a small gap, then bring the
  // broader, softer centre stream in gradually behind it.
  float centerFade=smoothstep(6.2,8.5,axis.x)*tailFade(axis.x);
  centerFade*=1.0-smoothstep(.85,.98,abs(originalDirection.x));
  color=illuminateBand(color,axisNormal,vec3(0.0,1.0,0.0),centerAcross,halfWidth,centerFade,.38,0.0);
  gl_FragColor=vec4(color,1.0);
}`;

export const lensFragment = /* glsl */`
uniform sampler2D tDiffuse;
uniform float uTime;
uniform float uBloom;
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
  c += flare * vec3(.04, .08, .15) * (uBloom/.65);
  c *= 1.0 - .45 * dot(p * vec2(.85, 1.0), p);
  // No animated grain: stable highlights matter more than a film overlay here.
  gl_FragColor = vec4(max(c, vec3(0.0)), 1.0);
}`;
