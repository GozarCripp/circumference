// art/assets.js — the one door through which every sprite reaches the screen. OWNER: Foreman A / A10.
// Contract: docs/ARCHITECTURE.md §8.A10, §7 (asset manifest + drop-in art), §11 (performance).
//
//   sprite(id, variant)  ->  1. custom PNG already loaded for this id            (hand-drawn art, smooth-scaled)
//                            2. else the procedural generator for the category   (chunky placeholder, pixelated)
//                            ...and, the first time an id is asked for, a polite background probe for
//                            assets/art/<id>.png (or the manifest ART entry). If it exists it is swapped in and
//                            'asset' {id} is emitted so the renderer redraws. A missing file is remembered.
//
//   blit(ctx, spr, x, y, S, opts)  draws from a per-zoom pre-scaled copy, so the draw itself is a 1:1 copy.
//
// Nothing here runs at import time: all setup happens in initAssets(). Nothing here ever throws into the game.
import { BOX, ART, ART_DIR, AUTO_PROBE } from '../../assets/manifest.js';
import { emit, on } from '../core/bus.js';
import { slug } from '../core/util.js';
import { canvas, makeSprite, outline } from './pixel.js';
import { makeTile } from './tiles.js';
import { makeProp } from './props.js';
import { makeEnemy, makeNPC } from './creatures.js';
import { makeHeroLayer, makeItem } from './hero.js';
import { TILE_IDS, PROP_IDS, TERRAIN } from '../data/terrain.js';
import { ENEMY_IDS, enemyById } from '../data/bestiary.js';
import { NPC_IDS, NPCS } from '../game/quests.js';
import { HERO_IDS, ITEM_IDS, potSpriteId } from '../game/loot.js';

// ---- state -----------------------------------------------------------------------------------------------
const CACHE_MAX = 3000, CACHE_TRIM = 2700;   // procedural + custom sprites by 'id~variant' (FIFO eviction)
const ICON_MAX = 600, HERO_MAX = 64, PROBE_CONCURRENCY = 6, TILE_VARIANTS = 4;
const CATEGORIES = ['tile', 'prop', 'enemy', 'npc', 'hero', 'item'];

const cache = new Map();        // 'id~variant' -> Sprite
const customMap = new Map();    // id -> custom Sprite (survives cache eviction)
const probed = new Set();       // ids a probe was ever queued for (one probe per id per session)
const missing = new Set();      // ids whose PNG 404'd (never retried)
const inflight = new Map();     // id -> Promise<boolean> of a running / queued probe
const queue = [];               // pending probes: { id, run }
let active = 0;
const iconCache = new Map();    // 'id~variant' -> data URL
const heroCache = new Map();    // look key -> Sprite
let artEntries = null;          // normalised ART: id -> { file, frames, w, h, ax, ay }
let unsubAsset = null;
let MISSING = null;             // the shared magenta marker (created lazily)

// pre-scaled copies, valid for ONE zoom level at a time
let curS = 0;
let scaled = new Map();         // Sprite -> { n, f, sn, sf }  (normal / flipped / silhouettes)

// ---- manifest ----------------------------------------------------------------------------------------------
function normaliseArt() {
  artEntries = new Map();
  let src = ART; if (!src || typeof src !== 'object') src = {};
  for (const id of Object.keys(src)) {
    const v = src[id]; if (!v) continue;
    if (v === true) artEntries.set(id, { file: id + '.png' });
    else if (typeof v === 'string') artEntries.set(id, { file: v });
    else if (typeof v === 'object') artEntries.set(id, { ...v, file: v.file || id + '.png' });
  }
}
const artEntry = id => { if (!artEntries) normaliseArt(); return artEntries.get(id) || null; };

