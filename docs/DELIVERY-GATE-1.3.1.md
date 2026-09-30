# Forge 1.3.1 delivery evidence

Scope: core processing speed and denoise tiling. The user's existing charcoal/blue studio, Energy 2 / Rhythm 2 / Motion 2, is retained. Antislop remains applied during work; no visual assets, pages or controls were added.

## Hard gate: PASS

Performance claims have measured scope and hardware. No Topaz-parity or platform-quality guarantee is made. Export phases no longer incorrectly say CPU when restoration uses a GPU. Packaged desktop smoke passes with no console errors or narrow-screen overflow. Existing accessible controls and measured contrast are unchanged from the 1.3 delivery record.

## Purpose gate: PASS

No decorative layout or motion changes. The update serves actual export speed, intermediate memory use and denoise seams. Inference remains local; the automatic CPU retry supports a usable export when a GPU driver fails.

## Liveliness: PASS

Existing studio identity and functional motion remain intact. Packaged captures are in `.test-data/core-packaged/desktop/`; no additional animation overhead was introduced.

## Craftsmanship and quality locks: PASS

28 regression tests pass. Actual GPU restoration/denoise/portrait export retains audio and decodes fully. ONNX CPU and GPU outputs pass numerical comparison against upstream FP32 models. Profiling confirms GPU computation. The wider denoise halo is checked against uninterrupted inference across tile boundaries. Independently, the packaged worker processes a detected face and AI denoise on both GPU and CPU using only shipped resources.

Packaged app interaction record: `.test-data/core-packaged/desktop/desktop-smoke.json`. All five navigation destinations, import, local video preview, Smart Auto, studio controls, recipes, synchronized comparison, zoom, compression preview, real ESRGAN/RIFE sample, full export, pause/resume, preferences and update UI fixture actions pass. `errors: []`, `mobileOverflow: false`.

Measurements and remaining limits are in `CORE-1.3.1.md`. Small fixtures do not establish full-length 4K performance or artifact-free human-video quality.
