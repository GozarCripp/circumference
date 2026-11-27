// render3d/combat3d.js — first-person combat feel, drawn on the 2D overlay canvas above the 3D view:
//   * the hand + weapon viewmodel (bottom-right), idle sway, and its swing / recoil / spell thrust
//   * the red damage-direction wedge pointing at whoever just hit you
//   * the hurt vignette and the low-HP pulse
// Event-driven (core/bus.js); reads G, never changes it. fp.js calls drawCombat() each frame and asks combatActive()
// whether to keep drawing frames.
import { G } from '../core/state.js';
import { on } from '../core/bus.js';
import * as assets from '../art/assets.js';

const SWING_MS = 180, CAST_MS = 280, WEDGE_MS = 900, VIG_MS = 500, LOW_HP = 0.25;
const SKIN = '#e8b48a', SKIN_D = '#c48f68', OUT = '#1a1023';
const clock = () => performance.now();

let swingT0 = -1e9, swingKind = 'melee', vigT0 = -1e9;
const wedges = [];                                  // { x, y, t0 } attacker tiles
let vm = null, vmKey = '';                          // cached viewmodel canvas for the current weapon

export function initCombat3d() {
  const swing = kind => { swingT0 = clock(); swingKind = kind; };
  on('hit', e => { if (e && (e.kind === 'melee' || e.kind === 'ranged')) swing(e.kind); });
  on('work', () => swing('melee'));                 // chopping / mining swings too
  on('spell', () => swing('spell'));
  on('hurt', e => {
    vigT0 = clock();
    const b = e && e.by;
    if (b && Number.isFinite(b.x) && Number.isFinite(b.y)) { wedges.push({ x: b.x, y: b.y, t0: clock() }); if (wedges.length > 4) wedges.shift(); }
  });
}

const lowHp = () => !!G.P && !G.over && G.P.hp > 0 && G.P.hp / G.P.max < LOW_HP;
/** True while something here is mid-animation (the frame loop keeps drawing). */
export function combatActive() {
  const t = clock();
  return t - swingT0 < CAST_MS || t - vigT0 < VIG_MS || wedges.some(w => t - w.t0 < WEDGE_MS) || lowHp();
}

/** 32x32 viewmodel: forearm from the bottom-right corner, a fist, and the weapon icon mirrored so its handle sits in
 *  the fist and the blade points up-left (the item art lies handle bottom-left, tip top-right). */
function viewmodel() {
  const wep = G.P.wep, key = wep && !wep.fists ? assets.gearIconId(wep) : 'fists';
  if (key === vmKey && vm) return vm;
  vmKey = key;
  const c = document.createElement('canvas'); c.width = c.height = 32;
  const g = c.getContext('2d');
  // forearm: a thick diagonal from (31,31) up-left to the wrist at (21,21), outlined
  for (let i = 0; i <= 12; i++) {
    const x = 31 - i, y = 31 - i;
    g.fillStyle = OUT; g.fillRect(x - 4, y - 3, 9, 7);
  }
  for (let i = 0; i <= 12; i++) {
    const x = 31 - i, y = 31 - i;
    g.fillStyle = SKIN; g.fillRect(x - 3, y - 2, 7, 5);
    g.fillStyle = SKIN_D; g.fillRect(x - 3, y + 2, 7, 1);
  }
  // weapon behind the fingers
  if (key !== 'fists') {
    const spr = assets.sprite(key);
    if (spr && spr.img) { g.save(); g.translate(26, 2); g.scale(-1, 1); g.drawImage(spr.img, 0, 0, spr.w, spr.h, 0, 0, 16, 16); g.restore(); }
  }
  // fist
  g.fillStyle = OUT; g.fillRect(14, 13, 10, 10);
  g.fillStyle = SKIN; g.fillRect(15, 14, 8, 8);
  g.fillStyle = SKIN_D; for (const y of [16, 18, 20]) g.fillRect(15, y, 5, 1);   // knuckle lines
  g.fillStyle = '#f6cfa6'; g.fillRect(16, 14, 6, 1);
  vm = c;
  return c;
}

