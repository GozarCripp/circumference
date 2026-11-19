// game/monsters.js — monster creation, spawning, visibility and the monster phase. Named rares, the root / mez /
// stun counters, bleed + burn ticks, feign death and per-chunk scroll and NPC spawns all live here.
//
// Monster: { id, b, t, ch, name, ai, lvl, x, y, hp, max, atk, xp, col, awake, seen,
//            bleed?, burn?, stun?, root?, mez?, rare?: 'rare-…', boss?: true }
//   id = bestiary id ('jungle-07', 'shark-2', 'rare-swamp-1'); sprite id = 'enemy/' + (rare || id).
//   x,y are UNWRAPPED like the hero's; G.items / G.spawned use wrapped keys.
//
// No top-level side effects: nothing here touches the DOM or reads G at import time.
import { G, say } from '../core/state.js';
import { emit } from '../core/bus.js';
import { spawnCount, crowded } from './formers.js';
import { WS } from '../core/config.js';
import { R, pick, mod, WK } from '../core/util.js';
import { BEAST, SHARKS, RARES, enemyById } from '../data/bestiary.js';
import { biome, tdist, dist0, free, mfree, isVis, isDeep, los, blocks } from '../world/world.js';
import { hurt, damageMon, theName } from './combat.js';
import { gearItem, genGear, potionItem, goldItem, scrollItem } from './loot.js';
import { spawnNPCs } from './quests.js';
import { randomSpell } from './spells.js';
import { tierShift, bossAllowed } from './director.js';

const CHUNK = 16;
const AI_RANGE = 24;        // monsters farther than this (Chebyshev) do nothing this turn
const KEEP_RANGE = 80;      // monsters farther than this are forgotten by spawnAround
const RARE_ODDS = 12;       // 1-in-12 when the rare's base tier is rolled
const RARE_HP = 1.8, RARE_ATK = 1.3, RARE_XP = 3;

// ---- named rare bookkeeping -------------------------------------------------------------------------------
/** rare id -> the live Monster object. Cleared by resetRares(); self-heals by scanning G.mons. */
const rareLive = new Map();
const warned = new Set();   // AI errors are logged once per message

/** Forget which named rares are alive (turn.newGame may call this; it also self-heals without it). */
export function resetRares() { rareLive.clear(); warned.clear(); }

function inPlay(m) {
  if (!m || !(m.hp > 0)) return false;
  if (G.mons && G.mons.includes(m)) return true;
  const ow = G.world || (G.P && G.P.ow);         // the shared overworld (stashed while this hero is in a pyramid)
  return !!(ow && ow.mons && ow.mons.includes(m));
}
function rareAlive(id) {
  const m = rareLive.get(id);
  if (m && inPlay(m)) return true;
  if (m) rareLive.delete(id);
  if (G.mons && G.mons.some(x => x.rare === id && x.hp > 0)) return true;      // e.g. restored from a save
  const ow = G.world || (G.P && G.P.ow);
  return !!(ow && ow.mons && ow.mons.some(x => x.rare === id && x.hp > 0));
}

// ---- creation -----------------------------------------------------------------------------------------------
/** Create a monster for position (x,y) at distance d from home; ft forces the tier (24 = boss). Classic formulas. */
export function mkMon(x, y, d, ft) {
  d = Number.isFinite(d) ? d : 0;
  let b = biome(x, y);
  if (!(b >= 0 && b < BEAST.length)) b = 0;
  let t = R(Math.min(23, 2 + Math.floor(d / 12)) + 1);
  t = Math.max(0, Math.min(23, t + tierShift()));   // soft adaptive difficulty (game/director.js)
  if (d > 150 && R(30) === 0 && bossAllowed()) t = 24;
  const forced = ft != null;
  if (forced) t = ft;
  t = Math.max(0, Math.min(24, t | 0));
  let rec = BEAST[b][t];
  let rare = null;
  if (!forced) {
    const cand = RARES.find(r => r.b === b && r.base === t);
    if (cand && R(RARE_ODDS) === 0 && !rareAlive(cand.id)) { rare = cand; rec = enemyById(cand.id) || rec; }
  }
  const boss = rec.ai === 'boss';
  const lvl = t * .5 + b * 1.2 + d / 35;
  let hp = Math.round((5 + lvl * 2.5) * (boss ? 4 : 1));
  let atk = Math.round((1 + lvl * .6) * (boss ? 1.5 : 1));
  let xp = Math.round((2 + lvl * 2) * (boss ? 5 : 1));
  if (rare) { hp = Math.round(hp * RARE_HP); atk = Math.round(atk * RARE_ATK); xp = Math.round(xp * RARE_XP); }
  const m = {
    id: rec.id, b, t, ch: rec.ch, name: rec.name, ai: rec.ai, lvl, x, y, hp, max: hp, atk, xp,
    col: boss ? '#ff4' : `hsl(${(t * 47 + b * 90) % 360},95%,74%)`, awake: false, seen: false,
  };
  if (boss) m.boss = true;
  if (rare) { m.rare = rare.id; rareLive.set(rare.id, m); }
  return m;
}

