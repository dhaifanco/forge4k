# Forge repository review and desktop direction

Reviewed 24 September 2026. Scope: source review, production frontend build, isolated reproductions, desktop feasibility and video export requirements. This is a review, not a completed desktop release. Application source was not modified; the frontend build regenerated `dist/`.

## Decision

Keep the React interface and Node/FFmpeg processing engine, but fix export correctness and file lifecycle before packaging. A Windows-first Electron application is a practical fit for the existing JavaScript code. Windows is a provisional planning assumption, not a confirmed cross-platform requirement.

Support two distinct outputs:

1. **Master export:** preserve source resolution and frame rate, including 2160x3840/3840x2160 at 120fps when the source and encoder support it. Do not present duplicated frames as added motion detail or upscaling as recovered source detail.
2. **Social export:** platform-specific, orientation-aware output with explicit color management, compatible audio, bounded bitrate and an honest frame-rate policy. Start with 1080x1920 at source cadence up to 60fps, plus optional TikTok 4K experiments. Compare actual uploads before declaring any preset better.

No preset can promise that TikTok or Instagram will never produce visible compression. Upload acceptance, delivered resolution, delivered frame rate and visual quality are different properties.

## Existing foundation

- React/Vite interface with Optimizer, Analyzer, History and Settings.
- Express bound to loopback, FFprobe inspection and FFmpeg subprocess execution.
- Remux and selective re-encoding, NVIDIA NVENC smoke tests, CPU encoding.
- Sequential batch queue, cancel/retry APIs, progress, local history.
- Temporary output followed by decode validation and final placement.

There is no desktop main process, native runtime package, installer configuration or bundled FFmpeg delivery in `package.json`. The existing portable ZIP name does not establish that it contains a standalone desktop runtime; its contents were not assessed in this review.

## Findings, highest priority first

### 1. P1: custom temp-folder cleanup can delete unrelated user directories

Location: `server/store.js:106-128`, called at server startup in `server/index.js`.

`cleanTempDir()` recursively deletes every directory directly under `tempDirEffective`. It does not verify ownership, a job filename pattern or age for directories. For regular files it checks age, but still does not establish that Forge owns them. Settings accepts an arbitrary non-synced folder. Selecting a folder containing other work therefore puts that work at risk at the next startup.

Reproduced with a mocked filesystem: an unrelated directory was passed to recursive deletion despite the 24-hour threshold. No real user files were deleted.

Fix: always create an app-owned subdirectory under a chosen location; verify its resolved path and ownership marker; delete only owned job artifacts with an age/active-job check. Never clean arbitrary directory contents.

### 2. P1: portrait presets discard source resolution

Location: `server/presets.js:66` and `server/presets.js:194`.

The 1080p presets cap literal image height at 1080. A standard 1080x1920 portrait source becomes approximately 608x1080. The 4K preset similarly reduces 2160x3840 portrait video to approximately 1216x2160. This directly undermines the requested TikTok/Reels quality.

Reproduced by calling the planner with 1080x1920 H.264/AAC: it forces video encoding and emits `scale=-2:1080`.

Fix: fit within orientation-aware 1080x1920 / 1920x1080 or 2160x3840 / 3840x2160 bounds, preserve aspect ratio, use even dimensions and avoid unrequested upscaling. Include rotation/display-matrix and sample-aspect-ratio handling.

### 3. P1: HDR-to-SDR conversion does not perform tone mapping

Location: `server/presets.js:197-200`; related encoding branches at `server/presets.js:175-188`.

`sdrConvert` adds `format=yuv420p` and BT.709 tags, but no transfer-function, gamut or luminance conversion. PQ/HLG content can consequently appear dark, washed out or incorrectly colored. The default CPU path also quantizes HDR inputs to 8-bit while retaining HDR tags when SDR conversion is disabled.

Reproduced with a synthetic PQ/BT.2020 probe: the filter is only `scale=-2:1080,format=yuv420p`.

