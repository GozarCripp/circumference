# Drop-in art, or: how to make the game look like you

Every tile, prop, enemy, NPC, hero layer and item in the game is currently a procedural placeholder. That is fine. The
placeholders are there so nothing is blank. When you draw something, the game uses your drawing instead and nothing
else changes. No code edits. Here is the whole process.

## The four steps

1. **Open `art.html`** (in the repo root, served with any static server, or on the Pages site at `/art.html`).
   Every id is listed with its human name, its box size, the exact path to save to, and a tick when your PNG exists.
2. **Draw the asset.** Any tool. Transparent background. Stay inside the box (see below).
3. **Save the PNG** at the path shown on its card, for example `assets/art/enemy/jungle-00.png`.
4. **Reload.** The tick goes green and the game uses your drawing. That is the whole process.

The full list of ids, by category, with what each one is and its file name: **`docs/ART-IDS.md`**.

`art.html` looks for every PNG when it opens. Its **Check for my PNGs** button rescans without a reload, and
**Copy manifest entries** makes the release list (more on that below).

## What the ids look like

Every id is `<category>/<name>`, and the file path is always `assets/art/<category>/<name>.png`.

| Category | Count | Id grammar | Examples |
|---|---|---|---|
| tile | 18 | `tile/<terrain>` | `tile/grass`, `tile/water` (4 frames) |
| prop | 12 | `prop/<thing>`, `prop/campfire` | `prop/tree`, `prop/campfire` |
| enemy | 140 | `enemy/<biome>-<tier>`, `enemy/shark-<0..4>`, `enemy/rare-<biome>-<0 or 1>` | `enemy/jungle-00` … `enemy/desert-24` (24 is the boss), `enemy/shark-0`, `enemy/rare-swamp-1` |
| npc | 8 | `npc/<name>` | `npc/brenda` |
| hero | 63 | `hero/base`, `hero/swim`, `hero/<slot>-<material>`, `hero/wep-<weapon>` | `hero/base`, `hero/head-iron`, `hero/wep-katana` |
| item | 64 | `item/wep-<weapon>`, `item/arm-<material>-<slot>`, `item/potion`, `item/gold`, `item/scroll` | `item/wep-katana`, `item/arm-iron-head`, `item/potion` |

The hero's armour slots are `head`, `body`, `arms` and `legs`. The materials are `leather`, `iron`, `bone`, `dog`,
`bureaucrat`, `ghost`, `obsidian`, `diamond` and `space-age`.

The 25 weapon slugs, used by both `hero/wep-<slug>` and `item/wep-<slug>`:

```
dagger            straight-sword     greatsword        ultra-greatsword
curved-sword      katana             curved-greatsword thrusting-sword
axe               greataxe           hammer            great-hammer
pickaxe           spear              halberd           scythe
whip              fist-weapons       claws             twinblade
bow               greatbow           crossbow          sorcery-staff
pyromancy-flame
```

## Boxes and anchors

These are copied from `assets/manifest.js`. The box is the logical frame. Your drawing is fitted to its width.

| Category | Box (W x H) | Anchor (x, y) | Notes |
|---|---|---|---|
| tile | 32 x 80 | 16, 8 | Diamond on top (32 x 16), side faces hang 64 px below |
| prop | 48 x 64 | 24, 56 | Trees, cacti, pillars, stairs, chests, campfire |
| enemy, npc, hero | 32 x 40 | 16, 36 | Feet at the anchor |
| enemy boss (tier 24) | 64 x 72 | 32, 66 | `enemy/<biome>-24` |
| item | 16 x 16 | 8, 13 | Ground drops and UI icons |

The tile diamond, from above:

```
          (16, 8)  <- anchor sits in the centre of the top diamond
            .
         /     \      top face: 32 px wide, 16 px tall
        <   x   >
         \     /
          \   /       the two side faces hang straight down
           \ /        from the diamond's lower edges
            |         ...for 64 px more, so the tile is 80 px tall
```

## Sizes to draw at

Draw at **8x** for crisp results on retina screens. The game and the gallery both fit any resolution to the box width.

| Category | Recommended size |
|---|---|
| enemy, npc, hero layer | 256 x 320 |
| boss | 512 x 576 |
| tile | 256 x 640 |
| prop | 384 x 512 |
| item | 128 x 128 |

Rules that do not bend:

- **Transparent background.** A solid backdrop reads as a rectangle in the game.
- **Faces right.** The game flips sprites that face left. Draw once, facing right.
- **Hero layers share one box.** Every `hero/<slot>-<material>` and `hero/wep-<slug>` is 32 x 40, drawn on top of
  `hero/base` at the same anchor. Put the helmet where the head is on your base figure, or it will float.
- **Tiles are top-aligned**, non-tiles are **bottom-centre anchored**.
- **Liquids can be animated.** A single-frame `tile/water`, `tile/bogw` or `tile/deep` gives still water. For moving
  water save four frames side by side in one PNG (each 32 x 80) and declare `frames: 4` in `assets/manifest.js`
  (see below). Without that line a strip is read as one very wide picture.

## Using a different file name, box or animation

You rarely need this. The default is "file named after the id, default box". When you do need something else, add an
entry to the `ART` object in `assets/manifest.js`. These are the forms the manifest comments give:

```js
export const ART = {
  'enemy/jungle-00': true,                                  // assets/art/enemy/jungle-00.png, default box
  'tile/water':      { file: 'tile/water.png', frames: 4 }, // four 32 x 80 frames side by side
  'enemy/desert-24': { file: 'bosses/ramset.png', w: 64, h: 72, ax: 32, ay: 66 }, // other name, boss box
};
```

## AUTO_PROBE, and getting ready for release

`AUTO_PROBE` is set in `assets/manifest.js`.

- **`AUTO_PROBE = true` (the default, for drawing).** The first time the game needs a sprite, it tries
  `assets/art/<id>.png` once per session. If the file is there, it is used. If not, the placeholder stays and the 404
  is remembered. A 404 is harmless. It is only noise in the network log.
- **`AUTO_PROBE = false` (for a release).** The game only loads what is listed in `ART`. Zero 404s, and the list is
  explicit.

To go to a release: in `art.html`, press **Copy manifest entries**. It copies one `'<id>': true,` line per finished
PNG. Paste those lines into `ART`, set `AUTO_PROBE = false`, and commit.

## Checklist

- [ ] Drawn at 8x, transparent background, facing right.
- [ ] Saved at the exact path on the card (`assets/art/<category>/<name>.png`).
- [ ] Hero layers checked on top of `hero/base`, same box.
- [ ] Animated liquids saved as four frames side by side and declared with `frames: 4`.
- [ ] Tick is green on `art.html` after a reload.

Anything you have not drawn yet keeps its placeholder. That is intended. Nothing breaks, and the gallery will
keep showing you what is still waiting for a pen.
