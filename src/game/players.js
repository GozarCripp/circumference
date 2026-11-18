// game/players.js — MULTIPLAYER: every hero in the room, and the context switch that lets the classic single-hero
// code run for any of them.
//
// The classic modules read "the hero's world" from G: G.P, G.dg, G.mons, G.items, G.npcs, G.seen, G.seenW, G.vis,
// G.zone, G.auto, G.over, G.log. Rather than rewrite them, withPlayer(P, fn) swaps those fields to P's view, runs
// fn, and swaps back. Outside a world tick the context is always the LOCAL hero, so UI, input and render are unchanged.
//
// Layers: the overworld (G.world: mons/items/npcs/seen) is shared by every hero on it. Each dungeon floor is its own
// shared layer (floor.mons/items/seen). Per-hero state lives on the hidden P.mp (non-enumerable: saves ignore it).
// While a REMOTE hero is in context, bus events are captured into P.mp.outbox (the net layer ships them to that
// player) instead of reaching the local UI.
import { G, newPlayer } from '../core/state.js';
import { capture } from '../core/bus.js';
import { WS } from '../core/config.js';

let cur = null;                 // the hero whose view G currently holds

/** The hidden per-hero record, created on first touch. */
export function mpOf(P) {
  if (!P.mp) {
    Object.defineProperty(P, 'mp', {
      enumerable: false, writable: true,
      value: {
        id: '', name: '', local: false, joined: 0,
        dg: null, fi: 0, vis: new Uint8Array(WS * WS), zone: null, auto: null, over: false, log: [], outbox: [],
        acted: false, rested: false, queued: null, held: null, known: new Set(), zoneSaid: new Map(), twice: false,
      },
    });
  }
  return P.mp;
}

/** Layer key of a hero ('ow' or '<dungeon key>#<floor>'), from its stored record. */
export function layerOf(P) { const m = mpOf(P); return m.dg ? m.dg.k + '#' + m.fi : 'ow'; }

export const players = () => (G.players ? [...G.players.values()] : (G.P ? [G.P] : []));
export const living = () => players().filter(p => !mpOf(p).over);
export const local = () => (G.players && G.players.get(G.me)) || G.P;
export const isLocal = P => P === local();

/** Adopt the current G (fresh game or loaded save) as the room's single local hero, and pin the shared overworld. */
export function adopt(name = 'You') {
  const P = G.P;
  G.world = G.dg && P.ow
    ? { mons: P.ow.mons, items: P.ow.items, npcs: P.ow.npcs, seen: P.ow.seen }
    : { mons: G.mons, items: G.items, npcs: G.npcs, seen: G.seen };
  G.players = new Map();
  G.me = 'me';
  const m = mpOf(P);
  Object.assign(m, { id: 'me', name, local: true, joined: G.turn, outbox: [] });
  G.players.set('me', P);
  cur = P;
  leave(P);
  return P;
}

/** Add another hero near home (or at x,y). Returns it. Used by the net layer and by tests. */
export function addPlayer({ id, name = 'Stranger', x, y } = {}) {
  const P = newPlayer();
  const m = mpOf(P);
  Object.assign(m, { id: id || 'p' + Math.random().toString(36).slice(2, 8), name, joined: G.turn, zone: null });
  P.x = x ?? G.home.x; P.y = y ?? G.home.y;
  G.players.set(m.id, P);
  return P;
}

export function removePlayer(id) { if (G.players) G.players.delete(id); }

/** Point G at hero P's view. */
function enter(P) {
  const m = mpOf(P);
  G.P = P; G.dg = m.dg;
  if (m.dg) {
    m.dg.i = m.fi;
    const f = m.dg.floors[m.fi];
    G.mons = f.mons; G.items = f.items; G.npcs = f.npcs || (f.npcs = []); G.seen = f.seen; G.seenW = f.s;
  } else if (G.world) {
    G.mons = G.world.mons; G.items = G.world.items; G.npcs = G.world.npcs; G.seen = G.world.seen; G.seenW = WS;
  }
  if (m.vis.length !== G.seen.length) m.vis = new Uint8Array(G.seen.length);
  G.vis = m.vis; G.zone = m.zone; G.auto = m.auto; G.over = m.over; G.log = m.log;
  cur = P;
}

/** Write G's view back into hero P (P may have changed floor, died, started walking...). */
function leave(P) {
  const m = mpOf(P);
  m.dg = G.dg; m.fi = G.dg ? G.dg.i : 0;
  m.vis = G.vis; m.zone = G.zone; m.auto = G.auto; m.over = G.over; m.log = G.log;
  if (!G.dg && G.world) {                       // keep the shared overworld pinned if code replaced the arrays
    G.world.mons = G.mons; G.world.items = G.items; G.world.npcs = G.npcs; G.world.seen = G.seen;
  }
}

/** Run fn with hero P in context, then restore. Remote heroes' events go to their outbox, not the local UI. */
export function withPlayer(P, fn) {
  if (!P || P === cur) return fn();
  const prev = cur;
  if (prev) leave(prev);
  enter(P);
  const m = mpOf(P);
  const oldSink = capture(m.local ? null : (ev, payload) => { m.outbox.push([ev, payload]); if (m.outbox.length > 400) m.outbox.splice(0, 100); });
  try { return fn(); } finally {
    capture(oldSink);
    leave(P);
    if (prev) enter(prev);
  }
}

/** Living heroes on layer key, optionally within Chebyshev range r of (x,y), nearest first. */
export function heroesOn(key, x, y, r = Infinity) {
  const out = [];
  for (const p of living()) {
    if (layerOf(p) !== key) continue;
    const d = Math.max(Math.abs(p.x - x), Math.abs(p.y - y));
    if (d <= r) out.push([d, p]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out.map(e => e[1]);
}
