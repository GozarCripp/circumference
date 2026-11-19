// net/net.js — MULTIPLAYER rooms. One browser (the HOST) runs the whole world; everyone else is a CLIENT that mirrors
// what their own hero can see and sends their actions (game/verbs.js) to the host.
//
//   join:     a room code (or ?room=CODE in the link). Nobody answers within a few seconds -> you host it.
//   host:     runs turn.worldTick on the clock; after every tick sends each client a 'view' of their hero's
//             surroundings plus the events their hero caused; every 5 s sends everyone a full 'snap' of the world.
//   client:   applies views to a mirror of G (bus.setMirror: simulation listeners stay quiet), sends verbs.
//   handover: the host vanishes -> the next player in join order rebuilds the world from their latest snap and hosts;
//             everyone sees the "hang in there!" screen meanwhile.
//   dropouts: a hero whose player disconnects collapses where they stand, untouchable, for up to 5 minutes; the same
//             browser rejoining (same per-room key) picks them back up.
import { G, say } from '../core/state.js';
import { on, emit, setMirror } from '../core/bus.js';
import { WS } from '../core/config.js';
import { wx } from '../core/util.js';
import * as turn from '../game/turn.js';
import * as players from '../game/players.js';
import * as verbs from '../game/verbs.js';
import * as save from '../game/save.js';
import * as world from '../world/world.js';
import { newPlayer } from '../core/state.js';
import { openTransport } from './transport.js';
import { makeFormer } from '../game/formers.js';
import { nid, encode, decode, wire, unwire } from './codec.js';
import { showHang, hideHang } from '../ui/hang.js';

export const MAX_PLAYERS = 8;
const COLLAPSE_TICKS = 5 * 60 * 4;       // 5 minutes at 4 ticks a second
const SNAP_EVERY = 20;                   // ticks between full snapshots (handover insurance)
const VIEW_R = 20;                       // what a client is sent around its hero (Chebyshev)
const JOIN_WAIT = 6000;                  // ms of silence before a joiner opens the room itself
const MOVE_WAIT = 10000;                 // ms to wait for the next host during a handover

let T = null;                            // transport
let role = 'solo';                       // 'solo' | 'joining' | 'host' | 'client' | 'moving'
let code = '';
let hostPeer = '';
let roster = [];                         // [{peer, key, id, name}] in join order (host first)
let since = 0;                           // when this host opened the room (settles two simultaneous hosts)
let lastSnap = null;                     // newest full world snapshot (clients keep it for handover)
let myName = 'Wanderer';
let timer = 0;
const sent = new Map();                  // host: peer -> {layer, modsN}

export const roomRole = () => role;
export const roomCode = () => code;
export const roomPlayers = () => players.players().map(p => ({ id: p.seat && p.seat.id, name: p.seat && p.seat.name, me: players.isLocal(p),
  over: !!(p.seat && p.seat.over), collapsed: !!(p.seat && p.seat.collapsed) }));
export const shareLink = () => location.origin + location.pathname + '?room=' + code;
export const netKind = () => (new URLSearchParams(location.search).get('net') === 'local' ? 'local' : 'rtc');

