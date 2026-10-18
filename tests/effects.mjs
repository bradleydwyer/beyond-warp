import assert from 'node:assert/strict';

const SLIDERS = ['nebula', 'nebulaDensity', 'nebulaGlow', 'blackLevel', 'interior', 'interiorShrink', 'crestThickness', 'crestLight', 'crestVariation',
  'gas', 'gasShock', 'gasPileup', 'gasDepth', 'gasFlow',
  'streak', 'streakLength', 'streakTint', 'heroFlares', 'starStreaks',
  'grain', 'softness', 'focus', 'dust', 'grade', 'vignette',
  'dispersion', 'iridescence', 'bowLayers', 'layerSpread', 'projectedStars', 'starThreshold'];
// Experiments (checkboxes that are on by default).
const TOGGLES = ['energyRim', 'gasReacts', 'filmFlow', 'layerRefraction', 'starLayer', 'stableDust'];
// The bow's optics act at the bow and hand over to the plain rim as the
// camera pulls back, so checkBow tests them in the Bow camera (and that they
// leave the wide shot's nose alone) rather than in the wide default still.
const BOW_CONTROLS = ['dispersion', 'iridescence', 'bowLayers', 'layerSpread', 'filmFlow', 'layerRefraction'];
// The projected stars belong to Compressed space alone, so checkProjection
// tests them there (and that the other appearances never see them).
const PROJECTION_CONTROLS = ['projectedStars', 'starThreshold', 'starLayer', 'stableDust'];

// The Effects panel: every control changes the picture, survives appearance
// switches and replays, can be set from the URL, and stays deterministic.
export async function checkEffects(browser, url) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 536 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const setRange = (id, value) => page.locator(`#${id}`).evaluate((el, v) => {
    el.value = v; el.dispatchEvent(new Event('input', { bubbles: true }));
  }, String(value));
  const hash = () => page.evaluate(() => {
    window.warp.render();
    const gl = document.querySelector('canvas').getContext('webgl2');
    const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
    gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let h = 2166136261;
    for (let i = 0; i < pixels.length; i += 16) h = Math.imul(h ^ pixels[i] ^ (pixels[i + 1] << 8) ^ (pixels[i + 2] << 16), 16777619);
    return h >>> 0;
  });
  try {
    await page.goto(`${url}/?paused&time=10`);
    await page.waitForFunction(() => window.warp && document.getElementById('loading').hidden);
    assert.equal(await page.locator('#effects').evaluate(el => el.tagName), 'DETAILS', 'Effects panel is not collapsible');
    assert.equal(await page.locator('#nebula').isVisible(), false, 'Effects panel should start collapsed');
    await page.locator('#effects summary').click();
    assert.equal(await page.locator('#nebula').isVisible(), true, 'Effects panel did not open');
    const defaults = await hash();
    for (const id of SLIDERS) {
      const original = await page.locator(`#${id}`).inputValue();
      assert(Number(original) > 0, `${id} should be on by default`);
      if (BOW_CONTROLS.includes(id) || PROJECTION_CONTROLS.includes(id)) continue;
      await setRange(id, 0);
      assert.notEqual(await hash(), defaults, `${id} at 0 did not change the frame`);
      await setRange(id, original);
    }
    for (const id of TOGGLES) {
      assert(await page.locator(`#${id}`).isChecked(), `${id} should be on by default`);
      if (BOW_CONTROLS.includes(id) || PROJECTION_CONTROLS.includes(id)) continue;
      await page.locator(`#${id}`).uncheck();
      assert.notEqual(await hash(), defaults, `${id} toggle did not change the frame`);
      await page.locator(`#${id}`).check();
    }
    assert.equal(await hash(), defaults, 'Restoring every effect did not restore the frame');

    for (const id of SLIDERS) await setRange(id, 0);
    for (const id of TOGGLES) await page.locator(`#${id}`).uncheck();
    const off = await hash();
    assert.equal(await hash(), off, 'All-off frame is not stable while paused');

    // One-click A/B: the bypass shows the all-off frame without moving a slider.
    await page.locator('#effects-reset').click();
    assert.equal(await hash(), defaults, 'Defaults did not restore the tuned look');
    await page.locator('#effectsBypass').check();
    assert.equal(await hash(), off, 'Bypass did not show the original look');
    assert.equal(await page.locator('#crestThickness').inputValue(), '1', 'Bypass moved the sliders');
    await page.locator('#effectsBypass').uncheck();
    assert.equal(await hash(), defaults, 'Turning the bypass off did not restore the effects');
    await page.locator('#effects-off').click();
    assert.equal(await hash(), off, 'All off did not zero every effect');
    for (const id of SLIDERS) assert.equal(Number(await page.locator(`#${id}`).inputValue()), 0, `All off left ${id} on`);
    for (const id of TOGGLES) assert.equal(await page.locator(`#${id}`).isChecked(), false, `All off left the ${id} experiment on`);
    assert.equal(await page.locator('#letterbox').isChecked(), false, 'All off left the letterbox on');
    await setRange('crestThickness', 1.4);
    await setRange('bowLayers', 1.5);
    for (const appearance of ['fluid', 'space', 'glow']) await page.locator(`[data-appearance="${appearance}"]`).click();
    await page.locator('#reference-play').click();
    await page.waitForFunction(() => window.warp.reference.time > .1);
    const kept = await page.evaluate(() => [window.warp.state.crestThickness, window.warp.state.nebula, window.warp.state.energyRim, window.warp.state.bowLayers, window.warp.state.dispersion]);
    assert.deepEqual(kept, [1.4, 0, false, 1.5, 0], 'Appearance switches or replay reset the effect controls');
    await page.evaluate(() => window.warp.pause());

    // Compressed space reprojects bright gas into its ribbons: at the
    // defaults, with the nebula on, nothing may be drawn pure black (the
    // lower ribbon once turned into a black band along the whole field).
    await page.goto(`${url}/?paused&time=10&appearance=space`);
    await page.waitForFunction(() => window.warp && document.getElementById('loading').hidden);
    const black = await page.evaluate(() => {
      window.warp.render();
      const gl = document.querySelector('canvas').getContext('webgl2');
      const px = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
      gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let n = 0;
      for (let i = 0; i < px.length; i += 4) if (.2126 * px[i] + .7152 * px[i + 1] + .0722 * px[i + 2] < 1.5) n++;
      return n / (px.length / 4);
    });
    assert(black < .002, `Compressed space draws ${(black * 100).toFixed(2)}% pure-black pixels`);

    await page.goto(`${url}/?paused&time=10&crestThickness=0.5&energyRim=0&layerSpread=0.7&layerRefraction=0`);
    await page.waitForFunction(() => window.warp && document.getElementById('loading').hidden);
    assert.equal(await page.locator('#crestThickness').inputValue(), '0.5', 'URL parameter did not set the slider');
    assert.equal(await page.locator('#energyRim').isChecked(), false, 'URL parameter did not set the toggle');
    assert.equal(await page.locator('#layerSpread').inputValue(), '0.7', 'URL parameter did not set a Bow slider');
    assert.equal(await page.locator('#layerRefraction').isChecked(), false, 'URL parameter did not set a Bow experiment');
    assert.deepEqual(errors, []);
    console.log('PASS: effect controls change the frame, restore exactly, bypass and reset in one click, survive appearance switches and replay, and read URL parameters');
  } finally {
    await page.close();
  }
  await checkFilm(browser, url);
  await checkGas(browser, url);
  await checkBow(browser, url);
  await checkProjection(browser, url);
}

