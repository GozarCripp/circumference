// art/tiles.js — procedural Minecraft-palette isometric block sprites (ARCHITECTURE §8.A6, §3.3, §3.5).
//
// makeTile(key, variant) returns a Sprite: 32 px wide frames, TILE_SPRITE_H (80) tall, anchor (16, 8).
// The 32x16 diamond sits at the top; the two side faces continue SIDE_MAX px below it and the renderer crops what
// it needs. Liquids carry LIQUID_FRAMES frames side by side. Every pixel is painted through pixel.block(), so
// neighbours tessellate exactly (no gaps, no seams) and nothing is ever outlined.
//
// How a tile is authored
//   * TOP faces are painted from a 16x16 "cell texture" mapped onto the diamond along the iso axes (u, v), the way
//     Minecraft maps a 16x16 texture onto a block. Details are stored in a cell map or a screen-space overlay and are
//     clipped to the diamond by construction.
//   * SIDE faces are painted as functions of (dx, depth) only, never of the crop length, so any crop of 2..64 px
//     is a correct slice of the same strata. The first rows of every side already read as a proper edge.
//   * Colour: each material has a base colour from the terrain table; shade()/ramp() give the 3-5 tones. The +y face
//     (screen left) is shade(-1) and the +x face (screen right) shade(-2) of whatever the side function returns.
//   * Variants 0..3 share the material but reseed tuft layouts, crack directions, flowers, moss and so on.
//   * Determinism: rng()/hash only, seeded from the sprite id. No Math.random.
import { TERRAIN } from '../data/terrain.js';
import { blockSprite, canvas, block, makeSprite, rng, shade, ramp, mix, inDiamond, TILE_SPRITE_H } from './pixel.js';
import { TILE_W, HW } from '../core/config.js';
import { strHash } from '../core/util.js';

/** Variants per tile key (art variety chosen by world.variantAt). */
export const TILE_VARIANTS = 4;
/** Animation frames for liquids (laid side by side in the sprite). */
export const LIQUID_FRAMES = 4;

