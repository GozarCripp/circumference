// game/combat.js — OWNER: Foreman B / combat worker. Contract: docs/ARCHITECTURE.md §8.B4, §9.2, §9.7.
// Port of classic inRange / attack / hitOne / kill / hurt / gainXP / die / threat with identical numbers, odds and
// log strings, plus the damageMon funnel, con() and insurance on death.
// Layering: game/ never imports render/, ui/, audio/ — everything visible goes out through the event bus.
import { G, say } from '../core/state.js';
import { emit } from '../core/bus.js';
import { CON } from '../core/config.js';
import { R, pick } from '../core/util.js';
import { HITS, DEATHS, CON_TEXT } from '../data/flavor.js';
import { los, locName, zoneAt } from '../world/world.js';
import { defense, pieces, dropLoot } from './loot.js';
import { resolveInsurance } from './quests.js';

/** "the Ogre" / "The Ogre"; names already starting with "The " are not doubled. cap=true capitalises. */
export function theName(m, cap) {
  const n = (typeof m === 'string' ? m : m && m.name) || 'something';
  const bare = /^the /i.test(n);
  const rest = bare ? n.slice(4) : n;
  return (cap ? 'The ' : 'the ') + rest;
}

const tagsOf = w => (w && Array.isArray(w.tags)) ? w.tags : [];
const isInt = n => Number.isFinite(n);
const alive = m => !!m && G.mons.includes(m);
const touching = m => Math.abs(m.x - G.P.x) <= 1 && Math.abs(m.y - G.P.y) <= 1;

/** Can the hero's weapon reach monster m right now? (melee 1, 'reach' 2 with LOS, 'ranged' 6 with LOS) */
export function inRange(m) {
  const P = G.P, t = tagsOf(P.wep);
  const d = Math.max(Math.abs(m.x - P.x), Math.abs(m.y - P.y));
  return t.includes('ranged') ? d <= 6 && los(P.x, P.y, m.x, m.y)
    : t.includes('reach') ? d <= 2 && los(P.x, P.y, m.x, m.y)
      : d <= 1;
}

/** Player attacks m with the equipped weapon (cleave / multi / slow tags as classic). Does not end the turn. */
export function attack(m) {
  try {
    if (!alive(m) || m.hp <= 0) return;
    const P = G.P, w = P.wep, tags = tagsOf(w);
    if (P.buffs && P.buffs.feign) P.buffs.feign = 0;              // swinging a weapon ends feign death
    const targets = tags.includes('cleave') ? G.mons.filter(touching) : [];
    if (!targets.includes(m)) targets.push(m);
    const n = tags.includes('multi') ? 2 : 1;
    for (const t of targets) for (let i = 0; i < n; i++) if (alive(t)) hitOne(t, w);
    if (tags.includes('slow')) P.slowed = 1;
  } catch (e) { console.error('[combat.attack]', e); }
}

/** One weapon strike (classic hitOne): damage roll, crit, status tags, log line. */
function hitOne(m, w) {
  const P = G.P, tags = tagsOf(w);
  let d = (w.min | 0) + R(((w.max | 0) - (w.min | 0)) + 1) + Math.floor(P.lvl / 2);
  const crit = Math.random() < (tags.includes('crit') ? .25 : .07);
  if (crit) d = Math.round(d * 1.8);
  m.awake = m.seen = true;
  if (tags.includes('bleed') && R(3) === 0) { m.bleed = 3; emit('status', { mon: m, kind: 'bleed' }); }
  if (tags.includes('burn') && R(3) === 0) { m.burn = 3; emit('status', { mon: m, kind: 'burn' }); }
  if (tags.includes('stun') && R(4) === 0) { m.stun = 1; emit('status', { mon: m, kind: 'stun' }); }
  const kind = tags.includes('ranged') ? 'ranged' : 'melee';
  damageMon(m, d, {
    kind, crit,
    msg: `You ${pick(HITS)} ${theName(m)} for ${Math.max(1, Math.round(d))}${crit ? '. A critical hit, which it takes personally' : ''}.`,
  });
}

/** Deal d damage to monster m from any source. opts: {kind, silent, crit, msg}. Emits 'hit'; kills at 0 HP.
 *  The one funnel for all damage to monsters. Returns true if it died. */
export function damageMon(m, d, opts = {}) {
  try {
    if (!alive(m)) return false;
    const kind = opts.kind || 'spell';
    d = Math.max(1, Math.round(isInt(d) ? d : 1));
    m.hp -= d;
    m.mez = 0;                                                    // damage breaks mesmerize
    if (kind !== 'bleed' && kind !== 'burn') m.awake = m.seen = true;
    emit('hit', { mon: m, x: m.x, y: m.y, dmg: d, crit: !!opts.crit, kind });
    if (m.hp <= 0) { kill(m); return true; }
    if (!opts.silent) {
      let line = opts.msg;
      if (!line) {
        line = kind === 'bleed' ? `${theName(m,1)} bleeds for ${d}.`
          : kind === 'burn' ? `${theName(m,1)} burns for ${d}.`
            : kind === 'dog' ? `A dog bites ${theName(m)} for ${d}.`
              : `${theName(m,1)} takes ${d} damage.`;
      }
      say(line);
    }
    return false;
  } catch (e) { console.error('[combat.damageMon]', e); return false; }
}