// Projected stars (Effects › Projection), in Compressed space: each control
// changes the bands and restores them exactly, the frame is still while
// paused (also after the stars have moved on), 0% is the same frame as a
// fresh load without it (its define is removed and the star layer is not
// drawn), and Compressed glow and Fluid glow never see it. The stars in the
// centre stream stand out: along its rows there are many more points
// standing well above the local median of the band, and they stand further
// above it; a higher Star threshold leaves fewer of them. They are sparse
// points, not glare: most of the stream is the gas as before, and the
// frame's mean and its brightest pixels hardly rise. Edge glow keeps
// working with them. Looking down on the field from above (Orbit dragged to
// the pole) the centre stream's stars are not stretched into vertical bars.
// In the Bow camera, a star sliding along the centre stream does not make
// the whole frame's speed dust pulse (Stable dust light), which the other
// appearances never see. The controls survive appearance switches and
// replay, and read URL parameters.
export async function checkProjection(browser, url) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 536 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const ready = () => page.waitForFunction(() => window.warp && document.getElementById('loading').hidden);
  const set = (id, value) => page.locator(`#${id}`).evaluate((el, v) => {
    if (el.type === 'checkbox') { el.checked = v === 'true'; el.dispatchEvent(new Event('change', { bubbles: true })); }
    else { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }
  }, String(value));
  // Hash, the frame's mean and p99.9 luminance, and the peaks: local maxima
  // along a row standing more than 24 levels above the median of the 31
  // pixels around them, over the whole frame (the sky's own stars are the
  // same with and without, so the difference is the bands' stars) and along
  // the rows of the centre stream (the field's axis is the middle row in the
  // wide view). 'stream' is those rows' luminance.
  const frame = () => page.evaluate(() => {
    window.warp.render();
    const gl = document.querySelector('canvas').getContext('webgl2');
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let hash = 2166136261;
    for (let i = 0; i < px.length; i += 16) hash = Math.imul(hash ^ px[i] ^ (px[i + 1] << 8) ^ (px[i + 2] << 16), 16777619);
    const lum = (x, y) => { const i = ((h - 1 - y) * w + x) * 4; return .2126 * px[i] + .7152 * px[i + 1] + .0722 * px[i + 2]; };
    const all = new Float32Array(w * h);
    let sum = 0;
    for (let i = 0; i < w * h; i++) sum += all[i] = .2126 * px[4 * i] + .7152 * px[4 * i + 1] + .0722 * px[4 * i + 2];
    all.sort();
    const peakAt = (x, y) => {
      const v = lum(x, y);
      if (v < lum(x - 1, y) || v < lum(x - 2, y) || v <= lum(x + 1, y) || v <= lum(x + 2, y)) return 0;
      const around = [];
      for (let d = -15; d <= 15; d++) around.push(lum(x + d, y));
      around.sort((a, b) => a - b);
      return v - around[15] > 24 ? v - around[15] : 0;
    };
    let peaks = 0, strong = 0, streamPeaks = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 15; x < w - 15; x++) {
        const e = peakAt(x, y);
        if (e) peaks++;
        if (e > 40) strong++;
      }
    }
    const stream = [];
    for (let y = Math.round(.47 * h); y <= Math.round(.53 * h); y++) {
      for (let x = Math.round(.1 * w); x < Math.round(.95 * w); x++) {
        stream.push(lum(x, y));
        if (peakAt(x, y)) streamPeaks++;
      }
    }
    return { hash: hash >>> 0, peaks, strong, streamPeaks, mean: sum / (w * h), p999: all[Math.floor(.999 * (all.length - 1))], stream };
  });
  const shot = async query => { await page.goto(`${url}/?paused&time=10&${query}`); await ready(); return frame(); };
  try {
    const on = await shot('appearance=space');
    for (let i = 0; i < 3; i++) assert.equal((await frame()).hash, on.hash, 'The projected stars flicker while paused');
    await page.locator('#effects summary').click();
    for (const id of PROJECTION_CONTROLS) {
      const toggle = await page.locator(`#${id}`).evaluate(el => el.type === 'checkbox');
      const original = toggle ? 'true' : await page.locator(`#${id}`).inputValue();
      assert(toggle ? await page.locator(`#${id}`).isChecked() : Number(original) > 0, `${id} should be on by default`);
      await set(id, toggle ? 'false' : 0);
      assert.notEqual((await frame()).hash, on.hash, `${id} off did not change the Compressed space bands`);
      await set(id, original);
      assert.equal((await frame()).hash, on.hash, `${id} did not restore the bands exactly`);
    }
    await set('projectedStars', 0);
    const off = await frame();
    // Sparse points over the gas, not speckle or glare.
    let brightened = 0;
    for (let i = 0; i < on.stream.length; i++) if (on.stream[i] > off.stream[i] + 16) brightened++;
    const speckle = brightened / on.stream.length;
    assert(speckle < .3, `The centre stream fills with speckle (${(speckle * 100).toFixed(0)}% of it brightened by more than 16 levels)`);
    assert(on.mean < off.mean + 5, `Projected stars brighten the whole frame (mean ${off.mean.toFixed(1)} -> ${on.mean.toFixed(1)})`);
    assert(on.p999 < off.p999 + 30, `Projected stars glare (p99.9 ${off.p999.toFixed(0)} -> ${on.p999.toFixed(0)})`);
    await set('starThreshold', 2);
    const sparse = await frame();
    await set('projectedStars', 1);
    const strict = await frame();
    assert(on.peaks >= off.peaks + 80 && on.strong >= off.strong + 40 && on.streamPeaks >= off.streamPeaks + 8,
      `The projected stars do not stand out in the bands (${off.peaks} -> ${on.peaks} peaks, ${off.strong} -> ${on.strong} standing 40 levels out; centre stream ${off.streamPeaks} -> ${on.streamPeaks})`);
    assert(strict.peaks < on.peaks, `A higher Star threshold did not leave fewer stars (${on.peaks} -> ${strict.peaks})`);
    assert.equal(sparse.hash, off.hash, 'Star threshold changes the frame with Projected stars at 0%');
    assert.equal((await shot('appearance=space&projectedStars=0')).hash, off.hash, 'Projected stars at 0% is not the frame without them');
    // The half-float star layer (GPUs without filterable 32-bit float) shows
    // the same stars, still while paused.
    const half = await shot('appearance=space&halfFloatStars');
    assert(half.peaks >= off.peaks + 80 && half.strong >= off.strong + 40 && Math.abs(half.peaks - on.peaks) < .1 * on.peaks,
      `The half-float star layer differs (${on.peaks} -> ${half.peaks} peaks, ${on.strong} -> ${half.strong} standing out)`);
    assert.equal((await frame()).hash, half.hash, 'The half-float star layer is not still while paused');
    // Still while paused after the stars have moved on.
    await shot('appearance=space');
    await page.evaluate(() => window.warp.advance(10 / 60));
    const moved = await frame();
    assert.notEqual(moved.hash, on.hash, 'The frame did not advance');
    for (let i = 0; i < 2; i++) assert.equal((await frame()).hash, moved.hash, 'The projected stars are not still while paused');
    // Edge glow brightens the ribbons and their stars; the stars still
    // change the frame there and it is still while paused.
    await page.locator('#edgeGlow').evaluate(el => { el.value = '1'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    const glowing = await frame();
    assert.notEqual(glowing.hash, moved.hash, 'Edge glow did not change Compressed space');
    assert.equal((await frame()).hash, glowing.hash, 'Edge glow with projected stars is not still while paused');
    await page.locator('#effects summary').click();
    await set('projectedStars', 0);
    assert.notEqual((await frame()).hash, glowing.hash, 'Projected stars do not show with Edge glow on');
    // The other appearances never see them, nor Stable dust light (the
    // dust is strongest in the Bow camera).
    for (const appearance of ['glow', 'fluid']) {
      const plain = await shot(`appearance=${appearance}&projectedStars=0`);
      assert.equal((await shot(`appearance=${appearance}&projectedStars=3&starThreshold=0`)).hash, plain.hash, `Projected stars change ${appearance}`);
      const bow = await shot(`appearance=${appearance}&view=bow&stableDust=0`);
      assert.equal((await shot(`appearance=${appearance}&view=bow`)).hash, bow.hash, `Stable dust light changes ${appearance}`);
    }
    // Lengths of vertical runs: the luminance of the frame now against the
    // one kept by the previous call ('keep'), in columns where it rose by
    // more than 25 levels for 12 rows or more.
    const lumFrame = keep => page.evaluate(keep => {
      window.warp.render();
      const gl = document.querySelector('canvas').getContext('webgl2');
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const lum = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) lum[i] = .2126 * px[4 * i] + .7152 * px[4 * i + 1] + .0722 * px[4 * i + 2];
      const before = window.__projectionLum;
      if (keep) window.__projectionLum = lum;
      if (!before || keep) return { w, h };
      let bars = 0, lowerLeft = 0;
      for (let x = 0; x < w; x++) {
        let run = 0, longest = 0;
        for (let y = 0; y < h; y++) {
          const d = before[y * w + x] - lum[y * w + x];
          if (d > 25) longest = Math.max(longest, ++run); else run = 0;
          // GL rows run bottom up: y < .45h is the lower part of the frame.
          if (x < w / 2 && y < .45 * h && d > 2) lowerLeft += d;
        }
        if (longest >= 12) bars++;
      }
      return { w, h, bars, lowerLeft };
    }, keep);
    // Orbit from straight above: a long vertical drag parks the camera at
    // the pole, where the stream's across direction turns radial.
    await page.goto(`${url}/?paused&time=10&appearance=space&view=orbit`);
    await ready();
    await page.evaluate(() => document.getElementById('hide')?.click());
    await page.mouse.move(640, 268);
    await page.mouse.down();
    await page.mouse.move(640, 468, { steps: 25 });
    await page.mouse.up();
    let pose = '';
    for (let i = 0; i < 300; i++) {
      const now = await page.evaluate(() => { window.warp.render(); return JSON.stringify(window.warp.reference.camera.map(v => v.toFixed(4))); });
      if (now === pose) break;
      pose = now;
    }
    const camera = JSON.parse(pose).map(Number);
    assert(Math.abs(camera[1]) > 150 && Math.abs(camera[2]) < 1, `The Orbit drag did not reach the pole (${pose})`);
    await lumFrame(true);
    await set('projectedStars', 0);
    const pole = await lumFrame(false);
    assert(pole.bars <= 3, `Seen from above, the centre stream's stars are stretched into vertical bars (${pole.bars} columns)`);
    // Bow camera: a dash on the centre stream crossed one of the dust's
    // nine frame-light points in these frames and lit all the dust for a
    // few frames. Stars at a ten-thousandth keep the star layer and the dust
    // light it brings, so only the stars differ.
    const setFine = (id, value) => page.locator(`#${id}`).evaluate((el, v) => {
      el.step = 'any'; el.value = v; el.dispatchEvent(new Event('input', { bubbles: true }));
    }, String(value));
    await page.goto(`${url}/?paused&time=10&appearance=space&view=bow`);
    await ready();
    await page.evaluate(() => { window.warp.seek(10); window.warp.advance(2); for (let i = 0; i < 4; i++) window.warp.advance(1 / 60); });
    let pulse = 0;
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.warp.advance(1 / 60));
      await setFine('projectedStars', 1);
      await lumFrame(true);
      await setFine('projectedStars', .0001);
      pulse = Math.max(pulse, (await lumFrame(false)).lowerLeft);
    }
    assert(pulse < 10000, `Projected stars make the Bow camera's speed dust pulse (${Math.round(pulse)} levels of light in the lower left)`);
    // Kept through appearance switches and replay; URL parameters, clamped.
    await shot('appearance=space');
    await page.locator('#effects summary').click();
    await set('projectedStars', 1.7);
    await set('starThreshold', .4);
    for (const appearance of ['fluid', 'glow', 'space']) await page.locator(`[data-appearance="${appearance}"]`).click();
    await page.locator('#reference-play').click();
    await page.waitForFunction(() => window.warp.reference.time > .1);
    assert.deepEqual(await page.evaluate(() => [window.warp.state.projectedStars, window.warp.state.starThreshold, window.warp.state.appearance]), [1.7, .4, 'space'],
      'Appearance switches or replay reset the projection controls');
    await page.evaluate(() => window.warp.pause());
    await page.goto(`${url}/?paused&time=10&appearance=space&projectedStars=9&starThreshold=0.5&starLayer=0`);
    await ready();
    assert.equal(await page.locator('#starLayer').isChecked(), false, 'URL parameter did not set Separate star layer');
    assert.equal(await page.locator('#projectedStars').inputValue(), '3', 'URL parameter did not set (and clamp) Projected stars');
    assert.equal(await page.locator('#starThreshold').inputValue(), '0.5', 'URL parameter did not set Star threshold');
    assert.deepEqual(errors, []);
    console.log(`PASS: projected stars change the Compressed space bands and restore exactly, still while paused, 0% is the frame without them, glow and fluid untouched, Edge glow works with them, no bars seen from above (${pole.bars} columns), no dust pulse in the Bow camera (${Math.round(pulse)}); peaks ${off.peaks} -> ${on.peaks} (${off.strong} -> ${on.strong} standing 40 levels out), centre stream ${off.streamPeaks} -> ${on.streamPeaks} (${(speckle * 100).toFixed(0)}% of it brightened), ${strict.peaks} at Star threshold 200%; frame mean ${off.mean.toFixed(1)} -> ${on.mean.toFixed(1)}, p99.9 ${off.p999.toFixed(0)} -> ${on.p999.toFixed(0)}`);
  } finally {
    await page.close();
  }
}

