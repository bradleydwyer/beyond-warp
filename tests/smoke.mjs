import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { REFERENCE_DURATION, referenceCameraAt } from '../src/reference-sequence.js';

const port = 5176;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'pipe' });
let serverOutput = '';
server.stdout.on('data', d => { serverOutput += d; });
server.stderr.on('data', d => { serverOutput += d; });
let browser;
const errors = [];
const metrics = async page => page.evaluate(() => {
  window.warp.render();
  const gl = document.querySelector('canvas').getContext('webgl2');
  const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
  gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let hash = 2166136261, sum = 0, lit = 0, count = 0;
  for (let i = 0; i < pixels.length; i += 64) {
    const l = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
    sum += l; if (l > 20) lit++; count++;
    for (let c = 0; c < 3; c++) hash = Math.imul(hash ^ pixels[i + c], 16777619);
  }
  return { hash: hash >>> 0, mean: sum / count, lit: lit / count, glError: gl.getError() };
});
const checkLobeOrder = shape => {
  for (let i = 1; i < shape.length; i++) {
    const a = shape[i-1], b = shape[i];
    assert(b.radius > a.radius, 'An earlier bubble became taller than a later bubble');
    assert(b.halfLength > a.halfLength, 'An earlier bubble became longer than a later bubble');
    assert(Math.abs((a.center+a.halfLength)-(b.center-b.halfLength)) < .0001, 'Bubble necks separated');
  }
};
const setRange = async (page, id, value) => page.locator(`#${id}`).evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, String(value));

