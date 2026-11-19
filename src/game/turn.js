// game/turn.js — the player's verbs and the live turn pipeline: newGame, step, act, endTurn, worldTick, auto-actions
// (go / charge / work / rest / walk-to-NPC, one step per tick), terrain work, canAutoWalk and the camp.
// LIVE: the world no longer waits for the player. core/clock.js calls worldTick() every TIMING.tick ms; that runs the
// classic turn pipeline (monsters, poison, regen, buffs, day phase, emit('turn')). The player may act once per tick:
// endTurn() now only marks "acted this tick"; an input that arrives after acting is queued for the next tick.
// Never imports render/, ui/ or audio/; anything visible goes out on the bus.
import { G, resetState, say } from '../core/state.js';
import { emit } from '../core/bus.js';
import { WS, dayInfo } from '../core/config.js';
import { R, WK } from '../core/util.js';
import { INTRO, DAY_LINES, CAMP, ZONE_ENTER, FAR_LINE } from '../data/flavor.js';
import { SPECIAL_STEP } from '../data/terrain.js';
import {
  initWorld, blocks, isDeep, terr, calcVis, isSeen, isVis, monAt, npcAt, campAt, free, findPath,
  zoneAt, setTerrain, dist0,
} from '../world/world.js';
import { enterPyr, dungeonStep } from '../world/dungeon.js';
import { spawnAround, maybeSpawnShark, monAct, AI_RANGE, shown, resetRares } from './monsters.js';
import { attack, inRange, hurt, die, theName } from './combat.js';
import { pickup, pieces } from './loot.js';
import { tickSpells } from './spells.js';
import { mpOf, adopt, players, living, withPlayer, layerOf, heroesOn, local } from './players.js';

// ---- module state (only ever touched from functions, never at import time) --------------------------------------
// Per-hero tick state lives on P.mp (game/players.js): acted / rested this tick, queued step, held direction,
// monsters already known when an auto-action began, zone announcement memory, twice (slowed: monsters act twice).
const T = () => mpOf(G.P);
let inTurn = false;       // re-entrancy guard for the pipeline
let lastPhase = null;     // last day phase announced
const ZONE_QUIET = 40;     // turns before re-entering a zone is news again
const warned = new Set(); // one console line per distinct pipeline failure

const POISON_BY = { name: 'a long weekend of poison', col: '#9f5' };
const SEA_BY = { name: 'the sea, and your own choices', col: '#48f' };

/** Run one pipeline stage; a throw is logged once and never escapes into the caller or an auto timer. */
function safe(label, fn) {
  try { return fn(); } catch (e) {
    const key = label + ':' + (e && e.message);
    if (!warned.has(key)) { warned.add(key); console.error('[turn.' + label + ']', e); }
    return undefined;
  }
}

const cheb = (x, y) => Math.max(Math.abs(x - G.P.x), Math.abs(y - G.P.y));
const campNear = r => { const c = G.P.camp; return !!c && !G.dg && Math.abs(c.x - G.P.x) <= r && Math.abs(c.y - G.P.y) <= r; };

// =====================================================================================================================
// New life
// =====================================================================================================================

/** Start a fresh life: resetState(), initWorld(), place the hero on dry walkable ground near (0,0) (classic spiral),
 *  spawnAround(), calcVis(), say(INTRO), set G.zone, emit('newgame'). */
export function newGame() {
  inTurn = false;
  resetState();
  G.auto = null;
  safe('resetRares', resetRares);
  initWorld();
  const P = G.P;
  for (let r = 0; (blocks(P.x, P.y) || isDeep(P.x, P.y)) && r < 400; r++) { P.x = R(2 * r + 1) - r; P.y = R(2 * r + 1) - r; }
  G.home = { x: P.x, y: P.y };
  lastPhase = dayInfo(0).phase;
  safe('spawnAround', spawnAround);
  calcVis();
  G.zone = zoneAt(P.x, P.y).id;
  say(INTRO);
  adopt();
  emit('newgame', {});
}

// =====================================================================================================================
// Verbs
// =====================================================================================================================

/** One step / bump in direction (dx,dy). Attacks a monster there, hails an NPC there (emit 'hail', no turn spent),
 *  otherwise moves if not blocked, then pickup(), then pyramid door / stairs / chest triggers.
 *  Returns true if a turn was spent (the caller then calls endTurn()). Does NOT call endTurn itself. */
