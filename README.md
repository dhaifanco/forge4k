# Forge

A local Windows video studio for preparing TikTok and Instagram Reels exports.

## Download

[Download the latest Windows release](https://github.com/dhaifanco/forge4k/releases/latest).
Choose the latest setup executable to install, or the portable executable to run directly. The runtime, FFmpeg, FFprobe and selected AI models are included.

## Features

- Dark studio workspace with local video preview, source inspection and before/after export specs.
- TikTok and Reels presets, orientation-aware sizing, HDR tone mapping and optional NVIDIA encoding.
- HEVC 4K120 master export when supported by the source. No synthetic frame interpolation.
- Export queue, decode validation, retries and local history.
- Signed GitHub updates and offline update import.
- Real-ESRGAN 2x/4x detail enhancement, RIFE 60/120fps interpolation, gentle temporal noise reduction and playable 5-second samples. [Enhancement guide and limitations](docs/AI-ENHANCEMENT.md).

Platforms still apply their own compression. Forge cannot guarantee lossless TikTok/Instagram playback or 4K120 delivery online.

## Updates

Install 1.1 once. Future published versions appear under Updates. Choose Check for updates, Download update, then Close Forge and install. Updates are not installed silently.

[Publisher guide](docs/UPDATES.md) | [Desktop notes](docs/DESKTOP-RELEASE.md)

## Development

Run `npm ci` and `npm run dev`. For desktop development, run `npm run desktop`.
Place FFmpeg and FFprobe plus their license/readme files in `bin/` before building a standalone application.
Run `npm test`, then `npm run release:win`. Push tested code to main and run `node scripts/publish-release.cjs` to publish a new version. Preserve the private release signing key locally; never commit it.

## Privacy

Video processing and previews stay on the PC. Update checks contact the configured HTTPS release channel. No video is uploaded to GitHub.

## Dependencies

Forge uses Electron, React, Express and FFmpeg. Bundled FFmpeg is the Gyan 9.0.1 full build (GPLv3); its license and build configuration accompany the application. [FFmpeg source revision](https://github.com/FFmpeg/FFmpeg/commit/bf1b838f2a) and [build provider](https://www.gyan.dev/ffmpeg/builds/).
