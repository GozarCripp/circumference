// art/pixel.js — ARCHITECT-OWNED. The pixel-art toolkit and the house style. Every procedural sprite is built with
// these helpers so 130 enemies, 30 terrains and 60 items look like one game.
//
// HOUSE STYLE (art direction, see docs/ARCHITECTURE.md §3)
//   * Chunky pixels: sprites are authored at 1x logical resolution and upscaled nearest-neighbour. Never anti-alias.
//   * Light comes from the upper left. Block tops are brightest, the +y (screen-left) face is one shade down,
//     the +x (screen-right) face two shades down.
//   * Shading uses shade()/ramp(): shadows drift toward plum, highlights toward warm cream. No pure black, no grey mud.
//   * Props, creatures, the hero and items get a 1px PAL.outline outline via outline(). Ground blocks do not.
//   * DETERMINISM: art must never call Math.random(). Use rng(seed) with a seed derived from the sprite id.
import { PAL, TILE_W, TILE_H, HW } from '../core/config.js';
import { strHash } from '../core/util.js';

/** @typedef {{img:HTMLCanvasElement, w:number, h:number, ax:number, ay:number, frames:number, custom?:boolean, smooth?:boolean}} Sprite
 *  img holds `frames` frames side by side, each w x h logical px. (ax, ay) is the anchor inside one frame:
 *  tiles -> centre of the top diamond; props/creatures/hero/items -> the point where the feet touch the ground. */

/** New offscreen canvas + 2D context with smoothing off. */
export function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w | 0); c.height = Math.max(1, h | 0);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = false;
  return { c, g };
}

/** Wrap a canvas as a Sprite. */
export function makeSprite(c, ax, ay, frames = 1, extra = {}) {
  return { img: c, w: Math.round(c.width / frames), h: c.height, ax, ay, frames, ...extra };
}

/** Deterministic PRNG (mulberry32). seed: number or string. Returns fn() -> [0,1). Also fn.int(n), fn.pick(arr). */
export function rng(seed) {
  let a = (typeof seed === 'string' ? strHash(seed) : seed >>> 0) || 0x9e3779b9;
  const f = () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  f.int = n => Math.floor(f() * n);
  f.pick = arr => arr[Math.floor(f() * arr.length)];
  return f;
}

