// render3d/combat3d.js — first-person combat feel, drawn on the 2D overlay canvas above the 3D view:
//   * the hand + weapon viewmodel (bottom-right), idle sway, and its swing / recoil / spell thrust
//   * the red damage-direction wedge pointing at whoever just hit you
//   * the hurt vignette and the low-HP pulse
// Event-driven (core/bus.js); reads G, never changes it. fp.js calls drawCombat() each frame and asks combatActive()
// whether to keep drawing frames.
import { G } from '../core/state.js';
import { on } from '../core/bus.js';
import { makeViewmodel, VM } from '../art/hero.js';
import { slug } from '../core/util.js';

const SWING_MS = 240, CAST_MS = 280, WEDGE_MS = 900, VIG_MS = 500, LOW_HP = 0.25;
const clock = () => performance.now();

let swingT0 = -1e9, swingKind = 'melee', vigT0 = -1e9;
// stabbing weapons and fists drive the point / knuckles straight at the crosshair; everything else chops edge-first
const THRUST = /^(|dagger|straight-sword|thrusting-sword|spear|twinblade|fist-weapons|claws)$/;
const wedges = [];                                  // { x, y, t0 } attacker tiles
let vm = null, vmKey = '';                          // cached viewmodel canvas for the current weapon

export function initCombat3d() {
  const swing = kind => { swingT0 = clock(); swingKind = kind; };
  const melee = () => { const w = G.P && G.P.wep; return THRUST.test(w && !w.fists ? slug(w.type || '') : '') ? 'thrust' : 'chop'; };
  on('hit', e => { if (e && e.kind === 'melee') swing(melee()); else if (e && e.kind === 'ranged') swing('ranged'); });
  on('work', () => swing('chop'));                  // felling trees / mining: always a chop
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

/** The viewmodel canvas for the current weapon (art/hero.js makeViewmodel: full-size weapon, hand round the grip). */
function viewmodel() {
  const wep = G.P.wep, key = wep && !wep.fists ? slug(wep.type || '') : '';
  if (key === vmKey && vm) return vm;
  vmKey = key; vm = makeViewmodel(key || null);
  return vm;
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
    const img = viewmodel();
    // the weapon at real size; the fist low and right of centre, forearm off the bottom edge (portrait: clear of the log)
    const port = h > w * 1.2, sc0 = Math.min(h / 40, w / (port ? 24 : 30)) / VM.k;   // ~40 art px per screen height: a sword reaches mid-screen
    let gx = w * (port ? 0.7 : 0.72), gy = h * (port ? 0.74 : 0.8), rot = 0, sc = 1;   // fist above the button bar
    gx += Math.sin(sway * Math.PI) * w * 0.012; gy += Math.abs(Math.cos(sway * Math.PI)) * h * 0.012;   // walk sway
    const k = (t - swingT0) / (swingKind === 'spell' ? CAST_MS : SWING_MS);
    if (k >= 0 && k < 1) {
      const e = ease(k);
      if (swingKind === 'chop') {
        // wind up (tip back to the right), then strike down-left through the crosshair, edge leading
        const up = k < 0.3 ? Math.sin(k / 0.3 * Math.PI / 2) : Math.max(0, 1 - (k - 0.3) / 0.2);
        const hit = k < 0.3 ? 0 : Math.sin((k - 0.3) / 0.7 * Math.PI);
        rot = 0.4 * up - 0.6 * hit; gx += (w / 2 - gx) * 0.35 * hit; gy -= h * (0.06 * hit + 0.04 * up); sc = 1 - 0.1 * hit;   // the head lands on the crosshair
      } else if (swingKind === 'thrust') {
        // point the tip at the crosshair and drive it in: forward (up-left, smaller = further away) and back
        const aim = Math.atan2(w / 2 - gx, gy - h / 2) + 0.34;   // the art leans 0.34 rad left at rest
        rot = aim * Math.min(1, e * 1.6); gx += (w / 2 - gx) * 0.45 * e; gy += (h / 2 - gy) * 0.5 * e; sc = 1 - 0.22 * e;
      }
      else if (swingKind === 'ranged') { gx += w * 0.03 * e; gy += h * 0.04 * e; }             // recoil
      else { sc = 1 + 0.12 * e; gy -= h * 0.06 * e; }                                         // spell thrust
    }
    ctx.translate(gx, gy);                                        // pivot on the grip
    ctx.rotate(rot); ctx.scale(sc * sc0, sc * sc0);
    ctx.filter = light < 0.98 ? `brightness(${(0.35 + 0.65 * light).toFixed(2)})` : 'none';
    ctx.drawImage(img, -VM.gx, -VM.gy);
    ctx.filter = 'none';
    if (swingKind === 'spell' && k >= 0 && k < 1) {                 // a magic glow on the cast
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.6 * ease(k);
      ctx.drawImage(img, -VM.gx, -VM.gy);
    }
  }
  ctx.restore();
}
