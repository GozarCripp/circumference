# Circumference: Game Plan and Project Memory

This is the single source of truth for where the project stands, so nothing is lost between sessions.

> **HARD RULE:** every change to the project is logged in this file, in **§8 Change log** (newest first), in the same commit as the change. Decisions also go into §3, and new known issues into §5. When memory is compacted or anything about past work is unclear, read this file first.

Technical detail per chunk lives in `docs/plans/live-and-multiplayer.md`.

---

## 1. The game

**Circumference: Naked & Uninsured** is a procedurally generated roguelike RPG on a small planet that wraps around. You start with nothing, and everything you use has to be found or dropped. It plays in the browser on phone, tablet and desktop, with no build step.

| Version | Branch | Live URL |
|---|---|---|
| Classic ASCII | `main` | https://gozarcripp.github.io/circumference/ |
| 2.5D (turn-based) | `foreverquest-uncircumferenced` | https://gozarcripp.github.io/circumference/2.5d/ |
| 2.5D live (real-time, solo) | `2.5live` | not published |
| **2.5D live multiplayer** | `multiplayer` | https://gozarcripp.github.io/circumference/mp/ |

`multiplayer` is the main line of development. It contains everything in `2.5live` plus multiplayer and the combat changes. `2.5live` stopped at "live mode" and does not have the combat changes.

To run it locally, start a static server and open the page:

```bash
python3 -m http.server
```

Then open `http://localhost:8000`. To test multiplayer in one browser, add `?net=local` to the URL and open two tabs.

---

## 2. The original brief (as asked)

> 2.5D should have multiplayer, so we can play with Ken and up to 6 others for an 8-player rampage. All enemies spawn with a multiplier based on the number of players. What server do we need, and can it be free?

The answer was: **no server, and free.** One player's browser hosts the game, and the others connect peer to peer over WebRTC. They're introduced via free public relays (Trystero over Nostr), and the game is served by GitHub Pages.

---

## 3. Design decisions (all agreed with the owner)

### Versions (owner decision, 2026-11-19)
- **`/mp/` (the `multiplayer` branch) is the evolution of the 2.5D game.** Until the game goes 3D, every change is aimed at it.
- **The classic ASCII version (`main`) is finished:** "classic is perfect". Don't change it.

### Real-time
- **Turns are out: the game is live.** The world advances on a clock of 4 ticks per second (`TIMING.tick = 250` ms). One tick equals one classic turn, so every "N turns" duration in the data is unchanged.
- **Player actions.** A player acts at most once per tick, and a held direction key repeats one step per tick.
- **Pausing (solo only).** **P** pauses, and the game pauses itself when the tab is hidden. Menus (Gear, Journal, Menu) also hold the world. A multiplayer room never pauses.

### Players and rooms
- **Room size:** 1–8 players on one shared planet. Everyone can go anywhere independently, including different dungeons and floors.
- **Joining:** by share link (`.../mp/?room=CODE`) or by typing the room code. No accounts or installs.
- **Host leaves:** hosting passes automatically to the next player in join order. A loading screen shows a pixel cat hanging from a rope with the line **"hang in there!"**
- **No PvP.** Players can't damage each other, and they can walk through each other but not through monsters.
- **No trading.** Dropped items stay on the ground until anyone picks them up.
- **Death ends your run.** You can start again ("Be born again" or rejoin with the code), but always as a new character, naked and uninsured.

### Enemy scaling
- **Multiplier:** spawn counts are multiplied by `1 + 2·(n−1)/7`, where n is the number of living players. That's 1× alone and 3× with eight (two players gives about 1.3×). Fractions are rounded up or down at random.
- **Exempt from the multiplier:** bosses and NPCs (and also named rares and Formers).
- **Crowding:** at most one monster per tile. No more than 50% of a room's walkable space may be filled with monsters. Outdoors, a "room" is the 32×32 area around a spot; in dungeons it's a room-sized 9×9 window.

