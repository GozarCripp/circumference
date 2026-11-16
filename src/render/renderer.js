// render/renderer.js — the isometric frame.
//
// One call to render(now) draws the whole world, back to front:
//   1. backdrop (#08060f + a few deterministic stars)
//   2. world: every seen tile by ascending diagonal d = x + y  -> ground block (side faces cropped to the lower
//      front neighbour) -> prop -> campfire; entities (ground item, NPC, monster, hero) are merged into the same
//      painter's order by the (deeper) tile they occupy. The world stays solid; anything that ends up standing
//      behind a tree, wall, crag or terrace is drawn once more, faintly, over whatever hides it (see-through).
//   3. fx 'world' layer, 4. lighting multiply pass, 5. unlit overlays (selection ring, con rings, HP pips, stars),
//   6. fx 'overlay' layer.
// Every sprite goes through art/assets.js. Positions are integers in art pixels (so everything sits on the pixel
// grid), the view is `device px = art px * S + (ox, oy)` with S an INTEGER.
//
// Performance rules honoured here: one world query per tile per frame (a per-frame window of typed arrays is filled
// first and the hot loop only reads it); no allocation inside the tile loop (reused arrays, one mutable blit-options
// object, per-key sprite caches instead of building id strings); <= 1600 tile blits (adaptive far-row trim);
// the whole frame is wrapped so a bad sprite or tile can never kill the loop.
import { G, saveOpts } from '../core/state.js';
import { TILE_W, HW, HH, ZU, WS, TIMING, PAL } from '../core/config.js';
import { on, emit } from '../core/bus.js';
import { tileCenter, screenToTile } from './iso.js';
import { terr, isSeen, isVis, heightAt, elevAt, variantAt, groundKey, isDeep } from '../world/world.js';
import * as assets from '../art/assets.js';
import { drawLighting } from './lighting.js';
import { drawFx, shake, flashOf } from './fx.js';
import { shown } from '../game/monsters.js';
import { con } from '../game/combat.js';

// ---- tunables ------------------------------------------------------------------------------------------------
const BLIT_BUDGET = 1100;        // tile blits per frame before the far rows are trimmed on the next frame
const BLIT_HARD = 1800;          // hard stop for tile/prop blits inside one frame (entities are always drawn)
const MAX_MP = 3e6;              // backing-store megapixel cap
const Z_PAD = 26;                // tallest thing we expect, in ZU (pyramid apex + elevation), for window padding
const SIDE_MIN = 2, SIDE_MAX = 64;
const FOG_DROP = 3;              // unseen / void front neighbours count as this many ZU lower
const CAM_TAU = 85;              // camera ease time constant, ms
const PAN_TAU = 140;             // peek offset return time constant, ms
const PAN_MAX_X = 260, PAN_MAX_Y = 200;   // art px
const BG = '#170c33';              // the mist's base indigo: gaps behind lit tall things at the edge of the map read as mist, not holes
const KIND = { ground: 1, liquid: 2, solid: 3, prop: 4, none: 5 };   // terrain kind -> small int
// see-through: each creature / item carries 12 body sample points (3 columns x 4 rows); things drawn in front of it
// tick off the points they cover. XRAY_MIN covered points = "hidden enough" to be drawn again, faintly, on top.
const XRAY_MIN = 5, XRAY_HERO = .7, XRAY_OTHER = .55, XRAY_DEPTH = 9, COV_FULL = 0xfff;

// ---- module state --------------------------------------------------------------------------------------------
let cv = null, ctx = null, dpr = 1, S = 2;
let camX = 0, camY = 0, panX = 0, panY = 0, panReturn = false, lastNow = 0;
let snapPending = true, inited = false, errLogged = false, animating = false, farTrim = 0;
let disp = new WeakMap();                    // entity -> display record (see track())
const logged = new Set();                    // renderer errors are logged once per tag
const itemRec = new WeakMap();               // ground item -> {kx, ky, spr, ver, ph}
const stats = { blits: 0, ms: 0, tiles: 0, ents: 0, farTrim: 0 };
let stars = [];
let artVer = 0;                              // bumped when a custom PNG arrives ('asset' event)

// per-frame tile window (typed arrays, grown on demand, reused)
let WX0 = 0, WY0 = 0, WW = 0, WH = 0, WCAP = 0;
let wKind = new Uint8Array(0), wTop = new Int8Array(0), wVar = new Uint8Array(0);
let wDef = [], wKey = [];

// sprite caches by terrain / npc key (cleared when custom art arrives)
let tileSprites = Object.create(null), propSprites = Object.create(null), npcSprites = Object.create(null);

// entity pool, reused every frame
const pool = [];
const ents = [];
let entN = 0, poolN = 0, entMinZ = 0;
const occMasks = new WeakMap();              // prop sprite -> coarse opacity mask (see occMask)
let selTile = null;

// the single blit options object (assets.blit reads it synchronously; never retained)
const BO = { frame: 0, flip: false, alpha: 1, rows: undefined, flash: 0 };
let blits = 0;

/** @typedef {{S:number, ox:number, oy:number, w:number, h:number, dpr:number, toScreen:(x:number,y:number,z?:number)=>{x:number,y:number}}} View
 *  S = device px per art px (integer). Device px = art px * S + (ox, oy). toScreen gives the device-px centre of a tile top. */

