# Forge 1.3 studio

The ten requested additions are implemented as local processing features:

| Feature | Shipped behavior | Boundaries |
| --- | --- | --- |
| Before/after | Two synchronized players, shared scrub, fit/2x/4x zoom | Source codec must be supported by Chromium; zoomed panes can be scrolled |
| Smart Auto | Reads source dimensions and first-five-second luma measurements, suggests scale/denoise and keeps cadence | A transparent heuristic, not a trained quality evaluator or a guarantee |
| AI denoise | Real-ESRGAN `realesr-general-x4v3`, 65% output blend, tiled inference at original size | CPU runtime; can smooth texture and alter detail |
| Face enhancement | GFPGANv1.4 with deterministic noise and feathered strength blend over frontal-face detections | Haar frontal-face crops, not landmark alignment or identity recognition; profile/occluded faces can be missed and generated details can change appearance |
| Motion protection | Pixel-change cut detection; optionally conservative fast-motion detection; replaces risky interpolated frames with nearest source frames | Frame holds trade smoothness for less ghosting; heuristic thresholds can miss or over-detect cuts |
| Pause/resume | Validated five-second export sections on disk; resumes completed sections after reopening | Pauses at a section boundary; restarts unfinished section; remux is not segmented; changed source/settings reject stale checkpoints |
| 9:16 framing | Center, manual horizontal/vertical, or smoothed largest visible frontal-face following | Face-based subject following; no whole-body recognition or subject selection. No face returns toward center |
| Stabilization | FFmpeg deshake plus 5% or 10% border crop | Small shake compensation, not rolling-shutter correction; preview shows the actual result |
| Compression preview | Real five-second H.264 720p encode, CRF 32, capped at 1.5 Mbps | Illustrative heavy compression, not an exact TikTok/Instagram simulator |
| Saved presets / batch destinations | Local preset library, apply to all sources, additional TikTok/Reels/master outputs | Each destination must accept the selected FPS; jobs share source ownership until all finish |

All ten controls are backed by processing or persisted state, not placeholders. Face restoration and denoising add a CPU Python runtime to the standalone distribution. ESRGAN upscale and RIFE remain Vulkan engines. No user footage is uploaded and no model is fetched at runtime.

## Runtime provenance

Build setup is in `scripts/setup-studio.ps1`, with exact package versions in `studio-requirements.txt`. Python is the official 3.11.9 Windows embeddable distribution. The script downloads only the two pinned official model releases and verifies SHA-256 before use:

- GFPGANv1.4: `e2cd4703ab14f4d01fd1383a8a8b266f9a5833dacee8e6a79d3bf21a1b6be5ad`, from https://github.com/TencentARC/GFPGAN/releases/tag/v1.3.0
- Real-ESRGAN general-x4v3: `8dc7edb9ac80ccdc30c3a5dca6616509367f05fbc184ad95b731f05bece96292`, from https://github.com/xinntao/Real-ESRGAN/releases/tag/v0.2.5.0

The BasicSR import compatibility alias lives in the worker, leaving installed upstream package source unchanged. Official licenses and dependency notices remain in the application resources. The Python worker is unpacked outside Electron's ASAR so the external interpreter can execute it.

## Export costs and checkpoints

4K and synthesized 120fps can be expensive. The approximately five-second, frame-aligned boundary limits the amount of unfinished work lost on shutdown but can still take minutes with heavy CPU restoration. Source uploads and checkpoint files remain for paused jobs. Remove a paused job to reclaim its checkpoint data. Social/master exports re-encode independent video sections and encode the original audio once during final assembly, avoiding repeated AAC padding at section boundaries. Choose Lossless Remux when stream copy is the priority. Restoration and tracking reset at section boundaries; inspect critical footage for visible transitions.

This release does not claim Topaz parity, perfect face fidelity, or immunity to platform compression.
