// Platine — tes plateformes de musique (lecteurs web officiels) dans une appli desktop stable.
// Build Electron Castlabs = Widevine => qualité max. Une session séparée par plateforme : tu restes connecté partout.
// Si une page crashe ou fige, elle se relance toute seule là où tu étais.
//
// Fenêtres : chaque fenêtre (« hôte ») contient une barre d'onglets (cachée en mode classique) et une vue par page.
//  - mode classique (par défaut) : une seule page à la fois, changer de plateforme remplace la page, comme avant ;
//  - mode onglets : plusieurs plateformes ouvertes en même temps, chaque onglet peut être détaché dans sa fenêtre.

const {
  app, components, BaseWindow, BrowserWindow, WebContentsView, Tray, Menu, nativeImage, shell, session, ipcMain,
  dialog, screen, clipboard,
} = require('electron');
const path = require('path');
const fs = require('fs');

// Points d'accroche pour les tests automatiques (sans effet en temps normal).
if (process.env.PLATINE_USER_DATA) app.setPath('userData', process.env.PLATINE_USER_DATA);
const PLATFORMS = process.env.PLATINE_PLATFORMS_FILE ? require(process.env.PLATINE_PLATFORMS_FILE) : require('./platforms');

const discord = require('./discord');
const overlay = require('./overlay-server');
const { OVERLAY_PORT } = require('./config');
const accounts = require('./connectors/accounts');
const services = require('./connectors');
const transfer = require('./transfer');
const OVERLAY_URL = `http://127.0.0.1:${OVERLAY_PORT}/overlay`;

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0';
// Pages de connexion tierces autorisées dans une popup (le reste part dans ton navigateur).
const AUTH_DOMAINS = ['accounts.google.com', 'appleid.apple.com', 'idmsa.apple.com', 'facebook.com', 'amazon.fr', 'amazon.com'];

const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const BAR_H = 40;
const stateFile = () => path.join(app.getPath('userData'), 'state.json');
const logFile = () => path.join(app.getPath('userData'), 'crash.log');

let mainHost = null;          // fenêtre principale
const hosts = new Set();      // toutes les fenêtres (principale + détachées)
let nowTab = null;            // onglet dont on affiche la lecture (mini-lecteur, Discord, overlay)
let mini = null;              // fenêtre du mini-lecteur
let playlistsWin = null;      // fenêtre Playlists
let pollTimer = null;
let nowPlaying = { title: null, playing: false };
let tray = null;
let quitting = false;
let startHidden = process.argv.includes('--hidden'); // lancé par Windows au démarrage
let crashTimes = [];
let state = { lastUrls: {} };
let updateStatus = '';
let tabSeq = 0;
const configured = new Set();

const byId = id => PLATFORMS.find(p => p.id === id);
const hostOf = url => { try { return new URL(url).hostname; } catch { return ''; } };
const inDomains = (url, domains) => { const h = hostOf(url); return domains.some(d => h === d || h.endsWith('.' + d)); };
const tabsMode = () => !!state.tabsMode;
const allTabs = () => [...hosts].flatMap(h => h.tabs);
const findTab = pred => allTabs().find(pred);
const alive = t => t && t.view && !t.view.webContents.isDestroyed();

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(logFile(), line); } catch {}
  console.log(line.trim());
}

function loadState() {
  try { state = { lastUrls: {}, ...JSON.parse(fs.readFileSync(stateFile(), 'utf8')) }; } catch {}
}

