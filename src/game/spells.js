// game/spells.js — scroll-taught spells, EverQuest style: at most 4 memorised "gems", paid for in MP
// (Motivation Points). The SPELLS table is authored content: keep names, costs and text verbatim.
import { G, say } from '../core/state.js';
import { emit } from '../core/bus.js';
import { R } from '../core/util.js';
import { WS } from '../core/config.js';
import * as world from '../world/world.js';
import * as monsters from './monsters.js';
import * as combat from './combat.js';

export const MAX_SPELLS = 4;

/** target: 'self' | 'enemy' (needs a visible enemy within `range` and line of sight). {m} = monster name. */
export const SPELLS = {
  heal: { id: 'heal', name: 'Minor Healing (Out of Network)', cost: 4, target: 'self', weight: 5,
    desc: 'Restores a modest amount of HP. You will be billed separately.',
    cast: 'You feel somewhat better. Somewhere, an invoice is generated.' },
  bolt: { id: 'bolt', name: 'Firebolt of Passive Aggression', cost: 3, target: 'enemy', range: 6, weight: 5,
    desc: 'Ranged fire damage. May set the target alight, as previously discussed.',
    cast: 'You hurl a firebolt at the {m}. "No worries if not," you add.' },
  root: { id: 'root', name: 'Root: Per My Last Email', cost: 3, target: 'enemy', range: 6, weight: 4,
    desc: 'The target cannot move for 4 turns. It can still hit whatever stands next to it.',
    cast: 'The {m} is rooted to the spot, rereading something it should have read the first time.' },
  mez: { id: 'mez', name: 'Mesmerize: Terms and Conditions', cost: 5, target: 'enemy', range: 6, weight: 3,
    desc: 'The target stops everything to read, until something hurts it. Bosses skim.',
    cast: 'The {m} begins reading the terms and conditions. It will be some time.' },
  paper: { id: 'paper', name: 'Summon Paperwork', cost: 4, target: 'self', weight: 4,
    desc: 'Every adjacent enemy stops to fill out Form 27-B in triplicate.',
    cast: 'Forms rain from a clear sky. Everything near you reaches for a pen.' },
  sow: { id: 'sow', name: 'Spirit of the Commuter', cost: 5, target: 'self', weight: 3,
    desc: 'For 40 turns you move with the grim speed of someone who is late. Enemies act half as often.',
    cast: 'You are filled with the urgency of a person with a connection to make.' },
  feign: { id: 'feign', name: 'Feign Death (Out of Office)', cost: 4, target: 'self', weight: 3,
    desc: 'You collapse convincingly. Enemies lose interest for 6 turns, or until you do anything interesting.',
    cast: 'You drop to the ground and set an auto-reply.' },
  gate: { id: 'gate', name: 'Gate (Return to Sender)', cost: 8, target: 'self', weight: 2,
    desc: 'Returns you to where you first woke up. Pyramids have no forwarding address.',
    cast: 'The universe misplaces you briefly, then finds you back where you started.' },
};

export const SPELL_IDS = Object.keys(SPELLS);

const d6 = () => 1 + R(6);
const fill = (txt, m) => txt.replace('{m}', m ? m.name : 'void');
const safe = (tag, fn, fallback) => { try { return fn(); } catch (e) { console.error('[spells.' + tag + ']', e); return fallback; } };
const known = id => !!(G.P && G.P.spells && G.P.spells.includes(id));
const clampMp = () => { const P = G.P; P.mp = Math.max(0, Math.min(P.mpMax || 0, Math.round(P.mp) || 0)); };

/** Nothing global is registered: MP growth lives in combat.gainXP, buffs tick via tickSpells. Idempotent. */
export function initSpells() { }

/** Random spell id for a scroll drop, weighted by SPELLS[id].weight. */
export function randomSpell() {
  const total = SPELL_IDS.reduce((a, id) => a + SPELLS[id].weight, 0);
  let r = Math.random() * total;
  for (const id of SPELL_IDS) { r -= SPELLS[id].weight; if (r < 0) return id; }
  return SPELL_IDS[0];
}

/** Spells the hero knows, as SPELLS entries (for the hotbar and journal). */
export function spellList() { return (G.P.spells || []).map(id => SPELLS[id]).filter(Boolean); }

