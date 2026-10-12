// Injecté dans la page de chaque plateforme, AVANT ses propres scripts.
// On garde une copie des boutons que le site déclare à Windows (play/pause/suivant…)
// pour que le mini-lecteur puisse les appuyer, et on lit titre/artiste/pochette.
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
  const media = () => [...document.querySelectorAll('audio,video')]
    .find(m => m.currentSrc || m.src || m.srcObject) || null;
  const abs = u => { try { return new URL(u, location.href).href; } catch { return null; } };

  window.__platine = {
    state() {
      const ms = navigator.mediaSession;
      const md = ms && ms.metadata;
      const m = media();
      let playing = !!ms && ms.playbackState === 'playing';
      if (m && (!ms || ms.playbackState === 'none')) playing = !m.paused;

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
        can: { prev: !!handlers.previoustrack, next: !!handlers.nexttrack },
      };
    },
    action(a) {
      if (a === 'toggle') a = this.state().playing ? 'pause' : 'play';
      const h = handlers[a];
      if (h) { try { h({ action: a }); return true; } catch (e) {} }
      const m = media();
      if (m && a === 'play') { m.play(); return true; }
      if (m && a === 'pause') { m.pause(); return true; }
      return false;
    },
  };
})();`);