/** Remove m, log the death line, grant XP, roll loot, update the kill count. Quests hear emit('kill'). */
export function kill(m) {
  try {
    const i = G.mons.indexOf(m);
    if (i < 0) return;
    G.mons.splice(i, 1);
    if (m.hp > 0) m.hp = 0;
    say(`${theName(m,1)} ${pick(DEATHS)}. (+${m.xp} XP)`);
    G.P.kills = (G.P.kills || 0) + 1;
    if (m.name && !m.dboss && !G.dex.has(m.name)) { G.dex.add(m.name); emit('dex', { name: m.name, count: G.dex.size }); }   // normally added on sight (named dungeon bosses are not species)
    gainXP(m.xp);
    try { dropLoot(m); } catch (e) { console.error('[combat.dropLoot]', e); }
    emit('kill', { mon: m });
  } catch (e) { console.error('[combat.kill]', e); }
}

/** Monster m (or a pseudo-source {name, col}) hurts the hero for d before defence. kind: 'melee'|'range'|'burn'|'poison'|'drown'. */
export function hurt(m, d, msg, kind) {
  try {
    const P = G.P;
    if (G.over) return;
    const pc = pieces();
    if (G.auto) G.auto.hurt = true;
    const name = (m && m.name) || 'something';
    const physical = kind !== 'burn' && kind !== 'poison' && kind !== 'drown';
    if (physical && Math.random() < (pc.ghost || 0) * .08) {
      say(`${theName(name,1)}'s attack passes through your ghostly armor. It seems offended.`);
      emit('miss', { x: P.x, y: P.y, why: 'ghost' });
      return;
    }
    if (kind === 'burn' && (pc.obsidian || 0) >= 2) {
      say('Your obsidian armor declines the fire.');
      emit('miss', { x: P.x, y: P.y, why: 'obsidian' });
      return;
    }
    const df = defense();
    d = Math.max(1, Math.round((isInt(d) ? d : 1) * (1 - df / (df + 15))));
    P.hp -= d;
    say(`${msg} -${d}`, 'bad');
    emit('hurt', { by: m, dmg: d, kind: kind || 'melee', x: P.x, y: P.y });
    if (P.hp <= 0) { die(m); return; }
    if (kind === 'melee' && alive(m)) {
      if (Math.random() < (pc.dog || 0) * .12) {
        const b = 2 + R(3 + P.lvl);
        say(`A dog emerges from your armor and bites ${theName(m)} for ${b}. Nobody asks where it was.`);
        damageMon(m, b, { kind: 'dog', silent: true });
      } else if (Math.random() < (pc.bureau || 0) * .07) {
        m.stun = 1;
        say(`${theName(m,1)} stops to fill out Form 27-B in triplicate.`);
        emit('status', { mon: m, kind: 'paper' });
      }
    }
  } catch (e) { console.error('[combat.hurt]', e); }
}

/** Add XP; level up while xp >= next (classic: next *= 1.45, +5 max HP, full heal; +2 max MP once spells are known). */
export function gainXP(x) {
  try {
    const P = G.P;
    P.xp += isInt(x) ? x : 0;
    while (P.xp >= P.next && P.next > 0) {
      P.xp -= P.next; P.lvl++;
      P.next = Math.round(P.next * 1.45);
      P.max += 5;
      const healed = P.max - P.hp;
      P.hp = P.max;
      if (P.spells && P.spells.length > 0) { P.mpMax += 2; P.mp = Math.min(P.mpMax, P.mp + 2); }
      say(`LEVEL ${P.lvl}. You are now marginally more qualified to die.`, 'good');
      emit('levelup', { lvl: P.lvl });
      emit('heal', { amount: healed, kind: 'level' });
    }
  } catch (e) { console.error('[combat.gainXP]', e); }
}

/** The hero dies, killed by `by` ({name, col}). A paid insurance claim revives instead; otherwise G.over = true and 'death' fires. */
export function die(by) {
  try {
    const P = G.P;
    if (G.over) return;
    const who = by || { name: 'Something Unrecorded', col: '#ffffff' };
    let claim = null;
    try { claim = resolveInsurance(who); } catch (e) { console.error('[combat.insurance]', e); }
    if (claim && claim.paid) {
      if (!(P.hp > 0)) P.hp = Math.max(1, Math.ceil(P.max / 2));
      if (claim.text) say(claim.text, 'good');
      return;
    }
    G.over = true; P.hp = 0; G.auto = null;
    emit('auto', { auto: null });
    let place = 'wilderness';
    try { place = G.dg ? locName() : ((zoneAt(P.x, P.y) || {}).name || 'wilderness'); } catch (e) { /* keep default */ }
    say(`Slain by ${who.name} in ${place}.`, 'bad');
    if (claim && claim.text) say(claim.text, 'bad');
    emit('death', { by: who, claim: claim ? { paid: false, text: claim.text || '' } : null });
  } catch (e) { console.error('[combat.die]', e); G.over = true; }
}

/** Raw classic threat ratio: how long you take to kill it vs how much of your HP it takes from you. */
export function threat(m) {
  const P = G.P, df = defense();
  const avg = (P.wep.min + P.wep.max) / 2 + P.lvl / 2;
  return (m.hp / avg) * Math.max(.5, m.atk / 2 * (1 - df / (df + 15))) / Math.max(1, P.hp);
}

/** EverQuest-style consider. Returns { i: 0..5, color: CON[i], text } from the classic threat ratio. */
export function con(m) {
  let r = 1;
  try { r = threat(m); } catch (e) { /* fall through to a fair fight */ }
  const i = r < .15 ? 0 : r < .35 ? 1 : r < .6 ? 2 : r < .9 ? 3 : r < 1.4 ? 4 : 5;
  let text = typeof CON_TEXT === 'function' ? CON_TEXT(i, m) : CON_TEXT[i];
  if (typeof text !== 'string') text = '';
  return { i, color: CON[i], text };
}
