'use strict';
const { app, BrowserWindow, dialog, session, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
let server, window, closing = false;
const smoke = process.argv.includes('--smoke-test');
if (smoke && process.env.FORGE_DATA_DIR) app.setPath('userData', path.join(process.env.FORGE_DATA_DIR, 'electron-profile'));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
    process.env.FORGE_DATA_DIR = process.env.FORGE_DATA_DIR || path.join(app.getPath('userData'), 'data');
    process.env.FORCE_FFMPEG_DIR = path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'bin');
    process.env.FORGE_API_TOKEN = crypto.randomBytes(32).toString('hex');
    server = await require('../server/index').startServer(0);
    const updater = require('./updates.cjs').createUpdates({ app, dialog, getWindow: () => window,
      busy: () => require('../server/queue').listJobs().some(j => ['waiting', 'processing'].includes(j.state)),
      beforeInstall: () => { closing = true; } });
    require('../server/index').app.locals.updater = updater;
    const origin = 'http://127.0.0.1:' + server.address().port;
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
      if (new URL(details.url).origin !== origin) return callback({ cancel: true });
      details.requestHeaders['X-Forge-Token'] = process.env.FORGE_API_TOKEN;
      callback({ requestHeaders: details.requestHeaders });
    });
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    Menu.setApplicationMenu(null);
    window = new BrowserWindow({ width: 1280, height: 860, minWidth: 900, minHeight: 620, show: !smoke, title: 'Forge Video Optimizer',
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, devTools: !app.isPackaged, backgroundThrottling: !smoke, offscreen: smoke } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== origin) event.preventDefault(); });
    window.on('close', event => {
      const busy = require('../server/queue').listJobs().some(j => ['waiting', 'processing'].includes(j.state));
      if (!closing && busy && dialog.showMessageBoxSync(window, { type: 'question', buttons: ['Keep exporting', 'Stop and close'], defaultId: 0, cancelId: 0, message: 'An export is still running. Stop and close Forge?' }) === 0) event.preventDefault();
    });
    await window.loadURL(origin);
    if (!smoke && updater.snapshot().checkOnStart && updater.snapshot().feedUrl) updater.check().catch(() => {});
    if (smoke) {
      await require('./smoke.cjs')(window, process.env.FORGE_DATA_DIR);
      closing = true; app.quit();
    }
  }).catch(error => { if (!smoke) dialog.showErrorBox('Forge could not start', error.message); console.error(error); app.exit(1); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { closing = true; require('../server/queue').shutdown(); if (server) server.close(); });
}
