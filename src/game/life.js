// game/life.js — OWNED BY: world-life (builder D). v0.3 ambient folk: spawning from 'chunk', cheap wandering,
// proximity barks, and the dialog for every kind in data/folk.js (merchant, rumour-monger, pilgrim, ...).
//
// Ambient NPC (in G.npcs, saved wholesale with them):
//   { id: 'amb:<n>', amb: 1, kind, x, y, name, sub, look, hx, hy (home spot), s (seed int), f: {} (per-person flags),
//     stock?: [potKind...] (merchant), dx?, dy? (pilgrim heading), bk? (turn of last bark) }
// Per-run state: G.run.life = { n (id counter), bark (turn of last bark), met: { kind: count } }.
// Other builders' exports (potions.givePotion, dungeon.nearestSite, ...) land in parallel: every call is guarded.
import { G, say } from '../core/state.js';
import { onSim as on, emit } from '../core/bus.js';
import { WS, POTION_KINDS } from '../core/config.js';
import { R, pick, mod, WK, WI } from '../core/util.js';
import { h2, blocks, isDeep, terr, terrKey, free, isVis, tdist } from '../world/world.js';
import { FOLK, FOLK_BY, FOLK_TUNE as T, FOLK_LINES } from '../data/folk.js';
import { gainXP, theName } from './combat.js';
import * as potions from './potions.js';
import * as dungeon from '../world/dungeon.js';

const CHUNK = 16;
const SALT = 7717;
const SPECIAL = new Set(['pdoor', 'ddoor', 'up', 'down', 'chest']);
const POT_W = { heal: 50, tele: 20, poison: 20, nuke: 10 };
const warned = new Set();

function warnOnce(tag, e) {
  const key = tag + ':' + (e && e.message);
  if (warned.has(key)) return;
  warned.add(key);
  console.error('[life]', tag, e);
}
function safe(tag, fn, fallback) { try { return fn(); } catch (e) { warnOnce(tag, e); return fallback; } }

// ---- state ------------------------------------------------------------------------------------------------------
function st() {
  if (!G.run || typeof G.run !== 'object') G.run = {};
  let L = G.run.life;
  if (!L || typeof L !== 'object') L = G.run.life = { n: 0, bark: -9999, met: {} };
  if (!L.met || typeof L.met !== 'object') L.met = {};
  if (!Number.isFinite(L.n)) L.n = 0;
  if (!Number.isFinite(L.bark)) L.bark = -9999;
  return L;
}
const ambs = () => (Array.isArray(G.npcs) ? G.npcs.filter(n => n && n.amb) : []);
const fill = (s, v) => String(s || '').replace(/\{(\w+)\}/g, (m, k) => (v && v[k] != null ? String(v[k]) : m));
const cheb = (ax, ay, bx, by) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));
const wd = (a, b) => mod(b - a + WS / 2, WS) - WS / 2;               // shortest wrapped delta a -> b
const lvl = () => Math.max(1, (G.P && G.P.lvl) | 0);

/** Pick deterministically from a list with the person's seed (so their greeting is stable across visits). */
const spick = (npc, list, salt = 0) => (Array.isArray(list) && list.length ? list[mod((npc.s | 0) + salt * 7919, list.length)] : '');

/** A walkable, dry tile that is not a door/stairs/chest and holds nobody. */
export function standable(x, y) {
  if (blocks(x, y) || isDeep(x, y)) return false;
  const t = terr(x, y);
  if (t && t.kind === 'liquid') return false;
  const k = terrKey(x, y);
  if (SPECIAL.has(k) || (t && t.dd) || /door\d*$/.test(k)) return false;   // ddoor0..4 are entrances too
  return true;
}
const canStand = (x, y) => standable(x, y) && free(x, y);

