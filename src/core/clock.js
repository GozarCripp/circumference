// core/clock.js — ARCHITECT-OWNED. The live game clock: calls one tick function every TIMING.tick ms.
// One tick = one classic "turn" for the world (monsters, poison, regen, buffs, day phase). The player acts at most
// once per tick (game/turn.js gates that), so a held key moves the hero at the same pace the world moves.
// Knows nothing about the game: main.js wires it to turn.worldTick. Pausing is solo-only (multiplayer never pauses).

let handle = 0, fn = null, ms = 250, paused = false, holds = () => false;

/** Start ticking tickFn every intervalMs. holdFn() → true skips a tick (title screen, modal panel). */
export function startClock(tickFn, intervalMs, holdFn) {
  stopClock();
  fn = tickFn; ms = intervalMs; if (holdFn) holds = holdFn;
  handle = setInterval(() => {
    if (paused || holds()) return;
    try { fn(); } catch (e) { console.error('[clock]', e); }
  }, ms);
}

export function stopClock() { if (handle) clearInterval(handle); handle = 0; }

export const isPaused = () => paused;
export function setPaused(p) { paused = !!p; return paused; }
export const togglePause = () => setPaused(!paused);
export const tickMs = () => ms;
