import assert from 'node:assert/strict';

// Controlled lighting verifies the actual GPU path: off-camera space lights
// both ribbons, its colour is preserved, and a black environment emits nothing.
export async function checkOpticalLight(browser, url) {
  const page = await browser.newPage({ viewport: { width: 800, height: 400 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  let tint = 'vec3(0.0)';
  await page.route('**/src/shaders.js*', async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      'gl_FragColor=vec4(col,1.0);',
      `gl_FragColor=vec4(abs(uCameraPosition.z)<.1 ? ${tint} : vec3(0.0),1.0);`,
    );
    await route.fulfill({ response, body });
  });
  const setRange = (id, value) => page.locator(`#${id}`).evaluate((el, v) => {
    el.value = v; el.dispatchEvent(new Event('input', { bubbles: true }));
  }, String(value));
  const readLight = () => page.evaluate(() => {
    window.warp.render();
    const gl = document.querySelector('canvas').getContext('webgl2');
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const pixels = new Uint8Array(w*h*4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const center = [0, 0, 0], rim = [0, 0, 0];
    let sum = 0, max = 0;
    for (let y=0;y<h;y++) for (let x=0;x<w;x++) {
      const i = (y*w+x)*4, distance = Math.abs(y/h-.5);
      for (let c=0;c<3;c++) {
        const v = pixels[i+c]; sum += v; max = Math.max(max, v);
        if (x>w*.15 && x<w*.95) {
          if (distance<.015) center[c] = Math.max(center[c], v);
          if (distance>.06 && distance<.43) rim[c] = Math.max(rim[c], v);
        }
      }
    }
    return { center, rim, max, mean: sum/(w*h*3), glError: gl.getError() };
  });
  try {
    for (const [name, color, channel] of [
      ['black', 'vec3(0.0)', null],
      ['red', 'vec3(.004,0.0,0.0)', 0],
      ['blue', 'vec3(0.0,0.0,.004)', 2],
    ]) {
      tint = color;
      // The black-level lift is a display toe added to the final field image,
      // not light the field emits, so it is switched off for this measurement.
      await page.goto(`${url}/?paused&blackLevel=0`);
      await page.waitForFunction(() => window.warp && document.getElementById('loading').hidden);
      await setRange('stars', 0);
      await page.locator('#ship').uncheck();
      const light = await readLight();
      assert.equal(light.glError, 0);
      if (channel === null) assert(light.max <= 1, 'Black surroundings still produce an optical glow');
      else for (const region of ['center', 'rim']) {
        assert(light[region][channel] > 50, `${name} off-camera light did not illuminate the ${region}`);
        assert(light[region][channel] > light[region][2-channel]*2, `${region} lost the colour of its surroundings`);
      }
    }
    const glowing = await readLight();
    await page.locator('[data-appearance="space"]').click();
    assert((await readLight()).max <= 1, 'Compressed space still adds environmental glow to the reprojected background');
    await page.locator('[data-appearance="glow"]').click();
    await setRange('bloom', 0);
    assert((await readLight()).mean < glowing.mean, 'Bloom did not reduce the optical halo');
    await setRange('intensity', 0);
    assert((await readLight()).max <= 1, 'Field intensity zero did not remove the optical glow');
    assert.deepEqual(errors, []);
    console.log('PASS: rim and centre gather coloured off-camera light; darkness, intensity, and bloom behave correctly');
  } finally {
    await page.close();
  }
}
