// Injecté dans la page de chaque plateforme, AVANT ses propres scripts.
// On garde une copie des boutons que le site déclare à Windows (play/pause/suivant/avancer…)
// pour que Platine puisse les appuyer, et on lit titre/artiste/pochette/position.
const { webFrame } = require('electron');

webFrame.executeJavaScript(`(() => {
  if (window.__platine) return;
  const handlers = {};
  let pos = null;
  const MS = window.MediaSession && MediaSession.prototype;
  if (MS) {
    const origSet = MS.setActionHandler;
    MS.setActionHandler = function (action, handler) {
      handlers[action] = handler;
      return origSet.call(this, action, handler);
    };
    const origPos = MS.setPositionState;
    if (origPos) {
      MS.setPositionState = function (s) {
        pos = s && s.duration ? { duration: s.duration, position: s.position || 0, rate: s.playbackRate || 1, at: Date.now() } : null;
        return origPos.call(this, s);
      };
    }
  }
  // Certains sites (Spotify…) jouent le son avec un lecteur qui n'est jamais ajouté à la page :
  // on retient tous les lecteurs qui démarrent, même invisibles.
  const known = new Set();
  const HME = window.HTMLMediaElement && HTMLMediaElement.prototype;
  if (HME) {
    const origPlay = HME.play;
    HME.play = function () { known.add(this); return origPlay.apply(this, arguments); };
  }
  for (const ev of ['play', 'playing', 'loadedmetadata']) {
    document.addEventListener(ev, e => { if (e.target instanceof HTMLMediaElement) known.add(e.target); }, true);
  }
  const media = () => {
    const all = [...new Set([...known, ...document.querySelectorAll('audio,video')])]
      .filter(m => m.currentSrc || m.src || m.srcObject);
    // priorité : celui qui joue, puis celui qui a une durée
    return all.find(m => !m.paused && !m.ended)
      || all.find(m => isFinite(m.duration) && m.duration > 0)
      || all[0] || null;
  };
  const abs = u => { try { return new URL(u, location.href).href; } catch { return null; } };

  window.__platine = {
    state() {
      const ms = navigator.mediaSession;
      const md = ms && ms.metadata;
      const m = media();
      let playing = !!ms && ms.playbackState === 'playing';
      if (m && (!ms || ms.playbackState === 'none' || !ms.playbackState)) playing = !m.paused && !m.ended;
      else if (m && !playing && ms.playbackState !== 'paused') playing = !m.paused && !m.ended;

      let position = null, duration = null;
      if (pos) {
        duration = pos.duration;
        position = pos.position + (playing ? (Date.now() - pos.at) / 1000 * pos.rate : 0);
      } else if (m && isFinite(m.duration) && m.duration > 0) {
        duration = m.duration;
        position = m.currentTime;
      }
      if (duration && position > duration) position = duration;

      let art = null;
      if (md && md.artwork && md.artwork.length) {
        // la plus grande pochette proposée
        const best = [...md.artwork].sort((a, b) => (parseInt(b.sizes) || 0) - (parseInt(a.sizes) || 0))[0];
        art = abs(best.src);
      }
      return {
        title: md ? md.title : null,
        artist: md ? md.artist : null,
        album: md ? md.album : null,
        art, playing, position, duration,
        volume: m ? m.volume : null,
        can: {
          prev: !!handlers.previoustrack,
          next: !!handlers.nexttrack,
          seek: !!handlers.seekto || !!(m && isFinite(m.duration)),
          volume: !!m,
        },
      };
    },
    // a = 'play' | 'pause' | 'toggle' | 'nexttrack' | 'previoustrack'
    //   | { seek: secondes } | { volume: 0..1 }
    action(a) {
      const m = media();
      if (a && typeof a === 'object') {
        if (typeof a.seek === 'number') {
          if (handlers.seekto) { try { handlers.seekto({ action: 'seekto', seekTime: a.seek }); return true; } catch (e) {} }
          if (m) { m.currentTime = a.seek; return true; }
        }
        if (typeof a.volume === 'number' && m) {
          m.volume = Math.max(0, Math.min(1, a.volume));
          return true;
        }
        return false;
      }
      if (a === 'toggle') a = this.state().playing ? 'pause' : 'play';
      const h = handlers[a];
      if (h) { try { h({ action: a }); return true; } catch (e) {} }
      if (m && a === 'play') { m.play(); return true; }
      if (m && a === 'pause') { m.pause(); return true; }
      return false;
    },
  };
})();`);
