// game/formers.js — MULTIPLAYER: Formers, and how crowded the planet is allowed to get.
//
// A hero whose player stays gone (5 minutes collapsed, or everyone left the room) gets back up as a FORMER: a hostile
// exact copy (their max HP, their weapon, their look) carrying everything they owned, which spills out when it dies.
// A Former hunts the nearest living hero, anywhere on the planet, until a newer hero arrives (a fresh join or a
// respawn); then it hunts the newest. Far away or on another floor it travels unseen, and its target is warned as it
// closes in. Formers live in the ordinary monster lists (so they save, sync and fight like monsters), but they are
// skipped by the normal monster phase, never forgotten for being far away, and never multiplied.
//
// Spawn scaling: spawnCount(n) multiplies ordinary spawns by 1x (1 hero) .. 3x (8 heroes); crowded() refuses a spawn
// that would fill more than half the walkable tiles of the area (32x32 outdoors, the room-sized window in dungeons).
import { G, say } from '../core/state.js';
import { WK } from '../core/util.js';
import { mkMon, monAct, AI_RANGE } from './monsters.js';
import { gearItem, potionItem, goldItem } from './loot.js';
import { living, withPlayer, layerOf, seatOf } from './players.js';
import { free, isDeep } from '../world/world.js';

// ---- spawn scaling --------------------------------------------------------------------------------------------------
/** 1 + 2(n-1)/7 for n living heroes: 1x alone, 3x at eight. */
export function spawnMult() {
  const n = Math.max(1, Math.min(8, living().length));
  return 1 + 2 * (n - 1) / 7;
}
/** Scale an ordinary spawn count, rounding the fraction up or down at random. */
export function spawnCount(n) {
  const v = n * spawnMult(), w = Math.floor(v);
  return w + (Math.random() < v - w ? 1 : 0);
}
/** True if one more monster near (x,y) would fill more than half of the walkable tiles within r. */
export function crowded(x, y, mons, walkable, r) {
  let w = 0, c = 0;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (walkable(x + dx, y + dy)) w++;
  for (const m of mons) if (!m.former && Math.abs(m.x - x) <= r && Math.abs(m.y - y) <= r) c++;
  return c + 1 > w * .5;
}

// ---- dread ----------------------------------------------------------------------------------------------------------
const DREAD = {
  far: ['You feel your skin crawl.', 'The hairs on your neck file a formal complaint.',
    'Somewhere far away, something that knows your name stops walking and turns around.',
    'You get the feeling you left the stove on. You have never owned a stove.'],
  mid: ['An old friend is approaching.', 'Footsteps behind you match your own rhythm exactly.',
    'You smell campfire smoke. You know whose campfire.', 'Your shadow flinches before you do.'],
  near: ['Someone is calling your name...', 'A familiar voice laughs, close now.',
    'It knows your face. It wore one like it.', 'Something is wearing your old boots, and it is nearly here.'],
};
const pickOf = a => a[Math.floor(Math.random() * a.length)];
const warn = (P, msg) => withPlayer(P, () => say(msg, 'bad'));

// ---- making and breaking --------------------------------------------------------------------------------------------
/** Turn hero P into a Former on P's own tile and layer. The caller removes the hero afterwards.
 *  wait: ticks it stands there getting its bearings before the hunt starts (a head start for whoever is nearby). */
export function makeFormer(P, wait = 20) {
  const name = (P.seat && P.seat.name) || 'Someone';
  return withPlayer(P, () => {
    const m = mkMon(P.x, P.y, 0, 0);
    const w = P.wep || {};
    Object.assign(m, {
      former: name, name: `${name}'s Former Self`, ai: 'chase', awake: true, seen: false, col: '#ff5a5a',
      lvl: P.lvl || 1, hp: P.max, max: P.max,
      atk: Math.max(1, Math.round(((w.min || 1) + (w.max || 3)) / 2 + (P.lvl || 1))),
      xp: 10 + (P.lvl || 1) * 10,
      look: { arm: P.arm, wep: P.wep },
      loot: { inv: P.inv || [], arm: P.arm || {}, wep: P.wep, pots: P.pots || {}, gold: P.gold || 0 },
      born: G.turn, eta: null, tid: null, stage: 0, wait,
    });
    delete m.boss; delete m.rare;
    G.mons.push(m);
    say(`${name} gets back up. It is not ${name} any more.`, 'bad');
    return m;
  });
}

