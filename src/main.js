// Platine — tes plateformes de musique (lecteurs web officiels) dans une appli desktop stable.
// Build Electron Castlabs = Widevine => qualité max. Une session séparée par plateforme : tu restes connecté partout.
// Si une page crashe ou fige, elle se relance toute seule là où tu étais.

const { app, components, BrowserWindow, Tray, Menu, nativeImage, shell, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const PLATFORMS = require('./platforms');

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0';
// Pages de connexion tierces autorisées dans une popup (le reste part dans ton navigateur).
const AUTH_DOMAINS = ['accounts.google.com', 'appleid.apple.com', 'idmsa.apple.com', 'facebook.com', 'amazon.fr', 'amazon.com'];

const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const stateFile = () => path.join(app.getPath('userData'), 'state.json');
const logFile = () => path.join(app.getPath('userData'), 'crash.log');

let win = null;
let current = null;           // id de la plateforme affichée, ou null = écran de choix
let tray = null;
let quitting = false;
let crashTimes = [];
let state = { lastUrls: {} };
const configured = new Set();

const byId = id => PLATFORMS.find(p => p.id === id);
const hostOf = url => { try { return new URL(url).hostname; } catch { return ''; } };
const inDomains = (url, domains) => { const h = hostOf(url); return domains.some(d => h === d || h.endsWith('.' + d)); };

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(logFile(), line); } catch {}
  console.log(line.trim());
}

function loadState() {
  try { state = { lastUrls: {}, ...JSON.parse(fs.readFileSync(stateFile(), 'utf8')) }; } catch {}
}

function saveState() {
  if (win && !win.isDestroyed()) {
    Object.assign(state, win.getNormalBounds(), { maximized: win.isMaximized() });
  }
  try { fs.writeFileSync(stateFile(), JSON.stringify(state)); } catch {}
}

// Chaque plateforme a sa propre session (cookies, connexion) qui persiste entre les lancements.
function sessionFor(p) {
  const s = session.fromPartition(`persist:${p.id}`);
  if (configured.has(p.id)) return s;
  configured.add(p.id);

  s.setUserAgent(CHROME_UA);
  s.setPermissionRequestHandler((_wc, perm, cb) => {
    cb(['mediaKeySystem', 'notifications', 'fullscreen', 'clipboard-sanitized-write'].includes(perm));
  });
  // Google bloque les connexions dans les applis Electron : sur ses pages on se présente comme Firefox.
  s.webRequest.onBeforeSendHeaders({ urls: ['*://accounts.google.com/*'] }, (d, cb) => {
    const h = d.requestHeaders;
    h['User-Agent'] = FIREFOX_UA;
    for (const k of Object.keys(h)) if (k.toLowerCase().startsWith('sec-ch-ua')) delete h[k];
    cb({ requestHeaders: h });
  });
  return s;
}

// Ouvre l'écran de choix (id = null) ou une plateforme, dans une nouvelle fenêtre au même endroit.
function open(id) {
  const p = id ? byId(id) : null;
  const old = win;
  if (old && !old.isDestroyed()) saveState();

  win = new BrowserWindow({
    width: state.width || 1280,
    height: state.height || 800,
    x: state.x,
    y: state.y,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: p ? p.color : '#0b0b0d',
    title: p ? `${p.name} — Platine` : 'Platine',
    icon: ICON,
    autoHideMenuBar: true,
    show: false,
    webPreferences: p
      ? { session: sessionFor(p), contextIsolation: true, sandbox: true, backgroundThrottling: false, plugins: true }
      : { preload: path.join(__dirname, 'picker-preload.js'), contextIsolation: true, sandbox: true },
  });
  if (state.maximized) win.maximize();
  current = p ? p.id : null;

  win.once('ready-to-show', () => {
    win.show();
    if (old && !old.isDestroyed()) old.destroy();
  });

  wireWindow(win, p);

  if (p) {
    state.platform = p.id;
    const last = state.lastUrls[p.id];
    win.loadURL(last && inDomains(last, p.domains) ? last : p.url);
  } else {
    win.loadFile(path.join(__dirname, 'picker.html'));
  }
  saveState();
  buildTrayMenu();
}