// The bow close-up (Effects › Bow), in the Bow camera: every Bow control
// changes the close-up and restores it exactly, the frame is still while
// paused, dispersion really separates the red and blue channels round the
// nose, and 0% is the same frame as a fresh load without it (its shader
// define is removed). In each appearance the nested layers draw separate thin
// arcs (rows across the upper bow cross several distinct ridges of the light
// they add) and the optics at 0 are a fresh load without them. In the wide
// shot the optics hand over to the plain rim: the nose gains no red/blue
// outline and hardly changes. Pushed to 200%, the layers neither wash out the
// bow's interior nor reach into the on-board view.
export async function checkBow(browser, url) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 536 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const ready = () => page.waitForFunction(() => window.warp && document.getElementById('loading').hidden);
  const set = (id, value) => page.locator(`#${id}`).evaluate((el, v) => {
    if (el.type === 'checkbox') { el.checked = v; el.dispatchEvent(new Event('change', { bubbles: true })); }
    else { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }
  }, value);
  // Hash; the channels of a box (fractions x0, x1, y0, y1, top-down); and the
  // correlation of the horizontally high-passed red and blue channels in it
  // (1 when they line up, lower as they separate).
  const frame = box => page.evaluate(box => {
    window.warp.render();
    const gl = document.querySelector('canvas').getContext('webgl2');
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let hash = 2166136261;
    for (let i = 0; i < px.length; i += 16) hash = Math.imul(hash ^ px[i] ^ (px[i + 1] << 8) ^ (px[i + 2] << 16), 16777619);
    const at = (x, y, c) => px[((h - 1 - y) * w + x) * 4 + c];
    const channels = [];
    let rb = 0, rr = 0, bb = 0;
    for (let y = Math.round(box[2] * h); y < Math.round(box[3] * h); y++) for (let x = Math.round(box[0] * w); x < Math.round(box[1] * w); x++) {
      channels.push(at(x, y, 0), at(x, y, 1), at(x, y, 2));
      if (x < 3 || x > w - 4) continue;
      const pass = c => at(x, y, c) - (at(x - 3, y, c) + at(x + 3, y, c)) * .5;
      const r = pass(0), b = pass(2);
      rb += r * b; rr += r * r; bb += b * b;
    }
    return { hash: hash >>> 0, channels, correlation: rb / Math.sqrt(rr * bb + 1e-9) };
  }, box);
  const moved = (a, b) => [0, 1, 2].map(c => {
    let sum = 0;
    for (let i = c; i < a.channels.length; i += 3) sum += Math.abs(a.channels[i] - b.channels[i]);
    return sum / (a.channels.length / 3);
  });
  const redBlue = (f, q) => {
    const d = [];
    for (let i = 0; i < f.channels.length; i += 3) d.push(f.channels[i] - f.channels[i + 2]);
    d.sort((p, r) => p - r);
    return d[Math.floor(q * (d.length - 1))];
  };
  const NOSE = [.38, .62, .05, .95];
  // Smoothed luminance along rows through the upper bow, and the number of
  // distinct ridges (thin arcs) in a row: peaks standing a given number of
  // levels above both sides within 12 pixels.
  const rows = () => page.evaluate(() => {
    window.warp.render();
    const gl = document.querySelector('canvas').getContext('webgl2');
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const lum = (x, y) => { const i = ((h - 1 - y) * w + x) * 4; return .2126 * px[i] + .7152 * px[i + 1] + .0722 * px[i + 2]; };
    return [.08, .12, .16, .2, .25, .3].map(fy => {
      const y = Math.round(fy * h), row = [];
      for (let x = Math.round(.38 * w); x < Math.round(.9 * w); x++) {
        let s = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -1; dx <= 1; dx++) s += lum(x + dx, y + dy);
        row.push(s / 15);
      }
      return row;
    });
  });
  const ridges = (row, prominence) => {
    let count = 0;
    for (let i = 1; i < row.length - 1; i++) {
      if (row[i] <= row[i - 1] || row[i] < row[i + 1]) continue;
      let left = row[i], right = row[i];
      for (let j = 1; j <= 12; j++) { left = Math.min(left, row[Math.max(i - j, 0)]); right = Math.min(right, row[Math.min(i + j, row.length - 1)]); }
      if (row[i] - Math.max(left, right) > prominence) count++;
    }
    return count;
  };
  try {
    await page.goto(`${url}/?paused&time=10&view=bow`);
    await ready();
    await page.locator('#effects summary').click();
    const lit = await frame(NOSE);
    for (let i = 0; i < 3; i++) assert.equal((await frame(NOSE)).hash, lit.hash, 'The bow optics flicker while paused');
    for (const id of BOW_CONTROLS) {
      const toggle = await page.locator(`#${id}`).evaluate(el => el.type === 'checkbox');
      const original = toggle ? true : await page.locator(`#${id}`).inputValue();
      await set(id, toggle ? false : '0');
      assert.notEqual((await frame(NOSE)).hash, lit.hash, `${id} off did not change the bow`);
      await set(id, original);
    }
    assert.equal((await frame(NOSE)).hash, lit.hash, 'Restoring the bow controls did not restore the frame');
    // Dispersion alone, against the plain bow: red and blue move apart far
    // more than green, and their fine detail no longer lines up.
    for (const id of ['dispersion', 'iridescence', 'bowLayers']) await set(id, '0');
    const plain = await frame(NOSE);
    await set('dispersion', '1');
    const dispersed = await frame(NOSE);
    const [r, g, b] = moved(dispersed, plain);
    assert(r + b > 2.5 * g && plain.correlation - dispersed.correlation > .05,
      `Dispersion does not separate the channels at the bow (mean change r ${r.toFixed(2)}, g ${g.toFixed(2)}, b ${b.toFixed(2)}; red/blue correlation ${plain.correlation.toFixed(3)} -> ${dispersed.correlation.toFixed(3)})`);
    await set('layerSpread', '0');
    await set('dispersion', '0');
    await set('bowLayers', '1');
    assert.equal((await frame(NOSE)).hash, plain.hash, 'Layer spread at 0 is not the same frame as Bow layers at 0');
    await page.goto(`${url}/?paused&time=10&view=bow&dispersion=0`);
    await ready();
    const noDispersion = await frame(NOSE);
    await page.goto(`${url}/?paused&time=10&view=bow`);
    await ready();
    await set('dispersion', '0');
    assert.equal((await frame(NOSE)).hash, noDispersion.hash, 'Dispersion at 0% is not the frame without it');

    // Several thin arcs, not one curve, in all three appearances, and all of
    // the optics at 0 is a fresh load without them.
    const arcs = {};
    for (const appearance of ['glow', 'fluid', 'space']) {
      await page.goto(`${url}/?paused&time=10&view=bow&appearance=${appearance}`);
      await ready();
      const on = await frame(NOSE);
      const layered = await rows();
      await set('bowLayers', '0');
      const single = await rows();
      const added = layered.reduce((sum, row, k) => sum + ridges(row.map((v, i) => v - single[k][i]), 5), 0);
      assert(added >= 9, `The bow layers do not draw separate arcs in ${appearance} (${added} ridges over ${layered.length} rows)`);
      arcs[appearance] = added;
      for (const id of ['dispersion', 'iridescence']) await set(id, '0');
      const zeroed = await frame(NOSE);
      assert.notEqual(zeroed.hash, on.hash, `The bow optics do nothing in ${appearance}`);
      await page.goto(`${url}/?paused&time=10&view=bow&appearance=${appearance}&dispersion=0&iridescence=0&bowLayers=0`);
      await ready();
      assert.equal((await frame(NOSE)).hash, zeroed.hash, `The bow optics at 0 are not the frame without them in ${appearance}`);
    }

    // The wide shot: no chromatic outline at the nose, and hardly any change.
    const WIDE_NOSE = [0, .25, .2, .8];
    const wide = {};
    for (const appearance of ['glow', 'space']) {
      await page.goto(`${url}/?paused&time=10&appearance=${appearance}`);
      await ready();
      const optics = await frame(WIDE_NOSE);
      for (const id of ['dispersion', 'iridescence', 'bowLayers']) await set(id, '0');
      const none = await frame(WIDE_NOSE);
      const change = Math.max(...moved(optics, none));
      const outline = redBlue(optics, .999) - redBlue(none, .999);
      assert(change < 1 && outline <= 3,
        `The bow optics change the wide shot's nose in ${appearance} (mean change ${change.toFixed(2)}, red-blue p99.9 ${outline > 0 ? '+' : ''}${outline})`);
      wide[appearance] = `${change.toFixed(2)}/${outline > 0 ? '+' : ''}${outline}`;
    }
    // At the top of their range the layers are still a set of arcs: the
    // interior behind the upper bow does not wash out (the sheets ease off
    // before the axis), and the on-board view, which looks along the axis,
    // is untouched by them.
    const INTERIOR = [.55, .95, .1, .42];
    const luminance = f => {
      let sum = 0;
      for (let i = 0; i < f.channels.length; i += 3) sum += .2126 * f.channels[i] + .7152 * f.channels[i + 1] + .0722 * f.channels[i + 2];
      return sum / (f.channels.length / 3);
    };
    const shot = async (query, box) => { await page.goto(`${url}/?paused&time=10&${query}`); await ready(); return frame(box); };
    const usual = luminance(await shot('view=bow', INTERIOR));
    const pushed = luminance(await shot('view=bow&bowLayers=2&layerSpread=2', INTERIOR));
    assert(pushed < usual * 1.25 + 2, `Bow layers and Layer spread at 200% wash out the bow's interior (mean ${usual.toFixed(1)} -> ${pushed.toFixed(1)})`);
    const ride = (await shot('view=ride', [0, 1, 0, 1])).hash;
    assert.equal((await shot('view=ride&bowLayers=2&layerSpread=2', [0, 1, 0, 1])).hash, ride, 'The bow layers reach into the on-board view');
    assert.deepEqual(errors, []);
    console.log(`PASS: the bow optics change the close-up and restore exactly, still while paused; dispersion moves red and blue (${r.toFixed(2)}, ${b.toFixed(2)}) more than green (${g.toFixed(2)}), red/blue correlation ${plain.correlation.toFixed(2)} -> ${dispersed.correlation.toFixed(2)}; 0% is the frame without it; separate nested arcs (${arcs.glow}, ${arcs.fluid} and ${arcs.space} ridges over 6 rows in glow, fluid and space); the wide nose barely changes (glow ${wide.glow}, space ${wide.space}); at 200% layers and spread the interior stays dark (mean ${usual.toFixed(1)} -> ${pushed.toFixed(1)}) and the on-board view is untouched`);
  } finally {
    await page.close();
  }
}

