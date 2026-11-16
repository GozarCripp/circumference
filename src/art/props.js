// art/props.js — procedural pixel-art props (everything that STANDS ON a ground block).
// Contract: docs/ARCHITECTURE.md §8.A7. Keys: tree, bush, stump, dtree, reed, pillar, cactus, pdoor, up, down,
// chest, campfire. Each sprite lives in BOX.prop (48 x 64 per frame, anchor 24,56 = centre of the tile's top face).
// Style: Minecraft block palette, light from the upper left, 3-5 tones from ramp()/shade(), chunky pixels,
// a 1px plum outline per sprite. Deterministic per (key, variant): all randomness comes from rng('prop/<key>~<v>').
// Each prop is drawn through a tiny "kit" bound to a frame offset, so multi-frame sprites (campfire) share code.
// The ground block and any ground shadow are NOT painted here; the renderer owns those.
import { PAL } from '../core/config.js';
import { canvas, makeSprite, outline, rect, px, rng, shade, ramp, mix } from './pixel.js';
import { BOX } from '../../assets/manifest.js';

/** Variants per prop key. */
export const PROP_VARIANTS = 4;
/** Frames for animated props (campfire flicker); 1 for the rest. */
export const PROP_FRAMES = { campfire: 4 };

const LEAF = { dark: '#1F4A14', base: PAL.leaves, light: '#3F8A2A', spark: '#5FA83A' };
const GLOW = '#FFE27A', GOLD = PAL.gold, PLUM = '#2a1050', VOID = PAL.outline;

// ---- drawing kit (all coordinates are frame-local) -------------------------------------------------
function kit(g, ox) {
  const P = (x, y, c) => px(g, ox + x, y, c);
  const R = (x, y, w, h, c) => rect(g, ox + x, y, w, h, c);
  const clear = (x, y, w, h) => g.clearRect(ox + x | 0, y | 0, w | 0, h | 0);
  /** Filled pixel ellipse, centre (cx,cy), radii rx,ry. */
  const E = (cx, cy, rx, ry, c) => {
    for (let y = -ry; y <= ry; y++) {
      const w = Math.round(rx * Math.sqrt(Math.max(0, 1 - (y * y) / (ry * ry + 0.01))));
      R(cx - w, cy + y, w * 2 + 1, 1, c);
    }
  };
  /** Bresenham line with a t x t square brush. */
  const line = (x0, y0, x1, y1, c, t = 1) => {
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy, x = x0, y = y0;
    for (let n = 0; n < 400; n++) {
      R(x, y, t, t, c);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
  };
  /** Rounded-square leaf cluster: lit top-left edge, shaded bottom-right edge, speckles. */
  const blob = (x, y, w, h, base, rnd, spark) => {
    const lo = shade(base, -1), hi = shade(base, 1);
    for (let j = 0; j < h; j++) {
      const ind = (j === 0 || j === h - 1) ? 2 : (j === 1 || j === h - 2) ? 1 : 0;
      const a = ind, b = w - 1 - ind;
      for (let i = a; i <= b; i++) {
        let c = base;
        if (j === 0 || i === a) c = hi;
        else if (j === h - 1 || i === b) c = lo;
        else { const q = rnd(); if (q < 0.1) c = hi; else if (q < 0.18) c = lo; else if (spark && q < 0.23) c = spark; }
        P(x + i, y + j, c);
      }
    }
  };
  /** Tapered trunk from (xb, yBot) up to (xt, yTop); light left, bark right, vertical grooves. */
  const trunk = (xb, xt, yTop, yBot, wb, wt, rnd, col = PAL.oak) => {
    const hi = shade(col, 1), lo = PAL.bark, mid = col;
    const n = yBot - yTop;
    const g1 = 1 + rnd.int(2), g2 = 1 + rnd.int(2);
    for (let y = yTop; y <= yBot; y++) {
      const t = n ? (y - yTop) / n : 1;
      const w = Math.max(2, Math.round(wt + (wb - wt) * t));
      const cx = Math.round(xt + (xb - xt) * t), x0 = Math.round(cx - w / 2);
      for (let i = 0; i < w; i++) {
        let c = i === 0 ? hi : i >= w - 2 ? lo : mid;
        if (i === g1 && w > 3 && (y >> 2) % 2 === 0) c = lo;
        if (i === w - 1 - g2 && w > 4 && ((y + 2) >> 2) % 2 === 0) c = shade(lo, 1);
        P(x0 + i, y, c);
      }
    }
  };
  /** Cactus-style panel: edges shaded, scattered pale spines. */
  const panel = (x, y, w, h, base, spine, rnd) => {
    const hi = shade(base, 1), lo = shade(base, -1), dk = shade(base, -2);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      let c = base;
      if (j === 0 || i === 1) c = hi;
      if (i === 0) c = lo;
      if (i === w - 1) c = dk; else if (i === w - 2) c = lo;
      if (j === h - 1) c = lo;
      P(x + i, y + j, c);
    }
    for (let j = 2; j < h - 1; j += 4) for (let i = 2 + ((j >> 2) & 1) * 2; i < w - 2; i += 4)
      P(x + i, y + j + rnd.int(2), spine);
  };
  return { P, R, clear, E, line, blob, trunk, panel };
}

