# Forge 1.2: enhancement for camera footage

Open Optimizer, import a video, select an export preset and expand **Enhance camera footage**.

- **2x / 4x AI detail** uses Real-ESRGAN x4plus, followed by a resize to the selected scale and preset bounds. It can generate plausible detail and may change skin texture. The model processes individual frames; temporal flicker is possible.
- **60 / 120fps AI motion** uses RIFE v4.6. Choose Master 4K120 for 120fps. Motion artifacts can occur around occlusions and cuts; there is no scene-cut detector in this release.
- **Gentle noise reduction** uses FFmpeg's temporal hqdn3d filter. This control is explicitly not described as AI denoising.
- **Export 5-second sample** processes the beginning of the selected clip and leaves its source available for full export. Play the sample in the queue and compare it with the source monitor. Samples use H.264 for in-app playback, including when the full preset uses HEVC.

Enhancement is off by default. Enabled enhancement converts output to BT.709 SDR, including HDR inputs. Disable enhancement to use the original HDR-preserving master workflow. Resolution is fitted to the selected preset, without cropping; aspect ratio is retained. 2x/4x are requested scale factors, not promises to exceed preset bounds.

The two AI engines and selected models are bundled with the desktop build. A compatible Vulkan GPU and driver are needed for Real-ESRGAN. Selecting CPU processing controls the final encoder, not the AI engine. Exporting long high-resolution sequences needs substantial temporary space and time. Forge estimates intermediate image storage and refuses to start if available disk space is insufficient. Temporary frames are cleaned after success, failure and cancellation; a forced OS/process termination can leave a workspace behind.

This is a first enhancement implementation, not feature or quality parity with Topaz. Face recovery, stabilization, AI motion deblur, SDR-to-HDR generation, automatic scene-cut handling and synchronized comparison are not included. No Topaz engine or model is redistributed. TikTok and Instagram still control their playback compression.

## Engines and provenance

Official Real-ESRGAN Windows archive: https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip

SHA256: `abc02804e17982a3be33675e4d471e91ea374e65b70167abc09e31acb412802d`

Official RIFE Windows archive: https://github.com/nihui/rife-ncnn-vulkan/releases/download/20221029/rife-ncnn-vulkan-20221029-windows.zip

SHA256: `d8e4d772d26cd8006ef0ad0bc82eb191b53c68677d1ae2f42506d74cbbbea606`

Packaged paths: `bin/ai/esrgan` (executable, vcomp140.dll, models/realesrgan-x4plus.bin and .param, upstream license/readme) and `bin/ai/rife` (executable, vcomp140.dll, rife-v4.6 model directory, upstream license/readme). These binary folders are excluded from Git; preserve them for local release builds.

## Verification

`npm test` covers valid and rejected plans, portrait bounds and cleanup boundaries alongside existing regression/update tests. `node tests/ai-smoke.cjs` runs actual bundled models, verifies 2x resolution and 120fps with audio and full decode, cancels a running inference, checks cleanup, and exercises queued sample output, source retention and HTTP range playback. Small synthetic clips prove pipeline behavior, not human-face quality or full-length 4K performance.