/** Register generators / read the manifest. Never waits for images and never rejects. */
export async function initAssets() {
  try {
    normaliseArt();
    if (!unsubAsset) unsubAsset = on('asset', p => { if (p && typeof p.id === 'string' && p.id.startsWith('hero/')) heroCache.clear(); });
    for (const id of artEntries.keys()) startProbe(id);       // explicit entries preload in the background
  } catch (e) { console.warn('[assets] init', e); }
}

// ---- the missing marker -----------------------------------------------------------------------------------
function missingSprite() {
  if (MISSING) return MISSING;
  const { c, g } = canvas(16, 16);
  g.fillStyle = '#ff00ff'; g.fillRect(1, 1, 14, 14);
  g.fillStyle = '#1a0a20'; g.fillRect(1, 1, 14, 1); g.fillRect(1, 14, 14, 1); g.fillRect(1, 1, 1, 14); g.fillRect(14, 1, 1, 14);
  for (let i = 3; i < 13; i++) { g.fillRect(i, i, 1, 1); g.fillRect(i, 15 - i, 1, 1); }   // a big black X
  MISSING = makeSprite(c, 8, 13);
  return MISSING;
}

// ---- ids / boxes -------------------------------------------------------------------------------------------
const splitId = id => { const i = id.indexOf('/'); return i < 0 ? ['', id] : [id.slice(0, i), id.slice(i + 1)]; };

function boxFor(id, entry) {
  const [cat, name] = splitId(id);
  let b = BOX[cat] || BOX.item;
  if (cat === 'enemy') { try { const e = enemyById(name); if (e && e.ai === 'boss') b = BOX.boss; } catch (e) { /* ignore */ } }
  if (entry && (entry.w || entry.h || entry.ax != null || entry.ay != null))
    b = { w: entry.w || b.w, h: entry.h || b.h, ax: entry.ax != null ? entry.ax : (entry.w ? entry.w / 2 : b.ax), ay: entry.ay != null ? entry.ay : (entry.h ? entry.h - 4 : b.ay) };
  return b;
}

// ---- procedural generation ---------------------------------------------------------------------------------
function generate(id, variant) {
  try {
    const [cat, name] = splitId(id);
    if (cat === 'tile') return makeTile(name, variant);
    if (cat === 'prop') return makeProp(name, variant);
    if (cat === 'enemy') return makeEnemy(name);
    if (cat === 'npc') return makeNPC(name);
    if (cat === 'hero') return makeHeroLayer(name);
    if (cat === 'item') return makeItem(name);
  } catch (e) { console.warn('[assets] generate', id, e); }
  return null;
}

function remember(k, s) {
  if (cache.size >= CACHE_MAX) {
    let n = cache.size - CACHE_TRIM;
    for (const key of cache.keys()) { cache.delete(key); if (--n <= 0) break; }
  }
  cache.set(k, s);
}

/** Get a sprite by asset id (see ARCHITECTURE §7.1 for the id grammar). Never null, never throws: unknown ids give a
 *  magenta marker. variant only matters for procedural tiles/props. Synchronous; a custom PNG that arrives later
 *  replaces the cached procedural sprite and emits 'asset' {id}. */
export function sprite(id, variant = 0) {
  const k = id + '~' + variant;
  const hit = cache.get(k);
  if (hit) return hit;
  return resolve(id, variant, k);
}

function resolve(id, variant, k) {
  try {
    if (typeof id !== 'string') return missingSprite();
    let s = customMap.get(id);
    if (!s) {
      const cat = splitId(id)[0];
      if (!CATEGORIES.includes(cat)) { s = missingSprite(); remember(k, s); return s; }
      if (!probed.has(id) && (AUTO_PROBE || artEntry(id))) startProbe(id);
      s = generate(id, variant) || missingSprite();
    }
    remember(k, s);
    return s;
  } catch (e) { return missingSprite(); }
}