// ---- individual props -----------------------------------------------------------------------------
function tree(k, r, v) {
  const H = [48, 52, 44, 53][v], lean = [0, 2, -2, 0][v], cw = [30, 34, 26, 32][v], tw = [5, 6, 4, 5][v];
  const top = 56 - H, cx = 24 + lean;
  // trunk with root flare
  k.trunk(24, cx, top + 12, 55, tw, Math.max(3, tw - 1), r);
  k.R(24 - ((tw / 2) | 0) - 2, 54, tw + 4, 2, PAL.bark);
  k.R(24 - ((tw / 2) | 0) - 1, 53, 1, 1, shade(PAL.oak, 0));
  k.P(24 - ((tw / 2) | 0), 50, '#2E6B1E'); k.P(24 - ((tw / 2) | 0), 51, '#3F8A2A'); // trunk vine
  const bw = (cw * 0.5) | 0, mw = cw - 10, fw = (cw * 0.46) | 0;
  // back clusters (dark), main (base), front clusters (light / base)
  k.blob(cx - (cw >> 1), top + 8, bw, 13, LEAF.dark, r);
  k.blob(cx + (cw >> 1) - bw, top + 6, bw, 14, LEAF.dark, r);
  k.blob(cx - (mw >> 1), top, mw, 15, LEAF.base, r, LEAF.spark);
  k.blob(cx - (cw >> 1) + 1, top + 9, fw, 12, LEAF.light, r, '#7BC24E');
  k.blob(cx + (cw >> 1) - 1 - fw, top + 11, fw, 11, LEAF.base, r, LEAF.spark);
  k.blob(cx - (fw >> 1) + 1, top + 14, fw, 9, shade(LEAF.base, 0), r, LEAF.spark);
  // hanging vines
  if (v === 1 || v === 3) {
    const vs = v === 1 ? [-9, 7, 12] : [-6, 10];
    for (const dx of vs) {
      const len = 4 + r.int(5), x = cx + dx, y0 = top + 20 + (Math.abs(dx) > 9 ? -1 : 2);
      for (let j = 0; j < len; j++) k.P(x, y0 + j, j === len - 1 ? '#5FA83A' : LEAF.base);
    }
  }
  // cocoa pods
  if (v === 2) {
    const y = top + 25, x = cx + 3;
    k.R(x, y, 3, 4, '#8B5A2B'); k.R(x, y, 1, 3, '#A8743C'); k.R(x + 2, y + 1, 1, 3, PAL.bark); k.P(x + 1, y - 1, PAL.bark);
  }
}

function bush(k, r, v) {
  const n = 5 + r.int(3), stem = '#2E6B1E', mid = PAL.fern, hi = '#7BC24E';
  for (let i = 0; i < n; i++) {
    const dir = (i / (n - 1)) * 2 - 1;               // -1 .. 1 across the fan
    const len = 7 + r.int(4) - Math.round(Math.abs(dir) * 2);
    const x0 = 24 + Math.round(dir * 3);
    const pts = [];
    for (let t = 0; t <= len; t++) {
      const x = x0 + Math.round(dir * t * 0.75), y = 55 - Math.round(t * 0.9 + 0.2) + Math.round((t * t) / (len * 7));
      pts.push([x, y]);
      k.P(x, y, t < 2 ? stem : mid);
    }
    pts.forEach(([x, y], t) => {                      // leaflets
      if (t > 1 && t < len && t % 2 === 0) { k.P(x - 1, y, hi); k.P(x + 1, y + 1, shade(mid, -1)); }
    });
    const [tx, ty] = pts[pts.length - 1]; k.P(tx, ty, hi);
  }
  k.R(21, 55, 7, 1, stem);
  if (v === 3) {                                       // tiny flower
    k.R(24, 44, 3, 3, '#FF7AB0'); k.P(25, 45, '#FFE27A'); k.P(24, 47, '#2E6B1E'); k.P(25, 48, '#2E6B1E');
  }
}

function stump(k, r, v) {
  const cx = 24, cyTop = 49, rx = 7, ry = 3, drop = 4, side = PAL.stump;
  // bottom cap + body
  k.E(cx, cyTop + drop, rx, ry, shade(side, -1));
  k.R(cx - rx, cyTop, rx * 2 + 1, drop, side);
  for (let y = cyTop; y < cyTop + drop + 3; y++) {      // light left, shaded right
    k.P(cx - rx, y, shade(side, 1)); k.P(cx - rx + 1, y, shade(side, 1));
    k.P(cx + rx, y, shade(side, -2)); k.P(cx + rx - 1, y, shade(side, -1)); k.P(cx + rx - 2, y, shade(side, -1));
  }
  for (let i = -4; i <= 4; i += 3) for (let y = cyTop + 2; y < cyTop + drop + 2; y++) // bark grooves
    if ((y + i) % 3 !== 0) k.P(cx + i, y + (Math.abs(i) > 3 ? 0 : 1), shade(side, -2));
  // top face with rings
  k.E(cx, cyTop, rx, ry, shade(PAL.oak, 1));
  k.E(cx, cyTop, rx - 2, ry - 1, mix(PAL.oak, '#E7C894', 0.55));
  k.E(cx, cyTop, 3, 1, shade(PAL.oak, 0));
  k.P(cx, cyTop, shade(PAL.bark, 1));
  k.R(cx - rx, cyTop, 1, 1, shade(side, 0)); k.R(cx + rx, cyTop, 1, 1, shade(side, -1));
  if (v === 2) {                                        // mushroom beside the stump
    k.P(34, 54, '#E9E4D8'); k.P(34, 53, '#E9E4D8'); k.R(33, 51, 3, 2, '#D0312D'); k.P(33, 51, '#FF7A7A'); k.P(35, 52, '#E9E4D8');
  }
  if (v === 1) { k.P(15, 54, '#5FA83A'); k.P(16, 55, '#7BC24E'); k.P(14, 55, '#5FA83A'); } // grass tuft
  if (v === 3) { k.P(17, 52, '#2E6B1E'); k.P(17, 53, '#2E6B1E'); k.P(17, 54, '#3F8A2A'); }   // moss streak
}

