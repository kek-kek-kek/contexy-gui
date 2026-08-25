#!/usr/bin/env node
// Contexy desktop shell — splash from disk immediately, then the live server.
const tProc = Date.now();
function boot(msg) { console.log(`[boot] ${msg}  +${Date.now() - tProc}ms`); }
boot('process');

const path = require('path');
const { app, BrowserWindow, shell } = require('electron');
boot('electron-loaded');
const { startServer } = require('./server');
boot('server-module-loaded');

let win = null;
let started = null;

async function listen() {
  try {
    return await startServer(Number(process.env.PORT || 6161));
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') return startServer(0);
    throw err;
  }
}

async function openWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'Contexy',
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: '#eceef2',
    autoHideMenuBar: true,
    show: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.on('closed', () => { win = null; });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  // Paint the logo from disk first so macOS isn't staring at a blank window
  // (that's the rainbow wait cursor) while the local server comes up.
  const splashFile = path.join(__dirname, 'index.html');
  await win.loadFile(splashFile, { hash: 'splash' });
  boot('splash-from-disk');
  if (!started) started = listen();
  const { port } = await started;
  boot('server-listening :' + port);
  await win.loadURL(`http://127.0.0.1:${port}/`);
  boot('live-url');
}

app.setName('Contexy');
app.whenReady().then(() => {
  boot('app.whenReady');
  started = listen();
  return openWindow();
}).catch((err) => {
  console.error(err.stack);
  app.quit();
});

app.on('window-all-closed', () => app.quit());
app.on('activate', () => {
  if (!win) openWindow().catch((err) => console.error(err.stack));
});
