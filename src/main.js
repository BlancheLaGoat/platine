// Platine — tes plateformes de musique (lecteurs web officiels) dans une appli desktop stable.
// Build Electron Castlabs = Widevine => qualité max. Une session séparée par plateforme : tu restes connecté partout.
// Si une page crashe ou fige, elle se relance toute seule là où tu étais.

const {
  app, components, BrowserWindow, Tray, Menu, nativeImage, shell, session, ipcMain, dialog, screen, clipboard,
} = require('electron');
const path = require('path');
const fs = require('fs');
const PLATFORMS = require('./platforms');
const discord = require('./discord');
const overlay = require('./overlay-server');
const { OVERLAY_PORT } = require('./config');
const OVERLAY_URL = `http://127.0.0.1:${OVERLAY_PORT}/overlay`;

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
let mini = null;              // fenêtre du mini-lecteur
let pollTimer = null;
let nowPlaying = { title: null, playing: false };
let tray = null;
let quitting = false;
let startHidden = process.argv.includes('--hidden'); // lancé par Windows au démarrage
let crashTimes = [];
let state = { lastUrls: {} };
let updateStatus = '';
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
  if (mini && !mini.isDestroyed()) {
    const [x, y] = mini.getPosition();
    state.mini = { x, y };
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
  const oldVisible = old && !old.isDestroyed() && old.isVisible();
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
      ? {
          session: sessionFor(p),
          preload: path.join(__dirname, 'media-preload.js'),
          contextIsolation: true,
          sandbox: true,
          backgroundThrottling: false,
          plugins: true,
        }
      : { preload: path.join(__dirname, 'picker-preload.js'), contextIsolation: true, sandbox: true },
  });
  current = p ? p.id : null;

  win.once('ready-to-show', () => {
    // Au démarrage de Windows, ou si le mini-lecteur est ouvert, la grande fenêtre reste cachée.
    const keepHidden = (startHidden && p) || (miniOpen() && !oldVisible && p);
    startHidden = false;
    if (!keepHidden) {
      if (state.maximized) win.maximize();
      win.show();
    }
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

  // Raccourcis : Ctrl+Maj+P = écran de choix, Ctrl+Maj+M = mini-lecteur.
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !input.control || !input.shift) return;
    const k = input.key.toLowerCase();
    if (k === 'p') { e.preventDefault(); open(null); }
    if (k === 'm' && p) { e.preventDefault(); toggleMini(); }
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

// ------------------------------------------------------------------
// Mini-lecteur : petite fenêtre toujours au premier plan.
// Les infos viennent de la "Media Session" que chaque site remplit (titre, artiste, pochette),
// donc ça marche sur toutes les plateformes sans code spécifique.
// ------------------------------------------------------------------
const miniOpen = () => !!(mini && !mini.isDestroyed());

function toggleMini() {
  if (miniOpen()) return closeMini(true);
  if (!current) return; // rien à contrôler sur l'écran de choix

  const W = 380, H = 120;
  const area = screen.getPrimaryDisplay().workArea;
  const pos = state.mini || { x: area.x + area.width - W - 24, y: area.y + area.height - H - 24 };

  mini = new BrowserWindow({
    width: W, height: H, x: pos.x, y: pos.y,
    frame: false, resizable: false, maximizable: false, fullscreenable: false,
    alwaysOnTop: true, skipTaskbar: true, show: false,
    backgroundColor: '#111114', title: 'Platine — mini', icon: ICON,
    webPreferences: { preload: path.join(__dirname, 'mini-preload.js'), contextIsolation: true, sandbox: true },
  });
  mini.setAlwaysOnTop(true, 'floating');
  mini.loadFile(path.join(__dirname, 'mini.html'));
  mini.once('ready-to-show', () => mini.showInactive());
  mini.on('moved', saveState);
  mini.on('closed', () => { mini = null; buildTrayMenu(); });
  mini.webContents.once('did-finish-load', () => sendToMini(nowPlaying));

  if (win && !win.isDestroyed()) win.hide();
  buildTrayMenu();
}

function closeMini(showMain) {
  if (miniOpen()) { saveState(); mini.close(); }
  if (showMain) showWin();
}

// ------------------------------------------------------------------
// Suivi de la lecture : une seule lecture par seconde, partagée entre
// le mini-lecteur, Discord et l'overlay OBS.
// ------------------------------------------------------------------
async function poll() {
  const p = current && byId(current);
  let s = null;
  try {
    if (win && !win.isDestroyed() && p) {
      s = await win.webContents.executeJavaScript('window.__platine ? window.__platine.state() : null', true);
    }
  } catch {}
  nowPlaying = {
    title: null, artist: null, album: null, art: null, playing: false, position: null, duration: null,
    ...(s || {}),
    platform: p ? { id: p.id, name: p.name, accent: p.accent, color: p.color } : null,
  };
  sendToMini(nowPlaying);
  discord.update(nowPlaying);
  overlay.update(nowPlaying);
}

function sendToMini(np) {
  if (miniOpen() && !mini.webContents.isLoading()) mini.webContents.send('mini-state', np);
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(poll, 1000);
  poll();
}

ipcMain.on('mini-action', async (_e, action) => {
  if (action === 'expand') return closeMini(true);
  if (action === 'close') return closeMini(false);
  if (!win || win.isDestroyed()) return;
  try {
    await win.webContents.executeJavaScript(`window.__platine && window.__platine.action(${JSON.stringify(action)})`, true);
  } catch {}
  setTimeout(poll, 150);
});

// ------------------------------------------------------------------
// Discord + overlay OBS
// ------------------------------------------------------------------
function setDiscord(on) {
  state.discord = on;
  discord.setEnabled(on);
  saveState();
  buildTrayMenu();
}

async function setOverlay(on) {
  state.overlay = on;
  if (on) {
    const ok = await overlay.start(OVERLAY_PORT);
    if (!ok) {
      state.overlay = false;
      dialog.showMessageBox({
        type: 'warning', title: 'Platine',
        message: `L'overlay OBS n'a pas pu démarrer : le port ${OVERLAY_PORT} est déjà utilisé.`,
        detail: 'Change OVERLAY_PORT dans src/config.js, ou ferme le programme qui utilise ce port.',
      });
    }
  } else {
    overlay.stop();
  }
  saveState();
  buildTrayMenu();
}

// ------------------------------------------------------------------
// Démarrage avec Windows
// ------------------------------------------------------------------
const loginArgs = ['--hidden'];
const startsWithWindows = () => app.getLoginItemSettings({ args: loginArgs }).openAtLogin;
function setStartWithWindows(on) {
  app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args: loginArgs });
  buildTrayMenu();
}