function dtree(k, r, v) {
  const H = [46, 42, 50, 40][v], top = 56 - H, xt = 24 + [1, -2, 2, -1][v];
  const light = mix(PAL.deadwood, '#9A9488', 0.35), dark = PAL.bark;
  k.trunk(24, xt, top + 4, 55, 7, 3, r, light);
  k.R(20, 54, 9, 2, dark); k.P(19, 55, dark); k.P(29, 55, dark);
  const n = 3 + (v & 1);
  let moss = false;
  for (let i = 0; i < n; i++) {
    const ty = top + 6 + i * Math.floor((H - 18) / n), t = (ty - top - 4) / (H - 5);
    const sx = Math.round(xt + (24 - xt) * t), dir = i % 2 === 0 ? -1 : 1;
    const x1 = Math.max(5, Math.min(42, sx + dir * (5 + r.int(4)))), y1 = Math.max(4, ty - 3 - r.int(3));
    const x2 = Math.max(4, Math.min(43, x1 + dir * (3 + r.int(5)))), y2 = Math.max(3, y1 - 4 - r.int(5));
    k.line(sx, ty, x1, y1, dark, 2); k.line(sx, ty - 1, x1, y1 - 1, light, 1);
    k.line(x1, y1, x2, y2, dark, 2); k.line(x1, y1 - 1, x2, y2 - 1, shade(light, 0), 1);
    const x3 = Math.max(4, Math.min(43, x2 - dir * 3)), y3 = Math.max(3, y2 - 3);       // forked twig
    k.line(x2, y2, x3, y3, dark, 1);
    if (!moss && i === 1) {                                                 // hanging moss strand
      moss = true;
      for (let j = 1; j <= 6; j++) k.P(x1, y1 + 1 + j, j % 2 ? '#5E7A3A' : '#46602A');
      k.P(x1 + 1, y1 + 4, '#7A9A4A');
    }
  }
  k.line(xt - 1, top + 5, xt + 1, top - 1, dark, 2);                        // crown snag
  k.P(xt, top + 5, light);
  k.R(xt - 1, top - 1, 1, 1, light);
  k.P(21, 50, shade(dark, 1)); k.P(26, 44, shade(dark, 1)); k.P(22, 38, shade(dark, 1)); // knots
}

function reed(k, r, v) {
  const greens = [PAL.reed, '#7FA83A', '#B7DA5E'], dkG = '#5F8A2A';
  const n = 4 + r.int(3);
  for (let i = 0; i < n; i++) {
    const x = 24 - 8 + Math.round((i / (n - 1)) * 16) + r.int(2) - 1;
    const hgt = 8 + r.int(6), bend = r.int(3) - 1, col = greens[r.int(2)];
    for (let j = 0; j < hgt; j++) {
      const bx = x + Math.round(bend * (j / hgt) * 2);
      k.P(bx, 55 - j, j < 2 ? dkG : col);
      if (j === hgt - 1 && (i + v) % 2 === 0) { // cattail head
        k.R(bx, 55 - j - 1, 1, 4, PAL.stump); k.P(bx, 55 - j - 2, shade(PAL.stump, 1)); k.P(bx, 55 - j - 4, mix(PAL.stump, '#E7C894', 0.5));
      }
    }
  }
  // two-tone blades
  for (let i = 0; i < 3 + (v & 1); i++) {
    const dir = i % 2 ? 1 : -1, x = 24 + dir * (2 + i * 2), len = 6 + r.int(4);
    for (let j = 0; j < len; j++) k.P(x + Math.round(dir * j * 0.55), 55 - j, j % 3 === 2 ? greens[2] : dkG);
  }
  k.R(17, 55, 14, 1, dkG);
  if (v === 3) { k.P(30, 50, '#FFD23F'); k.P(29, 51, '#FFD23F'); }  // dragonfly-ish spark
}

function pillar(k, r, v) {
  const q = ramp(PAL.quartz), H = [42, 40, 26, 44][v], top = 56 - H;
  const slab = (x, y, w, h) => {
    k.R(x, y, w, h, q[2]);
    k.R(x, y, w, 1, q[4]); k.R(x, y, 1, h, q[3]); k.R(x + w - 3, y, 2, h, q[1]); k.R(x + w - 1, y, 1, h, q[0]);
    k.R(x, y + h - 1, w, 1, q[1]);
  };
  slab(16, 52, 15, 4);                                                    // plinth
  k.R(17, 51, 13, 1, q[3]);
  // fluted shaft x 19..28
  const sTop = v === 2 ? top : top + 5;
  for (let y = sTop; y < 52; y++) {
    for (let i = 0; i < 10; i++) {
      let c = i === 0 ? q[4] : i === 1 ? q[3] : i === 8 ? q[1] : i === 9 ? q[0] : q[2];
      if (i === 3 || i === 6) c = q[1];
      else if (i === 4) c = q[3];
      if ((y - 52) % 8 === 0) c = shade(c, -1);                            // drum seam
      k.P(19 + i, y, c);
    }
  }
  if (v === 2) {                                                          // ragged broken top + rubble
    for (let i = 0; i < 10; i++) { const d = 1 + ((i * 7 + 3) % 5); k.clear(19 + i, top, 1, d); }
    k.R(19, top + 4, 10, 1, q[1]);
    const bits = [[13, 54], [14, 55], [12, 55], [32, 54], [33, 55], [34, 56 - 1], [31, 52]];
    bits.forEach(([x, y], i) => k.R(x, y, i % 3 === 0 ? 3 : 2, i % 2 ? 2 : 1, i % 2 ? q[3] : q[1]));
    k.R(32, 51, 4, 3, q[2]); k.R(32, 51, 4, 1, q[4]); k.R(34, 51, 2, 3, q[1]);        // fallen drum chunk
    k.P(15, 53, '#5E5E5E'); k.P(33, 56, '#5E5E5E');
    return;
  }
  slab(16, top + 1, 15, 4);                                               // capital
  k.R(17, top, 13, 1, q[4]); k.R(17, top, 1, 1, '#FFFFFF');
  k.R(18, top + 5, 11, 1, q[1]);
  if (v === 1) {                                                          // chipped top
    k.clear(25, top, 6, 2); k.clear(28, top + 2, 3, 1); k.R(25, top + 2, 3, 1, q[1]); k.P(24, top + 1, q[1]);
    k.P(31, 55, q[3]); k.P(33, 55, q[2]); k.P(34, 54, q[1]);
  }
  if (v === 3) {                                                          // creeping vine
    const gs = [LEAF.base, LEAF.light, LEAF.dark];
    for (let y = top + 3, x = 20, d = 1, n = 0; y < 50; y++, n++) {
      k.P(x, y, gs[n % 3]); if (n % 3 === 0) { x += d; if (x > 25 || x < 19) d = -d; }
    }
    k.R(18, 44, 3, 2, LEAF.light); k.R(18, 46, 2, 1, LEAF.dark); k.P(22, 49, LEAF.light);
  }
}

