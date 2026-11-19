// game/verbs.js — every action a player can take, by name. UI and input call run('drink', pot) instead of reaching
// into the game modules directly, so that in a MULTIPLAYER room a client's action can be shipped to the host and run
// there against that client's hero (net/net.js installs the remote sender; arguments are encoded by net/codec.js).
// Solo and host: run() executes at once, in the current (local) hero's context, and returns the verb's result.
import { G } from '../core/state.js';
import { emit } from '../core/bus.js';
import { WK } from '../core/util.js';
import * as turn from './turn.js';
import { attack, inRange } from './combat.js';
import { castSpell, forgetSpell } from './spells.js';
import { drink, throwPoison } from './potions.js';
import { pickup, equip, dropGear } from './loot.js';
import * as quests from './quests.js';
import * as life from './life.js';
import { isLocal } from './players.js';

let remote = null;   // (name, args) => void, set by the net layer on a client

export const VERBS = {
  act: (dx, dy) => turn.act(dx, dy),
  held: dir => turn.setHeld(dir),
  auto: a => turn.startAuto(a),
  stop: () => turn.stopAuto(),
  camp: () => turn.makeCamp(),
  wait: () => turn.endTurn(true),
  /** Attack in reach, otherwise charge. */
  attack: m => {
    if (!m || !G.mons.includes(m)) return false;
    if (inRange(m)) { attack(m); turn.endTurn(); return true; }
    turn.startAuto({ kind: 'go', mon: m, hunt: true });
    return false;
  },
  cast: (id, target) => { const ok = castSpell(id, target); if (ok) turn.endTurn(); return ok; },
  forget: id => forgetSpell(id),
  drink: pot => { const ok = drink(pot); if (ok && !G.over) turn.endTurn(); return ok; },
  throw: m => { const ok = !!m && throwPoison(m); if (ok) turn.endTurn(); return ok; },
  /** Pick up what is underfoot; a turn is spent only if something actually moved. */
  pickup: () => {
    const k = WK(G.P.x, G.P.y), before = G.items.get(k);
    pickup();
    const took = G.items.get(k) !== before || !G.items.has(k);
    if (took) turn.endTurn();
    return took;
  },
  equip: i => equip(i),
  drop: i => dropGear(i),
  /** NPC dialog choice. A remote hero gets the next page back as a 'dialog' event. */
  choose: (npc, id) => {
    if (!npc || !G.npcs.includes(npc)) return null;
    const next = npc.amb ? life.choose(npc, id) : quests.choose(npc, id);
    if (!isLocal(G.P)) emit('dialog', { npc, model: next || null });
    return next;
  },
};

/** Run verb `name`. On a client it goes to the host and returns undefined. */
export function run(name, ...args) {
  if (remote) { remote(name, args); return undefined; }
  const f = VERBS[name];
  return f ? f(...args) : undefined;
}

/** True when actions go to a host (this device is a client). */
export const isRemote = () => !!remote;
export function setRemote(fn) { remote = fn || null; }