// The gas reacts to the field: it piles up against the outside of the lower
// surface, the dark interiors stay dark, the reaction is still while paused,
// switching it off (the experiment, or Gas interaction at 0%) gives back
// exactly the frame of the gas that ignores the field, and it streams
// downstream only (to the right in the wide view), never toward the bow.
async function checkGas(browser, url) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 536 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const setRange = (id, value) => page.locator(`#${id}`).evaluate((el, v) => {
    el.value = v; el.dispatchEvent(new Event('input', { bubbles: true }));
  }, String(value));
  // Hash and mean luminance of boxes (top-down fractions of the frame): the
  // gas just under the lower surface and the lower interior of the field.
  const frame = () => page.evaluate(() => {
    window.warp.render();
    const gl = document.querySelector('canvas').getContext('webgl2');
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let hash = 2166136261;
    for (let i = 0; i < px.length; i += 16) hash = Math.imul(hash ^ px[i] ^ (px[i + 1] << 8) ^ (px[i + 2] << 16), 16777619);
    const mean = (x0, x1, y0, y1) => {
      let sum = 0, n = 0;
      for (let y = Math.round(y0 * h); y < Math.round(y1 * h); y++) for (let x = Math.round(x0 * w); x < Math.round(x1 * w); x++) {
        const i = ((h - 1 - y) * w + x) * 4; sum += .2126 * px[i] + .7152 * px[i + 1] + .0722 * px[i + 2]; n++;
      }
      return sum / n;
    };
    return { hash: hash >>> 0, below: mean(.25, .45, .74, .82), interior: mean(.30, .50, .55, .63) };
  });
  try {
    await page.goto(`${url}/?paused&time=10`);
    await page.waitForFunction(() => window.warp && document.getElementById('loading').hidden);
    await page.locator('#effects summary').click();
    const reacting = await frame();
    for (let i = 0; i < 3; i++) assert.equal((await frame()).hash, reacting.hash, 'The gas reaction flickers while paused');
    await page.locator('#gasReacts').uncheck();
    const ignoring = await frame();
    await page.locator('#gasReacts').check();
    await setRange('gas', 0);
    assert.equal((await frame()).hash, ignoring.hash, 'Gas interaction at 0% is not the same as the experiment off');
    await setRange('gas', 1);
    assert.equal((await frame()).hash, reacting.hash, 'Gas interaction did not restore the reaction exactly');
    assert(reacting.below > ignoring.below + 15, `The gas does not pile up under the field (${ignoring.below.toFixed(1)} -> ${reacting.below.toFixed(1)})`);
    assert(reacting.interior < ignoring.interior + 6 && reacting.interior < reacting.below * .3,
      `The gas fills the dark interior (${ignoring.interior.toFixed(1)} -> ${reacting.interior.toFixed(1)})`);
    // Nothing drifts toward the bow: the gas's own light (on minus off) must
    // move to the right (downstream) as the field travels on, in a band below
    // the field and one above it. Every seek past 10 s leaves the fluid in the
    // same state, so only the travelled distance differs between the frames:
    // 1, 2 and 4 units on. The column profiles are high-passed so the broad
    // brightening does not decide the match, only the strands and lumps that
    // move. The search window is a few times the expected shift (2–3 px per
    // unit here), so the match is unambiguous, and the shift must be positive
    // and grow with the distance. This guards the lag and the deflection
    // against future tuning.
    const shifts = await page.evaluate(() => {
      const gl = document.querySelector('canvas').getContext('webgl2');
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const read = () => { window.warp.render(); const px = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
      const react = on => { const el = document.getElementById('gasReacts'); el.checked = on; el.dispatchEvent(new Event('change')); };
      const columns = (a, b, y0, y1) => {
        const col = new Float64Array(w);
        for (let y = Math.round(y0 * h); y < Math.round(y1 * h); y++) for (let x = 0; x < w; x++) {
          const i = ((h - 1 - y) * w + x) * 4; col[x] += a[i] + a[i + 1] + a[i + 2] - b[i] - b[i + 1] - b[i + 2];
        }
        const out = new Float64Array(w);
        for (let x = 0; x < w; x++) {
          let sum = 0, n = 0;
          for (let k = Math.max(0, x - 30); k <= Math.min(w - 1, x + 30); k++) { sum += col[k]; n++; }
          out[x] = col[x] - sum / n;
        }
        return out;
      };
      window.warp.seek(10);
      const velocity = window.warp.state.travel / 10, start = 10 * velocity + .3;
      const bands = [[.74, .97], [.05, .30]];
      const at = travel => {
        window.warp.seek(travel / velocity);
        react(true); const on = read();
        react(false); const off = read();
        react(true);
        return bands.map(([y0, y1]) => columns(on, off, y0, y1));
      };
      const before = at(start);
      const result = bands.map(() => []);
      for (const distance of [1, 2, 4]) {
        const after = at(start + distance);
        const reach = 6 * distance + 2;
        bands.forEach((band, b) => {
          let best = -Infinity, shift = 0;
          for (let s = -reach; s <= reach; s++) {
            let score = 0;
            for (let x = 100; x < w - 100; x++) score += before[b][x] * after[b][x + s];
            if (score > best) { best = score; shift = s; }
          }
          result[b].push(shift);
        });
      }
      window.warp.seek(10);
      return result;
    });
    ['below', 'above'].forEach((band, b) => assert(shifts[b].every(s => s > 0) && shifts[b][2] > shifts[b][0],
      `The gas ${band} the field does not stream downstream (best matches ${shifts[b].join(', ')} px for 1, 2 and 4 units)`));
    assert.deepEqual(errors, []);
    console.log(`PASS: the gas piles up under the field (${ignoring.below.toFixed(0)} -> ${reacting.below.toFixed(0)}), the interior stays dark (${ignoring.interior.toFixed(0)} -> ${reacting.interior.toFixed(0)}), still while paused, off restores the frame exactly, and it streams downstream (${shifts[0].join('/')} px below, ${shifts[1].join('/')} px above for 1/2/4 units)`);
  } finally {
    await page.close();
  }
}

