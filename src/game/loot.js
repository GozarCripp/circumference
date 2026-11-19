// game/loot.js — OWNER: Foreman B / loot worker.
// Contract: docs/ARCHITECTURE.md §8.B6. Item data + item logic. Port the classic "LOOT" section 1:1: the tables
// (WT, TAGD, QUAL, EPI, MATS, SLOTS — same numbers, same strings) and rollQ / genGear / gearItem / gearDesc /
// defense / pieces / pickup, plus the Gear-screen verbs (equip, drop) and scroll items.
//
// Gear (weapon): { kind:'wep', type, name, q, min, max, tags:[], chop, mine, col }      q = quality name
// Gear (armour): { kind:'arm', slot, mat, prop, heavy, name, q, def, col }
// Ground item:   { ch, col, kind:'potion'|'gold'|'gear'|'scroll', name, gear?, spell?, pot? }  (lives in G.items by WK)
// Potions (v0.3): pot = 'heal'|'tele'|'nuke'|'poison'; colours per run in G.run.pot; carried in P.pots = {kind: n}.
import { G, say } from '../core/state.js';
import { emit } from '../core/bus.js';
import { BAG } from '../core/config.js';
import { R, pick, slug, WK } from '../core/util.js';
import { isDeep } from '../world/world.js';
import { learnSpell, randomSpell } from './spells.js';

// ---- data: VERBATIM from classic (already ported by the architect — keep the numbers and strings) -------------
const W = (type, min, max, tags = [], chop = 0, mine = 0) => ({ type, min, max, tags, chop, mine });
/** Weapon classes (classic WT), classic order. chop = turns to fell a tree, mine = turns to break rock (0 = cannot). */
export const WEAPONS = [
  W('Dagger', 1, 4, ['multi']), W('Straight Sword', 2, 6), W('Greatsword', 4, 10), W('Ultra Greatsword', 7, 16, ['slow', 'cleave']),
  W('Curved Sword', 2, 5, ['bleed']), W('Katana', 3, 7, ['bleed', 'crit']), W('Curved Greatsword', 5, 11, ['cleave']), W('Thrusting Sword', 2, 6, ['crit']),
  W('Axe', 3, 7, [], 4), W('Greataxe', 6, 13, ['slow', 'cleave'], 3), W('Hammer', 3, 8, ['stun']), W('Great Hammer', 7, 15, ['slow', 'stun'], 0, 9),
  W('Pickaxe', 2, 6, [], 0, 5), W('Spear', 3, 7, ['reach']), W('Halberd', 4, 9, ['reach', 'cleave']), W('Scythe', 4, 9, ['cleave', 'bleed']),
  W('Whip', 2, 5, ['reach']), W('Fist Weapons', 1, 4, ['multi', 'stun']), W('Claws', 1, 4, ['multi', 'bleed']), W('Twinblade', 2, 6, ['multi']),
  W('Bow', 2, 6, ['ranged']), W('Greatbow', 5, 12, ['ranged', 'slow']), W('Crossbow', 4, 8, ['ranged']), W('Sorcery Staff', 3, 7, ['ranged']),
  W('Pyromancy Flame', 3, 8, ['ranged', 'burn']),
];
/** Tag descriptions (classic TAGD). */
export const TAGD = { multi: 'hits twice', slow: 'heavy: enemies get an extra turn', cleave: 'hits everything adjacent', bleed: 'causes bleeding', crit: 'high crit chance', stun: 'can stun', reach: 'reach 2', ranged: 'range 6', burn: 'sets things on fire' };
/** Qualities, best first (classic QUAL). */
export const QUALITIES = [
  { name: 'Legendary', mult: 1.8, col: '#fa3' }, { name: 'Masterwork', mult: 1.45, col: '#6af' }, { name: 'Fine', mult: 1.2, col: '#7f7' },
  { name: 'Plain', mult: 1, col: '#ddd' }, { name: 'Rusty', mult: .8, col: '#999' },
];
/** Legendary epithets (classic EPI). */
export const EPITHETS = ['of the Final Notice', 'of Hostile Takeover', 'of Diminishing Returns', 'of Severance', 'of the Quarterly Report', 'of Mild Inconvenience', 'of Unpaid Overtime', 'of the Hidden Fee'];
/** Armour materials (classic MATS). prop keys: dog | bureau | ghost | obsidian | space. */
export const MATERIALS = [
  { name: 'Leather', tier: 0, def: 1, col: '#a86', prop: '', desc: '', heavy: 0 },
  { name: 'Iron', tier: 1, def: 2, col: '#bbb', prop: '', desc: '', heavy: 1 },
  { name: 'Bone', tier: 1, def: 2, col: '#eed', prop: '', desc: '', heavy: 0 },
  { name: 'Dog', tier: 2, def: 2, col: '#c96', prop: 'dog', desc: 'each piece: 12% chance a dog bites your attacker', heavy: 0 },
  { name: 'Bureaucrat', tier: 2, def: 2, col: '#99a', prop: 'bureau', desc: 'each piece: 7% chance attackers stop to do paperwork', heavy: 0 },
  { name: 'Ghost', tier: 3, def: 2, col: '#cdf', prop: 'ghost', desc: 'each piece: 8% chance attacks pass through you', heavy: 0 },
  { name: 'Obsidian', tier: 3, def: 4, col: '#a6f', prop: 'obsidian', desc: '2+ pieces: immune to fire', heavy: 1 },
  { name: 'Diamond', tier: 4, def: 5, col: '#6ff', prop: '', desc: '', heavy: 1 },
  { name: 'Space-Age', tier: 5, def: 6, col: '#fff', prop: 'space', desc: 'each piece speeds healing; 4 pieces: immune to poison', heavy: 0 },
];
/** Armour slots (classic SLOTS). */
export const SLOTS = [{ slot: 'head', noun: 'Helm', mult: .8 }, { slot: 'body', noun: 'Cuirass', mult: 1.4 }, { slot: 'arms', noun: 'Gauntlets', mult: .7 }, { slot: 'legs', noun: 'Greaves', mult: 1 }];
// ---- potions (v0.3, builder C): four kinds, per-run colours, identify by drinking ------------------------------
/** Colour pool the run's potions are dealt from. key = sprite suffix (item/potion-<key>); the hex is mirrored by hand
 *  in art/hero.js POTION_TINT (art never imports gameplay), so keep the two in step. */
