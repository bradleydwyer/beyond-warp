import assert from 'node:assert/strict';

const SLIDERS = ['nebula', 'nebulaDensity', 'nebulaGlow', 'blackLevel', 'interior', 'interiorShrink', 'crestThickness', 'crestLight', 'crestVariation',
  'streak', 'streakLength', 'streakTint', 'heroFlares', 'starStreaks',
  'grain', 'softness', 'focus', 'dust', 'grade', 'vignette'];

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
      await setRange(id, 0);
      assert.notEqual(await hash(), defaults, `${id} at 0 did not change the frame`);
      await setRange(id, original);
    }
    await page.locator('#energyRim').uncheck();
    assert.notEqual(await hash(), defaults, 'Energy-conserving rim toggle did not change the frame');
    await page.locator('#energyRim').check();
    assert.equal(await hash(), defaults, 'Restoring every effect did not restore the frame');

    for (const id of SLIDERS) await setRange(id, 0);
    await page.locator('#energyRim').uncheck();
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
    assert.equal(await page.locator('#energyRim').isChecked(), false, 'All off left the experiment on');
    assert.equal(await page.locator('#letterbox').isChecked(), false, 'All off left the letterbox on');
    await setRange('crestThickness', 1.4);
    for (const appearance of ['fluid', 'space', 'glow']) await page.locator(`[data-appearance="${appearance}"]`).click();
    await page.locator('#reference-play').click();
    await page.waitForFunction(() => window.warp.reference.time > .1);
    const kept = await page.evaluate(() => [window.warp.state.crestThickness, window.warp.state.nebula, window.warp.state.energyRim]);
    assert.deepEqual(kept, [1.4, 0, false], 'Appearance switches or replay reset the effect controls');
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

    await page.goto(`${url}/?paused&time=10&crestThickness=0.5&energyRim=0`);
    await page.waitForFunction(() => window.warp && document.getElementById('loading').hidden);
    assert.equal(await page.locator('#crestThickness').inputValue(), '0.5', 'URL parameter did not set the slider');
    assert.equal(await page.locator('#energyRim').isChecked(), false, 'URL parameter did not set the toggle');
    assert.deepEqual(errors, []);
    console.log('PASS: effect controls change the frame, restore exactly, bypass and reset in one click, survive appearance switches and replay, and read URL parameters');
  } finally {
    await page.close();
  }
  await checkFilm(browser, url);
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
  const ids = [...SLIDERS, 'energyRim', 'letterbox', 'effectsBypass', 'effects-reset', 'effects-off'];
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
