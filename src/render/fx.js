// render/fx.js — cosmetic effects driven by bus events.
// Floating damage numbers, hit flashes, pixel-square particles (leaves, chips, dust, embers, sparkles, coins),
// spell bolts, ring bursts, "LEVEL n", screen shake / flash / death wash.
//
// Rules: never mutates game state, never throws (every handler and draw is wrapped), <= MAX_FX live entries
// (oldest dropped, text last), everything expires so fxActive() goes false when idle.
// Particles live in TILE / ART space (fractional tile x,y + art-px offset + lift) and are projected each frame
// with view.toScreen so they stay anchored while the camera moves. Everything is drawn as integer pixel squares
// in palette colours; no anti-aliased circles. Layers: 'world' (before lighting) and 'overlay' (after, readable).
import { on } from '../core/bus.js';
import { G } from '../core/state.js';
import { PAL, UI } from '../core/config.js';
import { heightAt, terr, isVis } from '../world/world.js';
import { TERRAIN } from '../data/terrain.js';

const MAX_FX = 200;
const MAX_TEXTS = 7;
const DT_MAX = 50;
const FONT = '"Titan One", system-ui, -apple-system, "Segoe UI", sans-serif';

// ---- state ------------------------------------------------------------------------------------------------
let inited = false, unsubs = [];
let list = [];                       // every live entry: particles 'p', texts 't', bolts 'b'
const flashRecs = [];                // {e, t, dur}
const flashMap = new WeakMap();      // entity -> rec
const stackMap = new Map();          // "x,y" -> {n, t} floating-number stacking
let clock = 0;                       // accumulated ms (deterministic time for hashes)
let lastS = 3;                       // last render scale, for shake -> device px
const shk = { t: 0, dur: 0, amp: 0 };
const screenFlash = { t: 0, dur: 1, a: 0 };
const lvlText = { t: -1, dur: 1700, lvl: 0 };
const deathFx = { t: -1 };
const nukeFx = { t: -1, dur: 1500 };   // the nuke's full-screen white-then-orange wash
let emberAcc = 0, burning = false;

// ---- small utils -------------------------------------------------------------------------------------------
const fin = v => typeof v === 'number' && isFinite(v);
const rnd = (a = 1, b) => b === undefined ? Math.random() * a : a + Math.random() * (b - a);
const pick = a => a[Math.floor(Math.random() * a.length)];
const hero = () => (G && G.P ? G.P : null);

