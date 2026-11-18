// game/director.js — soft adaptive difficulty. Keeps a single "pace" number in G.run.pace (saved with the run):
// winning fights with health to spare pushes it up, taking big hits pulls it down. mkMon() shifts each spawn's
// tier by round(pace), so a hero cruising through gets a tougher world and a struggling one gets breathing room.
// Distance from home still sets the baseline; this only nudges it. Bosses are held back while the hero is struggling.
import { G } from '../core/state.js';
import { onSim as on } from '../core/bus.js';

const MIN = -2, MAX = 3;
const clamp = (v) => Math.max(MIN, Math.min(MAX, v));

export function pace() { return (G.run && Number.isFinite(G.run.pace)) ? G.run.pace : 0; }
/** Whole-tier shift applied to new spawns. */
export function tierShift() { return Math.round(pace()); }
/** Bosses only roll while the hero is not struggling. */
export function bossAllowed() { return pace() > -.5; }

function bump(d) {
  if (!G.run) G.run = {};
  G.run.pace = clamp(pace() + d);
}

let wired = false;
/** Subscribe to the bus. Called once by main.js; safe to call again. */
export function initDirector() {
  if (wired) return;
  wired = true;
  on('kill', () => {
    const P = G.P; if (!P || !P.max) return;
    bump(P.hp / P.max >= .6 ? .12 : .04);          // clean wins ramp it up; scrappy wins barely do
  });
  on('hurt', (e) => {
    const P = G.P; if (!P || !P.max || !e) return;
    bump(-1.5 * (e.dmg || 0) / P.max);             // losing 40% of max HP in one hit costs 0.6
  });
  on('newgame', () => { if (G.run) G.run.pace = 0; });
}