// ---- directions -------------------------------------------------------------------------------------------------
const COMPASS = [
  ['east', 'to the right'], ['north-east', 'up and to the right'], ['north', 'up'], ['north-west', 'up and to the left'],
  ['west', 'to the left'], ['south-west', 'down and to the left'], ['south', 'down'], ['south-east', 'down and to the right'],
];
/** Direction words for a world-space delta, in screen terms (the iso view puts world (-1,-1) at screen-up). */
export function dirWords(dx, dy) {
  const sx = dx - dy, sy = dx + dy;                                  // screen right / screen down
  if (!sx && !sy) return 'right here';
  const a = Math.atan2(-sy, sx);
  const i = mod(Math.round(a / (Math.PI / 4)), 8);
  return `${COMPASS[i][0]} (${COMPASS[i][1]})`;
}
function toward(tx, ty) {
  const P = G.P, dx = wd(P.x, tx), dy = wd(P.y, ty);
  return { dir: dirWords(dx, dy), dist: Math.max(Math.abs(dx), Math.abs(dy)), dx, dy };
}

// ---- spawning ---------------------------------------------------------------------------------------------------
const TOTAL_W = FOLK.reduce((s, f) => s + (f.w || 1), 0);
function kindAt(u) {
  let r = u * TOTAL_W;
  for (const f of FOLK) { r -= (f.w || 1); if (r < 0) return f; }
  return FOLK[FOLK.length - 1];
}
function rollPot() {
  const kinds = (Array.isArray(POTION_KINDS) && POTION_KINDS.length ? POTION_KINDS : Object.keys(POT_W));
  const tot = kinds.reduce((s, k) => s + (POT_W[k] || 10), 0);
  let r = Math.random() * tot;
  for (const k of kinds) { r -= (POT_W[k] || 10); if (r < 0) return k; }
  return kinds[0];
}

/** Create one ambient person of `kind` at (x,y). Returns the NPC (already pushed to G.npcs) or null. */
export function spawnFolk(kind, x, y) {
  const d = FOLK_BY[kind];
  if (!d || !Array.isArray(G.npcs) || G.dg) return null;
  const L = st(), s = Math.floor(h2(x, y, SALT + 9) * 1e6) + L.n * 31;
  const npc = {
    id: 'amb:' + (L.n++), amb: 1, kind, x, y, hx: x, hy: y, s,
    name: d.names[mod(s, d.names.length)], sub: d.title, look: d.look, f: {},
  };
  if (kind === 'merchant') { npc.stock = []; for (let i = 0; i < 3 + (s % 2); i++) npc.stock.push(rollPot()); }
  if (kind === 'pilgrim') { const a = (s % 8) * Math.PI / 4; npc.dx = Math.round(Math.cos(a)); npc.dy = Math.round(Math.sin(a)); }
  G.npcs.push(npc);
  return npc;
}

function onChunk(p) {
  if (G.dg || !p || !Array.isArray(G.npcs) || !G.P) return;
  const { cx, cy } = p;
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;
  const wcx = mod(cx, WS / CHUNK), wcy = mod(cy, WS / CHUNK);
  if (h2(wcx, wcy, SALT) >= T.chunkOdds) return;
  const live = ambs();
  if (live.length >= T.cap) return;
  const f = kindAt(h2(wcx, wcy, SALT + 1));
  for (let i = 0; i < 16; i++) {
    const x = cx * CHUNK + Math.floor(h2(wcx * 31 + i, wcy, SALT + 2) * CHUNK);
    const y = cy * CHUNK + Math.floor(h2(wcx, wcy * 31 + i, SALT + 3) * CHUNK);
    if (!canStand(x, y) || G.items.has(WK(x, y))) continue;
    if (live.some(n => cheb(n.x, n.y, x, y) < T.minGap)) return;
    spawnFolk(f.kind, x, y);
    return;
  }
}

// ---- per-turn: forget, wander, bark ----------------------------------------------------------------------------
function autoTarget(n) { const a = G.auto; return !!a && a.npc === n; }

