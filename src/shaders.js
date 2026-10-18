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
// Hermite-weighted lookups: the same seeded lattice without the creases of
// plain trilinear interpolation, which show when the nebula is magnified.
vec4 smoothLattice(vec3 p) {
  vec3 i=floor(p), f=fract(p);
  return texture(uNoise,(i+f*f*(3.0-2.0*f)+.5)/64.0);
}
float smoothNoise(vec3 p) { return smoothLattice(p).r; }
float smoothFbm(vec3 p) {
  return smoothNoise(p)*.50+smoothNoise(p*2.03+17.1)*.26
    +smoothNoise(p*4.07+31.7)*.15+smoothNoise(p*8.13+11.2)*.09;
}
`;

// Film finish (src/film.js). It runs last, after tone mapping and FXAA, on
// the display-referred frame, so the antialiasing cannot smear the grain.
// A half-resolution Gaussian of the finished frame, run twice across and
// never down, feeds the depth of field and the light on the speed dust: 9
// taps folded into 5 bilinear ones per pass. Horizontal only, so the
// defocused star dashes stay thin dashes, as in the clip, instead of
// spreading into faint smudges.
export const filmBlurFragment = /* glsl */`
uniform sampler2D tDiffuse;
uniform vec2 uStep;
varying vec2 vUv;
void main() {
  vec3 c=texture2D(tDiffuse,vUv).rgb*.2270270;
  c+=(texture2D(tDiffuse,vUv+uStep*1.3846154).rgb+texture2D(tDiffuse,vUv-uStep*1.3846154).rgb)*.3162162;
  c+=(texture2D(tDiffuse,vUv+uStep*3.2307692).rgb+texture2D(tDiffuse,vUv-uStep*3.2307692).rgb)*.0702703;
  gl_FragColor=vec4(c,1.0);
}`;

export const filmFragment = /* glsl */`
${noise}
uniform sampler2D tDiffuse, tBlur, uProfile;
uniform vec2 uResolution, uDustFlow;
uniform mat4 uInverseProjection, uCameraMatrix;
uniform vec3 uCameraPosition;
uniform vec4 uDustPhase;
uniform float uGrain, uSoftness, uFocus, uDust, uGrade, uLetterbox;
uniform float uFrame, uFocusNear, uDustNear, uDustArea;
varying vec2 vUv;
const float FIELD_LENGTH=390.0;
// Stable dust light: the mip level of the half-resolution blur that each of
// the nine frame-light taps reads. Its texels are a fortieth of the frame
// wide, so each bilinear tap averages a patch about a twentieth of the frame
// across and an eighth of its height.
const float DUST_AREA_LOD=4.0;
const vec3 LUMA=vec3(.2126,.7152,.0722);

// Integer hash: the same seed always gives the same grain, so a paused frame
// is bit-identical; the seed is the simulation frame, never the wall clock.
uint hash3(uvec3 v) {
  v=v*1664525u+1013904223u;
  v.x+=v.y*v.z; v.y+=v.z*v.x; v.z+=v.x*v.y;
  v^=v>>16u;
  v.x+=v.y*v.z; v.y+=v.z*v.x; v.z+=v.x*v.y;
  return v.x^v.y^v.z;
}
float random(vec2 cell,float layer) {
  uvec3 v=uvec3(ivec3(cell+16384.0,layer));
  return float(hash3(v)>>8)/16777216.0;
}
// Fine, soft grain: two layers of value noise on lattices a little over a
// pixel across, turned off the pixel grid so no rows or columns show.
float grainAt(vec2 pixel) {
  float cell=max(1.0,uResolution.y/420.0);
  float g=0.0;
  for (int i=0;i<2;i++) {
    vec2 p=(i==0?mat2(.8,-.6,.6,.8):mat2(.28,.96,-.96,.28))*pixel/cell;
    vec2 c=floor(p), f=fract(p);
    f=f*f*(3.0-2.0*f);
    float layer=mod(uFrame,4096.0)*2.0+float(i);
    float a=random(c,layer), b=random(c+vec2(1.0,0.0),layer);
    float d=random(c+vec2(0.0,1.0),layer), e=random(c+vec2(1.0,1.0),layer);
    g+=mix(mix(a,b,f.x),mix(d,e,f.x),f.y);
  }
  return g-1.0;
}

// How far this pixel's view ray passes from the warp field, in local field
// radii: small on the field (in focus), large for the space beyond it.
float fieldDistance(vec2 uv) {
  vec4 view=uInverseProjection*vec4(uv*2.0-1.0,1.0,1.0);
  vec3 d=normalize(mat3(uCameraMatrix)*view.xyz), o=uCameraPosition;
  float across=d.y*d.y+d.z*d.z;
  float t=across>1e-6?max(0.0,-(o.y*d.y+o.z*d.z)/across):0.0;
  vec3 p=o+d*t;
  float x=clamp(p.x,0.0,FIELD_LENGTH);
  vec4 size=texture2D(uProfile,vec2((x/FIELD_LENGTH*1023.0+.5)/1024.0,.5));
  float radius=max(x<10.0?sqrt(2.7*x):max(size.x,size.y),1.5);
  return length(vec3(p.x-x,p.y,p.z))/radius;
}

// Out-of-focus gas close to the lens, smeared along the flight by the
// shutter. Three depths (nearer is larger and brighter) and a faint veil.
// It moves only with travelled distance, along the on-screen flight path.
// rgb: the light it adds; a: how much its haze greys the colours behind it.
// The light is mostly in distinct blobs; the veil only greys the colours a
// little, so the frame gains soft shapes rather than a smoky grey cast.
vec4 speedDust(vec2 uv,vec3 ambient) {
  float flow=length(uDustFlow);
  if (flow<.05) return vec4(0.0);
  vec2 f=uDustFlow/flow;
  vec2 s=(uv-.5)*vec2(uResolution.x/uResolution.y,1.0);
  float a=dot(s,f), b=dot(s,vec2(-f.y,f.x));
  // The gas belongs with the banks below the field, so it is denser low.
  float low=mix(1.0,.22,smoothstep(-.30,.25,b));
  vec3 dust=vec3(0.0);
  for (int i=0;i<3;i++) {
    float k=float(i)*.5;
    vec2 scale=vec2(mix(.9,2.2,k),mix(4.0,9.0,k));
    vec3 p=vec3(a*scale.x-uDustPhase[i],b*scale.y+float(i)*9.7,7.0+float(i)*19.0);
    vec4 n=smoothLattice(p);
    vec4 m=smoothLattice(p*vec3(2.0,2.4,1.0)+vec3(3.1,1.7,5.3));
    // Sparse, distinct clumps with soft edges and brighter, smeared cores.
    // The nearest layer has the fewest, largest and brightest clumps.
    float body=n.r*.66+m.r*.34;
    float blob=i==0?smoothstep(.64,.78,body):smoothstep(.63,.80,body);
    blob*=.55+.45*smoothstep(.70,.86,body)+.5*smoothstep(.55,.85,m.g);
    vec3 tint=mix(vec3(.50,.62,.78),vec3(.60,.62,.64),smoothstep(.55,.80,n.b));
    dust+=tint*blob*low*(i==0?1.5:mix(.75,.35,k));
  }
  float veil=smoothstep(.30,.85,smoothNoise(vec3(a*.55-uDustPhase.w,b*1.6,61.0)));
  dust+=vec3(.10,.14,.18)*.25*veil*mix(.5,1.0,low);
  // Lit only by the space around it, near and across the frame: brighter
  // against the bright banks, faint over the dark interiors, and invisible
  // if space is black, so it never reads as a grey smudge on the lens.
  float light=3.0*dot(ambient,LUMA);
  float amount=uDust*uDustNear*flow;
  return vec4(dust*light*amount,min(amount*(.06+.14*veil),.22));
}

// Blue toward teal with occasional magenta. Every step keeps black at
// black, so the black-level lift (done once, in liftBlacks) is not repeated.
vec3 grade(vec3 c) {
  float l=dot(c,LUMA);
  vec3 t=c;
  // Teal: red is pulled out of the blues (toward cyan), and a little blue
  // moves into green. The same red axis pushes the pink-violet gas further
  // toward magenta, so magenta appears only where the gas already has it.
  t.r+=.32*(c.r-l);
  float shift=(c.b-c.g)*.09;
  t.g+=shift; t.b-=shift;
  // Pulling red out darkens the blue sky a little; that brightness is put
  // back, so the grade does not dim the frame (black stays black). Where the
  // shift into green already brightens a strongly saturated blue, it is left
  // as it is: scaling that back down would dim the blue channel itself.
  t=max(t,vec3(0.0));
  t*=max(1.0,l/max(dot(t,LUMA),1e-4));
  // Close to the field (the opening of the reference sequence, the bow
  // view) everything is seen through the near gas, so the grade is greyer
  // there, as in the clip's opening; the wide shots keep their saturated
  // blue. Elsewhere only the most saturated colour is tamed. The deep
  // shadows keep Black level's blue.
  float haze=.35*uFocusNear*smoothstep(.03,.15,l);
  float chroma=max(t.r,max(t.g,t.b))-min(t.r,min(t.g,t.b));
  t=mix(vec3(dot(t,LUMA)),t,(1.0-haze)*(1.0-.25*smoothstep(.45,.90,chroma)));
  // No highlight shoulder here: the filmic tone mapping before FXAA already
  // rolls the highlights off, and a second shoulder capped white at about
  // 80%, greying the hero flash and the brightest crest.
  return max(t,vec3(0.0));
}

