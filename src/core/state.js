// core/state.js — ARCHITECT-OWNED. The one mutable game-state singleton, G.
// Mirrors the classic prototype's globals (P, mons, items, seen, mods, DG, PYR, dex, log, turn, over, auto, sel)
// so porting classic code is mechanical:  P -> G.P, mons -> G.mons, DG -> G.dg, PYR -> G.pyr, SEED -> G.seed ...
// Shapes are documented in docs/ARCHITECTURE.md §5. Add fields there before you add them here.
import { WS, OPTS_KEY } from './config.js';
import { R } from './util.js';
import { emit } from './bus.js';

/** @type {any} The singleton. Import { G } and read/mutate fields; never reassign G itself. */
export const G = {};

/** Bare hands. P.wep is never null; `fists:1` marks "no weapon" (it is not put in the bag when swapped out). */
export const FISTS = () => ({ kind: 'wep', fists: 1, type: 'Fists', name: 'Bare Hands', q: 'Plain', min: 1, max: 3, tags: [], chop: 0, mine: 0, col: '#caa' });

export function newPlayer() {
  return {
    x: 0, y: 0,                      // UNWRAPPED integer tile coords (see ARCHITECTURE §4.1)
    hp: 25, max: 25,                 // classic
    mp: 0, mpMax: 0,                 // Motivation Points; 0 until the first scroll is read
    lvl: 1, xp: 0, next: 10, gold: 0,
    poison: 0, slowed: 0, far: 0,    // classic status fields
    inv: [],                         // gear objects, max BAG
    arm: { head: null, body: null, arms: null, legs: null },
    wep: FISTS(),
    work: new Map(),                 // WK -> turns of chopping/mining progress
    ow: null,                        // while inside a pyramid: the stashed overworld {x,y,mons,items,npcs,seen}
    spells: [],                      // learned spell ids, max 4 (the "spell gems")
    buffs: { haste: 0, feign: 0 },   // remaining turns
    camp: null,                      // {x,y} of the current campfire (overworld only)
    insured: 0,                      // 1 if a policy is in force (see game/quests.js: Phil)
    kills: 0, steps: 0,
  };
}

/** Wipe G in place and install a fresh run. Does NOT generate anything — game/turn.js newGame() does that. */
export function resetState(seed = R(1e9)) {
  const opts = G.opts || loadOpts();
  for (const k of Object.keys(G)) delete G[k];
  Object.assign(G, {
    seed, turn: 0, over: false,
    home: { x: 0, y: 0 },            // where this life began (Gate destination, quest anchor); set by newGame
    P: newPlayer(),
    mons: [],                        // live monsters near the player (current map)
    npcs: [],                        // live friendly NPCs near the player (overworld only)
    items: new Map(),                // WK -> ground item (current map)
    seen: new Uint8Array(WS * WS),   // current map's explored flags; index = y * G.seenW + x (wrapped on overworld)
    seenW: WS,
    vis: new Uint8Array(WS * WS),    // current map's visible-now flags, same indexing; owned by world.calcVis()
    spawned: new Set(),              // spawn-chunk keys already populated
    mods: new Map(),                 // WK -> terrain key (chopped trees, broken walls)
    dex: new Set(),                  // bestiary: enemy names met
    log: [],                         // newest first: {turn, msg, cls}
    dg: null,                        // current pyramid (Dungeon) or null
    pyr: new Map(),                  // WK of the entrance -> Dungeon
    auto: null,                      // running auto-action or null
    sel: null,                       // {x,y} highlighted tile or null
    zone: null,                      // current zone id (string) — set by game/turn.js via world.zoneAt
    quests: { active: [], done: [], npcs: {} },
    run: {},                         // v0.3 per-run randomized state; JSON-safe plain data only (saved wholesale). Keys: see docs/ARCHITECTURE-v0.3.md
    opts,
  });
  return G;
}

/** Add a line to the message log (newest first) and notify the HUD. cls: '' | 'good' | 'bad' | 'loot' | 'sys' | 'zone'. */
export function say(msg, cls = '') {
  if (!G.log) return;
  const e = { turn: G.turn, msg, cls };
  G.log.unshift(e);
  if (G.log.length > 80) G.log.length = 80;
  emit('log', e);
}

// ---- options (persist across lives) -------------------------------------------------
export function loadOpts() {
  const d = { muted: false, zoom: 0, dbl: 'danger' };   // dbl: double-tap a card's main action: 'danger' = risky ones still ask, 'all' = confirm everything
  try { Object.assign(d, JSON.parse(localStorage.getItem(OPTS_KEY) || '{}')); } catch (e) { /* private mode etc. */ }
  return d;
}
export function saveOpts() {
  try { localStorage.setItem(OPTS_KEY, JSON.stringify(G.opts)); } catch (e) { /* ignore */ }
}