// ---- custom PNG pipeline ------------------------------------------------------------------------------------
/** Fit an image to its category box. Returns a Sprite flagged custom + smooth. */
function buildCustom(id, img, entry) {
  const [cat] = splitId(id), box = boxFor(id, entry);
  const f = Math.max(1, (entry && entry.frames) | 0 || 1);
  const frameW = img.width / f, k = box.w / frameW, imgH = Math.max(1, Math.round(img.height * k)), fw = box.w;
  let left, top, W, H, ax, ay;
  if (cat === 'tile') {                       // top-left aligned: the top diamond sits at the top of the box
    left = 0; top = 0; W = fw; H = Math.max(box.h, imgH); ax = box.ax; ay = box.ay;
  } else {                                    // bottom-centre of the image on the anchor; grow, never crop
    left = Math.round(box.ax - fw / 2); top = box.ay - imgH;
    const minX = Math.min(0, left), maxX = Math.max(box.w, left + fw), minY = Math.min(0, top), maxY = Math.max(box.h, box.ay);
    W = maxX - minX; H = maxY - minY; ax = box.ax - minX; ay = box.ay - minY; left -= minX; top -= minY;
  }
  const o = canvas(W * f, H);
  const smooth = k < 2;                       // downscaling hand-drawn art: filter. Tiny pixel art: keep it crisp.
  const hi = { img, fw: frameW, ih: img.height, x: left, y: top, dw: fw, dh: imgH, frames: f, W };
  paintCustom(o.g, hi, 0, 0, 1, false, smooth);
  const spr = makeSprite(o.c, ax, ay, f, { custom: true, smooth: true });
  spr.hi = hi; spr.pixelCrisp = !smooth;
  return spr;
}

/** Paint every frame of a custom sprite's hi-res source into g at scale S (optionally mirroring each frame in place). */
function paintCustom(g, hi, ox, oy, S, flip, smooth) {
  g.imageSmoothingEnabled = smooth; g.imageSmoothingQuality = 'high';
  const fwS = Math.round(hi.W * S);
  for (let i = 0; i < hi.frames; i++) {
    const dx = ox + i * fwS + Math.round(hi.x * S), dy = oy + Math.round(hi.y * S), dw = Math.round(hi.dw * S), dh = Math.round(hi.dh * S);
    if (flip) {
      g.save(); g.translate(ox + i * fwS + fwS, 0); g.scale(-1, 1);
      g.drawImage(hi.img, i * hi.fw, 0, hi.fw, hi.ih, dx - (ox + i * fwS), dy, dw, dh);
      g.restore();
    } else g.drawImage(hi.img, i * hi.fw, 0, hi.fw, hi.ih, dx, dy, dw, dh);
  }
}

function installCustom(id, spr) {
  customMap.set(id, spr);
  const [cat] = splitId(id);
  for (let v = 0; v < (cat === 'tile' || cat === 'prop' ? TILE_VARIANTS : 1); v++) cache.set(id + '~' + v, spr);
  for (const k of [...iconCache.keys()]) if (k.startsWith(id + '~')) iconCache.delete(k);
  if (cat === 'hero') heroCache.clear();
  emit('asset', { id });
}

/** Load one PNG (promise<Image|null>). */
function loadImage(path) {
  return new Promise(res => {
    if (typeof Image === 'undefined') { res(null); return; }
    const im = new Image();
    im.decoding = 'async';
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = path;
  });
}

function pump() {
  while (active < PROBE_CONCURRENCY && queue.length) {
    const job = queue.shift(); active++;
    job.run().then(() => { active--; pump(); }, () => { active--; pump(); });
  }
}

