// ui/title.js — the title screen. drawTitle() is a verbatim port of the classic prototype
// (classic/index.html, "TITLE SCREEN"). This exact look is signed off: do not restyle it.
//   Synthwave sunset (purple/pink/orange sky, sun, neon-pink grid, palm silhouettes), "Circumference" in Titan One
//   (white letters, baby-blue inline, orange outline) sitting in clouds, "Naked & Uninsured" in Grenze with a
//   flat-top / arched-bottom warp on a solid black backing, drawn on a 256px-wide canvas and upscaled pixelated.
import { R, pick } from '../core/util.js';
import { TIPS } from '../data/flavor.js';
import { $ } from './dom.js';

export function drawTitle() {
  const tcv = $('tc'); if (!tcv) return;
  const W = 256, H = Math.max(160, Math.min(420, Math.round(256 * innerHeight / innerWidth))), c = tcv.getContext('2d');
  tcv.width = W; tcv.height = H;
  const sky = ['#1b0f3b', '#2d1458', '#4a1a6b', '#7a2470', '#b23a6a', '#e2585a', '#f5874a', '#ffb347'];
  for (let i = 0; i < sky.length; i++) { c.fillStyle = sky[i]; c.fillRect(0, Math.floor(i * H * .72 / sky.length), W, Math.ceil(H * .72 / sky.length) + 1); }
  for (let i = 0; i < 40; i++) { c.fillStyle = i % 3 ? '#fff8' : '#fff'; c.fillRect(R(W), R(H * .3), 1, 1); }
  const sx = W / 2, sy = H * .72, sr = Math.min(W, H) * .22; c.fillStyle = '#ffd23f'; c.beginPath(); c.arc(sx, sy, sr, Math.PI, 0); c.fill();
  c.fillStyle = '#f5874a'; for (let i = 0; i < 5; i++) c.fillRect(sx - sr, sy - sr * (.1 + i * .17), sr * 2, 1 + i * .6);
  c.fillStyle = '#120826'; c.fillRect(0, H * .72, W, H); c.strokeStyle = '#ff2fa0'; c.lineWidth = 1;
  for (let i = 0; i < 7; i++) { const y = H * .72 + Math.pow(i / 6, 1.8) * H * .28; c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }
  for (let i = -8; i <= 8; i++) { c.beginPath(); c.moveTo(W / 2 + i * 6, H * .72); c.lineTo(W / 2 + i * 40, H); c.stroke(); }
  const palm = (x, h, f) => {
    c.fillStyle = '#0a0418'; for (let i = 0; i < h; i++) c.fillRect(Math.round(x + Math.sin(i / h * 1.4) * 6 * f), Math.round(H * .72 - i), 3, 1);
    const tx = x + Math.sin(1.4) * 6 * f, ty = H * .72 - h;
    for (const [a, l] of [[-2.6, 22], [-2, 26], [-1.2, 24], [-.5, 20], [0, 22], [.5, 18]]) {
      c.beginPath(); c.moveTo(tx, ty);
      for (let t = 0; t <= 1; t += .1) c.lineTo(tx + Math.cos(a) * l * t * f, ty + Math.sin(a) * l * t * .5 + t * t * 8);
      c.lineWidth = 3; c.strokeStyle = '#0a0418'; c.stroke();
    }
  };
  palm(W * .1, H * .2, 1); palm(W * .9, H * .17, -1);
  const ty = H * .36, cloud = (x, y, r, col) => { c.fillStyle = col; c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); };
  for (const [x, y, r] of [[-.42, .4, 16], [-.3, 0, 22], [-.12, .3, 20], [.05, -.1, 24], [.22, .25, 20], [.36, 0, 18], [.47, .4, 14]]) { cloud(W / 2 + x * W, ty + y * 20 + 6, r, '#9fd8ff'); cloud(W / 2 + x * W, ty + y * 20 + 2, r - 1, '#fff'); }
  let fs = 60; c.font = `${fs}px "Titan One"`; while (c.measureText('Circumference').width > W * .9 && fs > 10) { fs--; c.font = `${fs}px "Titan One"`; }
  c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineJoin = 'round';
  c.fillStyle = '#2a0a3a'; c.fillText('Circumference', W / 2 + 2, ty + 3);
  c.strokeStyle = '#ff7a1a'; c.lineWidth = fs * .3; c.strokeText('Circumference', W / 2, ty);
  c.strokeStyle = '#8fd3ff'; c.lineWidth = fs * .14; c.strokeText('Circumference', W / 2, ty);
  const g = c.createLinearGradient(0, ty - fs / 2, 0, ty + fs / 2); g.addColorStop(0, '#fff'); g.addColorStop(.6, '#fff'); g.addColorStop(1, '#cfeaff'); c.fillStyle = g; c.fillText('Circumference', W / 2, ty);
  for (const [x, y, r] of [[-.4, .55, 5], [-.15, .6, 4], [.12, -.6, 5], [.33, .6, 4], [-.28, -.58, 4]]) { cloud(W / 2 + x * W, ty + y * fs, r + 1, '#8fd3ff'); cloud(W / 2 + x * W, ty + y * fs - 1, r, '#fff'); }
  const ts = Math.round(fs * .52);
  c.lineWidth = 3;
  {
    const txt = 'Naked & Uninsured', o = document.createElement('canvas'), oc = o.getContext('2d'), pad = Math.round(ts * .3), bh = Math.round(ts * 1.6);
    oc.font = `${ts}px "Grenze"`; const tw = Math.ceil(oc.measureText(txt).width) + pad * 2; o.width = tw; o.height = bh;
    oc.font = `${ts}px "Grenze"`; oc.textAlign = 'center'; oc.textBaseline = 'middle'; oc.lineWidth = Math.max(5, ts * .32); oc.lineJoin = 'round';
    oc.strokeStyle = '#000'; oc.strokeText(txt, tw / 2, bh / 2); oc.fillStyle = '#fff'; oc.fillText(txt, tw / 2, bh / 2);
    const S = 1.18, top = ty + fs * 1.02 - bh / 2 - (S - 1) * bh / 2, bulge = ts * .32; c.imageSmoothingEnabled = false; c.globalAlpha = 1;
    for (let x = 0; x < tw; x++) { const t = x / (tw - 1) * 2 - 1, extra = (1 - t * t) * bulge; c.drawImage(o, x, 0, 1, bh, Math.round(W / 2 - tw / 2) + x, Math.round(top), 1, Math.round(bh * S + extra)); }
  }
  c.fillStyle = '#ff7a1a'; c.fillRect(W / 2 - ts * 3, ty + fs * 1.02 + ts * .92, ts * 6, 1);
}

