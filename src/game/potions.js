// game/potions.js — OWNER: builder C (v0.3). Four potions, per-run colours, identify-by-drinking, a carried belt,
// throwing poison. Contract: docs/ARCHITECTURE-v0.3.md §4.
//
//   Kinds (config.POTION_KINDS): heal | tele | nuke | poison.
//   G.run.pot = { colors: { heal: {key, name, col}, ... }, known: ['heal', ...] }   (dealt in loot.potRun)
//   G.P.pots  = { heal: n, ... }   the belt; created lazily, saved with P.
//   Ground item: loot.potionItem(pot?) is the only factory.
//
// drink(pot) / throwPoison(m) apply the effect and return true when a turn was spent; THE CALLER calls endTurn()
// (same convention as spells.castSpell). Nothing here imports ui/, render/ or audio/: it all goes out on the bus:
//   'potion' { pot, by: 'drink'|'throw', first, from?, to? }   'nuke' { x, y, r, kills }   'teleport' { from, to }
import { G, say } from '../core/state.js';
import { on, emit } from '../core/bus.js';
import { POTION_KINDS, NUKE_R, NUKE_SELF_DMG, WS } from '../core/config.js';
import { R, WK, wx, mod } from '../core/util.js';
import { SPECIAL_STEP } from '../data/terrain.js';
import { terr, free, los, isVis, calcVis } from '../world/world.js';
import { shown } from './monsters.js';
import { gainXP, die, damageMon, theName } from './combat.js';
import {
  potRun, potName, potColor, potColorInfo, potSpriteId, isKnown, isPotKind, POTION_INFO,
} from './loot.js';

export { potName, potColor, isKnown, potSpriteId } from './loot.js';

const THROW_R = 6;
const NUKE_BY = { name: 'your own Nuke potion', col: '#ffd23f' };
const POISON_TURNS = 8;          // drinker
const MON_POISON = 6;            // thrown at a monster (bosses: 4)
const MON_AI_RANGE = 24;         // poison only ticks on monsters close enough to be simulated (monsters.js AI_RANGE)

const warned = new Set();
function guard(tag, fn, fallback) {
  try { return fn(); } catch (e) {
    const k = tag + ':' + (e && e.message);
    if (!warned.has(k)) { warned.add(k); console.error('[potions.' + tag + ']', e); }
    return fallback;
  }
}
const cheb = (x, y) => Math.max(Math.abs(x - G.P.x), Math.abs(y - G.P.y));

// ---------------------------------------------------------------------------------------------------------------------
// the belt
// ---------------------------------------------------------------------------------------------------------------------
function pots() {
  const P = G.P;
  if (!P.pots || typeof P.pots !== 'object') P.pots = {};
  return P.pots;
}
/** How many of a kind the hero carries. */
export function potCount(pot) { return guard('potCount', () => Math.max(0, pots()[pot] | 0), 0); }

/** Put n potions of a kind on the hero's belt (merchants, chests, quest rewards). Returns the new count. */
export function givePotion(pot, n = 1) {
  return guard('givePotion', () => {
    if (!isPotKind(pot)) return 0;
    n = Math.max(0, n | 0);
    const b = pots();
    b[pot] = (b[pot] | 0) + n;
    potRun();
    return b[pot];
  }, 0);
}

/** The belt for UIs: [{ pot, n, name, col, known, sprite, desc }] in POTION_KINDS order, held kinds only. */
export function belt() {
  return guard('belt', () => POTION_KINDS.filter(k => potCount(k) > 0).map(k => ({
    pot: k, n: potCount(k), name: potName(k), col: potColor(k), known: isKnown(k), sprite: potSpriteId(k),
    desc: isKnown(k) ? POTION_INFO[k].desc : 'Unlabelled. You will find out what it does by finding out what it does.',
  })), []);
}

// ---------------------------------------------------------------------------------------------------------------------
// effects
// ---------------------------------------------------------------------------------------------------------------------
const colourOf = pot => { const c = potColorInfo(pot); return c ? c.name : 'unlabelled'; };

function doHeal(known, cname) {
  const P = G.P, h = 6 + R(6) + P.lvl, before = P.hp;
  P.hp = Math.min(P.max, P.hp + h);
  say(known
    ? `You drink a Healing potion. Covered in full, for once. +${h} HP`
    : `You drink the ${cname} potion. It tastes of hospital corridors and works anyway. +${h} HP`, 'good');
  emit('heal', { amount: P.hp - before, kind: 'potion' });
}

/** Could the hero arrive on (x,y)? Dry, walkable, empty, not a door / stairs / chest. */
function landable(x, y) {
  const t = terr(x, y);
  if (!t || t.blocks || t.deep || t.kind === 'liquid' || t.kind === 'none') return false;
  if (SPECIAL_STEP.includes(t.key) || t.key === 'dkey' || /door|stair|chest|exit|portal/i.test(t.key)) return false;
  return free(x, y) && !G.items.has(WK(x, y));
}
/** Not a one-tile pocket: at least three walkable neighbours. */
function roomy(x, y) {
  let n = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue;
    const t = terr(x + dx, y + dy);
    if (t && !t.blocks) n++;
  }
  return n >= 3;
}
/** A random destination: anywhere on the planet (nearest image in the hero's unwrapped frame), or anywhere on the
 *  current dungeon floor. null if nothing qualifies. */