// ---------------------------------------------------------------------------------------------------------------
// small toolkit
// ---------------------------------------------------------------------------------------------------------------
/** Integer hash of up to four ints -> [0, 1). */
function hsh(a, b, c, d) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 2147483629) ^ Math.imul(d | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const mod = (a, n) => ((a % n) + n) % n;
const clamp15 = v => (v < 0 ? 0 : v > 15 ? 15 : v);

const shCache = new Map();
/** shade() with a cache; the same few colours are shaded thousands of times per tile. */
function sh(c, k) {
  const key = c + k;
  let v = shCache.get(key);
  if (v === undefined) { v = shade(c, k); shCache.set(key, v); }
  return v;
}
const col = key => TERRAIN[key].color;

/** Per-tile authoring context: seeded noise, rng, and the detail layers the top face reads. */
function makeCtx(key, variant) {
  const seed = strHash('tile/' + key + '~' + variant);
  const cells = new Map();      // cell texture overrides  (gy*16+gx -> colour)
  const over = new Map();       // screen overrides        (dy*32+dx -> colour), clipped to the diamond
  return {
    seed,
    r: rng('tile/' + key + '~' + variant),
    n: (x, y, k = 0) => hsh(x, y, seed, k),
    cell(gx, gy, c) { if (gx >= 0 && gx < 16 && gy >= 0 && gy < 16) cells.set(gy * 16 + gx, c); },
    put(dx, dy, c) { if (inDiamond(dx, dy) && dy < 15) over.set(dy * 32 + dx, c); },
    cells, over,
  };
}

/** A blob of cells around (cx, cy), radius ~rad, painted with pick(i) colours. */
function blob(X, cx, cy, rad, pick) {
  for (let y = -rad; y <= rad; y++) for (let x = -rad; x <= rad; x++) {
    const d = x * x + y * y * 1.3 + (X.n(cx + x, cy + y, 91) - 0.5) * rad * 1.6;
    if (d <= rad * rad * 0.9) X.cell(cx + x, cy + y, pick(x, y));
  }
}
/** A diagonal crack: random walk in cell space. */
function crack(X, gx, gy, len, c, dirX = 1, dirY = 1) {
  for (let i = 0; i < len; i++) {
    X.cell(gx, gy, c);
    const t = X.r();
    if (t < 0.55) { gx += dirX; gy += dirY; } else if (t < 0.78) gx += dirX; else gy += dirY;
  }
}
/** A 2:1 screen-space streak (gloss, sparkle trails). */
function streak(X, x0, y0, len, c) {
  for (let i = 0; i < len; i++) { X.put(x0 + 2 * i, y0 - i, c); X.put(x0 + 2 * i + 1, y0 - i, c); }
}

/** Compose a block colour spec from a top cell-texture function and a side function (dx, depth, face) -> hex|null. */
function spec(X, topCell, side) {
  return {
    top: (dx, dy, u, v) => {
      const gx = clamp15((u * 16) | 0), gy = clamp15((v * 16) | 0);
      return X.over.get(dy * 32 + dx) || X.cells.get(gy * 16 + gx) || topCell(gx, gy, dx, dy);
    },
    left: (dx, dep) => { const c = side(dx, dep, 'L'); return c && sh(c, -1); },
    right: (dx, dep) => { const c = side(dx, dep, 'R'); return c && sh(c, -2); },
  };
}

/** Brick/slab side face: courses of height ch, brick width bw, staggered; tones picked per brick. */
function brickSide(X, o) {
  const { ch, bw, tones, mortar, hi = null, grit = 0.06, gritTones = tones, stagger = true } = o;
  return (dx, dep) => {
    const course = (dep / ch) | 0, y = dep % ch;
    if (y === ch - 1) return mortar;
    const shift = stagger && (course & 1) ? bw >> 1 : (o.rowShift ? (hsh(course, 3, X.seed, 5) * bw) | 0 : 0);
    const xx = dx + shift, bi = (xx / bw) | 0;
    if (xx % bw === bw - 1) return mortar;
    let c = tones[(X.n(bi, course, 5) * tones.length) | 0];
    if (hi && y === 0) c = hi;
    else if (X.n(dx, dep, 6) < grit) c = gritTones[(X.n(dx, dep, 7) * gritTones.length) | 0];
    return c;
  };
}

// ---------------------------------------------------------------------------------------------------------------
// ground
// ---------------------------------------------------------------------------------------------------------------
function grass(v, X) {
  const g = ramp(col('grass')), d = ramp(col('mud')), { r, n } = X;
  const tufts = [3, 7, 9, 11][v];
  for (let i = 0; i < tufts; i++) {
    const gx = 1 + r.int(13), gy = 1 + r.int(13);
    X.cell(gx, gy, g[3]); X.cell(gx, gy + 1, g[1]);
    if (r() < 0.5) X.cell(gx + 1, gy + 1, g[1]);
  }
  if (v === 1) { const x = 3 + r.int(9), y = 3 + r.int(9); X.cell(x, y, '#FFE27A'); X.cell(x - 1, y, '#F7FBFF'); X.cell(x, y - 1, '#F7FBFF'); }
  if (v === 3) { const x = 3 + r.int(9), y = 3 + r.int(9); X.cell(x, y, '#E0524A'); X.cell(x + 1, y, '#FF9A8A'); X.cell(x, y + 1, g[0]); }
  if (v === 2) { const x = 3 + r.int(9), y = 3 + r.int(9); X.cell(x, y, '#9A9A9A'); X.cell(x + 1, y, '#B4B4B0'); X.cell(x, y + 1, '#5E5E5E'); X.cell(x + 1, y + 1, '#5E5E5E'); }
  const top = (gx, gy) => { const t = n(gx, gy, 1); return t < 0.13 ? g[1] : t < 0.2 ? g[3] : g[2]; };
  const side = (dx, dep) => {
    const f = 2 + ((n(dx, 0, 2) * 3) | 0);          // fringe covers depth 0..f  (3-5 px, jagged bottom)
    if (dep <= f) {
      if (dep === f) return g[1];
      if (dep === 0) return g[3];
      return n(dx, dep, 3) < 0.2 ? g[1] : g[2];
    }
    if (dep === f + 1 && n(dx, 0, 8) < 0.55) return d[1];
    const t = n(dx, dep, 4);
    return t < 0.08 ? d[1] : t < 0.14 ? d[3] : t < 0.165 ? '#8A8680' : t < 0.19 ? d[0] : d[2];
  };
  return spec(X, top, side);
}

function mud(v, X) {
  const m = ramp(mix(col('mud'), '#3a2a1c', 0.25)), d = ramp(col('mud')), { r, n } = X;
  const wet = mix(col('mud'), col('bogw'), 0.4);
  for (let i = 0; i < 1 + (v >> 1) + (v === 3 ? 1 : 0); i++) {
    const cx = 3 + r.int(10), cy = 3 + r.int(10);
    blob(X, cx, cy, 1 + (r() < 0.5 ? 1 : 0), () => wet);
    X.cell(cx - 1, cy - 1, sh(wet, 2)); X.cell(cx, cy - 1, sh(wet, 3));
  }
  for (let i = 0; i < 3 + v; i++) X.cell(1 + r.int(14), 1 + r.int(14), m[0]);
  const top = (gx, gy) => { const t = n(gx, gy, 1); return t < 0.18 ? m[1] : t < 0.25 ? m[3] : m[2]; };
  const side = (dx, dep) => {
    if (dep < 2) return dep === 0 ? d[3] : d[2];
    if (dep < 4 && n(dx, dep, 2) < 0.6) return d[1];
    const t = n(dx, dep, 3);
    return t < 0.09 ? d[1] : t < 0.15 ? d[3] : t < 0.17 ? '#5E5E5E' : t < 0.2 ? d[0] : d[2];
  };
  return spec(X, top, side);
}

function stone(v, X) {
  const s = ramp(col('stone')), { r, n } = X;
  const tones = [s[2], s[2], s[3], mix(s[2], s[1], 0.5), s[1]];
  const tex = new Array(256);
  const ys = [0, 4 + r.int(3), 9 + r.int(3), 16];
  for (let ri = 0; ri < 3; ri++) {
    const xs = [0]; let x = -r.int(4);
    while (x < 16) { x += 4 + r.int(5); xs.push(Math.min(16, Math.max(x, xs[xs.length - 1] + 1))); }
    for (let si = 0; si < xs.length - 1; si++) {
      const tone = tones[(n(si, ri, 4) * tones.length) | 0];
      for (let gy = ys[ri]; gy < ys[ri + 1]; gy++) for (let gx = xs[si]; gx < xs[si + 1]; gx++) {
        let c = tone;
        if (gy === ys[ri] || (gx === xs[si] && xs[si] > 0)) c = s[0];
        else if (gy === ys[ri] + 1 || gx === xs[si] + 1) c = sh(tone, 1);
        else if (n(gx, gy, 5) < 0.05) c = s[1];
        tex[gy * 16 + gx] = c;
      }
    }
  }
  if (v >= 2) for (let i = 0; i < v; i++) X.cell(1 + r.int(14), 1 + r.int(14), s[0]);
  const side = brickSide(X, { ch: 8, bw: 11, tones: [s[2], s[2], s[3], s[1]], mortar: s[0], hi: s[3], grit: 0.07, gritTones: [s[1], s[3]], rowShift: true, stagger: false });
  return spec(X, (gx, gy) => tex[gy * 16 + gx] || s[2], side);
}

function rubble(v, X) {
  const s = ramp(col('rubble')), { r, n } = X;
  const n0 = [1, 2, 2, 3][v];
  for (let i = 0; i < n0 + 1; i++) crack(X, 1 + r.int(14), 1 + r.int(14), 5 + r.int(5), s[0], r() < 0.5 ? 1 : -1, r() < 0.5 ? 1 : -1);
  for (let i = 0; i < 4 + v; i++) {            // loose chips with a shadow cell
    const gx = 1 + r.int(13), gy = 1 + r.int(13);
    X.cell(gx, gy, s[4]); X.cell(gx + 1, gy, s[3]); X.cell(gx + 1, gy + 1, s[0]); X.cell(gx, gy + 1, s[1]);
  }
  const top = (gx, gy) => { const t = n(gx, gy, 1); return t < 0.2 ? s[1] : t < 0.34 ? s[3] : s[2]; };
  const side = (dx, dep) => {
    const course = (dep / 8) | 0, y = dep % 8;
    if (y === 7 && n(dx >> 2, course, 2) > 0.22) return s[0];
    if ((dx + dep) % 13 === 0 && n(course, dx >> 4, 3) < 0.4) return s[0];     // diagonal crack segments
    if ((dx - dep * 2 + 400) % 17 === 0 && n(course, dx >> 4, 4) < 0.3) return s[0];
    if (y === 0 && dep === 0) return s[3];
    const t = n(dx, dep, 5);
    return t < 0.12 ? s[1] : t < 0.2 ? s[3] : t < 0.215 ? s[4] : s[2];
  };
  return spec(X, top, side);
}

function snow(v, X) {
  const b = col('snow'), dim = '#C9E2F5', dim2 = '#A9C8E4', rk = ramp('#76808F'), { r, n } = X;
  for (let i = 0; i < 3 + v * 2; i++) {
    const gx = 1 + r.int(12), gy = 1 + r.int(13);
    X.cell(gx, gy, dim); X.cell(gx + 1, gy, dim);
    if (r() < 0.6) X.cell(gx, gy + 1, dim2);
    X.cell(gx - 1, gy - 1, '#FFFFFF');
  }
  const top = (gx, gy) => { const t = n(gx, gy, 1); return t < 0.07 ? dim : t < 0.1 ? '#FFFFFF' : b; };
  const side = (dx, dep) => {
    const f = 2 + ((n(dx >> 1, 0, 2) * 2.4) | 0);           // snow cap 3-4 px with a ragged edge
    if (dep <= f) return dep === f ? dim2 : dep === 0 ? '#FFFFFF' : (n(dx, dep, 3) < 0.15 ? dim : b);
    if (dep === f + 1) return rk[1];
    const t = n(dx, dep, 4), course = (dep / 10) | 0;
    if (dep % 10 === 9 && n(dx >> 2, course, 6) < 0.6) return rk[0];
    return t < 0.1 ? rk[1] : t < 0.18 ? rk[3] : t < 0.2 ? '#9AA6B6' : rk[2];
  };
  return spec(X, top, side);
}

function ice(v, X) {
  const b = ramp(col('ice')), crk = mix(col('ice'), '#2F66C8', 0.55), { r, n } = X;
  for (let i = 0; i < 1 + (v > 1 ? 2 : v); i++) crack(X, 2 + r.int(11), 2 + r.int(11), 5 + r.int(4), crk, r() < 0.5 ? 1 : -1, r() < 0.5 ? 1 : -1);
  for (let i = 0; i < 2 + (v >> 1); i++) streak(X, 3 + r.int(14), 10 + r.int(3), 3 + r.int(4), '#FFFFFF');
  for (let i = 0; i < 2; i++) streak(X, 8 + r.int(14), 8 + r.int(4), 2, b[4]);
  const top = (gx, gy) => { const t = n(gx, gy, 1); return t < 0.12 ? b[3] : t < 0.17 ? b[1] : b[2]; };
  const side = (dx, dep) => {
    const t = Math.min(1, ((dep / 6) | 0) / 9);
    let c = mix('#C8E8FF', '#4F86D6', t);
    if (dep === 0) return '#F1FAFF';
    if (dep % 6 === 5) c = mix(c, '#3A64B8', 0.4);
    else if (dep % 12 === 2 && n(dx >> 1, (dep / 12) | 0, 2) < 0.4) c = '#FFFFFF';
    else if (n(dx, dep, 3) < 0.05) c = sh(c, 1);
    return c;
  };
  return spec(X, top, side);
}

function scree(v, X) { return pebbly(v, X, col('scree')); }
function pebbly(v, X, base) {
  const s = ramp(base), { r, n } = X, pebbleTones = [s[1], s[2], s[3], s[4]];
  const count = 16 + v * 2;
  for (let i = 0; i < count; i++) {
    const gx = 1 + r.int(14), gy = 1 + r.int(14), w = 1 + r.int(2), h = 1 + (r() < 0.4 ? 1 : 0), t = pebbleTones[r.int(4)];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) X.cell(gx + x, gy + y, (x === w - 1 && y === h - 1 && (w > 1 || h > 1)) ? s[0] : t);
    X.cell(gx + w, gy + h, s[0]);
  }
  const top = (gx, gy) => { const t = n(gx, gy, 1); return t < 0.4 ? s[1] : t < 0.5 ? s[0] : mix(s[1], s[2], 0.5); };
  const side = (dx, dep) => {
    const row = (dep / 3) | 0, off = row & 1 ? 2 : 0, cx = ((dx + off) / 4) | 0, lx = (dx + off) % 4, ly = dep % 3;
    if (dep < 2) return dep === 0 ? s[3] : s[2];
    const t = pebbleTones[(n(cx, row, 2) * 4) | 0];
    if (lx === 0 || ly === 2) return s[0];
    if (lx === 3 && ly === 1) return s[1];
    return n(dx, dep, 3) < 0.06 ? s[3] : t;
  };
  return spec(X, top, side);
}