// ------------------------------------------------------------------
// Mises à jour automatiques (depuis les Releases GitHub)
// ------------------------------------------------------------------
let autoUpdater = null;
function setupUpdater() {
  if (!app.isPackaged) return; // pas de mise à jour en mode dev (npm start)
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) { log(`Updater indisponible : ${e}`); return; }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: m => log(`[maj] ${m}`), warn: m => log(`[maj] ${m}`), error: m => log(`[maj] ${m}`), debug() {} };

  const setStatus = s => { updateStatus = s; buildTrayMenu(); };
  autoUpdater.on('checking-for-update', () => setStatus('Recherche de mise à jour…'));
  autoUpdater.on('update-not-available', () => setStatus(''));
  autoUpdater.on('download-progress', p => setStatus(`Téléchargement de la mise à jour… ${Math.round(p.percent)} %`));
  autoUpdater.on('error', err => { log(`[maj] erreur : ${err && err.message}`); setStatus(''); });
  autoUpdater.on('update-downloaded', async info => {
    setStatus(`Mise à jour ${info.version} prête`);
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'Platine',
      message: `La version ${info.version} de Platine est prête.`,
      detail: 'Redémarrer maintenant pour l\'installer ? Sinon elle s\'installera quand tu quitteras Platine.',
      buttons: ['Redémarrer maintenant', 'Plus tard'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) { quitting = true; autoUpdater.quitAndInstall(); }
  });

  const check = () => autoUpdater.checkForUpdates().catch(err => log(`[maj] ${err && err.message}`));
  setTimeout(check, 10_000);               // un peu après le lancement
  setInterval(check, 6 * 60 * 60 * 1000);  // puis toutes les 6 h
}

// ------------------------------------------------------------------
// Icône de la zone de notif
// ------------------------------------------------------------------
function buildTrayMenu() {
  if (!tray) return;
  tray.setToolTip(current ? `Platine — ${byId(current).name}` : 'Platine');
  const template = [
    { label: 'Afficher', click: showWin },
    { label: 'Mini-lecteur', type: 'checkbox', checked: miniOpen(), enabled: !!current, accelerator: 'Ctrl+Shift+M', click: toggleMini },
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
    { type: 'separator' },
    {
      label: discord.available() ? 'Afficher sur Discord' : 'Afficher sur Discord (ID à remplir dans config.js)',
      type: 'checkbox',
      checked: !!state.discord && discord.available(),
      enabled: discord.available(),
      click: item => setDiscord(item.checked),
    },
    {
      label: 'Overlay OBS',
      submenu: [
        { label: 'Activé', type: 'checkbox', checked: overlay.running(), click: item => setOverlay(item.checked) },
        { label: 'Copier le lien pour OBS', enabled: overlay.running(), click: () => clipboard.writeText(OVERLAY_URL) },
        { label: 'Aperçu dans le navigateur', enabled: overlay.running(), click: () => shell.openExternal(`${OVERLAY_URL}?pause=show`) },
      ],
    },
    { type: 'separator' },
    {
      label: 'Lancer au démarrage de Windows',
      type: 'checkbox',
      checked: app.isPackaged && startsWithWindows(),
      enabled: app.isPackaged,
      click: item => setStartWithWindows(item.checked),
    },
    {
      label: updateStatus || `Vérifier les mises à jour (v${app.getVersion()})`,
      enabled: app.isPackaged && !updateStatus,
      click: () => autoUpdater && autoUpdater.checkForUpdates().catch(() => {}),
    },
    { label: 'Ouvrir le journal des crashs', click: () => shell.openPath(logFile()) },
    { type: 'separator' },
    { label: 'Quitter', click: () => { quitting = true; app.quit(); } },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
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
  app.on('second-instance', () => { if (miniOpen()) closeMini(false); showWin(); });

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
    log(`Widevine prêt : ${JSON.stringify(components.status())} — v${app.getVersion()}`);
    loadState();

    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16 }));
    tray.on('click', () => (miniOpen() ? closeMini(true) : showWin()));

    // Premier lancement => écran de choix ; ensuite on rouvre la dernière plateforme.
    open(byId(state.platform) ? state.platform : null);
    setupUpdater();

    discord.setLogger(log);
    overlay.setLogger(log);
    if (state.discord === undefined) state.discord = discord.available(); // activé par défaut si l'ID est rempli
    if (state.discord && discord.available()) discord.setEnabled(true);
    if (state.overlay) await setOverlay(true);
    startPolling();
    buildTrayMenu();
  }).catch(err => log(`Erreur au démarrage : ${err}`));

  app.on('before-quit', () => { quitting = true; saveState(); discord.setEnabled(false); overlay.stop(); });
  app.on('window-all-closed', () => {}); // on reste dans la zone de notif
}

process.on('uncaughtException', err => log(`Exception non gérée : ${err.stack || err}`));