function wander(n) {
  const P = G.P, d = FOLK_BY[n.kind] || {};
  if (cheb(n.x, n.y, P.x, P.y) <= 2 || autoTarget(n)) return;        // they stop to look at you
  if (R(T.wanderOdds)) return;
  let dx, dy;
  if (n.kind === 'pilgrim' && (n.dx || n.dy) && R(3)) { dx = n.dx; dy = n.dy; }
  else if (d.roam && cheb(n.x, n.y, n.hx, n.hy) > d.roam) { dx = Math.sign(n.hx - n.x); dy = Math.sign(n.hy - n.y); }
  else { dx = R(3) - 1; dy = R(3) - 1; }
  if (!dx && !dy) return;
  for (const [a, b] of [[dx, dy], [dx, 0], [0, dy]]) {
    if ((a || b) && canStand(n.x + a, n.y + b)) { n.x += a; n.y += b; return; }
  }
  if (n.kind === 'pilgrim') { n.dx = -n.dx || (R(3) - 1); n.dy = -n.dy || (R(3) - 1); }   // a wall; turn round
}

function bark(n) {
  const L = st(), P = G.P, d = FOLK_BY[n.kind];
  if (!d || G.turn - L.bark < T.barkGap) return false;
  if (Number.isFinite(n.bk) && G.turn - n.bk < T.barkEach) return false;
  if (cheb(n.x, n.y, P.x, P.y) > T.barkR || !isVis(n.x, n.y)) return false;
  if (R(2)) return false;
  L.bark = G.turn; n.bk = G.turn;
  say(fill(pick(d.barks), { name: n.name }));
  return true;
}

function onTurn() {
  if (G.dg || !Array.isArray(G.npcs) || !G.P) return;
  const P = G.P;
  for (let i = G.npcs.length - 1; i >= 0; i--) {
    const n = G.npcs[i];
    if (!n || !n.amb) continue;
    if (Math.abs(n.x - P.x) >= T.forget || Math.abs(n.y - P.y) >= T.forget) { G.npcs.splice(i, 1); continue; }
    if (Math.abs(n.x - P.x) > T.wanderR || Math.abs(n.y - P.y) > T.wanderR) continue;
    safe('wander', () => wander(n));
  }
  let barked = false;
  for (const n of G.npcs) if (n && n.amb && !barked) barked = safe('bark', () => bark(n), false);
}

let wired = false;
/** Subscribe to the bus. Called once by main.js; safe to call again. */
export function initLife() {
  if (wired) return;
  wired = true;
  on('chunk', p => safe('chunk', () => onChunk(p)));
  on('turn', () => safe('turn', onTurn));
  on('newgame', () => safe('newgame', st));
  on('loaded', () => safe('loaded', () => {
    st();
    const lists = [G.npcs, G.P && G.P.ow && G.P.ow.npcs];
    for (const list of lists) if (Array.isArray(list)) for (const n of list) if (n && n.amb && (!n.f || typeof n.f !== 'object')) n.f = {};
  }));
}

// ---- dialog helpers ---------------------------------------------------------------------------------------------
const bye = (primary) => ({ id: 'bye', label: FOLK_LINES.bye, ...(primary ? { primary: true } : {}) });
const act = (id, label, primary) => ({ id, label, ...(primary ? { primary: true } : {}) });
const view = (npc, text, actions) => {
  const d = FOLK_BY[npc.kind] || {};
  const acts = actions.slice();
  if (!acts.some(a => a.primary) && acts.length) acts[0] = { ...acts[0], primary: true };
  return { npc, name: d.title ? `${npc.name}, ${d.title}` : (npc.name || 'Somebody'), text, actions: acts };
};
const flags = npc => (npc.f && typeof npc.f === 'object' ? npc.f : (npc.f = {}));
const goldOk = n => (G.P.gold | 0) >= n;
function spend(n) { G.P.gold = Math.max(0, (G.P.gold | 0) - n); }
function earn(n) { if (n > 0) { G.P.gold = (G.P.gold | 0) + n; say(`Received: ${n} gold.`, 'loot'); } }
function healBy(n) {
  const P = G.P, before = P.hp;
  P.hp = Math.min(P.max, P.hp + Math.max(0, n | 0));
  const got = P.hp - before;
  if (got > 0) emit('heal', { amount: got, kind: 'folk' });
  return got;
}

