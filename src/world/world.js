// world/world.js — the planet and every spatial query.
//
// What lives here
//   * Terrain generation, a bit-exact port of classic h2 / vn / fbm / biome() / tname(): the same seed makes the
//     same planet as the ASCII game.  Value noise is tileable over the WS x WS torus.
//   * A chunk cache: 32x32 typed-array chunks (terrain key index, biome, height, elevation, raw terrace level),
//     direct-indexed, LRU-capped.  After the first touch of a cell terr()/terrKey()/heightAt()/biome() are a few
//     array reads with no string allocation.  G.mods (chopped trees, broken walls) is folded into the cache.
//   * Visual elevation (Mountains terraces, never affects gameplay) and heightAt (presentation heights).
//   * Zones (named 64x64 regions), line of sight, visibility/exploration, 8-way BFS pathfinding.
//
// Coordinates: entity coordinates are unwrapped integers; every terrain lookup wraps onto the 768 torus.
// Pyramid floors (G.dg) bypass every cache and read the floor map directly.
import { G } from '../core/state.js';
import { WS, ZONE, BIOMES, BIOME_KEYS, dayInfo } from '../core/config.js';
import { hash2, mod, wx, WK, WI } from '../core/util.js';
import { emit } from '../core/bus.js';
import { TERRAIN, BIOME_GROUND, DOOR_KEYS, SPECIAL_STEP } from '../data/terrain.js';
import { HOME_ZONE, ZONE_ADJ, ZONE_NOUN } from '../data/flavor.js';
import { DTYPE, DUNGEONS_BY_BIOME } from '../data/dungeons.js';

// ---- terrain key table ---------------------------------------------------------------------------------
const KEYS = Object.keys(TERRAIN);
const KEYIDX = {}; KEYS.forEach((k, i) => { KEYIDX[k] = i; });
const K = KEYIDX;                                   // K.grass etc. (numeric ids used by the generator)
const DEFS = KEYS.map(k => TERRAIN[k]);
const BLK = Uint8Array.from(DEFS, d => (d.blocks ? 1 : 0));
const DEEP = Uint8Array.from(DEFS, d => (d.deep ? 1 : 0));
const SPEC = Uint8Array.from(DEFS, d => (SPECIAL_STEP.includes(d.key) ? 1 : 0));   // entrances, stairs, chest: auto-walk never crosses them mid-path
const LIQ = Uint8Array.from(DEFS, d => (d.kind === 'liquid' ? 1 : 0));
const VOID = K.void;

// ---- noise (bit-exact classic) -----------------------------------------------------------------------------
/** Classic h2 with the run seed mixed in. */
export const h2 = (x, y, s) => hash2(x, y, s + G.seed);