export function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';                           // no I or O: they read as 1 and 0
  let s = ''; for (let i = 0; i < 5; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

/** This browser's identity in room `code`: the same key on reconnect picks your collapsed hero back up. The tab keeps
 *  its own copy (sessionStorage) so a second tab of the same browser can be re-keyed into a separate hero. */
function myKey(fresh = false) {
  const k = 'circ.seat.key.' + code, mk = () => Math.random().toString(36).slice(2, 12);
  try {
    let v = fresh ? '' : (sessionStorage.getItem(k) || localStorage.getItem(k));
    if (!v) v = mk();
    sessionStorage.setItem(k, v); localStorage.setItem(k, v);
    return v;
  } catch (e) { return (!fresh && myKey.v) || (myKey.v = mk()); }
}

function setURL(c) {
  try {
    const u = new URL(location.href);
    if (c) u.searchParams.set('room', c); else u.searchParams.delete('room');
    history.replaceState(null, '', u);
  } catch (e) { /* not fatal */ }
}

// =====================================================================================================================
// Lifecycle
// =====================================================================================================================

/** Wire the room system. ?room=CODE in the link joins once the title screen is dismissed. */
export function initNet() {
  try { myName = localStorage.getItem('circ.name') || myName; } catch (e) { /* default */ }
  on('respawn', () => {
    if (role === 'host') respawn(players.local());
    else if (role === 'client') send({ t: 'v', n: 'respawn', a: [] }, hostPeer);
  });
  on('start', () => {
    const c = new URLSearchParams(location.search).get('room');
    if (c && role === 'solo') joinRoom(c);
  });
}

export function setName(n) {
  myName = String(n || '').trim().slice(0, 16) || 'Wanderer';
  try { localStorage.setItem('circ.name', myName); } catch (e) { /* fine */ }
}
export const getName = () => myName;

/** Join room c (or open it if nobody is there). */
export async function joinRoom(c) {
  await leaveRoom(true);
  code = String(c).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  if (!code) return;
  setURL(code);
  role = 'joining';
  showHang('Knocking on the door of room ' + code + '...');
  try { T = await openTransport(netKind(), code); } catch (e) { console.error(e); hideHang(); role = 'solo'; say('Could not reach the room. The internet is, broadly, a rumour.', 'sys'); return; }
  wireTransport();
  send({ t: 'hello', key: myKey(), name: myName });
  clearTimeout(timer);
  timer = setTimeout(() => { if (role === 'joining') becomeHostFresh(); }, JOIN_WAIT);
}

/** Open a new room with this device's current world. Returns the code. */
export async function hostRoom() {
  await leaveRoom(true);
  code = newCode();
  setURL(code);
  try { T = await openTransport(netKind(), code); } catch (e) { console.error(e); say('Could not open a room. The internet declined.', 'sys'); code = ''; return ''; }
  wireTransport();
  becomeHostFresh(true);
  return code;
}

/** Leave the room and go back to playing solo (a client gets a fresh solo life). */
export async function leaveRoom(quiet = false) {
  clearTimeout(timer);
  const wasClient = role === 'client' || role === 'moving' || role === 'joining';
  if (T) { try { T.close(); } catch (e) { /* gone */ } }
  T = null; role = 'solo'; hostPeer = ''; roster = []; lastSnap = null; sent.clear();
  verbs.setRemote(null); setMirror(false);
  G.room = null;
  hideHang();
  if (!quiet) {
    setURL(null);
    if (wasClient) turn.newGame();
    else if (G.players) for (const p of players.players()) if (!players.isLocal(p)) players.removePlayer(p.seat.id);
    code = '';
    emit('room', { role });
  }
}

function send(msg, to = null) { if (T) T.send(msg, to); }

function wireTransport() {
  T.onMsg((m, from) => { try { onMessage(m, from); } catch (e) { console.error('[net] message', m && m.t, e); } });
  T.onJoin(peer => { if (role === 'joining') send({ t: 'hello', key: myKey(), name: myName }, peer); });
  T.onLeave(peer => { try { onLeave(peer); } catch (e) { console.error('[net] leave', e); } });
}

/** The clock's tick (main.js): the host and solo players run the world; clients only mirror it. */
export function tick() {
  if (role === 'solo' || role === 'host') turn.worldTick();
  if (role === 'host') hostAfterTick();
}

// =====================================================================================================================
// Messages
// =====================================================================================================================

function onMessage(m, from) {
  if (!m || typeof m !== 'object') return;
  switch (m.t) {
    case 'hello': if (role === 'host') onHello(m, from); break;
    case 'v': if (role === 'host') onVerb(m, from); break;
    case 'welcome': if (role !== 'host' || shouldYield(m.snap)) onWelcome(m, from); break;
    case 'view': if ((role === 'client' || role === 'moving') && from === hostPeer) onView(m); break;
    case 'snap': if (from === hostPeer) { lastSnap = m.snap; roster = m.snap.roster || roster; keepRoom(lastSnap); } break;
    case 'roster':
      if (role === 'host' && from !== T.self && m.since && (m.since < since || (m.since === since && from < T.self))) {
        // two people opened the same room at once: the older host wins, this one joins it
        role = 'joining'; hostPeer = ''; send({ t: 'hello', key: myKey(), name: myName }, from);
      } else if (from === hostPeer) roster = m.list || roster;
      break;
    case 'rekey': if (role === 'joining') send({ t: 'hello', key: myKey(myKey() === m.key), name: myName }, from); break;
    case 'full': leaveRoom().then(() => say(`Room ${m.code || ''} is full (${MAX_PLAYERS} heroes). The planet has a capacity, apparently.`, 'sys')); break;
    default: break;
  }
}

const shouldYield = snap => !!(snap && snap.since && snap.since < since);

function onLeave(peer) {
  if (role === 'host') {
    const P = players.byPeer(peer);
    if (P) {
      P.seat.peer = ''; P.seat.held = null; P.seat.queued = null; P.seat.auto = null;
      if (!P.seat.over) P.seat.collapsed = G.turn || 1;
      tellAll(`${P.seat.name} collapses where they stand. Nothing will touch them for a while.`);
    }
    roster = roster.filter(r => r.peer !== peer);
    sent.delete(peer);
    broadcastRoster();
  } else if ((role === 'client' || role === 'moving') && peer === hostPeer) {
    handover(peer);
  } else {
    roster = roster.filter(r => r.peer !== peer);
  }
}

// =====================================================================================================================
// Host
// =====================================================================================================================

// ---- room memory: every device keeps the room's latest world, so an emptied room can be reopened ----------------------
const roomKey = () => 'circ.room.' + code;
function keepRoom(snap) {
  try { localStorage.setItem(roomKey(), JSON.stringify(snap)); }
  catch (e) { try { localStorage.removeItem(roomKey()); } catch (_) { /* full and stubborn */ } }
}
function storedRoom() { try { const v = localStorage.getItem(roomKey()); return v ? JSON.parse(v) : null; } catch (e) { return null; } }

/** Reopen an emptied room: everyone who was in it is gone, so every hero gets back up as a Former, and this player
 *  arrives fresh (the newest hero, so the Formers come for them first). */
function reopenRoom(snap) {
  save.restoreSnapshot(snap);
  G.room = code;
  players.rebuild(snap.heroes || [], null);
  for (const P of players.players()) {
    if (!P.seat.over) makeFormer(P, 60);                             // 15 s head start for the newcomer
    players.removePlayer(P.seat.id);
  }
  const me = players.addPlayer({ name: myName });
  players.setLocal(me.seat.id);
  me.seat.joined = G.turn + 1;
  placeNearHome(me);
  world.calcVis();
  emit('newgame', {});
  say(`Room ${code} reopens. The planet remembers everyone who left. So do they.`, 'bad');
}

function becomeHostFresh(fresh = false) {
  clearTimeout(timer);
  setMirror(false); verbs.setRemote(null);
  const kept = fresh ? null : storedRoom();
  if (kept && Array.isArray(kept.heroes)) { try { reopenRoom(kept); } catch (e) { console.error('[net] reopen', e); } }
  G.room = code; role = 'host'; since = Date.now(); hostPeer = T.self;
  const me = players.local();
  Object.assign(me.seat, { key: myKey(), peer: T.self, name: myName, collapsed: 0 });
  roster = [{ peer: T.self, key: me.seat.key, id: me.seat.id, name: myName }];
  hideHang();
  say(`Room ${code} is open. Share the link or the code; up to ${MAX_PLAYERS} heroes.`, 'sys');
  emit('room', { role, code });
}

function onHello(m, from) {
  const already = players.byPeer(from);
  if (already) {                                                     // a repeated hello from the same connection
    send({ t: 'welcome', you: already.seat.id, snap: roomSnapshot() }, from);
    return;
  }
  let P = m.key ? players.byKey(m.key) : null;
  if (P && (players.isLocal(P) || (P.seat.peer && P.seat.peer !== from && T.peers().includes(P.seat.peer)))) {
    send({ t: 'rekey', key: m.key }, from);                         // that hero is already being played (another tab)
    return;
  }
  if (P && P.seat.over) { players.removePlayer(P.seat.id); P = null; }    // a dead hero stays dead: start fresh
  if (!P) {
    if (players.players().filter(p => !p.seat.over).length >= MAX_PLAYERS) { send({ t: 'full', code }, from); return; }
    P = players.addPlayer({ name: String(m.name || 'Stranger').slice(0, 16) });
    placeNearHome(P);
    tellAll(`${P.seat.name} wakes up nearby, naked and uninsured.`);
  } else tellAll(`${P.seat.name} stirs and gets back up.`);
  Object.assign(P.seat, { key: m.key, peer: from, collapsed: 0, name: String(m.name || P.seat.name).slice(0, 16) });
  roster = roster.filter(r => r.key !== m.key && r.peer !== from);
  roster.push({ peer: from, key: m.key, id: P.seat.id, name: P.seat.name });
  sent.set(from, { layer: null, modsN: -1 });
  send({ t: 'welcome', you: P.seat.id, snap: roomSnapshot() }, from);
  broadcastRoster();
  emit('room', { role, code });
}

function placeNearHome(P) {
  players.withPlayer(P, () => {
    const h = G.home;
    for (let r = 0; r < 30; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const x = h.x + dx, y = h.y + dy;
      if (world.free(x, y) && !world.isDeep(x, y)) { P.x = x; P.y = y; G.zone = world.zoneAt(x, y).id; world.calcVis(); return; }
    }
  });
}

function onVerb(m, from) {
  const P = players.byPeer(from);
  if (!P || P.seat.collapsed) return;
  if (m.n === 'respawn') { if (P.seat.over) respawn(P); return; }
  if (P.seat.over || !Object.prototype.hasOwnProperty.call(verbs.VERBS, m.n)) return;
  const args = Array.isArray(m.a) ? m.a : [];
  players.withPlayer(P, () => verbs.VERBS[m.n](...decode(args)));
}

/** A dead hero's player starts over: a brand-new naked hero (the newest in the room). */
function respawn(old) {
  if (!old || !old.seat.over) return;
  const { key, peer, name } = old.seat, wasLocal = players.isLocal(old);
  players.removePlayer(old.seat.id);
  const P = players.addPlayer({ name });
  Object.assign(P.seat, { key, peer });
  placeNearHome(P);
  if (wasLocal) {
    players.setLocal(P.seat.id);
    roster = roster.map(r => (r.key === key ? { ...r, id: P.seat.id } : r));
    emit('newgame', {});
  } else if (peer) {
    roster = roster.map(r => (r.peer === peer ? { ...r, id: P.seat.id } : r));
    sent.set(peer, { layer: null, modsN: -1 });
    send({ t: 'welcome', you: P.seat.id, snap: roomSnapshot() }, peer);
  }
  tellAll(`${name} is born again, naked and uninsured. Some people never learn.`);
}

function roomSnapshot() {
  const s = save.worldSnapshot();
  s.heroes = players.records();
  s.roster = roster; s.since = since; s.code = code;
  return s;
}

function broadcastRoster() { send({ t: 'roster', list: roster, since }); }

/** A line in every living hero's log. */
function tellAll(msg) { for (const p of players.players()) players.withPlayer(p, () => say(msg, 'sys')); }

function hostAfterTick() {
  for (const P of players.players()) {
    const m = P.seat;
    if (m.collapsed && G.turn - m.collapsed > COLLAPSE_TICKS) {   // gone for good: the body gets up without them
      makeFormer(P);
      players.removePlayer(m.id);
      roster = roster.filter(r => r.key !== m.key);
      continue;
    }
    if (m.peer && m.peer !== T.self) sendView(P);
  }
  if (G.turn % SNAP_EVERY === 0) { lastSnap = roomSnapshot(); send({ t: 'snap', snap: lastSnap }); keepRoom(lastSnap); }
}

const plainP = P => {
  const p = {};
  for (const k of Object.keys(P)) if (k !== 'ow' && k !== 'work') p[k] = P[k];
  p.work = [...(P.work || new Map())];
  return p;
};
const torus = (a, b) => { const d = Math.abs(wx(a) - wx(b)); return Math.min(d, WS - d); };

function sendView(P) {
  const m = P.seat, st = sent.get(m.peer) || { layer: null, modsN: -1 };
  sent.set(m.peer, st);
  const v = players.withPlayer(P, () => {
    const key = G.dg ? G.dg.k + '#' + G.dg.i : 'ow';
    const out = { t: 'view', turn: G.turn, over: !!G.over, P: plainP(P), dk: G.dg ? G.dg.k : null, fi: G.dg ? G.dg.i : 0, zone: G.zone };
    if (st.layer !== key) { if (G.dg) out.dg = save.packDungeon(G.dg); st.layer = key; }
    const near = o => Math.abs(o.x - P.x) <= VIEW_R && Math.abs(o.y - P.y) <= VIEW_R;
    out.mons = G.mons.filter(near).map(x => { nid(x); return x.loot ? { ...x, loot: null } : x; });   // a Former's bag stays on the host
    out.npcs = G.npcs.filter(near).map(x => { nid(x); return x; });
    out.items = [];
    for (const [k, it] of G.items) {
      const [ix, iy] = k.split(',').map(Number);
      if (torus(ix, P.x) <= VIEW_R && torus(iy, P.y) <= VIEW_R) out.items.push([k, it]);
    }
    out.ev = m.outbox.splice(0).map(([e, p]) => [e, wire(p)]);
    return out;
  });
  if (G.mods.size !== st.modsN) { v.mods = [...G.mods]; st.modsN = G.mods.size; }
  v.heroes = players.players().filter(h => h !== P).map(h => ({
    id: h.seat.id, name: h.seat.name, x: h.x, y: h.y, dk: h.seat.dg ? h.seat.dg.k : null, fi: h.seat.fi, over: h.seat.over,
    collapsed: h.seat.collapsed, hp: h.hp, max: h.max, lvl: h.lvl, arm: h.arm, wep: h.wep, buffs: h.buffs,
  }));
  if (G.turn % SNAP_EVERY === 1) v.q = { quests: G.quests, dex: [...G.dex], run: G.run, home: G.home };
  send(v, m.peer);
}

// =====================================================================================================================
// Client
// =====================================================================================================================

function onWelcome(m, from) {
  clearTimeout(timer);
  setMirror(true);
  role = 'client'; hostPeer = from;
  lastSnap = m.snap; roster = m.snap.roster || [];
  save.restoreSnapshot(m.snap);
  G.room = code;
  players.rebuild(m.snap.heroes, m.you);
  verbs.setRemote((n, a) => send({ t: 'v', n, a: encode(a) }, hostPeer));
  world.calcVis();
  hideHang();
  emit('newgame', {});
  emit('room', { role, code });
}

function syncList(arr, incoming) {
  const by = new Map(arr.filter(o => o && o.nid).map(o => [o.nid, o]));
  const out = (incoming || []).map(inc => {
    const o = by.get(inc.nid) || {};
    for (const k of Object.keys(o)) if (!(k in inc)) delete o[k];
    return Object.assign(o, inc);
  });
  arr.length = 0; arr.push(...out);
}

function onView(v) {
  if (role === 'moving') { role = 'client'; hideHang(); }
  const P = players.local();
  if (!P) return;
  for (const k of Object.keys(v.P)) if (k !== 'work') P[k] = v.P[k];
  P.work = new Map(v.P.work || []);
  if (v.dg) {
    const D = save.unpackDungeon(v.dg), had = G.pyr.get(D.k);
    if (had) { for (const k of Object.keys(had)) delete had[k]; Object.assign(had, D); } else G.pyr.set(D.k, D);
  }
  const D = v.dk ? G.pyr.get(v.dk) : null;
  if (v.dk && !(D && D.floors[v.fi])) return;                     // floor not here yet: the next view brings it
  Object.assign(P.seat, { dg: D, fi: D ? v.fi : 0, zone: v.zone, over: !!v.over });
  if (v.mods) for (const [k, key] of v.mods) if (G.mods.get(k) !== key) { const [x, y] = k.split(',').map(Number); world.setTerrain(x, y, key); }
  if (v.q) { G.quests = v.q.quests; G.dex = new Set(v.q.dex); G.run = v.q.run || {}; if (v.q.home) G.home = v.q.home; }
  // other heroes
  const keep = new Set([P.seat.id]);
  for (const h of v.heroes || []) {
    keep.add(h.id);
    let o = G.players.get(h.id);
    if (!o) { o = newPlayer(); players.seatOf(o).id = h.id; G.players.set(h.id, o); }
    Object.assign(o, { x: h.x, y: h.y, hp: h.hp, max: h.max, lvl: h.lvl, arm: h.arm, wep: h.wep, buffs: h.buffs });
    Object.assign(o.seat, { name: h.name, dg: h.dk ? (G.pyr.get(h.dk) || { k: h.dk, floors: [] }) : null, fi: h.fi | 0, over: !!h.over, collapsed: h.collapsed || 0 });
  }
  for (const id of [...G.players.keys()]) if (!keep.has(id)) G.players.delete(id);
  players.refresh();                                              // G now shows the local hero's layer
  syncList(G.mons, v.mons);
  syncList(G.npcs, v.npcs);
  G.items.clear(); for (const [k, it] of v.items || []) G.items.set(k, it);
  G.turn = v.turn;
  world.calcVis();
  for (const [ev, p] of v.ev || []) {
    const pl = unwire(p);
    if (ev === 'log') { G.log.unshift(pl); if (G.log.length > 80) G.log.length = 80; }
    emit(ev, pl);
  }
  emit('turn', { turn: G.turn, resting: false });
}

// =====================================================================================================================
// Handover
// =====================================================================================================================

function handover(oldHost, skip = new Set()) {
  role = 'moving';
  showHang('The host wandered off. Finding someone else to hold the planet up...');
  const alive = new Set(T.peers());
  const order = roster.filter(r => r.peer !== oldHost && !skip.has(r.peer) && (r.peer === T.self || alive.has(r.peer)));
  const next = order[0];
  if (!next || next.peer === T.self) { becomeHostFrom(oldHost); return; }
  hostPeer = next.peer;
  clearTimeout(timer);
  timer = setTimeout(() => { if (role === 'moving') { skip.add(next.peer); handover(oldHost, skip); } }, MOVE_WAIT);
}

function becomeHostFrom(oldHost) {
  clearTimeout(timer);
  if (!lastSnap) { leaveRoom(); return; }
  setMirror(false); verbs.setRemote(null);
  const myId = G.me;
  save.restoreSnapshot(lastSnap);
  G.room = code;
  players.rebuild(lastSnap.heroes, myId);
  role = 'host'; since = Date.now(); hostPeer = T.self;
  const alive = new Set(T.peers());
  const keep = [];
  for (const P of players.players()) {
    const r = (lastSnap.roster || []).find(x => x.key === P.seat.key);
    if (players.isLocal(P)) { P.seat.peer = T.self; P.seat.collapsed = 0; keep.unshift({ peer: T.self, key: P.seat.key, id: P.seat.id, name: P.seat.name }); }
    else if (r && r.peer !== oldHost && alive.has(r.peer)) { P.seat.peer = r.peer; keep.push({ peer: r.peer, key: P.seat.key, id: P.seat.id, name: P.seat.name }); }
    else { P.seat.peer = ''; if (!P.seat.over && !P.seat.collapsed) P.seat.collapsed = G.turn || 1; }
  }
  roster = keep;
  sent.clear();
  for (const r of roster) if (r.peer !== T.self) { sent.set(r.peer, { layer: null, modsN: -1 }); send({ t: 'welcome', you: r.id, snap: roomSnapshot() }, r.peer); }
  hideHang();
  world.calcVis();
  emit('newgame', {});
  say('You are holding the planet up now. Try not to drop it.', 'sys');
  emit('room', { role, code });
}
