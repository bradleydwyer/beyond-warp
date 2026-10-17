# Beyond — warp field study

A real-time WebGL 2 / Three.js interpretation of the side-on warp bubble in [this Star Trek Beyond clip](https://www.youtube.com/watch?v=gCCYWTAA2wQ).

The scene is generated in code: a rounded bow feeding several connected, uneven lobes, background stars that refract through the field, and a small procedural starship. Three appearances are available: luminous fluid, compressed environmental glow, and direct reprojections of the background into three bands. The reference footage is not used by the renderer.

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

- The page opens with the reference camera sequence playing automatically, with sound muted. Use the sound button to unmute during playback, or **Replay reference** to start again with audio. An explicit mute choice is kept for subsequent replays. Reduced-motion preferences, `?paused`, and explicit camera/time URLs skip autoplay.
- **Play reference** replays the original 4.96-second camera pullback with audio from the linked clip. It starts close to the bow, holds its initial framing, then pans and pulls back into the wide wake. The button resets the scene to the reference settings; press it again to replay.
- **Sound** beside that button mutes/unmutes the reference audio. **Space** pauses both camera and sound. Choosing another camera stops the sequence; leaving the tab pauses it. At the end, the camera settles into a wide view with space ahead of the bow, and the simulation keeps running. The audio plays once; use **Replay reference** to repeat the camera move and sound.
- **Tracking** matches the final wide frame: the nose at the left edge, a very small ship, upper lobes, and a broad lower wake.
- **Bow** matches the early close-up, showing the rounded compression front and refracted starlight ahead of the ship. You can open it directly with `?view=bow`.
- **Orbit** supports dragging, scrolling to zoom, and right-dragging to pan.
- **On board** looks forward from inside the bubble.
- **Flyby** starts with the ship on the right, then lets it overtake the tracking camera and drift left while the camera smoothly pulls back over eight seconds. The final view includes the entire field with room around both tips. The simulation keeps running after the camera settles; click **Flyby** again or press **R** to repeat. Settings are preserved, **Space** pauses the move, and another camera cancels it. Use `?view=flyby` to open this preset directly.
- **Field appearance** offers **Fluid glow** (the earlier luminous folds and gas), **Compressed glow** (bands illuminated by surrounding space), and **Compressed space** (the background reprojected along the upper edge, lower edge, and centre stream). Switching preserves the camera, simulation time, and settings; replay keeps the selected appearance. Compressed glow is selected initially; `?appearance=fluid` or `?appearance=space` opens either alternative.
- **Compressed space** reveals two extra controls: **Projection width** adjusts all three image bands from 50–400% (default 200%), and **Edge glow** adds brightness and a soft halo to the outer projections from 0–300% (default 0%). Edge glow uses the projected stars and nebula, leaving the centre stream and general background exposure unchanged. Both settings are retained when changing appearances or replaying a camera move.
- **Warp speed** changes star motion and fluid transport.
- **Turbulence** changes stirring, vorticity, and the thickness of the turbulent wake.
- **Field intensity** controls luminous fluid, concentrated glow, or reprojection visibility according to the selected appearance, independently of **Light bending**. In Compressed glow, **Bloom** also controls how far the glow spreads from the rim and centre stream.
- **Bloom** controls the soft glow, star halos, and horizontal flares from 0–200% (default 65%). At zero, stars keep their sharp motion streaks without the optical glow.
- **Star density** changes the number of streaking and distant stars from 0–200% (default 100%). At zero, only the nebula and field remain. Bloom and star density choices are kept when replaying the reference.
- Turn **Field intensity** to zero to inspect only the background-star distortion. Compare **Light bending** at zero and 100% while paused.
- **Space** pauses; **R** restarts; **H** hides the controls; **F** toggles fullscreen.
- **Save frame** downloads the rendered scene as a PNG without UI.
- Reduced-motion preferences start the scene paused.

## Rendering

`src/fluid.js` implements a GPU fluid solver on a 512 × 256 grid of the shell's axial and angular coordinates. It uses midpoint semi-Lagrangian advection, clamped MacCormack correction for density, counter-rotating forces, vorticity confinement, and a 12-iteration pressure projection. A downstream velocity constraint after forcing and projection prevents ripples from reversing toward the bow while allowing angular rolling. The simulation advances at a fixed 60 Hz. The angular boundary wraps around the shell; the axial boundary has an inlet and outlet. This follows the stable-fluids approach described in [NVIDIA GPU Gems, chapter 38](https://developer.nvidia.com/gpugems/gpugems/part-vi-beyond-triangles/chapter-38-fast-fluid-dynamics-simulation-gpu).

`src/field.js` fits separate upper and lower envelopes to the final decoded reference frame (1280 × 536, approximately 4.92 seconds). Upper crests are near 28%, 51%, and 85% of the frame width. The lower wake is broader and smoother, and the internal fluid band remains near mid-height. The wide camera spans about 260 world units while the procedural ship is about 1.6 units long. The opening close-up spans 24 units. An analytic paraboloid rounds the first ten units of the bow, preserving its curvature when viewed close up.

The envelope is uploaded as two floating-point lookup textures containing heights and derivatives. Shape-preserving cubic interpolation avoids overshoot. Passing environmental density changes each lobe's dimensions and spacing, with downstream sizes kept ordered. Upper and lower contours have different amounts of variation, keeping the total envelope broad through the joins. The rear half of the final lobe is an ellipsoidal cap: both edges meet the centre stream at a shared, rounded tip. The field fades along the last lobe, with the fade interval following its changing dimensions.

In Fluid glow, `src/shaders.js` integrates the shell along adaptively spaced camera-ray samples. Surface displacement, ribbons, and folds come from transported fluid dye. A separate, thin 3D shear layer creates the rolling centre band; its folds and branching threads use that same moving fluid, rather than a fixed line.

Compressed space retains the curved-ray distortion and reprojects the background three times, across the upper edge, lower edge, and centre stream. Each ribbon squeezes a full-height background column into its adjustable width, preserving horizontal alignment so the same stars and nebula features appear in all three copies. Eight filtered samples split the compression footprint, preserving horizontal streak detail without flickering or blurring both dimensions. A modest compression-dependent gain keeps the minified image visible. Optional Edge glow brightens and spreads the light from the two outer images; it does not gather ambient light or add luminous gas. This is an artistic screen-space optical mapping, not a physically traced mirror reflection.

Compressed glow adds concentrated light to those reprojections. A live 64-pixel cube probe captures the same moving stars and nebula in all six directions, allowing off-camera space to illuminate the bands. Broad background samples retain variation along the rim and centre stream. Their glow inherits the incoming light's colour and brightness; black surroundings produce no glow. A soft luminance shoulder limits hot highlights, while Field intensity controls the concentrated light and Bloom controls its halo. The probe is fixed near the bow and approximates illumination across the full field; it is only updated when space changes, and only needed in Compressed glow.

The nebula is a world-space 3D density and colour field. Accumulated ship travel moves it past the ship and through the warp region. The same seeded cloud field drives envelope pressure and fluid stirring. In Fluid glow, it also drives surface luminosity and colour, with extra illumination near the shell and a broader plume below the field. It is not a screen-attached background, and brightness changes follow the clouds moving through the scene.

Large cloud regions vary the coverage and blue, teal, and violet colours. Their shapes distort smaller scales into wisps and dark dust lanes, giving the passing nebula distinct dense and sparse patches without random per-frame flicker.

Stars and nebula share the faster lateral transport seen in the opening shot. Each star's streak length follows its actual velocity and a 28 ms exposure. Filtered HDR cores, soft halos, and the optical bloom produce bright passing streaks while keeping subpixel highlights stable. The larger star volume recycles stars outside the visible frame.

Stars occupy both sides of the field, so reverse orbit views also show passing space. Streaks between the camera and the field's bounds are rendered in a separate foreground pass, after the optical distortion. These near stars stay straight instead of being treated as background light.

The shader also integrates a curved viewing ray through a smooth refractive-index field around the same lobes. It updates the ray direction from the component of `grad(log n)` perpendicular to the ray, and uses the outgoing direction to sample the star background. Smaller surface ripples contribute more gently to the lens than to the visible folds. Lensing works independently of emission, including when field intensity is zero. The ship is composited separately and stays stable.

The general idea of tracing curved rays and filtering the distorted star field is inspired by real-time black-hole renderers, including [Eric Bruneton's beam-tracing renderer](https://ebruneton.github.io/black_hole_shader/). This implementation uses a graded optical index around a fictional warp field; it does not use that renderer's Schwarzschild model or precomputed geodesic tables.

`src/main.js` manages the scene, cameras, render targets, HDR bloom, film optics, tone mapping, antialiasing, and controls. The background target uses multisampling, mipmaps, and a view 1.8 times wider than the visible frame. A second, camera-centred cube capture supplies light beyond that extended view. Rays retain their bending at the screen boundary; there is no viewport-edge distortion fade or offset clamp. The lower-resolution cube fallback is blended only at the outer edge of the extended capture. Full-screen passes explicitly disable depth testing/writing to prevent alternating-frame feedback from reused depth buffers.

`src/ship.js` builds the original stand-in model from geometry, including a saucer, nacelles, hull, windows, and emissive engine strips.

This is an artistic real-time approximation: the fluid solver is 2D flow wrapped through a 3D shell, and curved rays sample an extended background view with a lower-resolution, all-direction cube fallback. It is not a relativistic spacetime solver or a full 3D CFD reconstruction of the movie effect.

## Validation

The browser checks exercise actual GPU rendering, all three field appearances, switching modes without resetting, stars in reverse orbit views, shader compilation, identical paused frames, evolving and sustained fluid flow, variable but ordered lobe sizes, background refraction with the glow disabled, the four static cameras and Flyby preset, quality settings, ship visibility, PNG export, mobile layout, and reduced motion. Controlled black, red, and blue off-camera environments verify the optical glow's source, colour, and controls. A directional sky checks that refraction continues at the viewport boundary; profile checks verify that varying lobes retain a closed rear cap. Flyby checks cover smooth motion, the camera falling behind the ship, full-field framing, pause/resume, and continued simulation after the move. Screenshots are written to the ignored `artifacts/` directory.

For repeatable inspection, `?paused` starts paused and `window.warp` exposes `pause()`, `play()`, `seek(seconds)`, `advance(seconds)`, `setView(name)`, `render()`, and a read-only `fieldShape` snapshot. `seek()` reconstructs up to ten seconds of simulation history; `advance()` runs up to sixty seconds of additional fixed simulation steps.

`src/reference-sequence.js` fits global Bezier curves to camera landmarks measured from the clip. These smooth acceleration through the pullback and settle the camera to a stop in the final framing. During audible playback, the audio clock drives the camera and world travel, so dropped rendering frames cannot accumulate audiovisual drift. Automatic playback starts muted on the animation clock; unmuting seeks the audio to the current position and switches clocks without restarting. After the audio ends, the simulation continues on the animation clock with the camera held wide. If audio cannot load or play, the camera sequence continues silently.

Downloaded reference video/frames and development screenshots are ignored by Git and are not included in the build. The short reference audio track is included separately in `public/audio/`.

## License

Source code: [MIT](LICENSE) © 2026 Brad Dwyer.

The third-party reference audio is excluded from the MIT licence. See [audio provenance](public/audio/README.md).