export const POTION_COLORS = [
  { key: 'teal', name: 'Murky Teal', col: '#2a9d8f' },
  { key: 'orange', name: 'Hostile Orange', col: '#f07a1a' },
  { key: 'purple', name: 'Bruise Purple', col: '#8a46c0' },
  { key: 'beige', name: 'Office Beige', col: '#cdb98a' },
  { key: 'pink', name: 'Suspicious Pink', col: '#ff6fb5' },
  { key: 'red', name: 'Arterial Red', col: '#d0312d' },
  { key: 'green', name: 'Pond Green', col: '#5f9f2a' },
  { key: 'blue', name: 'Sincere Blue', col: '#2f6fe0' },
  { key: 'yellow', name: 'Fluorescent Yellow', col: '#e8e23a' },
  { key: 'grey', name: 'Landlord Grey', col: '#8a8a9a' },
];
/** What each kind is called once identified, and its one-line description. */
export const POTION_INFO = {
  heal: { name: 'Healing potion', desc: 'Restores some HP. No co-pay, no paperwork, no follow-up appointment.' },
  tele: { name: 'Teleportation potion', desc: 'Puts you somewhere else on the planet, at random. Like a career.' },
  nuke: { name: 'Nuke potion', desc: 'Everything hostile within ten tiles stops existing. You take 10 damage for the privilege.' },
  poison: { name: 'Poison potion', desc: 'Drinking it poisons you. Throwing it poisons someone else, which is the better plan.' },
};
const POT_WEIGHT = { heal: 50, tele: 20, poison: 20, nuke: 10 };
const POT_KINDS = Object.keys(POT_WEIGHT);