### Disconnects and Former selves
- **Dropped connection:** you get 5 minutes. Your character collapses where it stands and nobody can touch it. If you rejoin in time from the same browser, you carry on.
- **After 5 minutes** the body gets up as a **Former**, a hostile exact copy of you carrying all your loot, all of which drops when it's killed.
- **Who it hunts.** A Former hunts the nearest player until a newer player arrives (someone joining, or someone respawning). Then it switches to the newest. It reaches them anywhere, even in a dungeon, however far away they are.
- **Your own Former.** If you respawn while your Former is alive, it immediately comes after you, because you're the newest.
- **Several Formers** can hunt at once ("double dangerous").
- **Warning messages escalate as it approaches.** For example: "You feel your skin crawl." → "An old friend is approaching." → "Someone is calling your name..." (with more variants in `game/formers.js`).

### When everyone leaves
- **The room remembers.** When the room is reopened with the same code, everyone's Formers are there, and the new arrival is hunted first.

### Combat feel (added after the first playtest: monsters were too quick to tap)
1. **Tap to fight.** A quick tap on a monster makes your hero chase it and keep attacking until it dies or you tap somewhere else.
2. **Easier taps.** Tapping an empty tile next to a visible monster counts as tapping the monster. Item taps stay exact.
3. **Press and hold** opens the info card for a monster or anything else. That's where you throw poison and cast targeted spells.
4. **Players outpace monsters.** Monsters move every other tick (fliers stay quick), but attack every tick once they're next to you.
5. **Idle hit-back.** A player standing still who gets hit swings back automatically (not while feigning death).
- **Potions are unchanged.** Nukes, teleports and heals are drunk from Gear or by tapping your own hero.

---

## 4. What has been built (`multiplayer` branch)

| Chunk | What | Status |
|---|---|---|
| Plan | Branches, plan doc | done |
| Live | `core/clock.js`, `turn.worldTick`, held keys, auto-actions on the clock, solo pause | done |
| MP 1 | `game/players.js` context switch (many heroes in one world), shared overworld and floors, per-hero view, monsters target the nearest hero | done |
| MP 2 | `net/` rooms: bundled Trystero transport plus `?net=local`; host-authoritative views; 5 s snapshots; host handover; 5-minute collapse and reconnect; respawn; Play together panel; name tags | done |
| Pages | Workflow publishes `/mp/`; unique artifact name per run attempt | done (see issues) |
| Combat | Tap to fight, near-miss taps, press and hold to inspect, half-speed movement, idle hit-back | done |
| MP 3 | Spawn multiplier and crowding cap, Formers, room memory | done |

### Architecture in one paragraph
The folder layout is unchanged: `core/ data/ game/ world/ render/ ui/ input/ audio/` plus the event bus, and multiplayer adds `net/`. The classic single-hero code reads `G.P`, `G.mons` and so on. `players.withPlayer(P, fn)` swaps those fields to any hero's view, so the old code runs for every hero. Every player action goes through `game/verbs.js`, which runs it locally or sends it to the host. On clients, `bus.setMirror(true)` silences the game-logic listeners (registered with `onSim`), so only the host simulates.

### Files added
- **Core:** `core/clock.js`
- **Game:** `game/players.js`, `game/verbs.js`, `game/formers.js`
- **Network:** `net/net.js`, `net/transport.js`, `net/codec.js`, `net/vendor/trystero.min.js`
- **UI:** `ui/hang.js`
- **Docs:** `docs/plans/live-and-multiplayer.md`, `GAME-PLAN.md` (this file, at the repository root), `CLAUDE.md`

---

## 5. Known limitations and to-dos