Fix: separate preserve-HDR and convert-to-SDR policies. Implement an actual color pipeline using appropriate FFmpeg `zscale`/`tonemap` or supported equivalent filters. Preserve 10-bit data for HDR output; handle missing metadata explicitly. Validate real PQ, HLG and SDR fixtures visually and through output probing. See [FFmpeg tone-mapping documentation](https://ffmpeg.org/ffmpeg-filters.html#tonemap).

### 4. P1: active-job removal breaks queue listing

Location: `server/queue.js:134`, with failure at `server/queue.js:36`.

After an active job is removed, `pump()` deletes its Map record but leaves its ID in `QUEUE`. `listJobs()` calls `jobSnapshot(undefined)` before its trailing filter can remove the missing record. Subsequent queue requests fail.

Reproduced with a controlled asynchronous probe and no real FFmpeg process.

Fix: remove both references atomically and filter missing records before snapshotting. Keep cancellation, removal and cleanup paths consistent.

### 5. P2: selected H.264 preset can actually produce HEVC

Location: `server/presets.js:115-125`.

For a 10-bit input, `pickEncoder()` prioritizes input bit depth and chooses `hevc_nvenc` even when the selected target requests H.264 with SDR conversion. The advertised codec and actual export therefore disagree.

Reproduced with a 10-bit probe, Reels target and available H.264/HEVC NVENC.

Fix: resolve output color policy and bit depth first, then choose an encoder that meets the resolved target. Unsupported combinations must produce an explicit fallback plan or error, not silently change the target codec.

### 6. P2: 120fps recommendation describes a cap it does not apply

Location: `server/presets.js:274-279`; target definition at `server/presets.js:11-15`.

1080p120 H.264/AAC reaches a recommendation saying it is capped to 60fps, but the returned `tiktok_ultra` preset has no frame-rate limit. Strategy selection then returns stream copy, retaining 120fps.

Reproduced through both recommendation and strategy functions.

Fix: build recommendations from the same resolved export plan used for execution; keep high-frame-rate master profiles separate from platform profiles.

### 7. P2: retry shares staged input ownership with the old job

Location: `server/queue.js:72-73` and `server/queue.js:82-91`.

`retry()` enqueues the same payload/input path. Removing the old failed or cancelled job deletes that input even if the new job is waiting or using it. On Windows, this can fail depending on open handles; removing it before the retry opens the file can prevent the retry from running.

Code-inspection finding. Fix with reference-counted staging ownership, an independent retry input, or transfer of ownership to the new job. Also reject duplicate submission of consumed staging tokens.

### 8. P2: progress blocks are lost across stdout chunks

Location: `server/ffmpeg.js:91`.

The progress key/value object is recreated inside every stdout `data` callback. A progress block split between chunks loses keys from earlier chunks, causing incomplete progress/ETA samples.

Code-inspection finding. Keep both the partial line and current block across callbacks. Test deliberately split writes.

### 9. P2: validation has a fixed two-minute deadline

Location: `server/ffmpeg.js:247`.

Every output receives a complete software decode with a 120-second process timeout. Valid long or demanding 4K120 files can exceed this on slower hardware and be reported as failed. Cancellation also targets the encode child, not the validation process; a cancel during validation can still end in completion.

Code-inspection finding, not a measured performance result. Make validation cancellable, report its phase separately and budget time according to media/workload. Check cancellation again before publishing the final output.

## Other desktop gaps

- Store data relative to the source tree today. Packaged application resources should be immutable; settings/history/queue belong in app user data and video scratch files in an app-owned local folder.
- `data/uploads` is currently inside this OneDrive workspace. This conflicts with the absolute UI claim that nothing is uploaded: Forge sends no video to a remote API, but an external sync client can upload staged files. Native file selection can avoid full source copies and staging should be outside synced directories.
- Queue state is memory-only. Restart loses pending/failed jobs and their relationship to staged inputs.
- File names become staging IDs in probing and output naming; `sourceName` is carried in the queue but not used by `buildOutputName()`.
- Only NVIDIA acceleration is supported; Intel QSV, AMD AMF and macOS VideoToolbox need separate capability detection if required.
- API accepts local executable paths and arbitrary output/temp paths without a desktop trust boundary. For desktop, expose narrow validated IPC, or protect any retained loopback service with a per-launch secret plus Host/Origin checks.
- `open-folder` uses a command shell. Use native desktop folder opening or argument-based spawning.
- Health score is initialized to 100 and never reduced, so it is not a meaningful quality metric.
- Remux strips streams/metadata and rearranges a container; it cannot restore compression detail or prove improved platform delivery.
- README mentions a 4K120 preset that is absent from the current preset list.

## Platform evidence and its limits

Checked on 24 September 2026:

- [TikTok Content Posting API Media Transfer Guide](https://developers.tiktok.com/docs/en/content-posting-api-media-transfer-guide): 23-60fps and dimensions up to 4096 pixels on each axis; H.264 recommended, H.265 also supported. These are API ingest constraints, not guarantees about every manual upload route or viewer playback.
- [Meta's Instagram Reels publishing sample](https://github.com/fbsamples/reels_publishing_apis/blob/main/insta_reels_publishing_api_sample/README.md): 23-60fps, H.264/HEVC, 4:2:0, recommended 9:16 and a stated 25Mbps video ceiling. Use this as an API profile reference and recheck direct API documentation before integrating publishing.
- [Meta engineering on Reels transcoding](https://engineering.fb.com/2023/02/21/video-engineering/av1-codec-facebook-instagram-reels/): the service generates multiple encodings for delivery. It is architectural evidence for recompression, not a current universal resolution limit.

No uploads were made and no claim about post-upload quality was experimentally verified.

## Recommended implementation order

### A. Correctness and safe file handling

Fix findings 1-9. Introduce one resolved export-plan object shared by recommendation, UI, command generation and output verification. Include source/output geometry, color policy, codec, cadence, audio, encoder choice and reasons for re-encoding.

Acceptance: clean portrait 1080p remains 1080x1920; 4K portrait is handled correctly; social export never exceeds its selected frame-rate cap; master preservation does not invent frames; HDR/SDR outputs are visually correct; no cleanup touches unrelated files; retry/removal cannot invalidate other jobs.

### B. Windows desktop package

Use Electron with the existing React UI and a separate processing service/worker. Bundle the runtime plus pinned FFmpeg/FFprobe executables so installation does not require Node, a terminal or an initial download. Keep binaries outside the application archive where needed. Follow [Electron packaging](https://www.electronjs.org/docs/latest/tutorial/application-distribution) and [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security): isolated renderer, no renderer Node integration, sandboxing, restricted navigation and validated IPC.

Add native file/folder selection, app-owned data directories, one running instance, clean shutdown of child processes, collision-safe final output placement and persisted jobs. Provide installer and portable builds. Verify all redistribution notices for the actual bundled binaries before release.

Acceptance: on a clean Windows machine with no Node/FFmpeg installed, launch offline, import a file, export, cancel/retry, restart and reopen output. Test spaces/Unicode paths, another drive, full disk and encoder initialization failure. Signing/release distribution is a later release step, not implied by a successful development build.

### C. Quality tools that address actual footage

Add source/output preview at matched timestamps, crop/pad with safe-area guides, optional mild denoise/deband/sharpen controls and a short sample render before a long export. Keep defaults conservative. Support CPU quality mode and capability-tested GPU speed mode. Evaluate interpolation/upscaling separately with honest labels and hardware estimates.

### D. Post-upload evaluation

With user-provided footage and separately authorized uploads, compare controlled source/export pairs: 1080p vs 4K, 30 vs 60fps, SDR vs HDR where supported, and restrained filtering variants. Inspect delivered playback on more than one device/network after processing finishes. Local PSNR/SSIM/VMAF can assess export damage, but cannot predict a platform's final quality by themselves.

## Verification performed

- `npm.cmd run build`: PASS, 41 modules built. First sandboxed attempt was blocked by parent-directory access; the permitted retry succeeded.
- `node docs/review-repro.cjs`: six existing defects reproduced. This script asserts observed faulty behavior for audit evidence, not desired future behavior. Filesystem deletion and queue processing dependencies are mocked.
- Existing E2E suite reviewed but not executed. It requires a live API, NVIDIA encoding, supplied media, generates a 60-second 4K60 fixture and changes settings/history. It does not cover portrait target dimensions, tone mapping or 4K120 output correctness.
- No UI click-through, full media encode benchmark, clean-machine installer test or post-upload comparison was performed. No claim of desktop readiness or visual quality validation is made.

The immediate release blockers are safe cleanup, portrait dimensions, real color conversion and queue integrity. Desktop packaging should follow those fixes.