// ---- spawning -------------------------------------------------------------------------------------------------
/** Populate the 5x5 block of 16-tile spawn chunks around the hero (monsters, potions, gold, gear, scrolls, NPCs)
 *  and forget monsters more than 80 tiles away. Overworld only. */
export function spawnAround() {
  if (G.dg) return;
  const P = G.P, pcx = Math.floor(P.x / CHUNK), pcy = Math.floor(P.y / CHUNK), cw = WS / CHUNK;
  for (let cy = pcy - 2; cy <= pcy + 2; cy++) for (let cx = pcx - 2; cx <= pcx + 2; cx++) {
    const k = mod(cx, cw) + ',' + mod(cy, cw);
    if (G.spawned.has(k)) continue;
    G.spawned.add(k);
    const d = tdist(cx * CHUNK + 8, cy * CHUNK + 8);
    const spot = () => {
      for (let i = 0; i < 12; i++) {
        const x = cx * CHUNK + R(CHUNK), y = cy * CHUNK + R(CHUNK);
        if (free(x, y) && !isDeep(x, y) && !G.items.has(WK(x, y))) return { x, y };
      }
      return null;
    };
    try {
      if (cx || cy) {
        const n = spawnCount((R(3) === 0 ? 1 : 0) + (d > 60 && R(2) === 0 ? 1 : 0) + (d > 200 ? 1 : 0));   // MULTIPLAYER: 1x..3x
        for (let i = 0; i < n; i++) {
          const s = spot();
          if (s && !crowded(s.x, s.y, G.mons, (x, y) => !blocks(x, y) && !isDeep(x, y), 16)) G.mons.push(mkMon(s.x, s.y, d));
        }
      }
      const put = (item) => { const s = spot(); if (s) G.items.set(WK(s.x, s.y), item); };
      if (R(3) === 0) put(potionItem());
      if (R(2) === 0) put(goldItem());
      if (R(8) === 0) { const g = genGear(Math.floor(d / 30), 0); if (g) put(gearItem(g)); }
      if (R(14) === 0) put(scrollItem(randomSpell()));
    } catch (e) { warnOnce('spawn', e); }
    try { spawnNPCs(cx, cy); } catch (e) { warnOnce('npcs', e); }
    emit('chunk', { cx, cy });                         // v0.3: world-life and other spawners hook here (bus catches listener errors)
  }
  // forget the far-away (in place, other modules may hold the array). MULTIPLAYER: far from EVERY hero outside.
  const outside = G.players ? [...G.players.values()].filter(h => h.seat && !h.seat.dg && !h.seat.over && h !== P) : [];
  outside.push(P);
  const near = m => m.former || outside.some(h => Math.abs(m.x - h.x) < KEEP_RANGE && Math.abs(m.y - h.y) < KEEP_RANGE);
  for (let i = G.mons.length - 1; i >= 0; i--) if (!near(G.mons[i])) G.mons.splice(i, 1);
}

/** Deep-water check from endTurn: 1-in-10 chance per turn to surface a shark 4+ tiles away (classic). */
export function maybeSpawnShark() {
  const P = G.P;
  if (G.dg || !isDeep(P.x, P.y)) return false;
  if (R(10) !== 0) return false;
  if (G.mons.some(m => m.ai === 'swim' && Math.abs(m.x - P.x) < 14 && Math.abs(m.y - P.y) < 14)) return false;
  for (let i = 0; i < 25; i++) {
    const x = P.x + R(15) - 7, y = P.y + R(15) - 7;
    if (Math.hypot(x - P.x, y - P.y) >= 4 && isDeep(x, y) && free(x, y)) {
      const rec = pick(SHARKS), d = dist0(), lvl = 2 + d / 30, hp = Math.round(8 + lvl * 3);
      G.mons.push({
        id: rec.id, lvl, x, y, b: -1, t: rec.t, ch: 'Λ', name: rec.name, ai: 'swim', hp, max: hp,
        atk: Math.round(2 + lvl * .7), xp: Math.round(4 + lvl * 2), col: '#9bd', awake: true, seen: true,
      });
      say('A fin breaks the surface nearby. Of course it does.');
      return true;
    }
  }
  return false;
}

// ---- visibility ---------------------------------------------------------------------------------------------------
/** Is m currently drawn / targetable? (visible tile, and unrevealed 'sneak' monsters only within 2 tiles) */
export function shown(m) {
  return isVis(m.x, m.y) && !(m.ai === 'sneak' && !m.seen && Math.hypot(m.x - G.P.x, m.y - G.P.y) > 2);
}
/** Is m adjacent to the hero (8-way)? */
export const adj = m => Math.abs(m.x - G.P.x) <= 1 && Math.abs(m.y - G.P.y) <= 1;