const ease = k => (k <= 0 || k >= 1 ? 0 : Math.sin(k * Math.PI));

/** Draw the combat layer. ctx is the overlay (device px), yaw the view yaw, sway 0.. walk phase, light 0..1. */
export function drawCombat(ctx, w, h, yaw, sway, light) {
  if (!G.P) return;
  const t = clock();
  ctx.save();
  ctx.imageSmoothingEnabled = false;

  // ---- hurt vignette + low-HP pulse ----------------------------------------------------------------------------
  let va = Math.max(0, 1 - (t - vigT0) / VIG_MS) * 0.6;
  if (lowHp()) va = Math.max(va, 0.18 + 0.14 * Math.sin(t / 180));
  if (va > 0.01) {
    const gr = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.hypot(w, h) / 2);
    gr.addColorStop(0, 'rgba(255,40,80,0)'); gr.addColorStop(1, `rgba(255,40,80,${va})`);
    ctx.fillStyle = gr; ctx.fillRect(0, 0, w, h);
  }

  // ---- damage-direction wedges ---------------------------------------------------------------------------------
  const P = G.P, R = Math.min(w, h) * 0.36;
  for (let i = wedges.length - 1; i >= 0; i--) {
    const wd = wedges[i], k = (t - wd.t0) / WEDGE_MS;
    if (k >= 1) { wedges.splice(i, 1); continue; }
    const dx = wd.x - P.x, dy = wd.y - P.y;
    if (!dx && !dy) continue;
    // bearing relative to the view: 0 = straight ahead (screen up), + = to the right
    const rel = Math.atan2(-dx, -dy) - yaw, a = -rel - Math.PI / 2;
    ctx.globalAlpha = 0.95 * Math.min(1, 2.2 * (1 - k));
    ctx.fillStyle = '#ff2f5a'; ctx.strokeStyle = '#2a0a3a'; ctx.lineWidth = Math.max(2, R * 0.02);
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, R, a - 0.28, a + 0.28);
    ctx.arc(w / 2, h / 2, R * 0.88, a + 0.22, a - 0.22, true);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // ---- viewmodel -----------------------------------------------------------------------------------------------
  if (!G.over) {
    const img = viewmodel(), size = Math.round(Math.min(w, h) * 0.5);
    let px = w - size * 0.95, py = h - size * 0.97, rot = 0, sc = 1;   // fist sits right of centre, above the button bar
    px += Math.sin(sway * Math.PI) * size * 0.03; py += Math.abs(Math.cos(sway * Math.PI)) * size * 0.03;   // walk sway
    const k = (t - swingT0) / (swingKind === 'spell' ? CAST_MS : SWING_MS);
    if (k >= 0 && k < 1) {
      const e = ease(k);
      if (swingKind === 'melee') { rot = -1.15 * e; px -= size * 0.28 * e; py -= size * 0.12 * e; }   // arc across toward the centre
      else if (swingKind === 'ranged') { px += size * 0.08 * e; py += size * 0.1 * e; }               // recoil
      else { sc = 1 + 0.18 * e; px -= size * 0.12 * e; py -= size * 0.18 * e; }                     // spell thrust
    }
    ctx.translate(px + size * 0.8, py + size * 0.95);                // pivot near the elbow (bottom-right)
    ctx.rotate(rot); ctx.scale(sc, sc);
    ctx.filter = light < 0.98 ? `brightness(${(0.35 + 0.65 * light).toFixed(2)})` : 'none';
    ctx.drawImage(img, -size * 0.8, -size * 0.95, size, size);
    ctx.filter = 'none';
    if (swingKind === 'spell' && k >= 0 && k < 1) {                 // a magic glow on the cast
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.6 * ease(k);
      ctx.drawImage(img, -size * 0.8, -size * 0.95, size, size);
    }
  }
  ctx.restore();
}