/** Read a scroll. 'learned' | 'known' (refills MP) | 'full' (4 gems: the scroll stays put). */
export function learnSpell(id) {
  return safe('learnSpell', () => {
    const sp = SPELLS[id], P = G.P;
    if (!sp) return 'full';
    if (P.spells.includes(id)) {
      const gain = Math.max(0, P.mpMax - P.mp);
      P.mp = P.mpMax;
      say(`You reread "${sp.name}". Nothing new is learned, but the familiarity is restorative.`, 'good');
      emit('heal', { amount: gain, kind: 'spell' });
      return 'known';
    }
    if (P.spells.length >= MAX_SPELLS) {
      say(`Your head is full. "${sp.name}" will have to wait for someone with a larger head.`);
      return 'full';
    }
    P.spells.push(id);
    if (P.spells.length === 1 && !(P.mpMax > 0)) { P.mpMax = 10 + 2 * (P.lvl - 1); P.mp = P.mpMax; }
    say(`You memorise "${sp.name}". The scroll politely un-exists itself.`, 'good');
    emit('learn', { id });
    return 'learned';
  }, 'full');
}

/** Forget a memorised spell. Max MP stays: motivation, once found, is hard to take back. */
export function forgetSpell(id) {
  const P = G.P, i = P.spells.indexOf(id);
  if (i < 0) return;
  P.spells.splice(i, 1);
  say(`You forget "${SPELLS[id] ? SPELLS[id].name : id}". It was not that important, apparently.`);
}

const live = m => !!m && G.mons.includes(m);

/** Monsters this spell could hit right now, nearest first. [] for self spells. */
export function spellTargets(id) {
  return safe('spellTargets', () => {
    const sp = SPELLS[id];
    if (!sp || sp.target !== 'enemy') return [];
    const P = G.P, r = sp.range || 6;
    return G.mons
      .filter(m => world.isVis(m.x, m.y) && monsters.shown(m) && Math.hypot(m.x - P.x, m.y - P.y) <= r + .3 && world.los(P.x, P.y, m.x, m.y))
      .sort((a, b) => Math.hypot(a.x - P.x, a.y - P.y) - Math.hypot(b.x - P.x, b.y - P.y));
  }, []);
}

const adjacent = () => G.mons.filter(m => monsters.adj(m) && monsters.shown(m));

/** Why spell id cannot be cast right now, or '' if it can. */
export function castBlock(id, target) {
  return safe('castBlock', () => {
    const sp = SPELLS[id], P = G.P;
    if (!sp || !known(id)) return 'You do not know how.';
    if (P.mp < sp.cost) return `Not enough motivation (${sp.cost} MP needed).`;
    if (sp.target === 'enemy') {
      if (target !== undefined && target !== null) {
        if (!live(target)) return 'That target is no longer available.';
        if (Math.hypot(target.x - P.x, target.y - P.y) > (sp.range || 6) + .3) return 'Out of range.';
        if (!world.isVis(target.x, target.y) || !monsters.shown(target)) return 'You cannot see it.';
        if (!world.los(P.x, P.y, target.x, target.y)) return 'No line of sight.';
      } else if (!spellTargets(id).length) return 'No target in sight.';
    }
    if (id === 'paper' && !adjacent().length) return 'Nobody is close enough to be burdened with paperwork.';
    if (id === 'gate' && G.dg) return 'The Gate only works under open sky. Pyramids have no forwarding address.';
    return '';
  }, 'The spell fizzles for administrative reasons.');
}

/** Nearest wrapped image of the home tile in the hero's unwrapped frame. */
function nearestHome() {
  const P = G.P, h = G.home || { x: 0, y: 0 };
  const near = (v, c) => v + WS * Math.round((c - v) / WS);
  return { x: near(h.x, P.x), y: near(h.y, P.y) };
}

function castGate() {
  const P = G.P, from = { x: P.x, y: P.y }, h = nearestHome();
  let to = null;
  for (let r = 0; r <= 6 && !to; r++)
    for (let dy = -r; dy <= r && !to; dy++) for (let dx = -r; dx <= r && !to; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const x = h.x + dx, y = h.y + dy;
      if (world.free(x, y) && !world.isDeep(x, y)) to = { x, y };
    }
  to = to || h;
  P.x = to.x; P.y = to.y;
  for (let i = G.mons.length - 1; i >= 0; i--) if (Math.hypot(G.mons[i].x - P.x, G.mons[i].y - P.y) > 18) G.mons.splice(i, 1);
  if (G.npcs) for (let i = G.npcs.length - 1; i >= 0; i--) if (Math.hypot(G.npcs[i].x - P.x, G.npcs[i].y - P.y) > 18) G.npcs.splice(i, 1);
  world.calcVis();
  emit('moved', { from, to: { x: P.x, y: P.y } });
  return { x: P.x, y: P.y };
}