function cactus(k, r, v) {
  const H = [32, 38, 34, 36][v], top = 56 - H, base = PAL.cactus, spine = '#E8F0B0';
  const arms = [[], [['R', 14]], [['R', 15], ['L', 10]], [['L', 14]]][v];
  for (const [side, dy] of arms) {
    const y = top + dy;
    if (side === 'R') { k.panel(27, y + 3, 6, 5, base, spine, r); k.panel(28, y - 5, 5, 9, base, spine, r); }
    else { k.panel(15, y + 3, 6, 5, base, spine, r); k.panel(15, y - 6, 5, 10, base, spine, r); }
  }
  k.panel(20, top, 8, H, base, spine, r);
  k.R(20, 55, 8, 1, shade(base, -2));
  k.P(19, 55, shade(base, -2)); k.P(28, 55, shade(base, -2));
  if (v === 3) {                                                          // pink flower on top
    k.R(22, top - 3, 5, 3, '#FF7AB0'); k.R(23, top - 4, 3, 1, '#FF9AC8'); k.P(24, top - 2, '#FFE27A'); k.P(22, top - 1, '#D0507F'); k.P(26, top - 1, '#D0507F');
  }
  if (v === 2) k.P(24, top - 1, '#FF7AB0');
}

function pdoor(k, r, v) {
  const gold = GOLD, hi = '#FFF3B0';
  const rows = [[33, 5], [38, 6], [44, 6], [50, 5]];
  const gblock = (x, y, w, h, i) => {
    k.R(x, y, w, h, i % 2 ? shade(GLOW, -0) : GLOW);
    if (i % 3 === 0) k.R(x + 1, y + 1, w - 3, h - 3, mix(GLOW, hi, 0.5));
    k.R(x, y, w, 1, hi); k.R(x, y, 1, h, hi);
    k.R(x + w - 1, y, 1, h, gold); k.R(x, y + h - 1, w, 1, gold);
    k.P(x + w - 2, y + h - 2, shade(gold, -1));
  };
  rows.forEach(([y, h], i) => { gblock(12, y, 6, h, i); gblock(30, y, 6, h, i + 1); });
  gblock(18, 33, 6, 5, 2); gblock(24, 33, 6, 5, 3);
  // opening: arch with stepped gradient toward a warm lit bottom
  const rowCol = y => y < 45 ? VOID : y < 50 ? '#220c3d' : y < 52 ? PLUM : y === 52 ? mix(PLUM, GLOW, 0.25) : y === 53 ? mix(PLUM, GLOW, 0.5) : mix(PLUM, GLOW, 0.8);
  for (let y = 38; y <= 54; y++) {
    const a = y === 38 ? 20 : y === 39 ? 19 : 18, b = y === 38 ? 27 : y === 39 ? 28 : 29;
    k.R(a, y, b - a + 1, 1, rowCol(y));
  }
  k.R(18, 39, 1, 16, shade(rowCol(45), -1)); k.R(29, 39, 1, 16, '#14081f');       // inner reveal
  k.P(22, 46, '#3a1a6a'); k.P(26, 48, '#3a1a6a'); k.P(24, 43, '#2a1050');         // faint depth specks
  // hieroglyphs on the lintel
  const gl = '#B08A20';
  if (v === 1) { k.R(20, 35, 8, 1, gl); k.P(22, 34, gl); k.P(25, 34, gl); k.P(23, 36, gl); k.P(24, 36, gl); }          // eye
  else if (v === 2) { k.R(23, 34, 2, 2, gl); k.R(23, 36, 2, 1, gl); k.R(21, 36, 6, 1, gl); k.P(23, 33, gl); k.P(24, 33, gl); } // ankh-ish
  else if (v === 3) { for (let i = 0; i < 8; i++) k.P(20 + i, 34 + (i % 2) * 2, gl); k.P(21, 35, gl); }
  // sandstone step in front
  k.R(14, 55, 20, 2, '#DDBF82'); k.R(14, 55, 20, 1, '#EBD39C'); k.R(14, 57, 20, 2, PAL.tombfloor); k.R(32, 57, 2, 2, shade(PAL.tombfloor, -1));
  k.R(21, 56, 6, 1, mix('#DDBF82', GLOW, 0.5));                                     // spill of light on the step
}

/** Isometric helpers for the stairs: a filled diamond, and a little cuboid whose base is centred on (cx, cy). */
function diamond(k, cx, cy, hw, hh, col) {
  for (let dy = -hh; dy <= hh; dy++) { const half = Math.round(hw * (1 - Math.abs(dy) / hh)); k.R(cx - half, cy + dy, half * 2 + 1, 1, col); }
}
function isoBox(k, cx, cy, hw, hh, h, top, left, right) {
  for (let dx = -hw; dx <= hw; dx++) {
    const y0 = cy - h + Math.round(hh * (1 - Math.abs(dx) / hw));
    k.R(cx + dx, y0, 1, h + 1, dx < 0 ? left : right);
  }
  diamond(k, cx, cy - h, hw, hh, top);
}