- **Pages workflow on other branches.** Only `multiplayer` carries the `/mp/` and artifact-name changes to `.github/workflows/pages.yml`. A push to `main` or `foreverquest-uncircumferenced` redeploys the site **without `/mp/`** until their workflow files get the same change. It needs the owner's OK to push there.
- **Handover rolls back** up to 5 s, because the new host restores the last snapshot.
- **Room memory** restores the first returning player's own copy, not the newest copy among all returners.
- **Quests and bestiary** belong to the room. A remote player's events are captured for their own screen, so **kills by non-host players may not count toward quests**. Worth fixing.
- **Solo saves are off inside a room.** A client who leaves a room gets a fresh solo life.
- **Monster half speed also applies in solo**, which is a balance change for the single-player game.
- **Former look.** Formers are drawn as their player's hero with a red name tag, without a colour tint. A tint would make them easier to spot.
- **Name tags** can be overlapped by trees.
- **`docs/ARCHITECTURE.md`** is referenced in code comments but doesn't exist yet.
- **Networking limits.** Players on strict networks may fail to connect, because there's only public STUN and no TURN relay yet. A free TURN service (for example Cloudflare) could be added to `net/transport.js` (`rtcConfig`).

## 6. Ideas parked
- A "ponytail" plugin pass over the codebase. The plugin isn't in the catalog, so its purpose is unknown; ask the owner what it does before running it.

## 7. Testing notes
- **Approach:** Playwright scripts drive the game through `window.circ` (the debug handle) and the `?net=local` transport, with several tabs in one browser context.
- **Covered:** solo soak; held keys; two heroes; dungeon split; join/move/attack; host handover with three tabs; disconnect, reconnect and respawn; tap-to-fight for host and client; monster pace; Former life cycle; room reopen.
- **Not testable in the dev sandbox:** real WebRTC over the internet. It's confirmed working by the owner's playtest.

---

## 8. Change log (newest first)

Format: `YYYY-MM-DD · branch · what changed (and why)`.

- 2026-11-19 · multiplayer · Decision: `/mp/` is the evolution of 2.5D and all work targets it until 3D; classic stays frozen. Bug reported and under investigation: after tapping to walk, a message appears and walking stops working. Not a status effect.
- 2026-11-19 · multiplayer · Moved the plan to the repository root as `GAME-PLAN.md`, added this change log and the hard rule, and added `CLAUDE.md` so every session follows it.
- 2026-11-19 · multiplayer · Added `docs/GAME-PLAN.md`, the project memory.
- 2026-11-19 · multiplayer · **Chunk 3:**
  - The spawn multiplier (1×–3×) and the 50% crowding cap.
  - Formers: exact copies carrying all their loot, with hunting, warning messages, and a 5 s head start (15 s when a room reopens).
  - Room memory, so a reopened room raises everyone who left as Formers.
  - Formers aren't prefixed with "the" in messages and stay out of the bestiary.
- 2026-11-19 · multiplayer · **Combat feel** (after the first playtest found monsters too fast to tap): tap to fight, near-miss taps, press and hold to inspect, monsters move at half speed but attack at full rate, and idle heroes hit back.
- 2026-11-18 · multiplayer · Pages: unique artifact name per run attempt, after re-runs failed with "Multiple artifacts named github-pages". The owner also added deployment branch rules for `multiplayer` and `foreverquest-uncircumferenced` in the `github-pages` environment.
- 2026-11-18 · multiplayer · Pages workflow publishes the `multiplayer` branch at `/mp/`. Pushing the same change to `main` and `foreverquest-uncircumferenced` was blocked by the session's safety check, and is still pending.
- 2026-11-18 · multiplayer · **MP chunk 2:**
  - Online rooms: bundled Trystero over WebRTC, plus `?net=local` for testing.
  - The host runs the world, and clients mirror it.
  - Host handover behind the "hang in there!" cat screen.
  - The 5-minute collapse and reconnect, and respawning.
  - The Play together panel and name tags.
- 2026-11-18 · multiplayer · **MP chunk 1:** many heroes in one world (the `players.withPlayer` context switch), shared layers, and monsters targeting the nearest hero.
- 2026-11-18 · 2.5live · **Live mode:** a 250 ms world clock replaces turn-waiting, held keys move continuously, auto-actions run on the clock, solo pause, and the autosave throttle rescaled.
- 2026-11-18 · 2.5live · Wrote the plan (`docs/plans/live-and-multiplayer.md`) and recorded the decisions on the 5-minute collapse, outdoor "rooms" being 32×32, and Formers being exact copies.