let gone = true;     // false while the title is up (it keeps fading out for a moment after it stops counting as "up")

// Input that arrives while the game is still booting (before showTitle runs) is queued, not dropped.
// The prompt reads LOADING until the title is live, so players are never told to tap before it listens.
const IGNORED_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab', 'Escape', 'F5', 'F12']);
const isWake = e => e.type !== 'keydown' || (!IGNORED_KEYS.has(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey);
let queued = false, live = false;
const early = e => { if (!live && isWake(e)) queued = true; };
addEventListener('keydown', early, true);
addEventListener('pointerup', early, true);
{ const t = $('tap'); if (t) t.textContent = 'LOADING...'; }

/** Show the title over the (already running) game. Resolves when the player taps or presses a key.
 *  opts.resume: true when a saved life was loaded — only the prompt text changes.
 *  The promise resolves inside the tap itself (so audio can unlock); the picture then fades out over the world. */
export function showTitle(opts = {}) {
  const titleEl = $('title');
  live = true;
  $('tap').textContent = opts.resume ? 'TAP TO WAKE UP (AGAIN)' : 'TAP TO WAKE UP';
  $('tip').textContent = 'Tip: ' + pick(TIPS);
  titleEl.classList.remove('out');
  titleEl.style.display = 'block';
  gone = false;
  const redraw = () => { if (titleEl.style.display !== 'none') drawTitle(); };
  Promise.all([document.fonts.load('40px "Titan One"'), document.fonts.load('20px "Grenze"')]).catch(() => { }).finally(drawTitle);
  addEventListener('resize', redraw);
  return new Promise(resolve => {
    const done = e => {
      if (e) { e.stopPropagation(); if (!isWake(e)) return; e.preventDefault(); }
      if (gone) return;
      gone = true;
      titleEl.removeEventListener('pointerup', done); removeEventListener('keydown', done, true); removeEventListener('resize', redraw);
      titleEl.classList.add('out');                                   // styles/ui.css: fade + drift up, no pointer events
      setTimeout(() => { if (gone) titleEl.style.display = 'none'; }, 520);
      resolve();
    };
    titleEl.addEventListener('pointerup', done);
    addEventListener('keydown', done, true);
    if (queued) { queued = false; done(); }                           // a key/tap landed during boot: honour it now
  });
}
export const titleVisible = () => { const t = $('title'); return !gone && !!t && t.style.display !== 'none'; };