function sandSides(X, cap, base, strat) {
  const s = ramp(base), { n } = X;
  return (dx, dep) => {
    if (dep < 2) return dep === 0 ? sh(cap, 1) : cap;
    if (dep === 2 && n(dx, 0, 1) < 0.5) return cap;
    const course = (dep / 11) | 0;
    if (dep % 5 === 4 && n(dx >> 2, dep, 2) < 0.8) return strat ? s[1] : s[0];
    if (dep % 11 === 3 && n(dx >> 1, course, 3) < 0.55) return s[3];
    const t = n(dx, dep, 4);
    return t < 0.06 ? s[1] : t < 0.1 ? s[3] : s[2];
  };
}

function sand(v, X) {
  const s = ramp(col('sand')), { r, n } = X, ph = r() * 6, amp = 0.7 + v * 0.15;
  const top = (gx, gy) => {
    const rr = gy + Math.round(Math.sin(gx * 0.55 + ph) * amp);
    const m = mod(rr, 4);
    if (m === 0 && n(gx, gy, 2) < 0.85) return s[1];
    if (m === 1 && n(gx, gy, 3) < 0.4) return s[3];
    const t = n(gx, gy, 1);
    return t < 0.05 ? s[1] : t < 0.08 ? s[3] : s[2];
  };
  for (let i = 0; i < v; i++) X.cell(2 + r.int(12), 2 + r.int(12), '#F4EEC8');
  return spec(X, top, sandSides(X, col('sand'), '#CDBF86', true));
}