// =================================================================================================================
//  setup / resize / zoom
// =================================================================================================================
export function initRenderer(canvas) {
  cv = canvas; ctx = cv.getContext('2d');
  if (!inited) {
    inited = true;
    // deterministic starfield (no Math.random): a tiny LCG
    let a = 0x2f6e2b1;
    const next = () => { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return a / 4294967296; };
    for (let i = 0; i < 90; i++) stars.push({ x: next(), y: next(), s: next() < .2 ? 2 : 1, a: .3 + next() * .6, p: next() * 6.28 });
    const snap = () => { snapPending = true; };
    on('newgame', snap); on('loaded', snap); on('floor', snap);
    on('asset', () => { artVer++; tileSprites = Object.create(null); propSprites = Object.create(null); npcSprites = Object.create(null); });
    on('turn', () => { panReturn = true; });
    on('moved', () => { panReturn = true; });
    on('hit', e => { if (e && e.mon && G.P) face(G.P, e.mon.x, e.mon.y); });
    on('hurt', e => { if (e && e.by && G.P && e.by.hp !== undefined) face(e.by, G.P.x, G.P.y); });
  }
  resize();
}

/** Recompute canvas size and zoom. S is an INTEGER number of device pixels per art pixel:
 *  phones aim for ~52 CSS px per tile width, tablets/desktop ~72, then G.opts.zoom steps are added, clamp 1..12.
 *  The backing store is capped at 3 megapixels, DPR at 2 (the DPR drops to fit). */
export function resize() {
  if (!cv) return;
  const iw = Math.max(1, innerWidth), ih = Math.max(1, innerHeight);
  dpr = Math.min(2, window.devicePixelRatio || 1);        // art is chunky pixels: DPR 3 only costs fill-rate
  if (iw * ih * dpr * dpr > MAX_MP) dpr = Math.sqrt(MAX_MP / (iw * ih));
  cv.width = Math.max(1, Math.round(iw * dpr)); cv.height = Math.max(1, Math.round(ih * dpr));
  // CSS px per tile width: ~52 on phones; on tablets and desktops big enough that the 9-tile circle of sight
  // (about 13.5 tiles wide, 8.6 tall on screen) fills the window instead of floating in the middle of it.
  const target = Math.min(iw, ih) < 700 ? 52 : Math.max(64, Math.min(112, Math.min(iw / 13.5, ih / 8.6)));
  S = Math.max(1, Math.min(12, Math.round(target * dpr / TILE_W) + ((G.opts && G.opts.zoom) || 0)));
  farTrim = 0;
  if (ctx) ctx.imageSmoothingEnabled = false;
}

/** Change zoom by +-1 step (persisted through G.opts.zoom), then re-fit. Emits 'opts'. */
export function zoomBy(d) {
  if (G.opts) { G.opts.zoom = Math.max(-3, Math.min(4, (G.opts.zoom || 0) + d)); try { saveOpts(); } catch (e) { /* ignore */ } }
  emit('opts', { zoom: G.opts && G.opts.zoom });
  resize();
}

// ---- camera helpers -------------------------------------------------------------------------------------------
/** Drag-peek: shift the camera by a CSS-pixel delta (drag direction = content direction). Eases back on the next turn. */
export function panBy(dxCss, dyCss) {
  panX = clampN(panX - dxCss * dpr / S, PAN_MAX_X); panY = clampN(panY - dyCss * dpr / S, PAN_MAX_Y);
  panReturn = false; emit('opts', { pan: true });
}
/** Set the peek offset absolutely, in CSS px (content shifts by this much). */
export function setCameraOffset(dxCss, dyCss) { panX = clampN(-dxCss * dpr / S, PAN_MAX_X); panY = clampN(-dyCss * dpr / S, PAN_MAX_Y); panReturn = false; emit('opts', { pan: true }); }
const clampN = (v, m) => v < -m ? -m : v > m ? m : v;

/** Jump the camera to the player with no easing (after load, floor changes, Gate). */
export function snapCamera() {
  snapPending = true; panX = panY = 0; panReturn = false;
  if (!G.P) return;
  const z = safeZ(G.P.x, G.P.y), c = tileCenter(G.P.x, G.P.y, z);
  camX = c.x; camY = c.y - 10;
}
function safeZ(x, y) { try { return standZ(x, y); } catch (e) { return 0; } }
/** Height an entity stands at on this tile (props sit on the ground block at elevAt). Not the hot path. */
function standZ(x, y) { return isSeen(x, y) ? heightAt(x, y) : 0; }

/** The current view transform, for lighting.js / fx.js / input.js. */
export function getView(withShake = false) {
  let ox = Math.round(cv.width / 2 - (camX + panX) * S), oy = Math.round(cv.height / 2 - (camY + panY) * S);
  if (withShake) { const s = shake(); if (s) { ox += Math.round(s.x || 0); oy += Math.round(s.y || 0); } }
  return mkView(ox, oy);
}
function mkView(ox, oy) {
  const s = S, w = cv.width, h = cv.height, d = dpr;
  return { S: s, ox, oy, w, h, dpr: d, toScreen: (x, y, z = 0) => { const c = tileCenter(x, y, z); return { x: c.x * s + ox, y: c.y * s + oy }; } };
}

/** True while tweens, the camera ease or the peek return are unfinished (the frame loop keeps rendering). */
export const isAnimating = () => animating;
/** Last frame's numbers: { blits, ms, tiles, ents, farTrim }. For tests and the dev overlay. */
export const renderStats = () => stats;