/** A fresh run's potion state: four distinct colours dealt from POTION_COLORS, nothing known. */
function dealPotions() {
  const pool = POTION_COLORS.slice(), colors = {};
  for (const k of POT_KINDS) { const c = pool.splice(R(pool.length), 1)[0]; colors[k] = { key: c.key, name: c.name, col: c.col }; }
  return { colors, known: [] };
}
/** G.run.pot, created on first use (spawns happen before 'newgame' fires) and repaired if a save mangled it. */
export function potRun() {
  if (!G.run) G.run = {};
  let r = G.run.pot;
  if (!r || typeof r !== 'object' || !r.colors || POT_KINDS.some(k => !r.colors[k])) r = G.run.pot = dealPotions();
  if (!Array.isArray(r.known)) r.known = [];
  return r;
}
/** Roll a potion kind: heal 50, tele 20, poison 20, nuke 10. */
export function rollPotKind() {
  let r = R(100);
  for (const k of POT_KINDS) { r -= POT_WEIGHT[k]; if (r < 0) return k; }
  return 'heal';
}
export const isPotKind = pot => Object.prototype.hasOwnProperty.call(POT_WEIGHT, pot);
/** Has this kind been identified (by drinking) this run? */
export function isKnown(pot) { try { return potRun().known.includes(pot); } catch (e) { return false; } }
/** The run colour of a kind: { key, name, col }. */
export function potColorInfo(pot) { try { return potRun().colors[pot] || null; } catch (e) { return null; } }
/** Hex colour of a kind this run. */
export function potColor(pot) { const c = potColorInfo(pot); return c ? c.col : '#f55'; }
/** "Murky Teal potion" until identified, then "Healing potion". */
export function potName(pot) {
  if (!isPotKind(pot)) return 'Mystery potion';
  if (isKnown(pot)) return POTION_INFO[pot].name;
  const c = potColorInfo(pot);
  return c ? c.name + ' potion' : 'Mystery potion';
}
/** Sprite id of a potion kind (tinted by its run colour). */
export function potSpriteId(pot) { const c = isPotKind(pot) && potColorInfo(pot); return c ? 'item/potion-' + c.key : 'item/potion'; }

/** Every item sprite id: 25 weapons, 9 x 4 armour pieces, potion (+ one per potion colour), gold, scroll. */
export const ITEM_IDS = WEAPONS.map(w => 'item/wep-' + slug(w.type))
  .concat(MATERIALS.flatMap(m => SLOTS.map(s => 'item/arm-' + slug(m.name) + '-' + s.slot)), ['item/potion', 'item/gold', 'item/scroll'],
    POTION_COLORS.map(c => 'item/potion-' + c.key));
/** Hero overlay layer ids: hero/base, hero/swim, hero/<slot>-<mat> x36, hero/wep-<slug> x25. */
export const HERO_IDS = ['hero/base', 'hero/swim'].concat(MATERIALS.flatMap(m => SLOTS.map(s => 'hero/' + s.slot + '-' + slug(m.name))), WEAPONS.map(w => 'hero/wep-' + slug(w.type)));

// ---- logic ---------------------------------------------------------------------------------------------------

/** Roll a quality (classic odds: 3% Legendary, 9% Masterwork, 18% Fine, 30% Plain, 40% Rusty; bosses roll 0-29 of
 *  that scale, so no Rusty and 10% Legendary). Returns a fresh copy {name, mult, col, epithet?}; Legendary gets an
 *  epithet from EPITHETS. lvl is accepted for API symmetry (classic odds do not depend on it). */
export function rollQ(lvl, boss) {
  if (typeof lvl === 'boolean') { boss = lvl; lvl = 1; }
  const r = R(boss ? 30 : 100);
  const q = { ...QUALITIES[r < 3 ? 0 : r < 12 ? 1 : r < 30 ? 2 : r < 60 ? 3 : 4] };
  if (q.name === 'Legendary') q.epithet = pick(EPITHETS);
  return q;
}