function dune(v, X) {
  const s = ramp(col('dune')), { r, n } = X, cx = 4 + r.int(9) + (v - 1), cy = 20 + r.int(8) + v * 2;
  const top = (gx, gy) => {
    const d = Math.sqrt((gx - cx) * (gx - cx) * 0.9 + (gy - cy) * (gy - cy) * 1.4) + (n(gx >> 1, gy >> 1, 2) - 0.5) * 0.9;
    const m = mod(Math.floor(d), 4);
    if (m === 0) return s[1];
    if (m === 1 && n(gx, gy, 3) < 0.7) return s[3];
    const t = n(gx, gy, 1);
    return t < 0.05 ? s[1] : s[2];
  };
  return spec(X, top, sandSides(X, col('dune'), '#D9BD76', false));
}

function pfloor(v, X) { return slabFloor(v, X, col('pfloor')); }
function slabFloor(v, X, base) {
  const s = ramp(base), { n } = X, ox = [0, 2, 5, 3][v], oy = [0, 3, 1, 6][v];
  const top = (gx, gy) => {
    const x = mod(gx + ox, 8), y = mod(gy + oy, 8);
    if (x === 0 || y === 0) return s[1];
    const tile = n(((gx + ox) / 8) | 0, ((gy + oy) / 8) | 0, 2);
    let c = tile < 0.3 ? mix(s[2], s[3], 0.35) : tile > 0.75 ? mix(s[2], s[1], 0.3) : s[2];
    if ((x === 1 || x === 7) && (y === 1 || y === 7)) c = s[1];            // darker corners
    else if (n(gx, gy, 3) < 0.05) c = s[3];
    else if (n(gx, gy, 4) < 0.04) c = s[1];
    return c;
  };
  const side = (dx, dep) => {
    if (dep === 0) return s[3];
    if (dep % 8 === 7) return s[0];
    if (((dx + ((dep / 8) & 1) * 5) % 12) === 11) return s[1];
    const t = n(dx, dep, 5);
    return t < 0.07 ? s[1] : t < 0.11 ? s[3] : s[2];
  };
  return spec(X, top, side);
}

// ---------------------------------------------------------------------------------------------------------------
// solids
// ---------------------------------------------------------------------------------------------------------------
function wall(v, X) {
  const s = ramp(col('wall')), { r, n } = X;
  const moss = ['#3C6424', '#4E7A2E', '#659A3A'], mossy = v >= 1;
  const tones = [s[2], s[2], s[3], s[1], mix(s[2], s[1], 0.5)];
  // top: staggered cobbles 4 cells tall
  const top = (gx, gy) => {
    const row = gy >> 2, y = gy & 3, xx = gx + (row & 1) * 2, ci = (xx / 4) | 0, x = xx & 3;
    if (y === 3 || x === 3) return s[0];
    let c = tones[(n(ci, row, 2) * tones.length) | 0];
    if (y === 0 || x === 0) c = sh(c, 1);
    return n(gx, gy, 3) < 0.05 ? s[1] : c;
  };
  if (mossy) for (let i = 0; i < v + 1; i++) blob(X, 2 + r.int(12), 2 + r.int(12), 1 + (v > 1 ? 1 : 0), (x, y) => moss[(n(x, y, 7) * 3) | 0]);
  const brick = brickSide(X, { ch: 6, bw: 8, tones, mortar: s[0], hi: s[3], grit: 0.07, gritTones: [s[1], s[3]] });
  const side = (dx, dep, face) => {
    if (v >= 2) {
      const cap = 1 + ((n(dx >> 1, 0, 8) * (v === 3 ? 4 : 3)) | 0);
      if (n(dx >> 2, 1, 9) < (v === 3 ? 0.8 : 0.5) && dep <= cap) return dep === cap ? moss[0] : moss[1 + (n(dx, dep, 10) < 0.3 ? 1 : 0)];
    }
    return brick(dx, dep, face);
  };
  return spec(X, top, side);
}