try {
  // Regression for the speed kink at the old keyframe joins near two seconds.
  const h = .001;
  const acceleration = (t, key) => (referenceCameraAt(t+h)[key]-2*referenceCameraAt(t)[key]+referenceCameraAt(t-h)[key])/(h*h);
  for (const frame of [30, 36, 45, 54, 63, 72]) {
    const t = frame*1001/24000;
    for (const key of ['span', 'x', 'y', 'elevation']) {
      assert(Math.abs(acceleration(t-.002, key)-acceleration(t+.002, key)) < 1, `Camera acceleration jumps near ${t}s (${key})`);
    }
  }
  let previousSpan = 13;
  for (let i=0; i<=600; i++) {
    const span = referenceCameraAt(i/600*REFERENCE_DURATION).span;
    assert(span >= previousSpan && span <= 260, 'Camera zoom reverses or overshoots');
    previousSpan = span;
  }
  for (const key of ['span', 'x', 'y', 'elevation']) {
    const endSpeed = (referenceCameraAt(REFERENCE_DURATION)[key]-referenceCameraAt(REFERENCE_DURATION-h)[key])/h;
    assert(Math.abs(endSpeed) < .25, `Camera does not settle at the end (${key})`);
  }
  console.log('PASS: smooth camera acceleration, monotonic pullback, and settled final framing');
  for (let i = 0; i < 80; i++) {
    if (serverOutput.includes('Local:')) break;
    if (server.exitCode !== null) throw new Error(serverOutput);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  try { browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true }); }
  catch { browser = await chromium.launch({ headless: true }); }
  await mkdir('artifacts', { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${port}/?paused`);
  await page.waitForFunction(() => window.warp && document.getElementById('loading').hidden);
  assert.equal(await page.locator('#error').isVisible(), false);
  const first = await metrics(page);
  const initialShape = await page.evaluate(() => window.warp.fieldShape);
  checkLobeOrder(initialShape);
  assert(first.mean > 2 && first.mean < 100, `Unexpected initial luminance: ${first.mean}`);
  assert(first.lit > .01, 'Scene is empty or black');
  assert.equal(first.glError, 0);
  // Regression for the depth-buffer feedback bug: every paused frame is identical.
  const pausedHashes = [];
  for (let i = 0; i < 12; i++) pausedHashes.push((await metrics(page)).hash);
  assert(pausedHashes.every(hash => hash === first.hash), 'Paused frames flicker or accumulate brightness');
  console.log('PASS: shader compilation, rendered pixels, and 12 identical paused frames');

  await page.getByRole('button', { name: 'Play animation', exact: true }).click();
  const t0 = await page.evaluate(() => window.warp.state.time);
  await page.waitForTimeout(4000);
  await page.getByRole('button', { name: 'Pause animation', exact: true }).click();
  const animated = await metrics(page);
  const running = await page.evaluate(() => window.warp.state);
  assert(running.time > t0 + 2);
  assert.notEqual(animated.hash, first.hash);
  assert(animated.mean > 2 && animated.mean < 100, 'Simulation became black or overexposed');
  const changedShape = await page.evaluate(() => window.warp.fieldShape);
  checkLobeOrder(changedShape);
  assert(changedShape.some((lobe, i) => Math.abs(lobe.radius-initialShape[i].radius) > .1), 'Bubble heights stayed fixed');
  assert(changedShape.some((lobe, i) => Math.abs(lobe.halfLength-initialShape[i].halfLength) > .1), 'Bubble lengths stayed fixed');
  console.log(`PASS: fluid and bubble shapes evolve; downstream sizes stay ordered; observed ${running.fps} fps`);
  await page.screenshot({ path: 'artifacts/desktop.png' });
  await page.evaluate(() => window.warp.advance(30));
  const sustained = await metrics(page);
  checkLobeOrder(await page.evaluate(() => window.warp.fieldShape));
  assert(sustained.mean > 2 && sustained.mean < 100, 'Long-running fluid became black or overexposed');
  assert.notEqual(sustained.hash, animated.hash);
  assert.equal((await metrics(page)).hash, sustained.hash);
  await page.screenshot({ path: 'artifacts/after-30-seconds.png' });
  console.log('PASS: 30 further seconds of fixed-step fluid simulation remain stable');

  // Isolate refraction: no luminous volume, same paused background and camera.
  await setRange(page, 'intensity', 0);
  await setRange(page, 'lensing', 0);
  const straight = await metrics(page);
  await setRange(page, 'lensing', 1);
  const bent = await metrics(page);
  assert.notEqual(bent.hash, straight.hash, 'Light bending did not change background stars');
  assert(bent.mean > 1 && bent.mean < 100);
  await page.screenshot({ path: 'artifacts/lensing-only.png' });
  await setRange(page, 'intensity', 1);
  await setRange(page, 'lensing', .7);
  console.log('PASS: refraction bends the background independently of glow');

  for (const view of ['orbit', 'bow', 'ride', 'tracking']) {
    await page.locator(`[data-view="${view}"]`).click();
    await page.evaluate(() => window.warp.render());
    assert.equal(await page.evaluate(() => window.warp.state.view), view);
    const viewFrame = await metrics(page);
    assert.equal(viewFrame.glError, 0);
    assert(viewFrame.mean > .5 && viewFrame.mean < 100, `${view} view is blank or overexposed: ${viewFrame.mean}`);
    await page.screenshot({ path: `artifacts/view-${view}.png` });
  }
  await page.locator('#quality').selectOption('high');
  assert.equal((await metrics(page)).glError, 0);
  await page.locator('#quality').selectOption('balanced');
  await page.locator('[data-view="bow"]').click();
  const withShip = await metrics(page);
  await page.locator('#ship').uncheck();
  assert.notEqual((await metrics(page)).hash, withShip.hash);
  await page.locator('#ship').check();
  await page.locator('[data-view="tracking"]').click();
  await page.locator('#hide').click();
  assert.equal(await page.locator('#show').isVisible(), true);
  await page.locator('#show').click();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#capture').click();
  const download = await downloadPromise;
  assert(download.suggestedFilename().endsWith('.png'));
  console.log('PASS: four cameras, quality modes, ship toggle, hidden UI, PNG export');

  await page.getByRole('button', { name: 'Play reference sequence', exact: true }).click();
  await page.waitForFunction(() => window.warp.reference.time > .45);
  const close = await page.evaluate(() => window.warp.reference);
  assert(close.active && !close.silent && !close.audioPaused, 'Original audio did not start with the sequence');
  assert(Math.abs(close.time-close.audioTime) < .1, 'Camera drifted from the audio clock');
  await page.getByRole('button', { name: 'Pause animation', exact: true }).click();
  const pausedSequence = await page.evaluate(() => window.warp.reference);
  await page.waitForTimeout(300);
  const stillSequence = await page.evaluate(() => window.warp.reference);
  assert.equal(stillSequence.time, pausedSequence.time, 'Camera moved while paused');
  assert.equal(stillSequence.audioTime, pausedSequence.audioTime, 'Sound moved while paused');
  assert.deepEqual(stillSequence.camera, pausedSequence.camera);
  await page.getByRole('button', { name: 'Mute reference audio', exact: true }).click();
  assert(await page.locator('#reference-audio').evaluate(el => el.muted));
  await page.getByRole('button', { name: 'Play animation', exact: true }).click();
  await page.waitForFunction(() => window.warp.reference.time > 2);
  const pulledBack = await page.evaluate(() => window.warp.reference);
  assert(pulledBack.camera[2] > close.camera[2]*2, 'Camera did not pull away from the bow');
  assert(pulledBack.target[0] > close.target[0], 'Camera did not pan along the wake');
  await page.screenshot({ path: 'artifacts/reference-sequence-middle.png' });
  await page.waitForFunction(() => window.warp.reference.finished, undefined, { timeout: 8000 });
  assert.equal(await page.evaluate(() => window.warp.state.playing), true);
  const end = await page.evaluate(() => window.warp.reference);
  assert.equal(end.time, end.duration);
  assert(end.audioPaused);
  assert(Math.abs(end.target[0]-130) < .001, 'Sequence did not finish on the fitted wide view');
  const endState = await page.evaluate(() => window.warp.state);
  const endHash = (await metrics(page)).hash;
  await page.waitForTimeout(700);
  const continuing = await page.evaluate(() => ({ state: window.warp.state, reference: window.warp.reference }));
  assert(continuing.state.time > endState.time+.4, 'Simulation stopped after the camera sequence');
  assert(continuing.state.travel > endState.travel+20, 'Stars and nebula stopped moving after the sequence');
  assert(continuing.state.simulationTime > endState.simulationTime+.4, 'Fluid stopped after the sequence');
  assert.deepEqual(continuing.reference.camera, end.camera, 'Camera moved out of the final framing');
  assert(continuing.reference.audioPaused, 'Reference audio restarted at the end');
  assert.notEqual((await metrics(page)).hash, endHash, 'Final wide view is frozen');
  await page.evaluate(() => window.warp.pause());
  const settledHash = (await metrics(page)).hash;
  assert.equal((await metrics(page)).hash, settledHash, 'Paused final view flickers');
  await page.evaluate(() => window.warp.play());
  await page.waitForTimeout(150);
  const resumed = await page.evaluate(() => window.warp.reference);
  assert(resumed.finished && resumed.audioPaused && resumed.time === resumed.duration, 'Resuming the simulation restarted the reference sequence');
  await page.screenshot({ path: 'artifacts/reference-sequence-end.png' });
  await page.getByRole('button', { name: 'Replay reference sequence', exact: true }).click();
  await page.waitForFunction(() => window.warp.reference.time > .1 && window.warp.reference.time < 1);
  await page.locator('[data-view="bow"]').click();
  const cancelled = await page.evaluate(() => window.warp.reference);
  assert(!cancelled.active && cancelled.audioPaused, 'Changing cameras left reference audio playing');
  // Cancel before play() resolves: its stale promise must not restart audio.
  await page.evaluate(() => { document.getElementById('reference-play').click(); window.warp.setView('bow'); });
  await page.waitForTimeout(150);
  assert(await page.locator('#reference-audio').evaluate(el => el.paused));
  await page.getByRole('button', { name: 'Unmute reference audio', exact: true }).click();
  await page.evaluate(() => window.warp.pause());
  await page.locator('[data-view="tracking"]').click();
  console.log('PASS: synchronised audio and camera, continued simulation after the end, pause/resume, mute, replay, and view cancellation');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false, 'Mobile layout overflows horizontally');
  for (const id of ['speed', 'turbulence', 'intensity', 'lensing', 'quality', 'reference-play', 'reference-sound']) {
    const box = await page.locator(`#${id}`).boundingBox();
    assert(box && box.x >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844, `${id} is off-screen`);
  }
  await page.evaluate(() => window.warp.render());
  await page.screenshot({ path: 'artifacts/mobile.png' });
  const reduced = await browser.newPage({ viewport: { width: 800, height: 600 }, reducedMotion: 'reduce' });
  await reduced.goto(`http://127.0.0.1:${port}/`);
  await reduced.waitForFunction(() => window.warp);
  assert.equal(await reduced.evaluate(() => window.warp.state.playing), false);
  console.log('PASS: mobile controls fit and reduced-motion preference starts paused');
  const unavailable = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await unavailable.route('**/audio/beyond-reference.m4a', route => route.abort());
  await unavailable.goto(`http://127.0.0.1:${port}/?paused`);
  await unavailable.waitForFunction(() => window.warp && document.getElementById('loading').hidden);
  await unavailable.locator('#reference-play').click();
  await unavailable.waitForFunction(() => window.warp.reference.silent && window.warp.reference.time > .25);
  assert.equal(await unavailable.locator('#error').isVisible(), false);
  await unavailable.close();
  console.log('PASS: unavailable audio falls back to silent camera playback');
  assert.deepEqual(errors, [], `Browser errors: ${errors.join('\n')}`);
  console.log('All visual smoke checks passed.');
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