// potions (builder C), defensively
const hasGive = () => typeof potions.givePotion === 'function';
function potLabel(pot) {
  try { if (typeof potions.potName === 'function') { const s = potions.potName(pot); if (s) return String(s); } } catch (e) { warnOnce('potName', e); }
  try { const c = G.run && G.run.pot && G.run.pot.colors && G.run.pot.colors[pot]; if (c && c.name) return c.name + ' potion'; } catch (e) { /* fall through */ }
  return 'Unlabelled potion';
}
const colorName = pot => potLabel(pot).replace(/ potion$/i, '');
function known(pot) {
  try { if (typeof potions.isKnown === 'function') return !!potions.isKnown(pot); } catch (e) { warnOnce('isKnown', e); }
  const k = G.run && G.run.pot && G.run.pot.known;
  return Array.isArray(k) && k.includes(pot);
}
function give(pot, n = 1) {
  if (!hasGive()) return false;
  try { potions.givePotion(pot, n); return true; } catch (e) { warnOnce('givePotion', e); return false; }
}
function identify(pot) {
  try { if (typeof potions.identify === 'function') { potions.identify(pot, 'appraise'); return true; } } catch (e) { warnOnce('identify', e); }
  const R0 = G.run && G.run.pot;
  if (!R0 || !Array.isArray(R0.known)) return false;
  if (!R0.known.includes(pot)) { R0.known.push(pot); emit('potion', { pot, by: 'appraise', first: true }); }
  return true;
}
const heldUnknown = () => {
  const pots = G.P && G.P.pots;
  if (!pots || typeof pots !== 'object') return [];
  return Object.keys(pots).filter(k => (pots[k] | 0) > 0 && !known(k));
};

// prices scale gently with level
const PRICE = {
  potion: () => 12 + 3 * lvl(),
  appraise: () => 6 + 2 * lvl(),
  kit: npc => 20 + 4 * lvl() + 10 * ((flags(npc).kits | 0)),
  survey: () => 8 + 2 * lvl(),
  song: () => 3 + lvl(),
  session: () => 10 + 3 * lvl(),
};

// ---- per-kind dialog -------------------------------------------------------------------------------------------
// Each handler: menu(npc, d) -> model; do(npc, d, id) -> model | null. Text lives in data/folk.js.
const K = {};

K.merchant = {
  menu(npc, d, text) {
    const acts = [];
    if (!hasGive()) return view(npc, (text ? text + ' ' : '') + d.noStock, [act('appraise', `Appraise a bottle (${PRICE.appraise()} gold)`), bye()]);
    const stock = Array.isArray(npc.stock) ? npc.stock : (npc.stock = []);
    const counts = {};
    for (const k of stock) counts[k] = (counts[k] | 0) + 1;
    for (const k of Object.keys(counts)) acts.push(act('buy:' + k, `Buy ${potLabel(k)} (${PRICE.potion()} gold) ×${counts[k]}`));
    acts.push(act('appraise', `Appraise a bottle (${PRICE.appraise()} gold)`));
    acts.push(bye());
    return view(npc, text || (stock.length ? d.browse : d.soldout), acts);
  },
  do(npc, d, id) {
    if (id.startsWith('buy:')) {
      const pot = id.slice(4), stock = npc.stock || [], i = stock.indexOf(pot), cost = PRICE.potion();
      if (i < 0) return this.menu(npc, d, d.soldout);
      if (!goldOk(cost)) return this.menu(npc, d, fill(d.poor, { k: cost - (G.P.gold | 0) }));
      if (!give(pot, 1)) return this.menu(npc, d, d.noStock);
      spend(cost); stock.splice(i, 1);
      say(`You buy ${/^[aeiou]/i.test(potLabel(pot)) ? 'an' : 'a'} ${potLabel(pot)} from ${npc.name} for ${cost} gold.`, 'loot');
      return this.menu(npc, d, spick(npc, d.bought, G.turn + stock.length) + (stock.length ? '' : ' ' + d.soldout));
    }
    if (id === 'appraise') {
      const list = heldUnknown(), cost = PRICE.appraise();
      if (!list.length) return this.menu(npc, d, d.appraiseNone);
      return view(npc, fill(d.appraiseAsk, { cost }),
        [...list.map(k => act('ident:' + k, `The ${colorName(k)} one (${cost} gold)`)), act('back', 'Never mind')]);
    }
    if (id.startsWith('ident:')) {
      const pot = id.slice(6), cost = PRICE.appraise();
      if (!heldUnknown().includes(pot)) return this.menu(npc, d, d.appraiseNone);
      if (!goldOk(cost)) return this.menu(npc, d, fill(d.poor, { k: cost - (G.P.gold | 0) }));
      const color = colorName(pot);
      if (!identify(pot)) return this.menu(npc, d, d.noStock);
      spend(cost);
      say(`${npc.name} identifies the ${color} potion. It is ${/^[aeiou]/i.test(potLabel(pot)) ? 'an' : 'a'} ${potLabel(pot)}.`, 'good');
      return this.menu(npc, d, fill(d.appraised, { color, kind: (d.kinds && d.kinds[pot]) || pot }));
    }
    return this.menu(npc, d);
  },
};