function rock(v, X) { return rockLike(v, X, col('rock')); }
function rockLike(v, X, base) {
  const s = ramp(base), { r, n } = X;
  // top: voronoi facets, lighter on their upper-left, darker on their lower-right
  const sites = [];
  for (let i = 0; i < 6; i++) sites.push([r() * 16, r() * 16, [s[1], s[2], s[2], s[3], mix(s[2], s[3], 0.5)][r.int(5)]]);
  const id = new Array(256);
  for (let gy = 0; gy < 16; gy++) for (let gx = 0; gx < 16; gx++) {
    let best = 0, bd = 1e9;
    for (let i = 0; i < sites.length; i++) { const d = (gx - sites[i][0]) ** 2 + (gy - sites[i][1]) ** 2; if (d < bd) { bd = d; best = i; } }
    id[gy * 16 + gx] = best;
  }
  const top = (gx, gy) => {
    const me = id[gy * 16 + gx], rt = gx < 15 ? id[gy * 16 + gx + 1] : me, dn = gy < 15 ? id[(gy + 1) * 16 + gx] : me;
    const lf = gx > 0 ? id[gy * 16 + gx - 1] : me, up = gy > 0 ? id[(gy - 1) * 16 + gx] : me;
    let c = sites[me][2];
    if (rt !== me || dn !== me) c = sh(c, -1);
    else if (lf !== me || up !== me) c = sh(c, 1);
    return n(gx, gy, 2) < 0.05 ? s[0] : c;
  };
  // sides: vertical strips 3-5 px wide with jagged splits
  const sid = []; let w = 0, cur = 0;
  for (let x = 0; x < 32; x++) { if (w <= 0) { cur++; w = 3 + r.int(3); } sid.push(cur); w--; }
  const side = (dx, dep) => {
    const j = n(0, (dep / 4) | 0, 3 + v), xs = Math.max(0, Math.min(31, dx + (j < 0.3 ? 1 : j > 0.7 ? -1 : 0)));
    const strip = sid[xs], start = xs === 0 || sid[xs - 1] !== strip;
    if (dep === 0) return s[3];
    if (start) return s[0];
    const lay = (dep / 14) | 0;
    if (dep % 14 === 0 && n(strip, lay, 4) < 0.45) return s[3];
    const t = n(strip, lay, 5);
    let c = t < 0.3 ? s[1] : t < 0.75 ? s[2] : s[3];
    if (n(dx, dep, 6) < 0.06) c = sh(c, -1);
    return c;
  };
  return spec(X, top, side);
}

const SROCK_BANDS = (() => {      // depth%24 -> tone index: 0 terracotta, 1 light, 2 dark, 3 cream
  const t = []; const run = (k, n) => { for (let i = 0; i < n; i++) t.push(k); };
  run(0, 5); run(1, 4); run(3, 1); run(2, 5); run(0, 3); run(1, 2); run(2, 2); run(3, 1); run(0, 1);
  return t;
})();
function srock(v, X) {
  const base = col('srock'), tones = [base, '#C97A4A', '#9E5230', '#E8D2B0'], s = ramp(base), { r, n } = X;
  const dust = mix(base, '#F0D8B8', 0.28);
  const top = (gx, gy) => {
    const t = n(gx, gy, 1);
    if (t < 0.1) return dust;
    if (t < 0.15) return s[1];
    return (gx + gy * 2 + v * 3) % 11 === 0 && n(gx >> 1, gy, 2) < 0.5 ? dust : s[2];
  };
  for (let i = 0; i < 2 + v; i++) streak(X, 6 + r.int(14), 8 + r.int(5), 2 + r.int(3), dust);
  const side = (dx, dep) => {
    if (dep === 0) return sh(tones[1], 1);
    const wob = n(dx >> 1, (dep / 24) | 0, 2) < 0.25 ? 1 : 0;      // slight wobble of the strata edges
    const t = SROCK_BANDS[(dep + wob) % 24];
    let c = tones[t];
    if (t !== 3 && n(dx, dep, 3) < 0.07) c = sh(c, n(dx, dep, 4) < 0.5 ? -1 : 1);
    return c;
  };
  return spec(X, top, side);
}

