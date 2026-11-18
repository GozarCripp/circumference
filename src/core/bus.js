// core/bus.js — ARCHITECT-OWNED. Synchronous event bus. Game logic emits; UI / fx / audio / quests / save listen.
// Rules: listeners never throw into game logic (errors are caught and logged); listeners must not call endTurn().
// The event catalogue lives in docs/ARCHITECTURE.md §6. Emit only catalogued events (or add yours there).

const L = new Map();   // event -> Set<fn>
const ANY = new Set(); // wildcard listeners: fn(event, payload)

/** Subscribe. Returns an unsubscribe function. on('*', (ev, payload) => ...) hears everything. */
export function on(ev, fn) {
  if (ev === '*') { ANY.add(fn); return () => ANY.delete(fn); }
  let s = L.get(ev); if (!s) L.set(ev, s = new Set());
  s.add(fn); return () => s.delete(fn);
}

let sink = null;       // MULTIPLAYER: while set, emits are captured here instead of dispatched (see game/players.js)

/** Redirect every emit to fn(ev, payload) until capture(null). Returns the previous sink (so captures can nest). */
export function capture(fn) { const prev = sink; sink = fn || null; return prev; }

export function emit(ev, payload) {
  if (sink) { try { sink(ev, payload); } catch (e) { console.error('[bus sink]', ev, e); } return; }
  const s = L.get(ev);
  if (s) for (const fn of [...s]) { try { fn(payload); } catch (e) { console.error('[bus]', ev, e); } }
  for (const fn of [...ANY]) { try { fn(ev, payload); } catch (e) { console.error('[bus*]', ev, e); } }
}
