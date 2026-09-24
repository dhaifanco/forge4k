# Publishing Forge updates

Release channel: https://github.com/dhaifanco/forge4k/releases/latest/download/forge-update.json

## What users do

Install version 1.1.0 once. Version 1.0.0 had no updater, so it cannot discover this first upgrade automatically.

From 1.1.0 onward, open Updates and choose Check for updates, Download update, then Close Forge and install. The application also checks when opened if enabled. It never silently installs an update. Running exports must finish or be cancelled first. The installer keeps user-data files outside the application folder.

For offline PCs, put `forge-update.json` and its matching `Forge-VERSION-setup.exe` in the same folder. Choose Update from a file and select the JSON manifest. The executable is copied into the app cache and verified before the Install button becomes available.

Portable users can use the same update center, but installing an update installs the new version on the PC. It does not overwrite the portable launcher. Continue using the installed app afterward. Public GitHub Releases are required for this public feed; client apps contain no GitHub token.

## What the publisher does for every release

1. Make and test the code changes.
2. Set a new stable version in package.json with `npm version 1.2.0 --no-git-tag-version` (choose the actual next version).
3. Write the changes in `release-notes.txt`.
4. Run `npm test`, then `npm run release:win` on Windows with the FFmpeg binaries in `bin/`.
5. Create a GitHub Release in `dhaifanco/forge4k` using the matching version tag. Upload the new setup executable and `forge-update.json`. The portable executable is optional for new users.
6. Publish it as a normal latest release, not a draft or prerelease. Users checking the configured feed will see it.

After pushing the tested source to main, run `node scripts/publish-release.cjs` to verify the signed installer, upload all three assets to a draft and publish it as the latest release. It refuses to overwrite an existing release tag. Publish the installer and manifest together. Do not edit the manifest by hand after it is signed. Updating code in the repository alone does not create an application release.

## Release key

The trusted public key ships in `desktop/update-public.pem`. The corresponding private key is in `.release-private/update-private.pem` on the publisher's machine, unless FORGE_SIGNING_KEY points elsewhere. Back it up privately. It is excluded from Git and the application package. Never upload it as a release asset, paste it into an issue, or share it with end users. Losing it prevents existing clients from trusting future releases. Rotating the public key requires a migration plan.

Signed manifests bind the installer SHA-512 hash, byte count, application identity, Windows x64 platform and version. This is separate from Windows Authenticode signing; the current installer is still unsigned by Windows.

## Verification scope

Tests cover signed manifests, altered manifests, wrong keys, wrong architecture, path traversal, downgrade handling, HTTPS redirects, corrupted installer cleanup, offline preparation, busy-export blocking and mocked installer launch. Desktop tests cover navigation, import, preview, export planning, completed exports, logs, errors and narrow layout. A real multi-PC upgrade and Windows installer replacement have not been exercised in a clean VM.