/** Stairs, drawn on the isometric grid so they can never be mistaken for a chest.
 *  up: three glowing sandstone steps climbing toward the back right.  down: a dark stairwell cut into the floor. */
function stairs(k, r, v, up) {
  const sand = PAL.sandstone, floor = PAL.tombfloor, glow = PAL.stairs;
  if (up) {
    const steps = [[31, 52, 11], [24, 55, 7], [17, 59, 3]];           // back (tallest) first
    steps.forEach(([cx, cy, h], i) => {
      const top = mix(sand, glow, 0.75 - i * 0.2);
      isoBox(k, cx, cy, 7, 3, h, top, shade(sand, -1), shade(sand, -2));
      diamond(k, cx, cy - h - 1, 4, 1, mix(top, '#FFFFFF', 0.45));    // lit tread
      for (let y = cy - h + 5; y < cy + 2; y += 4) { k.R(cx - 6, y, 3, 1, shade(sand, -2)); k.R(cx + 2, y + 1, 3, 1, shade(sand, -3)); }  // brick seams
    });
    k.P(31, 36, glow); k.P(33, 33, mix(glow, '#FFFFFF', 0.5)); k.P(28, 34, glow);                          // motes rising
  } else {
    diamond(k, 24, 56, 13, 6, shade(sand, 1));                         // raised rim
    diamond(k, 24, 57, 13, 6, sand);
    diamond(k, 24, 56, 13, 6, shade(sand, 1));
    diamond(k, 24, 56, 10, 4, VOID);                                   // the well
    diamond(k, 24, 57, 8, 3, '#150a22');
    // steps going down toward the front left, each darker than the last
    const tr = [[29, 54, mix(sand, glow, 0.5)], [26, 56, shade(sand, -1)], [23, 58, shade(floor, -1)], [20, 59, shade(floor, -3)]];
    tr.forEach(([x, y, c], i) => { k.R(x - 2, y - 1, 5 - (i > 2 ? 1 : 0), 1, c); k.R(x - 2, y, 4, 1, shade(c, -2)); });
    k.R(12, 55, 2, 1, mix(sand, glow, 0.6)); k.R(34, 55, 2, 1, mix(sand, glow, 0.6)); k.R(23, 50, 3, 1, mix(sand, glow, 0.8));   // glints on the rim
  }
}

function chest(k, r, v) {
  const wood = PAL.chest, hi = shade(wood, 1), lo = shade(wood, -1), dk = shade(wood, -2), band = PAL.bark;
  const bandCol = v === 2 ? mix(GOLD, band, 0.35) : band;
  const x = 15, w = 18;
  // body
  k.R(x, 49, w, 7, wood);
  for (let j = 51; j < 56; j += 2) k.R(x + 1, j, w - 2, 1, lo);                           // planks
  k.R(x, 49, 1, 7, hi); k.R(x + w - 3, 49, 2, 7, lo); k.R(x + w - 1, 49, 1, 7, dk); k.R(x, 55, w, 1, dk);
  k.R(x + 2, 49, 2, 7, bandCol); k.R(x + w - 5, 49, 2, 7, bandCol);
  k.P(x + 2, 49, shade(bandCol, 1));
  if (v === 1) {
    // OPEN / looted: lid tilted back (we see its inner face), empty dark interior, no glow
    k.R(x + 1, 38, w - 2, 7, lo);
    k.R(x + 2, 39, w - 4, 5, mix(dk, PLUM, 0.5));
    k.R(x + 1, 38, w - 2, 1, hi); k.R(x + 1, 38, 1, 7, hi); k.R(x + w - 2, 38, 1, 7, dk);
    k.R(x + 2, 38, 2, 7, bandCol); k.R(x + w - 5, 38, 2, 7, bandCol);
    k.R(x, 45, w, 1, dk);
    k.R(x + 1, 45, w - 2, 1, band);
    k.R(x + 1, 46, w - 2, 3, '#150a22');                                  // empty interior
    k.R(x + 2, 46, w - 4, 1, '#2a1a3a');
    k.R(x, 46, 1, 3, hi); k.R(x + w - 1, 46, 1, 3, dk);
    k.P(x + 8, 48, '#3a2a4a'); k.P(x + 11, 47, '#3a2a4a');                // dust
    k.R(x + 8, 50, 2, 2, mix(GOLD, band, 0.5)); k.P(x + 8, 50, band);       // broken clasp, no glow
  } else {
    // lid with rounded top
    k.R(x, 43, w, 6, hi);
    k.R(x + 2, 42, w - 4, 1, hi); k.R(x + 4, 41, w - 8, 1, shade(wood, 2));
    k.R(x + 1, 43, w - 2, 5, wood);
    k.R(x + 2, 42, w - 4, 1, hi);
    k.R(x + w - 3, 43, 2, 6, lo); k.R(x + w - 1, 43, 1, 6, dk);
    k.R(x, 43, 1, 6, hi);
    k.R(x + 2, 43, 2, 6, bandCol); k.R(x + w - 5, 43, 2, 6, bandCol);
    k.R(x + 2, 42, 2, 1, bandCol); k.R(x + w - 5, 42, 2, 1, bandCol);
    k.R(x, 48, w, 1, band);                                               // lid seam
    // gold clasp
    k.R(23, 46, 4, 5, GOLD); k.R(23, 46, 4, 1, '#FFE27A'); k.R(26, 47, 1, 4, shade(GOLD, -1)); k.P(24, 48, VOID); k.P(24, 49, VOID);
    if (v === 3) { k.P(17, 41, LEAF.light); k.P(18, 41, LEAF.base); k.P(16, 42, LEAF.base); k.P(30, 42, LEAF.light); k.P(31, 43, LEAF.dark); } // mossy
    if (v === 2) { k.P(17, 44, GOLD); k.P(30, 44, GOLD); k.P(17, 54, GOLD); k.P(30, 54, GOLD); }        // gold rivets
  }
}

