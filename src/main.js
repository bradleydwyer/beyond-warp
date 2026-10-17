import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { fullscreenVertex, backgroundFragment, starVertex, starFragment, volumeFragment, lensFragment } from './shaders.js';
import { createShip } from './ship.js';
import { ShellFluid } from './fluid.js';
import { WarpField } from './field.js';
import { REFERENCE_DURATION, referenceCameraAt } from './reference-sequence.js';
import './style.css';

const $ = (id) => document.getElementById(id);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const params = new URLSearchParams(location.search);
const state = {
  time: Number(params.get('time') ?? 4),
  travel: 12,
  playing: !reducedMotion && !params.has('paused'),
  view: ['tracking','bow','orbit','ride'].includes(params.get('view')) ? params.get('view') : 'tracking',
  speed: 8,
  turbulence: .65,
  intensity: 1,
  lensing: .7,
  quality: innerWidth < 700 ? 'low' : 'balanced',
  ship: true,
  entrance: 1,
  hidden: false,
};
let renderer, sceneTarget, composer, camera, orbit, background, world, composite, shipScene, fluid, field;
let shared, starUniforms, volumeMaterial, bloom, lens, ship, fxaa;
let previous = performance.now(), frames = 0, fpsStart = previous, fps = 0;
let noticeTimer, resizing;
const reference = { active: false, time: 0, loading: false, silent: false, finished: false, revision: 0 };
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
  const count = 2300;
  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    seeds.set([random() * 1000, (random() - .5) * 360, -40 - random() * 360, random()], i * 4);
  }
  geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
  geometry.instanceCount = count;
  starUniforms = { uTravel: { value: state.travel }, uSpeed: { value: state.speed }, uTime: shared.uTime };
  const material = new THREE.ShaderMaterial({ vertexShader: starVertex, fragmentShader: starFragment, uniforms: starUniforms, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const stars = new THREE.Mesh(geometry, material);
  stars.frustumCulled = false; world.add(stars);

  const positions = new Float32Array(1200 * 3);
  for (let i = 0; i < 1200; i++) {
    const v = new THREE.Vector3(random() - .5, random() - .5, random() - .5).normalize().multiplyScalar(650 + random() * 400);
    positions.set(v.toArray(), i * 3);
  }
  const points = new THREE.BufferGeometry(); points.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  world.add(new THREE.Points(points, new THREE.PointsMaterial({ color: 0x6093aa, size: .18, transparent: true, opacity: .42, depthWrite: false })));
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
  };
  field = new WarpField(shared.uNoise.value);
  fluid = new ShellFluid(renderer, shared.uNoise.value);
  // Begin with a developed velocity field rather than a frozen noise pattern.
  for (let i=0; i<90; i++) fluid.update(1/60, state.speed, state.turbulence);
  background = makeFullscreenScene(backgroundFragment, shared).scene;
  world = new THREE.Scene();
  shipScene = new THREE.Scene();
  shipScene.add(new THREE.HemisphereLight(0xb4e4f3, 0x182530, 1.1));
  const key = new THREE.DirectionalLight(0xd8e8f1, 2.4); key.position.set(-5, 5, 8); shipScene.add(key);
  const fill = new THREE.DirectionalLight(0x1670c7, 1.5); fill.position.set(2, -3, -4); shipScene.add(fill);
  ship = createShip(); shipScene.add(ship);
  makeStars();

  sceneTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true, depthBuffer: true, samples: 4 });
  const volume = makeFullscreenScene(volumeFragment, {
    ...shared,
    tScene: { value: sceneTarget.texture },
    uTurbulence: { value: state.turbulence }, uIntensity: { value: state.intensity },
    uEntrance: { value: 1 },
    uFluid: { value: fluid.texture },
    uProfile: { value: field.texture },
    uProfileSlope: { value: field.derivativeTexture },
    uLensing: { value: state.lensing }, uProjection: { value: camera.projectionMatrix },
  }, { STEPS: quality[state.quality].steps });
  composite = volume.scene; volumeMaterial = volume.material;
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(composite, new THREE.Camera()));
  const shipPass = new RenderPass(shipScene, camera); shipPass.clear = false; shipPass.clearDepth = true;
  composer.addPass(shipPass);
  bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), .65, .72, .42);
  composer.addPass(bloom);
  lens = new ShaderPass({ uniforms: { tDiffuse: { value: null }, uTime: shared.uTime, uResolution: shared.uResolution }, vertexShader: fullscreenVertex, fragmentShader: lensFragment });
  // Full-screen passes must not inherit stale depth from the ship pass when
  // EffectComposer alternates its buffers. That caused alternating/feedback
  // frames in the earlier renderer.
  lens.material.depthTest = false; lens.material.depthWrite = false;
  composer.addPass(lens);
  const output = new OutputPass(); output.material.depthTest = false; output.material.depthWrite = false;
  composer.addPass(output);
  fxaa = new ShaderPass(FXAAShader); fxaa.material.depthTest = false; fxaa.material.depthWrite = false; composer.addPass(fxaa);

  $('quality').value = state.quality;
  bindControls();
  setView(state.view);
  resize();
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
    get reference() { return { ...reference, duration: REFERENCE_DURATION, audioTime: referenceAudio.currentTime, audioPaused: referenceAudio.paused, camera: camera.position.toArray(), target: cameraTarget.toArray() }; },
    setView,
    seek(time) { if (reference.active) setView('tracking'); state.time = time; state.travel = time * (12 + state.speed * 6); state.entrance = 1; fluid.reset(); for (let i=0; i<Math.min(600, Math.round(time*60)); i++) fluid.update(1/60,state.speed,state.turbulence); },
    pause() { setPlaying(false); },
    play() { setPlaying(true); },
    advance(seconds) {
      if (reference.active) setView('tracking');
      const steps = Math.round(THREE.MathUtils.clamp(Number(seconds) || 0, 0, 60) * 60);
      for (let i=0; i<steps; i++) {
        state.time += 1/60; state.travel += (12+state.speed*6)/60;
        fluid.update(1/60, state.speed, drivenTurbulence());
      }
      state.entrance = 1; render(0);
    },
    render: () => render(0),
  };
  render(0);
  $('loading').style.opacity = 0;
  setTimeout(() => { $('loading').hidden = true; }, 650);
  renderer.setAnimationLoop(tick);
}