function teleportSpot() {
  const P = G.P;
  if (G.dg) {
    const w = G.seenW | 0, h = w > 0 ? Math.floor(G.seen.length / w) : 0, spots = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x !== P.x || y !== P.y) && landable(x, y)) spots.push(x, y);
    if (!spots.length) return null;
    const i = R(spots.length / 2) * 2;
    return { x: spots[i], y: spots[i + 1] };
  }
  const px = wx(P.x), py = wx(P.y);
  for (let tries = 0; tries < 600; tries++) {
    const ax = R(WS), ay = R(WS);
    const x = P.x + mod(ax - px + WS / 2, WS) - WS / 2, y = P.y + mod(ay - py + WS / 2, WS) - WS / 2;
    if (Math.max(Math.abs(x - P.x), Math.abs(y - P.y)) < 12) continue;     // "somewhere else" means somewhere else
    if (landable(x, y) && (tries > 400 || roomy(x, y))) return { x, y };
  }
  return null;
}

function doTele(known, cname) {
  const P = G.P;
  say(known
    ? 'You drink a Teleportation potion and are, without consultation, relocated.'
    : `You drink the ${cname} potion. Space folds you up like a fitted sheet and puts you somewhere else.`, 'good');
  const to = teleportSpot();
  if (!to) { say('The universe looks for somewhere to put you and comes up empty. You stay put, which is its own kind of answer.'); return; }
  const from = { x: P.x, y: P.y };
  if (G.auto) { G.auto = null; emit('auto', { auto: null }); }
  P.x = to.x; P.y = to.y;
  if (P.buffs && P.buffs.feign) P.buffs.feign = 0;
  calcVis();
  emit('moved', { from, to: { x: P.x, y: P.y } });
  emit('teleport', { from, to: { x: P.x, y: P.y } });
  say(G.dg ? 'You reappear elsewhere on this floor. The walls pretend not to have noticed.'
    : 'You arrive. Nobody here was expecting you, and nobody here is pleased.');
}

/** Wrapped Chebyshev distance from the hero to a stored item key "x,y". */
function keyCheb(k) {
  const i = k.indexOf(','), x = +k.slice(0, i), y = +k.slice(i + 1), P = G.P;
  const dx = mod(x - wx(P.x) + WS / 2, WS) - WS / 2, dy = mod(y - wx(P.y) + WS / 2, WS) - WS / 2;
  return Math.max(Math.abs(dx), Math.abs(dy));
}

function doNuke(known, cname) {
  const P = G.P, r = NUKE_R, x = P.x, y = P.y;
  say(known
    ? 'You drink a Nuke potion. You were warned. You wrote the warning.'
    : `You drink the ${cname} potion. For one brief, thermonuclear moment you are the most important thing on the planet.`, 'bad');
  // 1. every monster in the square dies (NPCs are not in G.mons and are spared)
  const victims = G.mons.filter(m => m && Math.max(Math.abs(m.x - x), Math.abs(m.y - y)) <= r);
  let xp = 0;
  for (const m of victims) {
    const i = G.mons.indexOf(m);
    if (i < 0) continue;
    G.mons.splice(i, 1);
    m.hp = 0;
    P.kills = (P.kills || 0) + 1;
    if (m.name && !m.dboss && !G.dex.has(m.name)) { G.dex.add(m.name); emit('dex', { name: m.name, count: G.dex.size }); }
    xp += m.xp | 0;
    emit('kill', { mon: m, by: 'nuke' });
  }
  // 2. every ground item in the square is vaporised
  let gone = 0;
  for (const k of [...G.items.keys()]) if (keyCheb(k) <= r) { G.items.delete(k); gone++; }
  // 3. the news
  const n = victims.length;
  if (n === 1) say(`${theName(victims[0], 1)} ceases to be, along with any outstanding grievances. (+${xp} XP)`, 'good');
  else if (n > 1) say(`${n} things within ten tiles cease to be, along with their belongings and any outstanding grievances. (+${xp} XP)`, 'good');
  else say('The blast finds nobody worth vaporising. The scenery takes it personally.');
  if (gone) say(gone === 1 ? 'Something lying on the ground is reduced to a rumour.' : `${gone} things lying on the ground are reduced to rumours.`);
  emit('nuke', { x, y, r, kills: n });
  if (xp > 0) gainXP(xp);
  // 4. the drinker pays, last, so a level-up's full heal cannot refund it
  const d = NUKE_SELF_DMG;
  P.hp -= d;
  say(`You take ${d} damage, mostly from the lesson. -${d}`, 'bad');
  emit('hurt', { by: NUKE_BY, dmg: d, kind: 'nuke', x: P.x, y: P.y });
  if (P.hp <= 0) die(NUKE_BY);
}