void main() {
  vec2 uv=vUv;
  vec2 texel=1.0/uResolution;
  vec3 c=texture2D(tDiffuse,uv).rgb;
  // Softness everywhere, plus depth of field away from the field. The focus
  // follows the camera: close to the field, the space beyond it is far out.
  // At the defaults the two together stay within the fine 4-tap blend, so
  // the thin star dashes stay distinct; only Depth of field above 100% mixes
  // in the wider half-resolution blur (horizontal, so dashes stay dashes).
  float blur=min(uSoftness*.4,1.0);
  if (uFocus>0.0 && uFocusNear>0.0) blur+=uFocus*uFocusNear*.6*smoothstep(1.2,3.2,fieldDistance(uv));
  if (blur>0.0) {
    vec3 soft=(texture2D(tDiffuse,uv+texel*vec2(.5,.75)).rgb+texture2D(tDiffuse,uv+texel*vec2(-.75,.5)).rgb
      +texture2D(tDiffuse,uv+texel*vec2(-.5,-.75)).rgb+texture2D(tDiffuse,uv+texel*vec2(.75,-.5)).rgb)*.25;
    c=blur<=1.0?mix(c,soft,blur):mix(soft,textureLod(tBlur,uv,0.0).rgb,min(blur-1.0,1.0));
  }
  if (uDust>0.0 && uDustNear>0.0) {
    // The near gas veils the colours behind it, then adds its own light:
    // from the space just behind it and, across the frame, nine taps of
    // the blurred frame. With Stable dust light (uDustArea) each tap is a
    // broad patch, a coarse mip level, so a bright star dash sliding
    // through one cannot make the whole frame's dust pulse.
    vec3 frame=vec3(0.0);
    for (int i=0;i<9;i++) frame+=textureLod(tBlur,vec2(.2+.3*float(i%3),.25+.25*float(i/3)),uDustArea*DUST_AREA_LOD).rgb/9.0;
    vec4 dust=speedDust(uv,textureLod(tBlur,uv,0.0).rgb*.55+frame*.45);
    c=mix(c,vec3(dot(c,LUMA)),dust.a)+dust.rgb*(1.0-c);
  }
  if (uGrade>0.0) c=mix(c,grade(c),uGrade);
  // The vignette is not here: it is optical, so the lens pass applies it
  // once, in scene light (see Lens › Vignette).
  float bar=uLetterbox;
  if (uGrain>0.0) {
    // Multiplicative, so black stays black; strongest in the mid-tones.
    float l=dot(c,LUMA);
    c*=1.0+uGrain*.05*grainAt(gl_FragCoord.xy)*smoothstep(.0,.10,l)*(1.0-.55*l);
    // A zero-mean, sub-level dither breaks the banding in the deep shadows.
    // It fades out at pure black, where clipping would bias it upward.
    float dither=random(gl_FragCoord.xy,uFrame*2.0+8191.0)+random(gl_FragCoord.xy+vec2(733.0,211.0),uFrame*2.0+8191.0)-1.0;
    c+=dither*min(uGrain,1.0)*clamp(l*127.5,0.0,1.0)/255.0;
  }
  if (bar>0.0) {
    float edge=min(uv.y,1.0-uv.y)*uResolution.y-bar*uResolution.y;
    c=mix(vec3(.012,.035,.043),c,clamp(edge+.5,0.0,1.0));
  }
  gl_FragColor=vec4(clamp(c,0.0,1.0),1.0);
}`;

// A brighter, filamentary nebula for the backdrop. Two levels of domain
// warping fold the fbm into banks, wisps and dark dust lanes; it is fixed in
// the passing world (only travelled distance moves it) and denser below the
// field. Nebula brightness/density at zero leave only the original faint fog.
// The volume shaders declare the first two uniforms themselves, so the gas
// that reacts to the field (gasNearField below) includes only the function.
const nebulaUniforms = /* glsl */`
uniform float uNebula, uNebulaDensity, uNebulaGlow;`;
const nebulaFunction = /* glsl */`
// rgb: emitted colour, a: density. 'hot' marks sparse emissive cores.
vec4 nebulaAt(vec3 world, float horizon, out float hot) {
  vec3 p=vec3((world.x-uTravel)*.0135,world.y*.0175,world.z*.0145)+vec3(41.0,13.0,7.0);
  vec4 broad=smoothLattice(p*.33+vec3(5.0,11.0,3.0));
  vec3 q=p+(broad.rgb-.5)*vec3(2.6,1.3,2.2);
  vec4 shear=smoothLattice(q*vec3(1.05,1.8,1.35)+vec3(9.0,4.0,1.0));
  vec3 r=q+(shear.rgb-.5)*vec3(.80,.45,.70);
  vec3 rb=r*vec3(.62,1.65,1.3);
  float large=smoothNoise(rb)*.50+smoothNoise(rb*2.03+17.1)*.26;
  // The finer octaves are drawn out along the flight path, so the banks read
  // as gas streaming past at warp rather than as billowing cumulus.
  vec3 rs=r*vec3(.26,1.65,1.3);
  float body=large+smoothNoise(rs*4.07+31.7)*.15+smoothNoise(rs*8.13+11.2)*.09;
  // Ridged noise gives sparse bright filaments and dark dust lanes.
  float filament=pow(1.0-abs(smoothNoise(r*vec3(.45,3.4,2.1)+5.0)*2.0-1.0),8.0);
  float lane=pow(1.0-abs(smoothNoise(q*vec3(.70,2.4,1.4)+27.0)*2.0-1.0),6.0);
  // Banks pile up below the field; above it a thinner, patchier bank.
  float below=smoothstep(.25,-.35,horizon+(body-.5)*.45);
  float cover=body+.16*below-.08;
  float density=smoothstep(mix(.48,.47,below),.74,cover)*mix(.55,1.0,below);
  density+=filament*smoothstep(.38,.60,cover)*.30*mix(.45,1.0,below);
  density*=1.0-.80*lane*smoothstep(.25,.55,body);
  // Erode the banks with fine streaks stretched along the flight path, so
  // they break into wisps and lanes instead of a soft, even fog.
  float grain=smoothNoise(r*vec3(.70,13.0,8.5)+23.0);
  density=clamp((density-grain*.30)/(1.0-grain*.30),0.0,1.0);
  // Long streaks along the flight path break the banks into bright sheets
  // and dark gaps, the way gas smears past at warp.
  float streak=smoothNoise(r*vec3(.16,7.5,5.0)+51.0)*.65+smoothNoise(r*vec3(.30,15.0,10.0)+7.0)*.35;
  density*=.35+1.15*smoothstep(.30,.72,streak);
  density*=uNebulaDensity;
  // Key light from above: where the gas thins upward the bank has a lit top,
  // where it thickens upward it is the shadowed belly of the bank above.
  vec3 ru=rb+vec3(.05,.22,.04);
  float largeUp=smoothNoise(ru)*.50+smoothNoise(ru*2.03+17.1)*.26;
  float key=clamp(.45+(large-largeUp)*11.0,0.0,1.0);
  // Billows: a finer lattice gives bright cores and darker hollows inside.
  float billow=smoothNoise(r*vec3(.50,4.0,3.2)+19.0)*.65+smoothNoise(r*vec3(1.0,8.1,6.4)+3.0)*.35;
  float lit=smoothstep(.35,.85,billow)*smoothstep(.48,.72,cover);
  lit=clamp(lit*.55+key*smoothstep(.40,.62,cover)*.55,0.0,1.0);
  // Colour: dark navy body, pale blue-white lit tops, pink-violet highlights.
  // The body is kept dark and the lit gas bright, so the banks have depth
  // instead of reading as an even pale wash.
  float core=smoothstep(.54,.84,cover)*(.25+.75*lit);
  vec3 color=mix(vec3(.008,.030,.095),vec3(.024,.14,.36),smoothstep(.42,.66,cover));
  color*=.16+1.70*lit*lit;
  color=mix(color,vec3(.40,.74,1.0)*(.6+.8*lit),core*.80);
  // Deep in the banks the gas is denser and brighter.
  color*=mix(.75,1.35,below);
  // Pink-violet belongs to the lit, dense cores, not the thin fringes.
  float violet=smoothstep(.50,.70,shear.g*.55+broad.b*.45)*smoothstep(.54,.78,cover)*lit*uNebulaGlow;
  color=mix(color,vec3(.82,.45,.95)*(.7+.6*lit),min(violet*.90,1.0));
  // Sparse hot knots inside the densest banks.
  hot=smoothstep(.55,.76,shear.b*.45+broad.g*.30+billow*.25)*smoothstep(.48,.78,cover)*smoothstep(.10,.50,density)*uNebulaGlow;
  return vec4(color,density);
}
`;
const nebula = nebulaUniforms + nebulaFunction;

// The gas reacts to the field (Effects › Gas). The field moves through the
// nebula like a body through a stream: the gas is deflected around it, never
// through it. Seen from the field, that is a steady potential flow, so where
// the gas at any point came from is a pure function of the field's shape;
// nothing is simulated or accumulated, every frame stands on its own, and the
// gas only ever streams downstream (+x, the way the passing world moves).
//
// Slender-body theory: a line of sources along the axis, of strength U·dA/dx,
// carries the uniform stream around a body of revolution with cross-section
// A(x). Its stream function gives the radius r0 a streamline had far upstream
// as r0² = r² − Ā(x, r)/π, where Ā is A smoothed along the axis by the kernel
// ½r²/(s²+r²)^1.5 (as wide as the distance from the axis: the body's bumps
// are felt close to it and blur out farther away). Its velocity potential
// gives how far the gas lags behind the undisturbed stream (slowed ahead of
// the nose, sped up along the flanks). Both integrals are taken here, once
// per field shape, into a small 2D table indexed by x and the distance from
// the axis; the gas lookups read it with one bilinear tap.
// x from GAS_X0 over GAS_XSPAN, r = GAS_RMAX·v² (finer near the axis).
const gasFlowTable = /* glsl */`
const float GAS_X0=-96.0, GAS_XSPAN=576.0, GAS_RMAX=256.0;`;
export const gasFlowFragment = /* glsl */`
${gasFlowTable}
uniform sampler2D uProfile;
uniform vec2 uTailFade;
varying vec2 vUv;
const float LENGTH=390.0;
// Cross-section of the field in its round (normalised) coordinates: the
// half-width squared, so A/π. The last bubble fades out with the field.
float area(float x) {
  if (x<=0.0 || x>=LENGTH) return 0.0;
  if (x<10.0) return 2.7*x;
  float d=texture2D(uProfile,vec2((x/LENGTH*1023.0+.5)/1024.0,.5)).z;
  return d*d*(1.0-smoothstep(uTailFade.x,uTailFade.y,x));
}
void main() {
  float x=GAS_X0+GAS_XSPAN*vUv.x;
  // Rows nearer the axis than this repeat it: closer in, the slender-body
  // lag sharpens into a spike that the coarse table cannot follow.
  float r=max(GAS_RMAX*vUv.y*vUv.y,2.0);
  // Both kernels are sampled through their own cumulative distributions, so
  // a few dozen taps integrate them at any distance from the axis.
  float smoothed=0.0, lag=0.0;
  for (int i=0;i<32;i++) {
    float u=(float(i)+.5)/32.0;
    float t=2.0*u-1.0;
    smoothed+=area(x-r*t/sqrt(1.0-t*t));
    float s=r*sqrt(1.0/((1.0-u)*(1.0-u))-1.0);
    lag+=area(x-s)-area(x+s);
  }
  // r: the effective radius √(Ā/π); g: the lag (negative: behind the stream).
  gl_FragColor=vec4(sqrt(smoothed/32.0),lag*.25/(32.0*r),0.0,1.0);
}`;

// Shared by the backdrop and both volume shaders. uGas: interaction strength,
// layer thickness, pile-up and deflection (the last two already scaled by the
// strength). uGasBody is the field profile (upper, lower, half-width).
const gasFlow = /* glsl */`
${gasFlowTable}
uniform sampler2D uGasFlow, uGasBody;
uniform vec2 uGasTail;
uniform vec4 uGas;
const float GAS_LENGTH=390.0;
// How strongly the lag (slowed at the nose, sped up along the flanks) is shown.
const float GAS_LAG=2.5;
float gasTailFade(float x) { return 1.0-smoothstep(uGasTail.x,uGasTail.y,x); }
// Key light from above, as on the backdrop's banks: the gas on top of the
// field is lit, the underside of the gas below it less so (never unlit).
float gasKey(float up) { return .45+.55*smoothstep(-.8,.9,up); }
struct GasPoint {
  vec3 look;     // where this gas was in the undisturbed stream
  float outside; // 0 inside the field (no gas there), 1 outside
  float surface; // roughly how far outside the field's surface (world units)
  float radius;  // the field's local half-width
  float up;      // upward component of the direction from the axis (round coordinates)
  float stream;  // the radius this streamline had far upstream (constant along it)
};
GasPoint gasFlow(vec3 p) {
  GasPoint g;
  g.look=p; g.outside=1.0; g.surface=1e4; g.radius=0.0; g.up=p.y/max(length(p.yz),1e-4); g.stream=length(p.yz);
  // Beyond the table the stream is undisturbed (its edges fade to that, and
  // the deflection is gone 240 from the axis).
  if (p.x<GAS_X0 || p.x>GAS_X0+GAS_XSPAN || dot(p.yz,p.yz)>240.0*240.0) return g;
  vec3 size=p.x<10.0 ? vec3(sqrt(max(2.7*p.x,0.0)))
    : texture2D(uGasBody,vec2((min(p.x,GAS_LENGTH)/GAS_LENGTH*1023.0+.5)/1024.0,.5)).xyz;
  float fade=gasTailFade(p.x)*step(0.0,p.x);
  float depth=max(size.z,.002);
  float world=length(p.yz);
  // Round coordinates: the elliptical cross-section becomes a circle near the
  // field, and space is left round far from it.
  float scale=mix(max(p.y>=0.0?size.x:size.y,.002)/depth,1.0,smoothstep(1.5*depth,4.0*depth,world));
  float r=length(vec2(p.y/scale,p.z));
  g.up=p.y/scale/max(r,1e-4);
  g.outside=1.0-min(uGas.x,1.0)*sqrt(fade)*(1.0-smoothstep(depth-.6,depth+.6,r));
  g.surface=p.x<0.0 ? length(p) : world*(1.0-depth/max(r,1e-4));
  g.radius=depth*sqrt(fade);
  // Within about a radius of the surface the stream follows the local shape
  // (into every neck and over every bubble); farther out the table's smoothed
  // shape takes over. Faded out toward the table's edges.
  vec4 flow=texture2D(uGasFlow,vec2((p.x-GAS_X0)/GAS_XSPAN,sqrt(min(r,GAS_RMAX)/GAS_RMAX)));
  float near=1.0-smoothstep(0.0,1.0,(r-depth)/max(depth,1.0));
  float area=mix(flow.r*flow.r,depth*depth*fade,near*step(0.0,p.x));
  float edge=smoothstep(GAS_X0,GAS_X0+40.0,p.x)*(1.0-smoothstep(GAS_X0+GAS_XSPAN-40.0,GAS_X0+GAS_XSPAN,p.x))
    *(1.0-smoothstep(170.0,240.0,r));
  float deflect=min(.92,uGas.w*.80)*edge;
  float r0=sqrt(max(r*r-deflect*area,0.0));
  float ratio=r0/max(r,1e-4);
  g.stream=r0;
  g.look=vec3(p.x-uGas.w*GAS_LAG*edge*flow.g,p.y*ratio,p.z*ratio);
  return g;
}
`;

// The gas piled up against the field, sampled near the field itself, so it
// is truly in 3D: a compressed layer just outside the surface, deepest and
// densest under the field where the banks press against it, thin at the
// sides so the dark interiors stay clear, and nothing inside. The volume
// shaders gather its column along the view ray as they march and light it
// with the nebula, read where that gas came from upstream. Ahead of the
// rounded bow, compressed sheets stand off the nose: the bow shock.
const gasNearField = (declareTravel) => /* glsl */`
#ifdef GAS_FIELD
${declareTravel ? 'uniform float uTravel;' : ''}
uniform float uNebulaGlow, uGasDepth;
${nebulaFunction}
${gasFlow}
// Opacity per unit of column and density, how much brighter compressed gas
// glows than the bank it came from, and how far upstream the swept-up gas
// was gathered.
const float GAS_COLUMN=.22, GAS_GLOW=11.0, GAS_AMBIENT=1.5, GAS_SWEEP=55.0, GAS_SHEET=3.3;
const vec3 GAS_LUMA=vec3(.2126,.7152,.0722);
// The ambient luminance range over which the layer's light thins (pressed
// against a bright bank), and by how much at most; the weight of the broad
// outer bow-shock sheet and the range over which its clumps fill in.
const vec3 GAS_BRIGHT=vec3(.03,.09,.6);
const float GAS_WIDE_WEIGHT=.75;
const vec2 GAS_WIDE_CLUMPS=vec2(.38,.64);
// How deep the layer is under the field relative to elsewhere.
const float GAS_BELOW=.6;
// The farthest the layer reaches from the surface (three depths under the
// deepest bubble): the march gathers it only within this distance.
float gasLayerReach() { return 3.0*uGasDepth*(.40+.11*45.0)*(1.0+GAS_BELOW); }
// Excess gas (beyond the surrounding nebula) at distance d outside the
// surface. around: the direction from the axis in round coordinates.
float gasLayer(float d, vec3 p, float height, vec2 around) {
  float x=p.x;
  // Deeper and denser below the bubbles, where the banks are pressed against
  // them (round the nose the bow shock carries it).
  float below=smoothstep(.2*height,-.6*height,p.y)*smoothstep(8.0,50.0,x);
  // About a tenth of the local radius: thin round the slender nose, so it
  // follows its contour closely, deeper along the big bubbles, and deepest
  // under them, where the bank pressed against the lower surface is a deep,
  // lumpy volume rather than a skin.
  float h=uGasDepth*(.40+.11*height)*(1.0+GAS_BELOW*below);
  if (d<=0.0 || h<=0.0 || d>=3.0*h || x<-3.0) return 0.0;
  float pile=smoothstep(0.0,.25*h,d)*exp(-d/h)*(1.0-smoothstep(2.0*h,3.0*h,d));
  // Thin at the sides facing the camera of the wide shot, so the layer in
  // front of a bubble hardly veils its dark interior.
  float sides=mix(1.0,.3,around.y*around.y);
  // The march only covers the field's box: a very deep layer fades out
  // before it reaches the sides of the box instead of being cut off there.
  float box=smoothstep(-3.0,-2.4,x)*(1.0-smoothstep(48.0,64.0,abs(p.y)))*(1.0-smoothstep(52.0,69.0,abs(p.z)));
  // Round the slender nose the bow shock's sheets carry most of it, and over
  // the top of the nose and the first flank, where the dark sky above has
  // little to pile up, it is thinnest: an even skin there read as a glowing
  // outline of the rim.
  float top=smoothstep(-.2*height,.6*height,p.y);
  float nose=mix(.4-.2*top,1.0,smoothstep(4.0,30.0+40.0*top,x));
  // Thinner over the top all along.
  float above=top*smoothstep(8.0,50.0,x);
  return pile*sides*nose*(1.0+1.2*below)*(1.0-.45*above)*gasTailFade(x)*box;
}
// The same horizon the backdrop uses for this view ray, so the near gas is
// denser below the field exactly where the nebula behind it is.
float gasHorizon(vec3 ray) {
  vec3 h=uCameraPosition+ray*300.0;
  vec3 hp=vec3((h.x-uTravel)*.0062,h.y*.006,h.z*.006)+vec3(3.0,29.0,17.0);
  float rise=(smoothNoise(hp)-.5)*1.5+(smoothNoise(hp*2.7+11.0)-.5)*.6;
  return ray.y*3.0-.08+clamp(rise,-.55,.30);
}
// The light of compressed gas is the light of the space around it, never its
// own: brighter where the gas it came from is lit (the key light from above)
// and tinted toward that gas's colour, but black surroundings leave it black.
// (The hot cores are left to the banks: carried into the layer they made
// white hotspots against the surface.)
vec3 gasTint(vec3 cloud, vec3 ambient) {
  float lit=dot(cloud,GAS_LUMA);
  float level=dot(ambient,GAS_LUMA);
  return mix(ambient,level*cloud/max(lit,1e-3),.35)*GAS_AMBIENT*(.7+.6*smoothstep(.02,.5,lit));
}
// The gas the layer was gathered from: the nebula read upstream of where the
// gas at the layer's (column-weighted) centre came from, so it is lit and
// coloured like the banks the field ploughed through. One lookup per pixel,
// shared by the layer in front, the layer behind and the bow shock.
vec4 gasSource=vec4(0.0);
float gasSourceHot=0.0, gasSourceSet=0.0;
void gasGather(vec4 front, vec4 back, float horizon) {
  vec4 acc=front.w>=back.w ? front : back;
  if (acc.w<.01 || uGas.z<=0.0) return;
  GasPoint g=gasFlow(acc.xyz/acc.w);
  gasSource=nebulaAt(g.look-vec3(GAS_SWEEP,0.0,0.0),horizon,gasSourceHot);
  gasSourceSet=1.0;
}
// A framing-steady share of the light around the field (see gasAmbientAt).
vec3 gasSteadyAmbient=vec3(0.0);
// Light (rgb) and opacity (a) of one crossing of the layer: acc holds the
// column-weighted position (xyz) and the column itself (w, world units).
// It is broken into banks and gaps, and into strands drawn out along the
// streamlines.
vec4 gasShell(vec4 acc, vec3 ambient) {
  if (acc.w<.01 || uGas.z<=0.0) return vec4(0.0);
  vec3 p=acc.xyz/acc.w;
  GasPoint g=gasFlow(p);
  // Strands at fixed distances from the surface, so they run parallel to it
  // and wrap round the nose in concentric arcs (strands scaled to the local
  // layer depth fanned out from the nose in straight diagonals), drawn out
  // along the flow and carried downstream with it.
  vec2 dir=normalize(p.yz+vec2(1e-4,0.0));
  vec2 around=dir*(6.0+max(g.surface,0.0)*.55);
  // (The distance along the flow keeps one fixed scale: dividing the
  // travelled distance by a size that changes along the field combed it.)
  float along=g.look.x-uTravel;
  vec3 q=vec3(along*.060,around)+vec3(9.0,3.0,21.0);
  float streak=smoothNoise(q)*.62+smoothNoise(q*vec3(1.9,2.2,2.2)+7.0)*.38;
  float lumps=.15+1.35*smoothstep(.34,.74,streak);
  // Banks and clear gaps tens of units long, also carried downstream: the
  // layer breaks into lit stretches instead of following the surface as an
  // even, glowing outline. Under the field, where the bank is pressed
  // against the surface, the gaps only thin it and the banks swell into
  // brighter knots.
  float gaps=smoothstep(.40,.64,smoothNoise(vec3(along*.022,dir*1.5)+vec3(27.0,41.0,11.0)));
  float banks=mix(gaps,.45+.75*gaps,smoothstep(.1,-.5,g.up));
  float column=acc.w*GAS_COLUMN;
  // Denser where the gas it came from was dense, but never empty: the field
  // sweeps up gas wherever it goes, so the layer does not come and go with
  // the banks behind it.
  float alpha=(1.0-exp(-(.35+.65*min(gasSource.a,1.0))*lumps*banks*uGas.z*column))*nebulaOn();
  vec3 tint=gasTint(gasSource.rgb,ambient);
  // Lit from above like the banks: the layer on top of the field takes the
  // full key light, the underside of the layer below it about half.
  vec3 light=tint*gasKey(g.up)*uNebula*GAS_GLOW*(.3+.7*lumps)*alpha;
  // A soft shoulder: a layer pressed against a bright bank must not glare.
  light/=1.0+dot(light,GAS_LUMA)*6.0;
  // Over an already bright bank it adds knots and strands (its lumps still
  // glow, its thin parts hide the bank) rather than an overall lift.
  light*=1.0-GAS_BRIGHT.z*smoothstep(GAS_BRIGHT.x,GAS_BRIGHT.y,dot(ambient,GAS_LUMA))*(1.0-.6*smoothstep(.6,1.3,lumps));
  return vec4(light,alpha);
}