/** Lighten (k>0) or darken (k<0) a #rrggbb colour; any other colour string is returned untouched. */
function shade(c, k) {
  if (typeof c !== 'string' || !/^#[0-9a-f]{6}$/i.test(c)) return c;
  const n = parseInt(c.slice(1), 16), t = k < 0 ? 0 : 255, p = Math.abs(k);
  const f = v => Math.round(v + (t - v) * p);
  return '#' + ((1 << 24) | (f(n >> 16 & 255) << 16) | (f(n >> 8 & 255) << 8) | f(n & 255)).toString(16).slice(1);
}
const colOf = (c, fb) => (typeof c === 'string' && c ? c : fb);
const safe = fn => (...a) => { try { fn(...a); } catch (e) { /* cosmetic only */ } };

/** Tile for an event payload: explicit {x,y}, else the given fallback entity, else the hero. */
function tileOf(o, fb) {
  if (o && fin(o.x) && fin(o.y)) return { x: o.x, y: o.y };
  if (fb && fin(fb.x) && fin(fb.y)) return { x: fb.x, y: fb.y };
  const h = hero();
  return h ? { x: h.x, y: h.y } : null;
}

function add(p) {
  p.t = 0;
  if (p.life === undefined) p.life = 600;
  p.ox = p.ox || 0; p.lift = p.lift || 0; p.vx = p.vx || 0; p.vl = p.vl || 0; p.g = p.g || 0;
  if (p.L === undefined) p.L = 'w';
  if (p.k === undefined) p.k = 'p';
  if (p.sz === undefined) p.sz = 1.5;
  p.seed = Math.random() * 6.28;
  if (list.length >= MAX_FX) {
    let i = list.findIndex(q => q.k !== 't');
    if (i < 0) i = 0;
    list.splice(i, 1);
  }
  list.push(p);
  return p;
}

/** Radial burst of pixel squares. */
function burst(t, o) {
  if (!t) return;
  const n = o.n || 8, cols = o.cols || [PAL.iron];
  for (let i = 0; i < n; i++) {
    const a = rnd(Math.PI * 2), s = rnd(0.4, 1) * (o.spd || 40);
    add({
      tx: t.x, ty: t.y, lift: o.lift === undefined ? 8 : o.lift + rnd(-2, 2), ox: rnd(-2, 2),
      vx: Math.cos(a) * s, vl: Math.sin(a) * s * (o.flat === undefined ? 0.7 : o.flat) + (o.up || 0),
      g: o.g === undefined ? 90 : o.g, drag: o.drag === undefined ? 0.5 : o.drag,
      life: (o.life || 500) * rnd(0.7, 1.2), col: pick(cols), sz: o.sz || 1.5, L: o.L || 'w', floor: !!o.floor, tw: !!o.tw,
    });
  }
}

/** Ring of dots that expand along an iso-flattened ellipse (orbit with fixed phase). */
function ring(t, o) {
  if (!t) return;
  const n = o.n || 16, cols = o.cols || ['#fff'];
  for (let i = 0; i < n; i++) {
    add({
      tx: t.x, ty: t.y, orb: { a: (i / n) * Math.PI * 2 + rnd(0.2), w: o.w || 0, r: o.r0 || 3, vr: (o.vr || 50) * rnd(0.85, 1.1), cl: o.lift || 8, vl: o.vl || 0 },
      life: o.life || 600, col: pick(cols), sz: o.sz || 1.5, L: o.L || 'w', tw: !!o.tw,
    });
  }
}

/** Floating number / word over a tile. opts: col, size (art px), crit, life, lift. */
function text(t, str, o = {}) {
  if (!t) return;
  const key = Math.round(t.x) + ',' + Math.round(t.y), now = clock;
  let s = stackMap.get(key);
  if (!s || now - s.t > 500) s = { n: 0, t: now }; else { s.n++; s.t = now; }
  stackMap.set(key, s);
  if (stackMap.size > 64) stackMap.clear();
  // cap live floating texts: drop the oldest so numbers never pile up into a smear
  let live = 0, oldest = -1;
  for (let i = 0; i < list.length; i++) if (list[i].k === 't') { live++; if (oldest < 0) oldest = i; }
  if (live >= MAX_TEXTS && oldest >= 0) list.splice(oldest, 1);
  // stagger successive numbers on one tile: sideways (away from the face) and in clear vertical steps
  const offs = (o.side || 0) + [0, -9, 9, -5, 6][s.n % 5];
  const lift = (o.lift || 52) + (s.n % 4) * 6;
  add({
    k: 't', L: 'o', tx: t.x, ty: t.y, ox: offs, lift, base: lift,
    life: o.life || 900, txt: String(str), col: o.col || '#fff', size: o.size || 7, crit: !!o.crit, rise: o.rise === undefined ? 14 : o.rise,
  });
}

function flash(e, dur) {
  if (!e || typeof e !== 'object') return;
  let r = flashMap.get(e);
  if (!r) { r = { e, t: 0, dur }; flashMap.set(e, r); flashRecs.push(r); }
  r.t = 0; r.dur = dur;
}

function shakeAdd(amp, dur) {
  const cur = shk.dur > 0 ? shk.amp * Math.max(0, 1 - shk.t / shk.dur) : 0;
  if (amp < cur) return;
  shk.amp = Math.min(4, amp); shk.dur = dur; shk.t = 0;
}

// ---- event handlers ----------------------------------------------------------------------------------------
const HIT_COL = { spell: '#ffb347', burn: '#ffb347', bleed: '#ff7a8a', dog: '#e8d2a6', poison: '#99ff55' };

function onHit(e) {
  if (!e) return;
  const m = e.mon, t = tileOf(e, m); if (!t) return;
  if (fin(e.dmg)) {
    const crit = !!e.crit;
    text(t, crit ? e.dmg + '!' : e.dmg, { lift: m && m.boss ? 82 : 52, side: 6, col: crit ? '#ffd23f' : (HIT_COL[e.kind] || '#fff'), size: crit ? 10 : 7, crit, life: crit ? 1000 : 900 });
  }
  flash(m, 150);
  burst(t, { n: e.crit ? 9 : 5, cols: e.crit ? ['#ffd23f', '#fff', '#ffb347'] : ['#fff', '#ffe9a8', HIT_COL[e.kind] || '#fff'], lift: 14, spd: 50, g: 60, life: 280, sz: 1, L: 'o' });
}

function onHurt(e) {
  const h = hero(); if (!h) return;
  e = e || {};
  const t = tileOf(e, h), d = fin(e.dmg) ? e.dmg : 0;
  if (fin(e.dmg)) text(t, e.dmg, { col: UI.bad, size: 8, lift: 54, side: -10 });
  flash(h, 220);
  if (!(e.kind === 'poison' && d < 2) && d > 0) shakeAdd(Math.min(3.2, 1.6 + d * 0.12), 150);
  burst(t, { n: 4, cols: [UI.bad, '#ff9aa6'], lift: 14, spd: 36, g: 80, life: 300, sz: 1, L: 'o' });
}

const MISS_WORD = { ghost: 'miss', phased: 'miss', obsidian: 'immune', immune: 'immune', flit: 'dodged', dodged: 'dodged' };
function onMiss(e) {
  e = e || {};
  const t = tileOf(e); if (!t) return;
  text(t, MISS_WORD[e.why] || 'miss', { col: '#b8b0c8', size: 6, life: 800, rise: 10, lift: 52 });
}

function onHeal(e) {
  const h = hero(); if (!h) return;
  e = e || {};
  const t = { x: h.x, y: h.y };
  if (fin(e.amount) && e.amount > 0) text(t, '+' + e.amount, { col: UI.good, size: 8, lift: 54, side: 10 });
  for (let i = 0; i < 10; i++) add({ tx: t.x, ty: t.y, ox: rnd(-8, 8), lift: rnd(2, 12), vl: rnd(14, 34), life: rnd(500, 850), col: pick([UI.good, '#d6ffd9', '#fff']), sz: 1.5, L: 'o', tw: true });
}

function onKill(e) {
  const m = e && e.mon; if (!m) return;
  const t = tileOf(m); if (!t) return;
  const c = colOf(m.col, '#cccccc');
  burst(t, { n: Math.round(rnd(8, 12)), cols: [c, c, shade(c, 0.3), shade(c, -0.3)], lift: 8, spd: 55, g: 70, life: 650, sz: 2 });
  burst(t, { n: 4, cols: ['#d9d3e6', '#9b93ad'], lift: 6, spd: 24, g: -10, life: 600, sz: 2.5, flat: 0.4 });
  if (fin(m.xp) && m.xp > 0) text(t, '+' + m.xp + ' XP', { col: UI.sun, size: 6.5, lift: 60, life: 1100 });
}

function onLevel(e) {
  const h = hero(); if (!h) return;
  const t = { x: h.x, y: h.y };
  ring(t, { n: 24, cols: [UI.sun, '#ff7ac8', '#fff', UI.sun], vr: 70, r0: 4, w: 1.2, lift: 12, vl: 12, life: 800, sz: 2, L: 'o', tw: true });
  burst(t, { n: 10, cols: [UI.sun, '#ff7ac8'], lift: 10, spd: 35, up: 30, g: 40, life: 800, sz: 1.5, L: 'o', tw: true });
  lvlText.t = 0; lvlText.lvl = e && fin(e.lvl) ? e.lvl : (h.lvl || 1);
  screenFlash.t = 0; screenFlash.dur = 420; screenFlash.a = 0.22;
}

function onPickup(e) {
  const h = hero(); if (!h) return;
  const it = (e && e.item) || {}, t = { x: h.x, y: h.y };
  const gold = it.kind === 'gold', c = gold ? PAL.gold : colOf(it.col, '#fff');
  const cols = gold ? [PAL.gold, UI.sun, '#fff'] : [c, '#fff', shade(c, 0.4)];
  for (let i = 0; i < (gold ? 8 : 6); i++) add({ tx: t.x, ty: t.y, ox: rnd(-7, 7), lift: rnd(4, 18), vl: rnd(8, 26), life: rnd(380, 650), col: pick(cols), sz: gold ? 1.5 : 1, L: 'o', tw: true });
}

function onDrop(e) {
  e = e || {};
  const t = tileOf(e); if (!t) return;
  const c = colOf(e.item && e.item.col, PAL.gold);
  for (let i = 0; i < 4; i++) add({ tx: t.x, ty: t.y, ox: rnd(-5, 5), lift: rnd(2, 10), vl: rnd(4, 12), life: rnd(350, 600), col: pick(['#fff', c, UI.sun]), sz: 1, tw: true });
}

const STONE = new Set(['rock', 'srock', 'wall', 'pwall', 'pyr']);
function onTerrain(e) {
  if (!e) return;
  const t = tileOf(e); if (!t) return;
  const from = e.from, to = e.to;
  if (to === 'water' || to === 'deep' || to === 'bogw') return;
  if (from === 'tree' || from === 'dtree') {
    const cols = from === 'tree' ? ['#2E6B1E', '#5FA83A', '#3E8E2E', '#7FB238', PAL.bark, PAL.stump] : [PAL.deadwood, PAL.bark, PAL.stump, '#7a6038'];
    for (let i = 0; i < 12; i++) add({ tx: t.x, ty: t.y, ox: rnd(-9, 9), lift: rnd(14, 36), vx: rnd(-14, 14), vl: rnd(-6, 8), g: 28, drag: 1.2, life: rnd(900, 1400), col: pick(cols), sz: 2, floor: true, sway: rnd(6, 14) });
  } else if (STONE.has(from)) {
    const base = (TERRAIN[from] && TERRAIN[from].color) || PAL.stone;
    burst(t, { n: 10, cols: [base, shade(base, 0.25), shade(base, -0.3)], lift: 10, spd: 50, up: 18, g: 150, life: 700, sz: 2, floor: true });
    burst(t, { n: 6, cols: ['#cfc8b8', '#a39d90', '#e3dccb'], lift: 6, spd: 22, g: -8, life: 800, sz: 2.5, flat: 0.4 });
  } else if (from && to) {
    const base = (TERRAIN[from] && TERRAIN[from].color) || '#bbb';
    burst(t, { n: 5, cols: [base, shade(base, 0.2)], lift: 8, spd: 30, g: 120, life: 450, sz: 1.5, floor: true });
  }
}

function onWork(e) {
  const t = tileOf(e); if (!t) return;
  let c = PAL.stone, key = '';
  try { const d = terr(t.x, t.y); if (d) { c = d.color || c; key = d.key; } } catch (er) { /* ignore */ }
  const n = Math.random() < 0.5 ? 1 : 2, leaf = key === 'tree' || key === 'dtree';
  const cols = leaf ? (key === 'tree' ? ['#2E6B1E', '#5FA83A', PAL.bark] : [PAL.deadwood, PAL.bark]) : [c, shade(c, 0.25), shade(c, -0.25)];
  for (let i = 0; i < n; i++) add({ tx: t.x, ty: t.y, ox: rnd(-5, 5), lift: rnd(10, 22), vx: rnd(-26, 26), vl: rnd(10, 34), g: leaf ? 60 : 160, drag: leaf ? 1 : 0.3, life: rnd(400, 700), col: pick(cols), sz: leaf ? 2 : 1.5, floor: true });
  shakeAdd(0.7, 70);
}

function onSpell(e) {
  const h = hero(); if (!h) return;
  e = e || {};
  const from = tileOf(e.from), to = tileOf(e.to), id = String(e.id || '');
  if (!from || !to) return;
  if (id === 'bolt') {
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    add({ k: 'b', L: 'o', fx: from.x, fy: from.y, tx: from.x, ty: from.y, ex: to.x, ey: to.y, life: dist < 0.5 ? 120 : 220, lift: 12, trail: 0, col: '#ff8a1c', pal: FIRE_PAL });
  } else if (id === 'heal') {
    for (let i = 0; i < 12; i++) add({ tx: to.x, ty: to.y, ox: rnd(-9, 9), lift: rnd(0, 14), vl: rnd(14, 38), life: rnd(500, 900), col: pick([UI.good, '#d6ffd9', '#fff', '#4fe872']), sz: 1.5, L: 'o', tw: true });
  } else if (id === 'root') {
    for (let i = 0; i < 9; i++) add({ tx: to.x, ty: to.y, ox: rnd(-9, 9), lift: 0, vl: rnd(30, 60), g: 90, drag: 0.8, life: rnd(500, 800), col: pick(['#6E5238', '#866043', '#4a8a2a', '#5FA83A']), w: 1.5, h: rnd(3, 6), sz: 1.5 });
    burst(to, { n: 5, cols: ['#5FA83A', '#3E8E2E'], lift: 4, spd: 24, g: 80, life: 500, sz: 1.5, floor: true });
  } else if (id === 'mez') {
    for (let i = 0; i < 14; i++) add({ tx: to.x, ty: to.y, orb: { a: rnd(6.28), w: rnd(4, 6) * (i % 2 ? 1 : -1), r: rnd(5, 9), vr: -3, cl: 12 + (i % 5) * 3, vl: 8 }, life: rnd(700, 1000), col: pick(['#8f7bff', '#b79bff', '#5b8cff', '#fff']), sz: 1.5, L: 'o', tw: true });
  } else if (id === 'paper') {
    const dx = (to.x - from.x) - (to.y - from.y), n = 8;     // iso screen direction of the throw
    for (let i = 0; i < n; i++) {
      const a = rnd(6.28), s = rnd(40, 80), bias = (dx === 0 && from === to) ? 0 : Math.sign(dx) * 20;
      add({ tx: from.x, ty: from.y, lift: 16, vx: Math.cos(a) * s + bias, vl: Math.sin(a) * s * 0.5 + 10, g: 40, drag: 1.2, life: rnd(600, 900), col: pick(['#ffffff', '#f2eee0', '#e6e0cc']), w: 3, h: 4, L: 'o' });
    }
  } else if (id === 'sow') {
    for (let i = 0; i < 8; i++) add({ tx: from.x, ty: from.y, ox: rnd(-4, 8), lift: rnd(2, 20), vx: rnd(-130, -80), life: rnd(220, 380), col: pick([UI.sun, '#fff3b0', UI.orange]), w: rnd(4, 8), h: 1, L: 'o' });
  } else if (id === 'feign') {
    burst(from, { n: 12, cols: ['#9b93ad', '#b8b0c8', '#7f7894'], lift: 6, spd: 30, g: -6, life: 800, sz: 2.5, flat: 0.5 });
  } else if (id === 'gate') {
    for (let i = 0; i < 22; i++) add({ tx: from.x, ty: from.y, ox: rnd(-6, 6), lift: rnd(0, 6), vl: rnd(40, 90), life: rnd(600, 1100), col: pick(['#8fd3ff', '#ffffff', '#5b8cff', '#d6efff']), sz: 1.5, L: 'o', tw: true });
  } else {
    for (let i = 0; i < 8; i++) add({ tx: to.x, ty: to.y, ox: rnd(-8, 8), lift: rnd(2, 16), vl: rnd(8, 24), life: rnd(400, 700), col: pick(['#fff', UI.sun, '#8fd3ff']), sz: 1.5, L: 'o', tw: true });
  }
}

// ---- potions (v0.3) ----------------------------------------------------------------------------------------------
const FIRE_PAL = { trail: ['#ff8a1c', '#ffd23f', '#ff3a1a', '#7a2a10'], pop: ['#ff8a1c', '#ffd23f', '#fff', '#ff3a1a'], smoke: ['#4a3a30', '#7a6a60'], core: '#ffe9a8' };
const POISON_PAL = { trail: ['#99ff55', '#3fd46b', '#d6ffd9', '#5f9f2a'], pop: ['#99ff55', '#3fd46b', '#fff', '#c8ff9a'], smoke: ['#3e6e3a', '#6a8a5a'], core: '#e8ffd8' };

/** 'potion': a gulp of coloured bubbles when drunk; a lobbed, spinning bottle (a green bolt) when thrown. */
function onPotion(e) {
  e = e || {};
  const h = hero(); if (!h) return;
  if (e.by === 'throw') {
    const from = tileOf(e.from, h), to = tileOf(e.to); if (!from || !to) return;
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    add({ k: 'b', L: 'o', fx: from.x, fy: from.y, tx: from.x, ty: from.y, ex: to.x, ey: to.y, life: dist < 0.5 ? 140 : 260, lift: 12, trail: 0, col: '#99ff55', pal: POISON_PAL, arc: 14 });
    return;
  }
  const t = { x: h.x, y: h.y };
  let c = '#ff7a8a';
  try { if (G.run && G.run.pot && G.run.pot.colors[e.pot]) c = G.run.pot.colors[e.pot].col; } catch (er) { /* default */ }
  for (let i = 0; i < 9; i++) add({ tx: t.x, ty: t.y, ox: rnd(-5, 5), lift: rnd(16, 26), vl: rnd(10, 30), vx: rnd(-6, 6), g: -4, life: rnd(400, 750), col: pick([c, shade(c, 0.4), '#fff']), sz: i % 3 ? 1.5 : 2, L: 'o', tw: true });
  if (e.first) text(t, '?!', { col: c, size: 8, lift: 64, life: 1000 });
}

/** 'nuke': a white-out, a fireball, a mushroom column and two shockwave rings sized to the 21 x 21 blast. */
function onNuke(e) {
  e = e || {};
  const t = tileOf(e); if (!t) return;
  const r = fin(e.r) ? e.r : 10, R = r * 32;     // a Chebyshev square of radius r is an iso diamond 32r art px wide each side
  nukeFx.t = 0; nukeFx.dur = 1500;
  shakeAdd(4, 900);
  // shockwave rings (iso-flattened ellipses that reach the blast's corners)
  ring(t, { n: 30, cols: ['#ffffff', '#fff3b0', UI.sun], vr: R / 0.55, r0: 6, w: 0, lift: 2, life: 560, sz: 2.5, L: 'o' });
  ring(t, { n: 24, cols: [UI.orange, '#ff3a1a', UI.sun], vr: R / 0.85, r0: 4, w: 0, lift: 1, life: 860, sz: 2.5, L: 'o' });
  ring(t, { n: 16, cols: ['#9b93ad', '#d9d3e6', '#7f7894'], vr: R / 1.3, r0: 4, w: 0, lift: 0, life: 1300, sz: 3, L: 'w' });
  // fireball
  burst(t, { n: 26, cols: ['#fff', '#fff3b0', UI.sun, UI.orange, '#ff3a1a'], lift: 18, spd: 120, up: 30, g: 30, drag: 1.2, life: 900, sz: 3, L: 'o' });
  // the mushroom: a rising stem, then a cap that spreads
  for (let i = 0; i < 20; i++) add({ tx: t.x, ty: t.y, ox: rnd(-4, 4), lift: rnd(4, 20), vl: rnd(50, 110), vx: rnd(-6, 6), g: -10, drag: 1.4, life: rnd(1100, 1700), col: pick([UI.orange, '#ff3a1a', '#ffb347', '#7a2a10', '#4a3a30']), sz: rnd(2, 3.5), L: 'o' });
  for (let i = 0; i < 16; i++) { const a = rnd(Math.PI * 2); add({ tx: t.x, ty: t.y, ox: Math.cos(a) * 4, lift: 70 + rnd(-6, 6), vx: Math.cos(a) * rnd(30, 60), vl: Math.sin(a) * rnd(5, 15) + 8, g: 4, drag: 1.1, life: rnd(1200, 1800), col: pick(['#9b93ad', '#d9d3e6', '#ffb347', '#7f7894']), sz: rnd(2.5, 4), L: 'o' }); }
  text(t, 'BOOM', { col: UI.sun, size: 14, lift: 90, life: 1400, rise: 20, crit: true });
}

/** 'teleport': you dissolve upward at the old spot and condense downward at the new one. */
function onTeleport(e) {
  e = e || {};
  const from = e.from && fin(e.from.x) ? e.from : null, to = e.to && fin(e.to.x) ? e.to : null;
  const cols = ['#8fd3ff', '#ffffff', '#b79bff', '#ff7ac8'];
  if (from) for (let i = 0; i < 18; i++) add({ tx: from.x, ty: from.y, ox: rnd(-6, 6), lift: rnd(0, 20), vl: rnd(40, 90), life: rnd(500, 900), col: pick(cols), sz: 1.5, L: 'o', tw: true });
  if (to) {
    for (let i = 0; i < 20; i++) add({ tx: to.x, ty: to.y, ox: rnd(-8, 8), lift: rnd(40, 70), vl: rnd(-70, -30), g: -10, life: rnd(450, 800), col: pick(cols), sz: 1.5, L: 'o', tw: true });
    ring(to, { n: 18, cols, vr: 60, r0: 2, w: 0, lift: 1, life: 600, sz: 1.5, L: 'o' });
  }
  screenFlash.t = 0; screenFlash.dur = 300; screenFlash.a = 0.18;
}

function onStatus(e) {
  e = e || {};
  const m = e.mon, h = hero(), who = m || h; if (!who) return;
  const t = tileOf(m || null, h); if (!t) return;
  switch (e.kind) {
    case 'burn': for (let i = 0; i < 7; i++) add({ tx: t.x, ty: t.y, ox: rnd(-6, 6), lift: rnd(4, 14), vl: rnd(14, 36), life: rnd(400, 700), col: pick([UI.orange, '#ff3a1a', UI.sun]), sz: 1.5, L: 'o' }); break;
    case 'bleed': for (let i = 0; i < 6; i++) add({ tx: t.x, ty: t.y, ox: rnd(-6, 6), lift: rnd(10, 20), vx: rnd(-10, 10), vl: rnd(0, 20), g: 140, life: rnd(350, 550), col: pick(['#d0312d', '#a02020', '#ff5d6c']), sz: 1.5, L: 'o', floor: true }); break;
    case 'stun': for (let i = 0; i < 4; i++) add({ tx: t.x, ty: t.y, orb: { a: (i / 4) * 6.28, w: 5, r: 7, vr: 0, cl: 30, vl: 0 }, life: 900, col: UI.sun, sz: 2, L: 'o', tw: true }); break;
    case 'poison': for (let i = 0; i < 6; i++) add({ tx: t.x, ty: t.y, ox: rnd(-6, 6), lift: rnd(4, 12), vl: rnd(10, 26), life: rnd(500, 850), col: pick(['#7dff8a', '#3fd46b', '#a8ff6a']), sz: 2, L: 'o' }); break;
    case 'root': for (let i = 0; i < 6; i++) add({ tx: t.x, ty: t.y, ox: rnd(-8, 8), lift: 0, vl: rnd(24, 46), g: 80, drag: 0.8, life: rnd(450, 700), col: pick(['#6E5238', '#4a8a2a', '#5FA83A']), w: 1.5, h: rnd(3, 5) }); break;
    case 'mez': for (let i = 0; i < 6; i++) add({ tx: t.x, ty: t.y, orb: { a: rnd(6.28), w: 5, r: 7, vr: -3, cl: 22, vl: 4 }, life: 800, col: pick(['#8f7bff', '#b79bff', '#5b8cff']), sz: 1.5, L: 'o', tw: true }); break;
    case 'paper': for (let i = 0; i < 4; i++) add({ tx: t.x, ty: t.y, lift: 22, vx: rnd(-30, 30), vl: rnd(5, 30), g: 40, drag: 1.2, life: 700, col: '#fff', w: 3, h: 4, L: 'o' }); break;
    default: burst(t, { n: 5, cols: ['#fff', UI.sun], lift: 16, spd: 28, g: 20, life: 400, sz: 1.5, L: 'o' });
  }
}

function onChest(e) {
  const h = hero(); if (!h) return;
  const t = { x: h.x, y: h.y };
  for (let i = 0; i < 20; i++) add({ tx: t.x, ty: t.y, ox: rnd(-10, 10), lift: rnd(28, 50), vx: rnd(-18, 18), vl: rnd(-10, 14), g: 130, drag: 0.4, life: rnd(700, 1100), col: pick([PAL.gold, UI.sun, '#fff3b0', '#c9962a']), sz: i % 3 ? 1.5 : 2, L: 'o', floor: true, tw: true });
  burst(t, { n: 8, cols: [UI.sun, '#fff'], lift: 14, spd: 40, g: 40, life: 500, sz: 1, L: 'o', tw: true });
  if (e && fin(e.gold) && e.gold > 0) text(t, '+' + e.gold + ' gold', { col: PAL.gold, size: 7.5, lift: 56, life: 1100 });
}

function onDeath() {
  const h = hero();
  if (h) {
    const t = { x: h.x, y: h.y };
    flash(h, 700);
    burst(t, { n: 30, cols: ['#9b93ad', '#ff7ac8', '#d9d3e6', '#ff9aa6', '#6b5f86'], lift: 14, spd: 70, up: 10, g: 60, life: 1100, sz: 2, L: 'o' });
  }
  shakeAdd(4, 520);
  deathFx.t = 0;
}

function onMoved(e) {
  if (!e || !e.to || !fin(e.to.x) || !fin(e.to.y)) return;
  const d = terr(e.to.x, e.to.y);
  if (!d || d.kind !== 'liquid') return;
  const t = { x: e.to.x, y: e.to.y }, cols = d.deep ? ['#5b8cff', '#8fd3ff', '#fff'] : ['#8fd3ff', '#cfe8ff', '#fff'];
  ring(t, { n: 10, cols, vr: 26, r0: 2, w: 0, lift: 0, life: 520, sz: 1.5 });
  burst(t, { n: 6, cols, lift: 2, spd: 30, up: 24, g: 140, life: 450, sz: 1.5 });
}

function resetAll() {
  list = []; flashRecs.length = 0; stackMap.clear();
  shk.t = shk.dur = 0; screenFlash.a = 0; screenFlash.t = 0; lvlText.t = -1; deathFx.t = -1; nukeFx.t = -1;
}

// ---- public API ---------------------------------------------------------------------------------------------
/** Subscribe to the bus. Safe to call twice. */
export function initFx() {
  if (inited) return;
  inited = true;
  const sub = (ev, fn) => unsubs.push(on(ev, safe(fn)));
  sub('hit', onHit); sub('hurt', onHurt); sub('miss', onMiss); sub('heal', onHeal); sub('kill', onKill);
  sub('levelup', onLevel); sub('pickup', onPickup); sub('drop', onDrop); sub('terrain', onTerrain);
  sub('work', onWork); sub('spell', onSpell); sub('status', onStatus); sub('chest', onChest);
  sub('death', onDeath); sub('moved', onMoved);
  sub('potion', onPotion); sub('nuke', onNuke); sub('teleport', onTeleport);
  sub('newgame', resetAll); sub('loaded', resetAll);
}

function burnEmbers() {
  burning = false;
  const ms = G && G.mons; if (!ms) return;
  for (const m of ms) {
    if (!m || !(m.burn > 0) || !fin(m.x) || !fin(m.y)) continue;
    let vis = true; try { vis = isVis(m.x, m.y); } catch (e) { /* ignore */ }
    if (!vis) continue;
    burning = true;
    add({ tx: m.x, ty: m.y, ox: rnd(-5, 5), lift: rnd(6, 16), vl: rnd(14, 30), vx: rnd(-4, 4), life: rnd(420, 700), col: pick([UI.orange, '#ff3a1a', UI.sun]), sz: 1.5, L: 'o' });
  }
}

/** Advance all effects by dt ms (clamped to 50). */
export function updateFx(dt) {
  try {
    dt = fin(dt) ? Math.max(0, Math.min(DT_MAX, dt)) : 16;
    clock += dt;
    const s = dt / 1000;
    // timers
    if (shk.dur > 0) { shk.t += dt; if (shk.t >= shk.dur) shk.dur = 0; }
    if (screenFlash.a > 0) { screenFlash.t += dt; if (screenFlash.t >= screenFlash.dur) screenFlash.a = 0; }
    if (lvlText.t >= 0) { lvlText.t += dt; if (lvlText.t > lvlText.dur) lvlText.t = -1; }
    if (deathFx.t >= 0) { deathFx.t += dt; if (deathFx.t > 5000) deathFx.t = -1; }
    if (nukeFx.t >= 0) { nukeFx.t += dt; if (nukeFx.t > nukeFx.dur) nukeFx.t = -1; }
    for (let i = flashRecs.length - 1; i >= 0; i--) {
      const r = flashRecs[i]; r.t += dt;
      if (r.t >= r.dur) { flashMap.delete(r.e); flashRecs.splice(i, 1); }
    }
    emberAcc += dt;
    if (emberAcc >= 120) { emberAcc = 0; burnEmbers(); }
    // entries
    const born = [];
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      p.t += dt;
      if (p.t >= p.life && p.k !== 'b') { list.splice(i, 1); continue; }
      if (p.k === 'b') {
        const f = Math.min(1, p.t / p.life);
        p.tx = p.fx + (p.ex - p.fx) * f; p.ty = p.fy + (p.ey - p.fy) * f; p.lift = 12 + Math.sin(f * Math.PI) * (p.arc || 5);
        p.trail += dt;
        while (p.trail >= 22) {
          p.trail -= 22;
          born.push({ tx: p.tx, ty: p.ty, ox: rnd(-1.5, 1.5), lift: p.lift + rnd(-1.5, 1.5), vl: rnd(-6, 6), life: rnd(220, 380), col: pick((p.pal || FIRE_PAL).trail), sz: rnd(1, 2), L: 'o' });
        }
        if (f >= 1) {
          const t = { x: p.ex, y: p.ey };
          list.splice(i, 1);
          burst(t, { n: 14, cols: (p.pal || FIRE_PAL).pop, lift: 12, spd: 70, g: 80, life: 420, sz: 2, L: 'o' });
          burst(t, { n: 5, cols: (p.pal || FIRE_PAL).smoke, lift: 10, spd: 22, g: -6, life: 600, sz: 2.5, L: 'o', flat: 0.4 });
        }
        continue;
      }
      if (p.k === 't') {
        const f = Math.min(1, p.t / p.life);
        p.lift = p.base + p.rise * (1 - (1 - f) * (1 - f));
        continue;
      }
      if (p.orb) {
        const o = p.orb;
        o.a += o.w * s; o.r = Math.max(0, o.r + o.vr * s); o.cl += o.vl * s;
        p.ox = Math.cos(o.a) * o.r; p.lift = o.cl + Math.sin(o.a) * o.r * 0.5;
        continue;
      }
      if (p.drag) { const k = Math.max(0, 1 - p.drag * s); p.vx *= k; if (p.g >= 0 && !p.floor) p.vl *= (1 - p.drag * s * 0.3); }
      if (p.sway) p.ox += Math.sin(clock * 0.008 + p.seed) * p.sway * s;
      p.ox += p.vx * s; p.lift += p.vl * s; p.vl -= p.g * s;
      if (p.floor && p.lift <= 0 && p.g > 0) {
        p.lift = 0; p.vx = 0; p.vl = 0; p.g = 0; p.sway = 0;
        if (p.life - p.t > 260) p.life = p.t + 260;
      }
    }
    for (const b of born) add(b);
  } catch (e) { /* cosmetic only */ }
}

