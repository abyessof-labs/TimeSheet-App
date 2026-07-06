const { app, BrowserWindow, ipcMain, dialog, screen, Tray, Menu, nativeImage, powerMonitor, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

// ── Storage ───────────────────────────────────────────────────────────────────
// One JSON file per day in <DATA_DIR>/days/. categories.json for category list.
// DATA_DIR defaults to userData but can be overridden via config.json — e.g.
// pointed at a OneDrive folder to sync data across devices. See Settings tab.

let DATA_DIR, DAYS_DIR, CATS_FILE, CONFIG_FILE;

// The config file always lives in userData (never in the synced folder itself),
// so each machine has its own pointer to wherever the data is.
function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')) || {}; }
  catch { return {}; }
}

function writeConfig(cfg) {
  const tmp = configPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, configPath());
}

// Best-effort guess for the user's OneDrive root (used as a suggestion, never
// selected automatically). Reads OneDrive / OneDriveConsumer / OneDriveCommercial
// env vars set by the OneDrive client on Windows, then falls back to a
// conventional path under the home dir. Returns null if nothing plausible.
function detectOneDriveRoot() {
  const candidates = [
    process.env.OneDrive,
    process.env.OneDriveConsumer,
    process.env.OneDriveCommercial,
    path.join(os.homedir(), 'OneDrive'),
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p; } catch {}
  }
  return null;
}

function defaultDataDir() {
  return app.getPath('userData');
}

// Resolve the data dir from config, falling back to userData. If the configured
// directory doesn't exist yet, we create it (that's the normal case when the
// user picks an empty OneDrive folder for the first time on a new device).
function resolveDataDir() {
  const cfg = readConfig();
  let dir = cfg.dataDir && String(cfg.dataDir).trim();
  if (!dir) dir = defaultDataDir();
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    // If the configured path is unreachable (e.g. OneDrive folder for a
    // different Windows profile), fall back to userData so the app still runs.
    console.error('Data dir unreachable, falling back to userData:', e && e.message);
    dir = defaultDataDir();
  }
  return dir;
}

function initPaths() {
  CONFIG_FILE = configPath();
  DATA_DIR    = resolveDataDir();
  DAYS_DIR    = path.join(DATA_DIR, 'days');
  CATS_FILE   = path.join(DATA_DIR, 'categories.json');
  if (!fs.existsSync(DAYS_DIR)) fs.mkdirSync(DAYS_DIR, { recursive: true });
}

function readDay(date) {
  try { return JSON.parse(fs.readFileSync(path.join(DAYS_DIR, `${date}.json`), 'utf8')); }
  catch { return {}; }
}

function writeDay(date, data) {
  // Strip empty slots before writing
  const clean = {};
  for (const [slot, sides] of Object.entries(data)) {
    const s = {};
    for (const [side, val] of Object.entries(sides)) {
      if (val && (val.cat !== 'none' || val.text)) s[side] = val;
    }
    if (Object.keys(s).length) clean[slot] = s;
  }
  const file = path.join(DAYS_DIR, `${date}.json`);
  if (Object.keys(clean).length) {
    // ponytail: atomic write via rename — safe on NTFS
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(clean), 'utf8');
    fs.renameSync(tmp, file);
  } else {
    try { fs.unlinkSync(file); } catch {}
  }
}

function loadRange(from, to) {
  const result = {};
  try {
    for (const file of fs.readdirSync(DAYS_DIR).sort()) {
      if (!file.endsWith('.json')) continue;
      const date = file.slice(0, -5);
      if (date >= from && date <= to) {
        try { result[date] = JSON.parse(fs.readFileSync(path.join(DAYS_DIR, file), 'utf8')); }
        catch {}
      }
    }
  } catch {}
  return result;
}

const DEFAULT_CATS = [
  { id: 'none',     label: 'None',        color: '#2e3350' },
  { id: 'deep',     label: 'Deep Work',   color: '#3b82f6' },
  { id: 'meetings', label: 'Meetings',    color: '#a855f7' },
  { id: 'admin',    label: 'Admin',       color: '#f97316' },
  { id: 'break',    label: 'Break',       color: '#22c55e' },
  { id: 'personal', label: 'Personal',    color: '#06b6d4' },
  { id: 'exercise', label: 'Exercise',    color: '#ef4444' },
  { id: 'learning', label: 'Learning',    color: '#eab308' },
  { id: 'quoting',  label: 'Quoting',     color: '#0d9488' },
  { id: 'wasted',   label: 'Wasted Time', color: '#991b1b' },
  { id: 'other',    label: 'Other',       color: '#6b7280' },
];