function pyr(v, X) {
  const g = ramp(col('pyr')), { r, n } = X;
  const top = (gx, gy) => {
    const e = Math.min(gx, gy, 15 - gx, 15 - gy);
    if (e < 2) return gx < 2 || gy < 2 ? (e === 0 ? g[4] : g[3]) : (e === 0 ? g[0] : g[1]);
    if ((gx + gy) % 4 === 0 || (gx - gy + 16) % 4 === 0) return g[1];
    return n(gx, gy, 2) < 0.1 ? g[3] : g[2];
  };
  for (let i = 0; i < 1 + (v >> 1); i++) { const gx = 4 + r.int(8), gy = 4 + r.int(8); X.cell(gx, gy, '#FFF3C0'); X.cell(gx + 1, gy - 1, g[4]); }
  const side = (dx, dep) => {
    const y = dep % 8, tx = dx & 15, course = (dep / 8) | 0;
    if (y === 7) return g[0];
    if (tx === (course & 1 ? 3 : 11)) return g[0];
    if (y === 0) return g[4];
    if (y === 1 || tx === (course & 1 ? 4 : 12)) return g[3];
    if (((tx + dep) & 15) === 0 && y <= 4) return '#FFF3C0';             // polished glint
    return n(dx, dep, 3) < 0.07 ? g[1] : g[2];
  };
  return spec(X, top, side);
}

const GLYPHS = [         // 3x5 hieroglyph-ish marks
  ['111', '101', '111', '010', '010'], ['010', '111', '010', '101', '101'], ['110', '011', '110', '011', '110'],
  ['111', '010', '111', '010', '111'], ['101', '101', '010', '101', '101'], ['011', '110', '010', '011', '110'],
];
function pwall(v, X) {
  const base = col('pwall'), s = ramp(base), { n } = X;
  const tones = [s[2], s[2], s[3], mix(s[2], s[1], 0.5)], ink = mix(base, '#3B2410', 0.62);
  const brick = brickSide(X, { ch: 6, bw: 12, tones, mortar: s[1], grit: 0.06, gritTones: [s[1], s[3]] });
  const T = ramp(sh(base, 1));
  const top = (gx, gy) => {
    const x = mod(gx + v * 2, 8), y = mod(gy + v * 3, 8);
    if (x === 0 || y === 0) return T[1];
    const t = n(((gx + v * 2) / 8) | 0, ((gy + v * 3) / 8) | 0, 2);
    return n(gx, gy, 3) < 0.06 ? T[3] : n(gx, gy, 4) < 0.05 ? T[1] : t < 0.3 ? T[3] : T[2];
  };
  const side = (dx, dep, face) => {
    const course = (dep / 6) | 0, y = dep % 6, bw = 12, shift = course & 1 ? 6 : 0, xx = dx + shift, bi = (xx / bw) | 0, bx = xx % bw;
    if (y < 5 && bx >= 4 && bx <= 6 && n(bi, course, 20 + (face === 'L' ? 0 : 1)) < 0.2 + v * 0.03) {
      const gl = GLYPHS[(n(bi, course, 22) * GLYPHS.length) | 0];
      if (gl[y][bx - 4] === '1') return ink;
    }
    return brick(dx, dep, face);
  };
  return spec(X, top, side);
}

// ---------------------------------------------------------------------------------------------------------------
// liquids (f = animation frame 0..3, every pattern is periodic in 4)
// ---------------------------------------------------------------------------------------------------------------
/** Drifting highlights shared by the water-like tops. */
function drift(n, gx, gy, f, rate) {
  const k = mod(gx - f, 4), mask = n(gx >> 2, gy, 12);
  if (mask > 0.62) return 0;
  if (n(k, gy, 11) < rate) return 2;                              // head
  if (n(mod(k + 3, 4), gy, 11) < rate * 0.8) return 1;           // fading trail
  return 0;
}
function liquidSide(X, f, base, deepCol, sheen) {
  const s = ramp(base), { n } = X;
  return (dx, dep) => {
    if (dep === 0) return s[3];
    const t = ((dep / 8) | 0) / 8;
    let c = mix(base, deepCol, Math.min(0.88, t));
    if (dep % 8 === 7) c = sh(c, -1);
    if (sheen && mod(dep - 2 * f, 8) === 0 && n(dx >> 2, (dep / 8) | 0, 3) < 0.55) c = sh(c, 1);
    return c;
  };
}
function water(v, X, f) {
  const b = ramp(col('water')), { n } = X;
  const top = (gx, gy) => {
    const d = drift(n, gx, gy, f, 0.13);
    if (d === 2) return b[3];
    if (d === 1) return mix(b[2], b[3], 0.45);
    if (n(gx, gy, 14) < 0.05 && ((n(gx, gy, 15) * 4) | 0) === f) return '#F1F8FF';
    const k = mod(gx - f, 4);
    if (n(k, gy, 13) < 0.08) return b[1];
    return n(gx, gy, 16) < 0.09 ? mix(b[2], b[1], 0.4) : b[2];
  };
  return spec(X, top, liquidSide(X, f, col('water'), '#16307A', true));
}
function deep(v, X, f) {
  const b = ramp(col('deep')), { n } = X;
  const top = (gx, gy) => {
    const m = mod(gx + gy - f + ((n(gx >> 2, gy >> 2, 2) * 2) | 0), 4);
    let c = m === 0 ? mix(b[2], b[3], 0.35) : m === 2 ? b[1] : b[2];
    if (n(gx, gy, 3) < 0.05) c = sh(c, -1);
    return c;
  };
  return spec(X, top, liquidSide(X, f, col('deep'), '#0C1A58', false));
}
function bogw(v, X, f) {
  const b = ramp(col('bogw')), { r, n } = X, scum = ['#5F6B3A', '#7C8A45', '#4A5530'];
  for (let i = 0; i < 2 + (v > 1 ? 2 : v); i++) blob(X, 2 + r.int(12), 2 + r.int(12), 1 + r.int(2), (x, y) => scum[(n(x, y, 7) * 3) | 0]);
  for (let i = 0; i < 3; i++) {                     // bubbles: appear, pop, vanish
    const gx = 2 + r.int(12), gy = 2 + r.int(12), st = mod(f - r.int(4), 4);
    if (st === 0) X.cell(gx, gy, '#CFE3DC');
    else if (st === 1) { X.cell(gx, gy, b[1]); X.cell(gx - 1, gy, '#EAF6EF'); X.cell(gx + 1, gy, '#EAF6EF'); X.cell(gx, gy - 1, '#BBD8D2'); }
  }
  const top = (gx, gy) => {
    const d = drift(n, gx, gy, f, 0.07);
    if (d === 2) return b[3];
    if (d === 1) return mix(b[2], b[3], 0.35);
    return n(gx, gy, 16) < 0.12 ? b[1] : b[2];
  };
  return spec(X, top, liquidSide(X, f, col('bogw'), '#1C3A3A', false));
}