// =================================================================================================================
//  display records (tweens) and facing
// =================================================================================================================
function rec(e, x, y) {
  let r = disp.get(e);
  if (!r) { r = { x, y, px: x, py: y, tx: x, ty: y, t0: -1, flip: false, spr: null, sver: -1, cturn: -1, ccol: '#fff', ph: 0 }; disp.set(e, r); }
  return r;
}
function face(e, tx, ty) {
  const r = rec(e, e.x, e.y), sdx = (tx - ty) - (e.x - e.y);
  if (sdx !== 0) r.flip = sdx < 0;
}
/** Advance an entity's display position. Returns the record. Sets `animating` while a tween is running. */
function track(e, now) {
  const r = rec(e, e.x, e.y);
  if (e.x !== r.tx || e.y !== r.ty) {
    if (Math.abs(e.x - r.x) > 2.01 || Math.abs(e.y - r.y) > 2.01) { r.x = r.px = r.tx = e.x; r.y = r.py = r.ty = e.y; r.t0 = -1; }
    else {
      r.sx = r.x; r.sy = r.y; r.px = r.tx; r.py = r.ty; r.tx = e.x; r.ty = e.y; r.t0 = now;
      const sdx = (e.x - r.px) - (e.y - r.py);
      if (sdx !== 0) r.flip = sdx < 0;
    }
  }
  if (r.t0 >= 0) {
    const k = (now - r.t0) / TIMING.tween;
    if (k >= 1) { r.x = r.tx; r.y = r.ty; r.t0 = -1; r.px = r.tx; r.py = r.ty; }
    else { r.x = r.sx + (r.tx - r.sx) * k; r.y = r.sy + (r.ty - r.sy) * k; animating = true; }
  }
  return r;
}

// =================================================================================================================
//  sprite caches (no string building in the hot loop)
// =================================================================================================================
function tileSpr(key, v) {
  let a = tileSprites[key]; if (!a) a = tileSprites[key] = [null, null, null, null];
  return a[v] || (a[v] = assets.sprite('tile/' + key, v));
}
function propSpr(key, v) {
  let a = propSprites[key]; if (!a) a = propSprites[key] = [null, null, null, null];
  return a[v] || (a[v] = assets.sprite('prop/' + key, v));
}
function npcSpr(id) { return npcSprites[id] || (npcSprites[id] = assets.sprite('npc/' + id)); }

/** blit through the shared options object and count it. */
function put(spr, x, y, frame, rows, flip, alpha, flash) {
  BO.frame = frame; BO.rows = rows; BO.flip = flip; BO.alpha = alpha; BO.flash = flash;
  assets.blit(ctx, spr, x, y, S, BO);
  blits++;
}

// =================================================================================================================
//  the tile window
// =================================================================================================================
function ensureWindow(n) {
  if (n <= WCAP) return;
  WCAP = Math.max(n, WCAP * 2);
  wKind = new Uint8Array(WCAP); wTop = new Int8Array(WCAP); wVar = new Uint8Array(WCAP);
  wDef.length = WCAP; wKey.length = WCAP;
  for (let i = 0; i < WCAP; i++) { if (wDef[i] === undefined) { wDef[i] = null; wKey[i] = null; } }
}
/** Fill the window [x0..x1+1] x [y0..y1+1] (one extra row/column for the front neighbours). One world query set per tile. */
function fillWindow(x0, y0, x1, y1) {
  WX0 = x0; WY0 = y0; WW = x1 - x0 + 2; WH = y1 - y0 + 2;
  ensureWindow(WW * WH);
  let i = 0;
  for (let y = y0; y <= y1 + 1; y++) for (let x = x0; x <= x1 + 1; x++, i++) {
    if (!isSeen(x, y)) { wKind[i] = 0; continue; }
    const d = terr(x, y), k = KIND[d.kind] || 5;
    wKind[i] = k;
    if (k === 5) continue;
    wTop[i] = heightAt(x, y);
    wVar[i] = variantAt(x, y);
    wDef[i] = d;
    wKey[i] = k === 4 ? (d.ground === 'auto' ? groundKey(x, y) : d.ground) : d.key;
  }
}
/** Height of tile (x,y) as the window knows it (falls back to a direct query outside the window). */
function zAtWin(x, y) {
  const xi = x - WX0, yi = y - WY0;
  if (xi >= 0 && yi >= 0 && xi < WW && yi < WH) { const i = yi * WW + xi; const k = wKind[i]; return k === 0 || k === 5 ? 0 : wTop[i]; }
  return safeZ(x, y);
}
/** Top of a front neighbour as seen from a tile at `top`: unseen / void / out-of-window count as FOG_DROP lower. */
function nbTop(x, y, top) {
  const xi = x - WX0, yi = y - WY0;
  if (xi >= 0 && yi >= 0 && xi < WW && yi < WH) { const i = yi * WW + xi, k = wKind[i]; return k === 0 || k === 5 ? top - FOG_DROP : wTop[i]; }
  return top - FOG_DROP;
}
const sidePx = (top, a, b) => { const lo = a < b ? a : b, s = (top - lo) * ZU; return s < SIDE_MIN ? SIDE_MIN : s > SIDE_MAX ? SIDE_MAX : s; };

// =================================================================================================================
//  render
// =================================================================================================================
/** Draw one frame. Never throws. */
export function render(now) {
  if (!ctx || !G.P) return;
  const t0 = performance.now();
  try { frame(now); }
  catch (e) {
    if (!errLogged) { errLogged = true; console.error('[renderer] frame failed (logged once):', e); }
    try { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.shadowBlur = 0; } catch (e2) { /* ignore */ }
  }
  stats.ms = performance.now() - t0;
}