// The film finish: a 2.39:1 letterbox only during the camera sequences on a
// 16:9 screen, grain frozen while paused, and the black floor not lifted.
async function checkFilm(browser, url) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  // A matte row is one flat, dark colour; a picture row is not.
  const matte = () => page.evaluate(() => {
    window.warp.render();
    const gl = document.querySelector('canvas').getContext('webgl2');
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, flat = y => {
      const px = new Uint8Array(w * 4);
      gl.readPixels(0, y, w, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      for (let i = 4; i < px.length; i += 4) if (px[i] !== px[0] || px[i + 1] !== px[1] || px[i + 2] !== px[2]) return false;
      return Math.max(px[0], px[1], px[2]) <= 12;
    };
    return [flat(h - 3), flat(2), flat(h >> 1)];
  });
  const pixels = () => page.evaluate(() => {
    window.warp.render();
    const gl = document.querySelector('canvas').getContext('webgl2');
    const px = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
    gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let hash = 2166136261;
    const levels = [];
    for (let i = 0; i < px.length; i += 4) {
      hash = Math.imul(hash ^ px[i] ^ (px[i + 1] << 8) ^ (px[i + 2] << 16), 16777619);
      levels.push(.2126 * px[i] + .7152 * px[i + 1] + .0722 * px[i + 2]);
    }
    levels.sort((a, b) => a - b);
    return { hash: hash >>> 0, floor: levels[Math.floor(levels.length * .02)] };
  });
  try {
    await page.goto(`${url}/?paused&time=10&view=flyby`);
    await page.waitForFunction(() => window.warp && document.getElementById('loading').hidden);
    assert.deepEqual(await matte(), [true, true, false], 'Flyby at 16:9 is not letterboxed to 2.39:1');
    await page.locator('#effects summary').click();
    await page.locator('#letterbox').uncheck();
    assert.deepEqual(await matte(), [false, false, false], 'Letterbox toggle did not remove the bars');
    await page.locator('[data-view="tracking"]').click();
    const unboxed = await pixels();
    await page.locator('#letterbox').check();
    assert.equal((await pixels()).hash, unboxed.hash, 'Letterbox shown outside the camera sequences');
    // Grain is seeded by simulation time, so a paused frame stays identical.
    for (let i = 0; i < 3; i++) assert.equal((await pixels()).hash, unboxed.hash, 'Film grain flickers while paused');
    // Neither the grade nor the grain may lift the darkest pixels again (the
    // black level is applied once, before the film pass), and the vignette
    // may not push them below Black level's floor either.
    for (const id of ['grain', 'softness', 'focus', 'dust', 'grade', 'vignette']) await page.locator(`#${id}`).evaluate(el => { el.value = 0; el.dispatchEvent(new Event('input', { bubbles: true })); });
    const plain = await pixels();
    assert(unboxed.floor <= plain.floor + 1, `The film pass lifted the black floor: ${plain.floor.toFixed(1)} -> ${unboxed.floor.toFixed(1)}`);
    assert(unboxed.floor >= plain.floor - 2, `The film or vignette dropped the black floor: ${plain.floor.toFixed(1)} -> ${unboxed.floor.toFixed(1)}`);
    assert.deepEqual(errors, []);
    console.log('PASS: film letterbox only in the camera sequences at 16:9, grain still while paused, black floor not lifted');
  } finally {
    await page.close();
  }
}

