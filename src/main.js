import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { fullscreenVertex, backgroundFragment, starVertex, starFragment, heroVertex, heroFragment, volumeFragment, fluidVolumeFragment, lensFragment } from './shaders.js';
import { StreakBloomPass, HeroFlashPass } from './streak.js';
import { createShip } from './ship.js';
import { FilmPass } from './film.js';
import { GasFlow } from './gasflow.js';
import { ShellFluid } from './fluid.js';
import { WarpField, FIELD_LENGTH } from './field.js';
import { REFERENCE_DURATION, referenceCameraAt } from './reference-sequence.js';
import { FLYBY_DURATION, flybyCameraAt } from './flyby-sequence.js';
import './style.css';

const $ = (id) => document.getElementById(id);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const params = new URLSearchParams(location.search);
const state = {
  time: Number(params.get('time') ?? 4),
  travel: 12,
  playing: !reducedMotion && !params.has('paused'),
  view: ['tracking','bow','orbit','ride','flyby'].includes(params.get('view')) ? params.get('view') : 'tracking',
  speed: 10,
  turbulence: 1.5,
  intensity: 2,
  lensing: .7,
  bloom: .65,
  edgeGlow: 0,
  projectionWidth: 2,
  stars: 1,
  appearance: ['fluid', 'space'].includes(params.get('appearance')) ? params.get('appearance') : 'glow',
  quality: innerWidth < 700 ? 'low' : 'balanced',
  ship: true,
  entrance: 1,
  hidden: false,
};
// Effects panel. Every control at 0 (or off) restores the earlier look.
// Values can also be set from the URL, e.g. ?nebula=0&crestThickness=1.5.
const EFFECTS = {
  nebula: 1, nebulaDensity: 1, nebulaGlow: 1, blackLevel: 1,
  interior: .92, interiorShrink: .6, crestThickness: 1, crestLight: .85, crestVariation: 1,
  energyRim: true,
  gas: 1, gasShock: 1, gasPileup: 1, gasDepth: 1, gasFlow: 1, gasReacts: true,
  streak: 1, streakLength: .75, streakTint: .8, heroFlares: 1, starStreaks: 1,
  grain: 1, softness: 1, focus: 1, dust: 1, grade: 1, vignette: 1, letterbox: true,
  dispersion: 1, iridescence: 1, bowLayers: 1, layerSpread: 1, filmFlow: true, layerRefraction: true,
};
const EFFECT_SLIDERS = Object.keys(EFFECTS).filter(key => typeof EFFECTS[key] === 'number');
const EFFECT_TOGGLES = Object.keys(EFFECTS).filter(key => typeof EFFECTS[key] === 'boolean');
const readParam = (key, fallback) => {
  const raw = params.get(key);
  if (raw === null) return fallback;
  if (typeof fallback === 'boolean') return !['0', 'false', 'off'].includes(raw.toLowerCase());
  if (raw === '' || !Number.isFinite(Number(raw))) return fallback;
  // Keep URL values inside the slider's own range, so the label, the slider
  // and the shader always agree (and nothing can go negative).
  const input = document.getElementById(key);
  const min = Number(input?.min ?? -Infinity), max = Number(input?.max ?? Infinity);
  return Math.min(max, Math.max(min, Number(raw)));
};
for (const [key, value] of Object.entries(EFFECTS)) state[key] = readParam(key, value);
// One-click A/B: shows the original look without moving any slider.
state.effectsBypass = readParam('effectsBypass', false);
const effectValue = key => state.effectsBypass ? (typeof EFFECTS[key] === 'boolean' ? false : 0) : state[key];
let renderer, sceneTarget, composer, camera, orbit, background, world, foreground, composite, shipScene, fluid, field;
let shared, starUniforms, volumeMaterial, bloom, lens, ship, fxaa, starMesh, farStars;
let streak, heroFlash, heroUniforms, heroMesh, starStreaksOn = false;
const starMaterials = [], heroCopies = [];
let lightTarget, lightCamera, lightScene, lightKey = '';
let film;
// The gas that reacts to the field: its flow table, and every material whose
// shader switches GAS_FIELD (so with the gas off they are the original ones).
let gasFlow, gasOn = false;
const gasMaterials = [];
let sceneCamera, offscreenTarget, offscreenCamera, offscreenKey = '';
const SCENE_OVERSCAN = 1.8;
const STAR_COUNT = 7200, FAR_STAR_COUNT = 1200;
// Hero sources: [phase, height, depth, speed, period, size, warmth, brightness].
// x = mod(phase + travel*speed, period) - period/2, like the stars. The first
// is placed so the reference camera, unchanged, finds it crossing the rounded
// bow at 2.0 s (travel 812), about 16 px above the centre line so its streak
// runs beside the centre stream rather than along it; the wide and bow views
// meet it at the bow tip too. The other two are dimmer and stay out of the
// reference shot and the default still (travel 12): they pass above the
// crests and below the lower edges of the wide view now and then, as bright
// streaking stars. The field's edges there are nearly level, so they would
// only graze them, and a grazing pass does not flash (see updateHeroes).
const HEROES = [
  [1664.6, .216, -300, .55, 4400, 1, .15, 1],
  [3040, 92, -200, .8, 5200, .9, .6, .6],
  [539, -118, -250, .7, 6100, 1.1, .3, .7],
];
const HERO_CAUSTIC = 2.0, HERO_RADIUS = .08, HERO_FLASH = 1.4, HERO_FLASH_WIDTH = .05, STREAK_GAIN = 10;
// |sin| of the angle between a hero's path and the edge it is crossing:
// below the first value it does not flash at all, above the second fully.
const HERO_CROSSING = [.25, .6];
let previous = performance.now(), frames = 0, fpsStart = previous, fps = 0;
let noticeTimer, resizing;
const reference = { active: false, time: 0, loading: false, silent: false, finished: false, revision: 0, autoMuted: false };
const flyby = { active: false, time: 0, finished: false };
const referenceAudio = $('reference-audio');
referenceAudio.src = `${import.meta.env.BASE_URL}audio/beyond-reference.m4a`;
referenceAudio.volume = .75;
const cameraTarget = new THREE.Vector3(130, 0, 0);
const desiredPosition = new THREE.Vector3();
const desiredTarget = new THREE.Vector3();
const quality = { low: { scale: .7, steps: 96 }, balanced: { scale: 1, steps: 160 }, high: { scale: 1.25, steps: 240 } };