function frame(now) {
  const P = G.P;
  const dt = Math.max(1, Math.min(60, now - lastNow)); lastNow = now;
  animating = false;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.imageSmoothingEnabled = false; ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';

  // ---- snap after load / new game / floor change -------------------------------------------------------------
  let camSnap = false;
  if (snapPending) { snapPending = false; disp = new WeakMap(); camSnap = true; }

  // ---- hero display + camera ---------------------------------------------------------------------------------
  const hr = track(P, now);
  const hz = tweenZ(hr, true);
  const tc = tileCenter(hr.x, hr.y, hz), tX = tc.x, tY = tc.y - 10;
  if (camSnap || Math.abs(tX - camX) > 14 * TILE_W || Math.abs(tY - camY) > 14 * TILE_W) { camX = tX; camY = tY; }
  else {
    const k = 1 - Math.exp(-dt / CAM_TAU);
    camX += (tX - camX) * k; camY += (tY - camY) * k;
    if (Math.abs(tX - camX) < .35 && Math.abs(tY - camY) < .35) { camX = tX; camY = tY; } else animating = true;
  }
  if (panReturn && (panX !== 0 || panY !== 0)) {
    const k = 1 - Math.exp(-dt / PAN_TAU);
    panX -= panX * k; panY -= panY * k;
    if (Math.abs(panX) < .3 && Math.abs(panY) < .3) { panX = panY = 0; panReturn = false; } else animating = true;
  }

  const sh = shake();
  const ox = Math.round(cv.width / 2 - (camX + panX) * S) + (sh ? Math.round(sh.x || 0) : 0);
  const oy = Math.round(cv.height / 2 - (camY + panY) * S) + (sh ? Math.round(sh.y || 0) : 0);
  const W = cv.width, Hh = cv.height;
  const v = mkView(ox, oy);

  // ---- backdrop -----------------------------------------------------------------------------------------------
  ctx.fillStyle = BG; ctx.fillRect(0, 0, W, Hh);

  // ---- tile window from the canvas corners --------------------------------------------------------------------
  const ax0 = (0 - ox) / S, ax1 = (W - ox) / S, ay0 = (0 - oy) / S - 74, ay1 = (Hh - oy) / S + 64 + Z_PAD * ZU;
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (let c = 0; c < 4; c++) {
    const t = screenToTile(c & 1 ? ax1 + 24 : ax0 - 24, c & 2 ? ay1 : ay0, 0);
    if (t.x < x0) x0 = t.x; if (t.x > x1) x1 = t.x; if (t.y < y0) y0 = t.y; if (t.y > y1) y1 = t.y;
  }
  x0 = Math.floor(x0) - 1; x1 = Math.ceil(x1) + 1; y0 = Math.floor(y0) - 1; y1 = Math.ceil(y1) + 1;
  // never wider than the hero's possible knowledge: 3 * vision (explored memory further away is off-screen anyway)
  const lim = 64;
  if (x0 < P.x - lim) x0 = P.x - lim; if (x1 > P.x + lim) x1 = P.x + lim;
  if (y0 < P.y - lim) y0 = P.y - lim; if (y1 > P.y + lim) y1 = P.y + lim;
  fillWindow(x0, y0, x1, y1);

  // ---- entities: track, gather, sort -------------------------------------------------------------------------
  gatherEntities(now, hr, hz);

  selTile = G.sel || null;

  // ---- world pass --------------------------------------------------------------------------------------------
  blits = 0;
  const wf = Math.floor(now / TIMING.water) % 4;
  const camTile = (!G.dg && P.camp) ? P.camp : null;
  const cmx = camTile ? camTile.x : NaN, cmy = camTile ? camTile.y : NaN;
  let ei = 0, tiles = 0;
  const dMin = x0 + y0 + farTrim, dMax = x1 + y1 + 2;
  for (let d = dMin; d <= dMax; d++) {
    let xs = d - y1; if (xs < x0) xs = x0;
    let xe = d - y0; if (xe > x1) xe = x1;
    for (let x = xs; x <= xe; x++) {
      const y = d - x;
      // entities of earlier tiles (their own tile was culled or skipped); an entity is drawn right after the
      // ground block it stands on, so its feet and shadow sit ON the tile, and before anything it can wade through
      while (ei < entN && (ents[ei].dp < d || (ents[ei].dp === d && ents[ei].ox < x))) drawEnt(ents[ei++], now, ox, oy, 0);
      const i = (y - WY0) * WW + (x - WX0), k = wKind[i];
      if (k === 0 || k === 5 || blits > BLIT_HARD) continue;
      const top = wTop[i];
      const cx = ((x - y) * HW) * S + ox, cy = (d * HH + HH - top * ZU) * S + oy;
      if (cx < -34 * S || cx > W + 34 * S || cy - 8 * S > Hh) continue;
      const def = wDef[i];
      const side = sidePx(top, nbTop(x + 1, y, top), nbTop(x, y + 1, top));
      if (cy + (8 + side) * S < 0) continue;
      tiles++;
      try {
        const key = wKey[i], vr = wVar[i];
        put(tileSpr(key, vr), cx, cy, k === 2 ? wf : 0, 16 + side, false, 1, 0);
        const wade = k === 4 && (def.key === 'bush' || def.key === 'reed');      // undergrowth closes over the legs
        const tallProp = k === 4 && !wade && def.tall ? propSpr(def.key, vr) : null;
        if (k === 4 && !wade) put(tallProp || propSpr(def.key, vr), cx, cy, 0, undefined, false, 1, 0);
        // does this hide anyone standing further back? (trees, pillars, cacti by their silhouette; blocks that rise above them)
        if (ei > 0 && (tallProp || top > entMinZ + 1)) occlude(ei, d, cx, cy, top, side, tallProp);
        if (x === cmx && y === cmy) put(propSpr('campfire', 0), cx, cy, wf, undefined, false, 1, 0);
        while (ei < entN && ents[ei].dp === d && ents[ei].ox === x) drawEnt(ents[ei++], now, ox, oy, 0);
        if (wade) put(propSpr(def.key, vr), cx, cy, 0, undefined, false, 1, 0);
      } catch (e) { logOnce('tile', e); }
    }
  }
  while (ei < entN) drawEnt(ents[ei++], now, ox, oy, 0);
  // see-through: whoever is mostly hidden is drawn again over what hides them (before lighting, so it is lit like the rest)
  for (let j = 0; j < entN; j++) { const e = ents[j]; if (e.cov && popcount(e.cov) >= XRAY_MIN) drawEnt(e, now, ox, oy, e.k === 3 ? XRAY_HERO : XRAY_OTHER); }
  ctx.globalAlpha = 1;
  stats.blits = blits; stats.tiles = tiles; stats.ents = entN; stats.farTrim = farTrim;
  if (blits > BLIT_BUDGET) farTrim += 2; else if (farTrim > 0 && blits < BLIT_BUDGET * .8) farTrim--;

  // ---- fx (world), lighting, overlays, fx (overlay) -----------------------------------------------------------
  try { drawFx(ctx, v, 'world'); } catch (e) { logOnce('fx', e); }
  try { drawLighting(ctx, v); } catch (e) { logOnce('lighting', e); }
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  // stars, only out in the unexplored (they sit in the mist drawLighting just laid over the never-seen)
  const sp = Math.max(1, Math.round(dpr));
  ctx.fillStyle = '#e4dcff';
  for (let i = 0; i < stars.length; i++) {
    const st = stars[i], px = Math.floor(st.x * W), py = Math.floor(st.y * Hh);
    const t = screenToTile((px - ox) / S, (py - oy) / S, 0), tx = Math.floor(t.x), ty = Math.floor(t.y);
    if (isSeen(tx, ty) || isSeen(tx + 1, ty + 1) || isSeen(tx + 2, ty + 2) || isSeen(tx + 1, ty) || isSeen(tx, ty + 1)) continue;
    ctx.globalAlpha = st.a * (.6 + .4 * Math.sin(now / 1100 + st.p));
    ctx.fillRect(px, py, st.s * sp, st.s * sp);
  }
  ctx.globalAlpha = 1;
  try { drawOverlays(now, ox, oy); } catch (e) { logOnce('overlay', e); }
  try { drawFx(ctx, v, 'overlay'); } catch (e) { logOnce('fx-overlay', e); }
  ctx.globalAlpha = 1;
}