// The opened panel must fit on short and landscape phones: every control can
// be scrolled to inside the panel, and then lies fully inside the viewport.
export async function checkEffectsLayout(browser, url) {
  const ids = [...SLIDERS, ...TOGGLES, 'letterbox', 'effectsBypass', 'effects-reset', 'effects-off'];
  for (const [width, height] of [[390, 844], [375, 667], [844, 390], [1280, 536]]) {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: width < 700, hasTouch: width < 700 });
    const page = await context.newPage();
    try {
      await page.goto(`${url}/?paused&time=10`);
      await page.waitForFunction(() => window.warp && document.getElementById('loading').hidden);
      await page.locator('#effects summary').click();
      await page.waitForTimeout(150);
      const offscreen = await page.evaluate(ids => {
        const panel = document.querySelector('.effects-panel').getBoundingClientRect();
        const bad = [];
        if (panel.top < 0 || panel.bottom > innerHeight || panel.left < 0 || panel.right > innerWidth) bad.push('panel');
        for (const id of ids) {
          const el = document.getElementById(id);
          el.scrollIntoView({ block: 'nearest' });
          const box = el.getBoundingClientRect(), shown = document.querySelector('.effects-panel').getBoundingClientRect();
          if (box.top < Math.max(0, shown.top) - 1 || box.bottom > Math.min(innerHeight, shown.bottom) + 1 || box.left < 0 || box.right > innerWidth) bad.push(id);
        }
        return bad;
      }, ids);
      assert.deepEqual(offscreen, [], `Effects panel controls out of reach at ${width}x${height}`);
    } finally {
      await context.close();
    }
  }
  console.log('PASS: the opened Effects panel fits and every control is reachable on phone, landscape and desktop sizes');
}