// ---- the monster phase ----------------------------------------------------------------------------------------------
function warnOnce(tag, e) {
  const key = tag + ':' + (e && e.message);
  if (warned.has(key)) return;
  warned.add(key);
  console.error('[monsters]', tag, e);
}

function register(m) {
  if (m.dboss || m.former || G.dex.has(m.name)) return;            // v0.3: named dungeon bosses are not bestiary species
  G.dex.add(m.name);
  say(`New bestiary entry: ${m.name}.`);
  emit('dex', { name: m.name, count: G.dex.size });
}

export { AI_RANGE };

/** MULTIPLAYER: one monster takes its turn against the hero currently in context (game/turn.js picks the nearest). */
export function monAct(m) {
  if (G.over || !G.mons.includes(m)) return;
  try { think(m); } catch (e) { warnOnce('ai', e); }
}

/** Every awake monster within 24 tiles takes its turn (statuses, ranged, melee, movement by behaviour). */
export function monPhase() {
  for (const m of [...G.mons]) {
    if (G.over) break;
    if (!G.mons.includes(m) || Math.abs(m.x - G.P.x) > AI_RANGE || Math.abs(m.y - G.P.y) > AI_RANGE) continue;
    try { think(m); } catch (e) { warnOnce('ai', e); }
  }
}

function think(m) {
  const P = G.P, see = isVis(m.x, m.y);
  // damage over time (classic numbers); combat.damageMon logs nothing when silent, so say the line here
  if (m.bleed > 0) {
    m.bleed--;
    const d = 1 + R(2) + Math.floor(m.max * .05);
    if (see) say(`${theName(m,1)} bleeds. -${d}`);
    if (damageMon(m, d, { kind: 'bleed', silent: true }) || !G.mons.includes(m)) return;
  }
  if (m.burn > 0) {
    m.burn--;
    const d = 2 + R(3);
    if (see) say(`${theName(m,1)} burns. -${d}`);
    if (damageMon(m, d, { kind: 'burn', silent: true }) || !G.mons.includes(m)) return;
  }
  // timed statuses count down even while the monster is otherwise idle
  const rooted = m.root > 0;
  if (m.root > 0) m.root--;
  const mezzed = m.mez === true || m.mez > 0;
  if (typeof m.mez === 'number' && m.mez > 0) m.mez--;

  // feign death: awake monsters fall asleep and stay asleep (bosses shrug it off half the time)
  if (P.buffs && P.buffs.feign > 0 && !(m.boss && Math.random() < .5)) { m.awake = false; return; }

  if (see) m.awake = true;
  if (!m.awake || (m.ai === 'slow' && G.turn % 2)) return;
  if (mezzed) return;
  if (m.stun > 0) { m.stun--; return; }
  if (see && shown(m)) register(m);

  const dist = Math.hypot(m.x - P.x, m.y - P.y);
  if (m.ai === 'zap' && see && !adj(m) && dist <= 6 && R(3) === 0 && los(m.x, m.y, P.x, P.y)) {
    hurt(m, 1 + R(m.atk), `${theName(m,1)} attacks from afar.`, 'range');
    return;
  }
  if (adj(m)) {
    if (m.ai === 'flit' && R(2)) { emit('miss', { x: P.x, y: P.y, why: 'flit' }); return; }
    if (m.ai === 'swim' && !isDeep(P.x, P.y)) return;
    let d = 1 + R(m.atk);
    if (m.ai === 'sneak' && !m.seen) {
      d *= 2; m.seen = true;
      hurt(m, d, `${theName(m,1)} strikes from the shadows.`, 'melee');
    } else hurt(m, d, `${theName(m,1)} hits you.`, 'melee');
    if (G.over || !G.mons.includes(m)) return;
    if (m.ai === 'poison' && R(2) === 0) {
      P.poison = 3;
      say('You have been poisoned. Your body files a formal complaint.');
      emit('status', { mon: null, kind: 'poison' });
    }
    if (m.ai === 'burn' && R(3) === 0) hurt(m, 1 + R(2), 'You are on fire, briefly and personally.', 'burn');
    return;
  }
  if (m.ai === 'root' || rooted) return;
  let dx = Math.sign(P.x - m.x), dy = Math.sign(P.y - m.y);
  if (m.ai === 'flit' && R(2)) { dx = R(3) - 1; dy = R(3) - 1; }
  for (const [a, b] of [[dx, dy], [dx, 0], [0, dy]]) {
    if ((a || b) && mfree(m, m.x + a, m.y + b)) { m.x += a; m.y += b; break; }
  }
}
