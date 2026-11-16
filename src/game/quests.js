// game/quests.js — friendly quest-givers ("Hail!"), satirical missions, and Phil's insurance. OWNED BY: builder B.
// v0.3: the people live in data/npcs.js (NPC_POOL) and the missions in data/missions.js (MISSIONS). Each life deals
// NPCS_PER_RUN givers (Brenda + Phil always) and 1–3 missions to each, so no two runs ask for the same things.
//
// Per-run state (plain JSON, saved wholesale):
//   G.run.npcs     = [npcId, ...]                     this life's quest-givers
//   G.run.missions = { npcId: [missionId, ...] }      offered in order; the next one unlocks when one is turned in
// Quest state (format kept from v0.2 so old saves load):
//   G.quests.active = [{ id: missionId, npc, have, n, ready?, b?, base?, to?, seen? }]   G.quests.done = [missionId]
//   G.quests.npcs[npcId] = 'new' | 'active' | 'done'   G.quests.cells = placement memo   G.quests.met = { npcId: {x,y} }
// Ambient folk (npc.amb, World Life) are never touched here.
import { G, say } from '../core/state.js';
import { emit, on } from '../core/bus.js';
import { WS, ZONE, BAG, BIOMES, NPCS_PER_RUN } from '../core/config.js';
import { R, pick, mod, WK, hash2 } from '../core/util.js';
import { blocks, isDeep, terr, free, calcVis, biome } from '../world/world.js';
import { DENIALS, CLAIM_APPROVED } from '../data/flavor.js';
import { NPC_POOL, NPC_BY_ID } from '../data/npcs.js';
import { MISSIONS, MISSION_BY_ID } from '../data/missions.js';
import { gainXP } from './combat.js';
import { WEAPONS, MATERIALS, SLOTS, QUALITIES, EPITHETS, rollQ, gearItem, scrollItem } from './loot.js';
import * as loot from './loot.js';
import * as potions from './potions.js';
import { SPELLS, learnSpell } from './spells.js';

export { NPC_POOL, MISSIONS };
/** Ambient-folk sprite ids drawn in art/creatures.js (kept here too so the art pipeline lists them; no art import in game code). */
const FOLK_LOOK_IDS = ['folk-merchant', 'folk-gossip', 'folk-pilgrim', 'folk-tourist', 'folk-mlm', 'folk-surveyor', 'folk-hermit', 'folk-flat', 'folk-influencer', 'folk-ghost', 'folk-busker', 'folk-coach', 'folk-courier', 'folk-assessor'];

// ---- NPC table (compat view) ----------------------------------------------------------------------------------
/** id -> NPC definition. Each entry also has a live `quest` getter: the mission this giver is currently on or
 *  offering this run (or undefined), so older UI code reading `NPCS[id].quest.title` keeps working. */
export const NPCS = {};
for (const d of NPC_POOL) {
  const w = { ...d };
  Object.defineProperty(w, 'quest', { enumerable: false, get: () => { try { return currentMission(d.id) || undefined; } catch (e) { return undefined; } } });
  NPCS[d.id] = w;
}
/** NPC sprite ids for the art pipeline (every pool NPC, whether or not it is dealt this run). */
export const NPC_IDS = [...new Set(NPC_POOL.map(n => 'npc/' + (n.look || n.id)).concat(FOLK_LOOK_IDS.map(k => 'npc/' + k)))];

// ---- constants and small helpers ------------------------------------------------------------------------------
const CHUNK = 16;
const CELL_ODDS = 0.55;                        // share of zone cells that hold a stranger
const INSURANCE_ODDS = 0.35;
const QUEST_SALT = 0x51d;                      // hash seed salt for NPC placement
const DEAL_SALT = 0x5eed;
const CLASSIC = ['dennis', 'crystal', 'marguerite', 'gary', 'intern', 'clerk'];
const POLL = new Set(['hoard', 'level', 'travel', 'walk', 'potion', 'far']);

/** Connective lines (plain administrative absurdity). */
const LINES = {
  ready: 'Everything required appears to have been done. Please present yourself for the reward, which the paperwork calls "consideration".',
  closed: 'That matter is closed. There is nothing further on file, and I have checked twice.',
  again: 'There is, regrettably, something else.',
  short: 'You are {k} gold short. {who} regards your empty hands with professional interest.',
  already: 'You have, it turns out, already done this. ',
  nowhere: 'somewhere out there. Nobody has written down where, which is how most things are kept',
  bye: 'Leave',
};