function readCategories() {
  try { return JSON.parse(fs.readFileSync(CATS_FILE, 'utf8')); }
  catch { return DEFAULT_CATS; }
}

function writeCategories(cats) {
  fs.writeFileSync(CATS_FILE, JSON.stringify(cats), 'utf8');
}

// ── Migration from SQLite (v1.1/v1.2) ────────────────────────────────────────
// Runs once on first launch after upgrade. Safe to remove after v1.4.0.
// Always looks in userData — the legacy SQLite DB never lived in a synced
// data dir, so we don't check DATA_DIR here.
function migrateFromSqlite() {
  const dbPath = path.join(app.getPath('userData'), 'timesheet.db');
  if (!fs.existsSync(dbPath) || fs.existsSync(CATS_FILE)) return;
  try {
    const { Database } = require('node-sqlite3-wasm');
    const db = new Database(dbPath);

    const cats = db.prepare('SELECT id, label, color FROM categories ORDER BY sort_order').all();
    if (cats.length) writeCategories(cats);

    const slots = db.prepare('SELECT date, slot_key, side, cat, text FROM slots').all();
    const byDate = {};
    for (const r of slots) {
      if (!byDate[r.date]) byDate[r.date] = {};
      if (!byDate[r.date][r.slot_key]) byDate[r.date][r.slot_key] = {};
      byDate[r.date][r.slot_key][r.side] = { cat: r.cat, text: r.text };
    }
    for (const [date, data] of Object.entries(byDate)) writeDay(date, data);

    db.close();
    fs.renameSync(dbPath, dbPath + '.migrated');
  } catch {} // silently skip — user starts fresh if migration fails
}

// ── Windows ───────────────────────────────────────────────────────────────────

let mainWin = null, reminderWin = null, tray = null, isQuitting = false;

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Timesheet');
  tray.on('click', () => {
    if (mainWin) { mainWin.show(); mainWin.focus(); }
    else createMain();
  });
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Timesheet', click: () => { if (mainWin) { mainWin.show(); mainWin.focus(); } else createMain(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]));
}

function createMain() {
  mainWin = new BrowserWindow({
    width: 1200, height: 900, minWidth: 800, minHeight: 600,
    title: 'Timesheet', backgroundColor: '#0f1117',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    // Start hidden; reveal only once the content is painted to avoid the
    // blank-window flash on launch (Fix A).
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true,
      // Keep renderer timers (e.g. the live now-line) accurate even when the
      // window is hidden/minimized to the tray.
      backgroundThrottling: false,
    },
  });
  mainWin.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWin.once('ready-to-show', () => { mainWin.show(); });
  mainWin.on('close', (e) => {
    if (!isQuitting) { e.preventDefault(); mainWin.hide(); }
  });
  // Each time the window is shown again from the tray, tell the renderer so it
  // can jump back to "today" and re-snap the view to the current time.
  mainWin.on('show', () => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('windowShown');
  });
}