// ---- drawing ------------------------------------------------------------------------------------------------
function project(view, p) {
  let z = 0;
  try { z = Math.max(0, heightAt(Math.round(p.tx), Math.round(p.ty)) || 0); } catch (e) { /* ignore */ }
  const c = view.toScreen(p.tx, p.ty, z), k = c.k || view.S;   // k: art px -> device px at that depth (3D view)
  return { x: c.x + p.ox * k, y: c.y - p.lift * k };
}

function drawText(ctx, view, p) {
  const S = view.S, c = project(view, p), f = p.t / p.life;
  const a = f > 0.66 ? Math.max(0, 1 - (f - 0.66) / 0.34) : 1;
  const bump = p.crit ? 1 + 0.5 * Math.max(0, 1 - p.t / 180) : 1;
  const size = Math.max(10, Math.round(p.size * S * bump));
  ctx.globalAlpha = a;
  ctx.font = `${size}px ${FONT}`;
  const x = Math.round(c.x), y = Math.round(c.y);
  // the title logo's treatment: plum drop shadow, fat accent stroke, thin dark inner stroke, gradient fill
  const acc = p.crit ? UI.line : UI.orange, sh = Math.max(1, Math.round(size * 0.06));
  ctx.lineWidth = Math.max(3, Math.round(size * 0.3));
  ctx.strokeStyle = '#2a0a3a'; ctx.strokeText(p.txt, x + sh, y + sh * 1.5);
  ctx.strokeStyle = acc; ctx.strokeText(p.txt, x, y);
  ctx.lineWidth = Math.max(2, Math.round(size * 0.13));
  ctx.strokeStyle = '#2a0a3a'; ctx.strokeText(p.txt, x, y);
  const g = ctx.createLinearGradient(0, y - size / 2, 0, y + size / 2);
  g.addColorStop(0, shade(p.col, 0.55)); g.addColorStop(0.55, p.col); g.addColorStop(1, shade(p.col, -0.15));
  ctx.fillStyle = g; ctx.fillText(p.txt, x, y);
}