function campfire(k, r, v, f) {
  const stoneC = PAL.stone;
  const stone = (x, y, i) => {
    k.R(x - 2, y - 1, 4, 3, shade(stoneC, i % 3 - 1));
    k.R(x - 2, y - 1, 3, 1, shade(stoneC, 2)); k.R(x + 1, y, 1, 2, shade(stoneC, -2)); k.R(x - 2, y + 1, 3, 1, shade(stoneC, -1));
  };
  const ring = [];
  for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2 + 0.3; ring.push([Math.round(24 + 11 * Math.cos(a)), Math.round(53 + 4.5 * Math.sin(a)), Math.sin(a)]); }
  ring.filter(s => s[2] <= 0).forEach(([x, y], i) => stone(x, y, i));                  // back stones
  // crossed logs
  const logA = PAL.stump, logB = PAL.oak;
  k.line(16, 55, 31, 50, shade(logA, -1), 3); k.line(16, 54, 31, 49, logA, 1);
  k.line(17, 50, 32, 55, shade(logB, -1), 3); k.line(17, 49, 32, 54, logB, 1);
  k.R(15, 53, 2, 3, mix(PAL.oak, '#E7C894', 0.5)); k.R(31, 53, 2, 3, mix(PAL.oak, '#E7C894', 0.5));
  k.R(30, 49, 2, 3, shade(logA, 1));
  // flames: distinct silhouette per frame
  const H = [9, 12, 8, 11][f], W = [5, 5, 6, 5][f], lean = [0, 2, -1, -2][f];
  const flame = (cx, by, h, w, ln, tip) => {
    for (let j = 0; j < h; j++) {
      const t = j / Math.max(1, h - 1), half = Math.max(0, Math.round(w * Math.pow(1 - t, 0.85))), off = Math.round(ln * t * t);
      const y = by - j;
      k.R(cx + off - half, y, half * 2 + 1, 1, '#D0312D');
      if (j < h * 0.85 && half >= 1) k.R(cx + off - half + 1, y, Math.max(1, half * 2 - 1), 1, '#FF6A00');
      if (j < h * 0.6 && half >= 2) k.R(cx + off - half + 2, y, Math.max(1, half * 2 - 3), 1, '#FFD23F');
      if (j === h - 1) k.P(cx + off, y, tip);
    }
  };
  flame(24, 51, H, W, lean, '#FF6A00');
  if (f === 0 || f === 3) flame(18 + (f === 3 ? 1 : 0), 51, 5, 2, -1, '#D0312D');
  if (f === 1 || f === 2) flame(30 - (f === 2 ? 1 : 0), 51, 5 + (f === 2 ? 1 : 0), 2, 1, '#D0312D');
  k.R(20, 51, 9, 1, '#FF6A00'); k.R(22, 51, 5, 1, '#FFD23F');
  // embers
  const eSets = [[[19, 41], [30, 44]], [[28, 40], [17, 45]], [[21, 39], [31, 43]], [[26, 38], [18, 42]]];
  const sh = (v & 1) ? 1 : 0;
  eSets[f].forEach(([x, y], i) => k.P(x + (sh && i ? 1 : 0), y, i ? '#FF6A00' : '#FFD23F'));
  ring.filter(s => s[2] > 0).forEach(([x, y], i) => stone(x, y, i + 1));              // front stones
}

function post(k) {
  k.R(22, 44, 4, 12, PAL.oak); k.R(22, 44, 1, 12, shade(PAL.oak, 1)); k.R(25, 44, 1, 12, PAL.bark);
  k.R(21, 55, 6, 1, PAL.bark);
}