/** Cast: pay MP, apply the effect, emit('spell'), return true if a turn was spent (the caller calls endTurn). */
export function castSpell(id, target) {
  return safe('castSpell', () => {
    const sp = SPELLS[id], P = G.P;
    if (!sp) return false;
    if (sp.target === 'enemy' && (target === undefined || target === null)) target = spellTargets(id)[0];
    const why = castBlock(id, sp.target === 'enemy' ? target : undefined);
    if (why) { say(why); return false; }
    const from = { x: P.x, y: P.y };
    let to = { x: P.x, y: P.y };
    P.mp = Math.max(0, P.mp - sp.cost);
    const m = sp.target === 'enemy' ? target : null;
    if (m) to = { x: m.x, y: m.y };
    const flat = id === 'gate';  // gate says its line after the jump
    if (!flat) say(fill(sp.cast, m), 'good');

    switch (id) {
      case 'heal': {
        const amt = 8 + 2 * P.lvl + d6(), before = P.hp;
        P.hp = Math.min(P.max, P.hp + amt);
        emit('heal', { amount: P.hp - before, kind: 'spell' });
        break;
      }
      case 'bolt': {
        const d = 4 + P.lvl + d6();
        emit('spell', { id, from, to });
        const died = combat.damageMon(m, d, { kind: 'spell', msg: `The firebolt scorches ${combat.theName(m)} for ${d}.` });
        if (!died && live(m) && Math.random() < .5) { m.burn = 3; say(`${combat.theName(m,1)} is on fire, and handling it badly.`); emit('status', { mon: m, kind: 'burn' }); }
        clampMp();
        return true;
      }
      case 'root':
        m.root = m.boss ? 2 : 4; emit('status', { mon: m, kind: 'root' }); break;
      case 'mez':
        m.mez = m.boss ? 2 : 12; emit('status', { mon: m, kind: 'mez' }); break;
      case 'paper':
        for (const a of adjacent()) { a.stun = 2; emit('status', { mon: a, kind: 'stun' }); }
        emit('status', { mon: null, kind: 'paper' });
        break;
      case 'sow':
        P.buffs.haste = 40; emit('status', { mon: null, kind: 'haste' }); break;
      case 'feign': {
        P.buffs.feign = 6;
        let slept = 0;
        for (const a of G.mons) {
          if (!a.awake || !world.isVis(a.x, a.y)) continue;
          if (a.boss && Math.random() < .5) { say(`${combat.theName(a,1)} is not fooled. It has seen auto-replies before.`, 'bad'); continue; }
          a.awake = false; slept++;
        }
        if (slept) say(slept === 1 ? 'One enemy loses interest and wanders off in spirit.' : `${slept} enemies lose interest and wander off in spirit.`);
        emit('status', { mon: null, kind: 'feign' });
        break;
      }
      case 'gate': {
        to = castGate();
        say(sp.cast, 'good');
        break;
      }
    }
    emit('spell', { id, from, to });
    clampMp();
    return true;
  }, false);
}

/** Per-turn upkeep from turn.endTurn: MP regen and buff timers. */
export function tickSpells(resting) {
  safe('tickSpells', () => {
    const P = G.P;
    if (P.mpMax > 0) {
      const atCamp = !!P.camp && !G.dg && Math.hypot(P.camp.x - P.x, P.camp.y - P.y) <= 2;
      const every = resting ? (atCamp ? 1 : 2) : 4;
      if (G.turn % every === 0 && P.mp < P.mpMax) P.mp++;
      clampMp();
    }
    if (P.buffs.haste > 0 && --P.buffs.haste === 0) { say('The urgency drains away. You remember you have all the time in the world, and none of it.'); emit('status', { mon: null, kind: 'haste' }); }
    if (P.buffs.feign > 0 && --P.buffs.feign === 0) { say('Your auto-reply expires. You are, regrettably, back in the office.'); emit('status', { mon: null, kind: 'feign' }); }
  }, undefined);
}