// ---- colour ---------------------------------------------------------------------------
export function toRGB(hex) {
  if (Array.isArray(hex)) return hex;
  let h = String(hex).replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function toHex(rgb) {
  return '#' + rgb.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
/** Linear mix of two colours, t in 0..1. */
export function mix(a, b, t) {
  const A = toRGB(a), B = toRGB(b);
  return toHex([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
}
const COOL = '#2a1050', WARM = '#fff3d0';
/** The house shading function. k = -3..+3 steps. Negative: darker and plummier. Positive: lighter and creamier. */
export function shade(hex, k) {
  if (!k) return toHex(toRGB(hex));
  if (k < 0) {
    const s = Math.min(3, -k), c = toRGB(hex).map(v => v * (1 - 0.17 * s));
    return mix(c, COOL, 0.09 * s);
  }
  return mix(hex, WARM, Math.min(0.75, 0.2 * k));
}
/** [darkest, dark, base, light, lightest] */
export const ramp = hex => [shade(hex, -2), shade(hex, -1), shade(hex, 0), shade(hex, 1), shade(hex, 2)];
/** hsl() helper for creature palettes (classic enemies are coloured hsl((tier*47 + biome*90) % 360, 95%, 74%)). */
export function hsl(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return toHex([f(0) * 255, f(8) * 255, f(4) * 255]);
}

// ---- pixels ---------------------------------------------------------------------------
export function px(g, x, y, col) { g.fillStyle = col; g.fillRect(x | 0, y | 0, 1, 1); }
export function rect(g, x, y, w, h, col) { g.fillStyle = col; g.fillRect(x | 0, y | 0, w | 0, h | 0); }

/** Paint ASCII pixel art. rows: array of strings; pal: {char: colour}. ' ' and '.' are transparent.
 *  The fastest way to hand-author a readable 12-24px sprite. Returns the row count. */
export function grid(g, ox, oy, rows, pal) {
  for (let j = 0; j < rows.length; j++) {
    const r = rows[j];
    for (let i = 0; i < r.length; i++) {
      const ch = r[i];
      if (ch === ' ' || ch === '.') continue;
      const col = pal[ch];
      if (col) px(g, ox + i, oy + j, col);
    }
  }
  return rows.length;
}

/** Add a 1px outline around every opaque region, in place. Leave a 1px transparent margin around your art.
 *  opts.inner: also darken pixels where two differently-coloured regions meet? (no — keep it simple) */
export function outline(c, col = PAL.outline) {
  const g = c.getContext('2d', { willReadFrequently: true }), w = c.width, h = c.height;
  const src = g.getImageData(0, 0, w, h), d = src.data, hit = [];
  const op = (x, y) => x >= 0 && y >= 0 && x < w && y < h && d[(y * w + x) * 4 + 3] > 40;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
    if (!op(x, y) && (op(x - 1, y) || op(x + 1, y) || op(x, y - 1) || op(x, y + 1))) hit.push(x, y);
  g.fillStyle = col;
  for (let i = 0; i < hit.length; i += 2) g.fillRect(hit[i], hit[i + 1], 1, 1);
  return c;
}

/** Mirrored copy. */
export function flipH(c) {
  const o = canvas(c.width, c.height);
  o.g.translate(c.width, 0); o.g.scale(-1, 1); o.g.drawImage(c, 0, 0);
  return o.c;
}
/** Copy tinted toward `col` by `alpha` (opaque pixels only). Used for rare spawns, hit flashes, palette swaps. */
export function tinted(c, col, alpha = 0.5) {
  const o = canvas(c.width, c.height);
  o.g.drawImage(c, 0, 0);
  o.g.globalCompositeOperation = 'source-atop'; o.g.globalAlpha = alpha;
  o.g.fillStyle = col; o.g.fillRect(0, 0, c.width, c.height);
  return o.c;
}
/** Nearest-neighbour upscale by integer S. */
export function scaleNearest(c, S) {
  const o = canvas(c.width * S, c.height * S);
  o.g.drawImage(c, 0, 0, c.width * S, c.height * S);
  return o.c;
}
/** Soft pixel ground shadow (ellipse) centred at cx,cy. */
export function shadow(g, cx, cy, rx, ry, col = PAL.shadow) {
  g.fillStyle = col;
  for (let y = -ry; y <= ry; y++) {
    const w = Math.round(rx * Math.sqrt(Math.max(0, 1 - (y * y) / (ry * ry + 0.01))));
    if (w > 0) g.fillRect(Math.round(cx - w), Math.round(cy + y), w * 2, 1);
  }
}

// ---- the isometric block ----------------------------------------------------------------
// One tile = a 32x16 diamond that tessellates EXACTLY with its neighbours:
//   row r (0..14) is 4*(r+1) px wide for r <= 7 and 4*(15-r) px wide for r >= 8; row 15 is empty.
// Sprite convention for every tile sprite: canvas is TILE_W wide, the diamond starts at y = 0,
// anchor = (16, 8), and the side faces continue downward for at least SIDE_MAX px.
export const SIDE_MAX = 64;                 // side-face length every tile sprite provides below its diamond
export const TILE_SPRITE_H = TILE_H + SIDE_MAX;

/** Half-width (px each side of the centre line) of diamond row r, or 0 outside. */
export const diamondHalf = r => (r < 0 || r > 14 ? 0 : r <= 7 ? 2 * (r + 1) : 2 * (15 - r));
/** Is (dx, dy) — relative to the diamond's top-left 32x16 box — on the top face? */
export const inDiamond = (dx, dy) => { const hf = diamondHalf(dy); return hf > 0 && dx >= HW - hf && dx < HW + hf; };
/** Lowest diamond row in column dx (0..31). */
export const diamondBottom = dx => { const d = dx < HW ? dx : TILE_W - 1 - dx; return 7 + (d >> 1); };

/** Visit every top-face pixel: fn(dx, dy, u, v) with u,v in 0..1 across the tile (u along +x, v along +y). */
export function eachTop(fn) {
  for (let dy = 0; dy < 15; dy++) {
    const hf = diamondHalf(dy);
    for (let dx = HW - hf; dx < HW + hf; dx++) {
      const a = (dx - HW + 0.5) / HW, b = (dy + 0.5) / 8 - 1;      // a: -1..1 screen x, b: -1..1 screen y
      fn(dx, dy, (a + b + 1) / 2, (b - a + 1) / 2);
    }
  }
}
/** Visit every side-face pixel for a side length of `len` px: fn(dx, y, face, depth) where face is 'L' (+y face,
 *  screen left) or 'R' (+x face, screen right), y is the canvas row (diamond top = 0), depth = px below the top edge. */
export function eachSide(len, fn) {
  for (let dx = 0; dx < TILE_W; dx++) {
    const yb = diamondBottom(dx), face = dx < HW ? 'L' : 'R';
    for (let k = 1; k <= len; k++) fn(dx, yb + k, face, k - 1);
  }
}

/** Draw a shaded iso block into g with its diamond's top-left box at (ox, oy).
 *  col: base hex, or {top, left, right} (each a hex or a function).
 *    top(dx, dy, u, v) -> colour | null        left/right(dx, depth, y) -> colour | null   (null = leave transparent)
 *  opts: { len = SIDE_MAX   side-face length in px
 *          speckle = 0.18   chance a top pixel is nudged one shade (texture)
 *          sideSpeckle = 0.1
 *          seed = 1         rng seed for the speckle
 *          rim = true       1px highlight where the top face meets the side faces
 *          bands = 0        if > 0, darken a 1px mortar line every `bands` px down the sides (bricks, strata) }
 *  Returns nothing; paint details on top afterwards with px()/grid(). */
export function block(g, ox, oy, col, opts = {}) {
  const { len = SIDE_MAX, speckle = 0.18, sideSpeckle = 0.1, seed = 1, rim = true, bands = 0 } = opts;
  const C = typeof col === 'string' ? { top: col, left: shade(col, -1), right: shade(col, -2) } : col;
  const r = rng(seed);
  const topF = typeof C.top === 'function' ? C.top : null, lF = typeof C.left === 'function' ? C.left : null, rF = typeof C.right === 'function' ? C.right : null;
  const tUp = topF ? null : shade(C.top, 1), tDn = topF ? null : shade(C.top, -1);
  eachSide(len, (dx, y, face, depth) => {
    let c = face === 'L' ? (lF ? lF(dx, depth, y) : C.left) : (rF ? rF(dx, depth, y) : C.right);
    if (!c) return;
    if (bands && depth % bands === bands - 1) c = shade(c, -1);
    else if (r() < sideSpeckle) c = shade(c, r() < 0.5 ? -1 : 1);
    px(g, ox + dx, oy + y, c);
  });
  eachTop((dx, dy, u, v) => {
    let c = topF ? topF(dx, dy, u, v) : C.top;
    if (!c) return;
    if (!topF && r() < speckle) c = r() < 0.5 ? tUp : tDn;
    if (rim && dy === diamondBottom(dx) && dy > 7) c = shade(c, 1);
    px(g, ox + dx, oy + dy, c);
  });
}

/** Convenience: a finished tile Sprite (32 x TILE_SPRITE_H, anchor 16,8) from one block() call. */
export function blockSprite(col, opts = {}) {
  const { c, g } = canvas(TILE_W, TILE_SPRITE_H);
  block(g, 0, 0, col, opts);
  return makeSprite(c, HW, 8);
}