/** Random gear for monster level lvl; boss = better quality odds (classic genGear). */
export function genGear(lvl, boss) {
  lvl = Number.isFinite(lvl) ? Math.max(1, lvl) : 1;
  const q = rollQ(lvl, !!boss), epi = q.epithet ? ' ' + q.epithet : '';
  if (R(100) < 55) {
    const t = pick(WEAPONS), s = 1 + lvl * .12;
    return {
      kind: 'wep', type: t.type, name: `${q.name} ${t.type}${epi}`, q: q.name,
      min: Math.max(1, Math.round(t.min * q.mult * s)), max: Math.max(1, Math.round(t.max * q.mult * s)),
      tags: t.tags.slice(), chop: t.chop, mine: t.mine, col: q.col,
    };
  }
  const m = pick(MATERIALS.filter(x => x.tier <= 1 + Math.floor(lvl / 3))), sl = pick(SLOTS);
  return {
    kind: 'arm', slot: sl.slot, mat: m.name, prop: m.prop, heavy: !!m.heavy,
    name: `${q.name === 'Plain' ? '' : q.name + ' '}${m.name} ${sl.noun}${epi}`, q: q.name,
    def: Math.max(1, Math.round(m.def * sl.mult * q.mult * (1 + lvl * .06))), col: q.col,
  };
}

/** Wrap gear as a ground item (classic gearItem). */
export function gearItem(g) { return { ch: g.kind === 'wep' ? ')' : '[', col: g.col, kind: 'gear', gear: g, name: g.name }; }
/** Ground-item factories. */
/** The ONE way to make a potion ground item: { kind:'potion', pot, ch:'!', col, name }. No argument = weighted roll.
 *  name is a snapshot; UI should call potName(it.pot) so identification shows up on items already lying about. */
export function potionItem(pot) {
  if (!isPotKind(pot)) pot = rollPotKind();
  return { ch: '!', col: potColor(pot), kind: 'potion', pot, name: potName(pot) };
}
export const goldItem = () => ({ ch: '$', col: '#fd3', kind: 'gold', name: 'Pile of gold' });
export function scrollItem(spellId) { return { ch: '?', col: '#efe9ff', kind: 'scroll', name: 'Scroll', spell: spellId }; }

/** One-line stats for a gear object (classic gearDesc). */
export function gearDesc(g) {
  if (!g) return '';
  if (g.kind === 'wep') {
    const tags = (g.tags || []).map(t => TAGD[t]).filter(Boolean);
    return `${g.min}-${g.max} dmg${tags.length ? ' · ' + tags.join(', ') : ''}${g.chop ? ' · chops trees' : ''}${g.mine ? ' · breaks rock' : ''}`;
  }
  const mat = MATERIALS.find(m => m.name === g.mat);
  return `${g.slot} · DEF ${g.def}${g.prop && mat && mat.desc ? ' · ' + mat.desc : ''}${g.heavy ? ' · heavy' : ''}`;
}
/** Total DEF of worn armour (classic defense). */
export function defense() { return Object.values(G.P.arm).reduce((s, a) => s + (a ? a.def : 0), 0); }
/** Count worn pieces by property: {heavy, dog?, bureau?, ghost?, obsidian?, space?} (classic pieces). */
export function pieces() { const c = { heavy: 0 }; for (const a of Object.values(G.P.arm)) if (a) { if (a.prop) c[a.prop] = (c[a.prop] || 0) + 1; if (a.heavy) c.heavy++; } return c; }

/** Nearest tile (hero's/monster's own first, then the 8 neighbours, then ring 2) with no item on it. null if none. */
function freeSpot(x, y) {
  for (let r = 0; r <= 2; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      if (!G.items.has(WK(x + dx, y + dy))) return { x: x + dx, y: y + dy };
    }
  }
  return null;
}
function place(x, y, item) {
  const s = freeSpot(x, y);
  if (!s) return false;
  G.items.set(WK(s.x, s.y), item);
  emit('drop', { x: s.x, y: s.y, item });
  return true;
}

/** Pick up whatever lies under the hero (classic pickup): potions go on the belt (P.pots), gold pocketed, gear bagged (if room),
 *  scrolls read (spells.learnSpell). Emits 'pickup'. */
