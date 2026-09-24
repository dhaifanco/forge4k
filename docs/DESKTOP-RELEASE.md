# Forge Windows desktop build

## Run

- `release/Forge-1.1.0-portable.exe`: launch without installing.
- `release/Forge-1.1.0-setup.exe`: install for the current Windows user.
- `release/win-unpacked/Forge.exe`: unpacked application. Keep its entire folder together.

The runtime, FFmpeg and FFprobe are bundled. No separate Node.js or FFmpeg install is required. Processing runs locally; no platform account or network upload is included. Windows x64 is the tested build target.

Version 1.1 adds the redesigned studio workspace and signed online/offline updates. See [update publishing](UPDATES.md) and [design/QA evidence](DELIVERY-GATE-1.1.md). The configured GitHub channel requires the first release assets to be published before online checks can succeed.

Data is saved in the application's user-data folder. Existing source-tree settings/history are retained on disk but not automatically imported. Completed exports default to Videos/Forge Optimizer. Interrupted jobs can be retried after restarting; retry starts the export again, not at an intermediate frame.

## Export choices

- TikTok 1080p60 and Instagram Reels HQ preserve a 1080x1920 source. Larger sources fit orientation-aware bounds, without upscaling. Source cadence is retained up to 60fps.
- TikTok 4K60 supports 2160x3840 portrait and 3840x2160 landscape.
- Master 4K120 uses HEVC, preserves HDR where present and caps at 120fps. It does not turn 30/60fps footage into true 120fps or recover missing detail.
- Archive Master keeps source dimensions/cadence in HEVC.
- Lossless Remux copies streams. It cannot improve compressed image detail.

Social presets convert tagged PQ/HLG to SDR with a real tone-mapping filter. Master presets preserve 10-bit HDR. NVIDIA NVENC is used when detected and enabled; CPU encoding is available through Settings. Hardware support still determines practical 4K120 encode speed.

TikTok and Instagram control their own recompression and playback delivery. No zero-compression guarantee is made.

## Verification

- `npm test`: regression coverage for orientation, cadence, codec selection, cleanup ownership, retry ownership, split progress records, active removal and actual HDR/SDR media processing.
- `node tests/api-smoke.cjs`: isolated authenticated API test with a generated 2160x3840 120fps source, batch import, master export, full decode and history verification.
- Desktop `--smoke-test`: hidden startup, bundled binary detection, page navigation and screenshot, saved under `FORGE_DATA_DIR`.
- `npm run dist:win`: build portable executable and installer.

The media tests use short synthetic fixtures. They do not establish long-duration GPU throughput, visual quality on all camera formats, Dolby Vision metadata preservation or post-upload platform quality. No clean-machine VM installation has been performed. This local build is unsigned. See THIRD-PARTY-NOTICES.txt before public redistribution.

## Changes from the reviewed version

Fixed unsafe recursive temp cleanup, portrait downscaling, HDR tone mapping, mismatched encoder selection, frame-rate recommendations, queue removal, retry ownership, progress buffering and cancellable validation. Outputs are validated before final placement; collision-safe placement does not overwrite existing files. Source names survive staging. Queue records persist across restarts. Desktop requests use a per-launch secret and the renderer has no Node access.

The original audit reproduction script was replaced by desired-behavior tests in tests/regression.test.cjs. The old E2E suite remains as historical coverage; it assumes the previous preset count/recommendations and is not the current release gate.
