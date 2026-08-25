#!/usr/bin/env node
// Contexy desktop shell — one paint of the live local server.
// Electron ready-to-show + matching backgroundColor: no white flash, no
// loadFile-then-loadURL double navigation (that showed fake tiles, then jumped).
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
  if (!started) started = listen();
  const { port } = await started;
  boot('server-listening :' + port);

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'Contexy',
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: '#eceef2',
    autoHideMenuBar: true,
    show: false,
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

  const reveal = () => { if (win && !win.isDestroyed() && !win.isVisible()) win.show(); };
  win.once('ready-to-show', reveal);
  setTimeout(reveal, 1500);

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