const fill = (s, o) => {
  const t = String(s || '').replace(/\{(\w+)\}/g, (_, k) => (o && o[k] != null ? o[k] : '{' + k + '}'));
  return t.charAt(0).toUpperCase() + t.slice(1);
};
const qs = () => {
  const q = G.quests || (G.quests = { active: [], done: [], npcs: {} });
  if (!Array.isArray(q.active)) q.active = [];
  if (!Array.isArray(q.done)) q.done = [];
  if (!q.npcs || typeof q.npcs !== 'object') q.npcs = {};
  if (!q.cells || typeof q.cells !== 'object') q.cells = {};
  if (!q.met || typeof q.met !== 'object') q.met = {};
  return q;
};
const defOf = id => NPCS[id] || null;
const missionDef = id => MISSION_BY_ID[id] || null;
const questDef = missionDef;
const entryOf = npcId => qs().active.find(e => e.npc === npcId) || null;
const safe = (tag, fn, fallback) => { try { return fn(); } catch (e) { console.error('[quests.' + tag + ']', e); return fallback; } };
const shortName = id => { const d = NPC_BY_ID[id]; return d ? d.short || d.name.split(/[,(]/)[0].trim() : 'somebody'; };
const fnOf = (mod, name) => (mod && typeof mod[name] === 'function' ? mod[name] : null);

// ---- per-run deal ----------------------------------------------------------------------------------------------
function rngFrom(seed) {
  let a = (seed >>> 0) || 1;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function shuffle(a, rnd) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

/** Build { npcs, missions } for this life. compat: an older save — keep the classic eight and their first quests. */
export function dealRun(seed, compat = false, mustHave = []) {
  const rnd = rngFrom(((seed | 0) ^ DEAL_SALT) + (compat ? 7 : 0));
  const pool = NPC_POOL.map(n => n.id).filter(id => id !== 'brenda' && id !== 'phil');
  let ids = ['brenda', 'phil'];
  if (compat) ids = ids.concat(CLASSIC.filter(id => NPC_BY_ID[id]));
  for (const id of mustHave) if (NPC_BY_ID[id] && !ids.includes(id)) ids.push(id);
  for (const id of shuffle(pool.filter(id => !ids.includes(id)), rnd)) { if (ids.length >= NPCS_PER_RUN) break; ids.push(id); }

  const used = new Set(), missions = {}, want = {};
  for (const id of ids) {
    const own = MISSIONS.filter(m => m.by && m.by.includes(id));
    const firsts = own.filter(m => m.first), rest = shuffle(own.filter(m => !m.first), rnd);
    const k = id === 'brenda' ? 2 + Math.floor(rnd() * 2) : id === 'phil' ? 1 + Math.floor(rnd() * 2) : 1 + Math.floor(rnd() * 3);
    let list = firsts.concat(rest).slice(0, k);
    if (list.length > 1 && id !== 'brenda' && rnd() < 0.35) list.pop();      // leave room for a relayed notice
    missions[id] = list.map(m => m.id);
    list.forEach(m => used.add(m.id));
    want[id] = k;
  }
  const open = shuffle(MISSIONS.filter(m => !m.by && !used.has(m.id)), rnd);
  for (const id of ids) {
    while (missions[id].length < want[id] && open.length) { const m = open.pop(); missions[id].push(m.id); used.add(m.id); }
    if (!missions[id].length && open.length) missions[id].push(open.pop().id);
  }
  return { npcs: ids, missions };
}

/** Make sure G.run.npcs / G.run.missions exist and are consistent with the quest log. Cheap when they do. */
export function ensureRun() {
  if (!G.run || typeof G.run !== 'object') G.run = {};
  const run = G.run, Q = qs();
  const okRun = Array.isArray(run.npcs) && run.npcs.length && run.missions && typeof run.missions === 'object';
  if (!okRun) {
    const placed = (G.npcs || []).filter(n => n && !n.amb && NPC_BY_ID[n.id]).map(n => n.id);
    const activeNpcs = Q.active.map(e => e.npc).filter(id => NPC_BY_ID[id]);
    const compat = !!(Q.active.length || Q.done.length || Object.keys(Q.cells).length || placed.length);
    const d = dealRun(G.seed | 0, compat, [...new Set([...activeNpcs, ...placed])]);
    run.npcs = d.npcs; run.missions = d.missions;
  }
  // repair: drop unknown entries; every active mission belongs to its giver's list
  Q.active = Q.active.filter(e => e && missionDef(e.id) && NPC_BY_ID[e.npc]);
  for (const e of Q.active) {
    if (!run.npcs.includes(e.npc)) run.npcs.push(e.npc);
    const l = run.missions[e.npc] || (run.missions[e.npc] = []);
    if (!l.includes(e.id)) l.unshift(e.id);
  }
  return run;
}

const runNpcs = () => ensureRun().npcs;
const missionsOf = id => (ensureRun().missions[id] || []);
const isRunNpc = id => runNpcs().includes(id);
/** The next mission this giver will offer (not active, not done), or null. */
function nextMission(id) {
  const Q = qs();
  for (const mid of missionsOf(id)) if (!Q.done.includes(mid) && !Q.active.some(e => e.id === mid) && missionDef(mid)) return missionDef(mid);
  return null;
}
/** Active mission def for a giver, else the one they would offer next. */
function currentMission(id) {
  const e = entryOf(id);
  return e ? missionDef(e.id) : nextMission(id);
}
const doneCount = id => { const Q = qs(); return missionsOf(id).filter(m => Q.done.includes(m)).length; };

// ---- text context -------------------------------------------------------------------------------------------------
const DIRS = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];

/** Where is giver `id`, roughly, from the hero ("north-east, about 40 paces away")? */
function whereText(id) {
  const Q = qs(), P = G.P;
  const me = G.dg && P.ow ? { x: P.ow.x, y: P.ow.y } : { x: P.x, y: P.y };
  let best = null, bd = 1e9;
  const consider = (x, y) => { const dx = nearestImage(x, me.x) - me.x, dy = nearestImage(y, me.y) - me.y, d = Math.max(Math.abs(dx), Math.abs(dy)); if (d < bd) { bd = d; best = { dx, dy }; } };
  if (!G.dg) for (const n of G.npcs || []) if (n && !n.amb && n.id === id) consider(n.x, n.y);
  const m = Q.met[id]; if (m) consider(m.x, m.y);
  if (!best) return LINES.nowhere;
  if (bd <= 2) return 'right here, more or less';
  const a = Math.atan2(best.dy, best.dx), dir = DIRS[mod(Math.round(a / (Math.PI / 4)), 8)];
  const paces = bd < 20 ? bd : Math.round(bd / 10) * 10;
  return `${G.dg ? 'out on the surface, ' : ''}${dir} of here, about ${paces} paces`;
}

function ctxOf(m, e, giver) {
  return {
    have: e ? e.have : 0, n: e ? e.n : needOf(m), gold: m.gold, cost: m.gold, name: shortName(giver),
    to: e && e.to ? shortName(e.to) : 'somebody', where: e && e.to ? whereText(e.to) : LINES.nowhere,
    biome: m.biome != null && BIOMES[m.biome] ? BIOMES[m.biome] : 'wilds',
  };
}

/** How much "have" a mission needs. */
function needOf(m) {
  switch (m.type) {
    case 'pay': case 'hoard': return m.gold | 0 || 1;
    case 'far': case 'travel': case 'deliver': return 1;
    default: return Math.max(1, m.n | 0 || 1);
  }
}

/** Plain row describing one active entry, for events and the journal. */
function row(e) {
  const q = missionDef(e.id) || {}, d = defOf(e.npc) || {};
  const text = e.ready ? `Done. Return to ${shortName(e.npc)} for your reward.` : fill(q.progress || q.ask, ctxOf(q, e, e.npc));
  return { id: e.id, npc: e.npc, giver: d.name || e.npc, title: q.title || e.id, text, have: e.have, n: e.n, ready: !!e.ready, type: q.type, to: e.to || null };
}

/** "30 XP, 200 gold, a Plain Straight Sword" for dialog text. */
function rewardLine(r) {
  const bits = [];
  if (r.xp) bits.push(`${r.xp} XP`);
  if (r.gold) bits.push(`${r.gold} gold`);
  if (r.gear) {
    const g = r.gear, q = g.q ? g.q + ' ' : '';
    const sl = g.slot && SLOTS.find(s => s.slot === g.slot);
    bits.push(g.type ? `a ${q}${g.type}` : g.kind === 'wep' ? `a ${q}weapon` : g.kind === 'arm' ? (sl ? `a ${q}${sl.noun.toLowerCase()}` : `${g.q ? 'a ' + g.q : 'an'} piece of armour`) : `a ${q}item of unspecified use`);
  }
  if (r.scroll) bits.push(`a scroll (${(SPELLS[r.scroll] && SPELLS[r.scroll].name) || r.scroll})`);
  if (r.potion) bits.push(potionLabel(r.potion.pot, r.potion.n || 1));
  return bits.length ? ' [Reward: ' + bits.join(', ') + '.]' : '';
}
function potionLabel(pot, n) {
  const nm = safe('potName', () => { const f = fnOf(potions, 'potName') || fnOf(loot, 'potName'); return f ? f(pot) : null; }, null);
  const what = nm ? String(nm).replace(/\s*potions?$/i, '') : 'unlabelled';
  return n > 1 ? `${n} ${what} potions` : `${/^[aeiou]/i.test(what) ? 'an' : 'a'} ${what} potion`;
}

// ---- reward gear (genGear with the quest's constraints applied) ------------------------------------------------
/** Build a gear object from {kind?, type?, slot?, q?}; anything unspecified is rolled. Mirrors loot.genGear's formulas. */
function questGear(spec, lvl) {
  spec = spec || {};
  lvl = Math.max(1, lvl | 0);
  let q = spec.q && QUALITIES.find(x => x.name === spec.q);
  q = q ? { ...q } : rollQ(lvl, false);
  if (q.name === 'Legendary' && !q.epithet) q.epithet = pick(EPITHETS);
  const epi = q.epithet ? ' ' + q.epithet : '';
  const kind = spec.kind || (spec.type ? 'wep' : spec.slot ? 'arm' : R(100) < 55 ? 'wep' : 'arm');
  if (kind === 'wep') {
    const t = WEAPONS.find(w => w.type === spec.type) || pick(WEAPONS), s = 1 + lvl * .12;
    return { kind: 'wep', type: t.type, name: `${q.name} ${t.type}${epi}`, q: q.name,
      min: Math.max(1, Math.round(t.min * q.mult * s)), max: Math.max(1, Math.round(t.max * q.mult * s)),
      tags: t.tags.slice(), chop: t.chop, mine: t.mine, col: q.col };
  }
  const m = pick(MATERIALS.filter(x => x.tier <= 1 + Math.floor(lvl / 3))), sl = SLOTS.find(x => x.slot === spec.slot) || pick(SLOTS);
  return { kind: 'arm', slot: sl.slot, mat: m.name, prop: m.prop, heavy: !!m.heavy,
    name: `${q.name === 'Plain' ? '' : q.name + ' '}${m.name} ${sl.noun}${epi}`, q: q.name,
    def: Math.max(1, Math.round(m.def * sl.mult * q.mult * (1 + lvl * .06))), col: q.col };
}

/** Put a ground item on the hero's tile, or the nearest empty one within two tiles. False if nothing fits. */
function dropNear(item) {
  const P = G.P;
  for (let r = 0; r <= 2; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
    const x = P.x + dx, y = P.y + dy;
    if (blocks(x, y) || isDeep(x, y) || G.items.has(WK(x, y))) continue;
    G.items.set(WK(x, y), item);
    emit('drop', { x, y, item });
    return true;
  }
  return false;
}

function grantGear(g) {
  const P = G.P;
  if (P.inv.length < BAG) {
    P.inv.push(g);
    say(`Received: ${g.name}.`, 'loot');
    emit('pickup', { item: gearItem(g) });
  } else if (dropNear(gearItem(g))) {
    say(`Your bag is full, so the ${g.name} is placed on the ground, where possessions go to be reconsidered.`, 'loot');
  } else {
    say(`There is nowhere to put the ${g.name}. It returns to the paperwork.`);
  }
}

function grantScroll(id) {
  if (!SPELLS[id]) return;
  const res = learnSpell(id);
  if (res === 'full' && !dropNear(scrollItem(id))) say('The scroll finds no room in your head or on the floor, and leaves.');
  else if (res === 'full') say('Your head is full, so the scroll waits on the ground. Forget a spell in the Journal first.');
}

function grantPotion(pot, n) {
  n = Math.max(1, n | 0);
  const give = fnOf(potions, 'givePotion');
  if (give) { give(pot, n); say(`Received: ${potionLabel(pot, n)}.`, 'loot'); return; }
  const mk = fnOf(loot, 'potionItem');                        // potions not landed yet: leave them on the ground
  let k = 0;
  for (let i = 0; i < n && mk; i++) if (dropNear(mk(pot))) k++;
  if (k) say(`${k > 1 ? 'Some potions are' : 'A potion is'} set down beside you, carefully, by someone who will not say what is in ${k > 1 ? 'them' : 'it'}.`, 'loot');
}

function grantRewards(r) {
  const P = G.P;
  if (r.gold) { P.gold += r.gold; say(`Received: ${r.gold} gold.`, 'loot'); }
  if (r.gear) grantGear(questGear(r.gear, Math.max(1, P.lvl)));
  if (r.scroll) grantScroll(r.scroll);
  if (r.potion) safe('potionReward', () => grantPotion(r.potion.pot, r.potion.n || 1));
  if (r.xp) gainXP(r.xp);
}

// ---- mission progress ----------------------------------------------------------------------------------------
/** Set progress. Counts only go up unless `down` (hoard: what you carry now). Marks ready at n. */
function advance(e, have, down = false) {
  if (e.ready) return;
  const v = Math.max(0, Math.min(e.n, down ? have : Math.max(e.have, have)));
  if (v === e.have) return;
  e.have = v;
  if (e.have >= e.n) {
    e.ready = true;
    const r = row(e);
    say(`Quest ready: "${r.title}". Return to ${shortName(e.npc)} for your reward.`, 'good');
    emit('quest', { kind: 'ready', quest: r });
  } else {
    emit('quest', { kind: 'progress', quest: row(e) });
  }
}

const each = (type, fn) => {
  for (const e of qs().active.slice()) {
    const q = missionDef(e.id);
    if (q && q.type === type && !e.ready) safe('advance', () => fn(e, q));
  }
};

function knownPotions() {
  const pot = G.run && G.run.pot;
  return pot && Array.isArray(pot.known) ? pot.known.length : null;
}

/** State-based mission types: recompute from the hero's current state. */
function poll(e, q) {
  const P = G.P;
  switch (q.type) {
    case 'hoard': advance(e, P.gold | 0, true); break;
    case 'level': advance(e, P.lvl | 0); break;
    case 'walk': advance(e, (P.steps | 0) - (e.base | 0)); break;
    case 'travel': if (!G.dg && biome(P.x, P.y) === q.biome) advance(e, e.n); break;
    case 'far': if (P.far) advance(e, e.n); break;
    case 'potion': { const k = knownPotions(); if (k != null) advance(e, k); break; }
  }
}
const pollAll = () => { for (const e of qs().active) { if (e.ready) continue; const q = missionDef(e.id); if (q && POLL.has(q.type)) safe('poll', () => poll(e, q)); } };

let wired = false;
/** Subscribe to the game's events and advance active missions. Safe to call repeatedly. */
export function initQuests() {
  if (wired) return;
  wired = true;
  on('newgame', () => safe('newgame', ensureRun));
  on('loaded', () => safe('loaded', ensureRun));
  on('kill', ({ mon } = {}) => {
    each('kill', (e, q) => {
      if (q.biome === 'here' && (G.dg || !mon || mon.b !== e.b)) return;
      if (typeof q.biome === 'number' && (!mon || mon.b !== q.biome)) return;
      if (q.where === 'dungeon' && !G.dg) return;
      advance(e, e.have + 1);
    });
    if (mon && mon.boss) each('boss', e => advance(e, e.have + 1));
    if (mon && mon.rare) each('rare', e => advance(e, e.have + 1));
  });
  on('chest', (p = {}) => each('chest', (e, q) => { if (typeof q.biome === 'number' && p && p.b != null && p.b !== q.biome) return; advance(e, e.have + 1); }));
  on('far', () => each('far', e => advance(e, e.n)));
  on('dex', () => each('dex', e => advance(e, G.dex.size - (e.base || 0))));
  on('dungeon', (p = {}) => {
    if (!p) return;
    if (p.kind === 'enter') each('enter', (e, q) => {
      if (typeof q.biome === 'number' && p.b !== q.biome) return;
      const key = String((G.dg && G.dg.k) || `${p.name}|${p.dtype}`);
      if (!Array.isArray(e.seen)) e.seen = [];
      if (e.seen.includes(key)) return;
      e.seen.push(key);
      advance(e, e.seen.length);
    });
    if (p.kind === 'clear') each('dclear', (e, q) => {
      if (typeof q.biome === 'number' && p.b !== q.biome) return;
      if (q.dtype && p.dtype !== q.dtype) return;
      advance(e, e.have + 1);
    });
  });
  on('potion', (p = {}) => {
    if (!p) return;
    if (p.by === 'throw') each('throw', e => advance(e, e.have + 1));
    each('potion', e => { const k = knownPotions(); advance(e, k != null ? k : e.have + (p.first ? 1 : 0)); });
  });
  on('nuke', (p = {}) => each('nuke', e => advance(e, (p && p.kills) | 0)));
  on('teleport', () => each('tele', e => advance(e, e.have + 1)));
  on('camp', (p) => {
    if (!p) return;                                     // null = camp lost
    each('camp', (e, q) => { if (typeof q.biome === 'number' && biome(p.x, p.y) !== q.biome) return; advance(e, e.have + 1); });
  });
  on('spell', (p = {}) => {
    const id = p && p.id;
    each('spell', (e, q) => { if (q.spell && q.spell !== id) return; advance(e, e.have + 1); });
    if (id === 'gate') each('tele', e => advance(e, e.have + 1));
  });
  on('learn', () => each('learn', e => advance(e, e.have + 1)));
  on('levelup', pollAll);
  on('turn', pollAll);
}

// ---- placing NPCs ------------------------------------------------------------------------------------------------
/** Wrapped tile -> unwrapped tile inside chunk (cx,cy), the chunk the caller is populating. */
const inChunk = (cx, cy, wxv, wyv) => ({ x: cx * CHUNK + mod(wxv, CHUNK), y: cy * CHUNK + mod(wyv, CHUNK) });
const chunkOf = v => mod(Math.floor(mod(v, WS) / CHUNK), WS / CHUNK);
const standable = (x, y) => { const t = terr(x, y); return !blocks(x, y) && !isDeep(x, y) && t.kind !== 'liquid' && !t.dd && t.key !== 'pdoor'; };   // never on a dungeon entrance

/** Nearest free standable tile to (x,y) within r tiles, or null. */
function nearestFree(x, y, r) {
  for (let k = 0; k <= r; k++) for (let dy = -k; dy <= k; dy++) for (let dx = -k; dx <= k; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== k) continue;
    if (standable(x + dx, y + dy) && free(x + dx, y + dy)) return { x: x + dx, y: y + dy };
  }
  return null;
}

function put(id, x, y) {
  const d = defOf(id);
  if (!d || G.npcs.some(n => n && !n.amb && n.id === id && Math.abs(n.x - x) < 8 && Math.abs(n.y - y) < 8)) return false;
  G.npcs.push({ id, x, y, name: d.name });
  qs().met[id] = { x, y };
  return true;
}

/** A once-per-life fixture at a hash-chosen point `rad` tiles from home (Brenda at 7, Phil at 15). */
function fixture(id, rad, salt, cx, cy, wcx, wcy) {
  const Q = qs();
  if (Q.cells[id] || !G.home || !isRunNpc(id)) return;
  const a = hash2(rad, salt, (G.seed | 0) + QUEST_SALT) * Math.PI * 2;
  const bx = G.home.x + Math.round(Math.cos(a) * rad), by = G.home.y + Math.round(Math.sin(a) * rad);
  if (chunkOf(bx) !== wcx || chunkOf(by) !== wcy) return;
  const p = inChunk(cx, cy, bx, by), t = nearestFree(p.x, p.y, 4);
  if (t && put(id, t.x, t.y)) Q.cells[id] = 1;
}

/** Called by monsters.spawnAround for each newly populated 16-tile chunk (cx, cy are chunk indices).
 *  Brenda and Phil: once per life, near home. This run's other givers: at most one per 64-tile zone cell. */
export function spawnNPCs(cx, cy) {
  safe('spawnNPCs', () => {
    if (G.dg || !Array.isArray(G.npcs)) return;
    const Q = qs(), s = G.seed | 0, wcx = mod(cx, WS / CHUNK), wcy = mod(cy, WS / CHUNK);
    ensureRun();
    if (Q.cells.brenda == null || Q.cells.brenda === 0) fixture('brenda', 7, 7, cx, cy, wcx, wcy);
    fixture('phil', 15, 15, cx, cy, wcx, wcy);

    // Strangers: this chunk lies wholly inside one zone cell (cells are offset by half a zone; chunks divide 32).
    const zx = Math.floor(mod(cx * CHUNK + ZONE / 2, WS) / ZONE), zy = Math.floor(mod(cy * CHUNK + ZONE / 2, WS) / ZONE);
    if (!zx && !zy) return;                                       // the home cell belongs to Brenda (and Phil)
    const key = zx + ',' + zy;
    if (Q.cells[key] != null) return;
    if (hash2(zx, zy, s + QUEST_SALT + 1) >= CELL_ODDS) return;   // decided here only if the cell has a stranger
    const givers = runNpcs().filter(id => id !== 'brenda' && NPC_BY_ID[id]);
    if (!givers.length) return;
    const id = givers[Math.floor(hash2(zx, zy, s + QUEST_SALT + 2) * givers.length) % givers.length];
    let spot = null;
    for (let i = 0; i < 48 && !spot; i++) {
      const wxv = zx * ZONE - ZONE / 2 + Math.floor(hash2(zx * 64 + i, zy, s + QUEST_SALT + 3) * ZONE);
      const wyv = zy * ZONE - ZONE / 2 + Math.floor(hash2(zx, zy * 64 + i, s + QUEST_SALT + 4) * ZONE);
      if (standable(wxv, wyv)) spot = { x: wxv, y: wyv };
    }
    if (!spot) { Q.cells[key] = 0; return; }
    if (chunkOf(spot.x) !== wcx || chunkOf(spot.y) !== wcy) return;   // not this chunk's turn
    const p = inChunk(cx, cy, spot.x, spot.y), t = nearestFree(p.x, p.y, 3);
    Q.cells[key] = t && put(id, t.x, t.y) ? 1 : 0;
  });
}

// ---- dialog ------------------------------------------------------------------------------------------------------
const view = (npc, text, actions) => ({ npc, name: npc.name || (defOf(npc.id) || {}).name || 'Stranger', text, actions });
const bye = (primary) => ({ id: 'bye', label: LINES.bye, ...(primary ? { primary: true } : {}) });
const askAct = (label, primary = true) => ({ id: 'ask', label, ...(primary ? { primary: true } : {}) });

/** Deliveries addressed to this NPC: mark them done and return what the recipient says (or ''). */
function receive(npc) {
  let said = '';
  for (const e of qs().active.slice()) {
    if (e.ready || e.to !== npc.id) continue;
    const q = missionDef(e.id);
    if (!q || q.type !== 'deliver') continue;
    advance(e, e.n);
    said += (said ? ' ' : '') + fill(q.recv || 'Oh. Right. Thank you. I suppose.', ctxOf(q, e, e.npc));
  }
  return said;
}

/** The mission part of a giver's dialog: { text, actions } (text may be ''). */
function missionPart(npc, d, opening) {
  const e = entryOf(d.id);
  if (e) {
    const q = missionDef(e.id);
    if (e.ready) return { text: LINES.ready, actions: [{ id: 'turnin', label: 'Claim reward', primary: true }] };
    const text = fill(q.progress, ctxOf(q, e, d.id));
    if (q.type === 'pay') return { text, actions: [{ id: 'pay', label: `Pay ${q.gold} gold`, primary: true }] };
    return { text, actions: [] };
  }
  const m = isRunNpc(d.id) ? nextMission(d.id) : null;
  if (m) return { text: opening, actions: [askAct(d.adjuster ? 'Anything else?' : 'What do you need?')] };
  if (isRunNpc(d.id) && missionsOf(d.id).length && doneCount(d.id)) return { text: (d.lines && d.lines.closed) || LINES.closed, actions: [], closed: true };
  return { text: opening, actions: [] };
}

/** Dialog model for the UI when the player hails an NPC. */
export function dialog(npc) {
  return safe('dialog', () => {
    if (npc && npc.amb) return null;                                  // ambient folk belong to World Life
    const d = npc && defOf(npc.id);
    if (!d) return view(npc || {}, '...', [bye(true)]);
    ensureRun();
    const recv = receive(npc);
    if (recv) return view(npc, recv, [{ id: 'back', label: 'Continue', primary: true }, bye()]);
    const opening = doneCount(d.id) ? ((d.lines && d.lines.again) || LINES.again) : d.greet;
    if (d.adjuster) {
      const head = G.P.insured ? `${d.greet} ${d.have}` : `${d.greet} ${fill(d.offer, { cost: policyCost() })}`;
      const buy = { id: 'buy', label: `Buy a policy (${policyCost()} gold)` };
      const mp = missionPart(npc, d, head);
      if (entryOf(d.id)) {                                              // on a job for Phil: talk shop first
        const acts = mp.actions.slice();
        if (!G.P.insured) acts.push(buy);
        acts.push(bye(!acts.some(a => a.primary)));
        return view(npc, mp.text, acts);
      }
      const acts = [];
      if (!G.P.insured) acts.push({ ...buy, primary: true });
      for (const a of mp.actions) acts.push({ ...a, primary: !!G.P.insured });
      acts.push(bye(!acts.some(a => a.primary)));
      return view(npc, head, acts);
    }
    const mp = missionPart(npc, d, opening);
    return view(npc, mp.text || d.greet, [...mp.actions, bye(!mp.actions.some(a => a.primary))]);
  }, { npc, name: (npc && npc.name) || '', text: '...', actions: [bye(true)] });
}