/** The rumour-monger's line about a site from dungeon.nearestSite() (or the no-site line for null). */
export function rumourLine(npc, s) {
  const d = FOLK_BY.gossip;
  if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.y)) return d.noSite;
  const t = toward(s.x, s.y);
  const quip = (Number.isInteger(s.biome) && d.quips[s.biome]) || d.quipAny;
  const line = fill(spick(npc || {}, d.site, (s.x + s.y) | 0),
    { dir: t.dir, dist: Math.max(5, Math.round(t.dist / 5) * 5), site: s.name || 'somewhere nobody has named', quip });
  return s.entered ? line + ' ' + d.entered : line;
}

K.gossip = {
  menu(npc, d, text) { return view(npc, text || spick(npc, d.greet), [act('rumour', 'Heard anything?', true), act('more', 'Anything else?'), bye()]); },
  do(npc, d, id) {
    if (id === 'rumour') {
      let s = null;
      if (typeof dungeon.nearestSite === 'function') s = safe('nearestSite', () => dungeon.nearestSite(G.P.x, G.P.y, 120), null);
      return this.menu(npc, d, rumourLine(npc, s));
    }
    if (id === 'more') {
      const f = flags(npc); f.more = (f.more | 0) + 1;
      return this.menu(npc, d, spick(npc, d.more, f.more));
    }
    return this.menu(npc, d);
  },
};

K.pilgrim = {
  menu(npc, d, text) { return view(npc, text || spick(npc, d.greet), [act('bless', 'Walk with them a while', true), act('whither', 'Where are you headed?'), bye()]); },
  do(npc, d, id) {
    if (id === 'whither') return this.menu(npc, d, d.whither);
    if (id === 'bless') {
      const f = flags(npc), P = G.P;
      if (f.bless) return this.menu(npc, d, d.blessed);
      if (P.hp >= P.max) return this.menu(npc, d, d.blessFull);
      f.bless = 1;
      const got = healBy(Math.max(5, Math.round(P.max * 0.35)));
      say(`The pilgrims' company restores ${got} HP. Nobody can explain it, least of all the pilgrims.`, 'good');
      return this.menu(npc, d, d.bless);
    }
    return this.menu(npc, d);
  },
};

K.tourist = {
  menu(npc, d, text) { return view(npc, text || spick(npc, d.greet), [act('directions', 'Give them directions', true), act('home', 'Which way is home?'), bye()]); },
  do(npc, d, id) {
    if (id === 'directions') {
      const f = flags(npc);
      if (f.tip) return this.menu(npc, d, d.tipped);
      f.tip = 1;
      const n = 1 + R(4) + Math.floor(lvl() / 2);
      earn(n);
      return this.menu(npc, d, fill(d.directions, { n }));
    }
    if (id === 'home') {
      const h = G.home || { x: 0, y: 0 }, t = toward(h.x, h.y);
      if (t.dist <= 6) return this.menu(npc, d, d.atHome);
      return this.menu(npc, d, fill(d.home, { dir: t.dir, dist: Math.max(5, Math.round(t.dist / 5) * 5) }));
    }
    return this.menu(npc, d);
  },
};

