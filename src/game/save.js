// game/save.js — autosave / resume for one life. One slot in localStorage under config.SAVE_KEY (format v1).
// Everything here is wrapped so that a full, forbidden or corrupt localStorage can never break the game:
// saveGame()/loadGame() never throw.
//
// The overworld lists stored under `ow` are ALWAYS the overworld's. Outside a pyramid they are the live
// G.mons/G.npcs/G.items/G.seen; inside one they come from the P.ow stash, and the live lists belong to the
// current floor and are written into that floor. P.ow itself is never saved raw. While inside a pyramid, `ow`
// also carries `x`,`y` (the hero's overworld position) so that leaving after a reload puts them back at the door.
import { G, resetState } from '../core/state.js';
import { onSim as on, emit } from '../core/bus.js';
import { SAVE_KEY, VERSION, WS } from '../core/config.js';
import { rleBits, unrleBits } from '../core/util.js';
import * as world from '../world/world.js';

const SAVE_V = 1;
const EVERY_TURNS = 40;      // throttle: save after this many turns ...
const EVERY_MS = 5000;       // ... or this many ms, whichever comes first
const LOG_KEEP = 30;
const IMMEDIATE = ['floor', 'zone', 'levelup', 'equip', 'quest', 'chest', 'claim'];   // events that save at once

// Floor-map packing: one character per tile.
const TILE_TO_CH = { pwall: '#', pfloor: '.', up: '<', down: '>', chest: 'C', void: ' ' };
const CH_TO_TILE = { '#': 'pwall', '.': 'pfloor', '<': 'up', '>': 'down', 'C': 'chest', ' ': 'void' };

let sinceTurns = 0, lastAt = 0, wired = false;

// ---- small helpers --------------------------------------------------------------------------------------------
const storageOk = () => { try { return typeof localStorage !== 'undefined' && !!localStorage; } catch (e) { return false; } };
/** Map -> [[key, value]…] (values are plain JSON data; JSON.stringify drops any stray function). */
const mapToPairs = m => (m instanceof Map ? [...m] : []);
/** [[key, value]…] -> Map, rejecting anything that is not an array of pairs. */
function pairsToMap(a) {
  if (!Array.isArray(a)) throw new Error('save: bad pair list');
  const m = new Map();
  for (const p of a) { if (!Array.isArray(p) || p.length < 2) throw new Error('save: bad pair'); m.set(p[0], p[1]); }
  return m;
}
const need = (cond, what) => { if (!cond) throw new Error('save: ' + what); };
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isArr = Array.isArray;

function packMap(map) {
  return map.map(row => {
    let s = '';
    for (let x = 0; x < row.length; x++) s += TILE_TO_CH[row[x]] || ' ';
    return s;
  });
}
function unpackMap(rows, s) {
  need(isArr(rows) && rows.length === s, 'floor rows');
  return rows.map(r => {
    need(typeof r === 'string' && r.length === s, 'floor row width');
    const out = new Array(s);
    for (let x = 0; x < s; x++) out[x] = CH_TO_TILE[r[x]] || 'void';
    return out;
  });
}

/** Serialise one floor. `live` (current floor only) supplies the lists the game is actually mutating.
 *  v0.3 floors hold many terrain keys, so the map is stored with a per-floor palette: `pal` lists the keys and each
 *  map character is String.fromCharCode(48 + palette index). Floors without `pal` (older saves) use packMap's table. */
function packFloor(f, live) {
  if (!f) return null;
  const mons = live ? live.mons : f.mons, items = live ? live.items : f.items, seen = live ? live.seen : f.seen;
  const pal = [], at = new Map();
  const map = f.map.map(row => {
    let s = '';
    for (let x = 0; x < row.length; x++) {
      const k = row[x] || 'void';
      let i = at.get(k);
      if (i === undefined) { i = pal.length; pal.push(k); at.set(k, i); }
      s += String.fromCharCode(48 + i);
    }
    return s;
  });
  const out = {
    s: f.s, pal, map, down: f.down, up: f.up,
    mons: mons || [], items: mapToPairs(items), seen: rleBits(seen || new Uint8Array(0)), looted: f.looted ? 1 : 0,
  };
  if (f.keyed) out.keyed = 1;
  if (f.cap) out.cap = f.cap;
  if (f.sw) out.sw = 1;
  return out;
}

function packPyr(D, inside, full) {
  const out = { k: D.k, n: D.n, d: D.d, i: inside ? D.i : (D.i || 0), floors: [],
    type: D.type || 'pyramid', b: D.b, dir: D.dir === -1 ? -1 : 1, tw: D.tw || {}, cl: D.cl ? 1 : 0 };
  if (!full && !inside) return out;                     // quota fallback: keep the door, forget the rooms
  for (let i = 0; i < D.floors.length; i++) {
    const f = D.floors[i];
    out.floors.push(packFloor(f, inside && i === D.i ? { mons: G.mons, items: G.items, seen: G.seen } : null));
  }
  return out;
}