// The bow shock: compressed sheets standing off ahead of the rounded bow and
// sweeping back round it. Each is the space between two paraboloids
// r² = k(x + standoff) opening downstream, so the path through it is exact
// and it is brightest where the view grazes it, as an arc round the nose,
// even over a void. Strongest at the nose, weakening as it sweeps back, never
// cutting through the field, and broken into clumps that drift downstream
// with the gas. Two thin sheets hug the nose (the nested arcs of the Bow
// view); a third, broad and faint, stands well off it and carries the wide
// swirl round the nose in the wide shots, where the thin ones lie only a few
// pixels off the rim. Bow-shock thickness scales their stand-off and depth.
// The span of a ray inside the paraboloid r² < k(x - x0): an interval of t
// (empty when x > y).
vec2 gasParaboloidSpan(vec3 ro, vec3 rd, float k, float x0) {
  float a=dot(rd.yz,rd.yz), b=2.0*dot(ro.yz,rd.yz)-k*rd.x, c=dot(ro.yz,ro.yz)-k*(ro.x-x0);
  if (a<1e-6) {
    if (abs(b)<1e-6) return c<0.0?vec2(-1e6,1e6):vec2(1.0,0.0);
    return b>0.0?vec2(-1e6,-c/b):vec2(-c/b,1e6);
  }
  float disc=b*b-4.0*a*c;
  if (disc<=0.0) return vec2(1.0,0.0);
  float root=sqrt(disc);
  return vec2(-b-root,-b+root)/(2.0*a);
}
// The broad outer sheet shows only in the wider framings; in the close-ups it
// would crowd the bow. A pure function of the camera's distance from the nose.
float gasWideSheet() { return smoothstep(30.0,80.0,length(uCameraPosition)); }
const float GAS_WIDE_K=10.0, GAS_WIDE_STANDOFF=10.0, GAS_WIDE_WIDTH=2.5, GAS_SHOCK_END=100.0;
// The part of the view ray that can meet any sheet: inside the outermost
// paraboloid, in front of the camera and short of where every sheet has
// faded out. Empty (x >= y) when the ray misses them all.
vec2 gasShockBound(vec3 ro, vec3 rd) {
  if (uGas.y<=0.0) return vec2(1.0,0.0);
  float grow=.35+.65*uGas.y;
  // The softer, wider layer of the outermost sheet stands off farthest.
  vec2 span=gasWideSheet()>0.0 ? gasParaboloidSpan(ro,rd,GAS_WIDE_K,-GAS_WIDE_STANDOFF*grow-.5*GAS_WIDE_WIDTH*uGas.y-.01)
    : gasParaboloidSpan(ro,rd,2.7*1.55,-2.8*grow-.175*uGas.y-.01);
  span.x=max(span.x,0.0);
  if (abs(rd.x)>1e-5) {
    float t=(GAS_SHOCK_END-ro.x)/rd.x;
    if (rd.x>0.0) span.y=min(span.y,t); else span.x=max(span.x,t);
  } else if (ro.x>GAS_SHOCK_END) span=vec2(1.0,0.0);
  return span;
}
// One piece of a sheet, from t=a to t=b: its brightness, by the exact path.
// Beyond 'behind' (the field's front surface) it is seen through the
// field's dark interior, which passes 'through' of it.
float gasShockPiece(vec3 ro, vec3 rd, float a, float b, float sheet, float standoff, float width, float behind, float through) {
  a=max(a,0.0);
  if (b<=a) return 0.0;
  float tm=(a+b)*.5;
  vec3 m=ro+rd*tm;
  float rho=length(m.yz);
  vec3 size=m.x<10.0 ? vec3(sqrt(max(2.7*m.x,0.0)))
    : texture2D(uGasBody,vec2((min(m.x,GAS_LENGTH)/GAS_LENGTH*1023.0+.5)/1024.0,.5)).xyz;
  float d=m.x<10.0?(rho*rho-2.7*m.x)/sqrt(4.0*rho*rho+7.29):rho-max(size.x,size.y);
  bool broad=sheet>1.5;
  // (Within a few units of the camera, as on board, a sheet is out of focus
  // and out of the picture, like the layer.)
  float strength=exp(-max(m.x+standoff,0.0)/(broad ? 18.0 : 7.0+9.0*sheet))*smoothstep(0.0,1.5,d)*(tm>behind?through:1.0)*smoothstep(2.0,8.0,tm);
  if (strength<.002) return 0.0;
  // Clumps addressed by the position across the axis too, so the visible
  // arc breaks up along its length; they drift downstream with the gas. The
  // broad sheet's clumps are larger.
  float grain=broad ? .45 : 1.0;
  vec3 q=vec3((m.x*.09-uTravel*.015+rho*.35)*grain,m.y*.8*grain,m.z*.8*grain+sheet*9.0)+vec3(5.0,9.0,13.0);
  float clumps=smoothNoise(q)*.55+smoothNoise(q*vec3(2.2,2.7,2.7)+21.0)*.30+smoothNoise(q*vec3(4.1,5.3,5.3)+3.0)*.15;
  // Seen face-on (over the field) a sheet is a thin veil; seen edge-on, an
  // arc. (The broad sheet is deep, so a shorter grazing path saturates it.)
  float graze=broad ? 3.0 : 7.0;
  float path=min((b-a)/width,graze)/graze;
  // The outer thin sheet is sparser, so it never closes into a smooth shell.
  vec2 sparse=broad ? GAS_WIDE_CLUMPS : vec2(.47,.72)+vec2(.07,.04)*sheet;
  return strength*smoothstep(sparse.x,sparse.y,clumps)*path*sqrt(path)*7.0*gasKey(m.y/max(rho,.001));
}
float gasShockSlab(vec3 ro, vec3 rd, float k, float standoff, float width, float sheet, float behind, float through) {
  vec2 outerSpan=gasParaboloidSpan(ro,rd,k,-standoff);
  if (outerSpan.y<=outerSpan.x || outerSpan.y<=0.0) return 0.0;
  vec2 innerSpan=gasParaboloidSpan(ro,rd,k,-standoff+width);
  // A ray that misses the inner surface still crosses the sheet twice, on
  // the near side and the far side of the axis, so it is split where it
  // would first meet the inner surface; as one long piece it outshone its
  // neighbours, which drew a bright block at the broad sheet's apex.
  if (innerSpan.y<=innerSpan.x) {
    float split=(outerSpan.x+outerSpan.y)*.5;
    return gasShockPiece(ro,rd,outerSpan.x,split,sheet,standoff,width,behind,through)
      +gasShockPiece(ro,rd,split,outerSpan.y,sheet,standoff,width,behind,through);
  }
  return gasShockPiece(ro,rd,outerSpan.x,min(outerSpan.y,innerSpan.x),sheet,standoff,width,behind,through)
    +gasShockPiece(ro,rd,max(outerSpan.x,innerSpan.y),outerSpan.y,sheet,standoff,width,behind,through);
}
float gasBowShock(vec3 ro, vec3 rd, float behind, float through) {
  float wide=gasWideSheet();
  float grow=.35+.65*uGas.y;
  float shock=0.0;
  for (int i=0;i<3;i++) {
    float sheet=float(i);
    float standoff=(.6+2.2*sheet)*grow, width=(.15+.20*sheet)*uGas.y, k=2.7*(1.20+.35*sheet);
    float weight=1.0/(1.0+sheet*.6+sheet*sheet*.5);
    if (i==2) {
      if (wide<=0.0) break;
      standoff=GAS_WIDE_STANDOFF*grow; width=GAS_WIDE_WIDTH*uGas.y; k=GAS_WIDE_K; weight=GAS_WIDE_WEIGHT*wide;
    }
    // A sharper core inside a softer, wider layer, so the arc has no hard edge.
    shock+=gasShockSlab(ro,rd,k,standoff,width,sheet,behind,through)*weight*.7;
    shock+=gasShockSlab(ro,rd,k,standoff+.5*width,1.8*width,sheet,behind,through)*weight*.3;
  }
  return shock;
}
// Its light: the framing-steady light of the space around the field (so it
// reads over a void as well as over a bright bank), tinted like the gas swept
// up in front of the field here, or, where there is none, like the gas
// streaming onto the nose, read where it still is undisturbed (read through
// the flow, every ray ahead of the nose met the one streamline that ends on
// it and drew the shock in horizontal bars).
vec3 gasBowLight(vec3 ro, vec3 rd, float behind, float through, float horizon) {
  float shock=gasBowShock(ro,rd,behind,through);
  if (shock<.001) return vec3(0.0);
  vec4 swept=vec4(gasSource.rgb,gasSourceHot);
  if (gasSourceSet<.5) {
    float hot;
    vec4 cloud=nebulaAt(ro+rd*max(-dot(ro,rd),0.0)-vec3(GAS_SWEEP,0.0,0.0),horizon,hot);
    swept=vec4(cloud.rgb,hot);
  }
  // Only gently brighter where the swept gas is lit, so the shock is about
  // as bright over a void as over a bank.
  float lit=dot(swept.rgb,GAS_LUMA), level=dot(gasSteadyAmbient,GAS_LUMA);
  vec3 tint=mix(gasSteadyAmbient,level*swept.rgb/max(lit,1e-3),.35)*(.8+.4*smoothstep(.02,.5,lit)+.3*swept.a*swept.a);
  vec3 light=tint*shock*GAS_SHEET*uGas.x*uNebula*min(uNebulaDensity,1.0);
  return light/(1.0+dot(light,GAS_LUMA)*2.0);
}
// Whether the camera is inside the field (On board): then everything ahead,
// the bow shock included, is seen through the dark interior.
float gasCameraInside(vec3 ro) {
  if (ro.x<=0.0 || ro.x>=GAS_LENGTH) return 0.0;
  vec3 size=ro.x<10.0 ? vec3(sqrt(2.7*ro.x))
    : texture2D(uGasBody,vec2((ro.x/GAS_LENGTH*1023.0+.5)/1024.0,.5)).xyz;
  float depth=max(size.z,.002);
  float scale=max(ro.y>=0.0?size.x:size.y,.002)/depth;
  return length(vec2(ro.y/scale,ro.z))<depth ? 1.0 : 0.0;
}
#endif
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
${nebula}
#ifdef GAS_FIELD
${gasFlow}
#endif
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
  if (uNebula>0.0 && uNebulaDensity>0.0) {
    // Emission and absorption through six slices behind the field. Nearer
    // slices pass faster than farther ones, so the gas has depth and parallax.
    // One shared, billowing upper boundary for the banks. It follows the
    // viewing elevation, so distant slices do not converge into a flat
    // horizon, and it is taken from the passing world so it moves with it.
    vec3 h=uCameraPosition+ray*300.0;
    vec3 hp=vec3((h.x-uTravel)*.0062,h.y*.006,h.z*.006)+vec3(3.0,29.0,17.0);
    float rise=(smoothNoise(hp)-.5)*1.5+(smoothNoise(hp*2.7+11.0)-.5)*.6;
    // Bounded, so the banks never close over the whole sky above the field.
    float horizon=ray.y*3.0-.08+clamp(rise,-.55,.30);
    // Composited back to front. Hot cores emit pink-white light, and the gas
    // in front of a core scatters it forward, so knots glow through the banks.
    vec3 gas=vec3(0.0), scattered=vec3(0.0);
    for (int i=5;i>=0;i--) {
      float hot;
#ifdef GAS_FIELD
      // The gas streams around the field and is absent inside it. Slices
      // outside the disturbed flow (beyond the flow table: in the wide shot,
      // the three far ones) return at once, unchanged.
      vec3 slice=uCameraPosition+ray*(190.0+float(i)*62.0);
      GasPoint flow=gasFlow(slice);
      vec4 cloud=nebulaAt(flow.look,horizon,hot);
      cloud.a*=flow.outside; hot*=flow.outside;
#else
      vec4 cloud=nebulaAt(uCameraPosition+ray*(190.0+float(i)*62.0),horizon,hot);
#endif
      float alpha=1.0-exp(-cloud.a*.95);
      vec3 core=vec3(1.0,.80,1.0)*hot*hot*2.4;
      gas=gas*(1.0-alpha*.75)+(cloud.rgb+core+scattered*(cloud.rgb*1.6+.06))*alpha;
      scattered=scattered*(1.0-alpha*.35)+vec3(.85,.70,1.0)*hot*alpha;
    }
    // Bright, dense gas scatters toward white rather than saturated blue, and
    // a soft shoulder keeps overlapping banks from bleaching. The shoulder is
    // gentle, so the hot cores still stand well above the body of the gas.
    gas*=uNebula*.35;
    float level=dot(gas,vec3(.2126,.7152,.0722));
    gas=mix(gas,vec3(level)*vec3(.92,.98,1.08),smoothstep(.06,.35,level)*.30);
    col+=gas/(1.0+level*2.2);
  }
  // The black-level lift is applied where space is seen (the field passes),
  // not here: this sky also feeds the light the field gathers and concentrates.
  gl_FragColor=vec4(col,1.0);
}`;

// Star streaks (STAR_STREAKS defined) stretch the brightest stars sideways.
// Without the define the shaders are exactly the original ones: even an
// inactive branch changed how the GPU compiler rounded the star quads.
export const starVertex = /* glsl */`
attribute vec4 aSeed;
uniform float uTravel;
uniform float uVelocity;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
varying float vForeground;
#ifdef STAR_STREAKS
uniform float uStarStreak;
varying float vStretch;
varying float vHot;
#endif
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
#ifdef STAR_STREAKS
  // Anamorphic star streaks: the sparse brightest stars reach well beyond
  // their shutter trail (by a fixed angle, so it does not depend on speed),
  // which leaves room for the long thin line their core is spread along.
  // An anamorphic lens streaks sideways on screen, so this fades out as the
  // flight turns away from screen-horizontal (looking down on the field in
  // Orbit, or along it in Ride), where the horizontal streak bloom alone
  // carries the look. dir is a unit vector: x is its sideways share.
  float sideways = smoothstep(.3, .8, abs(dir.x));
  vHot = pow(aSeed.w, 60.0) * sideways;
  float reach = len + uStarStreak * vHot * length(center.xyz) * .085;
  vStretch = reach / len;
  center.xyz += dir * position.x * reach;
#else
  center.xyz += dir * position.x * len;