function randomGenerator(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

function noiseTexture() {
  const random = randomGenerator(1701);
  const data = new Uint8Array(64 * 64 * 64 * 4);
  for (let i = 0; i < data.length; i++) data[i] = Math.floor(random() * 256);
  const texture = new THREE.Data3DTexture(data, 64, 64, 64);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = texture.wrapR = THREE.RepeatWrapping;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

function makeFullscreenScene(fragmentShader, uniforms, defines = {}) {
  const scene = new THREE.Scene();
  const material = new THREE.ShaderMaterial({ vertexShader: fullscreenVertex, fragmentShader, uniforms, defines, depthTest: false, depthWrite: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  scene.add(mesh);
  return { scene, material };
}

function makeStars() {
  const random = randomGenerator(2049);
  const base = new THREE.PlaneGeometry(2, 2);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = base.index; geometry.attributes.position = base.attributes.position; geometry.attributes.uv = base.attributes.uv;
  const count = STAR_COUNT*2;
  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    seeds.set([random() * 3200, (random() - .5) * 480, (random() - .5) * 960, random()], i * 4);
  }
  geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
  geometry.instanceCount = STAR_COUNT;
  starUniforms = { uTravel: { value: state.travel }, uVelocity: { value: spaceVelocity() }, uBloom: { value: state.bloom }, uForeground: { value: 0 }, uStarStreak: { value: state.starStreaks } };
  const material = new THREE.ShaderMaterial({ vertexShader: starVertex, fragmentShader: starFragment, uniforms: starUniforms, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  starMaterials.push(material);
  starMesh = new THREE.Mesh(geometry, material);
  starMesh.frustumCulled = false; world.add(starMesh);
  const foregroundMaterial = material.clone();
  foregroundMaterial.uniforms = { ...starUniforms, uForeground: { value: 1 } };
  foregroundMaterial.depthTest = false;
  starMaterials.push(foregroundMaterial);
  const foregroundStars = new THREE.Mesh(geometry, foregroundMaterial);
  foregroundStars.frustumCulled = false;
  foreground.add(foregroundStars);

  const positions = new Float32Array(FAR_STAR_COUNT * 2 * 3);
  for (let i = 0; i < FAR_STAR_COUNT*2; i++) {
    const v = new THREE.Vector3(random() - .5, random() - .5, random() - .5).normalize().multiplyScalar(650 + random() * 400);
    positions.set(v.toArray(), i * 3);
  }
  const points = new THREE.BufferGeometry(); points.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  farStars = new THREE.Points(points, new THREE.PointsMaterial({ color: 0x6093aa, size: .18, transparent: true, opacity: .42, depthWrite: false }));
  world.add(farStars);
}

function makeHeroes() {
  const base = new THREE.PlaneGeometry(2, 2);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = base.index; geometry.attributes.position = base.attributes.position; geometry.attributes.uv = base.attributes.uv;
  geometry.setAttribute('aHero', new THREE.InstancedBufferAttribute(new Float32Array(HEROES.flatMap(hero => hero.slice(0, 4))), 4));
  geometry.setAttribute('aHeroLook', new THREE.InstancedBufferAttribute(new Float32Array(HEROES.flatMap(hero => hero.slice(4, 8))), 4));
  geometry.instanceCount = HEROES.length;
  heroUniforms = { uTravel: starUniforms.uTravel, uVelocity: starUniforms.uVelocity, uHeroGain: { value: state.heroFlares }, uForeground: { value: 0 } };
  const material = new THREE.ShaderMaterial({ vertexShader: heroVertex, fragmentShader: heroFragment, uniforms: heroUniforms, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  heroMesh = new THREE.Mesh(geometry, material);
  heroMesh.frustumCulled = false; world.add(heroMesh);
  const foregroundMaterial = material.clone();
  foregroundMaterial.uniforms = { ...heroUniforms, uForeground: { value: 1 } };
  foregroundMaterial.depthTest = false;
  const foregroundHeroes = new THREE.Mesh(geometry, foregroundMaterial);
  foregroundHeroes.frustumCulled = false; foreground.add(foregroundHeroes);
  heroCopies.push(heroMesh, foregroundHeroes);
}

// Where each hero source is on screen, for the caustic it focuses into the
// field's edge. Only a source seen across the field (behind it) is focused.
const heroPoint = new THREE.Vector3(), heroAhead = new THREE.Vector3(), edgePoint = new THREE.Vector3();
// The field's upper and lower silhouette on screen, in screen heights:
// x, y and depth for each of 65 samples, crowded toward the rounded bow,
// where the edge turns fastest. Preallocated, as it is redrawn every frame.
const SILHOUETTE_SAMPLES = 65;
const silhouette = [new Float64Array(SILHOUETTE_SAMPLES * 3), new Float64Array(SILHOUETTE_SAMPLES * 3)];
const closest = { distance: Infinity, tx: 1, ty: 0 };
function projectSilhouette() {
  const aspect = camera.aspect;
  for (let k = 0; k < SILHOUETTE_SAMPLES; k++) {
    const x = FIELD_LENGTH * (k / (SILHOUETTE_SAMPLES - 1)) ** 2;
    const i = Math.min(1023, Math.round(x / FIELD_LENGTH * 1023));
    for (let side = 0; side < 2; side++) {
      edgePoint.set(x, (side ? -1 : 1) * field.data[i * 4 + side], 0).project(camera);
      silhouette[side][k * 3] = edgePoint.x * .5 * aspect;
      silhouette[side][k * 3 + 1] = edgePoint.y * .5;
      silhouette[side][k * 3 + 2] = edgePoint.z;
    }
  }
}
// The distance from a screen point to the nearest silhouette segment, and
// that segment's direction (unit length), in `closest`.
function silhouetteDistance(px, py) {
  closest.distance = Infinity;
  for (const edge of silhouette) {
    for (let k = 1; k < SILHOUETTE_SAMPLES; k++) {
      const ax = edge[k * 3 - 3], ay = edge[k * 3 - 2], az = edge[k * 3 - 1];
      const bx = edge[k * 3], by = edge[k * 3 + 1], bz = edge[k * 3 + 2];
      if (Math.abs(az) >= 1 || Math.abs(bz) >= 1) continue;
      const dx = bx - ax, dy = by - ay, length2 = dx * dx + dy * dy;
      const t = THREE.MathUtils.clamp(((px - ax) * dx + (py - ay) * dy) / Math.max(length2, 1e-12), 0, 1);
      const distance = Math.hypot(px - ax - dx * t, py - ay - dy * t);
      if (distance < closest.distance && length2 > 1e-14) {
        const length = Math.sqrt(length2);
        closest.distance = distance; closest.tx = dx / length; closest.ty = dy / length;
      }
    }
  }
  return closest.distance;
}
// Per-hero screen position, flash and crossing steepness, for the test API.
const heroReadout = HEROES.map(() => ({ x: 0, y: 0, flash: 0, crossing: 0, onScreen: false }));
function updateHeroes() {
  // Hero sources are stars too, so Star density at 0% removes them as well.
  const gain = state.stars > 0 ? effectValue('heroFlares') : 0;
  heroUniforms.uHeroGain.value = gain;
  for (const mesh of heroCopies) mesh.visible = gain > 0;
  const caustics = volumeMaterial.uniforms.uHeroCaustic.value;
  const aspect = camera.aspect;
  let flashing = false, projected = false;
  for (let i = 0; i < HEROES.length; i++) {
    const [phase, y, z, speed, period, , , brightness] = HEROES[i];
    const along = phase + state.travel * speed;
    const x = along - period * Math.floor(along / period) - period / 2;
    heroPoint.set(x, y, z);
    // Where it will be a little further on: its direction across the screen.
    heroAhead.set(x + 4, y, z).project(camera);
    const behind = camera.position.z * z < 0;
    heroPoint.project(camera);
    const onScreen = gain > 0 && behind && Math.abs(heroPoint.z) < 1 && Math.abs(heroPoint.x) < 1.4 && Math.abs(heroPoint.y) < 1.4;
    // The caustic and the flash belong to the edge passing over the source.
    // Both are weighted by how steeply the source's path crosses the nearest
    // edge, so a source that slides along a nearly level crest or lower edge
    // (in the wide views) stays a bright star instead of a glowing ball that
    // rides the edge for a second. A pure function of the current pose and
    // travelled distance, so a paused frame stays bit-identical.
    let flash = 0, crossing = 0, weight = 0;
    if (onScreen) {
      if (!projected) { projectSilhouette(); projected = true; }
      const px = heroPoint.x * .5 * aspect, py = heroPoint.y * .5;
      const distance = silhouetteDistance(px, py);
      const vx = (heroAhead.x - heroPoint.x) * .5 * aspect, vy = (heroAhead.y - heroPoint.y) * .5;
      const v = Math.hypot(vx, vy);
      crossing = v > 1e-9 ? Math.abs(vx * closest.ty - vy * closest.tx) / v : 0;
      weight = THREE.MathUtils.smoothstep(crossing, HERO_CROSSING[0], HERO_CROSSING[1]);
      // The source itself flares as the edge passes over it: brief, and only
      // within a few dozen pixels of the silhouette.
      flash = gain * brightness * weight * HERO_FLASH * Math.exp(-((distance / HERO_FLASH_WIDTH) ** 2));
    }
    caustics[i].set(heroPoint.x * .5 + .5, heroPoint.y * .5 + .5, onScreen ? gain * brightness * weight * HERO_CAUSTIC : 0, HERO_RADIUS);
    heroFlash.flashes[i].set(heroPoint.x * .5 + .5, heroPoint.y * .5 + .5, flash > .002 ? flash : 0, 0);
    flashing ||= flash > .002;
    const readout = heroReadout[i];
    readout.x = heroPoint.x * .5 + .5; readout.y = .5 - heroPoint.y * .5;
    readout.flash = flash > .002 ? flash : 0; readout.crossing = crossing; readout.onScreen = onScreen;
  }
  heroFlash.enabled = flashing;
}

function init() {
  renderer = new THREE.WebGLRenderer({ canvas: $('scene'), antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.autoClear = false;
  camera = new THREE.PerspectiveCamera(39, innerWidth / innerHeight, .1, 1800);
  camera.position.set(130, 3, 154);
  camera.lookAt(cameraTarget);
  sceneCamera = camera.clone();
  orbit = new OrbitControls(camera, renderer.domElement);
  orbit.enabled = false;
  orbit.target.copy(cameraTarget);
  orbit.enableDamping = true; orbit.dampingFactor = .06;
  orbit.minDistance = 3; orbit.maxDistance = 700;
  orbit.enablePan = true;

  shared = {
    uNoise: { value: noiseTexture() }, uTime: { value: state.time }, uTravel: { value: state.travel },
    uInverseProjection: { value: camera.projectionMatrixInverse },
    uCameraMatrix: { value: camera.matrixWorld },
    uCameraPosition: { value: camera.position },
    uResolution: { value: new THREE.Vector2() },
    uNebula: { value: state.nebula }, uNebulaDensity: { value: state.nebulaDensity }, uNebulaGlow: { value: state.nebulaGlow }, uBlackLevel: { value: state.blackLevel },
    uInteriorDarkness: { value: state.interior }, uInteriorShrink: { value: state.interiorShrink },
    uCrestThickness: { value: state.crestThickness }, uCrestLight: { value: state.crestLight },
    uCrestVariation: { value: state.crestVariation }, uEnergyRim: { value: state.energyRim ? 1 : 0 },
    uGasFlow: { value: null }, uGasBody: { value: null }, uGasTail: { value: new THREE.Vector2(270, FIELD_LENGTH) }, uGas: { value: new THREE.Vector4() }, uGasDepth: { value: 1 },
  };
  field = new WarpField(shared.uNoise.value);
  gasFlow = new GasFlow(shared.uNoise.value);
  shared.uGasFlow.value = gasFlow.texture;
  shared.uGasBody.value = field.texture;
  fluid = new ShellFluid(renderer, shared.uNoise.value);
  // Begin with a developed velocity field rather than a frozen noise pattern.
  for (let i=0; i<90; i++) fluid.update(1/60, state.speed, state.turbulence);
  const backdrop = makeFullscreenScene(backgroundFragment, {
    ...shared, uInverseProjection: { value: sceneCamera.projectionMatrixInverse },
  });
  background = backdrop.scene;
  gasMaterials.push(backdrop.material);
  world = new THREE.Scene();
  foreground = new THREE.Scene();
  shipScene = new THREE.Scene();
  shipScene.add(new THREE.HemisphereLight(0xb4e4f3, 0x182530, 1.1));
  const key = new THREE.DirectionalLight(0xd8e8f1, 2.4); key.position.set(-5, 5, 8); shipScene.add(key);
  const fill = new THREE.DirectionalLight(0x1670c7, 1.5); fill.position.set(2, -3, -4); shipScene.add(fill);
  ship = createShip(); shipScene.add(ship);
  makeStars();
  makeHeroes();

  // A small live probe gathers light from the whole surrounding space, not
  // only the part currently visible behind the optical bands.
  lightTarget = new THREE.WebGLCubeRenderTarget(64, {
    type: THREE.HalfFloatType, minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter, generateMipmaps: true, depthBuffer: false,
  });
  lightCamera = new THREE.CubeCamera(.1, 1800, lightTarget);
  lightCamera.position.set(80, 0, 0);
  const lightUniforms = {
    uNoise: shared.uNoise, uTravel: shared.uTravel,
    uNebula: shared.uNebula, uNebulaDensity: shared.uNebulaDensity, uNebulaGlow: shared.uNebulaGlow,
    uInverseProjection: { value: new THREE.Matrix4() },
    uCameraMatrix: { value: new THREE.Matrix4() },
    uCameraPosition: { value: new THREE.Vector3() },
    uGasFlow: shared.uGasFlow, uGasBody: shared.uGasBody, uGasTail: shared.uGasTail, uGas: shared.uGas,
  };
  const lightSkyScene = makeFullscreenScene(backgroundFragment, lightUniforms);
  lightScene = lightSkyScene.scene;
  gasMaterials.push(lightSkyScene.material);
  const lightSky = lightScene.children[0];
  lightSky.renderOrder = -1;
  lightSky.onBeforeRender = (_renderer, _scene, faceCamera) => {
    lightUniforms.uInverseProjection.value.copy(faceCamera.projectionMatrixInverse);
    lightUniforms.uCameraMatrix.value.copy(faceCamera.matrixWorld);
    lightUniforms.uCameraPosition.value.setFromMatrixPosition(faceCamera.matrixWorld);
  };
  const lightHeroes = heroMesh.clone();
  heroCopies.push(lightHeroes);
  lightScene.add(starMesh.clone(), farStars.clone(), lightHeroes);
  offscreenTarget = new THREE.WebGLCubeRenderTarget(256, {
    type: THREE.HalfFloatType, minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter, generateMipmaps: true, depthBuffer: false,
  });
  offscreenCamera = new THREE.CubeCamera(.1, 1800, offscreenTarget);

  sceneTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true, depthBuffer: true, samples: 4 });
  sceneTarget.texture.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
  const volume = makeFullscreenScene(state.appearance === 'fluid' ? fluidVolumeFragment : volumeFragment, {
    ...shared,
    tScene: { value: sceneTarget.texture },
    uSurroundings: { value: lightTarget.texture }, uBloom: { value: state.bloom },
    uOffscreenScene: { value: offscreenTarget.texture },
    uSceneScale: { value: SCENE_OVERSCAN },
    uTailFade: { value: new THREE.Vector2(270, FIELD_LENGTH) },
    uTailCap: { value: new THREE.Vector4(330, FIELD_LENGTH, 35, 39) },
    uBandGlow: { value: state.appearance === 'glow' ? 1 : 0 },
    uEdgeGlow: { value: state.edgeGlow },
    uProjectionWidth: { value: state.projectionWidth },
    uTurbulence: { value: state.turbulence }, uIntensity: { value: state.intensity },
    uEntrance: { value: 1 },
    uFluid: { value: fluid.texture },
    uFluidPatches: { value: fluid.patchTexture },
    uProfile: { value: field.texture },
    uProfileSlope: { value: field.derivativeTexture },
    uLensing: { value: state.lensing }, uProjection: { value: camera.projectionMatrix },
    uHeroCaustic: { value: HEROES.map(() => new THREE.Vector4()) },
    uBow: { value: new THREE.Vector4() }, uFilmFlow: { value: 1 },
  }, { STEPS: quality[state.quality].steps, HERO_COUNT: HEROES.length });
  composite = volume.scene; volumeMaterial = volume.material;
  gasMaterials.push(volumeMaterial);
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(composite, new THREE.Camera()));
  const shipPass = new RenderPass(shipScene, camera); shipPass.clear = false; shipPass.clearDepth = true;
  composer.addPass(shipPass);
  const foregroundPass = new RenderPass(foreground, camera); foregroundPass.clear = false;
  composer.addPass(foregroundPass);
  // Lens: a hero source's flash is added to the HDR frame first, so that the
  // anamorphic streak (taken before the round bloom and added back in the lens
  // pass) and the round bloom both spread it like any other highlight.
  heroFlash = new HeroFlashPass(HEROES.length);
  composer.addPass(heroFlash);
  streak = new StreakBloomPass();
  composer.addPass(streak);
  bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), state.bloom, .72, .42);
  composer.addPass(bloom);
  lens = new ShaderPass({ uniforms: {
    tDiffuse: { value: null }, uTime: shared.uTime, uResolution: shared.uResolution, uBloom: { value: state.bloom },
    tStreak: { value: null }, uStreak: { value: 0 }, uOldFlare: { value: 1 }, uStreakTexel: { value: new THREE.Vector2(1, 1) },
    uVignette: { value: 0 }, uLetterbox: { value: 0 }, uBlackLevel: { value: 0 },
  }, vertexShader: fullscreenVertex, fragmentShader: lensFragment });
  // Full-screen passes must not inherit stale depth from the ship pass when
  // EffectComposer alternates its buffers. That caused alternating/feedback
  // frames in the earlier renderer.
  lens.material.depthTest = false; lens.material.depthWrite = false;
  composer.addPass(lens);
  const output = new OutputPass(); output.material.depthTest = false; output.material.depthWrite = false;
  composer.addPass(output);
  fxaa = new ShaderPass(FXAAShader); fxaa.material.depthTest = false; fxaa.material.depthWrite = false; composer.addPass(fxaa);
  // Film finish, last so FXAA cannot smear its grain (see src/film.js).
  film = new FilmPass({
    uNoise: shared.uNoise, uResolution: shared.uResolution, uProfile: { value: field.texture },
    uInverseProjection: { value: camera.projectionMatrixInverse }, uCameraMatrix: { value: camera.matrixWorld }, uCameraPosition: { value: camera.position },
    uGrain: { value: 0 }, uSoftness: { value: 0 }, uFocus: { value: 0 }, uDust: { value: 0 }, uGrade: { value: 0 }, uLetterbox: { value: 0 },
    uFrame: { value: 0 }, uFocusNear: { value: 0 }, uDustNear: { value: 0 }, uDustPhase: { value: new THREE.Vector4() }, uDustFlow: { value: new THREE.Vector2() },
  });
  composer.addPass(film);

  $('quality').value = state.quality;
  updateAppearanceButtons();
  bindControls();
  resize();
  if (state.view === 'flyby') startFlyby({ playing: state.playing });
  else setView(state.view);
  updatePlay();
  renderer.domElement.addEventListener('webglcontextlost', (event) => { event.preventDefault(); fail('The graphics context was interrupted. Reload to restart the scene.'); });
  renderer.debug.onShaderError = (gl, program, vs, fs) => {
    const message = gl.getProgramInfoLog(program) + '\n' + gl.getShaderInfoLog(fs);
    console.error(message); fail('Your browser could not compile the warp shaders. Try a current browser with hardware acceleration enabled.');
  };
  // A small deterministic control surface for visual QA and reproducible frames.
  window.warp = {
    get state() { return { ...state, fps, simulationTime: fluid.time }; },
    get fieldShape() { return field.lobes.map(lobe => ({ ...lobe })); },
    get heroes() { return heroReadout.map(hero => ({ ...hero })); },
    get reference() { return { ...reference, duration: REFERENCE_DURATION, audioTime: referenceAudio.currentTime, audioPaused: referenceAudio.paused, camera: camera.position.toArray(), target: cameraTarget.toArray() }; },
    get flyby() { return { ...flyby, duration: FLYBY_DURATION, camera: camera.position.toArray(), target: cameraTarget.toArray() }; },
    setView,
    seek(time) { if (reference.active || flyby.active) setView('tracking'); state.time = time; state.travel = time * spaceVelocity(); state.entrance = 1; fluid.reset(); for (let i=0; i<Math.min(600, Math.round(time*60)); i++) fluid.update(1/60,state.speed,state.turbulence); },
    pause() { setPlaying(false); },
    play() { setPlaying(true); },
    advance(seconds) {
      if (reference.active || flyby.active) setView('tracking');
      const steps = Math.round(THREE.MathUtils.clamp(Number(seconds) || 0, 0, 60) * 60);
      for (let i=0; i<steps; i++) {
        state.time += 1/60; state.travel += spaceVelocity()/60;
        fluid.update(1/60, state.speed, drivenTurbulence());
      }
      state.entrance = 1; render(0);
    },
    render: () => render(0),
  };
  render(0);
  if (state.playing && !params.has('view') && !params.has('time')) {
    startReference({ autoplay: true });
    $('loading').hidden = true;
  } else {
    $('loading').style.opacity = 0;
    setTimeout(() => { $('loading').hidden = true; }, 650);
  }
  renderer.setAnimationLoop(tick);
}

function resize() {
  const width = innerWidth, height = innerHeight;
  const scale = quality[state.quality].scale;
  // Cap resolution so a Retina display does not silently quadruple the raymarch cost.
  const pixelRatio = Math.min(devicePixelRatio, 1.5) * scale * Math.min(1, 1920 / width);
  renderer.setPixelRatio(pixelRatio); renderer.setSize(width, height, false);
  composer.setPixelRatio(pixelRatio); composer.setSize(width, height);
  const sceneRatio = pixelRatio * SCENE_OVERSCAN * Math.min(1, 3072/(width*pixelRatio*SCENE_OVERSCAN));
  sceneTarget.setSize(Math.floor(width * sceneRatio), Math.floor(height * sceneRatio));
  shared.uResolution.value.set(width * pixelRatio, height * pixelRatio);
  fxaa.uniforms.resolution.value.set(1/(width*pixelRatio),1/(height*pixelRatio));
  camera.aspect = width / height;
  camera.fov = width < 700 ? 53 : 39;
  camera.updateProjectionMatrix();
}

function setView(view) {
  if (view === 'flyby') { startFlyby(); return; }
  if (!['tracking', 'bow', 'orbit', 'ride'].includes(view)) return;
  stopReference();
  flyby.active = false;
  state.view = view;
  orbit.enabled = view === 'orbit';
  if (orbit.enabled) { orbit.target.copy(cameraTarget); orbit.update(); }
  document.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === view)));
  $('view-label').textContent = { tracking: 'EXTERIOR / WIDE WAKE', bow: 'EXTERIOR / BOW CLOSE-UP', orbit: 'EXTERIOR / FREE ORBIT', ride: 'INTERIOR / ON BOARD' }[view];
  $('hint').textContent = view === 'orbit' ? 'Drag to orbit · Scroll to move closer · Right-drag to pan' : view === 'ride' ? 'Looking forward through the compression front' : view === 'bow' ? 'Rounded compression front · Refracted starlight' : 'Drag to look around in orbit view';
  updatePlay();
}

function updateAppearanceButtons() {
  document.querySelectorAll('[data-appearance]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.appearance === state.appearance)));
  $('space-controls').hidden = state.appearance !== 'space';
  document.body.classList.toggle('space-appearance', state.appearance === 'space');
}

function bindControls() {
  $('play').addEventListener('click', togglePlay);
  $('replay').addEventListener('click', restart);
  $('reference-play').addEventListener('click', () => startReference());
  $('reference-sound').addEventListener('click', () => {
    referenceAudio.muted = !referenceAudio.muted;
    reference.autoMuted = false;
    updateSound();
    if (!referenceAudio.muted && reference.active && !reference.finished && reference.silent && !referenceAudio.error) {
      referenceAudio.currentTime = reference.time;
      reference.silent = false;
      if (state.playing) setPlaying(true);
    }
  });
  referenceAudio.addEventListener('error', () => {
    if (reference.active && !reference.silent) useSilentReference();
  });
  for (const key of ['speed', 'turbulence', 'intensity', 'lensing', 'bloom', 'stars', 'edgeGlow', 'projectionWidth', ...EFFECT_SLIDERS]) {
    $(key).addEventListener('input', () => {
      state[key] = Number($(key).value);
      $(`${key}-value`).textContent = key === 'speed' ? state[key].toFixed(1) : `${Math.round(state[key] * 100)}%`;
    });
  }
  for (const key of [...EFFECT_TOGGLES, 'effectsBypass']) {
    $(key).addEventListener('change', () => { state[key] = $(key).checked; syncEffectInputs(); });
  }
  $('effects-reset').addEventListener('click', () => {
    for (const [key, value] of Object.entries(EFFECTS)) state[key] = value;
    state.effectsBypass = false;
    syncEffectInputs();
  });
  $('effects-off').addEventListener('click', () => {
    for (const [key, value] of Object.entries(EFFECTS)) state[key] = typeof value === 'boolean' ? false : 0;
    syncEffectInputs();
  });
  syncEffectInputs();
  // The panel opens upward from the controls bar, so it may only be as tall as
  // the room above that bar; on short or landscape phones a fixed cap pushed
  // its top controls off the screen. It scrolls inside that room instead.
  $('effects').addEventListener('toggle', fitEffectsPanel);
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
  $('quality').addEventListener('change', () => {
    state.quality = $('quality').value;
    volumeMaterial.defines.STEPS = quality[state.quality].steps;
    volumeMaterial.needsUpdate = true; resize();
  });
  document.querySelectorAll('[data-appearance]').forEach(button => button.addEventListener('click', () => {
    if (state.appearance === button.dataset.appearance) return;
    state.appearance = button.dataset.appearance;
    updateAppearanceButtons();
    volumeMaterial.fragmentShader = state.appearance === 'fluid' ? fluidVolumeFragment : volumeFragment;
    volumeMaterial.needsUpdate = true;
    render(0);
  }));
  $('ship').addEventListener('change', () => { state.ship = $('ship').checked; });
  $('hide').addEventListener('click', toggleUI);
  $('show').addEventListener('click', toggleUI);
  $('fullscreen').addEventListener('click', toggleFullscreen);
  $('capture').addEventListener('click', capture);
  document.addEventListener('keydown', (event) => {
    if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'A', 'SUMMARY'].includes(document.activeElement?.tagName)) return;
    if (event.code === 'Space') { event.preventDefault(); togglePlay(); }
    if (event.key.toLowerCase() === 'h') toggleUI();
    if (event.key.toLowerCase() === 'r') restart();
    if (event.key.toLowerCase() === 'f') toggleFullscreen();
  });
  addEventListener('resize', () => { clearTimeout(resizing); resizing = setTimeout(() => { resize(); fitEffectsPanel(); }, 80); });
  document.addEventListener('visibilitychange', () => {
    previous = performance.now();
    if (document.hidden && (reference.active || flyby.active) && state.playing) setPlaying(false);
  });
}