/** Build the plain-object snapshot of the current life. `lean` = the quota fallback. */
function snapshot(lean) {
  const P = G.P, inside = !!G.dg;
  const p = {};
  for (const k of Object.keys(P)) if (k !== 'ow' && k !== 'work') p[k] = P[k];
  p.work = mapToPairs(P.work);
  const ow = inside
    ? { x: P.ow.x, y: P.ow.y, mons: P.ow.mons, npcs: P.ow.npcs, items: mapToPairs(P.ow.items), seen: rleBits(P.ow.seen) }
    : { mons: G.mons, npcs: G.npcs, items: mapToPairs(G.items), seen: rleBits(G.seen) };
  const pyr = [];
  for (const D of G.pyr.values()) pyr.push(packPyr(D, inside && D === G.dg, !lean));
  return {
    v: SAVE_V, ver: VERSION, t: Date.now(), seed: G.seed, turn: G.turn, home: G.home, zone: G.zone,
    P: p, inDg: inside ? G.dg.k : null, ow,
    spawned: [...G.spawned], mods: mapToPairs(G.mods), dex: [...G.dex], quests: G.quests,
    log: lean ? [] : G.log.slice(0, LOG_KEEP), pyr,
    run: G.run || {},
  };
}

// ---- public API ------------------------------------------------------------------------------------------------
/** Hook up autosave: throttled on 'turn', immediate on key events and when the page is hidden, wipe on 'death'. */
export function initSave() {
  if (wired) return;
  wired = true;
  sinceTurns = 0; lastAt = Date.now();
  on('turn', () => {
    if (G.over) return;
    sinceTurns++;
    if (sinceTurns >= EVERY_TURNS || Date.now() - lastAt >= EVERY_MS) saveGame();
  });
  for (const ev of IMMEDIATE) on(ev, () => { saveGame(); });
  on('newgame', () => { saveGame(); });
  on('death', () => { wipeSave(); });
  try {
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveGame(); });
    if (typeof window !== 'undefined') window.addEventListener('pagehide', () => { saveGame(); });
  } catch (e) { /* no DOM: nothing to hook */ }
}

/** Serialise G to localStorage. Returns true on success. Never throws. */
export function saveGame() {
  try {
    if (G.room) return false;                           // MULTIPLAYER: the room's world is not this device's solo life
    if (!G.P || G.over || !G.seen || !G.pyr || !storageOk()) return false;
    if (G.dg && !G.P.ow) return false;                  // mid-swap: refuse rather than write half a life
    let json;
    try { json = JSON.stringify(snapshot(false)); localStorage.setItem(SAVE_KEY, json); }
    catch (e) {
      try { json = JSON.stringify(snapshot(true)); localStorage.setItem(SAVE_KEY, json); }
      catch (e2) { return false; }
    }
    sinceTurns = 0; lastAt = Date.now();
    return true;
  } catch (e) { return false; }
}

/** Restore a saved life into G. Returns false (and wipes the slot) if there is none, or it is corrupt/old. Never throws. */
export function loadGame() {
  let raw = null;
  try { raw = storageOk() ? localStorage.getItem(SAVE_KEY) : null; } catch (e) { return false; }
  if (!raw) return false;
  try {
    restoreSnapshot(JSON.parse(raw));
    return true;
  } catch (e) {
    wipeSave();
    return false;
  }
}

/** MULTIPLAYER: the whole world as plain JSON (host -> joiners, and every client's copy for host handover). */
export function worldSnapshot() { return snapshot(false); }
/** MULTIPLAYER: one dungeon, every floor, for a client entering it. */
export function packDungeon(D) { return packPyr(D, false, true); }
/** MULTIPLAYER: rebuild one packed dungeon (the inverse of packDungeon). */
export function unpackDungeon(pd) { return unpackPyr(pd); }

