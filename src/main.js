'use strict';

const path = require('path');
const fs = require('fs');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  Notification,
  shell,
} = require('electron');
const { buildMenu } = require('./menu');

// ---------------------------------------------------------------------------
// Native media integration.
// Chromium already bridges a page's MediaSession API to the macOS Now Playing
// widget + hardware media keys. Electron ships with those features disabled, so
// re-enable them BEFORE the app is ready. This gives us play/pause/next/prev on
// the keyboard's media keys and a full Control Center widget for ~zero code.
// ---------------------------------------------------------------------------
app.commandLine.appendSwitch(
  'enable-features',
  'HardwareMediaKeyHandling,MediaSessionService'
);

app.setName('YouTube Music');

const YTM_URL = 'https://music.youtube.com/';
// A current desktop-Chrome UA so Google sign-in doesn't reject the Electron UA
// with "this browser or app may not be secure".
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');

let mainWindow = null;
let tray = null;
let pollTimer = null;
let isQuitting = false;
let notificationsEnabled = true;
let lastTrackKey = '';

// --- tiny helpers ----------------------------------------------------------

function debounce(fn, wait) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

const saveState = debounce(() => {
  if (!mainWindow || mainWindow.isMinimized() || mainWindow.isFullScreen()) return;
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(mainWindow.getBounds()));
  } catch {
    /* non-fatal */
  }
}, 400);

function isInternalUrl(url) {
  try {
    const host = new URL(url).hostname;
    return (
      host.endsWith('music.youtube.com') ||
      host.endsWith('youtube.com') ||
      host.endsWith('google.com') ||
      host.endsWith('googleusercontent.com') ||
      host.endsWith('gstatic.com') ||
      host.endsWith('ggpht.com')
    );
  } catch {
    return false;
  }
}

// --- playback control (drives the YT Music player bar) ---------------------

function ytmClick(selector) {
  if (!mainWindow) return;
  mainWindow.webContents
    .executeJavaScript(
      `(() => { const el = document.querySelector(${JSON.stringify(
        selector
      )}); if (el) { el.click(); return true; } return false; })()`,
      true
    )
    .catch(() => {});
}

const playPause = () => ytmClick('#play-pause-button');
const nextTrack = () => ytmClick('.next-button');
const prevTrack = () => ytmClick('.previous-button');

// --- now-playing polling (for notifications + tray tooltip) ----------------
// Runs in the page's main world, so it reads the real MediaSession metadata
// that YouTube Music publishes.

async function pollNowPlaying() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const info = await mainWindow.webContents.executeJavaScript(
      `(() => {
        const ms = navigator.mediaSession;
        const m = ms && ms.metadata;
        if (!m) return null;
        return { title: m.title || '', artist: m.artist || '', album: m.album || '' };
      })()`,
      true
    );
    handleNowPlaying(info);
  } catch {
    /* page not ready yet */
  }
}

function handleNowPlaying(info) {
  if (!info || !info.title) return;
  const key = `${info.title} — ${info.artist}`;
  if (tray) tray.setToolTip(key);
  if (key === lastTrackKey) return;
  lastTrackKey = key;

  const shouldNotify =
    notificationsEnabled &&
    Notification.isSupported() &&
    mainWindow &&
    !mainWindow.isFocused();
  if (shouldNotify) {
    new Notification({
      title: info.title,
      body: info.artist || info.album || '',
      silent: true,
    }).show();
  }
}

// --- tray ------------------------------------------------------------------

function trayIcon() {
  const icon = nativeImage.createFromPath(
    path.join(__dirname, '..', 'assets', 'trayTemplate.png')
  );
  icon.setTemplateImage(true);
  return icon;
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Play / Pause', click: playPause },
      { label: 'Next', click: nextTrack },
      { label: 'Previous', click: prevTrack },
      { type: 'separator' },
      { label: 'Show / Hide', click: toggleWindow },
      {
        label: 'Track notifications',
        type: 'checkbox',
        checked: notificationsEnabled,
        click: (item) => {
          notificationsEnabled = item.checked;
        },
      },
      { type: 'separator' },
      {
        label: 'Quit YouTube Music',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ])
  );
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('YouTube Music');
  tray.on('click', toggleWindow);
  rebuildTrayMenu();
}

// --- main window -----------------------------------------------------------

function createWindow() {
  const state = readState();
  mainWindow = new BrowserWindow({
    width: state.width || 1280,
    height: state.height || 820,
    x: state.x,
    y: state.y,
    minWidth: 500,
    minHeight: 480,
    title: 'YouTube Music',
    backgroundColor: '#030303',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow.webContents.setUserAgent(CHROME_UA);
  mainWindow.loadURL(YTM_URL, { userAgent: CHROME_UA });

  // Popups (e.g. Google sign-in): keep auth flows in-app, send the rest to the
  // system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternalUrl(url)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Top-level navigations to non-YTM sites open in the default browser.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isInternalUrl(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.webContents.on('did-finish-load', () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollNowPlaying, 1500);
    pollNowPlaying();
  });

  mainWindow.on('resize', saveState);
  mainWindow.on('move', saveState);

  // Closing the window hides it (macOS convention); real quit sets isQuitting.
  mainWindow.on('close', (event) => {
    saveState();
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

// --- lifecycle -------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    createTray();
    buildMenu(mainWindow);

    app.on('activate', () => {
      if (mainWindow) {
        mainWindow.show();
      } else {
        createWindow();
      }
    });
  });

  app.on('before-quit', () => {
    isQuitting = true;
    if (pollTimer) clearInterval(pollTimer);
  });

  // Tray app: keep running when the window is closed/hidden.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