/** Queue a probe for id (once). Returns a promise resolving true if a custom PNG loaded. */
function startProbe(id, force = false) {
  if (customMap.has(id)) return Promise.resolve(true);
  if (inflight.has(id)) return inflight.get(id);
  if (!force && (missing.has(id) || probed.has(id))) return Promise.resolve(false);
  probed.add(id);
  const entry = artEntry(id), path = ART_DIR + (entry ? entry.file : id + '.png');
  const p = new Promise(resolve => {
    queue.push({ id, run: async () => {
      let ok = false;
      try {
        // Ask with HEAD first: a missing file then costs a few header bytes instead of the host's whole 404 page
        // (GitHub Pages sends ~9 kB of HTML per miss). If HEAD itself fails (odd hosts), fall through to the image.
        let there = true;
        if (!entry && typeof fetch === 'function') { try { there = (await fetch(path, { method: 'HEAD' })).ok; } catch (e) { there = true; } }
        const img = there ? await loadImage(path) : null;
        if (img && img.width > 0 && img.height > 0) { installCustom(id, buildCustom(id, img, entry)); missing.delete(id); ok = true; }
        else missing.add(id);
      } catch (e) { missing.add(id); }
      inflight.delete(id); resolve(ok);
    } });
  });
  inflight.set(id, p);
  pump();
  return p;
}

/** For art.html: try to load the PNG of every id (ignores the session's 404 memory). Resolves to the Set of ids that
 *  have a custom PNG. Emits 'asset' for each one newly found. */
export async function probeAll(ids = allIds()) {
  const found = new Set();
  await Promise.all(ids.map(id => startProbe(id, true).then(ok => { if (ok) found.add(id); }).catch(() => {})));
  return found;
}
/** Ids whose custom PNG is currently loaded. */
export const customIds = () => [...customMap.keys()];
/** The `'id': true,` lines to paste into assets/manifest.js ART (for an AUTO_PROBE = false release build). */
export const manifestEntries = ids => (ids || customIds()).map(id => `  '${id}': true,`).join('\n');

// ---- gear / item / monster ids -----------------------------------------------------------------------------
/** Asset id of a gear object's icon: weapons 'item/wep-<type slug>', armour 'item/arm-<mat slug>-<slot>'. */
export const gearIconId = g => !g ? 'item/potion' : g.kind === 'wep' ? 'item/wep-' + slug(g.type || '') : 'item/arm-' + slug(g.mat || '') + '-' + g.slot;
/** Asset id of a ground item ({kind:'potion'|'gold'|'scroll'|'gear', gear?}). */
export const itemSpriteId = it => !it ? 'item/potion' : it.kind === 'gear' ? gearIconId(it.gear)
  : it.kind === 'potion' ? potSpriteId(it.pot) : 'item/' + it.kind;   // potions: tinted by the run colour (item/potion-<colour key>)
/** Asset id of a monster: 'enemy/' + (m.rare || m.id). */
export const monSpriteId = m => 'enemy/' + ((m && (m.rare || m.id)) || '');

// ---- the hero ------------------------------------------------------------------------------------------------
/** The hero as currently equipped (composited layers, outlined if all procedural, cached by look). In deep water
 *  pass swim = true. Custom hero layers keep their own look (no outline). */
export function heroSprite(P, swim = false) {
  try {
    const arm = (P && P.arm) || {}, wep = (P && P.wep) || { fists: true };
    const look = swim ? 'swim' : ['legs', 'body', 'arms', 'head'].map(s => arm[s] ? slug(arm[s].mat) : '-').join('|') + '|' + (wep.fists || !wep.type ? 'fists' : slug(wep.type));
    let s = heroCache.get(look);
    if (s) return s;
    const ids = swim ? ['hero/swim'] : ['hero/base'];
    if (!swim) {
      for (const sl of ['legs', 'body', 'arms', 'head']) if (arm[sl]) ids.push('hero/' + sl + '-' + slug(arm[sl].mat));
      if (!wep.fists && wep.type) ids.push('hero/wep-' + slug(wep.type));
    }
    const layers = [];
    for (const id of ids) { const sp = sprite(id); if (sp && sp !== MISSING && sp.img) layers.push(sp); }
    const B = BOX.hero;
    let L = B.ax, T = B.ay, Rr = B.w - B.ax, Bt = B.h - B.ay;    // extents around the anchor, at least the box
    for (const sp of layers) { L = Math.max(L, sp.ax); T = Math.max(T, sp.ay); Rr = Math.max(Rr, sp.w - sp.ax); Bt = Math.max(Bt, sp.h - sp.ay); }
    const { c, g } = canvas(L + Rr, T + Bt);
    let allProc = true;
    for (const sp of layers) {
      if (sp.custom) { allProc = false; g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; } else g.imageSmoothingEnabled = false;
      g.drawImage(sp.img, 0, 0, sp.w, sp.h, L - sp.ax, T - sp.ay, sp.w, sp.h);
    }
    if (allProc) outline(c);
    s = makeSprite(c, L, T, 1, allProc ? {} : { smooth: true });
    if (heroCache.size >= HERO_MAX) heroCache.delete(heroCache.keys().next().value);
    heroCache.set(look, s);
    return s;
  } catch (e) { return missingSprite(); }
}