function logOnce(tag, e) { if (!logged.has(tag)) { logged.add(tag); console.error('[renderer] ' + tag + ':', e); } }

/** Standing height for an entity record mid-tween (blends the two tiles' heights). */
function tweenZ(r, direct) {
  const zt = direct ? safeZ(r.tx, r.ty) : zAtWin(r.tx, r.ty);
  if (r.t0 < 0) return zt;
  const zf = direct ? safeZ(r.px, r.py) : zAtWin(r.px, r.py), k = Math.max(0, Math.min(1, (lastNow - r.t0) / TIMING.tween));
  return zf + (zt - zf) * k;
}

// =================================================================================================================
//  entities
// =================================================================================================================
function newEnt() { return { k: 0, ref: null, r: null, x: 0, y: 0, z: 0, dp: 0, ox: 0, key: 0, cx: 0, cy: 0, spr: null, bob: 0, wet: false, px: 0, py: 0, cov: 0, hw: 5, h0: 6, hs: 8 }; }
function pushEnt(k, ref, r, x, y, z, dpx, dpy, P) {
  let e = pool[poolN];
  if (!e) e = pool[poolN] = newEnt();
  poolN++; ents.push(e);
  e.k = k; e.ref = ref; e.r = r; e.x = x; e.y = y; e.z = z; e.cov = 0;
  if (z < entMinZ) entMinZ = z;
  // body sample grid in art px: columns at -hw, 0, +hw; rows h0, h0 + hs, ... above the feet
  if (k === 0) { e.hw = 3; e.h0 = 2; e.hs = 3; } else if (k === 2 && ref.boss) { e.hw = 12; e.h0 = 10; e.hs = 14; } else { e.hw = 5; e.h0 = 6; e.hs = 8; }
  // painter's depth: the deeper of the two tiles an entity is between
  if (r && r.t0 >= 0 && (r.px + r.py) > (r.tx + r.ty)) { e.dp = r.px + r.py; e.ox = r.px; } else if (r) { e.dp = r.tx + r.ty; e.ox = r.tx; } else { e.dp = dpx + dpy; e.ox = dpx; }
  e.key = (e.dp - (P.x + P.y)) * 4096 + (e.ox - P.x + 1024) * 4 + k;
  return e;
}
const byKey = (a, b) => a.key - b.key;
let itemP = null;                            // hero record for the ground-item visit in progress

function itemVisit(it, key) {
  const P = itemP;
  let r = itemRec.get(it);
  if (!r) {
    const c = key.indexOf(',');
    r = { kx: +key.slice(0, c), ky: +key.slice(c + 1), spr: null, sver: -1, ph: ((key.length * 7 + (+key.slice(0, c) & 7)) % 6) };
    itemRec.set(it, r);
  }
  let ux = r.kx, uy = r.ky;
  if (!G.dg) { ux += Math.round((P.x - ux) / WS) * WS; uy += Math.round((P.y - uy) / WS) * WS; }
  if (ux < P.x - 30 || ux > P.x + 30 || uy < P.y - 30 || uy > P.y + 30) return;
  if (!isVis(ux, uy)) return;
  const e = pushEnt(0, it, null, ux, uy, zAtWin(ux, uy), ux, uy, P);
  e.r = r; e.bob = r.ph;
}