/** Draw effects. layer 'world' | 'overlay'. Restores ctx state. */
export function drawFx(ctx, view, layer) {
  if (!ctx || !view) return;
  ctx.save();
  try {
    if (fin(view.S) && view.S > 0) lastS = view.S;
    const S = view.S, over = layer === 'overlay', want = over ? 'o' : 'w';
    ctx.setLineDash && ctx.setLineDash([]);
    ctx.globalCompositeOperation = 'source-over';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round'; ctx.miterLimit = 2;
    // particles + bolts
    for (const p of list) {
      if (p.L !== want || p.k === 't') continue;
      const c = project(view, p), r = 1 - p.t / p.life;
      let a = p.k === 'b' ? 1 : (r < 0.35 ? r / 0.35 : 1);
      if (p.tw) a *= 0.55 + 0.45 * Math.sin(p.t * 0.03 + p.seed * 3);
      if (a <= 0.02) continue;
      ctx.globalAlpha = Math.min(1, a);
      if (p.k === 'b') {
        const u = Math.max(2, Math.round(2 * S));
        ctx.fillStyle = PAL.outline; ctx.fillRect(Math.round(c.x - u * 1.5), Math.round(c.y - u * 1.5), u * 3, u * 3);
        ctx.fillStyle = p.col || '#ff8a1c'; ctx.fillRect(Math.round(c.x - u * 1.5 + u * 0.3), Math.round(c.y - u * 1.5 + u * 0.3), Math.round(u * 2.4), Math.round(u * 2.4));
        ctx.fillStyle = (p.pal || FIRE_PAL).core; ctx.fillRect(Math.round(c.x - u * 0.5), Math.round(c.y - u * 0.5), u, u);
        continue;
      }
      const w = Math.max(1, Math.round(S * (p.w || p.sz))), h = Math.max(1, Math.round(S * (p.h || p.sz)));
      ctx.fillStyle = p.col;
      ctx.fillRect(Math.round(c.x - w / 2), Math.round(c.y - h / 2), w, h);
    }
    if (over) {
      for (const p of list) if (p.k === 't') drawText(ctx, view, p);
      ctx.globalAlpha = 1;
      // soft white flash
      if (screenFlash.a > 0) {
        const k = 1 - screenFlash.t / screenFlash.dur;
        ctx.globalAlpha = Math.max(0, Math.min(0.25, screenFlash.a * k * k));
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, view.w, view.h);
      }
      // nuke wash: a near-white-out that cools through sun yellow to a fading orange
      if (nukeFx.t >= 0) {
        const t = nukeFx.t, k = t / nukeFx.dur;
        if (t < 140) { ctx.globalAlpha = 0.85 * (1 - t / 400); ctx.fillStyle = '#ffffff'; }
        else { ctx.globalAlpha = Math.max(0, 0.5 * (1 - k) * (1 - k)); ctx.fillStyle = k < 0.35 ? UI.sun : UI.orange; }
        ctx.fillRect(0, 0, view.w, view.h);
        ctx.globalAlpha = 1;
      }
      // death wash
      if (deathFx.t >= 0) {
        const t = deathFx.t, up = Math.min(1, t / 1500), down = t > 4000 ? Math.max(0, 1 - (t - 4000) / 1000) : 1;
        ctx.globalAlpha = 0.35 * up * down;
        ctx.fillStyle = '#4a1a4e'; ctx.fillRect(0, 0, view.w, view.h);
      }
      // LEVEL n
      if (lvlText.t >= 0) {
        const t = lvlText.t, str = 'LEVEL ' + lvlText.lvl;
        const size = Math.round(Math.min(14 * S, view.w * 0.88 / 5.4));
        const pop = t < 260 ? 0.6 + 0.55 * (t / 260) : (t < 400 ? 1.15 - 0.15 * ((t - 260) / 140) : 1);
        const fade = t > lvlText.dur - 450 ? Math.max(0, (lvlText.dur - t) / 450) : 1;
        const x = Math.round(view.w / 2);
        let y = Math.round(view.h * 0.3 - Math.min(t, 1200) * 0.01 * S);
        try {   // never draw over the zone banner: sit just below its subtitle while it is on screen
          const bz = document.querySelector('#banner .hb-z.in'), cv = ctx.canvas && ctx.canvas.getBoundingClientRect();
          if (bz && cv && cv.height) {
            const bb = bz.getBoundingClientRect(), bottom = (bb.bottom - cv.top) * (view.h / cv.height);
            y = Math.max(y, Math.round(bottom + size * 0.7));
          }
        } catch (e) { /* DOM optional */ }
        ctx.globalAlpha = fade;
        ctx.font = `${Math.max(12, Math.round(size * pop))}px ${FONT}`;
        ctx.lineWidth = Math.max(3, Math.round(size / 5));
        ctx.strokeStyle = PAL.outline; ctx.strokeText(str, x, y + Math.round(size * 0.07));
        ctx.lineWidth = Math.max(2, Math.round(size / 9));
        ctx.strokeStyle = UI.orange; ctx.strokeText(str, x, y);
        ctx.fillStyle = UI.sun; ctx.fillText(str, x, y);
      }
    }
  } catch (e) { /* cosmetic only */ }
  ctx.restore();
}

/** True while anything is still animating. */
export function fxActive() {
  return list.length > 0 || flashRecs.length > 0 || shk.dur > 0 || screenFlash.a > 0 || lvlText.t >= 0 || deathFx.t >= 0 || nukeFx.t >= 0 || burning;
}

/** Live entry count (debug / cap test). */
export function fxCount() { return list.length; }

/** Current screen-shake offset in device px. */
export function shake() {
  if (!(shk.dur > 0)) return { x: 0, y: 0 };
  const k = Math.max(0, 1 - shk.t / shk.dur), amp = shk.amp * k * k * lastS;
  const h = n => { const v = Math.sin(clock * 0.05 * n + n * 12.9898) * 43758.5453; return (v - Math.floor(v)) * 2 - 1; };
  return { x: Math.round(h(1.3) * amp), y: Math.round(h(2.7) * amp * 0.6) };
}

/** 0..1 white hit-flash amount for a monster or the hero. */
export function flashOf(entity) {
  if (!entity || typeof entity !== 'object') return 0;
  const r = flashMap.get(entity);
  if (!r) return 0;
  const k = 1 - r.t / r.dur;
  return k > 0 ? Math.min(1, k) : 0;
}
