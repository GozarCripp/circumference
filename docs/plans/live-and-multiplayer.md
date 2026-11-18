# Plan: 2.5D Live + Multiplayer

Two branches, built in order:

1. **`2.5live`** (from `foreverquest-uncircumferenced`) — the game switches from turn-based to real-time. Single player only.
2. **`multiplayer`** (from `2.5live`) — 1–8 players on one planet, connecting peer to peer.

The architecture stays the same: `core/ data/ game/ world/ render/ ui/` plus the event bus. Multiplayer adds `src/net/`. `docs/ARCHITECTURE.md` gets updated in both phases.

---

## Phase 1 — Live (`2.5live`)

**Status: built.** What was done is simpler than the first draft:

- **`core/clock.js`** calls `turn.worldTick()` every `TIMING.tick` ms (250 ms). One tick is one classic world turn, so all "N turns" durations (potions, spells, regeneration, day length, quests) work unchanged.
- **One action per tick.** The player can act once per tick. `endTurn()` no longer advances the world: it only marks that the player has acted this tick. Input that arrives after the player has acted is queued for the next tick.
- **Held direction keys** repeat one step per tick (`turn.setHeld`), so movement doesn't depend on the browser's key repeat.
- **Auto-actions** (walk, charge, work, rest, walk to NPC) take one step per tick instead of running on `setTimeout`.
- **The clock holds** while the title screen or a modal panel (gear, journal, menu) is open.
- **Pausing (solo only).** **P** toggles pause. The game also pauses when the tab is hidden, and any key or tap resumes it. A `pause` event goes out on the bus.
- **Autosave** now happens every 40 ticks (10 s) or every 5 s, instead of every 10 turns.

## Phase 2 — Multiplayer (`multiplayer`)

### State refactor — **status: built (chunk 1)**
Built as a context switch rather than a rewrite. `game/players.js` keeps every hero in `G.players`. `withPlayer(P, fn)` points the existing single-hero fields (`G.P`, `G.dg`, `G.mons`, `G.items`, `G.npcs`, `G.seen`, `G.vis`, `G.zone`, `G.auto`, `G.over`, `G.log`) at that hero's view, runs `fn`, and switches back. Outside a world tick, the context is always the local hero.
- **Shared layers.** The overworld (`G.world`) is shared by everyone on it, and so is each dungeon floor, including what has been explored on it. Each hero has their own floor index, field of view, log, auto-action and zone.
- **The world tick**, per hero: action, then upkeep. Then monsters act layer by layer, each against the nearest living hero on its layer (twice if that hero is slowed, every other tick if they're hasted). Then the day-phase news goes to everyone.
- **Bus capture.** While a remote hero is in context, `bus.capture` diverts their events into `P.mp.outbox`, ready for the network layer.
- **Blocking.** Heroes block monsters (`world.heroAt`) but not each other. Monsters are only forgotten when they are far from every hero on the overworld.
- **Rendering.** The renderer draws the other heroes on the same layer.
- **Not yet:** quests and the bestiary are still shared (they belong to the room), and saving covers only the local hero.

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

## Decisions
- **Disconnect grace: 5 minutes.** During that time the character collapses where it stands and nobody can touch it. If the player reconnects in time, they carry on. If not, the character becomes a Former.
- **A "room" outdoors** is the 32×32-tile area around each player.
- **A Former** is an exact copy of the player, carrying all their loot and dropping all of it when killed.
