# Forge 1.2 delivery evidence

The 1.1 design system and its documented contrast checks remain in use. User direction remains dark video studio with blue accent, applied during implementation. Scope of this increment: enhancement controls and sample playback in the existing workspace.

- Hard gate PASS: no new promotional claims, illustrations or navigation. Labelled native selects, keyboard-operable details and buttons use existing focus styles. New options have real plan/render behavior and inline errors. Denoising is explicitly labelled non-AI, and AI limitations are visible. Source changes were applied directly.
- Purpose gate PASS: a collapsible inspector section groups optional enhancement settings; a secondary 5-second sample action allows checking results before full export. The queue's sample player serves the actual completed local output. Rationale is recorded in DESIGN.md.
- Liveliness PASS: existing Energy 2 / Rhythm 2 / Motion 1 and charcoal/blue system preserved; the video monitor remains the focal point. No unrelated animation or visual assets added.
- Functional verification PASS: 17 regression tests, plus actual Real-ESRGAN and RIFE inference on a small synthetic clip. Tests assert 2x dimensions, 120fps, preserved audio/duration, full output decode, cancellation cleanup, source retention and sample range streaming. Desktop smoke exercises each new select, sample export, sample player, and subsequent normal export. Screenshots and results are retained under .test-data.

These checks establish implementation behavior. They do not establish face-restoration quality, Topaz parity or full-length 4K performance. See AI-ENHANCEMENT.md for the shipped scope and known limitations.
