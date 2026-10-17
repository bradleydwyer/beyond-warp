export const FLYBY_DURATION = 8;

// The scene uses the ship's frame of reference: increasing camera x means
// following the ship towards the left, but falling behind it. Couple the
// screen position and zoom so this relative motion never reverses.
export function flybyCameraAt(seconds, aspect = 1280 / 536) {
  const progress = Math.max(0, Math.min(1, seconds / FLYBY_DURATION));
  const ease = progress ** 3 * (10 - 15 * progress + 6 * progress * progress);
  const fullSpan = Math.max(470, 170 * aspect);
  const openingSpan = Math.max(42, fullSpan * .09);
  const span = openingSpan + (fullSpan - openingSpan) * ease * ease;
  const shipScreenX = .78 - .69 * ease;
  return {
    span,
    x: 5 + span * (.5 - shipScreenX),
    y: 0,
    elevation: .25 + 2.75 * ease,
  };
}