K.mlm = {
  menu(npc, d, text) {
    return view(npc, text || spick(npc, d.greet),
      [act('pitch', 'Tell me about the opportunity', true), act('kit', `Buy the starter kit (${PRICE.kit(npc)} gold)`), act('upline', 'Who is above you?'), bye()]);
  },
  do(npc, d, id) {
    if (id === 'pitch') return this.menu(npc, d, fill(d.pitch, { cost: PRICE.kit(npc) }));
    if (id === 'upline') return this.menu(npc, d, d.upline);
    if (id === 'kit') {
      const cost = PRICE.kit(npc);
      if (!hasGive()) return this.menu(npc, d, d.noStock);
      if (!goldOk(cost)) return this.menu(npc, d, fill(d.poor, { k: cost - (G.P.gold | 0) }));
      const pot = rollPot();
      if (!give(pot, 1)) return this.menu(npc, d, d.noStock);
      spend(cost);
      const f = flags(npc); f.kits = (f.kits | 0) + 1;
      say(`You buy a starter kit for ${cost} gold. It contains one ${potLabel(pot)} and a sense of obligation.`, 'loot');
      return this.menu(npc, d, d.kit);
    }
    return this.menu(npc, d);
  },
};

K.surveyor = {
  menu(npc, d, text) { return view(npc, text || spick(npc, d.greet), [act('distance', 'How far have I come?', true), act('survey', `See the survey (${PRICE.survey()} gold)`), bye()]); },
  do(npc, d, id) {
    if (id === 'distance') {
      const dd = Math.round(tdist(G.P.x, G.P.y)), far = Math.round(WS * 0.68);
      return this.menu(npc, d, fill(d.distance, { d: dd, far, farNote: G.P.far ? d.farYes : d.farNo }));
    }
    if (id === 'survey') {
      const cost = PRICE.survey();
      if (!goldOk(cost)) return this.menu(npc, d, fill(d.poor, { cost, k: cost - (G.P.gold | 0) }));
      if (G.dg || !(G.seen instanceof Uint8Array) || G.seen.length !== WS * WS) return this.menu(npc, d, d.farNo);
      spend(cost);
      const r = 24, P = G.P;
      for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r) G.seen[WI(P.x + x, P.y + y)] = 1;
      say(`You pay ${cost} gold for a look at the survey. The map fills in around you.`, 'good');
      return this.menu(npc, d, d.surveyed);
    }
    return this.menu(npc, d);
  },
};

K.hermit = {
  menu(npc, d, text) { return view(npc, text || spick(npc, d.greet), [act('sit', 'Sit with them in silence', true), act('wisdom', 'Ask for wisdom'), bye()]); },
  do(npc, d, id) {
    if (id === 'wisdom') {
      const f = flags(npc);
      if (f.wise) return this.menu(npc, d, spick(npc, d.greet, 2));
      f.wise = 1;
      return this.menu(npc, d, spick(npc, d.wisdom, G.turn));
    }
    if (id === 'sit') {
      const f = flags(npc), P = G.P;
      if (f.sat) return this.menu(npc, d, d.sat);
      if (P.hp >= P.max) return this.menu(npc, d, d.sitFull);
      f.sat = 1;
      const got = healBy(P.max);
      say(`The silence restores ${got} HP. It is the most restful thing that has happened to you.`, 'good');
      return this.menu(npc, d, d.sit);
    }
    return this.menu(npc, d);
  },
};