function gatherEntities(now, hr, hz) {
  const P = G.P;
  poolN = 0; ents.length = 0; entMinZ = 1e9;
  // ground items
  itemP = P;
  if (G.items && G.items.size) G.items.forEach(itemVisit);
  // NPCs
  const npcs = G.npcs;
  if (npcs) for (let i = 0; i < npcs.length; i++) {
    const n = npcs[i];
    if (Math.abs(n.x - P.x) > 30 || Math.abs(n.y - P.y) > 30) continue;
    const r = track(n, now);
    if (!isVis(n.x, n.y)) continue;
    pushEnt(1, n, r, r.x, r.y, tweenZ(r), n.x, n.y, P);
  }
  // monsters (tracked even when hidden so a monster stepping into view does not pop from a stale spot)
  const mons = G.mons;
  if (mons) for (let i = 0; i < mons.length; i++) {
    const m = mons[i];
    if (Math.abs(m.x - P.x) > 16 || Math.abs(m.y - P.y) > 16) continue;
    const r = track(m, now);
    if (!shown(m)) continue;
    pushEnt(2, m, r, r.x, r.y, tweenZ(r), m.x, m.y, P);
  }
  // hero last (drawn after anything on the same tile)
  const he = pushEnt(3, P, hr, hr.x, hr.y, hz, P.x, P.y, P);
  hr.dp = he.dp;
  he.wet = isDeep(P.x, P.y);
  ents.sort(byKey);
  entN = ents.length;
}

/** Draw one entity. xr = 0: the normal pass (shadow, ripples, sprite). xr > 0: the see-through pass — the sprite
 *  alone, at that alpha, over whatever was drawn in front of it. */
function drawEnt(e, now, ox, oy, xr) {
  const r = e.r;
  const art = Math.round((e.x - e.y) * HW), arty = Math.round((e.x + e.y) * HH + HH - e.z * ZU);
  let cx = art * S + ox, cy = arty * S + oy;
  const k = e.k, a = xr || 1;
  e.px = cx; e.py = cy;
  try {
    if (k === 0) {                                              // ground item
      const it = e.ref;
      if (r.sver !== artVer) { r.spr = assets.sprite(assets.itemSpriteId(it)); r.sver = artVer; }
      const bob = ((Math.floor(now / 520) + e.bob) & 1) ? -1 : 0;
      if (!xr) shadowAt(cx, cy, 5);
      put(r.spr, cx, cy + bob * S, 0, undefined, false, a, 0);
      return;
    }
    if (k === 1) {                                              // NPC: faces the hero
      const n = e.ref, flip = ((G.P.x - G.P.y) - (n.x - n.y)) < 0;
      const spr = npcSpr(n.look || n.id);
      if (!xr) shadowAt(cx, cy, spr.w * .28);
      const nb = ((Math.floor(now / 780) + n.x * 3 + n.y) & 1) ? -S : 0;      // strangers shift their weight, slowly
      put(spr, cx, cy + nb, 0, undefined, flip, a, flashOf(n) || 0);
      e.cx = cx; e.cy = cy;
      return;
    }
    if (k === 2) {                                              // monster
      const m = e.ref;
      if (r.sver !== artVer) { r.spr = assets.sprite(assets.monSpriteId(m)); r.sver = artVer; }
      const spr = r.spr, swimmer = m.ai === 'swim' || (typeof m.id === 'string' && m.id.startsWith('shark'));
      let by = 0, rows;
      if (swimmer) { by = Math.round(Math.sin(now / 380 + (m.x * 7 + m.y * 3)) * 1.3) * S; if (!xr) ripple(cx, cy, now, 11, m.x + m.y); }
      else if (wading(m.x, m.y)) { rows = spr.ay - 3; if (!xr) ripple(cx, cy - 2 * S, now, Math.min(13, spr.w * .3), m.x + m.y); }
      else if (!xr) shadowAt(cx, cy, Math.min(15, spr.w * .28));
      // a tell: anything that has noticed you is restless; sleepers and the stunned / mesmerised hold still
      if (!swimmer && m.awake && !m.stun && !m.mez && ((Math.floor(now / 520) + m.x * 3 + m.y) & 1)) by = -S;
      put(spr, cx, cy + by, 0, rows, r.flip, a, flashOf(m) || 0);
      e.cx = cx; e.cy = cy + by; e.bob = by;
      return;
    }
    // hero
    const P = G.P, spr = assets.heroSprite(P, e.wet);
    const wade = !e.wet && wading(P.x, P.y);                    // shallows: the water closes over the ankles
    if (xr) { /* sprite only */ } else if (e.wet) ripple(cx, cy, now, 10, 0); else if (wade) ripple(cx, cy - 2 * S, now, 9, 0); else shadowAt(cx, cy, 9);
    const feign = P.buffs && P.buffs.feign > 0;
    put(spr, cx, cy + (e.wet ? Math.round(Math.sin(now / 420)) * S : 0), 0, wade ? spr.ay - 3 : undefined, r.flip, (feign ? .55 : 1) * a, flashOf(P) || 0);
    e.cx = cx; e.cy = cy;
  } catch (err) { logOnce('entity' + k, err); }
}

// ---- see-through ------------------------------------------------------------------------------------------------
const popcount = v => { let n = 0; while (v) { v &= v - 1; n++; } return n; };
/** Coarse opacity mask of a prop sprite (one cell = 4 x 4 art px of frame 0), built once per sprite. */
function occMask(spr) {
  let m = occMasks.get(spr);
  if (m) return m;
  const cw = Math.max(1, Math.ceil(spr.w / 4)), ch = Math.max(1, Math.ceil(spr.h / 4));
  m = { cw, ch, bits: new Uint8Array(cw * ch) };
  try {
    const c = document.createElement('canvas'); c.width = cw; c.height = ch;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingEnabled = true;
    g.drawImage(spr.img, 0, 0, spr.w, spr.h, 0, 0, cw, ch);
    const px = g.getImageData(0, 0, cw, ch).data;
    for (let i = 0; i < cw * ch; i++) m.bits[i] = px[i * 4 + 3] > 110 ? 1 : 0;
  } catch (e) { /* an unreadable sprite hides nobody */ }
  occMasks.set(spr, m);
  return m;
}
/** A tile at diagonal d (anchor cx, cy in device px; block top `top` ZU with `side` px of side face; prop sprite or
 *  null) has just been drawn: tick off the body sample points it covers on entities already drawn further back. */
