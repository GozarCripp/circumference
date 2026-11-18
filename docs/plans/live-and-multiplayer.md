# Plan: 2.5D Live + Multiplayer

Two branches, built in order:

1. **`2.5live`** (from `foreverquest-uncircumferenced`) — the game switches from turn-based to real-time. Single player only.
2. **`multiplayer`** (from `2.5live`) — 1–8 players on one planet, connecting peer to peer.

The architecture stays the same: `core/ data/ game/ world/ render/ ui/` plus the event bus. Multiplayer adds `src/net/`. `docs/ARCHITECTURE.md` gets updated in both phases.

---

## Phase 1 — Live (`2.5live`)

**Clock.** `core/clock.js` runs a fixed simulation tick of 5 ticks per second. `game/turn.js` stays the place where every action ends up, but `endTurn()` becomes `tick()`, which the clock calls instead of the player's actions. Rendering runs at 60 fps and smooths movement between ticks.

**Actions take time.** Each actor has a `ready` tick. An action sets `ready = now + cost`. A base step costs 2 ticks (2.5 tiles a second). Heavier actions such as big weapons, spells and work cost more. Monsters keep their relative speeds, converted to ticks.

**Turn-based numbers.** `TICKS_PER_TURN = 2` lives in `config.js`. Durations in the data files (potions, spells, regeneration, hunger, day length, quest timers) keep their "turns" values and are multiplied by this constant, so the data files don't change.

**Input.**
- Holding a direction key repeats the step whenever the player is ready.
- Tap-to-move uses the existing auto-walk path.
- Auto-actions (go, charge, work, rest) run on the clock instead of `setTimeout`.

**Pausing.** Solo play can pause. Multiplayer cannot.

**Saves** stay the same format. They also store the tick.

## Phase 2 — Multiplayer (`multiplayer`)

### State refactor
- The single player becomes many. `G.P` becomes `G.players[id]`, and `G.me` is the local player.
- **Dungeons are instanced.** `G.dg` becomes `G.dungeons[id]`, and each player points to the one they're in, so players can be anywhere.
- **Simulation follows the players.** It runs within an activity radius of every living player, and `spawnAround` runs per player.

### Networking (`src/net/`)
- **`room.js`** sets up WebRTC with Trystero, using free public signaling. Each room has a 5-letter code. Opening `.../2.5d/?room=ABCDE` joins straight away. No install or account is needed.
- **`host.js`** runs the authoritative simulation. It receives what players want to do and sends back changes plus bus events.
- **`client.js`** sends the local player's actions, applies the host's updates and smooths movement on screen.
- **`migrate.js`** handles the host leaving. The host order is the join order. Every client keeps a full snapshot, refreshed every 5 seconds. When the host drops, the next player in line restores from it and becomes host, and everyone reconnects. During the switch everyone sees a loading screen: a cat in Circumference style hanging from a rope, with **"hang in there!"**
- **Bad networks.** Public STUN works for most players. If someone can't connect, add a free TURN relay (such as Cloudflare's) as a fallback.

### Rules
- **Spawn multiplier.** `mult = 1 + 2·(n−1)/7`, where n is the number of living players connected. That gives 1× at 1 player and 3× at 8. Fractions are rounded up or down at random.
- **Exempt from the multiplier:** bosses, NPCs, uniques and former selves.
- **Crowding:** at most one mob per tile, and mobs fill no more than 50% of the walkable tiles in any room.
- **No PvP.** Players can't damage each other.
- **Movement between players and mobs.** Players walk through each other. Mobs block players, and players block mobs.
- **Dropped items** stay in the world until any player picks them up. There is no trading.
- **Death** ends the run. A player can rejoin with the room code or link, but starts a new character, naked and uninsured.
- **Player cap:** 8. A 9th player gets a "room full" message.

### Former selves
A player who leaves becomes a **Former**: a hostile mob with their name, stats and look, carrying their whole inventory and equipment. All of it drops when the Former is killed.

**Targeting.** A Former goes after the nearest living player until a newer player arrives. It then locks onto the newest player, and a player who respawns counts as the newest.

**Range.** It hunts anywhere: the overworld, dungeons, across the wrap. When it's far away it travels off-screen at a set speed, then appears next to its target.

**Several Formers** can all hunt at once.

**Warning messages** get stronger as the Former gets closer, and a few of them repeat over time. For example:
- "You feel your skin crawl."
- "Someone is calling your name..."
- "An old friend is approaching."
- "Your shadow flinches before you do."
- "It knows your face. It wore one like it."

### Persistence
- Every client saves the latest snapshot to `localStorage`, keyed by room code.
- When a room reopens, the arriving player with the newest snapshot (the highest tick) restores the world.
- **Players who were in the game when it emptied** all come back as Formers. Returning players start fresh, so they are the newest players, and the Formers hunt them.
- If nobody has a snapshot, the world starts fresh.

## Testing
- **Unit tests:** the spawn multiplier, the crowding caps, Former targeting, and turn-to-tick conversion.
- **Playwright:** 3–4 browser contexts in one room on a local server. Check joining, host migration, a Former spawning and hunting, dropping and picking up items, and the multiplier.

## Open questions
1. **Disconnect grace.** How long before a dropped connection becomes a Former? Proposed: 20 seconds, so wifi blips don't count.
2. **What counts as a "room" outdoors.** The 50% cap is clear in dungeons. Proposed for the overworld: the 32×32 area around each player.
3. **Former strength.** An exact copy of the player, or a copy with a bonus (for example +25% HP)?