function resize() {
  const width = innerWidth, height = innerHeight;
  const scale = quality[state.quality].scale;
  // Cap resolution so a Retina display does not silently quadruple the raymarch cost.
  const pixelRatio = Math.min(devicePixelRatio, 1.5) * scale * Math.min(1, 1920 / width);
  renderer.setPixelRatio(pixelRatio); renderer.setSize(width, height, false);
  composer.setPixelRatio(pixelRatio); composer.setSize(width, height);
  sceneTarget.setSize(Math.floor(width * pixelRatio), Math.floor(height * pixelRatio));
  shared.uResolution.value.set(width * pixelRatio, height * pixelRatio);
  fxaa.uniforms.resolution.value.set(1/(width*pixelRatio),1/(height*pixelRatio));
  camera.aspect = width / height;
  camera.fov = width < 700 ? 53 : 39;
  camera.updateProjectionMatrix();
}

function setView(view) {
  if (!['tracking', 'bow', 'orbit', 'ride'].includes(view)) return;
  stopReference();
  state.view = view;
  orbit.enabled = view === 'orbit';
  if (orbit.enabled) { orbit.target.copy(cameraTarget); orbit.update(); }
  document.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === view)));
  $('view-label').textContent = { tracking: 'EXTERIOR / WIDE WAKE', bow: 'EXTERIOR / BOW CLOSE-UP', orbit: 'EXTERIOR / FREE ORBIT', ride: 'INTERIOR / ON BOARD' }[view];
  $('hint').textContent = view === 'orbit' ? 'Drag to orbit · Scroll to move closer · Right-drag to pan' : view === 'ride' ? 'Looking forward through the compression front' : view === 'bow' ? 'Rounded compression front · Refracted starlight' : 'Drag to look around in orbit view';
  updatePlay();
}