/** Rebuild G from a snapshot object (save slot or host). Throws on anything malformed. Emits 'loaded'. */
export function restoreSnapshot(d) {
  {
    need(d && typeof d === 'object' && d.v === SAVE_V, 'version');
    need(isNum(d.seed) && isNum(d.turn) && d.home && isNum(d.home.x) && isNum(d.home.y), 'header');
    const sp = d.P;
    need(sp && isNum(sp.x) && isNum(sp.y) && isNum(sp.hp) && isNum(sp.max) && isArr(sp.inv) && sp.arm && sp.wep && isArr(sp.spells) && sp.buffs, 'player');
    need(d.ow && isArr(d.ow.mons) && isArr(d.ow.npcs) && isArr(d.pyr) && isArr(d.log) && d.quests, 'sections');

    resetState(d.seed);
    G.turn = d.turn; G.home = d.home; G.over = false;
    const P = G.P;
    for (const k of Object.keys(sp)) if (k !== 'work' && k !== 'ow') P[k] = sp[k];
    P.work = pairsToMap(sp.work); P.ow = null;
    G.spawned = new Set(d.spawned); G.dex = new Set(d.dex);
    G.mods = pairsToMap(d.mods);
    G.quests = d.quests; G.log = d.log.slice(0, LOG_KEEP);
    G.run = d.run && typeof d.run === 'object' ? d.run : {};

    for (const pd of d.pyr) { const D = unpackPyr(pd); G.pyr.set(D.k, D); }

    // overworld lists (live when outside; stashed in P.ow when inside)
    const owSeen = unrleBits(d.ow.seen, WS * WS), owItems = pairsToMap(d.ow.items);
    need(owSeen.length === WS * WS, 'seen size');
    if (d.inDg == null) {
      G.mons = d.ow.mons; G.npcs = d.ow.npcs; G.items = owItems;
      G.seen = owSeen; G.seenW = WS; G.vis = new Uint8Array(WS * WS); G.dg = null;
    } else {
      const D = G.pyr.get(d.inDg);
      need(D, 'inDg pyramid'); need(isNum(d.ow.x) && isNum(d.ow.y), 'ow position');
      const f = D.floors[D.i];
      need(f, 'current floor');
      P.ow = { x: d.ow.x, y: d.ow.y, mons: d.ow.mons, items: owItems, npcs: d.ow.npcs, seen: owSeen };
      G.dg = D;
      G.mons = f.mons; G.items = f.items; G.npcs = []; G.seen = f.seen; G.seenW = f.s; G.vis = new Uint8Array(f.seen.length);
    }
    G.auto = null; G.sel = null;

    world.initWorld();
    if (!G.dg && world.blocks(P.x, P.y)) {          // v0.2 saves: a new dungeon site may now stand where the hero was
      for (let r = 1, done = false; r <= 12 && !done; r++) for (let dy = -r; dy <= r && !done; dy++) for (let dx = -r; dx <= r && !done; dx++)
        if (Math.max(Math.abs(dx), Math.abs(dy)) === r && world.free(P.x + dx, P.y + dy) && !world.isDeep(P.x + dx, P.y + dy)) { P.x += dx; P.y += dy; done = true; }
    }
    world.calcVis();
    G.zone = world.zoneAt(P.x, P.y).id;
    sinceTurns = 0; lastAt = Date.now();
    emit('loaded', {});
  }
}

function unpackPyr(pd) {
  need(pd && typeof pd.k === 'string' && isNum(pd.n) && isNum(pd.d) && isArr(pd.floors), 'pyramid');
  const D = { k: pd.k, n: pd.n, d: pd.d, i: pd.i | 0, floors: [],
    type: typeof pd.type === 'string' ? pd.type : 'pyramid', b: isNum(pd.b) ? pd.b : 4, dir: pd.dir === -1 ? -1 : 1,
    tw: pd.tw && typeof pd.tw === 'object' ? pd.tw : {} };
  if (pd.cl) D.cl = 1;
  for (let i = 0; i < pd.floors.length; i++) {
    const f = pd.floors[i];
    if (!f) { D.floors.push(undefined); continue; }
    need(isNum(f.s) && f.s > 0 && isArr(f.down) && isArr(f.up) && isArr(f.mons), 'floor');
    const seen = unrleBits(f.seen, f.s * f.s);
    need(seen.length === f.s * f.s, 'floor seen size');
    let map;
    if (isArr(f.pal)) {                               // v0.3 palette-packed map
      need(isArr(f.map) && f.map.length === f.s, 'floor rows');
      map = f.map.map(r => {
        need(typeof r === 'string' && r.length === f.s, 'floor row width');
        const out = new Array(f.s);
        for (let x = 0; x < f.s; x++) { const k = f.pal[r.charCodeAt(x) - 48]; out[x] = typeof k === 'string' ? k : 'void'; }
        return out;
      });
    } else map = unpackMap(f.map, f.s);
    const fl = { s: f.s, map, down: f.down, up: f.up, mons: f.mons, items: pairsToMap(f.items), seen };
    if (f.looted) fl.looted = 1;
    if (f.keyed) fl.keyed = 1;
    if (isNum(f.cap)) fl.cap = f.cap;
    if (f.sw) fl.sw = 1;
    D.floors.push(fl);
  }
  return D;

}

export function hasSave() { try { return !!localStorage.getItem(SAVE_KEY); } catch (e) { return false; } }

/** Delete the save (death is permanent; also used by "Give up" in the menu). */
export function wipeSave() { try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ } }
