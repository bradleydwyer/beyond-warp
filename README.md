# Beyond — warp field study

A real-time WebGL 2 / Three.js interpretation of the side-on warp bubble in [this Star Trek Beyond clip](https://www.youtube.com/watch?v=gCCYWTAA2wQ).

The scene is generated in code: a rounded bow feeding several connected, uneven lobes, continuously flowing blue folds, background stars that refract through the field, and a small procedural starship. The reference footage is not used by the renderer.

## Run

```sh
git clone https://github.com/bradleydwyer/beyond-warp.git
cd beyond-warp
npm ci
npm run dev
```

Open the local URL printed by Vite, normally **http://127.0.0.1:5173/**.

```sh
npm run build       # Static production files in dist/
npm run preview     # Preview the production build
npm test            # Browser / GPU smoke checks
```

Tests use installed Google Chrome, or Playwright Chromium if Chrome is unavailable. To install the latter, run `npx playwright install chromium`. A browser with WebGL 2 and hardware acceleration is required.

## Controls

- **Play reference** replays the original 4.96-second camera pullback with audio from the linked clip. It starts close to the bow, holds its initial framing, then pans and pulls back into the wide wake. The button resets the scene to the reference settings; press it again to replay.
- **Sound** beside that button mutes/unmutes the reference audio. **Space** pauses both camera and sound. Choosing another camera stops the sequence; leaving the tab pauses it. At the end, the camera settles into the final wide view and the simulation keeps running. The audio plays once; use **Replay reference** to repeat the camera move and sound.
- **Tracking** matches the final wide frame: the nose at the left edge, a very small ship, upper lobes, and a broad lower wake.
- **Bow** matches the early close-up, showing the rounded compression front and refracted starlight ahead of the ship. You can open it directly with `?view=bow`.
- **Orbit** supports dragging, scrolling to zoom, and right-dragging to pan.
- **On board** looks forward from inside the bubble.
- **Warp speed** changes star motion and fluid transport.
- **Turbulence** changes stirring, vorticity, and the thickness of the turbulent wake.
- **Field intensity** changes the luminous plasma independently of **Light bending**.
- Turn **Field intensity** to zero to inspect only the background-star distortion. Compare **Light bending** at zero and 100% while paused.
- **Space** pauses; **R** restarts; **H** hides the controls; **F** toggles fullscreen.
- **Save frame** downloads the rendered scene as a PNG without UI.
- Reduced-motion preferences start the scene paused.

## Rendering

`src/fluid.js` implements a GPU fluid solver on a 512 × 256 grid of the shell's axial and angular coordinates. It uses midpoint semi-Lagrangian advection, clamped MacCormack correction for density, counter-rotating forces, vorticity confinement, and a 12-iteration pressure projection. The simulation advances at a fixed 60 Hz. The angular boundary wraps around the shell; the axial boundary has an inlet and outlet. This follows the stable-fluids approach described in [NVIDIA GPU Gems, chapter 38](https://developer.nvidia.com/gpugems/gpugems/part-vi-beyond-triangles/chapter-38-fast-fluid-dynamics-simulation-gpu).

`src/field.js` fits separate upper and lower envelopes to the final decoded reference frame (1280 × 536, approximately 4.92 seconds). Upper crests are near 28%, 51%, and 85% of the frame width. The lower wake is broader and smoother, and the internal fluid band remains near mid-height. The wide camera spans about 260 world units while the procedural ship is about 1.6 units long. The opening close-up spans 24 units. An analytic paraboloid rounds the first ten units of the bow, preserving its curvature when viewed close up.

The envelope is uploaded as two floating-point lookup textures containing heights and derivatives. Shape-preserving cubic interpolation avoids overshoot. Passing environmental density changes each lobe's dimensions and spacing, with downstream sizes kept ordered. Upper and lower contours have different amounts of variation, keeping the total envelope broad through the joins.

`src/shaders.js` integrates the shell along adaptively spaced camera-ray samples. Surface displacement, ribbons, and folds come from transported fluid dye. A separate, thin 3D shear layer creates the rolling centre band; its folds and branching threads use that same moving fluid, rather than a fixed line.

The nebula is a world-space 3D density and colour field. Accumulated ship travel moves it past the ship and through the warp region. The same seeded cloud field drives envelope pressure, fluid stirring, surface luminosity, and colour. Gas near the shell receives extra illumination, with a broader plume below the field. It is not a screen-attached background, and brightness changes follow the clouds moving through the scene.

The shader also integrates a curved viewing ray through a smooth refractive-index field around the same lobes. It updates the ray direction from the component of `grad(log n)` perpendicular to the ray, and uses the outgoing direction to sample the star background. Smaller surface ripples contribute more gently to the lens than to the visible folds. Lensing works independently of emission, including when field intensity is zero. The ship is composited separately and stays stable.

The general idea of tracing curved rays and filtering the distorted star field is inspired by real-time black-hole renderers, including [Eric Bruneton's beam-tracing renderer](https://ebruneton.github.io/black_hole_shader/). This implementation uses a graded optical index around a fictional warp field; it does not use that renderer's Schwarzschild model or precomputed geodesic tables.

`src/main.js` manages the scene, cameras, render targets, HDR bloom, film optics, tone mapping, antialiasing, and controls. The background target uses multisampling and mipmaps to reduce shimmer during distortion. Full-screen passes explicitly disable depth testing/writing to prevent alternating-frame feedback from reused depth buffers.

`src/ship.js` builds the original stand-in model from geometry, including a saucer, nacelles, hull, windows, and emissive engine strips.

This is an artistic real-time approximation: the fluid solver is 2D flow wrapped through a 3D shell, and the curved rays resolve into a screen-space background lookup (off-screen stars cannot be recovered). It is not a relativistic spacetime solver or a full 3D CFD reconstruction of the movie effect.

## Validation

The browser checks exercise actual GPU rendering, shader compilation, identical paused frames, evolving and sustained fluid flow, variable but ordered lobe sizes, background refraction with the glow disabled, all four cameras, quality settings, ship visibility, PNG export, mobile layout, and reduced motion. Screenshots are written to the ignored `artifacts/` directory.

For repeatable inspection, `?paused` starts paused and `window.warp` exposes `pause()`, `play()`, `seek(seconds)`, `advance(seconds)`, `setView(name)`, `render()`, and a read-only `fieldShape` snapshot. `seek()` reconstructs up to ten seconds of simulation history; `advance()` runs up to sixty seconds of additional fixed simulation steps.

`src/reference-sequence.js` fits global Bezier curves to camera landmarks measured from the clip. These smooth acceleration through the pullback and settle the camera to a stop in the final framing. The audio playback clock drives the camera and world travel during the sequence, so dropped rendering frames cannot accumulate audiovisual drift. After the audio ends, the simulation continues on the animation clock with the camera held wide. Audio starts only after an explicit user action. If audio cannot load or play, the camera sequence continues silently.

Downloaded reference video/frames and development screenshots are ignored by Git and are not included in the build. The short reference audio track is included separately in `public/audio/`.

## License

Source code: [MIT](LICENSE) © 2026 Brad Dwyer.

The third-party reference audio is excluded from the MIT licence. See [audio provenance](public/audio/README.md).