export function step(dx, dy) {
  if (G.over) return false;
  const P = G.P, nx = P.x + dx, ny = P.y + dy;
  const m = monAt(nx, ny);
  if (m) { attack(m); return true; }
  const npc = npcAt(nx, ny);
  if (npc) { emit('hail', { npc }); return false; }
  if (campAt(nx, ny) || blocks(nx, ny)) return false;

  const from = { x: P.x, y: P.y }, wasDeep = isDeep(P.x, P.y);
  P.x = nx; P.y = ny; P.steps++;
  if (P.buffs && P.buffs.feign) P.buffs.feign = 0;                 // moving ends feign death
  if (!wasDeep && isDeep(nx, ny)) say('You swim. Badly, but you swim. Something below takes an interest.');
  emit('moved', { from, to: { x: nx, y: ny } });
  safe('pickup', pickup);

  // special tiles: dungeon entrances outside; ice, traps, keys, stairs and the chest inside (world/dungeon.js)
  const td = terr(P.x, P.y);
  if (!G.dg && (td.key === 'pdoor' || td.dd)) safe('enterPyr', enterPyr);
  else if (G.dg) safe('dungeonStep', () => dungeonStep(dx, dy));
  return true;
}

/** Keyboard / button verb: cancel any auto-action, then step (or wait when dx = dy = 0) and end the turn.
 *  Already acted this tick: the step is queued for the next one (latest press wins). Returns true if a turn was spent. */
export function act(dx, dy) {
  if (G.over) return false;
  stopAuto();
  const t = T();
  if (t.acted) { t.queued = { dx, dy }; return false; }
  t.queued = null;
  if (!dx && !dy) { endTurn(true); return true; }
  const spent = step(dx, dy);
  if (spent) endTurn();
  return spent;
}

// =====================================================================================================================
// The turn pipeline
// =====================================================================================================================

/** True while the player may still act this tick. */
export const canAct = () => !T().acted && !G.over;

/** Drop a queued step (input.js calls this on key release so a held key does not overshoot). */
export function clearQueue() { T().queued = null; }

/** Direction key held down (input.js): repeat that step every tick until setHeld(null). */
export function setHeld(dir) { const t = T(); t.held = dir ? [dir[0], dir[1]] : null; if (!dir) t.queued = null; }

/** The player's action is done for this tick. LIVE: the world does not advance here; worldTick() does. */
export function endTurn(resting = false) {
  if (G.over) return;
  const t = T();
  t.acted = true;
  if (resting) t.rested = true;
}

/** One live world turn, called by core/clock.js, for every living hero in the room:
 *  1. each hero who has not acted yet runs their queued step, held direction or auto-action;
 *  2. each hero's upkeep (poison, regen, drowning, spawns, spells, camp, zone) — heroPhase;
 *  3. monsters, layer by layer: each awake monster acts once against the nearest living hero on its layer
 *     (twice if that hero is slowed, every other tick if hasted — the classic rules);
 *  4. world-wide news (day phase), fresh sight for everyone, emit('turn') in the local hero's context. */
export function worldTick() {
  if (inTurn) return;
  const heroes = living();
  if (!heroes.length) return;
  inTurn = true;
  try {
    G.turn++;
    for (const h of heroes) withPlayer(h, () => {
      const t = T();
      if (G.over || t.acted) return;
      if (t.queued) { const q = t.queued; t.queued = null; act(q.dx, q.dy); }
      else if (t.held) act(t.held[0], t.held[1]);
      else if (G.auto) runAuto();
      else retaliate(t);
    });
    for (const h of heroes) withPlayer(h, () => {
      const t = T(), r = t.rested;
      t.acted = false; t.rested = false;
      if (!G.over) heroPhase(r);
    });
    monstersPhase(heroes);
    worldNews();
    for (const h of heroes) withPlayer(h, () => { if (!G.over) safe('calcVis', calcVis); });
  } finally { inTurn = false; }
  emit('turn', { turn: G.turn, resting: false });
}

/** Idle and just hit: swing back at whoever did it, if they are still in reach (not while feigning death). */
function retaliate(t) {
  const m = t.lastHit;
  t.lastHit = null;
  if (!m || G.over || (G.P.buffs && G.P.buffs.feign > 0) || !G.mons.includes(m) || !(m.hp > 0) || !inRange(m)) return;
  attack(m); endTurn();
}

/** Monsters MOVE every other tick (heroes outpace them) but attack every tick once next to their hero.
 *  Flitting things stay quick. */
const offBeat = m => { m.tk = ((m.tk | 0) + 1) % 2; return m.ai !== 'flit' && m.tk === 1; };
const nextTo = (m, P) => Math.max(Math.abs(m.x - P.x), Math.abs(m.y - P.y)) <= 1;

