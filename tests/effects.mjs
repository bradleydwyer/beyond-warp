import assert from 'node:assert/strict';

const SLIDERS = ['nebula', 'nebulaDensity', 'nebulaGlow', 'blackLevel', 'interior', 'interiorShrink', 'crestThickness', 'crestLight', 'crestVariation'];

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
}

// The opened panel must fit on short and landscape phones: every control can
// be scrolled to inside the panel, and then lies fully inside the viewport.
export async function checkEffectsLayout(browser, url) {
  const ids = [...SLIDERS, 'energyRim', 'effectsBypass', 'effects-reset', 'effects-off'];
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