function bindControls() {
  $('play').addEventListener('click', togglePlay);
  $('replay').addEventListener('click', restart);
  $('reference-play').addEventListener('click', startReference);
  $('reference-sound').addEventListener('click', () => {
    referenceAudio.muted = !referenceAudio.muted;
    $('reference-sound').setAttribute('aria-pressed', String(!referenceAudio.muted));
    const label = referenceAudio.muted ? 'Unmute reference audio' : 'Mute reference audio';
    $('reference-sound').setAttribute('aria-label', label);
    $('reference-sound').title = label;
  });
  referenceAudio.addEventListener('error', () => {
    if (reference.active && !reference.silent) useSilentReference();
  });
  for (const key of ['speed', 'turbulence', 'intensity', 'lensing']) {
    $(key).addEventListener('input', () => {
      state[key] = Number($(key).value);
      $(`${key}-value`).textContent = key === 'speed' ? state[key].toFixed(1) : `${Math.round(state[key] * 100)}%`;
    });
  }
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
  $('quality').addEventListener('change', () => {
    state.quality = $('quality').value;
    volumeMaterial.defines.STEPS = quality[state.quality].steps;
    volumeMaterial.needsUpdate = true; resize();
  });
  $('ship').addEventListener('change', () => { state.ship = $('ship').checked; });
  $('hide').addEventListener('click', toggleUI);
  $('show').addEventListener('click', toggleUI);
  $('fullscreen').addEventListener('click', toggleFullscreen);
  $('capture').addEventListener('click', capture);
  document.addEventListener('keydown', (event) => {
    if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'A'].includes(document.activeElement?.tagName)) return;
    if (event.code === 'Space') { event.preventDefault(); togglePlay(); }
    if (event.key.toLowerCase() === 'h') toggleUI();
    if (event.key.toLowerCase() === 'r') restart();
    if (event.key.toLowerCase() === 'f') toggleFullscreen();
  });
  addEventListener('resize', () => { clearTimeout(resizing); resizing = setTimeout(resize, 80); });
  document.addEventListener('visibilitychange', () => {
    previous = performance.now();
    if (document.hidden && reference.active && state.playing) setPlaying(false);
  });
}

function startReference() {
  referenceAudio.pause();
  referenceAudio.currentTime = 0;
  Object.assign(reference, { active: true, time: 0, loading: false, silent: false, finished: false });
  Object.assign(state, { time: 4, travel: 12, entrance: 1, view: 'reference', speed: 8, turbulence: .65, intensity: 1, lensing: .7, ship: true });
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
  fluid.reset();
  for (let i=0; i<90; i++) fluid.update(1/60, state.speed, state.turbulence);
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
  state.travel += dt*(12+state.speed*6);
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
function restart() { if (reference.active) { startReference(); return; } state.time = 0; state.travel = 0; state.entrance = 0; fluid.reset(); state.playing = true; updatePlay(); }
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

function render(dt) {
  if (state.view === 'orbit') orbit.update();
  else {
    if (state.view === 'reference') {
      const pose = referenceCameraAt(reference.time);
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
    const blend = state.view !== 'reference' && dt > 0 ? 1 - Math.exp(-dt * 3.5) : 1;
    camera.position.lerp(desiredPosition, blend);
    cameraTarget.lerp(desiredTarget, blend);
    camera.lookAt(cameraTarget);
  }
  camera.updateMatrixWorld();
  shared.uTime.value = state.time;
  shared.uTravel.value = state.travel;
  field.update(state.travel);
  starUniforms.uTravel.value = state.travel;
  starUniforms.uSpeed.value = state.speed;
  volumeMaterial.uniforms.uTurbulence.value = state.turbulence;
  volumeMaterial.uniforms.uIntensity.value = state.intensity;
  volumeMaterial.uniforms.uFluid.value = fluid.texture;
  volumeMaterial.uniforms.uLensing.value = state.lensing;
  volumeMaterial.uniforms.uEntrance.value = THREE.MathUtils.smoothstep(state.entrance, 0, 1);
  lens.uniforms.uTime.value = state.time;
  ship.visible = state.ship && state.view !== 'ride';
  ship.rotation.x = Math.sin(state.time * .28) * .028;
  ship.rotation.z = Math.sin(state.time * .21) * .012;
  renderer.setRenderTarget(sceneTarget); renderer.clear();
  renderer.render(background, new THREE.Camera());
  renderer.clearDepth(); renderer.render(world, camera);
  renderer.setRenderTarget(null);
  composer.render();
}

function tick(now) {
  const dt = Math.min((now - previous) / 1000, .05); previous = now;
  if (document.hidden) return;
  if (state.playing) {
    if (reference.active && !reference.finished) {
      if (!reference.loading) advanceReferenceTo(reference.silent ? reference.time + dt : referenceAudio.ended ? REFERENCE_DURATION : referenceAudio.currentTime);
    } else {
      state.time += dt; state.travel += dt * (12 + state.speed * 6);
      state.entrance = Math.min(1, state.entrance + dt * .65);
      fluid.update(dt, state.speed, drivenTurbulence());
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
