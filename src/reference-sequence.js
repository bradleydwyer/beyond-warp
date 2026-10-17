export const REFERENCE_DURATION = 119 * 1001 / 24000;
export const REFERENCE_ASPECT = 1280 / 536;

// Global Bezier fits to the measured reference framing. Interpolating every
// landmark produced abrupt acceleration changes around 1.9–2.3 seconds.
// A single curve for each channel smooths those small measurement variations
// while retaining the opening hold, overall timing, and exact end framing.
// Repeated final controls bring camera velocity to zero in the wide view.
const spanControls = [13, 13, 37.7918, 88.53085, 108.80815, 112.80337, 260, 260];
const noseControls = [.405, .39849, .57129, .30281, .04683, .14088, 0, 0];
function bezier(controls, t) {
  const points = [...controls];
  for (let n=points.length-1; n>0; n--) {
    for (let i=0; i<n; i++) points[i] += (points[i+1]-points[i])*t;
  }
  return points[0];
}

export function referenceCameraAt(seconds) {
  const time = Math.max(0, Math.min(REFERENCE_DURATION, seconds));
  const progress = time / REFERENCE_DURATION;
  const span = bezier(spanControls, progress), nose = bezier(noseControls, progress);
  // The opening ship sits just above centre, settling to the final midline.
  const settle = Math.min(1, time / 1.5);
  const lineY = .465 + .03 * settle**3*(10-15*settle+6*settle*settle);
  return {
    span,
    x: span * (.5 - nose),
    y: (lineY-.5) * span / REFERENCE_ASPECT,
    elevation: .15 + 2.85 * progress*progress*(3-2*progress),
  };
}