function monstersPhase(heroes) {
  const layers = new Map();                                     // layer key -> the mons array of that layer
  for (const h of heroes) { const k = layerOf(h); if (!layers.has(k)) layers.set(k, withPlayer(h, () => G.mons)); }
  for (const [key, mons] of layers) {
    for (const m of [...mons]) {
      if (!mons.includes(m)) continue;
      const target = heroesOn(key, m.x, m.y, AI_RANGE)[0];
      if (!target) continue;
      if (offBeat(m) && !nextTo(m, target)) continue;
      withPlayer(target, () => {
        if (G.over) return;
        if (G.P.buffs && G.P.buffs.haste > 0 && G.turn % 2) return;
        monAct(m);
        if (T().twice && !G.over) monAct(m);
      });
    }
  }
}

/** Day-phase lines go to every hero. */
function worldNews() {
  const phase = dayInfo(G.turn).phase;
  if (lastPhase === null) lastPhase = dayInfo(G.turn - 1).phase;
  if (phase === lastPhase) return;
  lastPhase = phase;
  for (const h of living()) withPlayer(h, () => {
    if (DAY_LINES[phase]) say(DAY_LINES[phase]);
    emit('dayphase', { phase });
  });
}

/** Advance the world one turn (classic endTurn): turn++, far-side check, poison, regen (resting heals every turn),
 *  drowning + shark spawns in deep water, death check, spawnAround, calcVis, monPhase (twice if P.slowed; skipped on
 *  alternate turns while P.buffs.haste), buffs/MP tick, camp upkeep, day-phase lines, zone change, calcVis, emit('turn'). */
function heroPhase(resting) {
  const P = G.P;

  // far side of the planet (classic: dist0 > 68% of the world width)
  if (!G.dg && !P.far && dist0() > WS * .68) { P.far = 1; say(FAR_LINE); emit('far', {}); }

  const pc = safe('pieces', pieces) || {};

  // poison
  if (P.poison > 0) {
    if ((pc.space || 0) >= 4) P.poison = 0;
    else { P.poison--; hurt(POISON_BY, 1, 'The poison continues its work.', 'poison'); }
    if (G.over) return;
  }

  // regeneration: resting every turn (double within 2 tiles of the camp), otherwise every 5th turn; space-age faster
  if (P.hp < P.max) {
    if (resting) P.hp = Math.min(P.max, P.hp + (campNear(2) ? 2 : 1));
    else if (G.turn % 5 === 0 || (pc.space && G.turn % (6 - pc.space) === 0)) P.hp++;
  }

  // drowning and sharks
  if (!G.dg && isDeep(P.x, P.y)) {
    if ((pc.heavy || 0) >= 2) { hurt(SEA_BY, 1, 'Your metal armor is a poor flotation device.', 'drown'); if (G.over) return; }
    safe('shark', maybeSpawnShark);
  }

  if (P.hp <= 0 && !G.over) die(SEA_BY);
  if (G.over) return;

  safe('spawnAround', spawnAround);
  calcVis();

  T().twice = P.slowed > 0;                                     // monsters act twice against a slowed hero
  if (T().twice) P.slowed--;

  safe('tickSpells', () => tickSpells(resting));

  // camp upkeep: wandering 30+ tiles away abandons the fire
  if (P.camp && !G.dg && Math.hypot(P.camp.x - P.x, P.camp.y - P.y) > 30) {
    P.camp = null; say(CAMP.lost); emit('camp', null);
  }

  // zone change (pyramids are their own zone)
  const z = zoneAt(P.x, P.y);
  if (z.id !== G.zone) {
    const zoneSaid = T().zoneSaid;
    if (G.zone) zoneSaid.set(G.zone, G.turn);                  // the zone being left counts as freshly known
    G.zone = z.id;
    const last = zoneSaid.get(z.id), quiet = last !== undefined && G.turn - last < ZONE_QUIET;
    zoneSaid.set(z.id, G.turn);
    if (!quiet) say(ZONE_ENTER(z.name), 'zone');
    emit('zone', { zone: z, quiet });
  }

}

// =====================================================================================================================
// Auto-actions
// =====================================================================================================================

/** Classic double-tap rule: plain, known, walkable (or swimmable) ground with no monster, NPC or item on it,
 *  not the hero's own tile, not a pyramid door / stairs / chest, and a path exists. */