K.flat = {
  menu(npc, d, text) { return view(npc, text || spick(npc, d.greet), [act('pamphlet', 'Accept a pamphlet', true), act('argue', 'Point out the planet is round'), bye()]); },
  do(npc, d, id) {
    if (id === 'pamphlet') {
      const f = flags(npc); f.p = (f.p | 0) + 1;
      const t = spick(npc, d.pamphlets, f.p);
      say(`You receive a pamphlet: "${t}". You keep it for reasons you cannot articulate.`);
      return this.menu(npc, d, fill(d.pamphlet, { t }));
    }
    if (id === 'argue') {
      const f = flags(npc);
      if (f.argued) return this.menu(npc, d, d.argued);
      f.argued = 1;
      safe('xp', () => gainXP(3 + 2 * lvl()));
      return this.menu(npc, d, d.argue);
    }
    return this.menu(npc, d);
  },
};

K.influencer = {
  menu(npc, d, text) { return view(npc, text || spick(npc, d.greet), [act('cameo', 'Appear in the background', true), act('smoothie', 'What is in the smoothie?'), bye()]); },
  do(npc, d, id) {
    if (id === 'smoothie') return this.menu(npc, d, d.smoothie);
    if (id === 'cameo') {
      const f = flags(npc);
      if (f.cameo) return this.menu(npc, d, d.cameoDone);
      f.cameo = 1;
      const n = 4 + R(5) + lvl();
      earn(n);
      return this.menu(npc, d, fill(d.cameo, { n }));
    }
    return this.menu(npc, d);
  },
};

K.ghost = {
  menu(npc, d, text) { return view(npc, text || spick(npc, d.greet), [act('cause', 'How did you die?', true), act('after', 'What is the afterlife like?'), bye()]); },
  do(npc, d, id) {
    if (id === 'after') { const f = flags(npc); f.a = (f.a | 0) + 1; return this.menu(npc, d, spick(npc, d.after, f.a)); }
    if (id === 'cause') {
      const P = G.P;
      let best = null;
      for (const m of G.mons || []) {
        if (!m || !(m.hp > 0) || m.ai === 'swim' || cheb(m.x, m.y, P.x, P.y) > 30) continue;
        const score = (m.lvl || 0) + (m.boss ? 100 : 0) + (m.rare ? 50 : 0);
        if (!best || score > best.score) best = { m, score };
      }
      if (!best) return this.menu(npc, d, d.causeNone);
      const t = toward(best.m.x, best.m.y);
      return this.menu(npc, d, fill(d.cause, { mon: theName(best.m), dir: t.dir, dist: Math.max(1, t.dist) }));
    }
    return this.menu(npc, d);
  },
};

K.busker = {
  menu(npc, d, text) { return view(npc, text || spick(npc, d.greet), [act('song', `Request a song (${PRICE.song()} gold)`, true), act('stop', 'Ask them to stop'), bye()]); },
  do(npc, d, id) {
    if (id === 'stop') return this.menu(npc, d, d.stop);
    if (id === 'song') {
      const cost = PRICE.song();
      if (!goldOk(cost)) return this.menu(npc, d, fill(d.poor, { cost, k: cost - (G.P.gold | 0) }));
      spend(cost);
      const P = G.P;
      if (!P.buffs || typeof P.buffs !== 'object') P.buffs = { haste: 0, feign: 0 };
      P.buffs.haste = Math.max(P.buffs.haste | 0, 20);
      emit('status', { mon: null, kind: 'haste' });
      say(`You tip ${npc.name} ${cost} gold. You are hasted, mostly to get away from the song.`, 'good');
      return this.menu(npc, d, d.song);
    }
    return this.menu(npc, d);
  },
};

K.coach = {
  menu(npc, d, text) { return view(npc, text || spick(npc, d.greet), [act('session', `Book a session (${PRICE.session()} gold)`, true), bye()]); },
  do(npc, d, id) {
    if (id === 'session') {
      const P = G.P, cost = PRICE.session();
      if (!(P.mpMax > 0)) return this.menu(npc, d, d.noMp);
      if (P.mp >= P.mpMax) return this.menu(npc, d, d.fullMp);
      if (!goldOk(cost)) return this.menu(npc, d, fill(d.poor, { cost, k: cost - (G.P.gold | 0) }));
      spend(cost);
      P.mp = P.mpMax;
      emit('heal', { amount: 0, kind: 'mp' });
      say(`You pay ${npc.name} ${cost} gold. Motivation restored.`, 'good');
      return this.menu(npc, d, d.session);
    }
    return this.menu(npc, d);
  },
};