// ---- v0.3 dungeons (builder A): entrances per biome, locked/open doors, key, traps -------------------------------
/** The dark doorway shared by every entrance: an arch from (x0..x1, yTop) down to y 54 fading to a warm glow. */
function doorway(k, x0, x1, yTop, glowCol = GLOW) {
  const rowCol = y => y < yTop + 7 ? VOID : y < yTop + 12 ? '#220c3d' : y < 52 ? PLUM : y === 52 ? mix(PLUM, glowCol, 0.25) : y === 53 ? mix(PLUM, glowCol, 0.5) : mix(PLUM, glowCol, 0.8);
  for (let y = yTop; y <= 54; y++) {
    const inset = y === yTop ? 2 : y === yTop + 1 ? 1 : 0;
    k.R(x0 + inset, y, x1 - x0 + 1 - 2 * inset, 1, rowCol(y));
  }
  k.R(x1, yTop + 1, 1, 54 - yTop, '#14081f');
}
/** A wall of front-facing blocks (rows of bricks) over x0..x1, y0..y1, lit from the upper left. */
function blockWall(k, x0, y0, x1, y1, base, bw = 6, bh = 5) {
  const hi = shade(base, 1), lo = shade(base, -1), dk = shade(base, -2);
  for (let y = y0, row = 0; y <= y1; y += bh, row++) {
    const off = row & 1 ? bw >> 1 : 0;
    for (let x = x0 - off; x <= x1; x += bw) {
      const a = Math.max(x0, x), b = Math.min(x1, x + bw - 1), h = Math.min(bh, y1 - y + 1);
      if (b < a) continue;
      k.R(a, y, b - a + 1, h, (row + ((x / bw) | 0)) % 3 === 0 ? shade(base, 0) : base);
      k.R(a, y, b - a + 1, 1, hi); k.R(a, y, 1, h, hi);
      k.R(b, y, 1, h, lo); k.R(a, y + h - 1, b - a + 1, 1, dk);
    }
  }
}
function ddoorJungle(k, r, v) {
  const st = mix('#5E7A4A', PAL.stone, 0.45);
  blockWall(k, 11, 30, 36, 55, st, 6, 5);
  doorway(k, 18, 29, 38, '#7BC24E');
  k.R(10, 28, 28, 3, shade(st, 1)); k.R(10, 30, 28, 1, shade(st, -2));                       // lintel slab
  for (let i = 0; i < 6; i++) k.blob(8 + i * 5 - (i & 1), 22 + ((i * 3) % 4), 7, 6, i & 1 ? LEAF.base : LEAF.light, r, LEAF.spark);   // canopy on top
  for (const x of [13, 16, 31, 34]) { const len = 6 + r.int(10); for (let j = 0; j < len; j++) k.P(x + (j > 6 ? 1 : 0), 30 + j, j % 3 ? LEAF.base : LEAF.light); }  // vines
  if (v === 1 || v === 3) { k.R(21, 31, 6, 4, shade(st, -1)); k.P(22, 32, GLOW); k.P(25, 32, GLOW); k.R(22, 34, 4, 1, VOID); }          // idol face
  if (v === 2) { k.P(12, 54, '#FF7AB0'); k.P(35, 53, '#FFE27A'); }
}
function ddoorSwamp(k, r, v) {
  const wood = PAL.oak, w = ramp(mix(wood, PAL.mud, 0.35)), thatch = ['#8A7A3A', '#A8964A', '#6E6230'];
  for (let x = 12; x <= 35; x++) {                                                             // plank walls
    const p = ((x - 12) / 4) | 0, edge = (x - 12) % 4 === 3;
    k.R(x, 36, 1, 19, edge ? w[0] : [w[1], w[2], w[3]][(p * 7 + v) % 3]);
  }
  k.R(12, 36, 24, 1, w[3]); k.R(12, 44, 24, 1, w[0]);
  for (let y = 22; y <= 36; y++) {                                                             // thatched roof
    const half = Math.round((y - 20) * 1.15);
    for (let x = 24 - half; x <= 24 + half; x++) k.P(x, y, thatch[(x * 3 + y * 5 + (x >> 2)) % 3]);
  }
  k.R(6, 36, 36, 1, thatch[2]);
  doorway(k, 20, 27, 41, '#9BC44A');
  k.R(19, 41, 1, 14, w[0]); k.R(28, 41, 1, 14, w[0]);
  if (v !== 1) { k.R(30, 39, 3, 3, '#FFE27A'); k.P(31, 40, '#FFF3B0'); }                        // lit window
  for (const x of [8, 10, 38, 40]) for (let j = 0; j < 6 + (x & 3); j++) k.P(x, 55 - j, j < 2 ? '#5F8A2A' : PAL.reed);  // reeds
  if (v === 2) { k.R(16, 50, 3, 4, '#5E5E5E'); k.R(16, 50, 3, 1, '#8C8C8C'); }                  // bucket
}
function ddoorCastle(k, r, v) {
  const st = PAL.stone;
  blockWall(k, 10, 26, 37, 55, st, 7, 5);
  for (let x = 10; x <= 34; x += 6) blockWall(k, x, 20, x + 3, 25, st, 4, 3);                 // crenellations
  doorway(k, 17, 30, 36);
  const bars = '#5E5E5E', barHi = PAL.iron, raised = v === 1 ? 8 : 12;                         // portcullis, half up
  for (let x = 18; x <= 29; x += 3) k.R(x, 36, 1, raised, x === 18 ? barHi : bars);
  k.R(17, 36 + raised - 1, 14, 1, bars); k.R(17, 38, 14, 1, bars);
  for (let x = 18; x <= 29; x += 3) k.P(x, 36 + raised, barHi);
  if (v === 2) { k.R(12, 32, 4, 6, '#D0312D'); k.R(12, 32, 4, 1, '#E06060'); k.P(13, 34, GOLD); }   // banner
  if (v === 3) { k.R(31, 30, 1, 4, PAL.oak); k.R(30, 27, 3, 3, '#FF6A00'); k.P(31, 27, '#FFD23F'); } // torch
}
function ddoorMountain(k, r, v) {
  const rk = ramp('#7F7F7F'), snow = PAL.snow;
  k.E(24, 47, 17, 10, rk[1]);
  k.E(23, 45, 15, 9, rk[2]);
  for (let i = 0; i < 9; i++) { const x = 11 + i * 3, y = 40 + ((i * 5) % 7); k.R(x, y, 2, 2, rk[i % 2 ? 3 : 1]); }   // facets
  k.E(22, 38, 11, 4, snow); k.E(20, 37, 7, 2, '#FFFFFF');                                     // snow cap
  for (let y = 43; y <= 54; y++) {                                                             // cave mouth
    const half = Math.round(7 * Math.sqrt(Math.max(0, 1 - ((54 - y) / 11) ** 2)));
    k.R(24 - half, y, half * 2 + 1, 1, y < 47 ? VOID : y < 51 ? '#1a0f30' : mix(PLUM, '#A5D8FF', (y - 50) / 6));
  }
  for (const x of [19, 22, 26, 29]) { const len = 2 + ((x * 7) % 3); for (let j = 0; j < len; j++) k.P(x, 43 + j, j ? '#A5D8FF' : '#FFFFFF'); }   // icicles
  if (v === 2) { k.R(36, 50, 2, 6, PAL.oak); k.R(33, 47, 8, 3, PAL.oak); k.R(34, 48, 6, 1, '#F7FBFF'); }  // signpost
}
function ddoorDesert(k, r, v) {
  const ss = PAL.sandstone;
  blockWall(k, 13, 40, 34, 55, ss, 7, 4);
  k.R(11, 34, 26, 4, shade(ss, 1)); k.R(11, 34, 26, 1, '#EBD39C'); k.R(11, 37, 26, 1, shade(ss, -2));   // lintel
  k.R(14, 38, 4, 2, shade(ss, -1)); k.R(30, 38, 4, 2, shade(ss, -1));
  doorway(k, 18, 29, 40);
  for (let i = 0; i < 4; i++) k.R(19 + i, 46 + i * 2, 10 - 2 * i, 1, mix(ss, PLUM, 0.3 + i * 0.15));  // steps going down
  for (const x of [8, 38]) { k.R(x - 1, 30, 3, 25, ss); k.R(x - 1, 30, 1, 25, '#EBD39C'); k.R(x + 1, 30, 1, 25, shade(ss, -2)); k.P(x, 29, GOLD); }  // obelisks
  const gl = '#9E7A30';
  if (v === 1) { k.R(21, 35, 6, 1, gl); k.P(22, 36, gl); k.P(25, 36, gl); }
  if (v === 3) for (let i = 0; i < 6; i++) k.P(20 + i * 2, 35 + (i & 1), gl);
}
function dlockDoor(k, r, v, open) {
  const st = PAL.cobble, wood = PAL.chest, band = PAL.bark;
  k.R(14, 24, 20, 32, st); k.R(14, 24, 20, 1, shade(st, 1)); k.R(14, 24, 1, 32, shade(st, 1)); k.R(33, 24, 1, 32, shade(st, -2));
  if (open) {
    doorway(k, 17, 30, 27);
    k.R(28, 28, 3, 27, shade(wood, -1)); k.R(28, 28, 1, 27, shade(wood, 1));                   // door swung inward
    return;
  }
  k.R(17, 27, 14, 28, wood);
  for (let x = 17; x <= 30; x += 3) k.R(x, 27, 1, 28, shade(wood, -1));
  k.R(17, 27, 1, 28, shade(wood, 1));
  for (const y of [31, 47]) { k.R(17, y, 14, 2, band); k.R(17, y, 14, 1, shade(PAL.iron, -1)); }
  k.R(21, 38, 6, 6, GOLD); k.R(21, 38, 6, 1, '#FFE27A'); k.R(26, 39, 1, 5, shade(GOLD, -1));      // padlock
  k.R(22, 35, 1, 3, PAL.iron); k.R(25, 35, 1, 3, PAL.iron); k.R(22, 34, 4, 1, PAL.iron);
  k.P(23, 40, VOID); k.P(23, 41, VOID);
}
function dkey(k, r, v) {
  const g = GOLD, hi = '#FFF3B0', lo = shade(GOLD, -2);
  k.E(18, 50, 3, 2, g); k.E(18, 50, 1, 0, VOID); k.P(17, 49, hi);                             // bow
  k.line(21, 51, 31, 46, g, 2); k.line(21, 51, 31, 46, hi, 1);                                 // shaft
  k.R(28, 48, 2, 3, g); k.R(31, 47, 2, 3, lo);                                                 // teeth
  k.P(31, 42, '#FFFFFF'); k.P(30, 43, GLOW); k.P(32, 43, GLOW);                                 // glint
}
function trapPlate(k, r, v) {                     // deliberately subtle; drawn without the outline
  const seam = 'rgba(30,18,40,0.32)', hole = 'rgba(20,10,30,0.55)';
  for (let i = -6; i <= 6; i++) { const w = 6 - Math.abs(i); k.P(24 - 2 * w, 56 + i / 2 | 0, seam); }
  for (const [x, y] of [[21, 55], [26, 55], [23, 57], [24, 53]]) k.P(x + (v & 1), y, hole);
}
function trapSpikes(k, r, v) {
  const iron = PAL.iron, lo = shade(PAL.iron, -2);
  diamond(k, 24, 56, 9, 4, shade(PAL.cobble, -1));
  for (const [x, y, h] of [[18, 56, 6], [22, 54, 8], [26, 55, 7], [30, 57, 6], [24, 58, 7], [20, 59, 5], [28, 59, 5]]) {
    for (let j = 0; j < h; j++) { const w = Math.max(0, ((h - j) / 3) | 0); k.R(x - w, y - j, w * 2 + 1, 1, j === h - 1 ? '#FFFFFF' : w ? lo : iron); k.P(x - w, y - j, iron); }
  }
  if (v & 1) { k.P(21, 58, '#D0312D'); k.P(22, 58, '#A02020'); }
}