// Lens: a hero source crossing the bow flashes (deterministically, so a paused
// flash is still bit-identical), and the streak bloom carries light sideways
// far beyond the round bloom. The bow camera meets the first hero source at
// the rounded front after 134 fixed steps from time 10 (travel about 905).
export async function checkLens(browser, url) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 536 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const setRange = (id, value) => page.locator(`#${id}`).evaluate((el, v) => {
    el.value = v; el.dispatchEvent(new Event('input', { bubbles: true }));
  }, String(value));
  // Hash of the frame and mean luminance of two boxes (top-down fractions):
  // the bow's nose, and a strip of the flash's row well to its left.
  const frame = () => page.evaluate(() => {
    window.warp.render();
    const gl = document.querySelector('canvas').getContext('webgl2');
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let hash = 2166136261;
    for (let i = 0; i < px.length; i += 16) hash = Math.imul(hash ^ px[i] ^ (px[i + 1] << 8) ^ (px[i + 2] << 16), 16777619);
    const mean = (x0, x1, y0, y1) => {
      let sum = 0, n = 0;
      for (let y = Math.round(y0 * h); y < Math.round(y1 * h); y++) for (let x = Math.round(x0 * w); x < Math.round(x1 * w); x++) {
        const i = ((h - 1 - y) * w + x) * 4; sum += .2126 * px[i] + .7152 * px[i + 1] + .0722 * px[i + 2]; n++;
      }
      return sum / n;
    };
    let peak = 0;
    for (let y = Math.round(.43 * h); y < Math.round(.56 * h); y++) for (let x = Math.round(.37 * w); x < Math.round(.46 * w); x++) {
      const i = ((h - 1 - y) * w + x) * 4; peak = Math.max(peak, .2126 * px[i] + .7152 * px[i + 1] + .0722 * px[i + 2]);
    }
    return { hash: hash >>> 0, nose: mean(.37, .46, .43, .56), side: mean(.05, .28, .47, .51), peak };
  });
  try {
    await page.goto(`${url}/?paused&time=10&view=bow`);
    await page.waitForFunction(() => window.warp && document.getElementById('loading').hidden);
    await page.evaluate(() => window.warp.advance(134 / 60));
    const flash = await frame();
    assert.equal((await frame()).hash, flash.hash, 'The hero flash is not stable while paused');
    await setRange('heroFlares', 0);
    const plain = await frame();
    assert(flash.nose > plain.nose * 1.4 + 6, `The hero source did not flash at the bow (${flash.nose.toFixed(1)} vs ${plain.nose.toFixed(1)})`);
    await setRange('heroFlares', 1);
    assert.equal((await frame()).hash, flash.hash, 'Hero flares did not restore the flash exactly');
    await setRange('streak', 0);
    const unstreaked = await frame();
    assert(flash.side > unstreaked.side + 2, `The streak bloom does not reach sideways (${flash.side.toFixed(1)} vs ${unstreaked.side.toFixed(1)})`);
    assert(flash.nose < 235, `The hero flash glares to white (${flash.nose.toFixed(1)})`);
    // The tone mapping is the only highlight roll-off: the film grade must not
    // add a second shoulder that greys the flash's core.
    await setRange('streak', 1);
    await setRange('grade', 0);
    const ungraded = await frame();
    assert(flash.peak >= ungraded.peak - 6, `The grade dims the hottest highlight (${ungraded.peak.toFixed(0)} -> ${flash.peak.toFixed(0)})`);

    // A flash belongs to the edge crossing the source: brief, never a source
    // riding along a level edge for a second. Watch the wide view for 22 s
    // (every hero passes through it at least once) and time each flash, in a
    // smaller window of the same 2.39:1 shape to keep the 440 frames quick.
    await page.setViewportSize({ width: 720, height: 301 });
    await page.goto(`${url}/?paused&time=10`);
    await page.waitForFunction(() => window.warp && document.getElementById('loading').hidden);
    const flashes = await page.evaluate(() => {
      const events = [], open = [];
      const still = window.warp.heroes.some(hero => hero.flash > 0);
      for (let k = 0; k < 440; k++) {
        window.warp.advance(1 / 20);
        window.warp.heroes.forEach((hero, i) => {
          if (hero.flash > .05) { open[i] ??= { hero: i, start: k, peak: 0 }; open[i].peak = Math.max(open[i].peak, hero.flash); open[i].end = k; }
          else if (open[i]) { events.push(open[i]); open[i] = undefined; }
        });
      }
      return { still, events: [...events, ...open.filter(Boolean)].map(e => ({ ...e, seconds: (e.end - e.start + 1) / 20 })) };
    });
    assert(!flashes.still, 'The default ?paused&time=10 still is mid-flash');
    assert(flashes.events.length > 0, 'No hero source flashed in 22 s of the wide view');
    for (const e of flashes.events) assert(e.seconds <= .3, `Hero ${e.hero} flashed for ${e.seconds.toFixed(2)} s in the wide view`);
    assert.deepEqual(errors, []);
    console.log(`PASS: a hero source flashes at the bow (nose ${plain.nose.toFixed(0)} -> ${flash.nose.toFixed(0)}), stable while paused; the streak reaches sideways (${unstreaked.side.toFixed(1)} -> ${flash.side.toFixed(1)}); wide-view flashes last at most ${Math.max(...flashes.events.map(e => e.seconds)).toFixed(2)} s`);
  } finally {
    await page.close();
  }
}