function vn(x, y, sc, s) {
  const per = Math.max(1, Math.round(WS / sc)), S = WS / per, fx = wx(x) / S, fy = wx(y) / S;
  const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
  const u = tx * tx * (3 - 2 * tx), v = ty * ty * (3 - 2 * ty), i2 = (ix + 1) % per, j2 = (iy + 1) % per;
  const a = h2(ix, iy, s), b = h2(i2, iy, s), c = h2(ix, j2, s), d = h2(i2, j2, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
/** Classic fbm value noise, tileable over the torus. */
export function fbm(x, y, sc, s) { return vn(x, y, sc, s) * .6 + vn(x, y, sc / 2, s + 7) * .3 + vn(x, y, sc / 4, s + 13) * .1; }

/** Torus distance from home (0,0), as classic tdist. */
export function tdist(x, y) { const a = wx(x), b = wx(y); return Math.hypot(Math.min(a, WS - a), Math.min(b, WS - b)); }
/** Player's rounded distance from home (classic dist0). Inside a pyramid: the pyramid's distance (G.dg.d). */
export const dist0 = () => Math.round(G.dg ? G.dg.d : tdist(G.P.x, G.P.y));

// ---- chunk cache -------------------------------------------------------------------------------------------
const CS = 32, CB = 5, NC = WS / CS, NCHUNK = NC * NC, CAP = 256;   // chunk size, shift, chunks per axis, total, LRU cap
const UNK = -128;                                                    // "not computed yet" for Int8 caches
let chunks = new Array(NCHUNK).fill(null), nChunks = 0, tick = 0;
let modsIdx = new Map();            // wrapped cell id (y*WS+x) -> terrain key index (G.mods folded in)
let siteCache = new Map();          // dungeon-site cell (cy*16+cx) -> Site | null (see siteInfo)
let zoneCache = new Map();          // zone cell / pyramid name -> zone object
let visList = [], visCount = 0, lastVis = null;

function newChunk(ci) {
  if (nChunks >= CAP) {                         // evict least recently used
    let worst = -1, wt = Infinity;
    for (let i = 0; i < NCHUNK; i++) { const c = chunks[i]; if (c !== null && c.t < wt) { wt = c.t; worst = i; } }
    if (worst >= 0) { chunks[worst] = null; nChunks--; }
  }
  const c = {
    t: 0,
    k: new Uint8Array(CS * CS),                 // terrain key index + 1 (0 = unknown)
    b: new Uint8Array(CS * CS),                 // biome + 1
    h: new Int8Array(CS * CS).fill(UNK),        // heightAt
    e: new Int8Array(CS * CS).fill(UNK),        // elevAt
    r: new Int8Array(CS * CS).fill(UNK),        // raw mountain terrace level
  };
  chunks[ci] = c; nChunks++;
  return c;
}
function chunkOf(ax, ay) {
  const ci = (ay >> CB) * NC + (ax >> CB);
  let c = chunks[ci];
  if (c === null) c = newChunk(ci);
  c.t = ++tick;
  return c;
}
const cellOf = (ax, ay) => ((ay & (CS - 1)) << CB) | (ax & (CS - 1));

/** Call after G.seed is set (new game and load). Clears every cache that depends on the seed or on G.mods. */
export function initWorld() {
  chunks = new Array(NCHUNK).fill(null); nChunks = 0; tick = 0;
  siteCache = new Map(); zoneCache = new Map(); modsIdx = new Map();
  visList = []; visCount = 0; lastVis = null;
  if (G.mods) for (const [k, v] of G.mods) {
    const p = k.indexOf(','), x = +k.slice(0, p), y = +k.slice(p + 1), ki = KEYIDX[v];
    if (ki !== undefined && x >= 0 && y >= 0 && x < WS && y < WS) modsIdx.set(y * WS + x, ki);
  }
}

// ---- biome ---------------------------------------------------------------------------------------------------
function biomeCalc(x, y) {                       // classic biome() without the pyramid shortcut; x,y wrapped
  const d = tdist(x, y);
  if (d < 20) return 0;
  if (fbm(x, y, 96, 1) + Math.max(0, d - 180) / 1400 > .71) return 3;
  if (fbm(x, y, 110, 40) > .6) return 4;
  const b = fbm(x, y, 70, 2);
  return b < .46 ? 0 : b < .56 ? 1 : 2;
}
function biomeAt(ax, ay) {                       // cached overworld biome of a wrapped cell
  const c = chunkOf(ax, ay), i = cellOf(ax, ay);
  let b = c.b[i];
  if (b === 0) { b = biomeCalc(ax, ay) + 1; c.b[i] = b; }
  return b - 1;
}
/** Biome index 0..4 (see config.BIOMES). Inside a dungeon: the dungeon's biome (old pyramid saves: 4). */
export function biome(x, y) { return G.dg ? (G.dg.b >= 0 && G.dg.b <= 4 ? G.dg.b : 4) : biomeAt(wx(x), wx(y)); }

// ---- dungeon sites (builder A) ---------------------------------------------------------------------------------
// The planet is cut into 16 x 16 cells of 48 tiles. Most cells hold one dungeon site, jittered inside the cell, so
// sites sit ~45-55 tiles apart in every biome. Which cells have one, where, and which of the biome's 15 types it is
// all come from the seeded h2, so they change every run. A pyramid site keeps the classic stepped pyramid with its
// 'pdoor'; every other site is a single entrance prop (DOOR_KEYS[biome]) in a small cleared yard.
export const SITE = 48;
const SITE_N = WS / SITE;
const DOORK = DOOR_KEYS.map(k => KEYIDX[k]);
const YARDK = BIOME_GROUND.map(k => KEYIDX[k]);
const oceanAt = (x, y) => fbm(wx(x), wx(y), 128, 30) < .345;
function pickType(b, h, noPyr) {
  const list = DUNGEONS_BY_BIOME[b] || [];
  let tot = 0;
  for (const t of list) if (!(noPyr && t.id === 'pyramid')) tot += t.weight || 1;
  let r = h * tot;
  for (const t of list) {
    if (noPyr && t.id === 'pyramid') continue;
    r -= t.weight || 1;
    if (r < 0) return t;
  }
  return list[list.length - 1] || null;
}
/** Site of grid cell (cx, cy) (wrapped onto the 16 x 16 grid) or null. Cached; treat as read-only.
 *  Site: { cx, cy, px, py, b, type, pyr, r, dx, dy } — (dx, dy) is the entrance tile (wrapped coordinates). */
export function siteInfo(cx, cy) {
  cx = mod(cx, SITE_N); cy = mod(cy, SITE_N);
  const ck = cy * SITE_N + cx;
  let p = siteCache.get(ck);
  if (p !== undefined) return p;
  p = null;
  if (h2(cx, cy, 50) < .88) {
    const px = cx * SITE + 12 + Math.floor(h2(cx, cy, 55) * 24), py = cy * SITE + 10 + Math.floor(h2(cx, cy, 56) * 22);
    if (tdist(px, py) >= 32 && !oceanAt(px, py)) {
      const b = biomeAt(px, py);
      let t = pickType(b, h2(cx, cy, 53), false), r = 0;
      if (t && t.id === 'pyramid') {
        r = 4 + Math.floor(h2(cx, cy, 52) * 3);
        let ok = true;
        for (const [ax, ay] of [[-r, -r], [r, -r], [-r, r + 1], [r, r + 1], [0, r + 1]]) {
          if (biomeAt(wx(px + ax), wx(py + ay)) !== 4 || oceanAt(px + ax, py + ay)) { ok = false; break; }
        }
        if (!ok) { t = pickType(b, h2(cx, cy, 58), true); r = 0; }
      }
      if (t) {
        const pyr = t.id === 'pyramid';
        p = { cx, cy, px, py, b, type: t.id, pyr, r, dx: px, dy: pyr ? py + r : py };
      }
    }
  }
  siteCache.set(ck, p);
  return p;
}
/** The site whose entrance is the tile (x, y), or null. */
export function siteAtDoor(x, y) {
  const ax = wx(x), ay = wx(y), s = siteInfo(Math.floor(ax / SITE), Math.floor(ay / SITE));
  return s && s.dx === ax && s.dy === ay ? s : null;
}

// ---- generation (classic tname) ------------------------------------------------------------------------------
function genIdx(x, y) {                          // x,y wrapped; returns terrain key index of the generated planet
  const st = siteInfo(Math.floor(x / SITE), Math.floor(y / SITE));
  if (st) {
    if (st.pyr) {
      const r = st.r, dx = Math.abs(x - st.px), dy = y - st.py;
      if (dx <= r && Math.abs(dy) <= r) return dx === 0 && dy === r ? K.pdoor : K.pyr;
      if (dx <= r + 1 && dy === r + 1) return K.sand;
    } else {
      const dx = x - st.px, dy = y - st.py, ax = Math.abs(dx), ay = Math.abs(dy);
      if (!dx && !dy) return DOORK[st.b];
      if (ax <= 2 && ay <= 2 && ax + ay < 4) return YARDK[st.b];     // a small cleared yard so the door is reachable
    }
  }
  const b = biomeAt(x, y);
  if (tdist(x, y) > 25) {
    const o = fbm(x, y, 128, 30);
    if (o < .315) return K.deep;
    if (o < .335) return K.water;
  }
  if (b === 0) {
    const rv = Math.abs(fbm(x, y, 45, 9) - .5);
    if (rv < .007) return K.deep;
    if (rv < .022) return K.water;
    const r = fbm(x, y, 6, 3), r2 = h2(x, y, 4);
    return r > .63 || r2 < .035 ? K.tree : r < .38 ? K.bush : K.grass;
  }
  if (b === 1) {
    const bf = fbm(x, y, 10, 6);
    if (bf > .66) return K.deep;
    if (bf > .57) return K.bogw;
    if (h2(x, y, 4) < .03) return K.dtree;
    return fbm(x, y, 6, 3) < .4 ? K.reed : K.mud;
  }
  if (b === 2) {
    const S = 12, cx = Math.floor(x / S), cy = Math.floor(y / S), lx = mod(x, S), ly = mod(y, S);
    if (h2(cx, cy, 20) < .6) {
      if ((lx === 0 || ly === 0) && lx !== 6 && ly !== 6) return h2(x, y, 21) < .12 ? K.rubble : K.wall;
      if (lx % 4 === 2 && ly % 4 === 2 && h2(cx, cy, 22) < .5) return K.pillar;
      return K.stone;
    }
    return h2(x, y, 4) < .15 ? K.rubble : K.stone;
  }
  if (b === 4) {
    if (fbm(x, y, 9, 8) > .68) return K.srock;
    return h2(x, y, 4) < .02 ? K.cactus : fbm(x, y, 6, 3) > .62 ? K.dune : K.sand;
  }
  const f = fbm(x, y, 9, 8);
  if (f > .6 || h2(x, y, 4) < .02) return K.rock;
  return f < .4 ? K.ice : fbm(x, y, 6, 3) < .45 ? K.scree : K.snow;
}

function floorIdx(x, y) {                        // pyramid floor lookup -> key index
  const row = G.dg.floors[G.dg.i].map[y];
  const k = row && row[x];
  const i = k ? KEYIDX[k] : undefined;
  return i === undefined ? VOID : i;
}
/** Terrain key index at a tile (cached, O(1) after first touch). */
function terrIdx(x, y) {
  if (G.dg) return floorIdx(x, y);
  const ax = wx(x), ay = wx(y), c = chunkOf(ax, ay), i = cellOf(ax, ay);
  const v = c.k[i];
  if (v !== 0) return v - 1;
  let ki;
  if (modsIdx.size) ki = modsIdx.get(ay * WS + ax);
  if (ki === undefined) ki = genIdx(ax, ay);
  c.k[i] = ki + 1;
  return ki;
}

/** Terrain key at a tile. Honours pyramids (G.dg floor map) and G.mods. */
export const terrKey = (x, y) => KEYS[terrIdx(x, y)];
/** TerrainDef (data/terrain.js) at a tile. */
export const terr = (x, y) => DEFS[terrIdx(x, y)];
/** Overworld only: change a tile (chopped tree, broken wall). Stores in G.mods, invalidates caches, emits 'terrain'. */
export function setTerrain(x, y, key) {
  const from = terrKey(x, y);
  G.mods.set(WK(x, y), key);
  const ki = KEYIDX[key];
  if (ki !== undefined) {
    const ax = wx(x), ay = wx(y);
    modsIdx.set(ay * WS + ax, ki);
    const c = chunks[(ay >> CB) * NC + (ax >> CB)];
    if (c) { const i = cellOf(ax, ay); c.k[i] = ki + 1; c.h[i] = UNK; }   // heights are per cell; elevation ignores terrain
  }
  emit('terrain', { x, y, from, to: key });
}
export const blocks = (x, y) => BLK[terrIdx(x, y)] === 1;
export const isDeep = (x, y) => DEEP[terrIdx(x, y)] === 1;

/** The current dungeon's type entry (old saves without a type are pyramids), or null on the overworld. */
export const dgType = () => (G.dg ? DTYPE[G.dg.type] || DTYPE.pyramid : null);
/** Ground terrain key drawn under a prop: def.ground, with 'auto' resolved to the biome's base ground
 *  (inside a dungeon: the dungeon type's floor). */
export function groundKey(x, y) {
  const d = terr(x, y);
  if (d.kind !== 'prop') return d.key;
  if (d.ground !== 'auto') return d.ground;
  if (G.dg) { const t = dgType(); return (t && t.floor) || 'pfloor'; }
  return BIOME_GROUND[biome(x, y)];
}

// ---- elevation and height (visual only) ----------------------------------------------------------------------
function rawLevel(ax, ay) {                      // terrace level 0/2/4/6 from smooth noise (mountain cells only)
  const c = chunkOf(ax, ay), i = cellOf(ax, ay);
  let v = c.r[i];
  if (v === UNK) {
    const lvl = Math.max(0, Math.min(3, Math.floor((fbm(ax, ay, 14, 77) - .3) * 7)));
    v = lvl * 2; c.r[i] = v;
  }
  return v;
}
/** "Low" cells pin the terraces to 0: anything outside the Mountains, and every lake, river and sea inside them
 *  (water lies flat; the land steps down to it, so mountain lakes sit in bowls instead of on staircases). */
const lowAt = (ax, ay) => biomeAt(ax, ay) !== 3 || LIQ[terrIdx(ax, ay)] === 1;
function elevCalc(ax, ay) {
  if (lowAt(ax, ay)) return 0;
  // Distance (Chebyshev) to the nearest low tile, searched out to 5. Flat within 2, then +2 per tile.
  let m = 6;
  search: for (let d = 1; d <= 5; d++) {
    for (let dy = -d; dy <= d; dy++) {
      const edge = dy === -d || dy === d, step = edge ? 1 : 2 * d;
      for (let dx = -d; dx <= d; dx += step) if (lowAt(wx(ax + dx), wx(ay + dy))) { m = d; break search; }
    }
  }
  if (m <= 2) return 0;
  const cap = 2 * (m - 2);
  // Lipschitz envelope: no 4-neighbour may differ by more than 2 ZU (inf-convolution of the raw terraces, slope 2).
  let env = 6;
  for (let dy = -3; dy <= 3; dy++) {
    const rx = 3 - Math.abs(dy);
    for (let dx = -rx; dx <= rx; dx++) {
      const bx = wx(ax + dx), by = wx(ay + dy);
      const raw = lowAt(bx, by) ? 0 : rawLevel(bx, by);
      const v = raw + 2 * (Math.abs(dx) + Math.abs(dy));
      if (v < env) env = v;
    }
  }
  return Math.max(0, Math.min(env, cap));
}
/** Visual ground elevation in ZU (integer >= 0). 0 outside the Mountains and in pyramids; smooth terraces
 *  0/2/4/6 inside them, flat within 2 tiles of the border, never more than 2 ZU apart between 4-neighbours. */
export function elevAt(x, y) {
  if (G.dg) return 0;
  const ax = wx(x), ay = wx(y), c = chunkOf(ax, ay), i = cellOf(ax, ay);
  let e = c.e[i];
  if (e === UNK) { e = elevCalc(ax, ay); c.e[i] = e; }
  return e;
}
function heightCalc(ax, ay, idx) {               // ax,ay wrapped (or raw floor coordinates in a pyramid)
  const d = DEFS[idx], el = G.dg ? 0 : elevAt(ax, ay);
  if (d.kind === 'liquid') return el - 1;
  if (d.kind === 'ground') return el + d.h;
  if (d.kind === 'solid') {
    if (G.dg) {
      // Inside a dungeon, a wall standing in FRONT of open floor (floor behind it on screen) is drawn as a low
      // kerb so rooms are never hidden behind their own near walls; back walls keep their full height.
      if (BLK[floorIdx(ax - 1, ay)] === 0 || BLK[floorIdx(ax, ay - 1)] === 0 || BLK[floorIdx(ax - 1, ay - 1)] === 0) return 2;
      return 6;
    }
    switch (d.key) {
      case 'rock': return el + 4 + Math.floor(h2(ax, ay, 92) * 5);
      case 'srock': return el + 3 + Math.floor(h2(ax, ay, 92) * 4);
      case 'pyr': {
        const pi = siteInfo(Math.floor(ax / SITE), Math.floor(ay / SITE));
        if (!pi || !pi.pyr) return el + d.h;
        const ring = pi.r - Math.max(Math.abs(ax - pi.px), Math.abs(ay - pi.py));
        return el + 3 * (Math.max(0, ring) + 1);
      }
      default: return el + 6;                    // wall
    }
  }
  return el;                                      // props, void
}
/** Visual height of the tile's top surface in ZU: elevAt + column height (solids, with per-tile variation),
 *  -1 for liquids. This is where creatures stand (for non-solids) and where the block's top diamond is drawn. */
export function heightAt(x, y) {
  if (G.dg) return heightCalc(x, y, floorIdx(x, y));
  const ax = wx(x), ay = wx(y), idx = terrIdx(ax, ay), c = chunkOf(ax, ay), i = cellOf(ax, ay);
  let h = c.h[i];
  if (h === UNK) { h = heightCalc(ax, ay, idx); c.h[i] = h; }
  return h;
}
/** Stable 0..3 per tile for art variety. */
export const variantAt = (x, y) => Math.floor(h2(wx(x), wx(y), 91) * 4);

// ---- zones (EverQuest-style named regions) ------------------------------------------------------------
/** Zone containing a tile: {id, name, biome, danger}. id is stable per ZONE x ZONE cell (cells are offset by half a
 *  zone so home sits in the middle of cell 0,0); danger = 1..5 skulls from the cell centre's distance from home.
 *  Zones are per cell x biome at the tile; the home cell's jungle is HOME_ZONE. Inside a pyramid: {id:'pyr:'+G.dg.k, name: locName(), biome:4, danger:5}.
 *  Zone objects are cached per cell: repeated calls do not allocate (treat them as read-only). */
export function zoneAt(x, y) {
  if (G.dg) {
    const name = locName();
    let z = zoneCache.get(name);
    if (!z || z.id !== 'pyr:' + G.dg.k) { z = { id: 'pyr:' + G.dg.k, name, biome: biome(0, 0), danger: 5 }; zoneCache.set(name, z); }
    return z;
  }
  const cx = Math.floor(wx(x + ZONE / 2) / ZONE), cy = Math.floor(wx(y + ZONE / 2) / ZONE);
  const b = biome(x, y), ck = (cy * 64 + cx) * 5 + b;      // one zone per cell x biome, so the name always matches the ground underfoot
  let z = zoneCache.get(ck);
  if (z) return z;
  if (!cx && !cy && b === 0) z = { id: '0,0', name: HOME_ZONE, biome: 0, danger: 1 };
  else {
    const k = BIOME_KEYS[b];
    const name = 'The ' + ZONE_ADJ[k][Math.floor(h2(cx, cy, 61) * 10)] + ' ' + ZONE_NOUN[k][Math.floor(h2(cx, cy, 62) * 10)];
    z = { id: cx + ',' + cy + (b ? ':' + b : ''), name, biome: b, danger: Math.max(1, Math.min(5, 1 + Math.floor(tdist(cx * ZONE, cy * ZONE) / 90))) };
  }
  zoneCache.set(ck, z);
  return z;
}
/** Classic locName(): biome name on the overworld, "<dungeon name> · floor i/n" inside one. */
export function locName() {
  if (!G.dg) return BIOMES[biome(G.P.x, G.P.y)];
  const t = dgType(), name = t && t.id !== 'pyramid' ? t.name : 'Pyramid';
  return `${name} · ${t && t.dir === 'down' ? 'level' : 'floor'} ${G.dg.i + 1}/${G.dg.n}`;
}

// ---- who is where --------------------------------------------------------------------------------------
export const monAt = (x, y) => G.mons.find(m => m.x === x && m.y === y);
export const npcAt = (x, y) => G.npcs.find(n => n.x === x && n.y === y);
/** Is the hero's campfire on this tile? (Nothing may stand on it.) */
export const campAt = (x, y) => { const c = G.P.camp; return !!c && !G.dg && c.x === x && c.y === y; };
/** Walkable and empty (no monster, NPC, campfire or player). */
export const free = (x, y) => !blocks(x, y) && !monAt(x, y) && !npcAt(x, y) && !campAt(x, y) && !(x === G.P.x && y === G.P.y);
/** Can monster m stand there? Swimmers need deep water; everything else needs not-deep. */
export const mfree = (m, x, y) => free(x, y) && (m.ai === 'swim') === isDeep(x, y);

// ---- sight ------------------------------------------------------------------------------------------------
const seenIdx = (x, y) => G.dg ? (x >= 0 && y >= 0 && x < G.seenW && y * G.seenW + x < G.seen.length ? y * G.seenW + x : -1) : WI(x, y);
/** Classic line of sight. */
export function los(x0, y0, x1, y1) {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let i = 1; i < n; i++) if (blocks(Math.round(x0 + (x1 - x0) * i / n), Math.round(y0 + (y1 - y0) * i / n))) return false;
  return true;
}
const offsetCache = new Map();                    // radius -> flat [dx,dy,dx,dy,…] of tiles with hypot <= r + .3
function offsetsFor(r) {
  let o = offsetCache.get(r);
  if (!o) {
    o = [];
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (Math.hypot(dx, dy) <= r + .3) o.push(dx, dy);
    offsetCache.set(r, o);
  }
  return o;
}
/** Recompute G.vis around the player and mark G.seen. Radius: dayInfo(G.turn).radius on the overworld
 *  (9 by day, 7 at night; 9 within 3 tiles of your campfire); inside a dungeon dgVisR() (9, or 4 when 'dark'). */
export function calcVis() {
  const P = G.P;
  if (G.vis !== lastVis || G.vis.length !== G.seen.length) {   // arrays were swapped (pyramid floor, load, new game)
    if (G.vis.length !== G.seen.length) G.vis = new Uint8Array(G.seen.length); else G.vis.fill(0);
    lastVis = G.vis; visCount = 0;
  }
  const vis = G.vis, seen = G.seen;
  for (let i = 0; i < visCount; i++) vis[visList[i]] = 0;
  visCount = 0;
  let r = G.dg ? dgVisR() : dayInfo(G.turn).radius;
  if (!G.dg && P.camp && Math.abs(P.camp.x - P.x) <= 3 && Math.abs(P.camp.y - P.y) <= 3) r = 9;
  const o = offsetsFor(r);
  for (let k = 0; k < o.length; k += 2) {
    const x = P.x + o[k], y = P.y + o[k + 1];
    if (!los(P.x, P.y, x, y)) continue;
    const i = seenIdx(x, y); if (i < 0) continue;
    vis[i] = 1; seen[i] = 1; visList[visCount++] = i;
  }
  if (!G.dg) revealPyramids(r);
}
/** Vision radius inside the current dungeon: 9, or 4 when the type's twist is 'dark'. */
export function dgVisR() { const t = dgType(); return t && t.twist === 'dark' ? 4 : 9; }
/** Landmarks: a stepped pyramid towers over its own bottom course, so once any block of it is in view the whole
 *  thing is (presentation only: every pyramid block is solid, nothing can stand or hide on one). */
function revealPyramids(r) {
  const P = G.P, vis = G.vis, seen = G.seen, ax = wx(P.x), ay = wx(P.y);
  const c0x = Math.floor(ax / SITE), c0y = Math.floor(ay / SITE);
  for (let cy = c0y - 1; cy <= c0y + 1; cy++) for (let cx = c0x - 1; cx <= c0x + 1; cx++) {
    const pi = siteInfo(cx, cy);
    if (!pi || !pi.pyr) continue;
    let dx = pi.px - ax, dy = pi.py - ay;
    dx -= Math.round(dx / WS) * WS; dy -= Math.round(dy / WS) * WS;
    if (Math.max(Math.abs(dx), Math.abs(dy)) > r + pi.r) continue;
    const X = P.x + dx, Y = P.y + dy, pr = pi.r;
    let any = false;                                    // is any block of the outer course visible?
    for (let k = -pr; k <= pr && !any; k++) any = vis[WI(X + k, Y - pr)] === 1 || vis[WI(X + k, Y + pr)] === 1 || vis[WI(X - pr, Y + k)] === 1 || vis[WI(X + pr, Y + k)] === 1;
    if (!any) continue;
    for (let y = Y - pr; y <= Y + pr; y++) for (let x = X - pr; x <= X + pr; x++) {
      const i = WI(x, y);
      if (vis[i] !== 1) { vis[i] = 1; seen[i] = 1; visList[visCount++] = i; }
    }
  }
}
export const isVis = (x, y) => { const i = seenIdx(x, y); return i >= 0 && G.vis[i] === 1; };
export const isSeen = (x, y) => { const i = seenIdx(x, y); return i >= 0 && G.seen[i] === 1; };

// ---- pathfinding (classic BFS, 8-way, from the player) ----------------------------------------------------
const BOX = 40, BW = 2 * BOX + 1, BN = BW * BW;
const pfStamp = new Int32Array(BN), pfPrev = new Int32Array(BN), pfQueue = new Int32Array(BN);
const pfMon = new Int32Array(BN), pfBlock = new Uint8Array(BN);       // monster index + 1 (first wins); npc/camp flag
let pfRun = 0;
/** Path from the player to (tx,ty) as [[x,y],…] (first step first), [] if already there, null if none.
 *  opts.adj: stop when adjacent (attack / work targets).  opts.wet: allow swimming through deep water.
 *  opts.thru: path through visible monsters (last resort).  opts.shown(m): predicate "is this monster visible"
 *  (pass monsters.shown; default: every monster blocks). Search is limited to 40 tiles and 9000 nodes (classic). */
export function findPath(tx, ty, opts = {}) {
  const { adj = false, wet = false, thru = false, shown = () => true, spec = false } = opts, P = G.P, px = P.x, py = P.y;
  const mons = G.mons;
  pfRun++; if (pfRun > 2000000000) { pfStamp.fill(0); pfRun = 1; }
  const run = pfRun;
  pfMon.fill(0); pfBlock.fill(0);
  const inBox = (x, y) => Math.abs(x - px) <= BOX && Math.abs(y - py) <= BOX;
  for (let i = 0; i < mons.length; i++) {
    const m = mons[i];
    if (!inBox(m.x, m.y)) continue;
    const b = (m.y - py + BOX) * BW + (m.x - px + BOX);
    if (pfMon[b] === 0) pfMon[b] = i + 1;
  }
  for (const n of G.npcs) if (inBox(n.x, n.y)) pfBlock[(n.y - py + BOX) * BW + (n.x - px + BOX)] = 1;
  const camp = P.camp;
  if (camp && !G.dg && inBox(camp.x, camp.y)) pfBlock[(camp.y - py + BOX) * BW + (camp.x - px + BOX)] = 1;

  const start = BOX * BW + BOX;
  pfStamp[start] = run; pfPrev[start] = -1; pfQueue[0] = start;
  let qn = 1;
  for (let qi = 0; qi < qn && qi < 9000; qi++) {
    const cur = pfQueue[qi], x = px + (cur % BW) - BOX, y = py + ((cur / BW) | 0) - BOX;
    if (adj ? Math.abs(x - tx) <= 1 && Math.abs(y - ty) <= 1 : x === tx && y === ty) {
      const path = [];
      for (let c = cur; pfPrev[c] >= 0; c = pfPrev[c]) path.push([px + (c % BW) - BOX, py + ((c / BW) | 0) - BOX]);
      return path.reverse();
    }
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const nx = x + a, ny = y + b;
      if (Math.abs(nx - px) > BOX || Math.abs(ny - py) > BOX) continue;
      const ni = (ny - py + BOX) * BW + (nx - px + BOX);
      if (pfStamp[ni] === run) continue;
      const ti = terrIdx(nx, ny);
      if (BLK[ti] === 1 || (!wet && DEEP[ti] === 1 && !(nx === tx && ny === ty))) continue;
      if (!spec && SPEC[ti] === 1 && !(nx === tx && ny === ty)) continue;   // don't wander into a dungeon / up the stairs by accident
      if (pfBlock[ni] === 1) continue;
      const mi = pfMon[ni];
      if (mi !== 0 && !thru && shown(mons[mi - 1])) continue;
      pfStamp[ni] = run; pfPrev[ni] = cur; pfQueue[qn++] = ni;
    }
  }
  return spec ? null : findPath(tx, ty, { ...opts, spec: true });   // a stair is the only way through: allow it
}