function fitEffectsPanel() {
  const effects = $('effects');
  if (!effects.open) return;
  const room = document.querySelector('.controls').getBoundingClientRect().top - 16;
  effects.style.setProperty('--effects-room', `${Math.max(96, Math.floor(room))}px`);
}

function syncEffectInputs() {
  for (const key of EFFECT_SLIDERS) {
    $(key).value = state[key];
    $(`${key}-value`).textContent = `${Math.round(state[key] * 100)}%`;
  }
  for (const key of [...EFFECT_TOGGLES, 'effectsBypass']) $(key).checked = state[key];
  $('effects').classList.toggle('bypassed', state.effectsBypass);
}

function updateSound() {
  $('reference-sound').setAttribute('aria-pressed', String(!referenceAudio.muted));
  const label = referenceAudio.muted ? 'Unmute reference audio' : 'Mute reference audio';
  $('reference-sound').setAttribute('aria-label', label);
  $('reference-sound').title = label;
}

function startReference({ autoplay = false } = {}) {
  flyby.active = false;
  referenceAudio.pause();
  referenceAudio.currentTime = 0;
  if (autoplay || reference.autoMuted) referenceAudio.muted = autoplay;
  reference.autoMuted = autoplay;
  updateSound();
  // Audio-only elements may reject even muted autoplay. Run the initial shot
  // on the animation clock, then seek/join its audio on an explicit unmute.
  Object.assign(reference, { active: true, time: 0, loading: false, silent: autoplay, finished: false });
  Object.assign(state, { time: 4, travel: 12, entrance: 1, view: 'reference', speed: 10, turbulence: 1.5, intensity: 2, lensing: .7, ship: true });
  orbit.enabled = false;
  for (const key of ['speed', 'turbulence', 'intensity', 'lensing']) {
    $(key).value = state[key];
    $(`${key}-value`).textContent = key === 'speed' ? state[key].toFixed(1) : `${Math.round(state[key]*100)}%`;
  }
  $('ship').checked = true;
  document.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed', 'false'));
  $('view-label').textContent = 'REFERENCE / CAMERA SEQUENCE';
  $('hint').textContent = 'Original camera pullback · Space to pause picture and sound';
  $('reference-action').textContent = 'Replay reference';
  $('reference-time').textContent = '0.00 / 4.96 s';
  $('reference-progress').style.transform = 'scaleX(0)';
  $('reference-play').setAttribute('aria-label', 'Replay reference sequence');
  if (!autoplay) {
    fluid.reset();
    for (let i=0; i<90; i++) fluid.update(1/60, state.speed, state.turbulence);
  }
  render(0);
  setPlaying(true);
}