/** Spill a dead Former's belongings around where it fell (combat.kill calls this, in the killer's context). */
export function dropFormerLoot(m) {
  const L = m.loot; if (!L) return;
  const things = [];
  for (const g of L.inv || []) if (g) things.push(gearItem(g));
  for (const s of Object.keys(L.arm || {})) if (L.arm[s]) things.push(gearItem(L.arm[s]));
  if (L.wep && !L.wep.fists) things.push(gearItem(L.wep));
  for (const [k, n] of Object.entries(L.pots || {})) for (let i = 0; i < (n | 0); i++) things.push(potionItem(k));
  if (L.gold > 0) things.push({ ...goldItem(), amt: L.gold, name: `${L.gold} gold` });
  let r = 0, placed = 0;
  while (things.length && r < 8) {
    for (let dy = -r; dy <= r && things.length; dy++) for (let dx = -r; dx <= r && things.length; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const x = m.x + dx, y = m.y + dy, k = WK(x, y);
      if (G.items.has(k) || isDeep(x, y) || !(free(x, y) || (dx === 0 && dy === 0))) continue;
      G.items.set(k, things.shift()); placed++;
    }
    r++;
  }
  if (placed) say(`Everything ${m.former} ever carried spills across the ground. Finders keepers, legally.`, 'loot');
  m.loot = null;
}

// ---- the hunt -------------------------------------------------------------------------------------------------------
/** Every monster list in the world: [array, layer key]. */
function layers() {
  const out = [];
  if (G.world) out.push([G.world.mons, 'ow']);
  for (const D of (G.pyr ? G.pyr.values() : [])) (D.floors || []).forEach((f, i) => { if (f && f.mons) out.push([f.mons, D.k + '#' + i]); });
  return out;
}

const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/** Newest hero who arrived after this Former got up; otherwise the nearest (same layer first). */
function pickTarget(m, key, heroes) {
  let newest = null;
  for (const h of heroes) if (seatOf(h).joined > m.born && (!newest || seatOf(h).joined > seatOf(newest).joined)) newest = h;
  if (newest) return newest;
  let best = null, bd = Infinity;
  for (const h of heroes) { const d = (layerOf(h) === key ? 0 : 100000) + cheb(m, h); if (d < bd) { bd = d; best = h; } }
  return best;
}

/** Once per world tick (game/turn.js), after the ordinary monsters. */
export function formersPhase() {
  const heroes = living();
  if (!heroes.length) return;
  for (const [arr, key] of layers()) {
    for (const m of arr.filter(x => x.former && x.hp > 0)) {
      const T = pickTarget(m, key, heroes);
      if (!T) continue;
      const tid = seatOf(T).id;
      if (m.tid !== tid) { m.tid = tid; m.eta = null; m.stage = 0; }
      if (m.wait > 0) {                                              // still getting up: only the dread arrives
        m.wait--;
        if (m.stage < 1) { m.stage = 1; warn(T, pickOf(DREAD.far)); }
        continue;
      }
      if (layerOf(T) === key && cheb(m, T) <= AI_RANGE) {
        if (m.stage < 3) { m.stage = 3; warn(T, pickOf(DREAD.near)); }
        m.eta = null;
        withPlayer(T, () => monAct(m));
        continue;
      }
      // travelling unseen: arrives within about a minute, wherever the target is
      if (m.eta == null) { m.eta = Math.min(240, 60 + Math.floor((layerOf(T) === key ? cheb(m, T) : 200) / 2)); m.total = m.eta; m.stage = 0; }
      m.eta--;
      if (m.stage < 1) { m.stage = 1; warn(T, pickOf(DREAD.far)); }
      else if (m.stage < 2 && m.eta <= m.total / 2) { m.stage = 2; warn(T, pickOf(DREAD.mid)); }
      if (m.eta > 0) continue;
      // arrive: step out of nowhere a few tiles from the target, on the target's layer
      withPlayer(T, () => {
        for (let r = 6; r <= 12; r++) for (let i = 0; i < 24; i++) {
          const a = Math.random() * Math.PI * 2, x = T.x + Math.round(Math.cos(a) * r), y = T.y + Math.round(Math.sin(a) * r);
          if (!free(x, y) || isDeep(x, y)) continue;
          const at = arr.indexOf(m); if (at >= 0) arr.splice(at, 1);
          m.x = x; m.y = y; m.eta = null; m.stage = 3;
          G.mons.push(m);
          say(pickOf(DREAD.near), 'bad');
          return;
        }
      });
    }
  }
}