const DRAWERS = {
  tree, bush, stump, dtree, reed, pillar, cactus, pdoor, chest,
  ddoor0: ddoorJungle, ddoor1: ddoorSwamp, ddoor2: ddoorCastle, ddoor3: ddoorMountain, ddoor4: ddoorDesert,
  dlock: (k, r, v) => dlockDoor(k, r, v, false), dopen: (k, r, v) => dlockDoor(k, r, v, true),
  dkey, trap: trapPlate, trapd: trapSpikes,
  up: (k, r, v) => stairs(k, r, v, true), down: (k, r, v) => stairs(k, r, v, false),
};

/** Build a prop sprite. Box: BOX.prop (48 x 64, anchor 24,56 = where the prop meets the centre of its tile).
 *  Outlined with outline() (art stays >= 3px from each frame edge so outlines never bleed).
 *  Does NOT include the ground block or a ground shadow. Deterministic per (key, variant). */
export function makeProp(key, variant = 0) {
  const v = ((variant | 0) % PROP_VARIANTS + PROP_VARIANTS) % PROP_VARIANTS;
  const frames = PROP_FRAMES[key] || 1, B = BOX.prop, { c, g } = canvas(B.w * frames, B.h);
  for (let f = 0; f < frames; f++) {
    const k = kit(g, f * B.w), r = rng('prop/' + key + '~' + v);
    if (key === 'campfire') campfire(k, r, v, f);
    else (DRAWERS[key] || post)(k, r, v);
  }
  if (key !== 'trap') outline(c);                    // a hidden trap must not wear a bright outline
  return makeSprite(c, B.ax, B.ay, frames);
}