export function canAutoWalk(x, y) {
  const t = terr(x, y);
  if ((x === G.P.x && y === G.P.y) || !isSeen(x, y) || t.blocks || monAt(x, y) || npcAt(x, y) || campAt(x, y)
    || G.items.has(WK(x, y)) || SPECIAL_STEP.includes(t.key)) return false;
  const opts = { shown };
  const p = findPath(x, y, opts) || findPath(x, y, { ...opts, wet: true });
  return !!p && p.length > 0;
}

const visibleThreats = () => new Set(G.mons.filter(m => isVis(m.x, m.y) && shown(m)));

/** Begin a multi-turn action that runs one step per tick until done or interrupted (new enemy in view, damage taken,
 *  any player input). a = {kind:'go', x, y} | {kind:'go', mon} (charge and attack) | {kind:'work', x, y} |
 *  {kind:'rest'} | {kind:'npc', npc} (walk next to an NPC, then emit 'hail'). Sets G.auto. */
export function startAuto(a) {
  if (!a || G.over) return;
  T().queued = null;
  G.auto = a;
  const t = T();
  t.known = visibleThreats();
  if (a.mon) t.known.add(a.mon);
  emit('auto', { auto: a });
  if (a.kind === 'rest' && G.P.hp < G.P.max && campNear(2)) say(CAMP.rest);
  if (!t.acted) runAuto();                          // first step right away; the rest ride the clock
}

/** Cancel the running auto-action, if any. Called by input.js on every tap and key. */
export function stopAuto() {
  if (G.auto) { G.auto = null; emit('auto', { auto: null }); }
}

function runAuto() {
  try { tick(); } catch (e) {
    console.error('[turn.tick]', e);
    say('Something went wrong with your plans. This is not new.', 'sys');
    stopAuto();
  }
}

/** One auto-action step. Returns true when the action should continue on the next tick. */
function tick() {
  const a = G.auto, P = G.P;
  if (!a || G.over) return false;
  const stop = () => { stopAuto(); return false; };

  if (a.kind === 'rest') {
    if (P.hp >= P.max) { say(CAMP.rested); return stop(); }
    endTurn(true);
  } else {
    let tx = a.x, ty = a.y;
    if (a.kind === 'npc') {
      const n = a.npc;
      if (!n || !G.npcs.includes(n)) return stop();
      if (cheb(n.x, n.y) <= 1) { stopAuto(); emit('hail', { npc: n }); return false; }
      tx = n.x; ty = n.y;
    }
    if (a.mon) {
      if (!G.mons.includes(a.mon)) return stop();
      if (inRange(a.mon)) {
        attack(a.mon); endTurn();
        if (a.hunt && G.mons.includes(a.mon) && a.mon.hp > 0 && !G.over) return true;   // tap-to-fight: keep swinging
        stopAuto(); return false;
      }
      tx = a.mon.x; ty = a.mon.y;
    }
    if (tx == null || ty == null) return stop();

    if (a.kind === 'work' && cheb(tx, ty) <= 1 && !(tx === P.x && ty === P.y)) {
      if (!workInfo(tx, ty)) return stop();
      const done = doWork(tx, ty);
      endTurn();
      if (done) return stop();
    } else {
      const adjGoal = !!a.mon || a.kind === 'work' || a.kind === 'npc';
      const o = { adj: adjGoal, shown };
      const p = findPath(tx, ty, o) || findPath(tx, ty, { ...o, wet: true }) || findPath(tx, ty, { ...o, wet: true, thru: true });
      if (!p || !p.length) { if (!p) say('There is no path there. Many such cases.'); return stop(); }
      const bm = monAt(p[0][0], p[0][1]);
      if (bm) { say(`${theName(bm,1)} is in the way.`); return stop(); }
      if (!step(p[0][0] - P.x, p[0][1] - P.y)) return stop();
      endTurn();
      if (a.kind === 'go' && !a.mon && P.x === a.x && P.y === a.y) return stop();
    }
  }

  if (G.over || G.auto !== a) return false;
  const nu = a.hunt ? null : [...visibleThreats()].find(m => !T().known.has(m));   // a hunt ignores newcomers
  if (nu) { say(`You spot ${theName(nu)}. You stop, as is customary.`); return stop(); }
  if (a.hurt && !a.mon) return stop();          // damage taken (set by combat.hurt) interrupts a walk
  return true;
}

// =====================================================================================================================
// Terrain work (classic "TERRAIN WORK")
// =====================================================================================================================

/** Classic workInfo: what the equipped weapon can do to the blocking terrain at (x,y):
 *  {n: turns needed, to: resulting terrain key, verb} or null. Overworld only. */
