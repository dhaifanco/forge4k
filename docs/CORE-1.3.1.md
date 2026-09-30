# Forge 1.3.1 core processing

This update focuses on restoration speed and denoise seams. It adds no editing features. Forge's processing pipeline uses the same official GFPGANv1.4 and Real-ESRGAN general-x4v3 trained weights as 1.3.0, converted locally to ONNX FP32. It does not train a proprietary model or claim Topaz parity.

## Runtime

Face restoration and denoising use ONNX Runtime DirectML 1.20.1. Automatic processing selects DirectML when available; an initialization or execution failure retries once on CPU with the same model. Selecting the CPU encoder also selects CPU restoration. Explicit backend information and fallback appear in the export log. Telemetry is disabled. Upscaling and interpolation retain the existing Vulkan engines.

The installer contains embedded Python, OpenCV, NumPy, ONNX Runtime and model licenses. Development PyTorch packages and duplicate PTH weights are excluded. No external Python, model downloads or cloud account are required. DirectML compatibility depends on Windows, a DirectX 12 device and its driver. Only the RTX 3060 was tested here; AMD/Intel and dual-adapter selection were not validated. DirectML currently uses the default display adapter.

Reference: https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html

## Reproducible conversion

Run `scripts/setup-studio.ps1` to install pinned development dependencies, verify the two upstream weight hashes, export fixed-batch ONNX models and prepare the small runtime. `scripts/export-studio-onnx.py` uses deterministic GFPGAN noise, ONNX opset 17 and FP32 weights. `scripts/prepare-studio-runtime.cjs` checks the generated hashes before every Windows package build.

| Converted model | SHA-256 |
| --- | --- |
| face.onnx | 9f92bea7c59abc6c442c070a91849673571d25ac8f6987fb8902fbd843ab712f |
| denoise.onnx | aecf19d7de402a6e55d5a3092d96f60dd47e90517b33cff0d25e9615d0c9b4e6 |

## Measurements

Measured locally on an RTX 3060 12 GB, with six CPU inference threads. These are small controlled tests, not full-length 4K export benchmarks or real platform uploads.

| Measurement | Previous CPU path | New GPU path |
| --- | --- | --- |
| One 512x512 GFPGAN inference | 2.211 s | 0.049 s warmed; 2.205 s session initialization |
| One 256x256 denoise tile | 0.710 s | 0.022 s warmed; 0.309 s session initialization |
| Eight 256x256 frames, face strength 0.3 + AI denoise, including Python/model startup and PNG output | 35.634 s | 8.618 s (4.13x faster) |

The stage benchmark uses repeated NASA astronaut QA frames. It excludes video decoding, scaling, interpolation, final encoding and validation. Inference timings must not be presented as whole-export speedups. Models are loaded once per export section, so short sections still pay initialization cost.

GPU versus original FP32 model maximum tensor error: face 0.0000163, denoise 0.0000109. ONNX CPU outputs also pass the numerical comparison. Profiling confirms DirectML execution. The denoiser uses 256x256 tiles with a 34-pixel halo instead of the old 10-pixel overlap, sufficient for its convolution receptive field and output resampling. A 430x378 sample compared against uninterrupted model inference has at most one 8-bit pixel-value difference and mean difference 0.000058 in the interior, including tile boundaries. Reflect padding can change the outer frame border relative to the old zero-padded model. Restoration remains an approximation and can smooth texture or change face details.

PNG intermediates use fast lossless compression. Denoise tiles are reduced to source dimensions before transfer into the output frame, avoiding an entire 4x frame allocation. Source resolution, motion controls, blend strength, audio and export presets retain their existing behavior.

Validation: 28 regression/API/update/checkpoint tests pass; actual GPU face+denoise+portrait export, CPU numerical inference, scene-cut protection, audio and complete decoding pass. Scripts: `tests/benchmark-studio.py`, `tests/benchmark-worker.cjs`, `tests/studio-neural.cjs`. Local measurement records are in `.test-data/studio-gpu-benchmark.json` and `.test-data/core-speed/benchmark.json`.

TikTok, Instagram and other services choose their own delivery compression. Clean source detail and restrained enhancement help, but Forge cannot guarantee uncompressed playback, unchanged faces, or online 4K120 delivery. Use a short preview to check faces, hair, fast motion and texture before exporting the full video.