function stopReference() {
  if (!reference.active) return;
  reference.revision++;
  referenceAudio.pause();
  reference.active = false;
  reference.loading = false;
  $('reference-action').textContent = 'Play reference';
  $('reference-play').setAttribute('aria-label', 'Play reference sequence');
  $('reference-time').textContent = 'Original audio · 4.96 s';
  $('reference-progress').style.transform = 'scaleX(0)';
}

function startFlyby({ playing = true } = {}) {
  stopReference();
  Object.assign(flyby, { active: true, time: 0, finished: false });
  state.view = 'flyby';
  orbit.enabled = false;
  document.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === 'flyby')));
  $('view-label').textContent = 'EXTERIOR / FLYBY PULLBACK';
  $('hint').textContent = 'Ship overtakes the camera · Space to pause · Flyby to replay';
  render(0);
  setPlaying(playing);
}

function advanceFlyby(dt) {
  if (!flyby.active || flyby.finished) return;
  flyby.time = Math.min(FLYBY_DURATION, flyby.time + dt);
  if (flyby.time >= FLYBY_DURATION) {
    flyby.finished = true;
    $('view-label').textContent = 'EXTERIOR / FULL WARP FIELD';
    $('hint').textContent = 'Full field view · Flyby to repeat the camera move';
  }
}

