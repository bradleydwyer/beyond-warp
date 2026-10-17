import assert from 'node:assert/strict';
import { FLYBY_DURATION, flybyCameraAt } from '../src/flyby-sequence.js';

export function checkFlybyPath() {
  for (const aspect of [390 / 844, 1.6, 1280 / 536, 4]) {
    let previous = flybyCameraAt(0, aspect);
    let previousShipX = .5 + (5 - previous.x) / previous.span;
    assert(previousShipX > .75, 'Flyby does not start with the ship on the right');
    for (let i = 1; i <= 800; i++) {
      const pose = flybyCameraAt(i / 800 * FLYBY_DURATION, aspect);
      const shipX = .5 + (5 - pose.x) / pose.span;
      assert(pose.span >= previous.span, 'Flyby zoom reverses');
      assert(pose.x >= previous.x, 'Flyby camera moves ahead of the ship instead of falling behind');
      assert(shipX <= previousShipX, 'Flyby ship reverses screen direction');
      previous = pose;
      previousShipX = shipX;
    }
    const noseX = .5 - previous.x / previous.span;
    const tailX = .5 + (390 - previous.x) / previous.span;
    assert(noseX > .07 && tailX < .93, 'Full field does not fit with room around both tips');
    assert(previous.span / aspect >= 170, 'Wide-aspect view crops the field vertically');
    for (const t of [0, FLYBY_DURATION]) {
      for (const key of ['span', 'x', 'elevation']) {
        const speed = (flybyCameraAt(t + .001, aspect)[key] - flybyCameraAt(t - .001, aspect)[key]) / .002;
        assert(Math.abs(speed) < .001, `Flyby camera has an abrupt start or stop (${key})`);
      }
    }
  }
  console.log('PASS: flyby follows behind the ship, drifts left, and smoothly fits the full field');
}

export async function checkFlybyPlayback(page) {
  const start = await page.evaluate(() => {
    const before = window.warp.state;
    document.querySelector('[data-view="flyby"]').click();
    window.warp.pause();
    return { before, after: window.warp.state, flyby: window.warp.flyby, reference: window.warp.reference };
  });
  assert(start.flyby.active && !start.flyby.finished && start.flyby.time === 0);
  assert(!start.reference.active && start.reference.audioPaused, 'Flyby left reference audio playing');
  for (const key of ['time', 'travel', 'speed', 'turbulence', 'intensity', 'lensing', 'bloom', 'stars', 'appearance', 'ship']) {
    assert.equal(start.after[key], start.before[key], `Flyby changed the ${key} setting`);
  }
  await page.screenshot({ path: 'artifacts/flyby-start.png' });
  await page.waitForTimeout(200);
  assert.deepEqual(await page.evaluate(() => window.warp.flyby), start.flyby, 'Paused flyby camera moved');
  await page.evaluate(() => window.warp.play());
  await page.waitForFunction(() => window.warp.flyby.time > 3.5);
  await page.evaluate(() => window.warp.pause());
  const middle = await page.evaluate(() => window.warp.flyby);
  assert(middle.camera[0] > start.flyby.camera[0] && middle.camera[2] > start.flyby.camera[2]);
  await page.screenshot({ path: 'artifacts/flyby-middle.png' });
  await page.waitForTimeout(200);
  assert.deepEqual(await page.evaluate(() => window.warp.flyby), middle);
  await page.evaluate(() => window.warp.play());
  await page.waitForFunction(() => window.warp.flyby.finished, undefined, { timeout: 15000 });
  const end = await page.evaluate(() => ({ state: window.warp.state, flyby: window.warp.flyby }));
  assert.equal(end.flyby.time, FLYBY_DURATION);
  await page.screenshot({ path: 'artifacts/flyby-end.png' });
  await page.waitForTimeout(400);
  const continuing = await page.evaluate(() => ({ state: window.warp.state, flyby: window.warp.flyby }));
  assert(continuing.state.time > end.state.time + .1 && continuing.state.travel > end.state.travel);
  assert.deepEqual(continuing.flyby.camera, end.flyby.camera, 'Flyby moved after reaching the full-field view');
  await page.locator('[data-view="flyby"]').focus();
  await page.keyboard.press('Enter');
  assert(await page.evaluate(() => window.warp.flyby.active && !window.warp.flyby.finished && window.warp.flyby.time < 1));
  await page.locator('[data-view="bow"]').click();
  assert.equal(await page.evaluate(() => window.warp.flyby.active), false);
  await page.evaluate(() => {
    window.warp.setView('flyby');
    document.getElementById('reference-play').click();
  });
  assert.equal(await page.evaluate(() => window.warp.flyby.active), false, 'Reference replay did not cancel flyby');
  await page.evaluate(() => { window.warp.setView('tracking'); window.warp.pause(); });
  console.log('PASS: flyby settings, pause/resume, continued simulation, replay, and camera cancellation');
}