/** Pick a delivery recipient: another of this run's givers, preferably one somebody has already seen. */
function pickRecipient(from) {
  const Q = qs(), all = runNpcs().filter(id => id !== from && NPC_BY_ID[id]);
  const met = all.filter(id => Q.met[id]);
  return pick(met.length ? met : all) || null;
}

function accept(npc, d) {
  const Q = qs();
  if (entryOf(d.id)) return dialog(npc);
  const q = nextMission(d.id);
  if (!q) return dialog(npc);
  const P = G.P, e = { id: q.id, npc: d.id, have: 0, n: needOf(q) };
  if (q.type === 'kill' && q.biome === 'here') e.b = biome(P.x, P.y);
  if (q.type === 'dex') e.base = G.dex.size;
  if (q.type === 'walk') e.base = P.steps | 0;
  if (q.type === 'enter') e.seen = [];
  if (q.type === 'deliver') {
    const o = Q.offer && Q.offer[d.id];
    e.to = o && o !== d.id && NPC_BY_ID[o] ? o : pickRecipient(d.id);
    if (Q.offer) delete Q.offer[d.id];
  }
  Q.active.push(e);
  Q.npcs[d.id] = 'active';
  say(`Quest accepted: "${q.title}".`, 'good');
  emit('quest', { kind: 'accept', quest: row(e) });
  if (POLL.has(q.type)) safe('poll', () => poll(e, q));
  if (q.type === 'deliver' && !e.to) advance(e, e.n);               // nobody to deliver to: the letter delivers itself
  if (e.ready) return view(npc, LINES.already + LINES.ready, [{ id: 'turnin', label: 'Claim reward', primary: true }, bye()]);
  const text = fill(q.progress, ctxOf(q, e, d.id));
  if (q.type === 'pay') return view(npc, text, [{ id: 'pay', label: `Pay ${q.gold} gold`, primary: true }, bye()]);
  return view(npc, text, [bye(true)]);
}

function turnIn(npc, d) {
  const Q = qs(), e = entryOf(d.id), q = e && missionDef(e.id);
  if (!q || !e || !e.ready) return dialog(npc);
  Q.active.splice(Q.active.indexOf(e), 1);
  if (!Q.done.includes(q.id)) Q.done.push(q.id);
  const next = nextMission(d.id);
  Q.npcs[d.id] = next ? 'new' : 'done';
  say(`Quest complete: "${q.title}".`, 'good');
  grantRewards(q.reward || {});
  emit('quest', { kind: 'done', quest: { id: q.id, npc: d.id, giver: d.name, title: q.title, text: q.done, have: e.n, n: e.n, ready: false, type: q.type } });
  return view(npc, fill(q.done, ctxOf(q, e, d.id)), next ? [askAct('Anything else?', false), bye(true)] : [bye(true)]);
}

