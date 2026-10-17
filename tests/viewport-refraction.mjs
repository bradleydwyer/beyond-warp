import assert from 'node:assert/strict';

export async function checkViewportRefraction(browser, url) {
  const page = await browser.newPage({ viewport: { width: 800, height: 400 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  // A smooth directional sky isolates bending from moving stars and glow.
  await page.route('**/src/shaders.js*', async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace('gl_FragColor=vec4(col,1.0);',
      'gl_FragColor=vec4(vec3(.04)+.03*sin(ray*vec3(13.0,21.0,17.0)),1.0);');
    await route.fulfill({ response, body });
  });
  const setRange = (id, value) => page.locator(`#${id}`).evaluate((el, v) => {
    el.value = v; el.dispatchEvent(new Event('input', { bubbles: true }));
  }, String(value));
  const edgePixels = () => page.evaluate(() => {
    window.warp.render();
    const gl = document.querySelector('canvas').getContext('webgl2');
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, pixels = new Uint8Array(w*h*4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const edge = [];
    for (let y=30;y<h-30;y++) for (let x=w-2;x<w;x++) for (let c=0;c<3;c++) edge.push(pixels[(y*w+x)*4+c]);
    return edge;
  });
  try {
    await page.goto(`${url}/?paused&view=bow`);
    await page.waitForFunction(() => window.warp && document.getElementById('loading').hidden);
    for (const id of ['stars','intensity','bloom','lensing']) await setRange(id, 0);
    await page.locator('#ship').uncheck();
    const straight = await edgePixels();
    await setRange('lensing', 1);
    const bent = await edgePixels();
    const difference = straight.map((v, i) => Math.abs(v-bent[i]));
    const mean = difference.reduce((sum, v) => sum+v, 0)/difference.length;
    assert(mean > 2, 'Refraction returns to the unbent sky at the viewport edge');
    assert(difference.filter(v => v>5).length/difference.length > .15, 'The close-up field closes at the screen boundary');
    assert.deepEqual(errors, []);
    console.log('PASS: close-up light bending continues through the viewport boundary');
  } finally {
    await page.close();
  }
}
