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

// A brighter, filamentary nebula for the backdrop. Two levels of domain
// warping fold the fbm into banks, wisps and dark dust lanes; it is fixed in
// the passing world (only travelled distance moves it) and denser below the
// field. Nebula brightness/density at zero leave only the original faint fog.
const nebula = /* glsl */`
uniform float uNebula, uNebulaDensity, uNebulaGlow;
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
      vec4 cloud=nebulaAt(uCameraPosition+ray*(190.0+float(i)*62.0),horizon,hot);
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
vec3 backgroundAlongLod(vec3 direction,float level) {
  vec3 view=vec3(dot(direction,uCameraMatrix[0].xyz),dot(direction,uCameraMatrix[1].xyz),dot(direction,uCameraMatrix[2].xyz));
  if (view.z>=-.05) return textureLod(uOffscreenScene,direction,level).rgb;
  vec4 projected=uProjection*vec4(view,0.0);
  return backgroundLod(projected.xy/projected.w*.5+.5,level);
}
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
vec3 interiorView(Section section, vec3 ro, vec3 direction, float interior, float fieldLight) {
  float lens=clamp(uLensing/.7,0.0,1.0);
  float shrink=uInteriorShrink*interior*lens;
  vec3 outgoing=direction;
  if (shrink>0.0) {
    vec3 axisDirection=normalize(vec3(section.entry.x,0.0,0.0)-ro);
    vec3 offset=direction-axisDirection;
    offset.x*=.35;
    outgoing=normalize(direction+offset*shrink*1.6);
  }
  // Implicit-derivative lookup in uniform control flow.
  vec3 color=backgroundAlong(outgoing);
  if (shrink>0.0) {
    float squeeze=1.0+shrink*1.6;
    color=mix(color,backgroundAlongLod(outgoing,log2(squeeze)*2.2+1.2),smoothstep(0.0,.3,interior));
  }
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
  if (shell<=.0001) return vec3(0.0);
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
  return light*shell*fade*uEntrance*min(1.0,uIntensity*.5);
}
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
${fieldCrest}

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
  float interior=interiorAmount(section,ro,originalDirection);
  vec3 refracted=interiorView(section,ro,direction,interior,uEntrance*min(1.0,uIntensity*.5));
  // The same lit shell crest as the compressed appearances, seen through the
  // luminous gas in front of it.
  if (uCrestThickness>0.0 && section.front>0.0) {
    float worldPixel=2.0*length(section.entry-ro)/(uProjection[1][1]*uResolution.y);
    float crestFade=smoothstep(-.5,1.0,section.entry.x)*tailFade(section.entry.x);
    radiance+=crestLight(section,worldPixel,crestKey(section.side.y),crestPatches(section.sideUv),crestFade)*transmittance;
  }
  // The fluid's gas hardly dimmed the old near-black backdrop; with a nebula
  // behind it, the gas in front occludes it instead of adding to it twice.
  gl_FragColor=vec4(liftBlacks(refracted*mix(.90+.10*transmittance,transmittance,nebulaOn())+radiance),1.0);
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
// 'under' is the space the band must not be drawn darker than (about half
// of it): the brighter of what is behind the band and the unbent view.
vec3 illuminateBand(vec3 base, vec2 screenNormal, vec3 worldNormal,
                    float across, float halfWidthPixels, float fade, float strength, float edgeGlow, float shade, float haloScale, vec3 under) {
  if (abs(across)>4.0 || fade<=0.0 || uIntensity<=0.0) return base;
  float opacity=(1.0-smoothstep(.65,1.0,abs(across)))*fade*uEntrance*min(1.0,uIntensity*.5);
  if (uBandGlow<.5) {
    float mask=1.0-smoothstep(.88,1.0,abs(across));
    float visibility=fade*uEntrance*min(1.0,uIntensity*.5);
    vec3 projected=projectedSpace(clamp(across,-1.0,1.0),halfWidthPixels);
    // Recover light lost to minification, retaining the actual projected
    // stars/nebula rather than filling the ribbons with average ambient light.
    float compression=.48*uResolution.y/max(halfWidthPixels,1.0);
    float gain=clamp(sqrt(compression)*1.3,4.0,18.0)*mix(.75,1.0,strength)*spaceExposure();
    vec3 detail=bandLight(projected,gain*(1.0+edgeGlow*2.0))*shade;
    // The ribbon is a compressed image of space, never an ink outline: it is
    // not drawn darker than about half of the space just beside it.
    detail=max(detail,under*.55*edgeFloor());
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
  float core=exp(-across*across*1.8);
  float halo=exp(-across*across*.32)*uBloom*.38*haloScale;
  vec3 color=mix(base,detail,opacity*.70);
  return color+glow*(core+halo)*fade*uEntrance*uIntensity*strength*shade;
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
${fieldCrest}

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

  float worldPixel=2.0*length(rimPoint-ro)/(uProjection[1][1]*uResolution.y);
  float fade=smoothstep(-.5,1.0,rimPoint.x)*tailFade(rimPoint.x);
  vec2 normal=normalize((projectPosition(rimPoint+rimNormal)-projectPosition(rimPoint))*uResolution+vec2(.00001));
  Section section=viewSection(ro,originalDirection);
  float patches=crestPatches(section.sideUv);
  float fieldLight=uEntrance*min(1.0,uIntensity*.5);

  // Dark interiors: the shell gathers light toward its rim, so what is seen
  // through the inside is demagnified and dimmed. The energy-conserving
  // experiment ties the loss to the brightness of the crest above it.
  float interior=interiorAmount(section,ro,originalDirection);
  vec3 color=interiorView(section,ro,direction,interior,fieldLight);

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
  color=illuminateBand(color,normal,rimNormal,across,width/worldPixel,fade,1.0,uEdgeGlow,edgeShade,1.0-.65*min(uCrestThickness,1.0),under);
  if (uCrestThickness>0.0 && section.front>0.0) {
    float crestFade=smoothstep(-.5,1.0,section.entry.x)*tailFade(section.entry.x);
    color+=crestLight(section,worldPixel,crestKey(section.side.y),patches,crestFade);
  }
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
  color=illuminateBand(color,axisNormal,vec3(0.0,1.0,0.0),centerAcross,halfWidth,centerFade,.38,0.0,1.0,1.0,color);
  gl_FragColor=vec4(liftBlacks(color),1.0);
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