#endif
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
#ifdef STAR_STREAKS
uniform float uStarStreak;
varying float vStretch;
varying float vHot;
#endif
void main() {
  if (abs(vForeground-uForeground)>.5) discard;
  vec2 p = abs(vUv * 2.0 - 1.0);
#ifdef STAR_STREAKS
  // The shutter trail keeps its own length inside the stretched quad.
  float tail = pow(max(0.0, 1.0 - p.x * vStretch), 1.3);
#else
  float tail = pow(max(0.0, 1.0 - p.x), 1.3);
#endif
  // Filter the bright core over a pixel footprint to prevent subpixel sparkle.
  float width = sqrt(.0036 + pow(fwidth(vUv.y*2.0), 2.0) / 12.0);
  float core = exp(-p.y*p.y/(width*width)) * (.06/width);
  float halo = exp(-p.y*p.y*6.0);
#ifdef STAR_STREAKS
  // A bright point through an anamorphic lens: less of the core stays in
  // the hot centre (which the round HDR bloom turned into a blob), and it
  // is spread along a long, thin horizontal line instead. The soft halo
  // narrows across the streak and follows it out.
  float k = min(uStarStreak, 1.5) * vHot;
  float line = pow(max(0.0, 1.0 - p.x), 2.4);
  float thin = exp(-p.y*p.y*6.0*(1.0 + 5.0*k));
  float lineCore = exp(-p.y*p.y/(width*width*.6)) * (.06/width);
  float radiance = tail * core*12.0*(1.0 - .65*min(k, 1.0))
    + line * lineCore*12.0*.45*k
    + mix(tail, line, min(k, 1.0)) * mix(halo, thin, min(k, 1.0)) * .55*(uBloom/.65);
#else
  float radiance = tail * (core*12.0 + halo*.55*(uBloom/.65));
#endif
  gl_FragColor = vec4(vColor*radiance, vAlpha);
}`;

// Hero sources: a few very bright, deterministic stars that pass behind the
// field. Each is a compact point with a short shutter trail; its size is a
// fixed angle, so it reads as a point source at any distance.
export const heroVertex = /* glsl */`
attribute vec4 aHero;     // phase, height, depth, speed
attribute vec4 aHeroLook; // period, size, warmth, brightness
uniform float uTravel, uVelocity, uHeroGain;
varying vec2 vUv;
varying vec3 vColor;
varying float vForeground, vTrail, vGain;
void main() {
  vUv = uv;
  vec3 world = vec3(mod(aHero.x + uTravel * aHero.w, aHeroLook.x) - aHeroLook.x * .5, aHero.y, aHero.z);
  // The same split as the stars: in front of the field it is composited
  // afterwards, so the field cannot bend it.
  vec3 toHero = world - cameraPosition;
  vec3 inv = 1.0 / (normalize(toHero) + vec3(.000001));
  vec3 entry = (vec3(-3.0, -65.0, -70.0) - cameraPosition) * inv;
  vec3 exit = (vec3(390.0, 65.0, 70.0) - cameraPosition) * inv;
  vec3 lo = min(entry, exit), hi = max(entry, exit);
  float nearT = max(max(lo.x, lo.y), lo.z), farT = min(min(hi.x, hi.y), hi.z);
  vForeground = farT > max(nearT, 0.0) && length(toHero) < nearT ? 1.0 : 0.0;
  vec4 center = modelViewMatrix * vec4(world, 1.0);
  float size = length(center.xyz) * .011 * aHeroLook.y;
  float len = .25 * uVelocity * aHero.w * .028;
  vec3 dir = mat3(modelViewMatrix) * vec3(1.0, 0.0, 0.0);
  vec2 side = normalize(vec2(-dir.y, dir.x) + .0001);
  center.xyz += dir * position.x * (len + size);
  center.xy += side * position.y * size;
  vTrail = len / (len + size);
  gl_Position = projectionMatrix * center;
  vColor = mix(vec3(.82, .92, 1.0), vec3(1.0, .86, .93), aHeroLook.z);
  vGain = aHeroLook.w * uHeroGain;
}`;

export const heroFragment = /* glsl */`
uniform float uForeground;
varying vec2 vUv;
varying vec3 vColor;
varying float vForeground, vTrail, vGain;
void main() {
  if (abs(vForeground-uForeground)>.5) discard;
  vec2 p = abs(vUv * 2.0 - 1.0);
  // Distance from the trail segment, in units of the source's size.
  float along = max(p.x - vTrail, 0.0) / max(1.0 - vTrail, .001);
  float r2 = along * along + p.y * p.y;
  float radiance = exp(-r2 * 16.0) * 1.6 + exp(-r2 * 4.5) * .22;
  gl_FragColor = vec4(vColor * radiance * vGain, 1.0);
}`;

// Projected stars (Effects › Projection). The world's stars and hero sources
// alone, with no nebula, are rendered into their own layer with the camera's
// pose; this pass turns that layer into the fourth power of its light, so
// that the mipmapped, anisotropically filtered average the field reads back
// across a band is the mean of the fourth powers there. Its fourth root is a
// power mean, which keeps a squeezed star close to its own brightness instead
// of averaging it into the gas (see starColumn() in volumeFragment). The
// averaging happens on the powers, linearly, so the result changes smoothly
// as a star slides between texels and nothing pops. Two bilinear taps blur
// the layer by a pixel across, which keeps the fourth power from beating as
// a star's core moves between rows; along a band, where the streaks run, it
// stays pixel-sharp. Stars fainter than the threshold are left out, so the
// faint ones do not fill the bands with a haze of dots. The layer is 32-bit
// float where the GPU can filter it; on half float, uStarPower (a scale and
// a clamp) keeps the powers of faint stars out of the coarse subnormal range
// (where their colour channels would round off unevenly) and the brightest
// short of overflow.
export const starPowerFragment = /* glsl */`
uniform sampler2D tStars;
uniform vec2 uStarTexel, uStarPower;
uniform float uStarThreshold;
varying vec2 vUv;
void main() {
  vec2 dy=vec2(0.0,uStarTexel.y*.5);
  vec3 s=(texture2D(tStars,vUv-dy).rgb+texture2D(tStars,vUv+dy).rgb)*.5;
  float level=dot(s,vec3(.2126,.7152,.0722));
  s*=max(level-uStarThreshold,0.0)/max(level,1e-6);
  vec3 v=min(s*uStarPower.x,vec3(uStarPower.y));
  v*=v;
  gl_FragColor=vec4(v*v,1.0);
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
vec3 backgroundAlongLod(vec3 direction,float level) {
  vec3 view=vec3(dot(direction,uCameraMatrix[0].xyz),dot(direction,uCameraMatrix[1].xyz),dot(direction,uCameraMatrix[2].xyz));
  if (view.z>=-.05) return textureLod(uOffscreenScene,direction,level).rgb;
  vec4 projected=uProjection*vec4(view,0.0);
  return backgroundLod(projected.xy/projected.w*.5+.5,level);
}
`;

// The bow close-up (Effects › Bow): colour dispersion, soap-film colours on
// the glass and nested arcs at the nose. Each part is compiled in only while
// its control is above 0 (BOW_DISPERSION, BOW_FILM, BOW_LAYERS, and
// BOW_LAYER_LENS for the Layered refraction experiment), so with the controls
// at 0 the shaders are exactly the earlier ones. uBow is (dispersion,
// iridescence, layer strength, layer spread).
const bowRefraction = /* glsl */`
#if defined(BOW_DISPERSION) || defined(BOW_FILM) || defined(BOW_LAYERS)
uniform vec4 uBow;
uniform float uFilmFlow;
// 1 round the nose, falling to 0 along the first flanks.
float bowNose(float x) { return 1.0-smoothstep(6.0,70.0,x); }
// The colour fringes are a length on the field, not a pixel count: full size
// (about a pixel) in the bow close-ups, where a pixel at the nose covers
// under BOW_FRINGE_WORLD units, and shrinking below a pixel as the camera
// pulls back, so the wide and orbit shots get no red/blue outline.
const float BOW_FRINGE_WORLD=.032, BOW_INTERIOR_SPREAD=.012;
float bowFringeScale(float worldPixel) { return min(1.0,BOW_FRINGE_WORLD/max(worldPixel,1e-4)); }
#endif
#ifdef BOW_DISPERSION
// Dispersion: red is bent a little less than green and blue a little more, so
// whatever the lens bends breaks into colour fringes where it bends most (at
// the rim, and most of all round the nose). bowDispersion() gives the ray's
// whole bend times that red/blue spread, or 0 where the fringe would be under
// about a fifth of a pixel; each volume shader passes it to interiorView()
// after its march. Where the nose folds the view through a large angle the
// fringe saturates softly at a few pixels (times the slider), so the folded
// image gets coloured edges rather than splitting into separate red and blue
// copies. Downstream both the strength and that limit fall to about a third,
// and with distance the limit follows bowFringeScale(), so the hairline lens
// ring along the wide shot's crest is not tinted.
vec3 bowDispersion(vec3 bent, vec3 straight, float x, float worldPixel) {
  float nose=bowNose(x);
  vec3 bend=(bent-straight)*uBow.x*.16*mix(.35,1.0,nose);
  float pixel=2.0/(uProjection[1][1]*uResolution.y);
  float cap=pixel*mix(1.5,3.5,nose)*uBow.x*bowFringeScale(worldPixel);
  bend*=cap/sqrt(dot(bend,bend)+cap*cap);
  return dot(bend,bend)>pixel*pixel*.04 ? bend : vec3(0.0);
}
vec3 backgroundAlongGrad(vec3 direction, vec2 gx, vec2 gy) {
  vec3 view=vec3(dot(direction,uCameraMatrix[0].xyz),dot(direction,uCameraMatrix[1].xyz),dot(direction,uCameraMatrix[2].xyz));
  if (view.z>=-.05) return textureLod(uOffscreenScene,direction,0.0).rgb;
  vec4 projected=uProjection*vec4(view,0.0);
  vec2 uv=projected.xy/projected.w*.5+.5;
  vec2 capture=sceneUv(uv);
  vec3 wide=textureGrad(tScene,clamp(capture,vec2(.001),vec2(.999)),gx,gy).rgb;
  vec3 beyond=textureLod(uOffscreenScene,sceneRay(uv),0.0).rgb;
  return mix(beyond,wide,sceneCoverage(capture));
}
// 'color' is the plain lookup along 'outgoing'. Red and blue are read again
// along the less and the more bent ray, with twice the plain lookup's filter
// footprint (its derivatives are taken here, in uniform control flow): a
// spectrum spreads continuously, so a bright streak gets soft colour fringes
// rather than three crisp primary-coloured copies.
vec3 disperse(vec3 color, vec3 outgoing, vec3 bend) {
  vec3 view=vec3(dot(outgoing,uCameraMatrix[0].xyz),dot(outgoing,uCameraMatrix[1].xyz),dot(outgoing,uCameraMatrix[2].xyz));
  vec4 projected=uProjection*vec4(view,0.0);
  vec2 capture=sceneUv(projected.xy/max(abs(projected.w),1e-4)*.5+.5);
  vec2 gx=dFdx(capture)*2.0, gy=dFdy(capture)*2.0;
  if (bend==vec3(0.0)) return color;
  vec3 red=backgroundAlongGrad(normalize(outgoing-bend),gx,gy);
  vec3 blue=backgroundAlongGrad(normalize(outgoing+bend),gx,gy);
  return vec3(red.r,color.g,blue.b);
}
#endif
`;

// Crest and interior helpers shared by the field appearances. All of their
// texture comes from the transported fluid dye, so it streams downstream with
// the flow. Included after profile() and displacement().
const fieldEffects = /* glsl */`
uniform float uCrestThickness, uCrestLight, uCrestVariation, uInteriorDarkness, uInteriorShrink, uEnergyRim, uNebula, uNebulaDensity, uBlackLevel;
// How much of the bright nebula is present. Everything that only makes sense
// against a bright sky (exposure, shoulders, occlusion) follows this, so either
// Nebula brightness or Nebula density at 0 restores the earlier look.
float nebulaOn() { return min(uNebula,1.0)*min(uNebulaDensity,1.0); }
// A soft knee on luminance: unchanged below 'start', then compressed so it
// approaches start+range. Keeps concentrated light from glaring to white.
vec3 knee(vec3 c, float start, float range) {
  float level=dot(c,vec3(.2126,.7152,.0722));
  if (level<=start) return c;
  float over=level-start;
  return c*(start+over/(1.0+over/range))/level;
}
// Lift the darkest space to a deep blue rather than black. Applied once, to
// the final field composite, so the light the field gathers never includes it.
// The lens pass's Vignette darkens the corners down to this same floor colour
// and no further (keep the two in step).
vec3 liftBlacks(vec3 c) {
  float level=dot(c,vec3(.2126,.7152,.0722));
  return c+uBlackLevel*vec3(.0042,.0068,.0105)*(1.0-smoothstep(0.0,.03,level));
}
uniform sampler2D uFluidPatches;

// Smooth placement of the crest and dark interior for one pixel. A marched
// minimum distance bands deep inside the field, so this solves the straight
// view ray against the local elliptical cross-section instead: its closest
// approach to the field axis, and where it first enters the front of the shell.
struct Section {
  float inside;   // 0 at the shell, 1 on the axis; negative outside
  float height;   // local half-height on this side
  float scale;    // vertical stretch of the cross-section
  float hit;      // the ray enters the shell in front of the camera
  float front;    // the entry (or the closest approach, for a miss) is in front
  float vertical; // -1 at the lower silhouette, 0 on the axis, 1 at the top
  vec3 side;      // outward direction of this side of the cross-section
  vec3 entry;     // front-face entry point
  vec2 uv;        // fluid coordinates of the entry point
  vec2 sideUv;    // fluid coordinates of the nearest silhouette
};
Section viewSection(vec3 ro, vec3 rd) {
  Section c;
  float t=-dot(ro.yz,rd.yz)/max(dot(rd.yz,rd.yz),.0001);
  float depth=1.0, scale=1.0, height=1.0;
  for (int k=0;k<3;k++) {
    vec3 p=ro+rd*max(t,0.0);
    Shape shape=profile(p.x);
    depth=max(shape.size.z,.002);
    height=p.y>=0.0?shape.size.x:shape.size.y;
    scale=max(height/depth,.001);
    float a=rd.y*rd.y/(scale*scale)+rd.z*rd.z;
    t=-(ro.y*rd.y/(scale*scale)+ro.z*rd.z)/max(a,.00001);
  }
  float a=max(rd.y*rd.y/(scale*scale)+rd.z*rd.z,.00001);
  vec3 nearest=ro+rd*t;
  float q=nearest.y*nearest.y/(scale*scale)+nearest.z*nearest.z;
  c.inside=1.0-sqrt(q)/depth;
  c.height=height; c.scale=scale;
  c.vertical=clamp(nearest.y/max(height,.001),-1.0,1.0);
  c.side=normalize(vec3(0.0,nearest.y/(scale*scale),nearest.z)+vec3(0.0,.00001,0.0));
  c.sideUv=vec2(clamp(nearest.x/LENGTH,.001,.999),fract(atan(nearest.z,nearest.y/scale)/TAU+.5));
  float entryT=t-sqrt(max(depth*depth-q,0.0)/a);
  c.hit=c.inside>0.0 && entryT>0.0 ? 1.0 : 0.0;
  c.front=entryT>0.0 ? 1.0 : 0.0;
  c.entry=ro+rd*max(entryT,0.0);
  c.uv=vec2(clamp(c.entry.x/LENGTH,.001,.999),fract(atan(c.entry.z,c.entry.y/scale)/TAU+.5));
  return c;
}
// Shell normal at the entry point, rippled by the dye's displacement field
// read at uv. The crest passes its own, stable lookup: the entry point races
// round the shell near the silhouette, and ripples read there beaded the arcs.
vec3 rippledNormal(Section c, vec2 uv) {
  vec3 e=c.entry;
  Shape shape=profile(e.x);
  float depth=max(shape.size.z,.002);
  float heightSlope=e.y>=0.0?shape.slope.x:shape.slope.y;
  float scaleSlope=(heightSlope*depth-c.height*shape.slope.z)/(depth*depth);
  vec3 gradient=vec3(-2.0*e.y*e.y*scaleSlope/(c.scale*c.scale*c.scale)-2.0*depth*shape.slope.z,2.0*e.y/(c.scale*c.scale),2.0*e.z);
  vec3 normal=normalize(gradient+vec3(0.0,.00001,0.0));
  float wake=smoothstep(8.0,130.0,e.x);
  float deform=(.32+wake*2.9)*uTurbulence;
  vec2 du=vec2(.004,0.0),dv=vec2(0.0,.009);
  float dx=(displacement(texture2D(uFluid,uv+du).rgb)-displacement(texture2D(uFluid,uv-du).rgb))/(.008*LENGTH);
  float da=(displacement(texture2D(uFluid,uv+dv).rgb)-displacement(texture2D(uFluid,uv-dv).rgb))/(.018*TAU);
  vec2 radial=vec2(e.y/c.scale,e.z);
  float r2=max(dot(radial,radial),.0001);
  vec3 angular=vec3(0.0,-radial.y/(r2*c.scale),radial.x/r2);
  return normalize(normal-deform*(vec3(dx,0.0,0.0)+da*angular)*1.2);
}
// Large bright and dim stretches: a low-pass of the broad dye channel.
float crestPatches(vec2 uv) {
  // Tent filter across neighbouring texels of the 64×32 patch texture.
  float broad=0.0;
  for (int j=0;j<5;j++) {
    float o=float(j)-2.0;
    broad+=texture2D(uFluidPatches,vec2(clamp(uv.x+o*.0105,.001,.999),uv.y+o*.012)).r*(3.0-abs(o));
  }
  broad=smoothstep(.34,.62,broad/9.0);
  // Centred near 1, so the dim stretches carry most of the variation and a
  // bright stretch does not flare into a flat bar.
  return max(0.0,mix(1.0,.20+1.30*broad*broad*(3.0-2.0*broad),uCrestVariation));
}
// Key light from above: upward-facing shell is lit, the underside is dimmer
// but never unlit (at the default 85% it keeps about a quarter of the light).
float crestKey(float normalY) { return mix(1.0-uCrestLight*.9,1.0,smoothstep(-.45,.55,normalY)); }
// Churning whitewater: the sim's foam channel (spawned on sheared dye fronts
// and carried downstream), spray threads, and a soft body of broad dye, all
// read where the ray meets the front of the shell. Deeper layers slide around
// the shell, so the crest shows rolling, overlapping sheets, and the foam
// thins out away from the edge. Returns (body, whitewater, spray).
vec3 crestFoam(vec2 uv, float depth) {
  vec4 a=texture2D(uFluid,vec2(uv.x,fract(uv.y+depth*.020)));
  vec4 b=texture2D(uFluid,vec2(clamp(uv.x-.004,.001,.999),fract(uv.y-.010+depth*.045)));
  // A wide footprint gathers the foam into clumps separated by dark gaps;
  // the sharp samples add fine spray on top of them.
  float clump=0.0;
  for (int j=0;j<4;j++) {
    vec2 o=vec2(float(j)-1.5,float(j-(j/2)*2)-.5)*vec2(.0085,.024);
    clump+=texture2D(uFluid,vec2(clamp(uv.x+o.x,.001,.999),fract(uv.y+o.y+depth*.02))).a;
  }
  clump=smoothstep(.10+.12*min(depth,1.5),.52,clump*.25);
  float fine=smoothstep(.15,.80,a.a*.6+b.a*.4);
  float white=clump*(.45+.75*fine);
  float spray=smoothstep(.40,.95,a.g+b.g*.5)*(.4+.6*clump);
  float body=.06+.20*smoothstep(.30,.90,a.r*.6+b.r*.4);
  return vec3(body,white,spray);
}
// Darkness keeps going almost to the very end of the tail, so the rounded
// tail cap still closes over a dark interior instead of a grey wash.
float interiorFade(float x) { return smoothstep(0.0,5.0,x)*sqrt(tailFade(x)); }
float interiorAmount(Section c, vec3 ro, vec3 rd) {
  float amount=smoothstep(0.0,.25,c.inside)*c.hit*interiorFade(c.entry.x);
  // The section is exact for rays that cross the field, but a ray running
  // along it (seen from ahead, behind or obliquely in Orbit) reaches its
  // deepest point far from its closest approach to the axis. Sample the
  // ray's path through the field too; the deepest point wins. A maximum of
  // smooth terms stays smooth, and crossing rays are left as they were.
  if (amount<1.0) {
    vec2 span=intersectBox(ro,rd);
    float t0=max(span.x,0.0),t1=span.y;
    if (t1>t0) {
      for (int k=0;k<10;k++) {
        vec3 p=ro+rd*mix(t0,t1,(float(k)+.5)/10.0);
        Shape shape=profile(p.x);
        float depth=max(shape.size.z,.002);
        float scale=max((p.y>=0.0?shape.size.x:shape.size.y)/depth,.001);
        float inside=1.0-length(vec2(p.y/scale,p.z))/depth;
        amount=max(amount,smoothstep(0.0,.25,inside)*interiorFade(p.x));
      }
    }
  }
  return amount;
}
#ifdef INSIDE_CLEAR
// Clear view from inside (Effects › Field › Inside clarity). The dark
// interiors belong to the view from outside: the rim has gathered the light
// that would have crossed a bubble. A camera inside the field (On board, or
// Orbit scrolled through the surface) is not looking across its own bubble,
// only out through its wall, so only what lies beyond that bubble is seen
// through an interior: another lobe past a neck, or a bubble the ray enters
// again from outside. main.js compiles this in only while the camera is
// inside the field and Inside clarity is above 0, so every view from
// outside, and 0%, are exactly the shaders without it.
// uInsideClear: x, how much of the own bubble's darkness clears (Inside
// clarity times the camera's depth weight, 0 at the shell, so crossing the
// surface does not pop); y, how much of its demagnification eases out (its
// pull toward the axis is meaningless from inside, where it dragged the
// whole on-board view off centre); z, how far the bow shock is seen as from
// inside (1 deep in, 0 at the shell, where the view from outside takes over).
// uOwnBubble: the x range of the camera's bubble, between the necks either
// side of it (the bow and the first lobe are one bubble), then the far
// limits of the bubbles before and after it. uNeckBlend: how far the
// camera's view takes in the next bubble (x) or the previous one (y) as
// it nears the neck it shares with it, 1 at the neck. Both sides of a neck
// then see the two bubbles as one, so moving the camera along the field
// through a neck (Orbit) hands over smoothly rather than flipping which
// side counts as beyond.
uniform vec3 uInsideClear;
uniform vec4 uOwnBubble;
uniform vec2 uNeckBlend;
const float INSIDE_NECK=8.0;
// 0 inside the camera's own bubble, rising to 1 within INSIDE_NECK units
// past either neck.
float pastNeck(float x) {
  float ahead=mix(smoothstep(uOwnBubble.y,uOwnBubble.y+INSIDE_NECK,x),smoothstep(uOwnBubble.w,uOwnBubble.w+INSIDE_NECK,x),uNeckBlend.x);
  float behind=mix(1.0-smoothstep(uOwnBubble.x-INSIDE_NECK,uOwnBubble.x,x),1.0-smoothstep(uOwnBubble.z-INSIDE_NECK,uOwnBubble.z,x),uNeckBlend.y);
  return max(ahead,behind);
}
#endif
// The interior amount a pixel is drawn with: interiorAmount(), or, from
// inside the field, mixed toward the part of it beyond the camera's own
// bubble: along the same path samples, a sample counts once the ray has
// left that bubble, through its wall or past a neck. Each term is
// continuous in the ray, and the running 'left' is a running maximum of
// continuous terms, so the picture has no seams; the part beyond is never
// more than the whole. Both come out of one loop.
float viewInterior(Section c, vec3 ro, vec3 rd) {
#ifdef INSIDE_CLEAR
  float amount=smoothstep(0.0,.25,c.inside)*c.hit*interiorFade(c.entry.x);
  float beyond=amount*pastNeck(c.entry.x);
  vec2 span=intersectBox(ro,rd);
  float t0=max(span.x,0.0),t1=span.y;
  if (t1>t0) {
    float left=0.0;
    for (int k=0;k<10;k++) {
      vec3 p=ro+rd*mix(t0,t1,(float(k)+.5)/10.0);
      Shape shape=profile(p.x);
      float depth=max(shape.size.z,.002);
      float scale=max((p.y>=0.0?shape.size.x:shape.size.y)/depth,.001);
      float inside=1.0-length(vec2(p.y/scale,p.z))/depth;
      float here=smoothstep(0.0,.25,inside)*interiorFade(p.x);
      left=max(left,max(pastNeck(p.x),1.0-smoothstep(-.15,0.0,inside)));
      amount=max(amount,here);
      beyond=max(beyond,here*left);
    }
  }
  return mix(amount,beyond,uInsideClear.x);
#else
  return interiorAmount(c,ro,rd);
#endif
}
// Fraction of the light seen through the interior that survives. With the
// energy-conserving experiment, the loss follows the rim's own brightness.
float interiorTransmission(Section c, float interior, float fieldLight) {
  if (uInteriorDarkness<=0.0 || interior<=0.0) return 1.0;
  // Blend the crest above and below continuously across the centre line.
  float upper=smoothstep(-.35,.35,c.vertical);
  float coupling=fieldLight;
  if (uEnergyRim>.5) {
    float rimPatches=mix(crestPatches(vec2(c.sideUv.x,0.0)),crestPatches(vec2(c.sideUv.x,.5)),upper);
    // Strongest just under the rim, so bright crest stretches cast a soft
    // shadow inward instead of darkening whole columns of the interior.
    float reach=exp(-max(c.inside,0.0)*2.2);
    coupling=fieldLight*mix(1.0,crestKey(upper*2.0-1.0),.35*reach)*(1.0+(rimPatches-1.0)*.55*reach)*1.12;
  }
  float flow=texture2D(uFluid,c.uv).b;
  // The upper ovals are the darkest; below the centre line the gas still
  // shows through a little more, as in the reference.
  float side=mix(.96,1.0,upper);
  return max(0.0,1.0-uInteriorDarkness*interior*side*coupling*(.86+.28*flow));
}
// What is seen through a bubble. The lens spreads a wider patch of space over
// the interior, so it is pulled toward the field axis (demagnified), blurred
// to match, and dimmed. Both follow Light bending: at 0% the bubble no longer
// bends light away from its interior, so the dark ovals go too. The darkening
// stops at the deep-blue black level instead of crushing it to pure black.
// With Dispersion on, 'bend' is the colour spread from bowDispersion().
vec3 interiorView(Section section, vec3 ro, vec3 direction, float interior, float fieldLight
#ifdef BOW_DISPERSION
  , vec3 bend
#endif
) {
  float lens=clamp(uLensing/.7,0.0,1.0);
  float shrink=uInteriorShrink*interior*lens;
#ifdef INSIDE_CLEAR
  shrink*=1.0-uInsideClear.y;
#endif
  vec3 outgoing=direction;
  if (shrink>0.0) {
    vec3 axisDirection=normalize(vec3(section.entry.x,0.0,0.0)-ro);
    vec3 offset=direction-axisDirection;
    offset.x*=.35;
    outgoing=normalize(direction+offset*shrink*1.6);
  }
  // Implicit-derivative lookup in uniform control flow.
  vec3 color=backgroundAlong(outgoing);
#ifdef INSIDE_CLEAR
  // From inside, the blur that goes with the demagnification eases out
  // with it, so the view sharpens continuously rather than at once.
  float blur=smoothstep(0.0,.3,interior)*(1.0-uInsideClear.y);
#endif
#ifdef BOW_DISPERSION
  // Deep in the interior the plain lookup is replaced by the blurred one
  // below, so its own red and blue reads are skipped there (a zero spread;
  // the call stays in uniform control flow for its derivatives).
#ifdef INSIDE_CLEAR
  color=disperse(color,outgoing,shrink>0.0 && blur>=1.0 ? vec3(0.0) : bend);
#else
  color=disperse(color,outgoing,shrink>0.0 && interior>=.3 ? vec3(0.0) : bend);
#endif
  if (shrink>0.0) {
    float squeeze=1.0+shrink*1.6, level=log2(squeeze)*2.2+1.2;
    vec3 blurred=backgroundAlongLod(outgoing,level);
    // The blurred, demagnified view through the bow splits the same way, a
    // little wider (the demagnification is a lens too), so bright gas seen
    // through the glass picks up soft red and green patches; mixing in the
    // plain blur would wash the fringe out wherever the interior shrinks.
    if (bend!=vec3(0.0)) {
      vec3 spread=bend+(outgoing-direction)*BOW_INTERIOR_SPREAD*uBow.x*length(bend)/(length(bend)+.002);
      blurred=vec3(backgroundAlongLod(normalize(outgoing-spread),level).r,blurred.g,backgroundAlongLod(normalize(outgoing+spread),level).b);
    }
#ifdef INSIDE_CLEAR
    color=mix(color,blurred,blur);
#else
    color=mix(color,blurred,smoothstep(0.0,.3,interior));
#endif
  }
#else
  if (shrink>0.0) {
    float squeeze=1.0+shrink*1.6;
#ifdef INSIDE_CLEAR
    color=mix(color,backgroundAlongLod(outgoing,log2(squeeze)*2.2+1.2),blur);
#else
    color=mix(color,backgroundAlongLod(outgoing,log2(squeeze)*2.2+1.2),smoothstep(0.0,.3,interior));
#endif
  }
#endif
  // The black-level lift is added afterwards, so a fully dark interior still
  // stops at deep blue rather than crushing to pure black.
  return color*interiorTransmission(section,interior,fieldLight*lens);
}
// Concentrated light from a bright nebula would saturate into a uniform white
// line. Expose for the average brightness of the whole sky around the camera
// (the last mip of each face of the camera-centred capture), which does not
// swing with the framing: dark or sparse space keeps the full gain, bright gas
// is pulled back. Only active with the nebula on, so 0% is unchanged.
float exposureCache=-1.0;
vec3 skyCache=vec3(0.0);
vec3 skyAverage() {
  if (exposureCache<0.0) {
    skyCache=(textureLod(uOffscreenScene,vec3(1,0,0),8.0).rgb+textureLod(uOffscreenScene,vec3(-1,0,0),8.0).rgb
      +textureLod(uOffscreenScene,vec3(0,1,0),8.0).rgb+textureLod(uOffscreenScene,vec3(0,-1,0),8.0).rgb
      +textureLod(uOffscreenScene,vec3(0,0,1),8.0).rgb+textureLod(uOffscreenScene,vec3(0,0,-1),8.0).rgb)/6.0;
    exposureCache=1.0/(1.0+nebulaOn()*60.0*dot(skyCache,vec3(.2126,.7152,.0722)));
  }
  return skyCache;
}
float spaceExposure() { skyAverage(); return exposureCache; }
`;

// The bow's glass (Effects › Bow), shared by the three appearances. Included
// after fieldEffects, before fieldCrest.
const bowSurface = /* glsl */`
#if defined(BOW_FILM) || defined(BOW_LAYERS)
// The box-filtered (64×32) dye read with smoothed, C1 interpolation across
// its texels: plain bilinear taps kinked the arcs whose depth follows the dye
// into a polyline, and cut the film's colour patches into straight-edged
// blocks, at every texel boundary.
vec3 bowPatch(vec2 uv) {
  vec2 size=vec2(textureSize(uFluidPatches,0));
  vec2 texel=uv*size-.5;
  vec2 cell=floor(texel), f=fract(texel);
  vec2 smoothUv=(cell+.5+f*f*(3.0-2.0*f))/size;
  return texture2D(uFluidPatches,vec2(clamp(smoothUv.x,.001,.999),fract(smoothUv.y))).rgb;
}
// The box-filtered dye at a silhouette point (fluid coordinates sideUv),
// 'turn' of the way further round the shell. It streams downstream with the
// flow (at the nose the full-resolution dye moves tens of pixels a frame,
// which would strobe). Seen from the side, the silhouette's angle round the
// shell flips from the top to the bottom at the nose's centre line, so the two
// sides are blended there: nothing the dye drives is cut by a seam.
vec3 bowDye(vec2 sideUv, float turn, float vertical) {
  vec3 own=bowPatch(vec2(sideUv.x,sideUv.y+turn));
  float blend=.5-.5*smoothstep(0.0,.4,abs(vertical));
  return blend>0.0 ? mix(own,bowPatch(vec2(sideUv.x,sideUv.y+turn+.5)),blend) : own;
}
#endif
#ifdef BOW_FILM
// Soap-film colours as a cosine palette kept to the half of the hue wheel the
// clip shows: 0 cyan, 1/6 green, 1/3 amber, 1/2 red (never magenta or violet),
// scaled to unit luminance so it recolours the glass without brightening it.
vec3 filmColour(float hue) {
  vec3 tint=1.0+.5*cos(6.2831853*hue+vec3(3.1415927,-1.0471976,1.0471976));
  return tint/dot(tint,vec3(.2126,.7152,.0722));
}
// The full-resolution dye at a silhouette point, blended across the nose's
// centre line like bowDye. (The fluid texture has no mipmaps.)
vec3 bowFineDye(vec2 sideUv, float turn, float vertical) {
  vec3 own=textureLod(uFluid,vec2(sideUv.x,fract(sideUv.y+turn)),0.0).rgb;
  float blend=.5-.5*smoothstep(0.0,.4,abs(vertical));
  return blend>0.0 ? mix(own,textureLod(uFluid,vec2(sideUv.x,fract(sideUv.y+turn+.5)),0.0).rgb,blend) : own;
}
// The tint the film gives the light the glass reflects at a point of the
// shell (fluid coordinates uv). The film's thickness, and so its hue, is
// carried by the fluid dye, so the colours swirl and stream downstream with
// the flow; the dye gathers them into patches, so most of the glass stays
// blue-white with colour here and there. 'order' picks a different hue for
// each nested sheet; a grazing view shortens the path through the film, so
// the hue also shifts across the rim. With Fluid-driven film thickness off
// the hue depends only on those two. Strongest round the nose, faint
// downstream. Where one texel of the full-resolution dye spans several pixels
// (round the nose in the close-ups) its swirls are mixed in; farther out they
// would alias, and the box-filtered copy alone is used.
vec3 filmTint(vec2 uv, float vertical, float grazing, float x, float order, float strength, float worldPixel) {
  float flow=0.0, patchy=.55;
  if (uFilmFlow>.5) {
    vec3 broad=bowDye(uv,order*.11,vertical);
    float detail=smoothstep(2.0,6.0,(LENGTH/512.0)/max(worldPixel,1e-4));
    vec3 dye=detail>0.0 ? mix(broad,bowFineDye(uv,order*.11,vertical),detail) : broad;
    // Blobs addressed only by the transported dye (like the crest's clumps),
    // so they too travel downstream with the flow.
    float blobs=smoothNoise(vec3(dye.r*9.0,dye.b*9.0,broad.g*6.0+order*1.7));
    flow=(broad.r-.40)*2.0+(dye.b-.50)*4.0+blobs*.9;
    patchy=smoothstep(.30,.70,dye.r*.45+blobs*.65);
  }
  float hue=.20+.30*sin(6.2831853*(flow*.38+order*.23+grazing*.18));
  // Fainter as the camera pulls back: a trace in the wide shot's crest.
  float amount=uBow.y*strength*mix(.30,1.0,bowNose(x))*(.10+.90*patchy*patchy)*mix(.40,1.0,bowFringeScale(worldPixel));
  return mix(vec3(1.0),filmColour(hue),clamp(amount,0.0,.95));
}
#endif
#ifdef BOW_LAYERS
// Nested sheets of glass at the bow: iso-surfaces a share of the way from the
// surface to the axis along the surface's normal (for the paraboloid nose
// that length is sqrt(BOW_NOSE²+radius²): the nose's own radius of curvature
// at the tip, about the radius along the flanks), so they stay nested round
// the tip and fan out from the nose like the clip's arcs. The share decays
// downstream (by e every BOW_CONVERGE units), so the sheets converge into the
// rim and crest. They lie inside the surface; the bow-shock gas stands
// outside it.
//
// The sheets are unevenly spaced and not quite concentric: each is a little
// deeper on one side of the nose than the other (a share of its depth along
// the outward normal's component in these directions), so round the flanks
// neighbouring arcs drift together and apart and hook, while at the very tip
// of the nose (normal along the axis) they stay nested. However far Layer
// spread and the flow's ripples push a sheet, it eases off below BOW_DEEPEST
// of the way to the axis and fades out as it nears that: a sheet reaching the
// axis folded its silhouette into scribbles and washed the interior.
const vec3 BOW_SHEETS=vec3(1.15,1.85,3.3), BOW_LEVEL=vec3(.42,.32,.24), BOW_WIDTH=vec3(.85,1.35,1.9);
const float BOW_SPREAD=.15, BOW_NOSE=1.35, BOW_CONVERGE=40.0, BOW_DEEPEST=.55, BOW_SHEET_LENS=.10, BOW_GLASS=.40, BOW_GLASS_GRAIN=5.0;
const vec3 BOW_TILT0=vec3(0.0,.24,.12), BOW_TILT1=vec3(0.0,-.26,.10), BOW_TILT2=vec3(0.0,.16,-.24);
// The profile with its slopes eased from the paraboloid nose's into the
// chain's over x 10 to 16. They meet at x=10 with a step in slope, and the
// distance estimate deep under the surface follows the slope, so the deep
// sheets stepped by several pixels at a fixed place on screen.
Shape bowProfile(float x) {
  Shape shape=profile(x);
  float cap=1.0-smoothstep(10.0,16.0,x);
  if (x>=10.0 && cap>0.0) shape.slope.xyz=mix(shape.slope.xyz,vec3(1.35/sqrt(2.7*x)),cap);
  return shape;
}
// The march's distance with the slopes eased as in bowProfile(), from the
// loop's own terms (it differs only from x 10 to 16), to pick the sample
// where each ray passes deepest under the surface: with the step in slope, a
// ray seen a little obliquely could pass deepest on either side of x=10, and
// where the pick switched, the dye and tilt read there jumped, cutting the
// arcs and the film along a ragged line.
float sheetDistance(float baseDistance, float implicitDistance, vec3 gradient, float heightSlope, vec4 slope, float y, float scale, float depth, float height, float x) {
  if (x<10.0 || x>=16.0) return baseDistance;
  float cap=1.0-smoothstep(10.0,16.0,x), nose=1.35/sqrt(2.7*x);
  float hs=mix(heightSlope,nose,cap), zs=mix(slope.z,nose,cap);
  float scaleSlope=(hs*depth-height*zs)/(depth*depth);
  gradient.x=-2.0*y*slope.w/(scale*scale)-2.0*y*y*scaleSlope/(scale*scale*scale)-2.0*depth*zs;
  return implicitDistance/max(length(gradient),.001);
}
// The march's signed distance to the surface (as in the loop, with the eased
// slopes), and its minimum along the ray refined by a parabola through the
// closest sample and its neighbours one step either way. Deep inside the
// field the march steps are long, and the arcs drawn at the raw sampled
// minimum broke into overlapping, offset segments like scales.
float fieldDistance(vec3 p) {
  Shape shape=bowProfile(p.x);
  float depth=max(shape.size.z,.002);
  bool upper=p.y>=shape.size.w;
  float height=upper?shape.size.x:shape.size.y;
  float heightSlope=upper?shape.slope.x:shape.slope.y;
  float scale=height/depth;
  float scaleSlope=(heightSlope*depth-height*shape.slope.z)/(depth*depth);
  float y=p.y-shape.size.w;
  vec2 radial=vec2(y/max(scale,.001),p.z);
  vec3 gradient=vec3(-2.0*y*shape.slope.w/(scale*scale)-2.0*y*y*scaleSlope/(scale*scale*scale)-2.0*depth*shape.slope.z,2.0*y/(scale*scale),2.0*p.z);
  float implicitDistance=dot(radial,radial)-depth*depth;
  if (p.x<10.0) { implicitDistance=dot(p.yz,p.yz)-2.7*p.x; gradient=vec3(-2.7,2.0*p.y,2.0*p.z); }
  if (p.x>=uTailCap.x) {
    vec3 radii=vec3(uTailCap.y-uTailCap.x,p.y>=0.0?uTailCap.z:uTailCap.w,(uTailCap.z+uTailCap.w)*.5);
    vec3 q=(p-vec3(uTailCap.x,0.0,0.0))/radii;
    implicitDistance=dot(q,q)-1.0;
    gradient=2.0*q/radii;
  }
  return implicitDistance/max(length(gradient),.001);
}
// Returns the refined minimum; 'point' (the march's deepest sample) moves to
// where it lies. Two rounds, so the minimum is found even a step or two from
// the sample (the steps are long deep inside the field, and a sample on the
// wrong side of the nose's join at x=10 kinked the deep arcs there). All the
// samples use fieldDistance(), so the result is as smooth as it is.
float refinedClosest(inout vec3 point, vec3 direction, float step) {
  float closest=fieldDistance(point);
  for (int k=0;k<2;k++) {
    float before=fieldDistance(point-direction*step), after=fieldDistance(point+direction*step);
    float curve=before-2.0*closest+after;
    if (curve<=1e-5) break;
    float shift=clamp(.5*(before-after)/curve,-1.0,1.0);
    point+=direction*shift*step;
    closest=k==0 ? fieldDistance(point) : min(closest,closest+.5*(after-before)*shift+.5*curve*shift*shift);
  }
  return closest;
}
// Where each sheet is for this pixel: 'offset' is how far under the surface
// each lies at the ray's deepest point (so the ray grazes sheet k where
// closest+offset[k] is 0), rippled by the flow; 'weight' is how much of it
// shows; 'stretch' is the dye that breaks it into bright stretches and gaps;
// 'uv' and 'vertical' are the fluid coordinates of the silhouette line at
// that deepest point and its height on its side of the axis (-1 to 1), for
// the dye there. 'normal' is the outward normal of the surface's
// cross-section there, its radial part scaled by how far out from the axis
// the point lies: smooth from pixel to pixel (the normal at the march's
// closest sample jumps as the sample changes, which broke the arcs into
// segments) and through the axis, where a unit radial direction would flip.
struct BowSheets { vec3 offset; vec3 weight; vec3 stretch; vec2 uv; float vertical; vec3 normal; };
// Whether any sheet can show for this pixel at all (the fades in bowSheets():
// the hand-over to the rim as the camera pulls back, the fade downstream and
// the fade away from side-on), so the rest of the field skips them.
bool bowSheetsShow(float x, float worldPixel) { return worldPixel<.12 && x<70.0 && abs(uCameraMatrix[2].x)<.6; }
BowSheets noSheets() { BowSheets s; s.offset=vec3(1.0); s.weight=vec3(0.0); s.stretch=vec3(0.0); s.uv=vec2(0.0); s.vertical=0.0; s.normal=vec3(0.0,1.0,0.0); return s; }
BowSheets bowSheets(float closest, vec3 point, float worldPixel, float fade) {
  BowSheets s;
  float x=max(point.x,0.0);
  Shape shape=bowProfile(point.x);
  bool upper=point.y>=shape.size.w;
  float radius=upper ? shape.size.x : shape.size.y;
  // The dye and the tilt are read on the silhouette line above (or below)
  // that point, not round the shell at the point itself: seen a little
  // obliquely, a ray can pass deepest on either side of the silhouette, and
  // where the deepest point switched sides the dye and tilt read there
  // jumped, cutting the arcs and the film along a ragged line. (Across the
  // nose's centre line bowDye() blends the two sides half and half, so the
  // switch from top to bottom there is seamless.)
  s.uv=vec2(clamp(point.x/LENGTH,.001,.999),upper ? .5 : 0.0);
  s.vertical=clamp((point.y-shape.size.w)/max(radius,.001),-1.0,1.0);
  float slope=upper ? shape.slope.x : shape.slope.y;
  s.normal=vec3(-slope,s.vertical,0.0)/sqrt(1.0+slope*slope);
  vec3 tilt=1.0+vec3(dot(s.normal,BOW_TILT0),dot(s.normal,BOW_TILT1),dot(s.normal,BOW_TILT2));
  float reach=sqrt(BOW_NOSE*BOW_NOSE+radius*radius);
  vec3 share=BOW_SHEETS*tilt*uBow.w*BOW_SPREAD*exp(-x/BOW_CONVERGE)/BOW_DEEPEST;
  vec3 eased;
  // The flow ripples the sheets as it does the surface: each is pushed in and
  // out by the (smoothed, box-filtered) dye where the ray grazes it, a share
  // of its depth, so the arcs waver apart and together, hook, and the waves
  // travel downstream. (The dye at the pixel's own nearest approach to the
  // axis changes across the arcs in perspective, and broke them into scales.)
  for (int k=0;k<3;k++) {
    vec3 d=bowDye(s.uv,.17*float(k)+.05,s.vertical);
    s.stretch[k]=d.r*.8+d.g*.2;
    float f=max(share[k]*(1.0+displacement(d)*.85*uTurbulence/1.5),0.0);
    // A soft limit: shallow sheets pass almost unchanged, deep ones ease
    // toward BOW_DEEPEST of the way to the axis.
    eased[k]=f/sqrt(sqrt(1.0+f*f*f*f));
    s.offset[k]=eased[k]*BOW_DEEPEST*reach;
  }
  // A sheet shows where it stands clear of the rim by a few pixels; closer,
  // it has merged into the rim. As the camera pulls back (a pixel at the nose
  // growing from about 0.075 to 0.12 units, from about 2.5 s to 3 s of the
  // reference move) the sheets hand over to the rim altogether, so they are
  // still several arcs round the 2 s flash and the wide shot's crest keeps a
  // single edge. They also fade near the depth limit, the deeper ones sooner
  // downstream (so the deepest is not a wire along the bubble), and as the
  // camera turns away from side-on (in Orbit, where the inner sheets'
  // silhouettes would wander through the interior).
  float sideOn=abs(uCameraMatrix[2].x);
  vec3 shown=(1.0-smoothstep(vec3(6.0),vec3(70.0,55.0,36.0),vec3(x)))
    *(1.0-smoothstep(vec3(.30,.24,.18),vec3(.60,.50,.40),vec3(sideOn)))
    *(1.0-smoothstep(.82,.97,eased));
  s.weight=smoothstep(1.5,4.5,s.offset/worldPixel)*shown*fade*(1.0-smoothstep(.075,.12,worldPixel));
  return s;
}
#ifdef BOW_LAYER_LENS
// Layered refraction (experiment): each sheet is a thin lens ring of its own
// that pulls the rays passing close to it toward itself, so the space behind
// the nose is gathered into each arc and parted between them.
vec3 bowSheetLens(vec3 direction, float closest, BowSheets s, float x) {
  if (s.weight==vec3(0.0)) return direction;
  vec3 u=(closest+s.offset)/(.16+max(x,0.0)*.006);
  float bend=dot(s.weight*u*exp(-u*u),vec3(1.0,.8,.65))*BOW_SHEET_LENS*uLensing*uEntrance;
  vec3 across=s.normal-direction*dot(direction,s.normal);
  return normalize(direction-across*bend);
}
#endif
// The sheets' light. Each is a faint grazing line with a sharp outer edge and
// a soft smear inward, broken into stretches and gaps by the fluid that
// streams over it, with its own film colour: ghostly arcs of the space beside
// the rim squeezed into them (as for the crest) and the whole sky round the
// camera, paler than the rim; the deeper ones wider and dimmer, smeared.
// Between the arcs the film shows sparse soft spots of colour (see below).
vec3 bowLayers(BowSheets s, float closest, vec3 rimPoint, vec2 screenNormal, float worldPixel, float gain) {
  float deepest=max(s.offset.x,max(s.offset.y,s.offset.z));
  if (s.weight==vec3(0.0) || closest>worldPixel*4.0 || closest<-deepest*1.5-worldPixel*6.0) return vec3(0.0);
  vec2 source=vUv+screenNormal*(dot(vec2(.5)-vUv,screenNormal)+.12);
  vec3 seen=backgroundLod(source,2.5)*.6+skyAverage()*.4;
  vec3 light=seen*gain*spaceExposure();
  light/=1.0+dot(light,vec3(.2126,.7152,.0722))*.45;
  light=mix(light,knee(light,.30,.20),nebulaOn())*crestKey(s.normal.y);
  // Paler than the light they reflect, as thin glass is.
  light=mix(light,vec3(dot(light,vec3(.2126,.7152,.0722)))*vec3(.88,.97,1.06),.55);
  float fringe=uBow.x*bowFringeScale(worldPixel);
  vec3 sum=vec3(0.0);
  for (int k=0;k<3;k++) {
    float fk=float(k);
    if (s.weight[k]<=0.0) continue;
    // Where the arcs crowd within a few pixels of each other their colours
    // and fringes fade, as fine interference stripes blend to white.
    float roomy=smoothstep(3.0,11.0,s.offset[k]*.30/worldPixel);
    float width=worldPixel*BOW_WIDTH[k]+s.offset[k]*.025;
    float a=(closest+s.offset[k])/width;
#ifdef BOW_DISPERSION
    // Red a little inside each arc, blue a little outside it: under a pixel
    // apart (the deep arcs are several pixels wide, and splitting them by a
    // share of their width laid a red band along each).
    vec3 across=a+vec3(1.0,0.0,-1.0)*fringe*(.50+.25*fk)*roomy*worldPixel/width;
#else
    vec3 across=vec3(a);
#endif
    // A thin core with a sharp outer edge, and a soft smear inward over the
    // rays that pass through the sheet. Only the core is split: shifting the
    // long smear tinted all of it red.
    vec3 core=exp(-across*across*1.2);
    float smear=.22*exp(-max(-a,0.0)*.40)*(1.0-smoothstep(-.6,1.2,a));
    // Long stretches of each arc are nearly dark, so the arcs are broken
    // rather than whole rings.
    float stretch=smoothstep(.34,.64,s.stretch[k]);
    float level=BOW_LEVEL[k]*(.05+.95*stretch)*s.weight[k];
#ifdef BOW_FILM
    // The film colours the thin core; the smear inward stays paler. Its hue
    // follows the dye that breaks the arc up, so it changes along the arc
    // with the bright stretches, and the deeper arcs are paler.
    vec3 tint=filmTint(s.uv,s.vertical,.85+s.stretch[k]*1.6,rimPoint.x,fk+1.0,roomy*(1.0-.22*fk),worldPixel);
    sum+=(core*tint+smear*mix(vec3(1.0),tint,.35))*level;
#else
    sum+=(core+smear)*level;
#endif
  }
#ifdef BOW_FILM
  // Sparse soft spots of film colour in the glass between the rim and the
  // deepest arc, fading in from just inside the rim and out before the last
  // arc. A lattice addressed along the arc by the full-resolution dye on the
  // silhouette line where the ray grazes the glass, smoothed over a few of
  // its cells (so they stream downstream with the flow and stay compact; the
  // box-filtered dye barely changes along the bow, and lit whole bands at
  // once), and across it by the depth. With Fluid-driven film thickness off
  // they are addressed by their place along the bow, so they sit still.
  float between=clamp(-closest/max(deepest,1e-4),0.0,1.0);
  float glass=smoothstep(0.0,.25,between)*(1.0-smoothstep(.65,1.0,between))*max(s.weight.x,max(s.weight.y,s.weight.z));
  if (glass>0.0) {
    vec3 d0;
    if (uFilmFlow>.5) {
      vec2 cell=vec2(2.5/512.0,2.5/256.0);
      d0=(bowFineDye(s.uv+cell,.31,s.vertical)+bowFineDye(s.uv-cell,.31,s.vertical)
        +bowFineDye(s.uv+vec2(cell.x,-cell.y),.31,s.vertical)+bowFineDye(s.uv+vec2(-cell.x,cell.y),.31,s.vertical))*.25;
    } else {
      d0=vec3(s.uv.x*LENGTH*.03,.5,s.uv.x*LENGTH*.02);
    }
    float blob=smoothNoise(vec3(d0.r*BOW_GLASS_GRAIN,d0.b*BOW_GLASS_GRAIN+between*1.6,3.0+d0.g*BOW_GLASS_GRAIN*.6));
    float spot=smoothstep(.58,.82,blob);
    // Each spot is one pale interference colour, picked by the film's
    // thickness (the same dye; fixed with Fluid-driven film thickness off).
    float thickness=uFilmFlow>.5 ? d0.b*2.0+d0.r*1.3+d0.g : 1.7;
    vec3 colour=mix(filmColour(.25+.25*sin(6.2831853*(thickness+between*.4))),vec3(1.0),.55);
    sum+=glass*spot*BOW_GLASS*min(uBow.y,1.5)*mix(.30,1.0,bowNose(rimPoint.x))*colour;
  }
#endif
  return sum*light*min(uBow.z,2.0)*uEntrance*min(1.0,uIntensity*.5);
}
#endif
`;

// The thick crest, shared by all three appearances: the front of the
// fluid-rippled shell seen just inside the silhouette. Its light is the
// surrounding space (reflected, and in Compressed glow also gathered), never
// self-emission, so dark surroundings leave it dark. Each volume shader
// supplies crestEnvironment(). Included after projectPosition().
const fieldCrest = /* glsl */`
// Relative thickness of the lit shell: thin arcs at the nose, thickening as
// the wake develops downstream.
float crestEta(float x) {
  return min(.6,uCrestThickness*(.03+.22*smoothstep(6.0,170.0,x)));
}
// Optical path through a thin shell (relative thickness eta) at the ray's
// normalised impact parameter rho, times a grazing-angle Fresnel term and an
// inward window: brightest just inside the silhouette, fading inward. The
// brightest point is about 1 for any thickness.
float crestProfile(float rho, float eta) {
  if (eta<=.0001 || rho>=1.0) return 0.0;
  float outer=sqrt(max(0.0,1.0-rho*rho));
  float inner=sqrt(max(0.0,(1.0-eta)*(1.0-eta)-rho*rho));
  float path=(outer-inner)/sqrt(eta*(2.0-eta));
  float fresnel=.06+.94*pow(1.0-outer,2.5);
  float window=smoothstep(1.0-1.8*eta,1.0-.6*eta,rho);
  return path*fresnel*window/(.392*pow(eta/.06,-.46));
}
vec3 crestShoulder(vec3 energy) {
  return energy/(1.0+dot(energy,vec3(.2126,.7152,.0722))*.45);
}
// Chunky whitewater: clumps from the seeded lattice, addressed only by
// transported dye, so they travel downstream with the flow.
float crestChunk(vec3 dye, float depthIn) {
  float veins=.5+.5*sin(dye.r*11.0+dye.b*7.0+dye.g*3.0);
  float clumps=smoothNoise(vec3(dye.r*12.0,dye.b*12.0,dye.g*8.0+depthIn*1.6));
  return smoothstep(.30,.72,clumps*.8+veins*.2);
}
// The same clumps, from the box-filtered dye, break up the thin edge line
// along its length without beading.
float edgeChunk(vec2 sideUv) {
  if (uCrestThickness<=0.0) return 1.0;
  float chunk=crestChunk(texture2D(uFluidPatches,sideUv).rgb,0.0);
  return mix(1.0,.55+.75*chunk,min(1.0,uCrestVariation)*min(1.0,uCrestThickness));
}
vec3 crestLight(Section section, float worldPixel, float key, float patches, float fade) {
  // Rays that just miss the shell are kept too: the churning skyline rises
  // above the silhouette there.
  if (uCrestThickness<=0.0 || section.front<=0.0 || section.inside<-.30 || fade<=0.0 || uIntensity<=0.0) return vec3(0.0);
  float wake=smoothstep(8.0,130.0,section.entry.x);
  // The lit top is a thick crest; the underside, away from the key light,
  // stays thinner and flatter.
  float litSide=mix(1.0,smoothstep(-.6,.6,section.side.y),uCrestLight);
  float eta=crestEta(section.entry.x)*(.45+.55*litSide);
  eta=max(eta,min(.6,uCrestThickness*worldPixel*2.5/max(section.height,.01)));
  float rho=1.0-section.inside;
  if (rho<1.0-2.2*eta) return vec3(0.0);
  float depthIn=max(section.inside,0.0)/eta;
  // The shell's flow, read on the front face a little further round the
  // shell for each step inward. A linear map in depth keeps the lookup from
  // racing across the fluid texture at the silhouette (which beads).
  // Which way round the shell is a smooth function: right at the silhouette
  // the entry and the silhouette point meet, and a hard sign() flipped from
  // pixel to pixel there, which dotted the thin arcs at the bow.
  float arc=fract(section.uv.y-section.sideUv.y+.5)-.5;
  vec2 crestUv=vec2(section.uv.x,fract(section.sideUv.y+clamp(arc*80.0,-1.0,1.0)*(.035+.11*min(depthIn,2.0))));
  vec3 dye=texture2D(uFluid,crestUv).rgb;
  vec3 foam=crestFoam(crestUv,depthIn);
  float chunk=crestChunk(dye,depthIn);
  // The fluid texture has no mipmaps, so a crest only a few pixels deep
  // reads the box-filtered copy instead; sharp taps beaded along its edge.
  vec4 broad=texture2D(uFluidPatches,crestUv);
  vec3 broadDye=broad.rgb;
  float detail=smoothstep(4.0,16.0,eta*section.height/max(worldPixel,1e-4));
  foam=mix(vec3(.06+.20*smoothstep(.30,.90,broadDye.r),smoothstep(.04,.30,broad.a)*.8,0.0),foam,detail);
  chunk=mix(crestChunk(broadDye,depthIn),chunk,detail);
  // The fluid pushes the shell in and out, so the crest's skyline churns.
  // Taken from the box-filtered dye: the full-resolution dye combed the edge.
  // On the lit top of the wake the skyline is lumpy whitewater: swells and
  // clumps rise well above the smooth silhouette and dip below it. It is a
  // property of the silhouette point, read from the box-filtered dye there,
  // so the skyline is continuous across the silhouette instead of breaking
  // into specks where the depth lookup jumps.
  vec3 edgeDye=texture2D(uFluidPatches,section.sideUv).rgb;
  float vary=uCrestVariation*(.3+.7*litSide);
  float churn=(displacement(edgeDye)*(.32+wake*2.9)*uTurbulence*.55+(crestChunk(edgeDye,0.0)-.3)*eta*section.height*.28)*vary;
  churn*=mix(1.0,2.2,litSide*wake*min(1.0,uCrestVariation));
  float height=max(section.height,.5);
  // Soft limits, so the tallest swells round off instead of flattening.
  float lift=churn/height;
  lift=lift>0.0 ? lift/(1.0+lift/.24) : lift/(1.0-lift/.5);
  float shifted=rho-lift;
  // Box-filter the profile over the pixel: at the bow the shell is only a
  // few pixels deep and its grazing peak is narrower than a pixel, which
  // drew the thin arcs as dotted, crawling lines. The outer edge is also
  // antialiased over about a pixel and a half.
  float pixelRho=worldPixel/height;
  float shell=(crestProfile(shifted-.375*pixelRho,eta)+crestProfile(shifted-.125*pixelRho,eta)
    +crestProfile(shifted+.125*pixelRho,eta)+crestProfile(shifted+.375*pixelRho,eta))*.25;
  shell*=smoothstep(0.0,1.5*pixelRho,1.0-shifted);
#ifdef BOW_DISPERSION
  // The thin glass refracts red a little inward and blue a little outward,
  // most at the nose, so the arc's edges carry a colour fringe: under a pixel,
  // a length on the field that fades as the camera pulls back.
  float split=uBow.x*mix(.12,.70,bowNose(section.entry.x))*bowFringeScale(worldPixel)*pixelRho;
  vec3 shells=vec3((crestProfile(shifted+split-.25*pixelRho,eta)+crestProfile(shifted+split+.25*pixelRho,eta))*.5
      *smoothstep(0.0,1.5*pixelRho,1.0-shifted-split),
    shell,
    (crestProfile(shifted-split-.25*pixelRho,eta)+crestProfile(shifted-split+.25*pixelRho,eta))*.5
      *smoothstep(0.0,1.5*pixelRho,1.0-shifted+split));
  if (max(shells.r,max(shells.g,shells.b))<=.0001) return vec3(0.0);
#else
  if (shell<=.0001) return vec3(0.0);
#endif
  vec3 n=rippledNormal(section,crestUv);
  vec3 v=normalize(section.entry-uCameraPosition);
  // Rippled glossy shell: grazing reflection plus a broad highlight from above.
  vec3 r=reflect(v,n);
  float fresnel=.10+.90*pow(1.0-abs(dot(n,v)),3.0);
  float highlight=pow(max(0.0,dot(r,normalize(vec3(.12,1.0,-.30)))),5.0);
  // The space above the crest, squeezed into it and displaced by the flow.
  vec2 screenNormal=normalize((projectPosition(section.entry+section.side)-projectPosition(section.entry))*uResolution+vec2(.00001));
  float across=1.0-min(depthIn,1.0)*.85+(dye.b-.5)*.45;
  vec2 tangent=vec2(screenNormal.y,-screenNormal.x);
  vec2 source=vUv+screenNormal*(dot(vec2(.5)-vUv,screenNormal)+across*.46)+tangent*(dye.r-.5)*.05;
  vec3 reflected=backgroundLod(source,2.5);
  float gain, whiten;
  vec3 environment=crestEnvironment(screenNormal,n,section.side,reflected,gain,whiten);
  // An evenly lit band of whitewater broken into clumps with dark gaps, plus
  // the simulation's own foam gathered into those clumps.
  float chunky=mix(1.0,.12+1.25*chunk+.6*smoothstep(.80,.98,chunk),min(1.0,uCrestVariation*(.7+.3*wake)));
  float white=foam.y*(.30+.90*chunk);
  // The shoulder limits hot sources first; the clumps, foam and patches then
  // modulate the lit band, so its texture is not flattened by the shoulder.
  vec3 lit=crestShoulder(environment*gain*(.55+.45*fresnel))*key;
  float sheen=chunky*(1.0+foam.x*1.6)+white*1.1+foam.z*.25*chunk+highlight*(.05+white*.25);
  // The bow carries only thin arcs; the lit crest develops with the wake.
  float develop=mix(.35,1.0,smoothstep(8.0,110.0,section.entry.x));
  // Energy-conserving rim: the light a bubble's interior loses is gathered
  // into its crest. Interior area grows with the square of the height and the
  // crest only linearly, so the big downstream bubbles get the brightest crest.
  float stolen=uInteriorDarkness*clamp(uLensing/.7,0.0,1.0)*section.height/(section.height+18.0);
  // Seen face-on (from above, in Orbit) the crest is no longer a grazing
  // rim gathering light along its length, so the boost falls away.
  float energy=1.0+uEnergyRim*stolen*smoothstep(.25,.75,1.0-abs(dot(n,v)));
  vec3 light=lit*sheen*patches*develop*energy;
  // Whitewater is whiter than the light it scatters.
  light=mix(light,vec3(dot(light,vec3(.2126,.7152,.0722)))*1.1,clamp(white*.4+chunk*.20,0.0,.45)*whiten);
  // A final, gentler shoulder keeps the brightest foam from glaring, and
  // concentrated light washes out toward white only up to a cap.
  light/=1.0+dot(light,vec3(.2126,.7152,.0722))*1.3;
  float luminance=dot(light,vec3(.2126,.7152,.0722));
  light=mix(light,vec3(luminance)*vec3(.96,.97,1.06),smoothstep(.30,1.2,luminance)*.45*whiten);
  // The same knee as the gathered glow: bright gas behind must not push the
  // crest into a white glare.
  light=mix(light,knee(light,.32,.22),nebulaOn());
#ifdef BOW_FILM
  // Soap-film colour on the glass, carried by the same dye as the crest.
  light*=filmTint(section.sideUv,section.vertical,1.0-min(depthIn,1.0),section.entry.x,0.0,1.0,worldPixel);
#endif
#ifdef BOW_DISPERSION
  return light*shells*fade*uEntrance*min(1.0,uIntensity*.5);
#else
  return light*shell*fade*uEntrance*min(1.0,uIntensity*.5);
#endif
}
`;

// The light of the gas piled up against the field is the light of the banks
// it was swept from: the backdrop a little way out from the surface on
// screen (so the layer under the field glows like the bank below it, and the
// one over a dark sky stays dim), blended half and half with a framing-steady
// average (a coarse local mip of the scene capture and its overall average),
// so its colour does not swing as the camera reframes, and never less than a
// share of the whole sky.
const gasAmbientChunk = /* glsl */`
#ifdef GAS_FIELD
vec3 gasAmbientAt(vec4 acc) {
  vec3 c=acc.xyz/max(acc.w,1e-4);
  vec3 n=normalize(vec3(-max(0.0,6.0-c.x)*.35,c.yz)+vec3(0.0,1e-4,0.0));
  vec2 out2=(projectPosition(c+n)-projectPosition(c))*uResolution;
  vec2 dir=out2/max(length(out2),1e-4);
  vec2 offset=dir*vec2(uResolution.y/uResolution.x,1.0)*.07;
  vec3 local=textureLod(tScene,clamp(sceneUv(vUv),vec2(.001),vec2(.999)),7.0).rgb;
  vec3 overall=textureLod(tScene,vec2(.5),12.0).rgb;
  vec3 steady=local*.35+overall*.65;
  gasSteadyAmbient=max(steady,skyAverage()*.6);
  return max(mix(backgroundLod(vUv+offset,4.5),steady,.5),skyAverage()*.6);
}
// After the march, shared by both volume shaders. The layer behind the field
// is laid over what is seen through and around it (before the crest); the
// layer in front and the bow shock wait for gasInFront. Pixels that meet
// neither the layer nor the shock's bound skip all of it.
vec4 gasAheadLayer=vec4(0.0);
vec3 gasShockLight=vec3(0.0);
vec3 gasBehindField(vec3 seen, vec4 front, vec4 back, Section section, float interior, vec3 ro, vec3 rd) {
  bool layer=max(front.w,back.w)>=.01 && uGas.z>0.0;
  vec2 bound=gasShockBound(ro,rd);
  if (!layer && bound.y<=bound.x) return seen;
  float horizon=gasHorizon(rd);
  vec3 ambient=gasAmbientAt(front.w>back.w ? front : back);
  gasGather(front,back,horizon);
  // What is behind the field is seen through its dark interior.
  float throughInterior=1.0-min(1.0,uInteriorDarkness*clamp(uLensing/.7,0.0,1.0))*interior;
  // Over a bubble the layer is seen face-on, thin and nearly clear, so the
  // dark ovals stay dark right up to the lit edge: it reads only at and
  // outside the silhouette, where it is seen edge-on.
  float edgeOn=1.0-.92*smoothstep(0.0,.15,section.inside);
#ifdef INSIDE_CLEAR
  // From inside there is no silhouette: the layer just outside the camera's
  // own wall is seen through that wall, edge-on where the view grazes it.
  edgeOn=mix(edgeOn,1.0,uInsideClear.x);
#endif
  float through=throughInterior*edgeOn;
  if (layer) {
    gasAheadLayer=gasShell(front,ambient)*edgeOn;
    // (The layer behind is not worth reading where the interior hides it.)
    if (through>.04) {
      vec4 behind=gasShell(back,ambient);
      seen=seen*(1.0-behind.a*.55)+behind.rgb*through;
    }
  }
  if (bound.y>bound.x) {
    // From inside the field (On board) the whole shock lies beyond the
    // surface and is seen through the interior, like everything ahead.
#ifdef INSIDE_CLEAR
    // (Compiled in only while the camera is inside.) Deep inside, the shock
    // is seen out through the camera's own wall, so it passes the cleared
    // interior's share. Toward the shell this hands over to the view from
    // outside, so scrolling through the surface in Orbit does not pop.
    gasShockLight=gasBowLight(ro,rd,section.hit>0.0 ? dot(section.entry-ro,rd) : 0.0,throughInterior,horizon);
    if (uInsideClear.z<1.0) {
      vec3 outside=gasBowLight(ro,rd,section.hit>0.0 ? dot(section.entry-ro,rd) : 1e9,through,horizon);
      gasShockLight=mix(outside,gasShockLight,uInsideClear.z);
    }
#else
    float inside=gasCameraInside(ro);
    float entry=section.hit>0.0 ? dot(section.entry-ro,rd) : (inside>.5 ? 0.0 : 1e9);
    gasShockLight=gasBowLight(ro,rd,entry,inside>.5 ? throughInterior : through,horizon);
#endif
  }
  return seen;
}
// The denser gas in front of the field partly hides what is behind it; the
// bow shock stands off the nose.
vec3 gasInFront(vec3 color) {
  return color*(1.0-gasAheadLayer.a*.55)+gasAheadLayer.rgb+gasShockLight;
}
#endif
`;

export const fluidVolumeFragment = /* glsl */`
${noise}
${environment}
varying vec2 vUv;
uniform sampler2D tScene, uFluid, uProfile, uProfileSlope;
uniform mat4 uInverseProjection, uProjection, uCameraMatrix;
uniform vec3 uCameraPosition;
uniform vec2 uResolution;
uniform float uTurbulence, uIntensity, uEntrance, uLensing;
${sceneSampling}
${bowRefraction}
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
${fieldEffects}
${gasNearField(false)}
vec2 projectDirection(vec3 direction) {
  vec3 view=vec3(dot(direction,uCameraMatrix[0].xyz),dot(direction,uCameraMatrix[1].xyz),dot(direction,uCameraMatrix[2].xyz));
  vec4 projected=uProjection*vec4(view,0.0);
  return projected.xy/max(projected.w,.1)*.5+.5;
}
vec2 projectPosition(vec3 p) { return projectDirection(p-uCameraPosition); }
// The crest reflects the space above it and the whole sky around the camera.
vec3 crestEnvironment(vec2 screenNormal, vec3 normal, vec3 side, vec3 reflected, out float gain, out float whiten) {
  gain=44.0*spaceExposure(); whiten=1.0;
  return reflected*.60+skyAverage()*.40;
}
${bowSurface}
${fieldCrest}
${gasAmbientChunk}

void main() {
  vec4 vr=uInverseProjection*vec4(vUv*2.0-1.0,1.0,1.0);
  vec3 direction=normalize(mat3(uCameraMatrix)*vr.xyz);
  vec3 originalDirection=direction;
  vec3 ro=uCameraPosition;
  vec2 bounds=intersectBox(ro,direction);
  float nearT=max(0.0,bounds.x),farT=bounds.y;
  // Rays that miss the field's box fall straight through the march below; an
  // early return here left neighbouring pixels without texture derivatives,
  // which showed as a bright seam along the box edge over a bright sky.
  vec3 p=ro+direction*nearT;
#ifdef GAS_FIELD
  // Column of the gas layer in front of the field and behind it (seen through it).
  vec4 gasFront=vec4(0.0), gasBack=vec4(0.0);
  float gasEntered=0.0, gasReach=gasLayerReach();
#endif
  vec3 radiance=vec3(0.0);
  float transmittance=1.0,travelled=nearT;
  vec4 gas=vec4(0.0);
#if defined(BOW_DISPERSION) || defined(BOW_LAYERS)
  // The ray's closest approach to the surface, for the bow's arcs and fringes.
  float closest=1e5;
  vec3 rimPoint=p, rimNormal=vec3(0.0,1.0,0.0);
#endif
#ifdef BOW_LAYERS
  // Where the ray passes deepest under the surface (by sheetDistance()), and
  // its direction and step there, to refine it for the nested sheets.
  float sheetNearest=1e5;
  vec3 sheetPoint=p, sheetDirection=direction;
  float sheetStep=0.0;
#endif
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
#ifdef BOW_LAYERS
    float sheetHere=sheetDistance(baseDistance,implicitDistance,gradient,heightSlope,shape.slope,y,scale,depth,height,p.x);
#endif
    vec3 baseNormal=gradient/max(length(gradient),.0001);
#if defined(BOW_DISPERSION) || defined(BOW_LAYERS)
    if (baseDistance<closest) { closest=baseDistance; rimPoint=p; rimNormal=baseNormal; }
#endif
    float wake=smoothstep(8.0,130.0,p.x);
    float minStep=.035+max(p.x,0.0)*.0012;
    float stepSize=min(clamp(abs(baseDistance)*.42,minStep,(farT-nearT)/22.0),farT-travelled);
    // Resolve a real, thin internal shear sheet, not a fixed centre guide line.
    float sheetExtent=1.0-smoothstep(depth*.70,depth*.98,abs(p.z));
    if (p.x>1.0 && sheetExtent>.001) stepSize=min(stepSize,max(minStep,abs(y)*.45)/max(abs(direction.y),.18));
#ifdef BOW_LAYERS
    if (sheetHere<sheetNearest) { sheetNearest=sheetHere; sheetPoint=p; sheetDirection=direction; sheetStep=stepSize; }
#endif
#ifdef GAS_FIELD
    if (baseDistance<0.0) gasEntered=1.0;
    else if (baseDistance<gasReach) {
      // Seen edge-on the layer is a long path through piled-up gas; seen
      // face-on, over a dark interior, it is thin and nearly clear.
      float facing=1.0-abs(dot(baseNormal,direction));
      // (Gas within a few units of the camera, in the bow close-ups, is out
      // of focus and out of the picture.)
      float gasWeight=gasLayer(baseDistance,p,height,radial/r)*stepSize*(.08+.92*facing*facing)*smoothstep(5.0,20.0,travelled);
      if (gasEntered>.5) gasBack+=vec4(p,1.0)*gasWeight; else gasFront+=vec4(p,1.0)*gasWeight;
    }
#endif
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
    // The backdrop nebula now supplies the surrounding gas, so the older
    // near-shell fog is reduced when it is on (unchanged at Nebula 0%).
    radiance+=transmittance*litGas*gasAlpha*(1.4+compression*.7)/(1.0+nebulaOn()*.8);
    transmittance*=1.0-gasAlpha*.25;

    vec2 uv=vec2(clamp(p.x/LENGTH,.001,.999),fract(atan(radial.y,radial.x)/TAU+.5));
    // The thick crest is a layer just inside the shell, so sample a little
    // deeper than the thin rim needs.
    float crestReach=uCrestThickness*max(.20*height*mix(.22,1.0,smoothstep(6.0,70.0,p.x)),.06);
    if (axialFade>0.0 && baseDistance<(3.0+wake*8.0) && baseDistance>-(3.0+wake*8.0+crestReach)) {
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
        // Key light from above and broad bright/dim stretches of the flow.
        float shade=crestKey(normal.y)*crestPatches(uv);
        float density=(rim*(.045+tracer*.40+filaments*.25)+folds*.18)*facing*shade;
        density*=axialFade*uIntensity*uEntrance*(.18+gas.a*2.0)/(1.0+wake*4.0);
        vec3 color=mix(vec3(.008,.07,.13),vec3(.24,.37,.43),tracer*.5+filaments*.5);
        color=mix(color,litGas*2.0,.55);
        vec3 film=.5+.5*cos(vec3(0.0,2.1,4.2)+surface.r*9.0+surface.b*5.0);
        color+=film*.12*(1.0-wake)*rim;
        float alpha=1.0-exp(-density*stepSize*2.0);
        radiance+=transmittance*color*alpha*(.70+facing*.55);
        transmittance*=1.0-alpha*.40;
        if (uCrestThickness>0.0 && d<0.0 && -d<crestReach*1.6) {
          // Churning whitewater in a layer under the surface. Seen edge-on it
          // integrates into a thick, bright crest that fades inward.
          float crestDepth=-d/crestReach;
          vec3 foam=crestFoam(uv,crestDepth);
          float layer=exp(-crestDepth*1.6)*(1.0-smoothstep(1.0,1.6,crestDepth));
          float grazing=pow(max(0.0,1.0-abs(dot(normal,direction))),1.3);
          float crestDensity=layer*(foam.x*.5+foam.y*2.0+foam.z*.5)*grazing*shade*.22;
          // Saturating in dense gas: the fog there is already bright, and
          // whitewater on top of it would only bleach the frame.
          crestDensity*=axialFade*uIntensity*uEntrance*(.30+gas.a*1.6)/(1.0+gas.a*3.0)/(1.0+wake*2.0);
          vec3 crestColor=mix(litGas*2.2,vec3(.30,.38,.42),.35+foam.y*.25);
          float crestAlpha=1.0-exp(-crestDensity*stepSize*2.0);
          radiance+=transmittance*crestColor*crestAlpha;
          transmittance*=1.0-crestAlpha*.30;
        }
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
  // Dark, demagnified interiors, as in the compressed appearances.
  Section section=viewSection(ro,originalDirection);
  float interior=viewInterior(section,ro,originalDirection);
#if defined(BOW_DISPERSION) || defined(BOW_LAYERS)
  float rimPixel=2.0*length(rimPoint-ro)/(uProjection[1][1]*uResolution.y);
#endif
#ifdef BOW_LAYERS
  // The sheets lie inside the surface, so pixels whose rays stay clear of it
  // skip them (with a margin over the march's own, slightly coarser
  // distance), as do pixels where none of them can show.
  float sheetClosest=sheetNearest;
  BowSheets sheets=noSheets();
  if (sheetNearest<rimPixel*4.0+.3 && bowSheetsShow(sheetPoint.x,rimPixel)) {
    sheetClosest=refinedClosest(sheetPoint,sheetDirection,sheetStep);
    sheets=bowSheets(sheetClosest,sheetPoint,rimPixel,smoothstep(-.5,1.0,sheetPoint.x)*tailFade(sheetPoint.x));
  }
#ifdef BOW_LAYER_LENS
  direction=bowSheetLens(direction,sheetClosest,sheets,sheetPoint.x);
#endif
#endif
#ifdef BOW_DISPERSION
  vec3 refracted=interiorView(section,ro,direction,interior,uEntrance*min(1.0,uIntensity*.5),bowDispersion(direction,originalDirection,rimPoint.x,rimPixel));
#else
  vec3 refracted=interiorView(section,ro,direction,interior,uEntrance*min(1.0,uIntensity*.5));
#endif
#ifdef GAS_FIELD
  refracted=gasBehindField(refracted,gasFront,gasBack,section,interior,ro,originalDirection);
#endif
  // The same lit shell crest as the compressed appearances, seen through the
  // luminous gas in front of it.
  if (uCrestThickness>0.0 && section.front>0.0) {
    float worldPixel=2.0*length(section.entry-ro)/(uProjection[1][1]*uResolution.y);
    float crestFade=smoothstep(-.5,1.0,section.entry.x)*tailFade(section.entry.x);
    radiance+=crestLight(section,worldPixel,crestKey(section.side.y),crestPatches(section.sideUv),crestFade)*transmittance;
  }
#ifdef BOW_LAYERS
  {
    vec2 normal=normalize((projectPosition(rimPoint+rimNormal)-projectPosition(rimPoint))*uResolution+vec2(.00001));
    radiance+=bowLayers(sheets,sheetClosest,sheetPoint,normal,rimPixel,40.0)*transmittance;
  }
#endif
  // The fluid's gas hardly dimmed the old near-black backdrop; with a nebula
  // behind it, the gas in front occludes it instead of adding to it twice.
#ifdef GAS_FIELD
  gl_FragColor=vec4(liftBlacks(gasInFront(refracted*mix(.90+.10*transmittance,transmittance,nebulaOn())+radiance)),1.0);
#else
  gl_FragColor=vec4(liftBlacks(refracted*mix(.90+.10*transmittance,transmittance,nebulaOn())+radiance),1.0);
#endif
}`;

export const volumeFragment = /* glsl */`
${noise}
varying vec2 vUv;
uniform sampler2D tScene, uFluid, uProfile, uProfileSlope;
uniform samplerCube uSurroundings;
uniform mat4 uInverseProjection, uProjection, uCameraMatrix;
uniform vec3 uCameraPosition;
uniform vec2 uResolution;
uniform float uTurbulence, uIntensity, uEntrance, uLensing, uBloom, uBandGlow, uEdgeGlow, uProjectionWidth;
${sceneSampling}
${bowRefraction}
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
${fieldEffects}
${gasNearField(true)}
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
#ifdef PROJECTED_STARS
// Projected stars (Effects › Projection), read from the separate star layer,
// which holds the fourth power of the stars' light (see starPowerFragment).
// Four anisotropic taps average those powers over a band pixel's footprint
// across the compression, pixel-sharp along it. The footprint is twice the
// pixel's own height, so a star is always about two pixels tall rather than
// hopping between one row and two as the band shifts. The fourth root of
// the mean keeps a star that fills a sixteenth of the footprint at half its
// brightness (the plain average keeps a sixteenth), so squeezed stars stay
// bright points and streaks sliding along the band. The layer is the
// visible frame plus a margin (uStarScale), and a projected band never
// reads beyond the frame; anything that did would fade out at the margin.
uniform sampler2D tStarPower;
// uStarRoom: a little under the bloom's threshold (main.js), which the
// stars and the gas under them stay below.
uniform float uStarScale, uProjectedStars, uStarLayer, uStarSparse, uStarRoom;
uniform vec2 uStarPower;
// STAR_BARE: how bright a star is where the band has no gas behind it,
// against one in the gas. STAR_SPARKLE: the light a star may still add
// over gas that already blooms.
const float STAR_FOOTPRINT=2.0, STAR_GAIN=12.0, STAR_SHOULDER=2.0, STAR_BARE=.5, STAR_SPARKLE=.03;
vec3 starColumn(vec2 source, vec2 along, vec2 footprint) {
  vec2 uv=(source-.5)/uStarScale+.5;
  along/=uStarScale; footprint*=STAR_FOOTPRINT/uStarScale;
  vec3 power=vec3(0.0);
  for (int j=0;j<4;j++) {
    power+=textureGrad(tStarPower,uv+footprint*((float(j)+.5)/4.0-.5),along,footprint/4.0).rgb;
  }
  vec2 edge=min(uv,1.0-uv);
  return sqrt(sqrt(power*.25))/uStarPower.x*smoothstep(0.0,.03,min(edge.x,edge.y));
}
const vec3 STAR_LUMA=vec3(.2126,.7152,.0722);
// The clip's flecks in the ribbons are blue-white, while the brightest stars
// are a warm cream; a projected star takes a cool white (unit luminance)
// and part of the hue of the gas it is squeezed in with.
const vec3 STAR_COOL=vec3(.70,.93,1.20)/.9012;
// The stars over a band, before their shoulder (see illuminateBand). Most
// stars are faint dashes and a few are very bright, so their light is
// lifted on a square-root curve: the faint ones become visible dashes over
// the gas without the bright ones being multiplied into glare. The nebula's
// exposure applies, and they are a little dimmer in the centre stream, as
// the band itself is. The centre stream squeezes the most sky into the
// fewest pixels, so it would hold the most stars, nearly a dotted line; a
// soft threshold there (uStarSparse, which follows Star threshold) leaves
// its brighter stars as sparse knots, fading the faint ones out smoothly
// rather than cutting them. 'gas' is the band's own projected light, for
// the hue. The band repeats a screen column, so where it runs steeply on
// screen a short dash would be drawn out along it into a long line, racing
// round the bow or, with Orbit looking down the field, raining down the
// centre stream, as the star passes; 'lying' fades the stars out there, by
// the band's direction on screen (starsAlong, set by volumeFragment for
// each band: along the rim's silhouette; for the centre stream, the lesser
// of how level the projected axis runs and how upright its normal, the
// projected vertical, stands: the first fails looking along the field, the
// second looking down on it from above or below), and only the gas is
// drawn out.
// Round the nose the rim curves faster than its own width, so a band pixel
// can lie on the arc while its closest point on the surface still slopes
// gently; volumeFragment sets this to fade the rim's stars over the first
// few units behind the nose (1 for the centre stream).
vec2 starsAlong=vec2(1.0,0.0);
float starsBehindNose=1.0;
// Light added on top of the band after it (the rim's crest), which the
// stars leave room for under the bloom's threshold.
float starsOver=0.0;
// 'reach': how far across the band (in half-widths) it is drawn at all.
vec3 starBand(float across, float halfWidthPixels, float strength, vec3 gas, float reach, out float lying) {
  lying=smoothstep(.6,.9,abs(starsAlong.x))*starsBehindNose;
  if (abs(across)>=reach || lying<=0.0) return vec3(0.0);
  // The same column as projectedSpace().
  vec2 source=vec2(vUv.x,.5+clamp(across,-1.0,1.0)*.48);
  vec3 stars=starColumn(source,vec2(1.0/uResolution.x,0.0),vec2(0.0,.48/max(halfWidthPixels,1.0)));
  float level=dot(stars,STAR_LUMA);
  float lifted=sqrt(level)*uProjectedStars*STAR_GAIN*mix(.75,1.0,strength)*spaceExposure();
  float sparse=(1.0-strength)*uStarSparse;
  lifted*=lifted*lifted/(lifted*lifted+sparse*sparse+1e-8);
  vec3 own=stars/max(level,1e-6);
  vec3 gasHue=gas+STAR_COOL*.002;
  gasHue/=dot(gasHue,STAR_LUMA);
  return mix(mix(own,STAR_COOL,.7),gasHue,.25)*lifted;
}
#endif

// The floor under the thin edge belongs with the new effects: with the crest
// and its lighting off, the edge is exactly the original hairline.
float edgeFloor() { return min(1.0,max(uCrestThickness,uCrestLight)); }
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
#if defined(BOW_DISPERSION) || defined(BOW_FILM)
#define BOW_BAND_OPTICS
// The bow's optics on a band (Effects › Bow): its colour fringe (red inward,
// blue outward, in band half-widths) and its soap-film tint. The rim passes
// its own; the centre stream passes plainBand().
struct BandOptics { float split; vec3 tint; };
BandOptics plainBand() { BandOptics o; o.split=0.0; o.tint=vec3(1.0); return o; }
#endif
// 'under' is the space the band must not be drawn darker than (about half
// of it): the brighter of what is behind the band and the unbent view.
vec3 illuminateBand(vec3 base, vec2 screenNormal, vec3 worldNormal,
                    float across, float halfWidthPixels, float fade, float strength, float edgeGlow, float shade, float haloScale, vec3 under
#ifdef BOW_BAND_OPTICS
                    , BandOptics optics
#endif
                    ) {
#ifdef BOW_DISPERSION
  // Red and blue sit optics.split half-widths either side of green, so their
  // halos reach that much farther out.
  if (abs(across)>4.0+abs(optics.split) || fade<=0.0 || uIntensity<=0.0) return base;
#else
  if (abs(across)>4.0 || fade<=0.0 || uIntensity<=0.0) return base;
#endif
#ifdef BOW_DISPERSION
  vec3 acrossRGB=across+vec3(optics.split,0.0,-optics.split);
  vec3 opacity=(1.0-smoothstep(.65,1.0,abs(acrossRGB)))*fade*uEntrance*min(1.0,uIntensity*.5);
#else
  float opacity=(1.0-smoothstep(.65,1.0,abs(across)))*fade*uEntrance*min(1.0,uIntensity*.5);
#endif
  if (uBandGlow<.5) {
#ifdef BOW_DISPERSION
    vec3 mask=1.0-smoothstep(.88,1.0,abs(acrossRGB));
#else
    float mask=1.0-smoothstep(.88,1.0,abs(across));
#endif
    float visibility=fade*uEntrance*min(1.0,uIntensity*.5);
    vec3 projected=projectedSpace(clamp(across,-1.0,1.0),halfWidthPixels);
    // Recover light lost to minification, retaining the actual projected
    // stars/nebula rather than filling the ribbons with average ambient light.
    float compression=.48*uResolution.y/max(halfWidthPixels,1.0);
    float gain=clamp(sqrt(compression)*1.3,4.0,18.0)*mix(.75,1.0,strength)*spaceExposure();
    vec3 detail=bandLight(projected,gain*(1.0+edgeGlow*2.0))*shade;
#ifdef BOW_FILM
    detail*=optics.tint;
#endif
    // The ribbon is a compressed image of space, never an ink outline: it is
    // not drawn darker than about half of the space just beside it.
    detail=max(detail,under*.55*edgeFloor());
#ifdef PROJECTED_STARS
    // Projected stars (Effects › Projection). Edge glow brightens them with
    // the ribbon (its halo below is the gas's alone). They are drawn mostly
    // where the band has gas to carry them: over the band's dark stretches
    // (the bare sky squeezed in beside the crest, the dark side of the
    // centre stream) they are half as bright, so fewer dashes line the
    // crest and the dark half of the stream is not crowded. The band's mask
    // is 0 beyond a half-width (each channel's own, split by Dispersion),
    // so no stars are read there.
#ifdef BOW_DISPERSION
    float starReach=min(1.0+abs(optics.split),1.5);
#else
    float starReach=1.0;
#endif
    float starLying;
    vec3 stars=starBand(across,halfWidthPixels,strength,projected,starReach,starLying)*(1.0+edgeGlow*2.0);
    float gasLevel=dot(detail,STAR_LUMA);
    stars*=mix(STAR_BARE,1.0,smoothstep(.01,.15,gasLevel));
    if (uStarLayer<.5) {
      // Separate star layer off (the experiment): the stars join the gas and
      // pass through the ribbon's own shoulder, floor and tint with it.
      detail=bandLight(projected+stars*(starLying/(gain*(1.0+edgeGlow*2.0))),gain*(1.0+edgeGlow*2.0))*shade;
#ifdef BOW_FILM
      detail*=optics.tint;
#endif
      detail=max(detail,under*.55*edgeFloor());
    } else {
      // A layer of their own, on top, after the floor, so bright gas behind
      // a band (the floor's per-channel max) cannot swallow part of their
      // colour. The key light dims them less than the gas, so the shaded
      // lower rim keeps its stars. A shoulder of their own holds the
      // brightest to about half the scene's white, and they give way as the
      // band nears the bloom's threshold, so a star stays a crisp point
      // rather than flaring into a round glint. The bloom takes a pixel's
      // whole light once it passes the threshold, so a star must not lift
      // gas just under it across: the room closes there, on purpose, before
      // gas that already blooms (well past it) gets back a faint sparkle,
      // which only adds its own little light to the bloom. The crest's light,
      // added on top of the rim afterwards (starsOver), counts as gas here:
      // stars crossing its key-lit hot spot made the hot spot's halo pulse.
      vec3 starLight=stars*sqrt(shade);
      starLight/=1.0+dot(starLight,STAR_LUMA)*STAR_SHOULDER;
      float below=gasLevel+starsOver;
      float room=max(uStarRoom-below,0.0)+STAR_SPARKLE*smoothstep(uStarRoom+.04,uStarRoom+.16,below);
      // A soft minimum of the star and the room left (a 4-norm): a star well
      // inside the room is untouched.
      float fill=dot(starLight,STAR_LUMA)/max(room,1e-4);
      fill*=fill;
      starLight*=starLying*inversesqrt(sqrt(1.0+fill*fill));
#ifdef BOW_FILM
      starLight*=optics.tint;
#endif
      detail+=starLight;
    }
#endif
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
      color+=halo*(edgeGlow*.18)*shade*(1.0-smoothstep(3.0,4.0,abs(across)))*visibility;
    }
    return color;
  }
  vec3 compressed=compressedSpace(screenNormal,clamp(across,-1.0,1.0),halfWidthPixels);
  vec3 gathered=surroundingLight(screenNormal,worldNormal);
  // Concentrating a wide strip into a few pixels must also concentrate light.
  float compression=.46*length(screenNormal*uResolution)/max(halfWidthPixels,1.0);
  float gain=clamp(sqrt(compression)*2.2,10.0,32.0);
  vec3 detail=bandLight(compressed,gain*spaceExposure());
  vec3 glow=bandLight(gathered,40.0*spaceExposure());
  // A bright bank in the compressed column pushed short stretches of the edge
  // into a blooming, lens-like hot spot; a softer shoulder (only with the
  // nebula on) keeps them whitewater-bright instead.
  float soften=.9*nebulaOn();
  detail=detail/(1.0+dot(detail,vec3(.2126,.7152,.0722))*soften)*strength*shade;
  // The thin edge replaces most of the space behind it; against bright gas a
  // dim stretch of edge would read as a dark outline, so it keeps a floor.
  detail=max(detail,under*.60*edgeFloor()*strength);
  glow/=1.0+dot(glow,vec3(.2126,.7152,.0722))*soften;
  // Against bright gas the gathered light can be far brighter than the sky
  // average the exposure follows (looking down into a bank from above), and
  // the column and edge blew out into a white, cross-shaped glare. A knee on
  // the gathered luminance itself caps them; ordinary levels pass unchanged.
  glow=mix(glow,knee(glow,.20,.12),nebulaOn());
  detail=mix(detail,knee(detail,.26,.16),nebulaOn());
#ifdef BOW_FILM
  detail*=optics.tint; glow*=optics.tint;
#endif
#ifdef BOW_DISPERSION
  vec3 core=exp(-acrossRGB*acrossRGB*1.8);
  vec3 halo=exp(-acrossRGB*acrossRGB*.32)*uBloom*.38*haloScale;
#else
  float core=exp(-across*across*1.8);
  float halo=exp(-across*across*.32)*uBloom*.38*haloScale;
#endif
  vec3 color=mix(base,detail,opacity*.70);
  return color+glow*(core+halo)*fade*uEntrance*uIntensity*strength*shade;
}

// Hero sources (screen uv, brightness, radius in screen heights). A bright
// source just behind the shell is focused into the edge around it, so a short
// arc of the rim flashes as the source crosses it, splitting into an upper and
// a lower arc once it is behind the bubble. Added after the knees on purpose:
// it is a brief caustic, and the lens bloom and streak spread it.
uniform vec4 uHeroCaustic[HERO_COUNT];
vec3 heroCaustic(float rimPixels, float fade) {
  float scale=uResolution.y/536.0;
  float rim2=rimPixels*rimPixels/(scale*scale);
  // A thin lit arc either side of the source, and a broader, much hotter
  // focus where the edge passes closest to it.
  float arc=exp(-rim2/20.0), focus=exp(-rim2/110.0);
  if (focus<.002 || fade<=0.0) return vec3(0.0);
  vec3 light=vec3(0.0);
  for (int i=0;i<HERO_COUNT;i++) {
    vec4 hero=uHeroCaustic[i];
    if (hero.z<=0.0) continue;
    vec2 d=(vUv-hero.xy)*vec2(uResolution.x/uResolution.y,1.0)/hero.w;
    float r2=dot(d,d);
    light+=hero.z*(vec3(.96,.88,1.0)*exp(-r2)*arc*.22+vec3(.95,.98,1.0)*exp(-r2*12.0)*focus);
  }
  return light*fade;
}

// Compressed glow mixes in the light gathered from all around the field;
// Compressed space reflects only the space above the crest and the sky
// around the camera, so dark surroundings still leave it dark.
vec3 crestEnvironment(vec2 screenNormal, vec3 normal, vec3 side, vec3 reflected, out float gain, out float whiten) {
  if (uBandGlow>.5) {
    gain=64.0*spaceExposure(); whiten=1.0;
    return surroundingLight(screenNormal,normal)*.55+reflected*.45;
  }
  // Compressed space keeps its own signature: the reprojected ribbon carries
  // the edge, so the crest is about half as bright and its whitewater keeps
  // the colour of the space it reflects instead of turning white.
  gain=22.0*spaceExposure(); whiten=.35;
  return reflected*.75+skyAverage()*.25;
}
${bowSurface}
${fieldCrest}
${gasAmbientChunk}

void main() {
  vec4 vr=uInverseProjection*vec4(vUv*2.0-1.0,1.0,1.0);
  vec3 originalDirection=normalize(mat3(uCameraMatrix)*vr.xyz);
  vec3 direction=originalDirection;
  vec3 ro=uCameraPosition;
  vec2 bounds=intersectBox(ro,direction);
  float nearT=max(0.0,bounds.x),farT=bounds.y;
  // Rays that miss the field's box fall straight through the march below; an
  // early return here left neighbouring pixels without texture derivatives,
  // which showed as a bright seam along the box edge over a bright sky.
  vec3 p=ro+direction*nearT;
#ifdef GAS_FIELD
  // Column of the gas layer in front of the field and behind it (seen through it).
  vec4 gasFront=vec4(0.0), gasBack=vec4(0.0);
  float gasEntered=0.0, gasReach=gasLayerReach();
#endif
  float travelled=nearT;
  float closest=1e5;
  vec3 rimPoint=p, rimNormal=vec3(0.0,1.0,0.0);
#ifdef BOW_LAYERS
  // Where the ray passes deepest under the surface (by sheetDistance()), and
  // its direction and step there, to refine it for the nested sheets.
  float sheetNearest=1e5;
  vec3 sheetPoint=p, sheetDirection=direction;
  float sheetStep=0.0;
#endif
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
#ifdef BOW_LAYERS
    float sheetHere=sheetDistance(baseDistance,implicitDistance,gradient,heightSlope,shape.slope,y,scale,depth,height,p.x);
#endif
    vec3 baseNormal=gradient/max(length(gradient),.0001);
    if (baseDistance<closest) {
      closest=baseDistance; rimPoint=p; rimNormal=baseNormal;
    }
    float wake=smoothstep(8.0,130.0,p.x);
    float minStep=.035+max(p.x,0.0)*.0012;
    float stepSize=min(clamp(abs(baseDistance)*.42,minStep,(farT-nearT)/22.0),farT-travelled);
#ifdef BOW_LAYERS
    if (sheetHere<sheetNearest) { sheetNearest=sheetHere; sheetPoint=p; sheetDirection=direction; sheetStep=stepSize; }
#endif
#ifdef GAS_FIELD
    if (baseDistance<0.0) gasEntered=1.0;
    else if (baseDistance<gasReach) {
      // Seen edge-on the layer is a long path through piled-up gas; seen
      // face-on, over a dark interior, it is thin and nearly clear.
      float facing=1.0-abs(dot(baseNormal,direction));
      // (Gas within a few units of the camera, in the bow close-ups, is out
      // of focus and out of the picture.)
      float gasWeight=gasLayer(baseDistance,p,height,radial/r)*stepSize*(.08+.92*facing*facing)*smoothstep(5.0,20.0,travelled);
      if (gasEntered>.5) gasBack+=vec4(p,1.0)*gasWeight; else gasFront+=vec4(p,1.0)*gasWeight;
    }
#endif
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

  float worldPixel=2.0*length(rimPoint-ro)/(uProjection[1][1]*uResolution.y);
  float fade=smoothstep(-.5,1.0,rimPoint.x)*tailFade(rimPoint.x);
  vec2 normal=normalize((projectPosition(rimPoint+rimNormal)-projectPosition(rimPoint))*uResolution+vec2(.00001));
  Section section=viewSection(ro,originalDirection);
  float patches=crestPatches(section.sideUv);
  float fieldLight=uEntrance*min(1.0,uIntensity*.5);

  // Dark interiors: the shell gathers light toward its rim, so what is seen
  // through the inside is demagnified and dimmed. The energy-conserving
  // experiment ties the loss to the brightness of the crest above it.
  float interior=viewInterior(section,ro,originalDirection);
#ifdef BOW_LAYERS
  // The sheets lie inside the surface, so pixels whose rays stay clear of it
  // skip them (with a margin over the march's own, slightly coarser
  // distance), as do pixels where none of them can show.
  float sheetClosest=sheetNearest;
  BowSheets sheets=noSheets();
  if (sheetNearest<worldPixel*4.0+.3 && bowSheetsShow(sheetPoint.x,worldPixel)) {
    sheetClosest=refinedClosest(sheetPoint,sheetDirection,sheetStep);
    sheets=bowSheets(sheetClosest,sheetPoint,worldPixel,smoothstep(-.5,1.0,sheetPoint.x)*tailFade(sheetPoint.x));
  }
#ifdef BOW_LAYER_LENS
  direction=bowSheetLens(direction,sheetClosest,sheets,sheetPoint.x);
#endif
#endif
#ifdef BOW_DISPERSION
  vec3 color=interiorView(section,ro,direction,interior,fieldLight,bowDispersion(direction,originalDirection,rimPoint.x,worldPixel));
#else
  vec3 color=interiorView(section,ro,direction,interior,fieldLight);
#endif
#ifdef GAS_FIELD
  color=gasBehindField(color,gasFront,gasBack,section,interior,ro,originalDirection);
#endif

  // The thin optical ribbon at the silhouette, then the thick crest just
  // inside it, laid over the ribbon so the lit edge stays continuous.
  float width=max(.045+smoothstep(8.0,150.0,rimPoint.x)*1.15,worldPixel*1.25);
  if (uBandGlow<.5) width=max(width*1.8,worldPixel*4.0)*uProjectionWidth;
  float across=closest/width;
  // Where the thick crest is on, it replaces most of the hairline's soft halo.
  // In Compressed space the wide ribbon is the reprojected sky itself, so the
  // key light and patches only shade it gently; at full depth they turned the
  // lower ribbon into a black band. The patches only ever dim the thin edge:
  // brightening it flared into a flat, lens-like bar. The crest carries the
  // bright stretches instead.
  float edgeShade=min(1.0,uBandGlow>.5 ? crestKey(rimNormal.y)*patches*edgeChunk(section.sideUv)
    : mix(1.0,crestKey(rimNormal.y),.30)*mix(1.0,patches,.35));
  // Inside the silhouette the band lies over the darkened interior, so its
  // floor also follows the unbent view of the space behind the edge: against
  // bright gas the edge never reads as an ink outline.
  vec3 under=max(color,backgroundAlong(originalDirection)*.9);
#ifdef PROJECTED_STARS
  starsAlong=vec2(normal.y,-normal.x);
  starsBehindNose=smoothstep(3.0,10.0,rimPoint.x);
  // The crest's light lands on top of the rim after it (the same light,
  // computed first), so the stars leave room for it under the bloom.
  vec3 crest=vec3(0.0);
  if (uCrestThickness>0.0 && section.front>0.0) {
    float crestFade=smoothstep(-.5,1.0,section.entry.x)*tailFade(section.entry.x);
    crest=crestLight(section,worldPixel,crestKey(section.side.y),patches,crestFade);
  }
  starsOver=dot(crest,STAR_LUMA);
#endif
#ifdef BOW_BAND_OPTICS
  BandOptics rimOptics=plainBand();
#ifdef BOW_DISPERSION
  // About a pixel of fringe at the nose in the close-ups, a third of that
  // downstream, and less than a pixel once the camera pulls back.
  // Where the rim is at its narrowest (a pixel and a quarter either side)
  // its edge is a stair-step, and a split would bead it with red and blue; it
  // fades there.
  rimOptics.split=uBow.x*mix(.15,1.0,bowNose(rimPoint.x))*bowFringeScale(worldPixel)*worldPixel/width
    *smoothstep(1.3,2.2,width/worldPixel);
#endif
#ifdef BOW_FILM
  // Compressed glow's rim is mostly gathered light, which the tint barely
  // showed through at the crest's strength.
  rimOptics.tint=filmTint(section.sideUv,section.vertical,1.0,rimPoint.x,0.0,uBandGlow>.5 ? 1.5 : 1.0,worldPixel);
#endif
  color=illuminateBand(color,normal,rimNormal,across,width/worldPixel,fade,1.0,uEdgeGlow,edgeShade,1.0-.65*min(uCrestThickness,1.0),under,rimOptics);
#else
  color=illuminateBand(color,normal,rimNormal,across,width/worldPixel,fade,1.0,uEdgeGlow,edgeShade,1.0-.65*min(uCrestThickness,1.0),under);
#endif
#ifdef PROJECTED_STARS
  color+=crest;
  starsOver=0.0;
#else
  if (uCrestThickness>0.0 && section.front>0.0) {
    float crestFade=smoothstep(-.5,1.0,section.entry.x)*tailFade(section.entry.x);
    color+=crestLight(section,worldPixel,crestKey(section.side.y),patches,crestFade);
  }
#endif
#ifdef BOW_LAYERS
  color+=bowLayers(sheets,sheetClosest,sheetPoint,normal,worldPixel,uBandGlow>.5 ? 60.0 : 34.0);
#endif
  // The lens ring just inside the silhouette bends in space from far away
  // (the dark sky, for the lower edge); against bright gas it read as a
  // heavy dark outline once the dimmer lower crest no longer covered it. It
  // keeps at least about half the brightness of the unbent view behind it.
  // The lens bends rays within its width on both sides of the surface.
  float lensWidth=.18+max(rimPoint.x,0.0)*.009;
  float ring=1.0-smoothstep(1.2*lensWidth,2.6*lensWidth,abs(closest));
  color=max(color,under*.5*ring*edgeFloor()*fade);

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
#ifdef PROJECTED_STARS
  // The stream lies flat only where both its run (the projected axis) is
  // level and its across direction (axisNormal, the projected vertical) is
  // upright. Looking along the axis the first fails; looking down on the
  // field from steeply above or below, the second does: axisNormal turns
  // radial, the lines of equal 'across' run down the screen, and each star
  // would be stretched into a vertical bar.
  starsAlong=normalize((projectPosition(axis+vec3(1.0,0.0,0.0))-axisUv)*uResolution+vec2(.00001));
  starsAlong=vec2(min(abs(starsAlong.x),abs(axisNormal.y)),0.0);
  starsBehindNose=1.0;
#endif
#ifdef BOW_BAND_OPTICS
  color=illuminateBand(color,axisNormal,vec3(0.0,1.0,0.0),centerAcross,halfWidth,centerFade,.38,0.0,1.0,1.0,color,plainBand());
#else
  color=illuminateBand(color,axisNormal,vec3(0.0,1.0,0.0),centerAcross,halfWidth,centerFade,.38,0.0,1.0,1.0,color);
#endif
  color+=heroCaustic(abs(closest)/worldPixel,fade);
#ifdef GAS_FIELD
  color=gasInFront(color);
#endif
  gl_FragColor=vec4(liftBlacks(color),1.0);
}`;

export const lensFragment = /* glsl */`
uniform sampler2D tDiffuse, tStreak;
uniform float uTime;
uniform float uBloom;
uniform float uOldFlare, uStreak, uVignette, uLetterbox, uBlackLevel;
uniform vec2 uResolution, uStreakTexel;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec3 oldFlare() {
  vec3 flare = vec3(0.0);
  for (int i = 1; i <= 5; i++) {
    vec2 o = vec2(float(i) * .012, 0.0);
    flare += max(texture2D(tDiffuse, vUv + o).rgb - .52, 0.0) / float(i + 1);
    flare += max(texture2D(tDiffuse, vUv - o).rgb - .52, 0.0) / float(i + 1);
  }
  return flare;
}
void main() {
  vec2 p = vUv - .5;
  vec2 aberration = p * dot(p, p) * .0016;
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  c.r = texture2D(tDiffuse, vUv + aberration).r;
  c.b = texture2D(tDiffuse, vUv - aberration).b;
  // The original faint five-tap horizontal flare. The anamorphic streak bloom
  // replaces it, so it only remains while Streak bloom is at (or near) 0%,
  // where it is evaluated exactly as before.
  if (uOldFlare >= 1.0) c += oldFlare() * vec3(.04, .08, .15) * (uBloom/.65);
  else if (uOldFlare > 0.0) c += oldFlare() * vec3(.04, .08, .15) * (uBloom/.65) * uOldFlare;
  // Anamorphic streak bloom, computed at reduced resolution from the HDR frame
  // before the round bloom; a final 3-tap pass smooths its upsampling.
  if (uStreak > 0.0) {
    float dx = uStreakTexel.x * 1.5;
    vec3 streak = texture2D(tStreak, vUv - vec2(dx, 0.0)).rgb * .25 + texture2D(tStreak, vUv).rgb * .5
      + texture2D(tStreak, vUv + vec2(dx, 0.0)).rgb * .25;
    c += streak * uStreak;
  }
  // One vignette, in scene light like a real lens's. The original gentle
  // falloff is evaluated exactly as before; Vignette deepens the corners on
  // top of it, following the 2.39:1 picture inside the letterbox. It starts
  // well out from the centre, so the middle of the frame keeps its light, and
  // it darkens the corners only down to Black level's deep-blue floor, never
  // below it (the floor is the colour liftBlacks adds to black).
  float vignette = 1.0 - .45 * dot(p * vec2(.85, 1.0), p);
  c *= vignette;
  if (uVignette > 0.0) {
    vec2 q = vec2(p.x, p.y / max(1.0 - 2.0 * uLetterbox, .01)) * 2.0;
    float deeper = exp(-uVignette * .42 * smoothstep(.5, 2.0, dot(q, q * vec2(.8, 1.0))));
    c = max(c * deeper, min(c, uBlackLevel * vec3(.0042, .0068, .0105)));
  }
  // Grain lives in the film pass, after FXAA, where it cannot be smeared.
  gl_FragColor = vec4(max(c, vec3(0.0)), 1.0);
}`;