export function workInfo(x, y) {
  if (G.dg) return null;
  const t = terr(x, y), w = G.P.wep;
  if ((t.key === 'tree' || t.key === 'dtree') && w.chop) return { n: w.chop - (t.key === 'dtree' ? 1 : 0), to: 'stump', verb: 'Chop it down' };
  if (t.key === 'cactus' && w.chop) return { n: Math.max(1, w.chop - 2), to: 'sand', verb: 'Chop it down' };
  if ((t.key === 'rock' || t.key === 'srock') && w.mine) return { n: w.mine, to: 'scree', verb: 'Break through' };
  if ((t.key === 'wall' || t.key === 'pillar') && w.mine) return { n: w.mine + 3, to: 'rubble', verb: 'Knock it down' };
  return null;
}

/** Classic workHint(t): the wry line shown when you cannot walk onto terrain def t. */
export function workHint(t) {
  const k = t && t.key;
  return k === 'tree' || k === 'dtree' ? 'A big enough axe would fix that.'
    : k === 'cactus' ? 'An axe would handle it. Hugging will not.'
      : k === 'rock' || k === 'srock' ? 'A pickaxe would fix that. Eventually.'
        : k === 'pyr' ? 'Built by someone who really wanted to be remembered, and wasn\'t. Find the entrance (∏).'
          : k === 'pwall' ? 'Tomb walls. Built to outlast you, which they will.'
            : k === 'jwall' ? 'Temple stone under a century of moss. The moss is winning, slowly, and has tenure.'
            : k === 'swall' ? 'Rotten timber, held up mostly by habit. Not by enough habit to walk through.'
            : k === 'cwall' ? 'Dungeon masonry. It has held better people than you, for longer.'
            : k === 'mwall' ? 'Solid mountain. It was here first and intends to make that everyone\'s problem.'
            : k === 'dlock' ? 'Locked. The key is on this floor somewhere, being guarded by someone with a grudge.'
            : G.dg && (k === 'srock' || k === 'rock' || k === 'wall') ? 'Load-bearing. Everything down here is, emotionally.'
            : k === 'wall' || k === 'pillar' ? 'A pickaxe could fix that, with patience.'
              : '';
}

/** One turn of chopping/mining at (x,y). Returns true when the job is finished (terrain changed via world.setTerrain).
 *  Does not end the turn. Emits 'work' {x, y, left} for every swing. */
export function doWork(x, y) {
  const wi = workInfo(x, y);
  if (!wi) return true;
  const P = G.P, k = WK(x, y), p = (P.work.get(k) || 0) + 1;
  if (p >= wi.n) {
    P.work.delete(k);
    setTerrain(x, y, wi.to);
    say(wi.to === 'stump' ? 'Timber. The tree falls with the quiet dignity of the recently unemployed.'
      : wi.to === 'scree' ? 'The rock gives way. Geology is, ultimately, negotiable.'
        : wi.to === 'sand' ? 'The cactus comes down. It had been through a lot, and none of it was your fault.'
          : 'The wall comes down. The architect, long dead, is spared the sight.');
    emit('work', { x, y, left: 0 });
    return true;
  }
  P.work.set(k, p);
  if (p === 1) say(wi.to === 'stump' ? 'You start chopping. The tree has done nothing to deserve this.' : 'You start swinging at it. It does not notice for some time.');
  emit('work', { x, y, left: wi.n - p });
  return false;
}

// =====================================================================================================================
// Camp
// =====================================================================================================================

/** Light a campfire on a free adjacent tile (overworld, no visible enemies). Sets G.P.camp; costs one turn.
 *  Returns true on success. */
export function makeCamp() {
  const P = G.P;
  if (G.over) return false;
  if (G.dg) { say(CAMP.indoors); return false; }
  if (isDeep(P.x, P.y)) { say(CAMP.noRoom); return false; }
  if (G.mons.some(m => isVis(m.x, m.y) && shown(m))) { say(CAMP.danger); return false; }
  const spots = [];
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
    const x = P.x + a, y = P.y + b;
    if ((a || b) && free(x, y) && !isDeep(x, y) && terr(x, y).kind === 'ground' && !SPECIAL_STEP.includes(terr(x, y).key) && !G.items.has(WK(x, y))) spots.push([x, y]);
  }
  if (!spots.length) { say(CAMP.noRoom); return false; }
  stopAuto();
  const [x, y] = spots[R(spots.length)];
  P.camp = { x, y };
  say(CAMP.make);
  emit('camp', { x, y });
  endTurn();
  return true;
}