function occlude(n, d, cx, cy, top, side, prop) {
  const mask = prop ? occMask(prop) : null;
  for (let j = n - 1; j >= 0; j--) {
    const e = ents[j];
    if (e.dp < d - XRAY_DEPTH) break;
    if (e.dp >= d || e.cov === COV_FULL) continue;
    const block = top > e.z + 1;                               // the block itself rises above the entity's feet
    if (!block && !mask) continue;
    const ddx = (e.px - cx) / S, reach = (mask ? 24 : 16) + e.hw;
    if (ddx > reach || ddx < -reach) continue;
    let bit = 1;
    for (let r = 0; r < 4; r++) {
      const ay = (e.py - cy) / S - e.h0 - r * e.hs;
      for (let c = -1; c <= 1; c++, bit <<= 1) {
        if (e.cov & bit) continue;
        const ax = ddx + c * e.hw, adx = ax < 0 ? -ax : ax;
        let hit = false;
        if (block && adx < 16) { const t = 8 - adx / 2; hit = ay >= -t && ay <= side + t; }
        if (!hit && mask) {
          const mx = Math.floor((ax + prop.ax) / 4), my = Math.floor((ay + prop.ay) / 4);
          hit = mx >= 0 && my >= 0 && mx < mask.cw && my < mask.ch && mask.bits[my * mask.cw + mx] === 1;
        }
        if (hit) e.cov |= bit;
      }
    }
  }
}