// ---- blit ---------------------------------------------------------------------------------------------------------
function buildScaled(spr, S, flip) {
  const sw = Math.max(1, Math.round(spr.w * S)), sh = Math.max(1, Math.round(spr.h * S)), f = spr.frames || 1;
  const o = canvas(sw * f, sh), g = o.g;
  if (spr.hi) { paintCustom(g, spr.hi, 0, 0, S, flip, !spr.pixelCrisp); return o.c; }
  g.imageSmoothingEnabled = !!spr.smooth && !spr.pixelCrisp;
  for (let i = 0; i < f; i++) {
    if (flip) { g.save(); g.translate(i * sw + sw, 0); g.scale(-1, 1); g.drawImage(spr.img, i * spr.w, 0, spr.w, spr.h, 0, 0, sw, sh); g.restore(); }
    else g.drawImage(spr.img, i * spr.w, 0, spr.w, spr.h, i * sw, 0, sw, sh);
  }
  return o.c;
}
function buildSilhouette(src) {
  const o = canvas(src.width, src.height);
  o.g.drawImage(src, 0, 0);
  o.g.globalCompositeOperation = 'source-atop';
  o.g.fillStyle = '#fff'; o.g.fillRect(0, 0, src.width, src.height);
  return o.c;
}

/** Draw a sprite with its anchor at device pixel (x, y), scaled by S device px per art px.
 *  opts: { frame = 0, flip = false, alpha = 1, rows = all (draw only the top `rows` art rows — tile side cropping),
 *          flash = 0 (0..1 white hit flash) }. Uses a per-zoom pre-scaled cache so the blit itself is 1:1.
 *  Never throws. */
export function blit(ctx, spr, x, y, S, opts) {
  try {
    if (!spr || !spr.img || !(S > 0)) return;
    const o = opts || EMPTY;
    const flip = !!o.flip, alpha = o.alpha === undefined ? 1 : o.alpha, flash = o.flash || 0;
    if (alpha <= 0) return;
    const frames = spr.frames || 1;
    const frame = ((o.frame | 0) % frames + frames) % frames;
    let rows = o.rows === undefined ? spr.h : Math.min(spr.h, o.rows);
    if (rows <= 0) return;

    const sw = Math.round(spr.w * S), sh = Math.round(spr.h * S);
    const ax = flip ? spr.w - spr.ax : spr.ax;
    const dx = Math.round(x - ax * S), dy = Math.round(y - spr.ay * S);
    const rowsPx = rows >= spr.h ? sh : Math.max(1, Math.round(rows * S));

    let src;
    if (S === 1 && !flip) src = spr.img, S = 1;                       // 1x: draw the art directly
    else {
      if (S !== curS) { scaled = new Map(); curS = S; }                // zoom changed: drop every pre-scaled copy
      let e = scaled.get(spr); if (!e) scaled.set(spr, e = {});
      src = flip ? e.f || (e.f = buildScaled(spr, S, true)) : e.n || (e.n = buildScaled(spr, S, false));
    }
    const sx = S === 1 && !flip ? frame * spr.w : frame * sw, wd = S === 1 && !flip ? spr.w : sw, hd = S === 1 && !flip ? Math.min(spr.h, rows) : rowsPx;

    if (alpha !== 1) ctx.globalAlpha = alpha;
    ctx.drawImage(src, sx, 0, wd, hd, dx, dy, wd, hd);
    if (flash > 0) {
      let sil;
      if (S === 1 && !flip) { let e = scaled.get(spr); if (!e) scaled.set(spr, e = {}); sil = e.s1 || (e.s1 = buildSilhouette(spr.img)); }
      else { const e = scaled.get(spr); sil = flip ? e.sf || (e.sf = buildSilhouette(src)) : e.sn || (e.sn = buildSilhouette(src)); }
      ctx.globalAlpha = alpha * Math.min(1, flash);
      ctx.drawImage(sil, sx, 0, wd, hd, dx, dy, wd, hd);
    }
    if (alpha !== 1 || flash > 0) ctx.globalAlpha = 1;
  } catch (e) { try { ctx.globalAlpha = 1; } catch (_) { /* ignore */ } }
}
const EMPTY = {};