function useSilentReference() {
  referenceAudio.pause();
  reference.silent = true;
  reference.loading = false;
  notice('Reference audio could not play. The camera sequence will continue silently.');
  updatePlay();
}

function setPlaying(playing) {
  state.playing = playing;
  if (reference.active && !reference.finished) {
    const revision = ++reference.revision;
    if (!playing) {
      if (!reference.silent && !reference.loading) advanceReferenceTo(referenceAudio.currentTime);
      referenceAudio.pause();
      reference.loading = false;
      render(0);
    } else if (!reference.silent) {
      reference.loading = true;
      referenceAudio.play().then(() => {
        if (!reference.active || revision !== reference.revision) return;
        reference.loading = false;
        previous = performance.now();
        updatePlay();
      }).catch(() => {
        if (reference.active && revision === reference.revision) useSilentReference();
      });
    }
  }
  previous = performance.now();
  updatePlay();
}

function advanceReferenceTo(time) {
  const next = Math.min(REFERENCE_DURATION, Math.max(reference.time, time));
  const dt = next-reference.time;
  state.time += dt;
  state.travel += dt*spaceVelocity();
  // Keep the solver stable after a delayed frame; the camera and environment
  // always use the media clock, never an independently drifting RAF timer.
  let remaining = Math.min(dt, .25);
  while (remaining > .000001) {
    const step = Math.min(remaining, 1/60);
    fluid.update(step, state.speed, drivenTurbulence());
    remaining -= step;
  }
  reference.time = next;
  $('reference-time').textContent = `${next.toFixed(2)} / ${REFERENCE_DURATION.toFixed(2)} s${reference.silent ? ' · silent' : ''}`;
  $('reference-progress').style.transform = `scaleX(${next/REFERENCE_DURATION})`;
  if (next >= REFERENCE_DURATION) {
    reference.finished = true;
    referenceAudio.pause();
    $('view-label').textContent = 'REFERENCE / WIDE WAKE';
    $('hint').textContent = 'Final wide view · Replay reference to repeat the camera move';
    updatePlay();
  }
}

