// assets/manifest.js — The single place that says where art comes from.
//
// HOW DAVE REPLACES PLACEHOLDER ART (no code changes):
//   1. Open art.html in the browser to see every asset id, its placeholder, and the PNG path it is waiting for.
//   2. Draw it. Save a transparent PNG at   assets/art/<category>/<name>.png
//        e.g.  assets/art/enemy/jungle-00.png     (Monkey Who Read One Book on Economics)
//              assets/art/item/wep-katana.png
//              assets/art/tile/grass.png
//   3. Reload. That is all: the game looks for assets/art/<id>.png the first time it needs a sprite, uses it if it
//      is there, and keeps the procedural placeholder if it is not. (A missing file shows up as a harmless 404 in
//      the browser console. For a release with a silent console, see AUTO_PROBE below.)
//
// Any resolution works: the image is fitted to the category's BOX below (width-fit, anchored at the same point).
// Draw at 8x the box for crisp results on retina screens (e.g. 256 x 320 for an enemy). Full details and the id
// list: assets/art/README.md.

/** Folder that holds drop-in art, relative to index.html. */
export const ART_DIR = 'assets/art/';

/** true (default): lazily try assets/art/<id>.png for every sprite the game asks for — drop a PNG in, reload, done.
 *  A missing file costs one small HEAD request and a 404 line in the console, once per page load.
 *  false: only ids listed in ART below are requested, so there are zero 404s. Use it for a polished release:
 *  art.html has a "Copy manifest entries" button that prints the ART lines for every PNG it finds. */
export const AUTO_PROBE = true;

/** Optional explicit entries. Only needed to (a) skip probing, (b) use a different file name, or (c) describe
 *  an animation strip or a non-default box.
 *    'enemy/jungle-00': true                                   -> assets/art/enemy/jungle-00.png, default box
 *    'tile/water':      { file: 'tile/water.png', frames: 4 }   -> 4 frames side by side
 *    'enemy/desert-24': { file: 'bosses/ramset.png', w: 64, h: 72, ax: 32, ay: 66 }                          */
export const ART = {
};

/** Logical boxes per category, in art pixels at 1x (a tile diamond is 32 x 16).
 *  w,h = frame size; (ax, ay) = anchor inside the frame (tile: centre of the top diamond; everything else: feet). */
export const BOX = {
  tile:  { w: 32, h: 80, ax: 16, ay: 8 },    // diamond on top, side faces hanging 64px below (see art/pixel.js)
  prop:  { w: 48, h: 64, ax: 24, ay: 56 },   // trees, cacti, pillars, stairs, chest, campfire…
  enemy: { w: 32, h: 40, ax: 16, ay: 36 },
  boss:  { w: 64, h: 72, ax: 32, ay: 66 },   // tier-24 bosses (enemy/<biome>-24)
  npc:   { w: 32, h: 40, ax: 16, ay: 36 },
  hero:  { w: 32, h: 40, ax: 16, ay: 36 },   // hero/base plus one overlay per equipped layer, all the same box
  item:  { w: 16, h: 16, ax: 8,  ay: 13 },   // ground drops and UI icons
  fx:    { w: 16, h: 16, ax: 8,  ay: 8 },
};