function createReminder(slotKey, slotLabel, plannedData) {
  if (reminderWin) { reminderWin.focus(); return; }
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const W = 360, H = 260;
  reminderWin = new BrowserWindow({
    width: W, height: H, x: sw - W - 16, y: sh - H - 16,
    frame: false, resizable: false, alwaysOnTop: true, skipTaskbar: true,
    backgroundColor: '#1a1d27', show: false, // reveal after paint (Fix A)
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  reminderWin.loadFile(path.join(__dirname, 'src', 'reminder.html'));
  reminderWin.on('closed', () => { reminderWin = null; });
  reminderWin.webContents.once('did-finish-load', () => {
    reminderWin.webContents.send('reminderData', { slotKey, slotLabel, plannedData });
  });
  // Show only once rendered so it appears fully-formed, not blank-then-fill.
  reminderWin.once('ready-to-show', () => { if (reminderWin) reminderWin.show(); });
  setTimeout(() => { if (reminderWin) reminderWin.close(); }, 2 * 60 * 1000);
}

// ── IPC ───────────────────────────────────────────────────────────────────────

ipcMain.handle('loadDay',        (_, date)       => readDay(date));
ipcMain.handle('loadRange',      (_, from, to)   => loadRange(from, to));
ipcMain.handle('saveDay',        (_, date, data) => writeDay(date, data));
ipcMain.handle('loadCategories', ()              => readCategories());
ipcMain.handle('saveCategories', (_, cats)       => writeCategories(cats));

ipcMain.handle('exportData', async (_, from, to) => {
  const { filePath } = await dialog.showSaveDialog(mainWin, {
    title: 'Export CSV',
    defaultPath: `timesheet_${from}_to_${to}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (!filePath) return { cancelled: true };
  const esc   = s => `"${(s||'').replace(/"/g,'""')}"`;
  const lines = ['Date,Time,Side,Category,Text'];
  for (const [date, dayData] of Object.entries(loadRange(from, to)).sort()) {
    for (const [slot_key, sides] of Object.entries(dayData)) {
      for (const [side, val] of Object.entries(sides)) {
        lines.push([date, slot_key, side, val.cat, esc(val.text)].join(','));
      }
    }
  }
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  return { filePath };
});

ipcMain.handle('exportJson', async (_, from, to) => {
  const { filePath } = await dialog.showSaveDialog(mainWin, {
    title: 'Export JSON',
    defaultPath: `timesheet_${from}_to_${to}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (!filePath) return { cancelled: true };
  fs.writeFileSync(filePath, JSON.stringify(loadRange(from, to), null, 2), 'utf8');
  return { filePath };
});

ipcMain.handle('submitReminder', (_, slotKey, cat, text) => {
  const today = todayString();
  const data  = readDay(today);
  if (!data[slotKey]) data[slotKey] = {};
  data[slotKey].actual = { cat: cat || 'none', text: text || '' };
  writeDay(today, data);
  if (mainWin) mainWin.webContents.send('refreshDay');
  if (reminderWin) reminderWin.close();
});

ipcMain.handle('dismissReminder', () => { if (reminderWin) reminderWin.close(); });

// ── Data-location IPC ─────────────────────────────────────────────────────────
// The Settings UI uses these to view and change where days/*.json and
// categories.json live. Changing the location does NOT move existing files —
// the user is expected to copy their days/ folder + categories.json into the
// new location themselves (documented in the Settings hint and README).

ipcMain.handle('getDataInfo', () => {
  return {
    dataDir:       DATA_DIR,
    defaultDir:    defaultDataDir(),
    isDefault:     DATA_DIR === defaultDataDir(),
    oneDriveRoot:  detectOneDriveRoot(),
    daysCount:     (() => { try { return fs.readdirSync(DAYS_DIR).filter(f => f.endsWith('.json')).length; } catch { return 0; } })(),
  };
});

ipcMain.handle('pickDataDir', async () => {
  const suggested = detectOneDriveRoot() || os.homedir();
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWin, {
    title: 'Choose Timesheet data folder',
    defaultPath: suggested,
    properties: ['openDirectory', 'createDirectory'],
    message: 'Pick a folder (e.g. inside OneDrive) where days/ and categories.json will live.',
  });
  if (canceled || !filePaths || !filePaths[0]) return { cancelled: true };
  return { cancelled: false, path: filePaths[0] };
});

ipcMain.handle('setDataDir', async (_, newDir) => {
  if (!newDir || typeof newDir !== 'string') return { ok: false, error: 'Invalid path' };
  try {
    if (!fs.existsSync(newDir)) fs.mkdirSync(newDir, { recursive: true });
    // Write test — makes sure we can actually create files there.
    const testFile = path.join(newDir, '.timesheet-write-test');
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'Cannot write to that folder' };
  }
  const cfg = readConfig();
  cfg.dataDir = newDir;
  writeConfig(cfg);
  // Re-init paths immediately so subsequent reads/writes use the new location
  // (no restart needed for the current session).
  initPaths();
  return { ok: true, dataDir: DATA_DIR };
});

ipcMain.handle('resetDataDir', async () => {
  const cfg = readConfig();
  delete cfg.dataDir;
  writeConfig(cfg);
  initPaths();
  return { ok: true, dataDir: DATA_DIR };
});

ipcMain.handle('openDataDir', () => {
  shell.openPath(DATA_DIR).catch(() => {});
});

// ── Reminders ─────────────────────────────────────────────────────────────────

function todayString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// The quarter-hour that just ended (the block the user should log).
function prevSlotInfo(ref) {
  const now      = ref || new Date();
  const totalMin = now.getHours() * 60 + now.getMinutes();
  const prevMin  = Math.floor(totalMin / 15) * 15 - 15;
  if (prevMin < 0) return null;
  const h = Math.floor(prevMin / 60), m = prevMin % 60;
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return {
    // Unique id for the just-ended quarter, used to avoid double/missed fires.
    qid:   `${todayString()} ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`,
    key:   `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`,
    label: `${h12}:${String(m).padStart(2,'0')} ${h < 12 ? 'AM' : 'PM'}`,
  };
}

// Which quarter-hour boundary are we currently in? (id of the boundary that
// most recently passed). Returns null before the first boundary of the day.
function currentQuarterId() {
  const now      = new Date();
  const totalMin = now.getHours() * 60 + now.getMinutes();
  const qStart   = Math.floor(totalMin / 15) * 15; // start of the quarter we're in now
  const h = Math.floor(qStart / 60), m = qStart % 60;
  return `${todayString()} ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

let lastFiredQuarter = null;

function fireReminder() {
  const slot = prevSlotInfo();
  if (!slot) return;
  const dayData = readDay(todayString());
  createReminder(slot.key, slot.label, (dayData[slot.key] && dayData[slot.key].planned) || null);
}

// Robust, drift-free scheduler.
//
// Instead of a single long-lived 15-minute setInterval (which Chromium throttles
// when the window is in the background and which drifts after sleep/suspend), we
// run a lightweight watchdog every few seconds. Each tick re-reads the wall
// clock: the moment we enter a new quarter-hour we fire exactly once for the
// quarter that just ended. This self-corrects after the machine sleeps, the
// timer is throttled, or the clock changes.
function reminderWatchdog() {
  const qid = currentQuarterId();
  // On first run, seed lastFiredQuarter to the CURRENT quarter so we don't
  // immediately pop a reminder for a block the user is still in.
  if (lastFiredQuarter === null) { lastFiredQuarter = qid; return; }
  if (qid !== lastFiredQuarter) {
    lastFiredQuarter = qid;
    fireReminder();
  }
}

let watchdogTimer = null;
function scheduleReminders() {
  if (watchdogTimer) clearInterval(watchdogTimer);
  reminderWatchdog();                       // seed lastFiredQuarter
  watchdogTimer = setInterval(reminderWatchdog, 10 * 1000); // check every 10s
  // Also re-check immediately when the system wakes from sleep, so a missed
  // boundary fires right away instead of up to 10s later.
  try {
    powerMonitor.on('resume', reminderWatchdog);
    powerMonitor.on('unlock-screen', reminderWatchdog);
  } catch (e) { /* powerMonitor unavailable in some contexts */ }
}

// ── Auto-update ───────────────────────────────────────────────────────────────

function sendUpdateStatus(msg) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('updateStatus', msg);
}

function setupAutoUpdate() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Don't let unhandled errors crash the flow; we report them to the UI instead.
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => sendUpdateStatus('Checking for updates…'));

  autoUpdater.on('update-available', (info) => {
    sendUpdateStatus(`Update found (v${info && info.version ? info.version : '?'}) — downloading…`);
  });

  autoUpdater.on('update-not-available', () => sendUpdateStatus("You're up to date"));

  autoUpdater.on('download-progress', (p) => {
    sendUpdateStatus(`Downloading update… ${Math.round(p.percent || 0)}%`);
  });

  autoUpdater.on('error', (err) => {
    // In dev the app isn't packaged, so updates can't run — say so clearly
    // instead of spinning forever.
    const msg = (err && err.message) ? err.message : String(err);
    if (!app.isPackaged) {
      sendUpdateStatus('Updates only work in the installed app');
    } else {
      sendUpdateStatus('Update check failed — try again later');
    }
    console.error('autoUpdater error:', msg);
  });

  autoUpdater.on('update-downloaded', () => {
    sendUpdateStatus('Update ready — restart to install');
    dialog.showMessageBox(mainWin, {
      type: 'info',
      title: 'Update Ready',
      message: 'A new version of Timesheet has been downloaded. Restart now to install it?',
      buttons: ['Restart', 'Later'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
  });

  // Defer the initial check so it never competes with rendering the window on
  // launch (Fix C). Only meaningful in the packaged app.
  if (app.isPackaged) {
    setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 4000);
  }
}

ipcMain.handle('checkForUpdates', async () => {
  // In dev, electron-updater throws — short-circuit with a clear message.
  if (!app.isPackaged) {
    sendUpdateStatus('Updates only work in the installed app');
    return;
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    sendUpdateStatus('Update check failed — try again later');
  }
});

// ── App lifecycle ─────────────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWin) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus(); }
    else createMain();
  });

  app.whenReady().then(() => {
    initPaths();
    migrateFromSqlite();
    // Get the window on screen first (Fix D) ...
    createTray();
    createMain();
    app.on('activate', () => { if (!mainWin) { mainWin = null; createMain(); } });
    // ... then start background work after the first paint, so it doesn't
    // compete with showing the UI. The reminder watchdog seeds immediately
    // (it only checks the clock), and auto-update is already deferred inside.
    setImmediate(() => {
      scheduleReminders();
      setupAutoUpdate();
    });
  });

  // App stays alive in tray — only quit via tray menu
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => { isQuitting = true; });
}