function togglePlay() { setPlaying(!state.playing); }
function updatePlay() {
  $('play').setAttribute('aria-label', state.playing ? 'Pause animation' : 'Play animation');
  $('play').title = state.playing ? 'Pause (Space)' : 'Play (Space)';
  $('play').innerHTML = state.playing ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6v12M16 6v12"/></svg>' : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7Z"/></svg>';
  $('motion-label').textContent = reference.loading ? 'LOADING AUDIO' : state.playing ? 'FIELD ACTIVE' : 'FRAME PAUSED';
}
function restart() { if (reference.active) { startReference(); return; } if (flyby.active) { startFlyby(); return; } state.time = 0; state.travel = 0; state.entrance = 0; fluid.reset(); state.playing = true; updatePlay(); }
function toggleUI() { state.hidden = !state.hidden; document.body.classList.toggle('ui-hidden', state.hidden); $('show').hidden = !state.hidden; }
async function toggleFullscreen() {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
  catch { notice('Fullscreen is unavailable in this browser window.'); }
}
function notice(message) { $('notice').textContent = message; $('notice').classList.add('visible'); clearTimeout(noticeTimer); noticeTimer = setTimeout(() => $('notice').classList.remove('visible'), 3000); }
function capture() {
  render(0);
  renderer.domElement.toBlob(blob => {
    if (!blob) { notice('Could not save the frame. Try again.'); return; }
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `beyond-warp-${state.time.toFixed(2)}.png`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); notice('Frame saved');
  }, 'image/png');
}

