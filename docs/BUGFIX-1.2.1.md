# Forge 1.2.1 verification

AI detail now processes source frames before interpolation. Intermediate frames are resized before RIFE, and completed stages release scratch files. Noise-only exports use the direct filter path. Stage progress includes frame counts, speed and estimated remaining time.

The fixed synthetic 192x108, 30fps, half-second clip exported at 2x/120fps in 23.064 seconds before and 7.801 seconds after on the development RTX 3060. This single small benchmark is not a full-length 4K performance or visual-quality equivalence claim. Measurements are retained in `.test-data/benchmark-ai`.

Update downloads now request bounded ranges, recover from stalled connections, support cancellation, and verify the entire installer before making it available. Installation blocked by an active export preserves the verified installer for retry. A full published 1.2.0 installer download completed with SHA-512 verification using the repaired downloader.

Other fixes cover invalid media and async API failures, duplicate active exports, staged upload ownership and cleanup, abandoned AI scratch directories, incomplete AI engine detection, HDR classification, and duration/frame-rate parsing.

Validation: 24 automated tests passed. Real-engine smoke tests cover ESRGAN plus RIFE, audio/duration, full output decode, cancellation cleanup, direct noise reduction and sample playback range requests. The packaged 1.2.1 desktop smoke completed an AI sample and subsequent export, visited all five pages, exercised preferences and the simulated update flow, and reported no errors or narrow-layout overflow. Download cancellation is covered by core/manager tests, not a desktop button-click test. Local results and screenshots are retained in `.test-data/packaged-ai-1.2.1`.

## Delivery gate

- Hard gate PASS: existing labelled controls and focus styles are retained; the new cancellation action has tested backend behavior. No unsupported quality claims were introduced.
- Purpose gate PASS: progress explains long-running processing, cancellation stops a transfer, and retry preserves completed work where possible.
- Liveliness PASS: the existing dark studio and blue accent system remains consistent. This maintenance change adds no decorative motion or unrelated assets.
- Functional gate PASS: regression tests, actual neural processing, production packaging and desktop smoke passed as scoped above. Existing design evidence is in `DELIVERY-GATE-1.1.md` and `DELIVERY-GATE-1.2.md`.

Long 4K/120fps neural exports remain expensive. These checks do not establish Topaz parity, exhaustive absence of bugs, or guaranteed quality after social-platform recompression.