function doPoison(known, cname) {
  const P = G.P;
  P.poison = Math.max(P.poison | 0, POISON_TURNS);
  say(known
    ? 'You drink the Poison potion on purpose. Bold. Unclear, but bold.'
    : `You drink the ${cname} potion. It is poison. Your liver drafts a strongly worded letter.`, 'bad');
  emit('status', { mon: null, kind: 'poison' });
}

const EFFECT = { heal: doHeal, tele: doTele, nuke: doNuke, poison: doPoison };
const IDENT = {
  heal: c => `${c} turns out to be Healing. A product doing what it said, had it said anything.`,
  tele: c => `${c} is Teleportation. Your landlord would call this a transfer of tenancy.`,
  nuke: c => `${c} is a Nuke. Handle with the care you have previously shown nothing.`,
  poison: c => `${c} is Poison. Now you can throw it at people, which is what poison is socially for.`,
};

/** Drink one potion of a kind from the belt. Identifies the kind on first drink. Returns true if drunk (a turn
 *  was spent: the caller calls endTurn()). */
export function drink(pot) {
  return guard('drink', () => {
    const P = G.P;
    if (!P || G.over || !isPotKind(pot)) return false;
    const n = potCount(pot);
    if (n <= 0) { say(`You have no ${potName(pot)}. You check your pockets twice anyway.`); return false; }
    const b = pots();
    b[pot] = n - 1;
    if (!b[pot]) delete b[pot];
    const known = isKnown(pot), cname = colourOf(pot), run = potRun();
    const first = !known;
    if (first) run.known.push(pot);
    EFFECT[pot](known, cname);
    if (first) say(IDENT[pot](cname), 'sys');
    emit('potion', { pot, by: 'drink', first, from: { x: P.x, y: P.y } });
    return true;
  }, false);
}

// ---------------------------------------------------------------------------------------------------------------------
// throwing poison
// ---------------------------------------------------------------------------------------------------------------------
/** Why poison cannot be thrown at m right now, or '' if it can. */
export function throwBlock(m) {
  return guard('throwBlock', () => {
    const P = G.P;
    if (!isKnown('poison')) return 'You do not yet know which bottle is the poison.';
    if (potCount('poison') < 1) return 'No poison on the belt.';
    if (!m || !G.mons.includes(m)) return 'That target is no longer available.';
    if (cheb(m.x, m.y) > THROW_R) return `Out of throwing range (${THROW_R}).`;
    if (!isVis(m.x, m.y) || !shown(m)) return 'You cannot see it.';
    if (!los(P.x, P.y, m.x, m.y)) return 'No clear line to throw.';
    return '';
  }, 'Throwing has been suspended pending review.');
}
/** Show the throw button at all? (identified and held) */
export const canThrowPoison = () => isKnown('poison') && potCount('poison') > 0;

/** Throw a Poison potion at monster m. Returns true if thrown (the caller calls endTurn()). */
export function throwPoison(m) {
  return guard('throwPoison', () => {
    const why = throwBlock(m);
    if (why) { say(why); return false; }
    const P = G.P, b = pots();
    b.poison = (b.poison | 0) - 1;
    if (b.poison <= 0) delete b.poison;
    const from = { x: P.x, y: P.y }, to = { x: m.x, y: m.y };
    if (P.buffs && P.buffs.feign) P.buffs.feign = 0;
    say(`You lob the Poison potion at ${theName(m)}. It shatters into a small, personal climate disaster.`);
    emit('potion', { pot: 'poison', by: 'throw', first: false, from, to });
    m.poison = Math.max(m.poison | 0, m.boss ? 4 : MON_POISON);
    m.awake = m.seen = true;
    emit('status', { mon: m, kind: 'poison' });
    damageMon(m, 2 + R(3), { kind: 'poison', msg: `${theName(m, 1)} takes a faceful of it.` });
    return true;
  }, false);
}

/** Poisoned monsters lose HP each turn (bleed/burn tick in monsters.js; poison is ours, so it ticks on 'turn'). */
function tickMonsterPoison() {
  if (G.over || !G.P || !G.mons) return;
  const P = G.P;
  for (const m of [...G.mons]) {
    if (!(m.poison > 0) || !G.mons.includes(m)) continue;
    if (Math.abs(m.x - P.x) > MON_AI_RANGE || Math.abs(m.y - P.y) > MON_AI_RANGE) continue;
    m.poison--;
    const d = 1 + R(2) + Math.floor((m.max | 0) * .04);
    if (isVis(m.x, m.y) && shown(m)) say(`${theName(m, 1)} is poisoned. -${d}`);
    damageMon(m, d, { kind: 'poison', silent: true });
    if (G.over) return;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------------------------------------------------
let ready = false;
/** Subscribe once: deal colours on 'newgame' (unless spawning already did), repair older saves on 'loaded',
 *  tick monster poison every turn. */
export function initPotions() {
  if (ready) return;
  ready = true;
  on('newgame', () => guard('newgame', () => { potRun(); pots(); }));
  on('loaded', () => guard('loaded', () => { potRun(); pots(); }));
  on('turn', () => guard('tick', tickMonsterPoison));
}