function drivenTurbulence(travel = state.travel) {
  return state.turbulence * (.7 + field.pressureAt(0, travel) * .6);
}

// The opening reference has fast lateral transport, even in distant layers.
// Stars, clouds, and pressure variations all share this travelled distance.
function spaceVelocity() { return 40 + state.speed*36; }

function render(dt) {
  if (state.view === 'orbit') orbit.update();
  else {
    if (state.view === 'reference' || state.view === 'flyby') {
      const pose = state.view === 'reference' ? referenceCameraAt(reference.time) : flybyCameraAt(flyby.time, camera.aspect);
      const distance = pose.span / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov/2)) * camera.aspect);
      desiredPosition.set(pose.x, pose.y + pose.elevation, distance);
      desiredTarget.set(pose.x, pose.y, 0);
    } else if (state.view === 'tracking') {
      const mobile = innerWidth < 700;
      const width = mobile ? 125 : 260;
      const distance = width / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov/2)) * camera.aspect);
      desiredPosition.set(mobile ? 58 : 130, 3, distance);
      desiredTarget.set(mobile ? 58 : 130, 0, 0);
    } else if (state.view === 'bow') {
      const width = innerWidth < 700 ? 13 : 24;
      const distance = width / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov/2)) * camera.aspect);
      desiredPosition.set(2.05, .25, distance);
      desiredTarget.set(2.05, 0, 0);
    } else {
      desiredPosition.set(4.95, .27, .04);
      desiredTarget.set(-12, .22, 0);
    }
    const blend = !['reference', 'flyby'].includes(state.view) && dt > 0 ? 1 - Math.exp(-dt * 3.5) : 1;
    if (blend === 1) {
      camera.position.copy(desiredPosition);
      cameraTarget.copy(desiredTarget);
    } else {
      camera.position.lerp(desiredPosition, blend);
      cameraTarget.lerp(desiredTarget, blend);
    }
    camera.lookAt(cameraTarget);
  }
  camera.updateMatrixWorld();
  // Render beyond the visible frame at the same pose. The screen boundary is
  // a crop of space, never a boundary of the lens or a forced return to zero.
  sceneCamera.copy(camera, false);
  sceneCamera.projectionMatrix.elements[0] /= SCENE_OVERSCAN;
  sceneCamera.projectionMatrix.elements[5] /= SCENE_OVERSCAN;
  sceneCamera.projectionMatrixInverse.copy(sceneCamera.projectionMatrix).invert();
  shared.uTime.value = state.time;
  shared.uTravel.value = state.travel;
  shared.uNebula.value = effectValue('nebula');
  shared.uNebulaDensity.value = effectValue('nebulaDensity');
  shared.uNebulaGlow.value = effectValue('nebulaGlow');
  shared.uBlackLevel.value = effectValue('blackLevel');
  shared.uInteriorDarkness.value = effectValue('interior');
  shared.uInteriorShrink.value = effectValue('interiorShrink');
  shared.uCrestThickness.value = effectValue('crestThickness');
  shared.uCrestLight.value = effectValue('crestLight');
  shared.uCrestVariation.value = effectValue('crestVariation');
  shared.uEnergyRim.value = effectValue('energyRim') ? 1 : 0;
  field.update(state.travel);
  volumeMaterial.uniforms.uTailFade.value.set(field.tail.start,field.tail.end);
  volumeMaterial.uniforms.uTailCap.value.set(field.tail.center,field.tail.end,field.tail.upper,field.tail.lower);
  updateGas();
  starUniforms.uTravel.value = state.travel;
  starUniforms.uVelocity.value = spaceVelocity();
  starUniforms.uBloom.value = state.bloom;
  starMesh.geometry.instanceCount = Math.round(STAR_COUNT*state.stars);
  farStars.geometry.setDrawRange(0, Math.round(FAR_STAR_COUNT*state.stars));
  bloom.strength = state.bloom;
  lens.uniforms.uBloom.value = state.bloom;
  // Streak bloom fades out as its length goes to 0; the old five-tap flare
  // only comes back as the streak goes away, so the two never double up.
  const streakAmount = effectValue('streak') * THREE.MathUtils.smoothstep(effectValue('streakLength'), 0, .2);
  streak.enabled = streakAmount > 0 && state.bloom > 0;
  streak.stretch = Math.min(.95, .5 + .42 * effectValue('streakLength'));
  const tint = effectValue('streakTint');
  streak.tint.setRGB(1 - .30 * tint, 1 - .12 * tint, 1 + .12 * tint);
  // ShaderPass clones its uniforms, so the streak's texture and texel size
  // (both replaced on resize) are copied in every frame.
  lens.uniforms.tStreak.value = streak.texture;
  lens.uniforms.uStreakTexel.value.copy(streak.texel);
  lens.uniforms.uStreak.value = streak.enabled ? streakAmount * state.bloom / .65 * STREAK_GAIN : 0;
  lens.uniforms.uOldFlare.value = Math.max(0, 1 - streakAmount * 4);
  starUniforms.uStarStreak.value = effectValue('starStreaks');
  // Star streaks switch a shader define, so 0% runs the original star shaders.
  if ((starUniforms.uStarStreak.value > 0) !== starStreaksOn) {
    starStreaksOn = !starStreaksOn;
    for (const material of starMaterials) {
      if (starStreaksOn) material.defines.STAR_STREAKS = ''; else delete material.defines.STAR_STREAKS;
      material.needsUpdate = true;
    }
  }
  updateHeroes();
  volumeMaterial.uniforms.uTurbulence.value = state.turbulence;
  volumeMaterial.uniforms.uIntensity.value = state.intensity;
  volumeMaterial.uniforms.uBloom.value = state.bloom;
  volumeMaterial.uniforms.uBandGlow.value = state.appearance === 'glow' ? 1 : 0;
  volumeMaterial.uniforms.uEdgeGlow.value = state.edgeGlow;
  volumeMaterial.uniforms.uProjectionWidth.value = state.projectionWidth;
  volumeMaterial.uniforms.uFluid.value = fluid.texture;
  volumeMaterial.uniforms.uLensing.value = state.lensing;
  volumeMaterial.uniforms.uEntrance.value = THREE.MathUtils.smoothstep(state.entrance, 0, 1);
  updateBow();
  lens.uniforms.uTime.value = state.time;
  updateFilm();
  ship.visible = state.ship && state.view !== 'ride';
  ship.rotation.x = Math.sin(state.time * .28) * .028;
  ship.rotation.z = Math.sin(state.time * .21) * .012;
  const spaceKey = ['nebula', 'nebulaDensity', 'nebulaGlow', 'heroFlares', 'starStreaks'].map(effectValue).join('/') + `/${shared.uGas.value.toArray()}`;
  if (state.appearance === 'glow') {
    const nextLightKey = `${state.travel}/${state.speed}/${state.stars}/${state.bloom}/${spaceKey}`;
    if (nextLightKey !== lightKey) {
      lightCamera.update(renderer, lightScene);
      lightKey = nextLightKey;
    }
  }
  const nextOffscreenKey = `${state.travel}/${state.speed}/${state.stars}/${state.bloom}/${spaceKey}/${camera.position.toArray().join(',')}`;
  if (nextOffscreenKey !== offscreenKey) {
    offscreenCamera.position.copy(camera.position);
    offscreenCamera.update(renderer, lightScene);
    offscreenKey = nextOffscreenKey;
  }
  renderer.setRenderTarget(sceneTarget); renderer.clear();
  renderer.render(background, new THREE.Camera());
  renderer.clearDepth(); renderer.render(world, sceneCamera);
  renderer.setRenderTarget(null);
  composer.render();
}