export function pickup() {
  try {
    const P = G.P, k = WK(P.x, P.y), it = G.items.get(k);
    if (!it) return;
    if (it.kind === 'potion') {
      G.items.delete(k);
      if (!isPotKind(it.pot)) it.pot = rollPotKind();            // pre-v0.3 saves / hand-built items: decide now
      if (!P.pots || typeof P.pots !== 'object') P.pots = {};
      P.pots[it.pot] = (P.pots[it.pot] || 0) + 1;
      const n = P.pots[it.pot], nm = potName(it.pot);
      say(isKnown(it.pot)
        ? `You pocket ${/^[aeiou]/i.test(nm) ? 'an' : 'a'} ${nm}. (${n} on the belt)`
        : `You pocket ${/^[aeiou]/i.test(nm) ? 'an' : 'a'} ${nm}. Nobody has told you what it does, which has never stopped anyone. (${n} on the belt)`, 'loot');
      emit('pickup', { item: it });
    } else if (it.kind === 'gold') {
      G.items.delete(k);
      const g = it.amt > 0 ? it.amt : 3 + R(8 + P.lvl * 3);              // a Former's purse keeps its exact amount
      P.gold += g;
      say(`You find ${g} gold. The economy thanks you for your participation.`, 'loot');
      emit('pickup', { item: it });
    } else if (it.kind === 'gear') {
      if (P.inv.length >= BAG) { say('Your bag is full. Material possessions have limits.', ''); return; }
      G.items.delete(k);
      P.inv.push(it.gear);
      say(`You pick up the ${it.name}. (Gear)`, 'loot');
      emit('pickup', { item: it });
    } else if (it.kind === 'scroll') {
      const res = learnSpell(it.spell);
      if (res === 'learned') {
        G.items.delete(k);
        say('You read the scroll. It makes a sudden and unreasonable amount of sense, then crumbles, as is its right.', 'good');
        emit('pickup', { item: it });
      } else if (res === 'known') {
        G.items.delete(k);
        say('You read the scroll. You already knew this. The reminder is oddly motivating: your Motivation Points are refilled.', 'good');
        emit('pickup', { item: it });
      } else {
        say('A scroll lies here, but your mind already holds four spells and a mortgage. Forget one in the Journal first.', '');
      }
    }
  } catch (e) { console.error('[loot.pickup]', e); }
}

/** Roll a kill's drop at the monster's tile (30%, bosses and rares always; 1 in 6 drops is a scroll). */
export function dropLoot(m) {
  try {
    if (!m || !(m.boss || m.rare || Math.random() < .3)) return;
    const strong = !!(m.boss || m.rare), lvl = m.lvl || 1;
    let item;
    if (R(6) === 0) {
      item = scrollItem(randomSpell());
      say('It drops a scroll, slightly damp with ambition.', 'loot');
    } else {
      const g = genGear(lvl, strong);
      item = gearItem(g);
      say(`It drops something: ${g.name}.`, 'loot');
    }
    place(m.x, m.y, item);
  } catch (e) { console.error('[loot.dropLoot]', e); }
}

/** Gear screen: equip bag item i (swaps with the worn piece). Emits 'equip'. Returns true on success. */
export function equip(i) {
  try {
    const P = G.P, g = P.inv[i];
    if (!g) return false;
    P.inv.splice(i, 1);
    if (g.kind === 'wep') {
      if (!P.wep.fists) P.inv.splice(Math.min(i, P.inv.length), 0, P.wep);
      P.wep = g;
    } else {
      const old = P.arm[g.slot];
      if (old) P.inv.splice(Math.min(i, P.inv.length), 0, old);
      P.arm[g.slot] = g;
    }
    say(`You equip the ${g.name}.`, '');
    if (g.kind === 'arm' && g.heavy && !G.dg && pieces().heavy >= 2 && isDeep(P.x, P.y)) say('Your metal armor is a poor flotation device.', 'bad');
    emit('equip', { gear: g });
    return true;
  } catch (e) { console.error('[loot.equip]', e); return false; }
}

/** Gear screen: drop bag item i. Placed on the hero's tile (or the nearest free one) so it can be picked up again;
 *  if nowhere is free it is simply left behind. Returns true on success. */
export function dropGear(i) {
  try {
    const P = G.P, g = P.inv[i];
    if (!g) return false;
    P.inv.splice(i, 1);
    const ok = place(P.x, P.y, gearItem(g));
    say(ok ? `You leave the ${g.name} behind. Someone will find it. Probably a raccoon.` : `You discard the ${g.name}. It is gone, like your deposit.`, '');
    return true;
  } catch (e) { console.error('[loot.dropGear]', e); return false; }
}