/** Perform a dialog action. Returns the next dialog model, or null to close. */
export function choose(npc, actionId) {
  return safe('choose', () => {
    if (npc && npc.amb) return null;
    const d = npc && defOf(npc.id);
    if (!d || actionId === 'bye') return null;
    if (actionId === 'back') return dialog(npc);
    if (actionId === 'buy') {
      if (!d.adjuster) return dialog(npc);
      const P = G.P, cost = policyCost();
      if (P.insured) return view(npc, d.have, [bye(true)]);
      if (P.gold < cost) return view(npc, d.poor, [{ id: 'back', label: 'Back' }, bye(true)]);
      P.gold -= cost; P.insured = 1;
      say(`You pay ${cost} gold for a policy. It is a very small piece of paper.`, 'good');
      emit('heal', { amount: 0, kind: 'policy' });
      const more = nextMission(d.id) && !entryOf(d.id);
      return view(npc, d.sold, more ? [askAct('Anything else?', false), bye(true)] : [bye(true)]);
    }
    if (actionId === 'ask') {
      if (entryOf(d.id)) return dialog(npc);
      const q = nextMission(d.id);
      if (!q) return dialog(npc);
      const Q = qs();
      if (!Q.offer || typeof Q.offer !== 'object') Q.offer = {};
      if (q.type === 'deliver') Q.offer[d.id] = pickRecipient(d.id);
      return view(npc, fill(q.ask, ctxOf(q, { have: 0, n: needOf(q), to: Q.offer[d.id] || null }, d.id)) + rewardLine(q.reward || {}),
        [{ id: 'accept', label: `Accept: ${q.title}`, primary: true }, { id: 'back', label: 'Not now' }]);
    }
    if (actionId === 'accept') return accept(npc, d);
    if (actionId === 'turnin') return turnIn(npc, d);
    if (actionId === 'pay') {
      const e = entryOf(d.id), q = e && missionDef(e.id), P = G.P;
      if (!e || !q || q.type !== 'pay') return dialog(npc);
      if (P.gold < q.gold) {
        return view(npc, fill(LINES.short, { k: q.gold - P.gold, who: shortName(d.id) }) + ' ' + fill(q.progress, ctxOf(q, e, d.id)),
          [{ id: 'pay', label: `Pay ${q.gold} gold`, primary: true }, bye()]);
      }
      P.gold -= q.gold;
      say(`You hand over ${q.gold} gold. A receipt is promised, in time.`, 'loot');
      e.have = e.n; e.ready = true;
      emit('quest', { kind: 'ready', quest: row(e) });
      return turnIn(npc, d);
    }
    return dialog(npc);
  }, null);
}

/** Journal rows: active quests with progress, plus completed quests. */
export function questLog() {
  return safe('questLog', () => {
    const Q = qs(), run = ensureRun();
    const giverOf = id => { for (const k in run.missions) if (run.missions[k].includes(id)) return k; const m = missionDef(id); return (m && m.by && m.by[0]) || ''; };
    return {
      active: Q.active.map(row),
      done: Q.done.map(id => {
        const q = missionDef(id), g = giverOf(id), d = NPC_BY_ID[g] || {};
        return { id, npc: g, giver: d.name || '', title: q ? q.title : id, text: q ? fill(q.done, ctxOf(q, null, g)) : '', have: 1, n: 1, ready: false };
      }),
    };
  }, { active: [], done: [] });
}

/** This run's givers with their dealt missions (for tests, the journal and anyone curious). */
export function runInfo() {
  return safe('runInfo', () => { const r = ensureRun(); return { npcs: r.npcs.slice(), missions: JSON.parse(JSON.stringify(r.missions)) }; }, { npcs: [], missions: {} });
}

/** Price of Phil's policy right now: 100 + 50 * level. */
export const policyCost = () => 100 + 50 * G.P.lvl;

// ---- insurance --------------------------------------------------------------------------------------------------
const nearestImage = (v, ref) => ref + mod(v - ref + WS / 2, WS) - WS / 2;

/** Leave a pyramid in place (dungeon.js owns the normal exit; this is the claim-adjuster's shortcut). */
function leavePyramid() {
  const P = G.P, ow = P.ow;
  if (!G.dg || !ow) return;
  G.dg = null;
  G.mons = ow.mons || []; G.items = ow.items || new Map(); G.npcs = ow.npcs || [];
  G.seen = ow.seen || new Uint8Array(WS * WS); G.seenW = WS; G.vis = new Uint8Array(G.seen.length);
  P.x = ow.x; P.y = ow.y; P.ow = null;
  emit('floor', { dg: null, i: -1 });
}

/** On death: null if uninsured; else the policy is consumed and { paid, text } is returned.
 *  35% paid: revive at camp (or home) with half HP, no gold. Denied: a reason from flavor.DENIALS. */
export function resolveInsurance(by) {
  return safe('resolveInsurance', () => {
    const P = G.P;
    if (!P.insured) return null;
    P.insured = 0;
    const killer = (by && by.name) || 'something unrecorded';
    if (Math.random() < INSURANCE_ODDS) {
      const from = { x: P.x, y: P.y };
      leavePyramid();
      const c = P.camp, dest = c ? { x: c.x, y: c.y } : { x: nearestImage(G.home.x, P.x), y: nearestImage(G.home.y, P.y) };
      const t = standable(dest.x, dest.y) ? dest : nearestFree(dest.x, dest.y, 6) || dest;
      P.x = t.x; P.y = t.y;
      P.hp = Math.max(1, Math.ceil(P.max / 2)); P.gold = 0; P.poison = 0; P.slowed = 0;
      G.auto = null;
      calcVis();
      emit('moved', { from, to: { x: P.x, y: P.y } });
      emit('claim', { paid: true, text: CLAIM_APPROVED });
      return { paid: true, text: CLAIM_APPROVED };
    }
    const text = fill(pick(DENIALS), { killer });
    emit('claim', { paid: false, text });
    return { paid: false, text };
  }, null);
}
