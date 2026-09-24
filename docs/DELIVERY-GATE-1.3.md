# Forge 1.3 delivery evidence

Direction: the user's dark video studio with blue accent, revised to be friendlier and more expressive. Antislop applied during implementation. Design Read: creator desktop studio, charcoal/blue, Energy 2 / Rhythm 2 / Motion 2. Purpose notes are in DESIGN.md.

## Hard gate: PASS

- R-02, R-17, R-18, R-28, R-36, R-38 PASS: new studio copy has no em dashes, invented statistics/testimonials, generic FAQ or unverified performance promises. AI and compression limitations are visible.
- R-03 PASS: packaged smoke at 390x844 reports no horizontal overflow. Narrow and desktop captures were inspected; the narrow view uses a single scrolling surface.
- R-23, R-24 PASS: the user requested the full redesign and motion. Existing five navigation destinations are retained and exercised. Forge remains a text wordmark; the import frame motif represents footage, not a fabricated logo or person.
- R-25 PASS: measured text/background ratios: body 15.14, secondary 7.83, selected tab 8.38, primary action 9.27, active navigation 8.48, accent control 7.42. Existing semantic status colors remain unchanged.
- R-26, R-27 PASS: controls call actual handlers, with disabled states, inline errors, import/loading feedback and empty states. API failures and invalid-media behavior are regression-tested.
- R-32 PASS: native buttons/selects/ranges/summary controls retain visible focus. Navigation focus is asserted by desktop smoke; no mouse-only editing action was added.
- R-33, R-34, R-37 PASS: UI was authored directly in JSX/CSS patches; no rewrite scripts. The user-selected dark theme and recorded direction are used throughout.
- R-35 PASS: production build and packaged desktop smoke completed; console errors array is empty. The interaction record below states what was exercised.

## Purpose gate: PASS

- R-01, R-07, R-10, R-12, R-13, R-22 PASS: no ambient gradients, background grids, glass panels or invented illustrations. The monitor alone has a modest elevation shadow, separating footage from controls.
- R-04, R-06, R-08, R-09 PASS: existing film/folder/export icons represent actual media actions; Segoe UI preserves Windows reading conventions; numeric workflow markers indicate steps, not marketing badges. No decorative arrow system.
- R-14, R-19 PASS: composition follows monitor, source list, queue and inspector. Brief panel transitions, selection feedback, progress interpolation and completion motion communicate state. Reduced-motion CSS removes animations and transitions.

## Liveliness: PASS

Energy 2 / Rhythm 2 / Motion 2 are implemented through a prominent monitor, varied workspace/inspector/queue proportions and small functional transitions. Blue marks the primary action and selected controls. The repeated frame geometry connects importing and comparing footage. Each other page retains its own content focus under the revised shared shell.

## Craftsmanship and quality locks: PASS

C-1 through C-5 and R-05/11/15/16/20/21/29/30/31: every panel serves an editing or export task; the user-selected theme, limited palette, radius hierarchy, native typography and recorded motion purposes remain consistent. Actions use concrete labels. Models and sample processing are real; no Topaz-parity or platform-quality guarantee is made.

### Interaction record

Packaged evidence: `.test-data/studio-packaged-final/desktop-smoke.json` plus screenshots.

- All five navigation items open their corresponding pages; Settings and Updates captured.
- Import opens a local source preview and export-plan table; preset changes update the plan.
- Smart Auto produces source-based recommendations and a dismissible notice.
- Setup/Detail/Framing tabs switch panels. All framing modes and both stabilization crop settings update controls; manual mode exposes positioning sliders.
- Preset name input, Save and Delete persist the library. Additional-destination checkbox toggles selection.
- AI scale, noise and motion-protection choices, face blend input and RIFE FPS selection change state. Actual model behavior is tested separately.
- Sample export runs real ESRGAN/RIFE; source remains available. Before/after displays two synchronized videos; Play and 2x zoom work. Compression preview produces and displays a real encoded sample; Original returns to the source.
- Pause saves a section boundary; Resume completes the export. Clear finished jobs, log expansion and history removal work.
- Preference/path save and hardware refresh show success. Update save/check/download/install UI actions use controlled fixtures, without running an installer.

### Processing evidence

28 automated tests passed, including a real pause/resume with a fresh job object, unchanged completed-chunk modification time, preserved audio/duration, full decode, shared-source batch ownership and real compression sample range playback. Actual ESRGAN/RIFE smoke passed. `tests/studio-neural.cjs` passed GFPGAN plus neural denoise, face-follow crop, audio/decode and cut-frame replacement. The packaged Python worker independently processed one detected face with both models using only bundled resources.

These checks are on small fixtures. They do not establish full-length 4K performance, exhaustive absence of bugs, universal face detection, or artifact-free enhancement. See STUDIO-1.3.md for the precise shipped scope.
