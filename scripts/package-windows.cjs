'use strict';
process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL ||= '1';
const { build, Platform, Arch } = require('electron-builder');
require('./prepare-studio-runtime.cjs');
build({ targets: Platform.WINDOWS.createTarget(['portable', 'nsis'], Arch.x64) }).catch(error => { console.error(error); process.exitCode = 1; });