K.courier = {
  menu(npc, d, text) { return view(npc, text || spick(npc, d.greet), [act('parcel', flags(npc).done ? 'Any more parcels?' : 'Is that parcel for me?', true), bye()]); },
  do(npc, d, id) {
    if (id === 'parcel') {
      const f = flags(npc);
      if (f.done) return this.menu(npc, d, d.delivered);
      f.done = 1;
      if (hasGive() && R(2) === 0) {
        const pot = rollPot();
        if (give(pot, 1)) { say(`The parcel holds ${/^[aeiou]/i.test(potLabel(pot)) ? 'an' : 'a'} ${potLabel(pot)}.`, 'loot'); return this.menu(npc, d, d.parcelPot); }
      }
      const n = 8 + R(12) + 2 * lvl();
      earn(n);
      return this.menu(npc, d, fill(d.parcelGold, { n }));
    }
    return this.menu(npc, d);
  },
};

K.assessor = {
  tax: () => Math.ceil((G.P.gold | 0) * 0.1) + ((G.P.gold | 0) > 0 ? 1 : 0),
  menu(npc, d, text) {
    if (flags(npc).paid) return view(npc, text || d.done, [bye(true)]);
    return view(npc, text || spick(npc, d.greet), [act('assess', 'What do I owe?', true), bye()]);
  },
  do(npc, d, id) {
    const f = flags(npc);
    if (f.paid) return this.menu(npc, d, d.done);
    if (id === 'assess') {
      const tax = Math.min(G.P.gold | 0, this.tax());
      if (tax <= 0) return view(npc, d.nothing, [bye(true)]);
      return view(npc, fill(d.assess, { tax }), [act('pay', `Pay ${tax} gold`, true), act('dispute', 'Dispute the assessment'), bye()]);
    }
    if (id === 'pay') {
      const tax = Math.min(G.P.gold | 0, this.tax());
      if (tax <= 0) return view(npc, d.nothing, [bye(true)]);
      spend(tax); f.paid = 1;
      say(`You pay ${tax} gold in planetary tax. A receipt is issued, to the planet.`, 'loot');
      safe('xp', () => gainXP(tax * 2 + lvl()));
      return this.menu(npc, d, d.paid);
    }
    if (id === 'dispute') { return view(npc, d.dispute, [bye(true)]); }
    return this.menu(npc, d);
  },
};

// ---- public dialog API (routed here by ui/panels.js for npc.amb) ----------------------------------------------
/** Dialog model for an ambient NPC (npc.amb), same shape as quests.dialog(); null = fall back to quests.dialog. */
export function dialog(npc) {
  return safe('dialog', () => {
    if (!npc || !npc.amb) return null;
    const d = FOLK_BY[npc.kind], h = K[npc.kind];
    if (!d || !h) return view(npc, FOLK_LINES.busy, [bye(true)]);
    const f = flags(npc);
    if (!f.met) {
      f.met = 1;
      const L = st(); L.met[npc.kind] = (L.met[npc.kind] | 0) + 1;
    }
    return h.menu(npc, d);
  }, npc ? { npc, name: npc.name || 'Somebody', text: '...', actions: [bye(true)] } : null);
}

/** Handle a dialog action for an ambient NPC; returns the next model or null to close. */
export function choose(npc, actionId) {
  return safe('choose', () => {
    if (!npc || !npc.amb || !actionId || actionId === 'bye') return null;
    const d = FOLK_BY[npc.kind], h = K[npc.kind];
    if (!d || !h) return null;
    if (actionId === 'back') return h.menu(npc, d);
    return h.do(npc, d, String(actionId));
  }, null);
}

/** For tests / tools: the kinds this module knows how to talk for. */
export const FOLK_KINDS = FOLK.map(f => f.kind).filter(k => K[k]);