// ---------------------------------------------------------------------------------------------------------------
// dungeon interiors (v0.3, builder A): one wall + one floor per biome
// ---------------------------------------------------------------------------------------------------------------
const MOSS = ['#3C6424', '#4E7A2E', '#659A3A'];
/** Jungle temple wall: grey-green ashlar, moss on top, vines hanging down the faces. */
function jwall(v, X) {
  const base = col('jwall'), st = ramp(mix(base, col('stone'), 0.45)), { r, n } = X;
  const tones = [st[2], st[2], st[3], st[1], mix(st[2], base, 0.5)];
  const brick = brickSide(X, { ch: 7, bw: 10, tones, mortar: st[0], hi: st[3], grit: 0.08, gritTones: [MOSS[0], MOSS[1]] });
  const vines = [];
  for (let i = 0; i < 32; i++) vines.push(n(i >> 1, 0, 30 + v) < 0.3 ? 6 + ((n(i, 1, 31) * 18) | 0) : (n(i >> 2, 2, 32) < 0.5 ? 2 : 0));
  for (let i = 0; i < 2 + v; i++) blob(X, 2 + r.int(12), 2 + r.int(12), 1 + (r() < 0.5 ? 1 : 0), (x, y) => MOSS[(n(x, y, 7) * 3) | 0]);
  const top = (gx, gy) => {
    const x = (gx + v * 3) & 7, y = (gy + v) & 7;
    if (x === 0 || y === 0) return st[0];
    return n(gx, gy, 3) < 0.06 ? MOSS[1] : n(gx >> 3, gy >> 3, 2) < 0.4 ? st[3] : st[2];
  };
  const side = (dx, dep, face) => {
    const vl = vines[dx];
    if (dep < vl) return n(dx, dep, 9) < 0.25 ? MOSS[2] : MOSS[(dx + dep) & 1];
    return brick(dx, dep, face);
  };
  return spec(X, top, side);
}
/** Jungle temple floor: worn slabs with moss in the joints and the odd leaf. */
function jfloor(v, X) {
  const S = slabFloor(v, X, col('jfloor')), { r } = X;
  for (let i = 0; i < 3 + v; i++) { const gx = 1 + r.int(14), gy = 1 + r.int(14); X.cell(gx, gy, MOSS[1]); X.cell(gx + 1, gy, MOSS[2]); }
  if (v & 1) { const gx = 3 + r.int(9), gy = 3 + r.int(9); X.cell(gx, gy, '#B8653A'); X.cell(gx + 1, gy, '#C97A4A'); X.cell(gx, gy + 1, '#9E5230'); }
  return S;
}
/** Swamp wall: vertical planks of wet timber, a cross-beam, moss creeping up from the bottom. */
function swall(v, X) {
  const w = ramp(col('swall')), { n } = X, moss = ['#46602A', '#5E7A3A', '#7A9A4A'];
  const top = (gx, gy) => {
    if ((gx & 3) === 3) return w[0];
    return n(gx >> 2, gy >> 2, 2) < 0.3 ? w[3] : n(gx, gy, 3) < 0.1 ? w[1] : w[2];
  };
  const side = (dx, dep) => {
    const p = (dx / 5) | 0, x = dx % 5;
    if (x === 4) return w[0];
    if (dep % 16 === 5 || dep % 16 === 6) return dep % 16 === 5 ? w[3] : w[1];          // cross-beam
    if (dep > 14 + ((n(p, 0, 6) * 8) | 0) && n(dx, dep, 7) < 0.55) return moss[(n(dx, dep, 8) * 3) | 0];
    const t = n(p, 1, 4 + v);
    let c = t < 0.33 ? w[1] : t > 0.66 ? w[3] : w[2];
    if (x === 0) c = sh(c, 1);
    if (n(dx, dep, 9) < 0.06) c = sh(c, -1);
    return c;
  };
  return spec(X, top, side);
}
/** Swamp floor: a boardwalk; dark water shows between the planks. */
function sfloor(v, X) {
  const s = ramp(col('sfloor')), { n } = X, gap = '#2E3E3A';
  const top = (gx, gy) => {
    const p = (gx / 4) | 0, x = gx & 3;
    if (x === 3) return gap;
    const off = (n(p, v, 2) * 16) | 0, y = mod(gy + off, 16);
    if (y === 0) return s[0];
    if (y === 1 && x === 1) return '#5E5E5E';                                              // nail
    const t = n(p, ((gy + off) / 16) | 0, 3);
    let c = t < 0.3 ? s[1] : t > 0.7 ? s[3] : s[2];
    if (x === 0) c = sh(c, 1);
    if (n(gx, gy, 4) < 0.07) c = sh(c, -1);
    return c;
  };
  const side = (dx, dep) => {
    if (dep < 3) return dep === 0 ? s[3] : s[2];
    if (dep < 5) return s[0];
    if (dx % 12 < 2) return sh(col('swall'), dx % 12 ? -1 : 0);                            // stilts
    return mix(col('bogw'), '#1C3A3A', Math.min(1, dep / 40));
  };
  return spec(X, top, side);
}
/** Castle dungeon wall: dark soot-stained brick with the odd iron ring. */
function cwall(v, X) {
  const s = ramp(col('cwall')), { n } = X;
  const tones = [s[2], s[2], s[3], s[1], mix(s[2], s[1], 0.5)];
  const brick = brickSide(X, { ch: 6, bw: 9, tones, mortar: s[0], hi: s[3], grit: 0.06, gritTones: [s[1], '#3A3A40'] });
  const top = (gx, gy) => {
    const row = gy >> 2, y = gy & 3, xx = gx + (row & 1) * 2, ci = (xx / 4) | 0, x = xx & 3;
    if (y === 3 || x === 3) return s[0];
    const c = tones[(n(ci, row, 2) * tones.length) | 0];
    return y === 0 || x === 0 ? sh(c, 1) : c;
  };
  const side = (dx, dep, face) => {
    const ring = v >= 2 && face === (v === 2 ? 'L' : 'R');
    if (ring) { const rx = dx - 13, ry = dep - 9, d2 = rx * rx + ry * ry; if (d2 >= 4 && d2 <= 8) return '#3A3A40'; }
    if (dep < 6 && n(dx >> 1, dep, 11) < 0.15) return '#2A2A30';                           // soot near the top
    return brick(dx, dep, face);
  };
  return spec(X, top, side);
}
/** Castle dungeon floor: dark irregular cobbles. */
function cfloor(v, X) {
  const s = ramp(col('cfloor')), { n } = X;
  const top = (gx, gy) => {
    const row = (gy + v) >> 2, y = (gy + v) & 3, xx = gx + (row & 1) * 2 + v, ci = (xx / 5) | 0, x = mod(xx, 5);
    if (y === 3 || x === 4) return s[0];
    const t = n(ci, row, 2);
    let c = t < 0.3 ? s[1] : t > 0.75 ? s[3] : s[2];
    if (y === 0 && x < 3) c = sh(c, 1);
    return n(gx, gy, 3) < 0.04 ? s[0] : c;
  };
  const side = (dx, dep) => { if (dep === 0) return s[3]; if (dep % 6 === 5) return s[0]; return n(dx, dep, 5) < 0.1 ? s[1] : s[2]; };
  return spec(X, top, side);
}
/** Mountain cave wall: dark faceted rock; some variants carry amethyst. */
function mwall(v, X) {
  const S = rockLike(v, X, col('mwall')), { r } = X;
  if (v >= 2) for (let i = 0; i < v; i++) { const gx = 2 + r.int(11), gy = 2 + r.int(11); X.cell(gx, gy, '#9A5CC6'); X.cell(gx + 1, gy, '#C9A0F0'); X.cell(gx, gy + 1, '#6A3C96'); }
  const side = S.left, sideR = S.right;
  if (v >= 2) {
    S.left = (dx, dep) => ((dx * 7 + dep * 3) % 41 === 0 ? '#B07ADE' : side(dx, dep));
    S.right = (dx, dep) => ((dx * 5 + dep * 7) % 43 === 0 ? '#8A52B6' : sideR(dx, dep));
  }
  return S;
}
/** Mountain cave floor: dark gravel with a damp patch. */
function mfloor(v, X) {
  const S = pebbly(v, X, col('mfloor')), { r } = X;
  if (v === 1 || v === 3) blob(X, 4 + r.int(8), 4 + r.int(8), 2, () => mix(col('mfloor'), col('water'), 0.35));
  return S;
}