// ---- icons ---------------------------------------------------------------------------------------------------------
/** data: URL of a sprite's first frame for <img class="icon"> in UI panels (cached, bounded). */
export function iconURL(id, variant = 0) {
  const k = id + '~' + variant;
  let u = iconCache.get(k);
  if (u) return u;
  try {
    const s = sprite(id, variant), o = canvas(s.w, s.h);
    if (s.hi) { o.g.imageSmoothingEnabled = !s.pixelCrisp; o.g.imageSmoothingQuality = 'high'; }
    o.g.drawImage(s.img, 0, 0, s.w, s.h, 0, 0, s.w, s.h);
    u = o.c.toDataURL();
  } catch (e) { u = ''; }
  if (iconCache.size >= ICON_MAX) iconCache.delete(iconCache.keys().next().value);
  iconCache.set(k, u);
  return u;
}

// ---- catalogue (art.html, README checklist, tests) -------------------------------------------------------------------
/** Every asset id the game can ask for. */
export function allIds() {
  return [...(TILE_IDS || []), ...(PROP_IDS || []), ...(ENEMY_IDS || []), ...(NPC_IDS || []), ...(HERO_IDS || []), ...(ITEM_IDS || [])];
}

const titleCase = s => s.split('-').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
function labelFor(category, name) {
  try {
    if (category === 'enemy') { const e = enemyById(name); if (e && e.name) return e.name; }
    if (category === 'npc') { const n = NPCS && NPCS[name]; if (n && n.name) return n.name; }
    if (category === 'tile' || category === 'prop') {
      if (name === 'campfire') return 'campfire';
      const t = TERRAIN && TERRAIN[name]; if (t && t.name) return t.name;
    }
    if (category === 'hero') {
      if (name === 'base') return 'Naked hero';
      if (name === 'swim') return 'Swimming hero';
      if (name.startsWith('wep-')) return titleCase(name.slice(4));
      const i = name.indexOf('-'); return titleCase(name.slice(i + 1)) + ' ' + name.slice(0, i);
    }
    if (category === 'item') {
      if (name.startsWith('wep-')) return titleCase(name.slice(4));
      if (name.startsWith('arm-')) { const rest = name.slice(4), j = rest.lastIndexOf('-'); return titleCase(rest.slice(0, j)) + ' ' + rest.slice(j + 1); }
      return titleCase(name);
    }
  } catch (e) { /* fall through */ }
  return name;
}

/** { id, category, name, label, box, path, custom } — label is human-readable (enemy name, terrain name…). */
export function assetInfo(id) {
  const [category, name] = splitId(String(id)), entry = artEntry(id);
  return { id, category, name, label: labelFor(category, name), box: boxFor(id, null), path: ART_DIR + (entry ? entry.file : id + '.png'), custom: customMap.has(id) };
}