// The gas reacts to the field (Effects › Gas). Off (the experiment toggle, or
// Gas interaction at 0%) removes GAS_FIELD from the shaders, so they are
// exactly the earlier ones. The interaction fades in with the field.
function updateGas() {
  const on = effectValue('gasReacts') && effectValue('gas') > 0;
  if (on !== gasOn) {
    gasOn = on;
    for (const material of gasMaterials) {
      if (on) material.defines.GAS_FIELD = ''; else delete material.defines.GAS_FIELD;
      material.needsUpdate = true;
    }
  }
  if (!on) { shared.uGas.value.set(0, 0, 0, 0); return; }
  const strength = effectValue('gas') * THREE.MathUtils.smoothstep(state.entrance, 0, 1);
  shared.uGas.value.set(strength, effectValue('gasShock'), strength * effectValue('gasPileup'), strength * effectValue('gasFlow'));
  shared.uGasDepth.value = effectValue('gasDepth');
  shared.uGasTail.value.set(field.tail.start, field.tail.end);
  gasFlow.update(renderer, state.travel);
}

// The bow close-up (Effects › Bow). Each part switches a shader define, so at
// 0% (or off) it is compiled out and the picture is exactly the one without
// it; the bow layers need both their strength and their spread, and the
// Layered refraction experiment needs the layers.
const bowLayersOn = () => effectValue('bowLayers') > 0 && effectValue('layerSpread') > 0;
const BOW_DEFINES = [
  ['BOW_DISPERSION', () => effectValue('dispersion') > 0],
  ['BOW_FILM', () => effectValue('iridescence') > 0],
  ['BOW_LAYERS', bowLayersOn],
  ['BOW_LAYER_LENS', () => bowLayersOn() && effectValue('layerRefraction')],
];
function updateBow() {
  const defines = volumeMaterial.defines;
  let changed = false;
  for (const [name, on] of BOW_DEFINES) {
    if (on() === name in defines) continue;
    if (on()) defines[name] = ''; else delete defines[name];
    changed = true;
  }
  if (changed) volumeMaterial.needsUpdate = true;
  volumeMaterial.uniforms.uBow.value.set(effectValue('dispersion'), effectValue('iridescence'), effectValue('bowLayers'), effectValue('layerSpread'));
  volumeMaterial.uniforms.uFilmFlow.value = effectValue('filmFlow') ? 1 : 0;
}

// Speed dust drifts at a fixed fraction of the travelled distance: near, mid
// and far layers, then the veil. Wrapped to the noise lattice's 64-cell period.
const DUST_RATES = [.0075, .0062, .0048, .0012];
const FILM_CONTROLS = [['grain', 'uGrain'], ['softness', 'uSoftness'], ['focus', 'uFocus'], ['dust', 'uDust'], ['grade', 'uGrade']];
function updateFilm() {
  const u = film.uniforms;
  for (let i = 0; i < FILM_CONTROLS.length; i++) u[FILM_CONTROLS[i][1]].value = effectValue(FILM_CONTROLS[i][0]);
  // A 2.39:1 letterbox during the camera sequences, on screens wider than
  // tall; on a portrait phone it would leave only a thin strip.
  const aspect = innerWidth / innerHeight;
  const sequence = state.view === 'reference' || state.view === 'flyby';
  const bar = Math.max(0, (1 - aspect/2.39)/2);
  u.uLetterbox.value = effectValue('letterbox') && sequence && aspect >= 1.2 && bar*innerHeight >= 1 ? bar : 0;
  // The vignette is optical, so the lens pass applies it (once), following
  // the letterboxed picture.
  lens.uniforms.uVignette.value = effectValue('vignette');
  lens.uniforms.uBlackLevel.value = effectValue('blackLevel');
  lens.uniforms.uLetterbox.value = u.uLetterbox.value;
  // Grain changes once per simulation frame and is frozen while paused.
  u.uFrame.value = Math.floor(state.time*60 + .5) % 65536;
  // Depth of field and the near dust both follow how close the camera is to
  // the field: strong in the bow close-up, almost gone in the wide shot.
  const p = camera.position, x = THREE.MathUtils.clamp(p.x, 0, FIELD_LENGTH);
  const distance = Math.hypot(p.x - x, p.y, p.z);
  u.uFocusNear.value = 1/(1 + (distance/45)**2);
  u.uDustNear.value = 1/(1 + (distance/35)**2);
  for (let i = 0; i < 4; i++) u.uDustPhase.value.setComponent(i, (state.travel*DUST_RATES[i]) % 64);
  // The on-screen direction space streams past: camera right/up against +x.
  u.uDustFlow.value.set(camera.matrixWorld.elements[0], camera.matrixWorld.elements[4]);
  film.enabled = u.uGrain.value > 0 || u.uSoftness.value > 0 || u.uFocus.value > 0 || u.uDust.value > 0
    || u.uGrade.value > 0 || u.uLetterbox.value > 0;
}

function tick(now) {
  const dt = Math.min((now - previous) / 1000, .05); previous = now;
  if (document.hidden) return;
  if (state.playing) {
    if (reference.active && !reference.finished) {
      if (!reference.loading) advanceReferenceTo(reference.silent ? reference.time + dt : referenceAudio.ended ? REFERENCE_DURATION : referenceAudio.currentTime);
    } else {
      state.time += dt; state.travel += dt * spaceVelocity();
      state.entrance = Math.min(1, state.entrance + dt * .65);
      fluid.update(dt, state.speed, drivenTurbulence());
      advanceFlyby(dt);
    }
  }
  render(dt);
  frames++;
  if (now - fpsStart > 1000) { fps = Math.round(frames * 1000 / (now - fpsStart)); fpsStart = now; frames = 0; }
}

function fail(message) {
  $('loading').hidden = true;
  $('error').hidden = false;
  $('error-message').textContent = message;
}

try { init(); }
catch (error) { console.error(error); fail('This scene needs WebGL 2 and hardware acceleration. Enable graphics acceleration in your browser, then reload.'); }