// ---------------------------------------------------------------------------------------------------------------
const BUILDERS = { jwall, jfloor, swall, sfloor, cwall, cfloor, mwall, mfloor, grass, mud, stone, rubble, snow, ice, scree, sand, dune, pfloor, wall, rock, srock, pyr, pwall, water, bogw, deep };
const LIQUID = { water: 1, bogw: 1, deep: 1 };

/** Build the block sprite for a terrain key. variant 0..3.
 *  Returns a Sprite: 32 px wide frames, TILE_SPRITE_H tall, anchor (16, 8), frames = 1 (LIQUID_FRAMES for liquids).
 *  The diamond sits at the top; side faces run the full SIDE_MAX below it (the renderer crops what it needs).
 *  Unknown keys never throw: they get a plain block in the terrain colour (magenta-ish when the key is unknown). */
export function makeTile(key, variant = 0) {
  const v = mod(variant | 0, TILE_VARIANTS), build = BUILDERS[key];
  if (!build) {
    const d = TERRAIN[key];
    return blockSprite(d ? d.color : '#C040C0', { seed: strHash('tile/' + key) + v });
  }
  const opts = { sideSpeckle: 0, speckle: 0, seed: strHash('tile/' + key + '~' + v) };
  if (!LIQUID[key]) {
    const { c, g } = canvas(TILE_W, TILE_SPRITE_H);
    block(g, 0, 0, build(v, makeCtx(key, v)), opts);
    return makeSprite(c, HW, 8);
  }
  const { c, g } = canvas(TILE_W * LIQUID_FRAMES, TILE_SPRITE_H);
  for (let f = 0; f < LIQUID_FRAMES; f++) block(g, f * TILE_W, 0, build(v, makeCtx(key, v), f), opts);
  return makeSprite(c, HW, 8, LIQUID_FRAMES);
}