function saveState() {
  if (mainHost && !mainHost.win.isDestroyed()) {
    Object.assign(state, mainHost.win.getNormalBounds(), { maximized: mainHost.win.isMaximized() });
    // onglets ouverts (toutes fenêtres confondues) pour les rouvrir au prochain lancement
    const list = allTabs().filter(t => t.p);
    state.tabs = list.map(t => ({ id: t.p.id, url: alive(t) ? t.view.webContents.getURL() || null : null }));
    const act = mainHost.active;
    if (act && act.p) { state.platform = act.p.id; state.activeTab = list.indexOf(act); }
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

// La page YouTube/Twitch demande au démarrage si l'anti-pub est actif (voir media-preload.js).
ipcMain.on('platine:adskip', e => { e.returnValue = { on: state.adblock !== false, twitchMode: state.twitchAds || 'vaft' }; });
// Script TwitchAdSolutions (vaft), lu une fois puis gardé en mémoire.
let vaftCode = null;
ipcMain.on('platine:twitch-script', e => {
  if (vaftCode == null) {
    try { vaftCode = fs.readFileSync(path.join(__dirname, 'vendor', 'twitch-vaft.js'), 'utf8'); }
    catch (err) { log(`[twitch] script vaft introuvable : ${err.message}`); vaftCode = ''; }
  }
  e.returnValue = vaftCode;
});

// Mode anti-pub Twitch : 'vaft' (bloquer, TwitchAdSolutions) ou 'mute' (couper le son et masquer).
function setTwitchAds(mode) {
  state.twitchAds = mode;
  saveState();
  for (const t of allTabs()) if (t.p && t.p.id === 'twitch' && alive(t)) t.view.webContents.reload();
  buildTrayMenu();
}

// Active / coupe l'anti-pub sur YouTube, YouTube Music et Twitch.
async function setAdblock(on) {
  state.adblock = on;
  saveState();
  for (const t of allTabs()) if (t.p && t.p.adblock && alive(t)) t.view.webContents.reload();
  buildTrayMenu();
}

// ------------------------------------------------------------------
// Fenêtres et onglets
// ------------------------------------------------------------------
class Host {
  constructor({ main, bounds }) {
    this.main = main;
    this.tabs = [];
    this.active = null;
    this.fullscreenTab = null;
    this.win = new BaseWindow({
      width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y,
      minWidth: 640, minHeight: 420,
      backgroundColor: '#0b0b0d', title: 'Platine', icon: ICON, autoHideMenuBar: true, show: false,
    });
    this.bar = new WebContentsView({
      webPreferences: { preload: path.join(__dirname, 'tabs-preload.js'), contextIsolation: true, sandbox: true },
    });
    this.bar.setBackgroundColor('#0b0b0d');
    this.bar.webContents.loadFile(path.join(__dirname, 'tabs.html'));
    this.bar.webContents.on('did-finish-load', () => this.updateBar());
    this.bar.webContents.on('before-input-event', (e, input) => shortcut(e, input, this));
    this.win.contentView.addChildView(this.bar);

    this.win.on('resize', () => { this.layout(); if (this.main) saveState(); });
    this.win.on('move', () => { if (this.main) saveState(); });
    this.win.on('focus', () => { if (this.active && alive(this.active)) this.active.view.webContents.focus(); });
    this.win.on('close', e => {
      if (this.main) {
        saveState();
        if (!quitting) { e.preventDefault(); this.win.hide(); } // la musique continue dans la zone de notif
        return;
      }
      // fenêtre détachée : on ferme ses onglets avec elle
      for (const t of [...this.tabs]) destroyTab(t);
    });
    this.win.on('closed', () => {
      hosts.delete(this);
      if (this.main) mainHost = null;
      buildTrayMenu();
    });
    hosts.add(this);
    this.layout();
  }

  barVisible() { return (tabsMode() || !this.main) && !this.fullscreenTab; }

  layout() {
    if (this.win.isDestroyed()) return;
    const { width, height } = this.win.getContentBounds();
    const barH = this.barVisible() ? BAR_H : 0;
    this.bar.setVisible(barH > 0);
    this.bar.setBounds({ x: 0, y: 0, width, height: BAR_H });
    for (const t of this.tabs) t.view.setBounds({ x: 0, y: barH, width, height: Math.max(0, height - barH) });
  }

  add(tab, { activate = true, index } = {}) {
    tab.host = this;
    this.win.contentView.addChildView(tab.view);
    if (index == null || index < 0 || index > this.tabs.length) this.tabs.push(tab);
    else this.tabs.splice(index, 0, tab);
    this.layout();
    if (activate || !this.active) this.activate(tab);
    else { tab.view.setVisible(false); this.updateBar(); }
  }

  // Retire l'onglet de cette fenêtre sans le détruire (pour le déplacer).
  take(tab) {
    const i = this.tabs.indexOf(tab);
    if (i < 0) return -1;
    this.tabs.splice(i, 1);
    if (this.fullscreenTab === tab) this.exitFullscreen();
    try { this.win.contentView.removeChildView(tab.view); } catch {}
    if (this.active === tab) {
      this.active = null;
      const next = this.tabs[i] || this.tabs[i - 1];
      if (next) this.activate(next);
    }
    this.updateBar();
    return i;
  }

  activate(tab) {
    if (!tab || this.tabs.indexOf(tab) < 0) return;
    this.active = tab;
    for (const t of this.tabs) t.view.setVisible(t === tab);
    if (!this.win.isDestroyed()) {
      this.win.setTitle(tab.p ? `${tab.p.name} — Platine` : 'Platine');
      this.win.setBackgroundColor(tab.p ? tab.p.color : '#0b0b0d');
    }
    if (alive(tab) && this.win.isVisible()) tab.view.webContents.focus();
    this.updateBar();
    if (this.main) saveState();
    buildTrayMenu();
  }

  enterFullscreen(tab) {
    this.fullscreenTab = tab;
    this.win.setFullScreen(true);
    this.layout();
  }

  exitFullscreen() {
    this.fullscreenTab = null;
    if (!this.win.isDestroyed()) { this.win.setFullScreen(false); this.layout(); }
  }

  updateBar() {
    if (this.bar.webContents.isDestroyed() || this.bar.webContents.isLoading()) return;
    this.bar.webContents.send('tabs:state', {
      main: this.main,
      tabsMode: tabsMode(),
      active: this.active ? this.active.key : null,
      tabs: this.tabs.map(t => ({
        key: t.key,
        name: t.p ? tabName(t) : 'Nouvel onglet',
        platform: t.p ? t.p.name : null,
        accent: t.p ? t.p.accent : '#8d8d97',
        picker: !t.p,
        audible: alive(t) && t.view.webContents.isCurrentlyAudible(),
        muted: alive(t) && t.view.webContents.isAudioMuted(),
      })),
    });
  }

  show() {
    if (this.win.isDestroyed()) return;
    if (this.main && state.maximized && !this.win.isVisible()) this.win.maximize();
    this.win.show();
    this.win.focus();
  }
}

// Nom affiché dans l'onglet : le titre de la page (vidéo, chaîne) pour YouTube/Twitch, sinon le nom de la plateforme.
function tabName(t) {
  if (!t.p.multi || !t.title) return t.p.name;
  const clean = t.title.replace(/\s*[-–|]\s*(YouTube|Twitch|SoundCloud)\s*$/i, '').replace(/^\(\d+\)\s*/, '').trim();
  return clean && clean.toLowerCase() !== t.p.name.toLowerCase() ? clean : t.p.name;
}

function createMainHost() {
  mainHost = new Host({
    main: true,
    bounds: { width: state.width || 1280, height: state.height || 800, x: state.x, y: state.y },
  });
  return mainHost;
}

// Crée un onglet : une plateforme (p) ou l'écran de choix (p = null).
function createTab(p, url) {
  const view = new WebContentsView({
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
  view.setBackgroundColor(p ? p.color : '#0b0b0d');
  const tab = { key: `t${++tabSeq}`, p, view, host: null };
  wireTab(tab);
  if (p) {
    const last = state.lastUrls[p.id];
    const target = url && inDomains(url, p.domains) ? url
      : tabsMode() && p.multi ? p.url              // nouvel onglet YouTube/Twitch : page d'accueil
      : last && inDomains(last, p.domains) ? last : p.url;
    view.webContents.loadURL(target);
  } else {
    view.webContents.loadFile(path.join(__dirname, 'picker.html'));
  }
  return tab;
}

function destroyTab(tab) {
  if (tab.host) tab.host.take(tab);
  if (nowTab === tab) nowTab = null;
  try { if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close(); } catch {}
}

function wireTab(tab) {
  const wc = tab.view.webContents;
  const p = tab.p;
  wc.on('before-input-event', (e, input) => shortcut(e, input, tab.host));
  wc.on('audio-state-changed', () => tab.host && tab.host.updateBar());
  wc.on('enter-html-full-screen', () => tab.host && tab.host.enterFullscreen(tab));
  wc.on('leave-html-full-screen', () => tab.host && tab.host.exitFullscreen());
  wc.on('page-title-updated', (_e, title) => { tab.title = title; if (tab.host) tab.host.updateBar(); });
  if (!p) return;

  // Mémorise la page en cours pour y revenir après un crash ou au prochain lancement.
  const track = (_e, url) => { if (inDomains(url, p.domains)) state.lastUrls[p.id] = url; };
  wc.on('did-navigate', track);
  wc.on('did-navigate-in-page', track);

  // --- Filets de sécurité ---
  wc.on('render-process-gone', (_e, d) => recover(tab, `renderer: ${d.reason}`));
  wc.on('unresponsive', () => {
    log(`${p.name} : page figée, on attend 10 s avant de forcer…`);
    setTimeout(() => { if (alive(tab) && !wc.isCrashed()) wc.forcefullyCrashRenderer(); }, 10_000);
  });
  wc.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) recover(tab, `chargement raté ${code} ${desc}`);
  });

  // Liens : site de la plateforme ou connexion => popup dans l'appli ; le reste => navigateur.
  wc.setWindowOpenHandler(({ url }) => {
    // en mode onglets, un lien YouTube/Twitch ouvert « dans un nouvel onglet » devient un vrai onglet
    if (tabsMode() && p.multi && inDomains(url, p.domains) && !inDomains(url, AUTH_DOMAINS)) {
      setImmediate(() => open(p.id, { inHost: tab.host, url, background: true, after: tab }));
      return { action: 'deny' };
    }
    if (inDomains(url, p.domains) || inDomains(url, AUTH_DOMAINS)) {
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, width: 520, height: 720 } };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// Recharge la page sans tourner en boucle si le site est vraiment HS.
function recover(tab, reason) {
  const p = tab.p;
  const now = Date.now();
  crashTimes = crashTimes.filter(t => now - t < 60_000);
  crashTimes.push(now);
  log(`${p.name} : récupération (${reason}) — ${crashTimes.length} dans la dernière minute`);
  const delay = crashTimes.length > 3 ? 15_000 : 1_000;
  setTimeout(() => {
    if (!alive(tab) || !tab.host) return;
    const last = state.lastUrls[p.id];
    tab.view.webContents.loadURL(last && inDomains(last, p.domains) ? last : p.url).catch(() => {});
  }, delay);
}

// Ouvre une plateforme (ou l'écran de choix si id = null).
//  - mode classique : remplace la page de la fenêtre principale (comme avant) ;
//  - mode onglets : va sur l'onglet s'il existe déjà, sinon en ouvre un nouveau.
function open(id, { inHost, replace, url, background, after } = {}) {
  const p = id ? byId(id) : null;
  if (!mainHost) createMainHost();
  const host = inHost && !inHost.win.isDestroyed() ? inHost : mainHost;

  // YouTube, Twitch… : en mode onglets, chaque ouverture crée un nouvel onglet
  const allowDuplicate = p && tabsMode() && (p.multi || url);
  if (p && !allowDuplicate) {
    const existing = findTab(t => t.p && t.p.id === p.id);
    if (existing) {
      existing.host.activate(existing);
      if (replace && replace !== existing) destroyTab(replace);
      showHost(existing.host);
      return existing;
    }
  } else if (!p && tabsMode()) {
    const picker = host.tabs.find(t => !t.p);
    if (picker) { host.activate(picker); showHost(host); return picker; }
  }

  const tab = createTab(p, url);
  if (!tabsMode()) {
    // une seule page à la fois : on remplace tout ce qui est ouvert dans la fenêtre principale
    const old = [...mainHost.tabs];
    mainHost.add(tab);
    for (const t of old) destroyTab(t);
  } else if (replace && replace.host === host) {
    const idx = host.tabs.indexOf(replace);
    host.add(tab, { index: idx });
    destroyTab(replace);
  } else if (after && after.host === host) {
    host.add(tab, { index: host.tabs.indexOf(after) + 1, activate: !background });
  } else {
    host.add(tab, { activate: !background });
  }
  if (p) state.platform = p.id;
  saveState();
  if (!background) showHost(host);
  return tab;
}

function showHost(host) {
  // Au démarrage de Windows, ou si le mini-lecteur est ouvert, la grande fenêtre reste cachée.
  if (startHidden || (host.main && miniOpen() && !host.win.isVisible())) return;
  host.show();
}

// Déplace un onglet dans une nouvelle fenêtre (sans recharger la page).
function detach(tab, at) {
  const from = tab.host;
  if (!from || !tab.p || (from.tabs.length < 2 && !from.main)) return;
  const [w, h] = from.win.getSize();
  const W = Math.min(w, 1100), H = Math.min(h, 760);
  const cur = at || screen.getCursorScreenPoint();
  const host = new Host({ main: false, bounds: { width: W, height: H, x: Math.round(cur.x - W / 2), y: Math.round(cur.y - 20) } });
  from.take(tab);
  host.add(tab);
  host.show();
  if (from.main && from.tabs.length === 0) open(null); // la fenêtre principale garde au moins l'écran de choix
  saveState();
  buildTrayMenu();
}

// Remet un onglet détaché dans la fenêtre principale.
function attach(tab) {
  const from = tab.host;
  if (!from || from.main) return;
  if (!mainHost) createMainHost();
  from.take(tab);
  // si la fenêtre principale n'affiche que l'écran de choix, on le remplace
  const onlyPicker = mainHost.tabs.length === 1 && !mainHost.tabs[0].p ? mainHost.tabs[0] : null;
  mainHost.add(tab);
  if (onlyPicker) destroyTab(onlyPicker);
  if (from.tabs.length === 0) from.win.close();
  mainHost.show();
  saveState();
  buildTrayMenu();
}

// Active / coupe le mode onglets.
function setTabsMode(on) {
  if (on === tabsMode()) return;
  if (!on) {
    // retour au mode classique : on garde la page affichée dans la fenêtre principale, le reste se ferme
    const keep = (mainHost && mainHost.active) || null;
    for (const h of [...hosts]) if (!h.main) { for (const t of [...h.tabs]) if (t !== keep) destroyTab(t); h.win.close(); }
    if (mainHost) for (const t of [...mainHost.tabs]) if (t !== keep) destroyTab(t);
  }
  state.tabsMode = on;
  for (const h of hosts) { h.layout(); h.updateBar(); }
  saveState();
  buildTrayMenu();
}

function closeTab(tab) {
  const host = tab.host;
  if (!host) return;
  if (host.main && host.tabs.length === 1) {
    // dernier onglet de la fenêtre principale : on revient à l'écran de choix
    if (tab.p) open(null, { replace: tab });
    return;
  }
  destroyTab(tab);
  if (!host.main && host.tabs.length === 0) host.win.close();
  saveState();
  buildTrayMenu();
}

// Raccourcis clavier, valables dans toutes les pages.
function shortcut(e, input, host) {
  if (input.type !== 'keyDown' || !input.control) return;
  const k = input.key.toLowerCase();
  const h = host || mainHost;
  if (input.shift) {
    if (k === 'p') { e.preventDefault(); open(null, { inHost: h }); }
    if (k === 'm') { e.preventDefault(); toggleMini(); }
    if (k === 'l') { e.preventDefault(); openPlaylists(); }
    if (k === 'd' && tabsMode() && h && h.active) { e.preventDefault(); detach(h.active); }
  }
  if (!tabsMode() || !h) return;
  if (!input.shift && k === 't') { e.preventDefault(); open(null, { inHost: h }); }
  if (!input.shift && k === 'w' && h.active) { e.preventDefault(); closeTab(h.active); }
  if (k === 'tab' && h.tabs.length > 1) {
    e.preventDefault();
    const i = h.tabs.indexOf(h.active);
    h.activate(h.tabs[(i + (input.shift ? -1 : 1) + h.tabs.length) % h.tabs.length]);
  }
  if (!input.shift && /^[1-9]$/.test(k)) {
    const t = h.tabs[Math.min(+k, h.tabs.length) - 1];
    if (t) { e.preventDefault(); h.activate(t); }
  }
}

function showWin() {
  if (!mainHost) { open(state.platform || null); return; }
  if (!mainHost.tabs.length) open(null);
  mainHost.show();
}

// --- IPC de la barre d'onglets ---
const tabByKey = key => findTab(t => t.key === key);
ipcMain.on('tabs:activate', (_e, key) => { const t = tabByKey(key); if (t) t.host.activate(t); });
ipcMain.on('tabs:close', (_e, key) => { const t = tabByKey(key); if (t) closeTab(t); });
ipcMain.on('tabs:new', e => { const h = [...hosts].find(x => x.bar.webContents === e.sender); open(null, { inHost: h || mainHost }); });
ipcMain.on('tabs:detach', (_e, key, x, y) => { const t = tabByKey(key); if (t) detach(t, x != null ? { x, y } : null); });
ipcMain.on('tabs:attach', (_e, key) => { const t = tabByKey(key); if (t) attach(t); });
ipcMain.on('tabs:mute', (_e, key) => {
  const t = tabByKey(key);
  if (alive(t)) { t.view.webContents.setAudioMuted(!t.view.webContents.isAudioMuted()); t.host.updateBar(); }
});
ipcMain.on('tabs:move', (_e, key, index) => {
  const t = tabByKey(key);
  if (!t || !t.host) return;
  const h = t.host, i = h.tabs.indexOf(t);
  if (i < 0 || index === i) return;
  h.tabs.splice(i, 1);
  h.tabs.splice(Math.max(0, Math.min(index, h.tabs.length)), 0, t);
  h.updateBar();
  saveState();
});
ipcMain.on('tabs:menu', (_e, key) => {
  const t = tabByKey(key);
  if (!t) return;
  const h = t.host;
  Menu.buildFromTemplate([
    ...(h.main
      ? [{ label: 'Détacher dans une fenêtre', enabled: !!t.p, click: () => detach(t) }]
      : [{ label: 'Rattacher à la fenêtre principale', click: () => attach(t) }]),
    { label: 'Recharger', enabled: alive(t), click: () => t.view.webContents.reload() },
    { label: alive(t) && t.view.webContents.isAudioMuted() ? 'Remettre le son' : 'Couper le son', enabled: alive(t) && !!t.p,
      click: () => { t.view.webContents.setAudioMuted(!t.view.webContents.isAudioMuted()); h.updateBar(); } },
    { type: 'separator' },
    { label: 'Fermer l\'onglet', click: () => closeTab(t) },
  ]).popup({ window: h.win });
});

// ------------------------------------------------------------------
// Mini-lecteur : petite fenêtre toujours au premier plan.
// Les infos viennent de la "Media Session" que chaque site remplit (titre, artiste, pochette),
// donc ça marche sur toutes les plateformes sans code spécifique.
// ------------------------------------------------------------------
const miniOpen = () => !!(mini && !mini.isDestroyed());

function toggleMini() {
  if (miniOpen()) return closeMini(true);
  if (!findTab(t => t.p)) return; // rien à contrôler sur l'écran de choix

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

  if (mainHost && !mainHost.win.isDestroyed()) mainHost.win.hide();
  buildTrayMenu();
}

function closeMini(showMain) {
  if (miniOpen()) { saveState(); mini.close(); }
  if (showMain) showWin();
}

// ------------------------------------------------------------------
// Suivi de la lecture : une lecture par seconde, partagée entre le mini-lecteur, Discord et l'overlay OBS.
// Avec plusieurs onglets, on suit celui qui joue (en priorité celui qu'on suivait déjà).
// ------------------------------------------------------------------
async function poll() {
  const tabs = allTabs().filter(t => t.p && alive(t));
  const states = await Promise.all(tabs.map(async t => {
    try { return await t.view.webContents.executeJavaScript('window.__platine ? window.__platine.state() : null', true); }
    catch { return null; }
  }));
  const playingIdx = tabs.map((t, i) => (states[i] && states[i].playing ? i : -1)).filter(i => i >= 0);
  let idx = tabs.indexOf(nowTab);
  if (!(idx >= 0 && states[idx] && states[idx].playing)) {
    if (playingIdx.length) {
      // priorité à l'onglet affiché dans la fenêtre principale, sinon le premier qui joue
      const act = mainHost && mainHost.active;
      idx = playingIdx.find(i => tabs[i] === act) ?? playingIdx[0];
    } else if (!(idx >= 0 && states[idx] && states[idx].title)) {
      const act = mainHost && mainHost.active;
      idx = act && act.p ? tabs.indexOf(act) : (tabs.length ? 0 : -1);
    }
  }
  nowTab = idx >= 0 ? tabs[idx] : null;
  const p = nowTab && nowTab.p;
  nowPlaying = {
    title: null, artist: null, album: null, art: null, playing: false, position: null, duration: null,
    ...((idx >= 0 && states[idx]) || {}),
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
  if (!alive(nowTab)) return;
  try {
    await nowTab.view.webContents.executeJavaScript(`window.__platine && window.__platine.action(${JSON.stringify(action)})`, true);
  } catch {}
  setTimeout(poll, 150);
});

// ------------------------------------------------------------------
// Fenêtre Playlists : lire, transférer, sauvegarder
// ------------------------------------------------------------------
function openPlaylists() {
  if (playlistsWin && !playlistsWin.isDestroyed()) { playlistsWin.show(); playlistsWin.focus(); return; }
  playlistsWin = new BrowserWindow({
    width: 1000, height: 720, minWidth: 720, minHeight: 480,
    backgroundColor: '#0b0b0d', title: 'Playlists — Platine', icon: ICON, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'playlists-preload.js'), contextIsolation: true, sandbox: true },
  });
  playlistsWin.loadFile(path.join(__dirname, 'playlists.html'));
  playlistsWin.on('close', e => {
    if (transfer.isRunning()) {
      const r = dialog.showMessageBoxSync(playlistsWin, {
        type: 'warning', buttons: ['Continuer le transfert', 'Annuler et fermer'], defaultId: 0, cancelId: 0,
        message: 'Un transfert est en cours.', detail: 'Si tu fermes, il sera annulé (les playlists déjà créées restent).',
      });
      if (r === 0) { e.preventDefault(); return; }
      transfer.cancel();
    }
  });
  playlistsWin.on('closed', () => { playlistsWin = null; });
}

const safely = fn => async (...args) => {
  try { return { ok: true, ...(await fn(...args)) }; }
  catch (e) { log(`[playlists] ${e && e.stack || e}`); return { ok: false, error: (e && e.message) || String(e) }; }
};
const stamp = () => new Date().toISOString().slice(0, 10);

ipcMain.handle('pl:services', () => services.list());
ipcMain.handle('pl:connect', safely(async (_e, id) => {
  await services.connect(id, url => shell.openExternal(url));
  if (playlistsWin && !playlistsWin.isDestroyed()) { playlistsWin.show(); playlistsWin.focus(); }
  return {};
}));
ipcMain.handle('pl:disconnect', (_e, id) => { services.disconnect(id); return { ok: true }; });
ipcMain.handle('pl:list', safely(async (_e, id) => ({ playlists: await services.connector(id).listPlaylists() })));
ipcMain.handle('pl:openPortal', (_e, id) => { const s = services.SERVICES[id]; if (s) shell.openExternal(s.devPortal); });
ipcMain.handle('pl:cancel', () => transfer.cancel());

ipcMain.handle('pl:transfer', safely(async (e, job) => {
  const send = p => { if (!e.sender.isDestroyed()) e.sender.send('pl:progress', p); };
  const report = await transfer.transfer(job, send);
  log(`[playlists] transfert ${report.from} -> ${report.to} : ${report.playlists.length} playlist(s)${report.error ? ' — ' + report.error : ''}`);
  return { report };
}));

ipcMain.handle('pl:backup', safely(async (e, id) => {
  const send = p => { if (!e.sender.isDestroyed()) e.sender.send('pl:backup-progress', p); };
  const data = await transfer.backup(id, send);
  const name = services.SERVICES[id].name;
  const { canceled, filePath } = await dialog.showSaveDialog(playlistsWin, {
    title: 'Enregistrer la sauvegarde',
    defaultPath: path.join(app.getPath('documents'), `Platine - playlists ${name} ${stamp()}.json`),
    filters: [{ name: 'Sauvegarde Platine', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { cancelled: true };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  fs.writeFileSync(filePath.replace(/\.json$/i, '') + '.csv', transfer.toCsv(data), 'utf8');
  return {
    path: filePath,
    playlists: data.playlists.length,
    tracks: data.playlists.reduce((a, p) => a + p.tracks.length, 0),
  };
}));

ipcMain.handle('pl:saveReport', safely(async (_e, report) => {
  const { canceled, filePath } = await dialog.showSaveDialog(playlistsWin, {
    title: 'Enregistrer le rapport',
    defaultPath: path.join(app.getPath('documents'), `Platine - transfert ${report.from} vers ${report.to} ${stamp()}.txt`),
    filters: [{ name: 'Texte', extensions: ['txt'] }],
  });
  if (canceled || !filePath) return { cancelled: true };
  const lines = [`Transfert ${report.from} → ${report.to} (${new Date(report.date).toLocaleString('fr-FR')})`, ''];
  if (report.error) lines.push(`Interrompu : ${report.error}`, '');
  for (const p of report.playlists) {
    lines.push(`■ ${p.name} — ${p.found}/${p.total} titres retrouvés${p.created ? '' : ' (playlist non créée)'}`);
    for (const m of p.missing) lines.push(`    ✕ ${m.title} — ${(m.artists || []).join(', ')}${m.album ? ` [${m.album}]` : ''}`);
    lines.push('');
  }
  fs.writeFileSync(filePath, '\uFEFF' + lines.join('\r\n'), 'utf8');
  return { path: filePath };
}));

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
  const act = mainHost && mainHost.active && mainHost.active.p ? mainHost.active : null;
  tray.setToolTip(act ? `Platine — ${act.p.name}` : 'Platine');
  const openIds = new Set(allTabs().filter(t => t.p).map(t => t.p.id));
  const template = [
    { label: 'Afficher', click: showWin },
    { label: 'Playlists…', accelerator: 'Ctrl+Shift+L', click: openPlaylists },
    { label: 'Mini-lecteur', type: 'checkbox', checked: miniOpen(), enabled: openIds.size > 0, accelerator: 'Ctrl+Shift+M', click: toggleMini },
    {
      label: 'Plateforme',
      submenu: [
        ...PLATFORMS.map(p => tabsMode()
          ? (p.multi
            ? { label: `${p.name} (nouvel onglet)`, click: () => open(p.id) }
            : { label: p.name, type: 'checkbox', checked: openIds.has(p.id), click: () => open(p.id) })
          : { label: p.name, type: 'radio', checked: !!act && act.p.id === p.id, click: () => open(p.id) }),
        { type: 'separator' },
        { label: tabsMode() ? 'Nouvel onglet' : 'Écran de choix', click: () => open(null) },
      ],
    },
    {
      label: 'Mode onglets',
      type: 'checkbox',
      checked: tabsMode(),
      click: item => setTabsMode(item.checked),
    },
    { label: 'Recharger', enabled: !!act, click: () => act && alive(act) && act.view.webContents.reload() },
    {
      label: 'Se déconnecter de cette plateforme',
      enabled: !!act,
      click: async () => {
        const p = act.p;
        await sessionFor(p).clearStorageData();
        delete state.lastUrls[p.id];
        if (alive(act)) act.view.webContents.loadURL(p.url);
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
      label: 'Bloquer les pubs (YouTube, Twitch)',
      type: 'checkbox',
      checked: state.adblock !== false,
      click: item => setAdblock(item.checked),
    },
    {
      label: 'Pubs Twitch',
      enabled: state.adblock !== false,
      submenu: [
        { label: 'Bloquer (TwitchAdSolutions)', type: 'radio', checked: (state.twitchAds || 'vaft') === 'vaft', click: () => setTwitchAds('vaft') },
        { label: 'Couper le son et masquer', type: 'radio', checked: state.twitchAds === 'mute', click: () => setTwitchAds('mute') },
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
ipcMain.on('choose', (e, id) => {
  if (!byId(id)) return;
  const pickerTab = findTab(t => !t.p && alive(t) && t.view.webContents === e.sender);
  open(id, { inHost: pickerTab && pickerTab.host, replace: pickerTab });
});

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
    if (d.type === 'GPU' && d.reason !== 'clean-exit') {
      for (const h of hosts) if (h.active && h.active.p) recover(h.active, `GPU: ${d.reason}`);
    }
  });

  app.whenReady().then(async () => {
    if (components && components.whenReady) await components.whenReady(); // module Widevine prêt (Electron Castlabs)
    log(`Widevine prêt : ${components ? JSON.stringify(components.status()) : 'n/a'} — v${app.getVersion()}`);
    loadState();

    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16 }));
    tray.on('click', () => (miniOpen() ? closeMini(true) : showWin()));

    // Premier lancement => écran de choix ; ensuite on rouvre la (ou les) dernière(s) plateforme(s).
    const saved = tabsMode()
      ? (state.tabs || []).map(x => (typeof x === 'string' ? { id: x } : x)).filter(x => x && byId(x.id))
      : [];
    if (saved.length) {
      // à lire AVANT de rouvrir : chaque ouverture réenregistre l'état
      const idx = typeof state.activeTab === 'number' ? state.activeTab
        : Math.max(0, saved.findIndex(x => x.id === state.activeTab));
      const opened = saved.map(x => open(x.id, { url: x.url || undefined, background: true }));
      const act = opened[Math.min(idx, opened.length - 1)];
      if (act && act.host) { act.host.activate(act); showHost(act.host); }
    } else {
      open(byId(state.platform) ? state.platform : null);
    }
    startHidden = false;
    setupUpdater();

    accounts.init({ dir: app.getPath('userData'), safeStorage: require('electron').safeStorage });
    discord.setLogger(log);
    overlay.setLogger(log);
    if (state.discord === undefined) state.discord = discord.available(); // activé par défaut si l'ID est rempli
    if (state.discord && discord.available()) discord.setEnabled(true);
    if (state.overlay) await setOverlay(true);
    startPolling();
    buildTrayMenu();
  }).catch(err => log(`Erreur au démarrage : ${err && err.stack || err}`));

  app.on('before-quit', () => { quitting = true; saveState(); discord.setEnabled(false); overlay.stop(); });
  app.on('window-all-closed', () => {}); // on reste dans la zone de notif
}

process.on('uncaughtException', err => log(`Exception non gérée : ${err.stack || err}`));

// Accès interne pour les tests automatiques uniquement.
if (process.env.PLATINE_TEST) {
  global.__platineTest = {
    open, detach, attach, closeTab, setTabsMode, poll,
    hosts: () => [...hosts], main: () => mainHost, tabs: allTabs, nowTab: () => nowTab, state: () => state,
  };
}