function wireWindow(w, p) {
  const wc = w.webContents;

  // Ctrl+Maj+P : revenir à l'écran de choix.
  wc.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'p') {
      e.preventDefault();
      open(null);
    }
  });

  w.on('close', e => {
    saveState();
    if (!quitting) { e.preventDefault(); w.hide(); } // la musique continue dans la zone de notif
  });
  w.on('resize', saveState);
  w.on('move', saveState);

  if (!p) return;

  // Mémorise la page en cours pour y revenir après un crash ou au prochain lancement.
  const track = (_e, url) => { if (inDomains(url, p.domains)) state.lastUrls[p.id] = url; };
  wc.on('did-navigate', track);
  wc.on('did-navigate-in-page', track);

  // --- Filets de sécurité ---
  wc.on('render-process-gone', (_e, d) => recover(w, p, `renderer: ${d.reason}`));
  wc.on('unresponsive', () => {
    log(`${p.name} : page figée, on attend 10 s avant de forcer…`);
    setTimeout(() => {
      if (!w.isDestroyed() && !wc.isCrashed()) wc.forcefullyCrashRenderer(); // => render-process-gone
    }, 10_000);
  });
  wc.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) recover(w, p, `chargement raté ${code} ${desc}`);
  });

  // Liens : site de la plateforme ou connexion => popup dans l'appli ; le reste => navigateur.
  wc.setWindowOpenHandler(({ url }) => {
    if (inDomains(url, p.domains) || inDomains(url, AUTH_DOMAINS)) {
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, width: 520, height: 720 } };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// Recharge la page sans tourner en boucle si le site est vraiment HS.
function recover(w, p, reason) {
  const now = Date.now();
  crashTimes = crashTimes.filter(t => now - t < 60_000);
  crashTimes.push(now);
  log(`${p.name} : récupération (${reason}) — ${crashTimes.length} dans la dernière minute`);
  const delay = crashTimes.length > 3 ? 15_000 : 1_000;
  setTimeout(() => {
    if (w.isDestroyed() || current !== p.id) return;
    const last = state.lastUrls[p.id];
    w.webContents.loadURL(last && inDomains(last, p.domains) ? last : p.url).catch(() => {});
  }, delay);
}

function showWin() {
  if (!win || win.isDestroyed()) return open(state.platform || null);
  win.show();
  win.focus();
}

function buildTrayMenu() {
  if (!tray) return;
  tray.setToolTip(current ? `Platine — ${byId(current).name}` : 'Platine');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Afficher', click: showWin },
    {
      label: 'Plateforme',
      submenu: [
        ...PLATFORMS.map(p => ({ label: p.name, type: 'radio', checked: current === p.id, click: () => open(p.id) })),
        { type: 'separator' },
        { label: 'Écran de choix', click: () => open(null) },
      ],
    },
    { label: 'Recharger', click: () => win && !win.isDestroyed() && win.webContents.reload() },
    {
      label: 'Se déconnecter de cette plateforme',
      enabled: !!current,
      click: async () => {
        const p = byId(current);
        await sessionFor(p).clearStorageData();
        delete state.lastUrls[p.id];
        open(p.id);
      },
    },
    { label: 'Ouvrir le journal des crashs', click: () => shell.openPath(logFile()) },
    { type: 'separator' },
    { label: 'Quitter', click: () => { quitting = true; app.quit(); } },
  ]));
}

// --- IPC de l'écran de choix ---
ipcMain.handle('platforms', () => ({
  list: PLATFORMS.map(({ id, name, color, accent, note }) => ({ id, name, color, accent, note })),
  last: state.platform || null,
}));
ipcMain.on('choose', (_e, id) => { if (byId(id)) open(id); });

// Une seule instance : relancer l'appli ramène la fenêtre existante.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWin);

  // Touches multimédia + contrôles Windows (SMTC) => TidalNowPlaying & co continuent de marcher.
  app.commandLine.appendSwitch('enable-features', 'HardwareMediaKeyHandling,MediaSessionService');
  // Coupe les "client hints" qui trahissent Electron auprès de Google.
  app.commandLine.appendSwitch('disable-features', 'UserAgentClientHint');
  app.userAgentFallback = CHROME_UA;

  app.on('child-process-gone', (_e, d) => {
    if (d.type === 'GPU' && d.reason !== 'clean-exit' && win && !win.isDestroyed() && current) {
      recover(win, byId(current), `GPU: ${d.reason}`);
    }
  });

  app.whenReady().then(async () => {
    await components.whenReady(); // module Widevine prêt
    log(`Widevine prêt : ${JSON.stringify(components.status())}`);
    loadState();

    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16 }));
    tray.on('click', showWin);

    // Premier lancement => écran de choix ; ensuite on rouvre la dernière plateforme.
    open(byId(state.platform) ? state.platform : null);
  }).catch(err => log(`Erreur au démarrage : ${err}`));

  app.on('before-quit', () => { quitting = true; saveState(); });
  app.on('window-all-closed', () => {}); // on reste dans la zone de notif
}

process.on('uncaughtException', err => log(`Exception non gérée : ${err.stack || err}`));