/** Standing in shallow liquid (river, bog water)? Not the hot path: called once per creature per frame. */
function wading(x, y) { try { const d = terr(x, y); return d.kind === 'liquid' && !d.deep; } catch (e) { return false; } }
/** Soft elliptical ground shadow of art-radius rx. */
function shadowAt(cx, cy, rx) {
  ctx.fillStyle = PAL.shadow;
  ctx.beginPath(); ctx.ellipse(cx, cy + S, rx * S, rx * .4 * S, 0, 0, 6.2832); ctx.fill();
}
/** Two expanding water rings (sharks, a swimming hero). */
function ripple(cx, cy, now, rx, seed) {
  ctx.lineWidth = Math.max(1, S * .8);
  for (let j = 0; j < 2; j++) {
    const p = ((now / 1300 + seed * .13 + j * .5) % 1);
    ctx.globalAlpha = .55 * (1 - p); ctx.strokeStyle = '#d6ecff';
    ctx.beginPath(); ctx.ellipse(cx, cy + S, (rx * .55 + rx * .55 * p) * S, (rx * .22 + rx * .22 * p) * S, 0, 0, 6.2832); ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// =================================================================================================================
//  unlit overlays: selection ring, con rings, HP pips, rare stars
// =================================================================================================================
function drawOverlays(now, ox, oy) {
  // monsters first (rings and pips), so the selection ring sits on top
  for (let i = 0; i < entN; i++) {
    const e = ents[i];
    if (e.k !== 2) continue;
    const m = e.ref, big = !!m.boss, cx = e.cx, cy = e.cy - e.bob;
    const r = e.r;
    if (r.cturn !== G.turn) { try { r.ccol = con(m).color || '#fff'; } catch (er) { r.ccol = '#fff'; } r.cturn = G.turn; }
    ctx.lineWidth = Math.max(1, Math.round(S * .8)); ctx.strokeStyle = r.ccol; ctx.globalAlpha = .85;
    ctx.beginPath(); ctx.ellipse(cx, cy + S, (big ? 17 : 11) * S, (big ? 7 : 4.6) * S, 0, 0, 6.2832); ctx.stroke();
    ctx.globalAlpha = 1;
    const top = (big ? 74 : 44) * S;
    if (m.hp < m.max) {
      const bw = (big ? 24 : 14) * S, bh = 2 * S, bx = Math.round(cx - bw / 2), by = Math.round(cy - top);
      const f = Math.max(0, m.hp / m.max);
      ctx.fillStyle = '#1a1023'; ctx.fillRect(bx - S, by - S, bw + 2 * S, bh + 2 * S);
      ctx.fillStyle = f > .5 ? '#7dff8a' : f > .25 ? '#ffd23f' : '#ff5d6c';
      ctx.fillRect(bx, by, Math.max(S, Math.round(bw * f)), bh);
    }
    if (m.rare) star(cx, cy - top - 5 * S, 4 * S, now);
  }
  const au = G.auto;
  if (au && (au.kind === 'go') && Number.isFinite(au.x) && Number.isFinite(au.y)) {            // where the walk is headed
    const z = zAtWin(au.x, au.y), cx = ((au.x - au.y) * HW) * S + ox, cy = ((au.x + au.y) * HH + HH - z * ZU) * S + oy;
    const p = (now / 600) % 1, w = (6 + 8 * p) * S, h = w * .5;
    ctx.strokeStyle = '#8fd3ff'; ctx.globalAlpha = .9 * (1 - p); ctx.lineWidth = Math.max(1, S);
    ctx.beginPath(); ctx.moveTo(cx, cy - h); ctx.lineTo(cx + w, cy); ctx.lineTo(cx, cy + h); ctx.lineTo(cx - w, cy); ctx.closePath(); ctx.stroke();
    ctx.globalAlpha = .9; ctx.fillStyle = '#8fd3ff';
    ctx.beginPath(); ctx.moveTo(cx, cy - 2 * S); ctx.lineTo(cx + 4 * S, cy); ctx.lineTo(cx, cy + 2 * S); ctx.lineTo(cx - 4 * S, cy); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 1; animating = true;
  }
  if (selTile) {
    const sx = selTile.x, sy = selTile.y, z = zAtWin(sx, sy);
    const cx = ((sx - sy) * HW) * S + ox, cy = ((sx + sy) * HH + HH - z * ZU) * S + oy;
    const pulse = .5 + .5 * Math.sin(now / 210);
    ctx.fillStyle = 'rgba(255,210,63,' + (.10 + .10 * pulse).toFixed(3) + ')';
    ctx.strokeStyle = '#ffd23f'; ctx.globalAlpha = .7 + .3 * pulse; ctx.lineWidth = Math.max(1, Math.round(S * (1 + pulse * .5)));
    const w = 15 * S, h = 7 * S;
    ctx.beginPath(); ctx.moveTo(cx, cy - h); ctx.lineTo(cx + w, cy); ctx.lineTo(cx, cy + h); ctx.lineTo(cx - w, cy); ctx.closePath();
    ctx.fill(); ctx.stroke(); ctx.globalAlpha = 1;
  }
}
/** A small gold five-point star centred on (cx, cy), radius r. */
function star(cx, cy, r, now) {
  ctx.fillStyle = '#ffd23f'; ctx.strokeStyle = PAL.outline; ctx.lineWidth = Math.max(1, S * .6);
  ctx.beginPath();
  const rot = -Math.PI / 2 + Math.sin(now / 500) * .12;
  for (let i = 0; i < 10; i++) { const a = rot + i * Math.PI / 5, rr = i & 1 ? r * .45 : r; ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); }
  ctx.closePath(); ctx.fill(); ctx.stroke();
}

// =================================================================================================================
//  picking
// =================================================================================================================
/** Client (CSS px) point -> tile under it: the front-most drawn block whose top diamond or side faces contain the point
 *  (so tapping a wall selects the wall, not the floor behind it; tall props also answer for their body). Unseen tiles
 *  count as flat ground at z = 0, so tapping fog still returns the plane tile. Coordinates are unwrapped (hero frame). */
export function pickTile(clientX, clientY) {
  const r = cv.getBoundingClientRect(), v = getView();
  const px = ((clientX - r.left) * (cv.width / r.width) - v.ox) / S, py = ((clientY - r.top) * (cv.height / r.height) - v.oy) / S;
  // Creatures first: a tap anywhere on a visible monster, NPC or the hero picks the tile it stands on (thumbs aim
  // at bodies, not at feet). The front-most one wins.
  try {
    let best = null, bestD = -1e9;
    const hit = (e, big) => {
      const z = standZ(e.x, e.y), ex = (e.x - e.y) * HW, ey = (e.x + e.y) * HH + HH - z * ZU;
      const hw = big ? 20 : 9, top = big ? 62 : 34;
      if (px >= ex - hw && px <= ex + hw && py >= ey - top && py <= ey + 3 && e.x + e.y > bestD) { bestD = e.x + e.y; best = e; }
    };
    const P = G.P, mons = G.mons || [], npcs = G.npcs || [];
    for (let i = 0; i < mons.length; i++) { const m = mons[i]; if (Math.abs(m.x - P.x) <= 16 && Math.abs(m.y - P.y) <= 16 && shown(m)) hit(m, !!m.boss); }
    for (let i = 0; i < npcs.length; i++) { const n = npcs[i]; if (Math.abs(n.x - P.x) <= 16 && Math.abs(n.y - P.y) <= 16 && isVis(n.x, n.y)) hit(n, false); }
    if (!best) hit(P, false);
    if (best) return { x: best.x, y: best.y };
  } catch (e) { logOnce('pick', e); }
  // direct world queries (taps are rare), never the per-frame window
  let bx = 0, by = 0, bd = -1e9, bdx = 1e9, found = false;
  const n0 = Math.floor(px / HW);
  for (let n = n0; n <= n0 + 1; n++) {
    const dx = px - n * HW, adx = Math.abs(dx);
    if (adx >= HW) continue;
    const t = HH * (1 - adx / HW);
    const xa = Math.ceil((((py - 84) / HH) + n) / 2), xb = Math.floor((((py + 4 * Z_PAD + 16) / HH) + n) / 2);
    for (let x = xa; x <= xb; x++) {
      const y = x - n;
      let z = 0, side = 0, tallBody = false;
      if (isSeen(x, y)) {
        const d = terr(x, y);
        if (d.kind === 'none') continue;
        z = heightAt(x, y);
        side = sidePx(z, pickNb(x + 1, y, z), pickNb(x, y + 1, z));
        tallBody = d.kind === 'prop' && !!d.tall;
      }
      const cy = (x + y) * HH + HH - z * ZU, dy = py - cy;
      let hit = dy >= -t && dy <= t + side;
      if (!hit && tallBody && adx <= 7 && dy >= -30 && dy < 0) hit = true;
      if (!hit) continue;
      const dp = x + y;
      if (dp > bd || (dp === bd && adx < bdx)) { bd = dp; bdx = adx; bx = x; by = y; found = true; }
    }
  }
  if (found) return { x: bx, y: by };
  const t = screenToTile(px, py, 0);
  return { x: Math.floor(t.x), y: Math.floor(t.y) };
}
function pickNb(x, y, top) {
  if (!isSeen(x, y)) return top - FOG_DROP;
  if (terr(x, y).kind === 'none') return top - FOG_DROP;
  return heightAt(x, y);
}

/** Tile -> client (CSS px) point of the centre of its top face (at its height), for anchoring the popup. */
export function tileToClient(x, y) {
  const v = getView(), r = cv.getBoundingClientRect(), z = standZ(x, y), c = v.toScreen(x, y, z);
  return { x: r.left + c.x * (r.width / cv.width), y: r.top + c.y * (r.height / cv.height) };
}
