// art/creatures.js — procedural placeholder sprites for every enemy, rare, boss, shark and friendly NPC.
// Contract: docs/ARCHITECTURE.md §8.A8.   Exports: makeEnemy(id), makeNPC(id), enemyColor(e).
//
// HOW IT WORKS
//   * One generator per body archetype (bestiary ARCHETYPES). Generators draw on a small LOGICAL grid: x is relative to
//     the sprite centre (+x = front, sprites face RIGHT), y is relative to the feet (negative = up). A drawing context
//     (makeCtx) scales logical units to real pixels, so one generator serves 0.8x / 1x / 1.2x creatures, 1.23x rares
//     and 2.2x bosses. Every generator returns "anchors" (head, chin, hand, torso) so accessories (tie, mic,
//     briefcase, crown, ...) can be pinned to any body plan: those accessories ARE the jokes.
//   * Shading follows the house style: light from the upper left, shade()/ramp() from pixel.js, plum-drifting shadows.
//   * Everything is deterministic: rng('enemy/' + id) drives proportions; Math.random() is never called.
//   * Missing archetypes are inferred from the creature's name, unknown ids give a generic outlined blob.
//   * A fit loop shrinks a creature until it clears the canvas border, so nothing is ever clipped.
//   * Dave's hand-drawn PNGs replace all of this through assets/manifest.js (no code change).
import { enemyById, ARCHETYPES } from '../data/bestiary.js';
import { canvas, makeSprite, outline, rect, px, hsl, shade, ramp, mix, rng } from './pixel.js';
import { BOX } from '../../assets/manifest.js';
import { PAL } from '../core/config.js';

const OL = PAL.outline, GOLD = PAL.gold, RED = '#D0312D', CREAM = '#FFF3D0';
const ARCH_SET = new Set(ARCHETYPES);

// ====================================================================================================
// colour helpers
// ====================================================================================================
const SHC = new Map();
/** memoised shade() */
const sh = (c, k) => { const key = c + k; let v = SHC.get(key); if (!v) { v = shade(c, k); SHC.set(key, v); } return v; };

/** Classic enemy colour: bosses '#ffff44', sharks '#99bbdd', the rest hsl((t*47 + b*90) % 360, 95%, 74%). */
export function enemyColor(e) {
  if (e.ai === 'boss') return '#ffff44';
  if (e.b < 0) return '#99bbdd';
  return hsl((e.t * 47 + e.b * 90) % 360, 95, 74);
}

// ====================================================================================================
// drawing context
// ====================================================================================================
/** Creates a scaled drawing context. (ox, oy) = pixel position of logical (0,0) (the feet), S = pixels per logical unit.
 *  `st` (shared state) holds the bounds of everything drawn and the list of eyes. */
function makeCtx(g, ox, oy, S, st = { b: { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 }, eyes: [] }) {
  const X = x => Math.round(ox + x * S), Y = y => Math.round(oy + y * S);
  const touch = (x0, y0, x1, y1) => { const b = st.b; if (x0 < b.x0) b.x0 = x0; if (y0 < b.y0) b.y0 = y0; if (x1 > b.x1) b.x1 = x1; if (y1 > b.y1) b.y1 = y1; };
  const put = (x, y, c) => { px(g, x, y, c); touch(x, y, x, y); };
  const fill = (a, b, w, h, c) => { rect(g, a, b, w, h, c); touch(a, b, a + w - 1, b + h - 1); };
  const c = { g, ox, oy, S, st, X, Y, put, fill, eyes: st.eyes };

  /** scaled rect, flat colour */
  c.R = (x, y, w, h, col) => { const a = X(x), b = Y(y), e = X(x + w), f = Y(y + h); fill(a, b, Math.max(1, e - a), Math.max(1, f - b), col); };
  /** scaled single logical pixel */
  c.P = (x, y, col) => c.R(x, y, 1, 1, col);
  /** exactly one real pixel at a logical position (fine detail that should not grow with scale) */
  c.p1 = (x, y, col) => put(X(x), Y(y), col);
  /** bevelled box: highlight top/left, shadow bottom/right */
  c.B = (x, y, w, h, col) => {
    const a = X(x), b = Y(y), ww = Math.max(1, X(x + w) - a), hh = Math.max(1, Y(y + h) - b);
    fill(a, b, ww, hh, col);
    if (ww >= 3 && hh >= 3) {
      fill(a, b, ww, 1, sh(col, 1)); fill(a, b, 1, hh, sh(col, 1));
      fill(a, b + hh - 1, ww, 1, sh(col, -1)); fill(a + ww - 1, b + 1, 1, hh - 1, sh(col, -1));
    }
  };
  /** shaded ellipse (light from upper left); flat=true for a single colour */
  c.O = (cx, cy, rx, ry, col, flat) => {
    const Xc = ox + cx * S, Yc = oy + cy * S, Rx = Math.max(0.7, rx * S), Ry = Math.max(0.7, ry * S);
    const x0 = Math.floor(Xc - Rx), x1 = Math.ceil(Xc + Rx), y0 = Math.floor(Yc - Ry), y1 = Math.ceil(Yc + Ry);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const nx = (x + 0.5 - Xc) / Rx, ny = (y + 0.5 - Yc) / Ry;
      if (nx * nx + ny * ny > 1) continue;
      let k = 0;
      if (!flat) { const l = -0.5 * nx - 0.7 * ny; k = l > 0.5 ? 1 : l > -0.2 ? 0 : l > -0.6 ? -1 : -2; }
      put(x, y, k ? sh(col, k) : col);
    }
  };
  /** polygon fill (even-odd scanline); pts = [[x,y],...] logical. */
  c.G = (pts, col) => {
    const P = pts.map(p => [ox + p[0] * S, oy + p[1] * S]);
    let y0 = 1e9, y1 = -1e9;
    for (const p of P) { if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
    for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
      const yy = y + 0.5, xs = [];
      for (let i = 0; i < P.length; i++) {
        const a = P[i], b = P[(i + 1) % P.length];
        if ((a[1] <= yy && b[1] > yy) || (b[1] <= yy && a[1] > yy)) xs.push(a[0] + (yy - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
      }
      xs.sort((m, n) => m - n);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const xa = Math.round(xs[i]), xb = Math.round(xs[i + 1]);
        if (xb > xa) fill(xa, y, xb - xa, 1, col);
      }
    }
  };
  /** thick line (Bresenham, square brush of size t logical units, min 1 px) */
  c.L = (x0, y0, x1, y1, col, t = 1) => {
    const th = Math.max(1, Math.round(t * S)), off = th >> 1;
    let a = X(x0), b = Y(y0); const e = X(x1), f = Y(y1);
    const dx = Math.abs(e - a), dy = -Math.abs(f - b), sx = a < e ? 1 : -1, sy = b < f ? 1 : -1;
    let err = dx + dy;
    for (let n = 0; n < 400; n++) {
      fill(a - off, b - off, th, th, col);
      if (a === e && b === f) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; a += sx; }
      if (e2 <= dx) { err += dx; b += sy; }
    }
  };
  /** a chain of discs along points (used for snakes, tails, necks). rad(i, n) -> radius; colf(i, n) -> colour */
  c.chain = (pts, rad, colf, flat = true) => {
    for (let i = 0; i < pts.length; i++) c.O(pts[i][0], pts[i][1], rad(i, pts.length), rad(i, pts.length), colf(i, pts.length), flat);
  };
  /** paint with `destination-over` so it appears BEHIND what is already drawn (cape, back wing) */
  c.under = fn => { const o = g.globalCompositeOperation; g.globalCompositeOperation = 'destination-over'; fn(); g.globalCompositeOperation = o; };
  /** child context with its own origin offset and extra scale, sharing bounds + eyes */
  c.sub = (dx, dy, k) => makeCtx(g, ox + dx * S, oy + dy * S, S * k, st);

  // ---- eyes ----------------------------------------------------------------------------------
  const es = Math.max(2, Math.round(2.6 * S));
  c.es = es;
  /** eye centred at logical (x, y). kind: normal | socket | glow | hollow */
  c.E = (x, y, kind = 'normal', tone = '#fff7b0') => {
    const e = { x: X(x) - (es >> 1), y: Y(y) - (es >> 1), kind, tone, s: es };
    st.eyes.push(e); drawEye(c, e);
    return e;
  };
  c.redrawEyes = () => { for (const e of st.eyes) drawEye(c, e); };
  return c;
}

function drawEye(c, e) {
  const { put, fill } = c, s = e.s, x = e.x, y = e.y, k = e.kind, pw = s >= 5 ? 2 : 1;
  if (k === 'normal' || k === 'soft') {
    fill(x, y, s, s, '#FFFFFF');
    if (s >= 4) { put(x, y, OL); put(x + s - 1, y, OL); put(x, y + s - 1, OL); put(x + s - 1, y + s - 1, OL); fill(x, y, s, 1, '#e6e0f0'); }
    fill(x + s - pw - (s >= 5 ? 1 : 0), y + ((s - pw + 1) >> 1), pw, pw, '#1A1023');
    if (k === 'normal') fill(x, y - 1, s, 1, '#3a2a48');                // heavy brow, keeps pale faces readable
  } else if (k === 'socket') {
    fill(x - 1, y - 1, s + 2, s + 2, '#1A1023');
    fill(x + (s >> 1), y + (s >> 1), pw, pw, e.tone);
  } else if (k === 'hollow') {
    fill(x, y, s, s + 1, '#1A1023');
    fill(x + s - pw, y + 1 + (s >> 1) - 1, pw, pw + (s >= 4 ? 1 : 0), '#9ff0ff');
  } else {                                                              // glow
    fill(x - 1, y - 1, s + 2, s + 2, e.tone);
    fill(x, y, s, s, '#FFFFFF');
    fill(x + s - pw, y + ((s - pw + 1) >> 1), pw, pw, '#7a2a00');
  }
}

// ====================================================================================================
// naming / spec helpers
// ====================================================================================================
const RX = (s) => new RegExp(s, 'i');
const INFER = [
  ['serpent', RX('snake|adder|serpent|worm|asp|sidewinder|hydra|kraken|cobra|python')],
  ['reptile', RX('frog|lizard|iguana|croc|gator|alligator|newt|toad|gecko')],
  ['ghost', RX('ghost|wraith|spectre|phantom|ghoul|wisp|specter|banshee')],
  ['skeleton', RX('skeleton|bonejangles|mummy|hollow man|lich')],
  ['bird', RX('bat\\b|parrot|toucan|bird|harpy|vulture|eagle|duck|pigeon|swarm|crow|owl')],
  ['bug', RX('spider|\\bant\\b|mosquito|scorpion|beetle|termite|moth|scarab|leech|fly\\b|wasp|bee\\b')],
  ['dragon', RX('dragon|wyrm|drake|whelp')],
  ['plant', RX('vine|fern|plant|tree|mushroom|shrub|bush')],
  ['blob', RX('pudding|slime|blob|ooze|jelly|gloop')],
  ['elemental', RX('elemental|flame|storm|dust devil|mirage')],
  ['object', RX('mimic|chair|chandelier|golem|\\blog\\b|toenail|rock')],
  ['fish', RX('shark|fish|catfish|eel|carp')],
  ['imp', RX('imp\\b|kobold|goblin|gremlin|fairy|sprite')],
  ['knight', RX('knight|guard|templar|paladin|armor|armour')],
  ['caster', RX('wizard|witch|shaman|mage|priest|cultist|hag|doctor|notary|necromancer')],
  ['brute', RX('ogre|troll|gorilla|hippo|yeti|giant|brute|gargoyle|snowman')],
  ['beast', RX('jaguar|rat\\b|wolf|goat|sloth|cat\\b|dog|bear|yak|jackal|coyote|ape\\b|sphinx|hyena')],
];
function inferArch(name) { for (const [a, re] of INFER) if (re.test(name)) return a; return 'biped'; }
const SIZES = { s: 0.8, m: 1, l: 1.2 };

// ====================================================================================================
// accessories (the jokes)
// ====================================================================================================
function hatStyle(name) {
  if (/wizard|witch|hag|notary|doctor|lich|shaman|priest|mage/i.test(name)) return 'cone';
  if (/jester/i.test(name)) return 'jester';
  if (/dwarf|miner/i.test(name)) return 'helmet';
  if (/pope/i.test(name)) return 'mitre';
  if (/bonejangles|mayor|butler|vampire|assassin/i.test(name)) return 'top';
  return 'fedora';
}
const headTop = a => a.head.y - a.head.ry;
const BOOKS = ['#3A5FCD', '#3FA34D', '#9A5CC6', '#B3322B'];

const ACC = {
  hat(c, a, K) {
    const H = a.head, hx = H.x, top = headTop(a), st = hatStyle(K.name);
    if (st === 'cone') {
      const col = '#5B3FA0';
      c.G([[hx - 5.5, top + 1.2], [hx + 5.5, top + 1.2], [hx + 1, top - 5], [hx + 3.5, top - 9.5], [hx - 1.5, top - 4.5]], col);
      c.R(hx - 6.5, top, 13, 1.6, sh(col, -1)); c.R(hx - 3, top - 1.5, 7, 1, GOLD); c.P(hx, top - 4, '#ffe27a'); c.P(hx + 2.5, top - 2, '#ffe27a');
      a.topY = Math.min(a.topY || 0, top - 9.5);
    } else if (st === 'jester') {
      c.G([[hx - 4, top + 1], [hx - 4.5, top - 3], [hx - 10, top - 6], [hx - 6, top - 1]], '#B3322B'); c.O(hx - 10, top - 6.5, 1.3, 1.3, GOLD, true);
      c.G([[hx + 4, top + 1], [hx + 4.5, top - 4], [hx + 9, top - 8], [hx + 7, top - 1]], '#3A5FCD'); c.O(hx + 9, top - 8.5, 1.3, 1.3, GOLD, true);
      c.R(hx - 5, top - 1, 10, 2.2, '#9A5CC6'); c.R(hx - 5, top - 0.5, 3, 1, GOLD);
      a.topY = Math.min(a.topY || 0, top - 9.5);
    } else if (st === 'helmet') {
      c.O(hx, top + 1.5, 5.5, 4, '#F0C030'); c.R(hx - 6, top + 1.5, 12, 1.4, '#C99A18'); c.R(hx + 2, top - 0.5, 2, 2, '#FFFFFF'); c.R(hx + 4, top, 3, 1, '#fff7b0');
      a.topY = Math.min(a.topY || 0, top - 3);
    } else if (st === 'mitre') {
      c.G([[hx - 4, top + 1], [hx + 4, top + 1], [hx + 3, top - 7], [hx, top - 5], [hx - 3, top - 7]], CREAM); c.R(hx - 0.5, top - 5, 1, 5, GOLD); c.R(hx - 2, top - 3, 4, 1, GOLD);
      a.topY = Math.min(a.topY || 0, top - 7);
    } else if (st === 'top') {
      c.R(hx - 6, top - 0.5, 12, 1.6, '#2b2233'); c.B(hx - 3.5, top - 7, 7, 7, '#2b2233'); c.R(hx - 3.5, top - 2.5, 7, 1.6, RED); c.p1(hx - 2, top - 5, '#5a4a68');
      a.topY = Math.min(a.topY || 0, top - 7);
    } else {
      c.R(hx - 6.5, top + 0.2, 13, 1.6, '#8F6A3A'); c.B(hx - 3.5, top - 4.5, 7, 5, '#B08A55'); c.R(hx - 3.5, top - 1.5, 7, 1.2, '#3a2418');
      a.topY = Math.min(a.topY || 0, top - 4.5);
    }
  },
  crown(c, a) {
    const H = a.head, hx = H.x, top = headTop(a), w = Math.max(5, Math.min(8, H.rx * 1.5));
    c.R(hx - w / 2, top - 1, w, 2.2, GOLD);
    c.R(hx - w / 2, top - 3.2, 1.4, 2.4, GOLD); c.R(hx - 0.7, top - 4.4, 1.5, 3.6, GOLD); c.R(hx + w / 2 - 1.4, top - 3.2, 1.4, 2.4, GOLD);
    c.R(hx - w / 2, top - 1, w, 0.8, sh(GOLD, 1)); c.P(hx - 0.2, top, RED); c.p1(hx - w / 2 + 1, top - 3, '#fff3d0');
    a.topY = Math.min(a.topY || 0, top - 4.4);
  },
  tie(c, a) {
    const x = a.chin.x, y = a.chin.y;
    c.R(x - 1.3, y, 2.6, 1.4, '#a02420'); c.G([[x - 1.2, y + 1.2], [x + 1.4, y + 1.2], [x + 1.8, y + 5], [x, y + 6.5], [x - 1.8, y + 5]], RED);
    c.R(x + 0.4, y + 1.5, 1, 3.5, '#a02420'); c.p1(x - 0.5, y + 2, '#ff7a70');
  },
  book(c, a, K) {
    const h = a.hand, col = BOOKS[K.r.int(BOOKS.length)];
    c.B(h.x - 3, h.y - 6, 6.5, 6, col); c.R(h.x + 3.5, h.y - 5.5, 1, 5, CREAM); c.R(h.x - 3, h.y - 3.5, 6.5, 1, GOLD); c.R(h.x - 1, h.y - 5, 2, 1, sh(col, 2));
  },
  mic(c, a) {
    const h = a.hand;
    c.R(h.x - 0.5, h.y - 6, 1.4, 6.5, '#3a3548'); c.O(h.x, h.y - 7.6, 2.3, 2.3, '#B9B6C6'); c.p1(h.x - 1, h.y - 9, '#ffffff'); c.R(h.x - 1.2, h.y - 6, 2.6, 1, '#1A1023');
  },
  briefcase(c, a) {
    const h = a.hand, y = Math.min(h.y + 0.5, -7.5);
    c.R(h.x - 1.8, y, 3.6, 1.2, '#4a2e12'); c.R(h.x - 1.8, y, 0.9, 2, '#4a2e12'); c.R(h.x + 1, y, 0.9, 2, '#4a2e12');
    c.B(h.x - 4.5, y + 1.6, 9, 6.4, '#8B5A2B'); c.R(h.x - 4.5, y + 4, 9, 0.9, '#6a4018'); c.R(h.x - 0.8, y + 3.4, 1.8, 1.8, GOLD); c.p1(h.x - 0.3, y + 3.8, '#fff3d0');
  },
  staff(c, a) {
    const h = a.hand, topY = Math.min(a.topY || 0, headTop(a)) - 2;
    c.R(h.x - 0.4, topY, 1.5, h.y + 3 - topY, '#8B5A2B'); c.R(h.x - 0.4, topY, 0.6, h.y + 3 - topY, '#B58652');
    c.O(h.x + 0.3, topY - 1.3, 2.4, 2.4, '#8FE8FF'); c.p1(h.x - 0.5, topY - 2.3, '#ffffff');
    a.topY = Math.min(a.topY || 0, topY - 3.5);
  },
  bow(c, a) {
    const h = a.hand, bx = h.x + 1;
    for (let dy = -7; dy <= 7; dy++) c.P(bx + Math.round(2.4 * (1 - (dy / 7) ** 2)), h.y - 4 + dy, '#8B5A2B');
    c.R(bx, h.y - 11, 0.8, 14.5, '#e8e0c8'); c.R(bx - 2, h.y - 4.5, 3, 1, '#c9a06a'); c.P(bx - 2, h.y - 4.5, '#e8e0c8');
  },
  sword(c, a) {
    const h = a.hand;
    c.R(h.x - 0.6, h.y - 13, 1.8, 12, '#DFE6F2'); c.R(h.x - 0.6, h.y - 13, 0.7, 12, '#ffffff'); c.G([[h.x - 0.6, h.y - 13], [h.x + 1.2, h.y - 13], [h.x + 0.3, h.y - 15]], '#DFE6F2');
    c.R(h.x - 2.5, h.y - 1.5, 5.5, 1.4, GOLD); c.R(h.x - 0.4, h.y - 0.2, 1.4, 2, '#6a4018');
  },
  flail(c, a) {
    const h = a.hand;
    c.R(h.x - 0.5, h.y - 5, 1.3, 6, '#8B5A2B');
    c.P(h.x + 0.5, h.y - 6, '#9aa0ac'); c.P(h.x + 1.5, h.y - 8, '#6e7280'); c.P(h.x + 3, h.y - 9.5, '#9aa0ac');
    c.O(h.x + 5.5, h.y - 10.5, 2.6, 2.6, '#7d8290');
    for (const [dx, dy] of [[0, -3.4], [0, 3.4], [-3.4, 0], [3.4, 0]]) c.p1(h.x + 5.5 + dx, h.y - 10.5 + dy, '#d8dde8');
  },
  shield(c, a) {
    const T = a.torso, cx = T.x1 - 1.5, cy = (T.y0 + T.y1) / 2 + 1;
    const col = '#B3322B';
    c.G([[cx - 4.5, cy - 5], [cx + 4.5, cy - 5], [cx + 4.5, cy + 1], [cx, cy + 6.5], [cx - 4.5, cy + 1]], '#9aa0b0');
    c.G([[cx - 3.5, cy - 4], [cx + 3.5, cy - 4], [cx + 3.5, cy + 0.5], [cx, cy + 4.8], [cx - 3.5, cy + 0.5]], col);
    c.R(cx - 0.6, cy - 3.5, 1.4, 7, CREAM); c.R(cx - 2.8, cy - 1.5, 5.6, 1.3, CREAM); c.p1(cx - 3, cy - 4, '#ffffff');
  },
  halo(c, a) {
    const hx = a.head.x, top = (a.topY !== undefined ? Math.min(a.topY, headTop(a)) : headTop(a)) - 2.5;
    c.R(hx - 2.5, top - 1.2, 5, 1.1, '#ffe84a'); c.R(hx - 2.5, top + 0.9, 5, 1.1, '#e0b820'); c.R(hx - 4.4, top - 0.2, 1.5, 1.6, '#ffe84a'); c.R(hx + 3, top - 0.2, 1.5, 1.6, '#e0b820');
    a.topY = Math.min(a.topY || 0, top - 1.5);
  },
  glasses(c) {
    const fr = '#3a2418';
    let prev = null;
    for (const e of c.eyes) {
      if (e.glassed) continue;
      e.glassed = true;
      const s = e.s;
      c.fill(e.x - 1, e.y - 2, s + 2, 1, fr); c.fill(e.x - 1, e.y + s, s + 2, 1, fr); c.fill(e.x - 1, e.y - 1, 1, s + 1, fr); c.fill(e.x + s, e.y - 1, 1, s + 1, fr);
      c.put(e.x, e.y + s - 1, '#aee8ff');
      if (prev && Math.abs(prev.y - e.y) < 3) { const a = Math.min(prev.x, e.x), b = Math.max(prev.x, e.x); if (b - a < 12) c.fill(a + s + 1, e.y, Math.max(1, b - a - s - 1), 1, fr); }
      prev = e;
    }
  },
  phone(c, a) {
    const h = a.hand;
    c.B(h.x - 2, h.y - 7, 4, 7, '#2a2438'); c.R(h.x - 1.2, h.y - 6.2, 2.4, 5, '#7FE8FF'); c.p1(h.x - 1, h.y - 6, '#ffffff'); c.P(h.x - 0.4, h.y - 1.8, '#2a2438');
  },
  clipboard(c, a) {
    const h = a.hand;
    c.B(h.x - 3.5, h.y - 10, 7, 10, '#9c6b3a'); c.R(h.x - 2.5, h.y - 8.8, 5, 8, CREAM);
    c.R(h.x - 1.5, h.y - 11, 3, 1.8, '#9aa3b5'); c.R(h.x - 2, h.y - 6.5, 4, 0.7, '#8a8498'); c.R(h.x - 2, h.y - 4.8, 4, 0.7, '#8a8498'); c.R(h.x - 2, h.y - 3, 2.5, 0.7, '#8a8498'); c.p1(h.x + 1.5, h.y - 7.5, RED);
  },
  coins(c, a) {
    const x = (a.hand ? a.hand.x : 8) + 1.5;
    c.R(x - 3.5, -2, 7, 2, '#c99a18'); c.R(x - 3.5, -2, 7, 0.9, GOLD);
    c.R(x - 2.5, -4, 5, 2, GOLD); c.R(x - 1.5, -5.5, 3, 1.6, '#ffd96a'); c.R(x - 2.5, -3.2, 5, 0.7, '#c99a18');
    c.p1(x - 1, -6, '#ffffff'); c.p1(x + 3, -3, '#fff3d0');
  },
  bottle(c, a, K) {
    const h = a.hand, green = K.r() < 0.5, g1 = green ? '#3FA34D' : '#BFE9FF', g2 = green ? '#2c7a38' : '#8fc4e0';
    c.B(h.x - 2, h.y - 6, 4, 6.5, g1); c.R(h.x + 0.5, h.y - 5.5, 1.5, 6, g2);
    c.R(h.x - 1, h.y - 9, 2.2, 3, g1); c.R(h.x - 1, h.y - 10.2, 2.2, 1.4, '#c9a06a'); c.R(h.x - 1.6, h.y - 4, 3.2, 2, CREAM); c.p1(h.x - 1.5, h.y - 6, '#ffffff');
  },
  fire(c, a) {
    const hx = a.head.x, top = (a.topY !== undefined ? Math.min(a.topY, headTop(a)) : headTop(a)) + 0.5;
    c.G([[hx - 3.5, top], [hx - 4, top - 4], [hx - 1.5, top - 6], [hx - 1, top - 9.5], [hx + 1.2, top - 6.5], [hx + 3, top - 8], [hx + 4, top - 3], [hx + 3.5, top]], '#FF6A00');
    c.G([[hx - 2, top], [hx - 2, top - 3], [hx, top - 5.5], [hx + 2, top - 3], [hx + 2, top]], '#FFB02E'); c.G([[hx - 1, top], [hx, top - 3], [hx + 1, top]], '#FFF1A0');
    a.topY = Math.min(a.topY || 0, top - 9.5);
  },
  ice(c, a) {
    const hx = a.head.x, top = headTop(a);
    const sh1 = (x, y, w, h) => { c.G([[x, y], [x - w, y - h * 0.55], [x - w * 0.3, y - h], [x + w * 0.7, y - h * 0.5], [x + w, y]], '#A5D8FF'); c.R(x - w * 0.5, y - h * 0.8, 0.8, h * 0.6, '#ffffff'); };
    sh1(hx - 2.5, top + 1.5, 1.8, 5); sh1(hx + 2.5, top + 1.2, 2, 7.5); sh1(a.torso ? a.torso.x0 + 0.5 : hx - 5, a.torso ? a.torso.y0 + 2 : top + 8, 1.6, 4.5);
    a.topY = Math.min(a.topY || 0, top - 6.5);
  },
  leaf(c, a) {
    const hx = a.head.x, top = headTop(a);
    c.G([[hx - 1, top + 1], [hx - 5.5, top - 3], [hx - 1.5, top - 6.5], [hx + 4, top - 5], [hx + 2.5, top - 1]], '#5FA83A');
    c.L(hx - 1, top + 0.5, hx + 2, top - 4.5, '#3E8E2E'); c.p1(hx - 3, top - 3, '#9BC44A'); c.P(hx - 1.4, top + 1.4, '#3E8E2E');
    a.topY = Math.min(a.topY || 0, top - 6.5);
  },
  hood(c, a, K) {
    const H = a.head, col = K.cl;
    c.O(H.x - 1.2, H.y - 0.6, H.rx + 1.9, H.ry + 1.9, col);
    c.O(H.x + 1.6, H.y + 0.6, H.rx - 2.1, H.ry - 1.6, K.face);                          // face opening
    c.R(H.x - H.rx - 0.5, H.y + 1, 2.4, H.ry + 1, sh(col, -1));
    c.redrawEyes();
    a.topY = Math.min(a.topY || 0, H.y - H.ry - 1.8);
  },
  cape(c, a) {
    const T = a.torso, col = '#8E2B4A', y0 = T.y0 - 1, y1 = Math.min(-1, T.y1 + 6);
    c.under(() => {
      for (let y = y0; y < y1; y += 0.5) {
        const k = (y - y0) / (y1 - y0), xl = T.x0 - 1.5 - k * 4.5, xr = T.x1 - 1 + k * 1.2;
        c.R(xl, y, xr - xl, 0.6, k > 0.82 ? '#6a1d34' : col);
      }
      c.R(T.x0 - 5.5, y1 - 0.5, 11, 0.8, '#E6B93C');
    });
  },
};
// order matters: things behind first, face covers before eyes are redrawn, glasses last
const ACC_ORDER = ['cape', 'hood', 'hat', 'tie', 'shield', 'coins', 'book', 'mic', 'briefcase', 'staff', 'bow', 'sword', 'flail', 'phone', 'clipboard', 'bottle', 'fire', 'ice', 'leaf', 'crown', 'halo', 'glasses'];

function applyAcc(c, a, K, list) {
  const set = new Set(list);
  for (const n of ACC_ORDER) if (set.has(n) && ACC[n]) { c.redrawEyes && n === 'glasses' && c.redrawEyes(); ACC[n](c, a, K); }
}

// ====================================================================================================
// archetype generators. Each returns anchors { head:{x,y,rx,ry}, chin, hand, hand2, torso }.
// ====================================================================================================
const A = (o) => Object.assign({ head: { x: 1, y: -20, rx: 5, ry: 5 }, chin: { x: 2, y: -14 }, hand: { x: 7, y: -8 }, hand2: { x: -1, y: -9 }, torso: { x0: -5, x1: 5, y0: -15, y1: -6 } }, o);
const mouth = (c, K, x, y, w = 3) => {
  const m = K.r.int(3);
  if (m === 0) c.R(x, y, w, 1, '#3a1a30');
  else if (m === 1) { c.R(x, y, w, 1, '#3a1a30'); c.P(x + 0.5, y + 1, '#ffffff'); c.P(x + w - 1.5, y + 1, '#ffffff'); }
  else { c.R(x, y + 0.5, w, 1.4, '#3a1a30'); c.P(x + 1, y + 0.5, '#ffffff'); }
};

// ---- biped / humanoid (also the NPC body) ----------------------------------------------------------
function humanoid(c, K, o = {}) {
  const r = K.r, skin = o.skin || K.col, shirt = o.shirt || K.cl, pants = o.pants || sh(K.cl, -1), shoe = o.shoe || '#4A3040';
  const hw = o.hw || 5, st = o.stoop || 0, bent = o.bent, robe = o.robe, hair = o.hair, hs = o.hairStyle;
  const hx = 1 + st, hy = -21 + (st ? 1.5 : 0);
  if (o.tail) { c.L(-hw, -8, -hw - 3, -6, sh(skin, -1), 1.4); c.L(-hw - 3, -6, -hw - 5, -11, sh(skin, -1), 1.4); c.O(-hw - 5, -12, 1.4, 1.4, sh(skin, -2), true); }
  // back arm
  c.B(-hw - 2, -16 + st * 0.3, 2.2, 8, sh(shirt, -1)); c.R(-hw - 2, -8.5, 2.2, 2, sh(skin, -1));
  // legs
  if (bent) {
    c.B(-4, -9, 3, 4.5, pants); c.B(-5, -5, 3, 5, sh(pants, -1)); c.R(-5.5, -1.8, 4, 1.8, shoe);
    c.B(0, -9, 3, 4.5, pants); c.B(-0.8, -5, 3, 5, sh(pants, -1)); c.R(-1, -1.8, 5, 1.8, shoe);
    c.R(-4, -5.6, 3, 1, '#e8e4f0'); c.R(0, -5.6, 3, 1, '#e8e4f0');
  } else if (!robe) {
    c.B(-4, -8, 3, 8, pants); c.B(1, -8, 3, 8, pants); c.R(-4.5, -2, 4, 2, shoe); c.R(1, -2, 5, 2, shoe);
  } else { c.R(-3.5, -3, 3, 3, skin); c.R(1, -3, 3, 3, skin); c.R(-4, -1.5, 4, 1.5, shoe); c.R(1, -1.5, 5, 1.5, shoe); }
  // torso
  if (robe) {
    for (let y = -16; y < -3; y += 0.5) { const k = (y + 16) / 13, w = hw + k * 2; c.R(-w + st * 0.3, y, 2 * w, 0.6, shirt); c.R(w - 2.2 + st * 0.3, y, 2.2, 0.6, sh(shirt, -1)); c.R(-w + st * 0.3, y, 1, 0.6, sh(shirt, 1)); }
    c.R(-hw - 2, -4, 2 * hw + 4, 1, sh(shirt, -1));
  } else c.B(-hw + st * 0.3, -16, 2 * hw, 9, shirt);
  if (!o.noBelt && !robe) c.R(-hw, -8, 2 * hw, 1.2, sh(pants, -2));
  // front arm
  c.B(hw - 0.5 + st * 0.3, -16, 2.4, 8, shirt); c.R(hw - 0.5 + st * 0.3, -8.5, 2.4, 2.4, skin);
  // back hair
  if (hs === 'bob') c.O(hx - 2, hy + 1, 6, 6.2, hair);
  if (hs === 'bun') c.O(hx - 5, hy - 5, 2.6, 2.6, hair);
  if (hs === 'wild') { for (const [dx, dy, rr] of [[-5, -3, 3.2], [-6, 1, 3], [-3, -6, 3.2], [1, -7, 3.2], [5, -5, 2.8], [-5.5, 4, 2.6], [4, 1, 2.2]]) c.O(hx + dx, hy + dy, rr, rr, hair); }
  // head
  c.O(hx, hy, 5, 5, skin);
  if (o.earStyle === 'round') { c.O(hx - 4.5, hy + 0.5, 1.7, 1.9, sh(skin, -1)); c.O(hx - 4.5, hy + 0.5, 0.8, 1, sh(skin, -2), true); }
  else if (o.earStyle === 'point') { c.G([[hx - 3.5, hy - 1], [hx - 9, hy - 4.5], [hx - 3.5, hy - 3.5]], sh(skin, -1)); c.G([[hx + 4, hy - 2], [hx + 7.5, hy - 5], [hx + 3.2, hy - 4]], sh(skin, -1)); }
  else c.O(hx - 4.4, hy + 0.5, 1.2, 1.6, sh(skin, -1));
  if (hs === 'tuft') { c.R(hx - 3, hy - 6, 5, 1.6, hair); c.R(hx - 1, hy - 8, 2, 2, hair); c.R(hx + 2, hy - 7, 2, 1.5, hair); }
  else if (hs === 'bob') { c.R(hx - 4.5, hy - 5.2, 9, 2.2, hair); c.R(hx - 5, hy - 3, 2, 5, hair); c.R(hx + 3.5, hy - 4, 1.5, 2, hair); }
  else if (hs === 'wild') { c.R(hx - 4.5, hy - 5.5, 8.5, 2.2, hair); c.O(hx + 1, hy - 6, 3, 1.6, hair); }
  else if (hs === 'bun') { c.R(hx - 4.5, hy - 5.2, 9, 2.2, hair); c.R(hx - 5, hy - 3, 1.8, 3, hair); }
  else if (hs === 'messy') { for (const [dx, dy] of [[-3, -6], [-1, -8], [1, -6.5], [3, -7.5], [-4.5, -4]]) c.R(hx + dx, hy + dy, 2, 2.2, hair); c.R(hx - 4, hy - 5, 8, 1.8, hair); }
  else if (hs === 'sides') { c.R(hx - 5, hy - 3, 1.8, 3.5, hair); c.R(hx - 4, hy - 5, 3, 1.2, hair); }
  else if (hs === 'tufted') { c.R(hx - 4, hy - 5.5, 8, 1.8, hair); }
  if (o.beard) { c.O(hx + 0.5, hy + 4.5, 4.8, 3.2, o.beard); c.R(hx - 3, hy + 1.5, 7, 2, o.beard); c.R(hx + 0.5, hy + 3.8, 3, 1, '#3a1a30'); if (o.beardLong) c.G([[hx - 3, hy + 6], [hx + 4, hy + 6], [hx + 2, hy + 12], [hx - 1, hy + 12]], o.beard); }
  if (o.mustache) c.R(hx + 0.5, hy + 2, 5, 1.2, o.mustache);
  // face
  const ek = o.smile ? 'soft' : 'normal';
  c.E(hx - 0.7, hy - 0.4, ek); c.E(hx + 3.4, hy - 0.4, ek);
  if (o.smile) { c.P(hx + 0.2, hy + 3, '#4a2030'); c.R(hx + 0.9, hy + 3.8, 3, 1, '#4a2030'); c.P(hx + 3.9, hy + 3, '#4a2030'); }
  else if (!o.beard) mouth(c, K, hx + 1, hy + 3, 3);
  K.face = skin;
  return A({ head: { x: hx, y: hy, rx: 5, ry: 5 }, chin: { x: hx + 0.8, y: hy + 5 }, hand: { x: hw + 1.7 + st * 0.3, y: -7 }, hand2: { x: -hw - 1, y: -8 }, torso: { x0: -hw, x1: hw, y0: -16, y1: -7 } });
}

function biped(c, K) {
  const n = K.name, r = K.r, monkey = /monkey|ape\b/i.test(n), pointy = /kobold|goblin|gremlin/i.test(n);
  const hairCol = sh(K.col, -2), hs = monkey || pointy ? null : r.pick(['tuft', 'sides', null, 'messy', 'tufted']);
  const a = humanoid(c, K, { skin: K.col, shirt: K.cl, pants: sh(mix(K.cl, '#4a3060', 0.4), 0), hair: hairCol, hairStyle: hs, earStyle: monkey ? 'round' : pointy ? 'point' : r.pick(['none', 'round']), tail: monkey, hw: 5 + (r.int(2)) });
  if (/nun/i.test(n)) { c.R(-5, -26, 11, 5, '#FFFFFF'); c.R(-6, -22, 3, 7, '#FFFFFF'); c.R(-5, -26, 11, 1, '#2b2233'); c.redrawEyes(); }
  if (/vampire/i.test(n)) { c.R(2.5, -17.6, 0.9, 1.6, '#fff'); c.R(4.2, -17.6, 0.9, 1.6, '#fff'); c.R(-4, -27, 8, 1.6, '#1A1023'); }
  if (/jester/i.test(n)) { /* hat comes from acc */ }
  return a;
}

// ---- knight ----------------------------------------------------------------------------------------
function knight(c, K) {
  const r = K.r, st = ramp(mix(K.col, '#c9cfdc', 0.62)), onion = /onion/i.test(K.name), has = n => K.acc.includes(n);
  const w = onion ? 7 : 6;
  c.B(-4, -8, 3.2, 8, st[1]); c.B(1, -8, 3.2, 8, st[2]); c.R(-5, -2, 4.5, 2, st[0]); c.R(1, -2, 5.5, 2, st[0]);
  if (onion) c.O(0, -10, 7.5, 8, st[2]); else c.B(-w, -17, 2 * w, 10, st[2]);
  c.R(-2, -16, 4, 9, K.cl); c.R(-w, -8, 2 * w, 1.2, st[0]); c.R(-0.4, -16, 0.9, 9, sh(K.cl, 1));
  c.B(-w - 1.5, -18, 4.5, 3.5, st[3]); c.B(w - 3, -18, 4.5, 3.5, st[3]);
  c.B(w - 0.5, -15, 3, 7, st[1]); c.R(w - 0.5, -8.5, 3, 2.2, st[0]);
  c.B(-w - 3, -15, 3, 7, st[1]);
  // helmet + visor
  c.O(1, -22.5, 5.6, 5.6, st[2]); c.R(-4.6, -22.5, 11.2, 5.2, st[2]);
  c.R(-0.5, -24, 7, 3.4, '#1A1023'); c.R(-4.6, -17.8, 11.2, 1, st[0]);
  c.E(1.6, -22.7, 'normal'); c.E(5, -22.7, 'normal');
  c.R(-4.6, -23, 1.5, 4, st[1]);
  const plume = K.cl; c.G([[-1, -28], [1, -31], [5, -29], [3, -27]], plume); c.R(0, -28.5, 3, 1, sh(plume, 1));
  if (onion) { c.P(3, -18, '#8fd3ff'); c.P(3.3, -16.6, '#8fd3ff'); c.P(5, -19, '#8fd3ff'); }
  if (!has('sword') && !has('shield')) K.acc = K.acc.concat(['sword']);
  return A({ head: { x: 1, y: -22.5, rx: 5.6, ry: 5.8 }, chin: { x: 1.5, y: -16.6 }, hand: { x: w + 1, y: -7.5 }, hand2: { x: -w - 1.5, y: -8 }, torso: { x0: -w, x1: w, y0: -17, y1: -7 } });
}

// ---- caster ----------------------------------------------------------------------------------------
function caster(c, K) {
  const r = K.r, rb = ramp(K.cl), has = n => K.acc.includes(n);
  c.L(-6, -14, -8, -7, sh(K.cl, -1), 2.2);
  for (let y = -15; y < -0.5; y += 0.5) {
    const k = (y + 15) / 14.5, hw = 4 + k * 3.8;
    c.R(-hw, y, 2 * hw, 0.6, rb[2]); c.R(hw - 2.4, y, 2.4, 0.6, rb[1]); c.R(-hw, y, 1.2, 0.6, rb[3]);
  }
  c.R(-7.8, -1.6, 15.6, 1.6, GOLD); c.R(-0.4, -14, 0.9, 13, rb[0]); c.R(-4, -9, 8, 0.9, GOLD);
  c.B(3.5, -14, 4, 3.2, rb[2]); c.L(6.5, -12, 8, -10.5, rb[1], 3); c.R(7.4, -11, 2, 2, sh(K.col, 0));
  // cowl (default headgear when no hat / hood)
  const cowl = !has('hat') && !has('hood');
  if (cowl) {
    c.G([[-6, -17], [-5, -23], [-1, -28], [3, -31], [2, -26], [6, -22], [7, -17]], rb[2]);
    c.G([[-6, -17], [-5, -23], [-1, -28], [0, -22], [-2, -17]], rb[1]);
  }
  c.O(1.4, -19.5, 4.4, 4.2, K.col); K.face = K.col;
  if (cowl) { c.R(-3.2, -24.6, 9, 2, rb[2]); c.G([[-4, -24], [-1, -28], [3, -24]], rb[2]); }
  c.E(0.6, -19.8); c.E(4.4, -19.8);
  if (r() < 0.6) { c.R(1, -16.5, 4.4, 2.4, '#E9E4D8'); c.R(2, -14.2, 2.4, 1.6, '#E9E4D8'); } else mouth(c, K, 1.6, -17, 3);
  if (cowl) K.hidTop = -31;
  return A({ head: { x: 1.4, y: -19.5, rx: 4.4, ry: 4.4 }, chin: { x: 2, y: -15.2 }, hand: { x: 8.2, y: -9.2 }, hand2: { x: -1, y: -9 }, torso: { x0: -4, x1: 4.5, y0: -15, y1: -4 }, topY: cowl ? -31 : undefined });
}

// ---- skeleton --------------------------------------------------------------------------------------
function skeleton(c, K) {
  const bone = mix('#F1ECD6', K.col, 0.22), br = ramp(bone), mummy = /mummy/i.test(K.name);
  c.R(-6.4, -15, 1.6, 8, br[1]); c.R(-6.8, -7.5, 2, 1.6, br[2]);                  // back arm
  c.R(-3, -6, 1.8, 6, br[1]); c.R(1.4, -6, 1.8, 6, br[2]); c.R(-4, -1.2, 3.5, 1.2, br[2]); c.R(1.4, -1.2, 4, 1.2, br[2]); // legs/feet
  c.R(-4, -8, 8.4, 2.4, br[2]); c.R(-1, -8, 2, 1.2, br[0]);                           // pelvis
  c.R(-0.6, -16, 1.8, 8.6, br[1]);                                                    // spine
  for (let i = 0; i < 4; i++) { c.R(-5, -15 + i * 2.1, 4.4, 1.1, br[i ? 2 : 3]); c.R(1.4, -15 + i * 2.1, 4.4, 1.1, br[1]); }
  c.R(5, -15, 1.7, 8, br[2]); c.R(4.8, -7.4, 2.5, 2, br[3]);                            // front arm + hand
  c.O(1, -21, 5, 4.6, bone);                                                        // skull
  c.R(-2, -18, 6.4, 2.6, br[2]);                                                    // jaw
  for (let x = -1.5; x < 4.4; x += 1.4) c.P(x, -17.6, '#1A1023');                      // teeth gaps
  c.R(-2, -17, 6.4, 0.7, br[0]);
  c.E(-0.2, -21, 'socket', '#ff8a8a'); c.E(3.6, -21, 'socket', '#ff8a8a');
  c.P(2.6, -19, br[0]);
  if (mummy) {
    for (let y = -26; y < -8; y += 2.6) { c.R(-5, y, 11, 1, '#D9CFA8'); c.R(-5.5, y + 1.3, 3, 0.8, '#B5A878'); }
    c.R(-4.5, -22, 11, 1.1, '#D9CFA8'); c.redrawEyes();
  }
  return A({ head: { x: 1, y: -21, rx: 5, ry: 4.6 }, chin: { x: 1.2, y: -16 }, hand: { x: 6, y: -7 }, hand2: { x: -6, y: -8 }, torso: { x0: -5, x1: 5, y0: -16, y1: -7 } });
}

// ---- ghost -----------------------------------------------------------------------------------------
function ghost(c, K) {
  const main = mix(K.col, '#ffffff', 0.38), rp = ramp(main), lo = mix(K.col, '#9fb0ff', 0.4);
  c.O(0, -17.5, 7, 7.5, main, true);
  c.R(-7, -17.5, 14, 11, main);
  for (let i = 0; i < 7; i++) { const x = -7 + i * 2, h = [0, 2, 3.4, 2, 0, 2, 3.4][i]; c.R(x, -6.5, 2, 3.4 + h * 0.8 - 1, main); }
  c.R(2, -22, 4, 2, rp[3]); c.R(-6, -16, 2, 9, rp[3]); c.R(4, -14, 3, 8, lo);
  for (let y = -12; y < -3; y++) for (let x = -7; x < 7; x++) if (((x + y) & 1) === 0) c.p1(x, y, rp[3]);
  c.R(6, -13, 3.6, 2, main); c.R(8, -13, 1.6, 2, rp[1]);                             // stub arm
  c.E(-1.4, -19, 'hollow'); c.E(3, -19, 'hollow');
  c.R(0.4, -13.4, 2.6, 2.8, '#1A1023'); c.P(0.4, -13.4, lo);
  return A({ head: { x: 0.5, y: -18, rx: 6, ry: 6.5 }, chin: { x: 1, y: -12.5 }, hand: { x: 9.2, y: -11 }, hand2: { x: -4, y: -8 }, torso: { x0: -6, x1: 6, y0: -13, y1: -6 } });
}

// ---- beast (quadruped) -----------------------------------------------------------------------------
function beastFeat(n, r) {
  const f = { ears: 'point', tail: 'long', bulk: 1, hump: 0 };
  if (/goat|yak/i.test(n)) { f.horns = true; f.beard = true; f.ears = 'flop'; f.tail = 'short'; if (/yak/i.test(n)) { f.shag = true; f.bulk = 1.15; } }
  if (/jaguar/i.test(n)) { f.spots = true; f.tail = 'long'; }
  if (/jackal|coyote/i.test(n)) { f.ears = 'tall'; f.tail = 'bush'; }
  if (/rat\b|pope/i.test(n)) { f.ears = 'round'; f.tail = 'bare'; f.bulk = 0.9; f.whisk = true; }
  if (/gorilla|ape\b/i.test(n)) { f.hump = 1; f.ears = 'round'; f.tail = 'none'; f.bulk = 1.1; f.arms = true; }
  if (/hippo/i.test(n)) { f.bulk = 1.25; f.ears = 'round'; f.tail = 'short'; f.wide = true; }
  if (/sloth/i.test(n)) { f.arms = true; f.ears = 'none'; f.tail = 'none'; f.hang = true; }
  if (/bear/i.test(n)) { f.bulk = 1.2; f.ears = 'round'; f.tail = 'short'; }
  if (/sphinx/i.test(n)) { f.mane = true; f.tail = 'long'; f.ears = 'none'; f.bulk = 1.1; }
  if (/\bcat\b|lion/i.test(n)) f.ears = 'point';
  return f;
}
function beast(c, K) {
  const f = beastFeat(K.name, K.r), bk = f.bulk, col = K.col, dk = sh(col, -1), dk2 = sh(col, -2), lt = sh(col, 1);
  const furShade = f.spots || f.shag ? 1 : 0;
  // far legs
  c.R(-5.5, -7, 2.6, 7, dk2); c.R(1.6, -7, 2.6, 7, dk2); c.R(-6, -1.2, 3.4, 1.2, dk2); c.R(1.4, -1.2, 3.6, 1.2, dk2);
  // tail
  if (f.tail === 'long') { c.L(-10, -12, -13, -9, dk, 1.8); c.L(-13, -9, -12.5, -15, dk, 1.8); c.P(-12.8, -15.8, sh(col, -2)); }
  else if (f.tail === 'bush') { c.G([[-9, -11], [-13, -14], [-14, -8], [-10, -8]], lt); c.R(-14, -10, 1.5, 2, '#ffffff'); }
  else if (f.tail === 'bare') { c.L(-9, -9, -13, -6, '#F08FA0', 1); c.L(-13, -6, -13, -11, '#F08FA0', 1); }
  else if (f.tail === 'short') c.O(-10.5, -11.5, 1.8, 1.8, dk);
  if (f.mane) c.O(6.5, -15.5, 5.6, 5.6, dk2);
  // body
  c.O(-1.5, -11, 8.4 * bk, 5 * bk, col);
  if (f.hump) c.O(3, -14, 5, 5, col);
  if (f.shag) for (let x = -8; x < 6; x += 2) c.R(x, -7, 1.4, 2.6, dk);
  c.O(-0.5, -9, 5.5 * bk, 2.4, lt, true);
  if (f.spots) for (const [sx, sy] of [[-6, -13], [-3, -10], [0, -13.5], [2, -10.5], [-8, -10], [-1, -8]]) { c.R(sx, sy, 1.7, 1.7, dk2); c.P(sx + 0.5, sy + 0.5, col); }
  // near legs
  c.B(-8, -7.5, 3, 7.5, dk); c.B(2.5, -7.5, 3, 7.5, col); c.R(-8.5, -1.4, 4.2, 1.4, dk2); c.R(2.2, -1.4, 4.4, 1.4, dk2);
  if (f.arms) { c.B(3.5, -12, 3.6, 9.5, f.hang ? dk : col); c.R(3.5, -3, 3.8, 2.6, dk2); for (let i = 0; i < 3; i++) c.P(3.8 + i * 1.2, -0.6, '#EEEEDD'); }
  // head
  const hx = f.hump ? 9 : 8.8, hy = f.hump ? -14 : -15;
  c.O(hx, hy, 4.4, 3.9, col);
  const snoutW = f.wide ? 7.5 : 5, snH = f.wide ? 4.4 : 3;
  c.B(hx + 1.5, hy + 0.5, snoutW, snH, lt); c.P(hx + snoutW + 0.3, hy + 0.8, '#1A1023'); c.P(hx + snoutW - 0.7, hy + 0.8, '#1A1023');
  c.R(hx + 1, hy + 0.5 + snH - 0.8, snoutW + 0.5, 0.8, '#3a1a30');
  if (f.wide) { c.P(hx + 3, hy - 1.2, dk2); }
  // ears
  if (f.ears === 'point') { c.G([[hx - 3, hy - 2.5], [hx - 2, hy - 7], [hx, hy - 3]], col); c.G([[hx + 0.5, hy - 3], [hx + 2, hy - 7.2], [hx + 3.5, hy - 2.5]], dk); }
  else if (f.ears === 'tall') { c.G([[hx - 3, hy - 2.5], [hx - 3, hy - 9], [hx, hy - 3]], col); c.G([[hx + 0.5, hy - 3], [hx + 1.5, hy - 9.5], [hx + 3.5, hy - 2.5]], dk); }
  else if (f.ears === 'round') { c.O(hx - 2, hy - 3.8, 2, 2, col); c.O(hx - 2, hy - 3.8, 1, 1, '#F08FA0', true); c.O(hx + 2, hy - 4, 2, 2, dk); }
  else if (f.ears === 'flop') { c.G([[hx - 3, hy - 2], [hx - 6, hy + 1], [hx - 2.5, hy - 0.5]], dk); }
  if (f.horns) { c.L(hx - 1, hy - 3, hx - 3, hy - 7, '#EEEEDD', 1.4); c.L(hx - 3, hy - 7, hx - 6, hy - 8, '#EEEEDD', 1.4); c.L(hx + 1.5, hy - 3.4, hx + 0.5, hy - 7.5, '#d8d4c0', 1.3); }
  if (f.beard) c.R(hx + 3, hy + 3.5, 1.4, 3, '#EEEEDD');
  if (f.whisk) { c.L(hx + 6, hy + 1.5, hx + 9, hy + 0.5, '#fff', 0.6); c.L(hx + 6, hy + 2.5, hx + 9, hy + 3.5, '#fff', 0.6); }
  c.E(hx - 0.8, hy - 1.2); c.E(hx + 3.2, hy - 1.2);
  K.face = col;
  return A({ head: { x: hx, y: hy, rx: 4.4, ry: 3.9 }, chin: { x: hx - 1, y: hy + 4.2 }, hand: { x: hx + 1.2, y: -5.5 }, hand2: { x: 0, y: -9 }, torso: { x0: -6, x1: 5.5, y0: -15, y1: -6 } });
}

// ---- brute -----------------------------------------------------------------------------------------
function brute(c, K) {
  const col = K.col, n = K.name, dk = sh(col, -1), dk2 = sh(col, -2), lt = sh(col, 1), gar = /gargoyle/i.test(n), yeti = /yeti|snowman/i.test(n);
  const body = gar ? mix(col, '#8a8a96', 0.6) : col, bd = ramp(body);
  if (gar) { c.under(() => { c.G([[-4, -18], [-12, -26], [-9, -20], [-13, -19], [-8, -15], [-6, -12]], bd[1]); }); }
  c.B(-5.5, -8, 4.5, 8, bd[1]); c.B(1, -8, 4.5, 8, bd[2]); c.R(-6.5, -1.6, 5.8, 1.6, bd[0]); c.R(1, -1.6, 6.2, 1.6, bd[0]);
  c.R(-9, -20, 4, 13, bd[1]); c.O(-8.5, -6, 3.2, 3, bd[1]);                                // back arm + fist
  c.O(0, -13.5, 8.8, 7.4, body);                                                              // hunched torso
  c.R(-4, -9, 9, 5, K.cl); c.R(-4, -9, 9, 1, sh(K.cl, 1)); c.R(-4, -6.5, 9, 0.8, sh(K.cl, -1)); // loincloth
  if (yeti) for (let x = -8; x < 8; x += 2) { c.G([[x, -6.5], [x + 1, -3], [x + 2, -6.5]], sh(body, 1)); c.G([[x, -17], [x + 1, -20.5], [x + 2, -17]], sh(body, 2)); }
  c.B(5.5, -19, 4.5, 12, bd[2]); c.O(8, -6.2, 3.7, 3.4, bd[3]);                              // front arm + big fist
  for (let i = 0; i < 3; i++) c.P(6.6 + i * 1.5, -6.6, bd[0]);
  c.O(4.2, -21, 4.2, 4, body);                                                                // small head
  c.R(1, -22.4, 7, 1, bd[1]);
  c.E(3.2, -21.5); c.E(6.6, -21.5);
  c.R(2.8, -18.4, 5, 1.6, '#3a1a30');
  if (/ogre|troll|hippo|gorilla/i.test(n) || !yeti) { c.G([[3, -19], [3.8, -21.5], [4.6, -19]], '#fff'); c.G([[6, -19], [6.8, -21.5], [7.6, -19]], '#fff'); }
  if (gar) { c.G([[1.6, -24], [0.6, -28], [3.4, -25]], bd[3]); c.G([[6, -24.5], [7.4, -28], [7.8, -24]], bd[3]); }
  K.face = body;
  return A({ head: { x: 4.2, y: -21, rx: 4.2, ry: 4 }, chin: { x: 5, y: -17 }, hand: { x: 8.2, y: -6 }, hand2: { x: -6, y: -8 }, torso: { x0: -7, x1: 7, y0: -19, y1: -7 } });
}

// ---- bird (+ bat) ----------------------------------------------------------------------------------
function bat(c, K, small) {
  const col = K.col, dk = sh(col, -1), dk2 = sh(col, -2), y = small ? -8 : -8.5;
  c.G([[-2, y - 1], [-11, y - 7], [-9, y - 2.5], [-12, y + 1], [-8, y], [-6, y + 3.5], [-2, y + 2]], dk);
  c.G([[2, y - 1], [11, y - 7], [9, y - 2.5], [12, y + 1], [8, y], [6, y + 3.5], [2, y + 2]], col);
  c.L(-2, y - 1, -10, y - 6.5, dk2, 0.8); c.L(2, y - 1, 10, y - 6.5, dk2, 0.8);
  c.O(0, y + 0.5, 3.4, 3.8, col);
  c.G([[-3, y - 2], [-4, y - 7], [-0.8, y - 3.5]], dk); c.G([[3, y - 2], [4, y - 7], [0.8, y - 3.5]], col);
  c.E(-1.6, y - 0.8); c.E(1.8, y - 0.8);
  c.R(-1.2, y + 2, 0.9, 1.4, '#fff'); c.R(0.7, y + 2, 0.9, 1.4, '#fff');
  return A({ head: { x: 0, y: y, rx: 3.4, ry: 3.6 }, chin: { x: 0, y: y + 3 }, hand: { x: 4.2, y: y + 4 }, hand2: { x: -4, y: y + 4 }, torso: { x0: -3, x1: 3, y0: y - 2, y1: y + 3 } });
}
function bird(c, K) {
  const n = K.name, r = K.r;
  if (/\bbat\b/i.test(n) && !/swarm/i.test(n)) { K.face = K.col; return bat(c, K); }
  if (/swarm/i.test(n)) {
    bat(c.sub(-6, -1, 0.62), K); bat(c.sub(6.5, 3, 0.62), K);
    const a = bat(c.sub(0, 0, 0.9), K); K.face = K.col; return a;
  }
  const col = K.col, dk = sh(col, -1), dk2 = sh(col, -2), lt = sh(col, 2);
  const eagle = /eagle|vulture/i.test(n), toucan = /toucan/i.test(n), duck = /duck/i.test(n), parrot = /parrot/i.test(n), pigeon = /pigeon/i.test(n), vult = /vulture/i.test(n);
  const wingC = parrot ? '#3A5FCD' : dk, tailC = parrot ? RED : dk2;
  c.R(-1, -7, 1.2, 7, '#E08A20'); c.R(2.2, -7, 1.2, 7, '#c06a14'); c.R(-2.5, -1, 3.5, 1, '#E08A20'); c.R(1, -1, 3.8, 1, '#c06a14');
  c.G([[-5, -13], [-13, -7], [-12, -4], [-9, -6], [-5, -9]], tailC); c.L(-6, -11, -12, -5.5, sh(tailC, -1), 0.8);
  if (parrot) c.G([[-6, -11], [-12, -9], [-11, -12]], '#3FA34D');
  c.O(0, -12, 6.6, 5.4, col);
  c.O(1.6, -10.4, 3.8, 3.4, pigeon ? sh(col, 2) : lt, true);
  c.O(-2, -12.5, 4.4, 3, wingC); for (let i = 0; i < 3; i++) c.L(-4 - i * 1.2, -11 + i, -7 - i * 1.4, -8.5 + i * 1.4, sh(wingC, -2), 0.7);
  if (vult) { c.R(1.5, -17, 6, 2, '#FFFFFF'); }
  c.O(3.4, -15.5, 3, 3.2, col);
  const headC = vult ? '#E8A0A0' : col;
  c.O(5.6, -18.6, 3.8, 3.7, headC);
  if (parrot) { c.G([[3, -21], [2, -26], [5.5, -22]], RED); }
  if (toucan) { c.G([[8, -19.8], [16, -18.5], [8, -15.5]], '#F0A030'); c.G([[8, -17.6], [15, -17.4], [8, -15.5]], '#d8701a'); c.R(14, -19, 2, 2, '#1A1023'); }
  else if (duck) { c.G([[8.6, -18.3], [14, -17.4], [14, -15.8], [8.6, -16]], '#F4C030'); c.P(13, -17, '#c99a18'); }
  else if (eagle) { c.G([[8.6, -19.8], [13, -18.5], [11, -16], [8.6, -16.4]], '#F4C030'); c.G([[11, -16.5], [13.2, -18.5], [13, -14.6]], '#c99a18'); }
  else c.G([[8.6, -19.4], [13, -18], [8.6, -16.4]], '#F0A030');
  c.E(4.1, -19.4); c.E(7.5, -19.4);
  K.face = headC;
  return A({ head: { x: 5.6, y: -18.6, rx: 3.8, ry: 3.7 }, chin: { x: 5.5, y: -14.8 }, hand: { x: 8.4, y: -8.5 }, hand2: { x: -1, y: -9 }, torso: { x0: -4, x1: 5, y0: -15, y1: -8 } });
}

// ---- bug -------------------------------------------------------------------------------------------
function bug(c, K) {
  const n = K.name, col = K.col, dk = sh(col, -1), dk2 = sh(col, -2), lt = sh(col, 1);
  const kind = /mosquito/i.test(n) ? 'mosq' : /\bant\b/i.test(n) ? 'ant' : /spider/i.test(n) ? 'spider' : /scorpion/i.test(n) ? 'scorp' : /termite|queen/i.test(n) ? 'queen' : /scarab|beetle/i.test(n) ? 'beetle' : 'gen';
  const leg = (x, y, dx, col2 = dk2) => { c.L(x, y, x + dx * 0.55, y - 3, col2, 1); c.L(x + dx * 0.55, y - 3, x + dx, 0, col2, 1); };
  if (kind === 'ant') {
    c.L(-3, -9, -4, 0, dk2, 1.4); c.L(2, -9, 3, 0, dk2, 1.4); c.R(-5, -1.2, 3, 1.2, dk2); c.R(2, -1.2, 3.5, 1.2, dk2);
    c.O(-7, -10, 5, 4.5, col); c.R(-6, -12, 3, 1, lt);                                       // abdomen
    c.O(0, -13, 3.8, 4.2, dk);                                                               // thorax
    c.L(3, -14, 7, -11, dk2, 1.4); c.L(-3, -14, -2, -9, dk2, 1);
    c.O(1.4, -20.5, 5, 4.8, col);
    c.L(2, -24, 0, -29, dk2, 0.9); c.L(5, -24, 8, -28, dk2, 0.9); c.O(0, -29, 1, 1, dk2, true); c.O(8, -28.5, 1, 1, dk2, true);
    c.E(0.4, -21); c.E(4.2, -21); c.L(6, -18, 8.5, -17, '#1A1023', 1); c.L(6, -17, 8.5, -15.5, '#1A1023', 1);
    K.face = col;
    return A({ head: { x: 1.4, y: -20.5, rx: 5, ry: 4.8 }, chin: { x: 2.2, y: -16.2 }, hand: { x: 7.4, y: -10.5 }, hand2: { x: -2, y: -10 }, torso: { x0: -3, x1: 4, y0: -16, y1: -9 } });
  }
  if (kind === 'spider') {
    for (const [lx, a1, a2, e] of [[-1, -7, -11, -16], [1, -2, -9, -7], [2, 2, -2, -2], [3, 7, 0, 2]]) {
      c.L(lx - 1, -9, lx - 4 - a1 * 0.2, -15, dk2, 1); c.L(lx - 4 - a1 * 0.2, -15, lx - 7 + a1 * 0.2, 0, dk2, 1);
      c.L(lx + 2, -9, lx + 5 + a2 * 0.1, -15 + (e + 16) * 0.1, dk2, 1); c.L(lx + 5 + a2 * 0.1, -15, lx + 7 + a1 * 0.3, 0, dk2, 1);
    }
    c.O(-4, -11, 5.8, 5.2, col); c.O(-5, -13, 2.2, 1.6, lt, true); c.R(-6, -10, 1, 3, dk); c.R(-3, -9, 1, 3, dk);
    c.O(3.8, -10.5, 3.6, 3.4, dk);
    c.E(2.6, -11.5); c.E(5.4, -11.5); c.P(3.3, -14, '#ff6a80'); c.P(5.2, -14, '#ff6a80'); c.G([[7.5, -8.5], [8.5, -5.5], [6.4, -7.5]], '#fff');
    K.face = col;
    return A({ head: { x: 3.8, y: -10.5, rx: 3.6, ry: 3.4 }, chin: { x: 4.5, y: -7 }, hand: { x: 8.5, y: -6 }, hand2: { x: 0, y: -8 }, torso: { x0: -8, x1: 2, y0: -16, y1: -7 } });
  }
  if (kind === 'scorp') {
    for (const lx of [-5, -1.5, 2]) { c.L(lx, -4, lx - 2, -2, dk2, 1); c.L(lx - 2, -2, lx - 2.5, 0, dk2, 1); c.L(lx + 1, -4, lx + 2.5, -1.5, dk2, 1); }
    c.chain([[-6, -6], [-9, -9], [-10.5, -13], [-9.5, -17], [-6, -19.5], [-2, -18.5], [-0.5, -15.5]], (i, n2) => 2.1 - i * 0.12, (i) => i % 2 ? dk : col);
    c.G([[-1.2, -15], [0.6, -15], [1.2, -11.5], [-0.8, -12]], '#1A1023'); c.G([[-1.6, -13.6], [0.8, -13.6], [-0.2, -11]], '#ff6a80');
    c.O(-3.5, -6.5, 6, 3.6, col); c.R(-6, -9, 1, 5, dk); c.R(-3, -9.2, 1, 5, dk); c.R(0, -9, 1, 5, dk);
    c.O(3.5, -7, 3.4, 3.1, dk);
    c.L(5, -8, 9, -11, dk, 1.8); c.O(10, -12, 2.8, 2, col); c.G([[9, -13.5], [13, -13], [10, -11]], dk2); c.L(5, -5.5, 9, -4.5, dk, 1.6); c.O(10, -4.5, 2.2, 1.6, col);
    c.E(2.4, -9.2); c.E(5.2, -9.2);
    K.face = col;
    return A({ head: { x: 3.5, y: -7.5, rx: 3.4, ry: 3 }, chin: { x: 4, y: -4.6 }, hand: { x: 11, y: -6 }, hand2: { x: 0, y: -8 }, torso: { x0: -8, x1: 2, y0: -10, y1: -4 } });
  }
  if (kind === 'beetle') {
    for (const lx of [-4, 0, 4]) { leg(lx, -4, -3, dk2); leg(lx + 1, -4, 4, dk2); }
    c.O(-1, -9, 7.8, 6.4, col); c.R(-1.4, -15, 1, 12, dk2); c.O(-4, -12, 2, 1.2, '#fff', true);
    c.O(-4, -8, 1.2, 1.2, dk, true); c.O(2, -8.5, 1.2, 1.2, dk, true);
    c.O(7, -10, 3.4, 3.2, dk); c.G([[8, -13], [10.5, -17], [10.6, -13]], dk2);
    c.E(5.6, -11); c.E(8.4, -11); c.L(9.5, -8, 11.5, -6, dk2, 1.2);
    K.face = col;
    return A({ head: { x: 7, y: -10, rx: 3.4, ry: 3.2 }, chin: { x: 7, y: -7 }, hand: { x: 11, y: -5 }, hand2: { x: 0, y: -8 }, torso: { x0: -8, x1: 5, y0: -15, y1: -4 } });
  }
  if (kind === 'queen') {
    c.L(-3, -5, -5, 0, dk2, 1.2); c.L(1, -5, 1, 0, dk2, 1.2); c.L(4, -5, 6, 0, dk2, 1.2);
    c.O(-5, -9, 8.4, 7, mix(col, '#fff3d0', 0.5));
    for (let i = 0; i < 5; i++) c.R(-11 + i * 3, -14.5 + Math.abs(i - 2) * 0.8, 1, 11 - Math.abs(i - 2) * 1.6, mix(col, '#a86', 0.5));
    c.O(-8, -13, 2.6, 1.4, '#fff', true);
    c.O(4.4, -9, 3, 3, dk); c.O(8, -10, 3.4, 3.2, col);
    c.E(6.6, -11.2); c.E(9.4, -11.2); c.L(10.6, -8, 12.5, -6, dk2, 1.2);
    K.face = col;
    return A({ head: { x: 8, y: -10, rx: 3.4, ry: 3.2 }, chin: { x: 8, y: -7 }, hand: { x: 12, y: -6 }, hand2: { x: 0, y: -8 }, torso: { x0: -12, x1: 4, y0: -16, y1: -3 } });
  }
  // mosquito / generic
  const mosq = kind === 'mosq';
  for (const lx of [-2, 1, 4]) { leg(lx, -8, -4 - (mosq ? 1 : 0), dk2); leg(lx + 0.5, -8, 5 + (mosq ? 1 : 0), dk2); }
  c.O(-6.2, -9.5, 5.4, 3.4, col); c.R(-9, -10, 1, 3.4, dk); c.R(-6.5, -10.6, 1, 4.4, dk); c.R(-3.8, -10.6, 1, 4.4, dk);
  c.O(-0.5, -10.5, 3.6, 3.6, dk);
  if (mosq) { c.G([[-3, -12], [-12, -19], [-10, -14]], mix(col, '#ffffff', 0.7)); c.G([[-1, -12.5], [4, -19], [5, -13]], mix(col, '#ffffff', 0.55)); c.L(-3, -12, -10, -17, dk2, 0.6); }
  else { c.G([[-4, -12], [-8, -17], [-2, -14]], mix(col, '#fff', 0.6)); }
  c.O(5, -11, 3.5, 3.2, col);
  if (mosq) { c.L(7.6, -9.5, 14, -5.5, '#3a3548', 1); }
  else c.L(7.5, -9, 9.5, -7, dk2, 1.2);
  c.L(4.5, -14, 6, -19, dk2, 0.9); c.L(6.5, -14, 9, -18, dk2, 0.9); c.P(6, -19.6, dk2); c.P(9, -18.6, dk2);
  c.E(3.5, -11.8); c.E(6.6, -11.8);
  K.face = col;
  return A({ head: { x: 5, y: -11, rx: 3.5, ry: 3.2 }, chin: { x: 5, y: -8 }, hand: { x: mosq ? 12 : 9.5, y: mosq ? -3.4 : -5 }, hand2: { x: 0, y: -8 }, torso: { x0: -8, x1: 2, y0: -13, y1: -6 } });
}

// ---- serpent (+ worm, hydra, kraken) ---------------------------------------------------------------
function catmull(pts, n) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(i - 1, 0)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(i + 2, pts.length - 1)];
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      out.push([0, 1].map(d => 0.5 * ((2 * p1[d]) + (-p0[d] + p2[d]) * t + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * t2 + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * t3)));
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}
function snakeHead(c, K, hx, hy, big = 1) {
  const col = K.col;
  c.O(hx, hy, 4 * big, 3.2 * big, col); c.O(hx + 3.6 * big, hy + 0.8 * big, 2.8 * big, 2.2 * big, sh(col, 1));
  c.E(hx - 0.8 * big, hy - 1.4 * big); c.E(hx + 2.6 * big, hy - 1.4 * big);
  c.R(hx + 4.5 * big, hy + 2.4 * big, 4, 0.9, RED); c.P(hx + 8.2 * big, hy + 1.6 * big, RED); c.P(hx + 8.2 * big, hy + 3.2 * big, RED);
  c.G([[hx + 3, hy + 2.4], [hx + 3.6, hy + 4.4], [hx + 4.4, hy + 2.4]], '#fff');
}
function serpent(c, K) {
  const n = K.name, r = K.r, col = K.col, dk = sh(col, -1), lt = sh(col, 1);
  if (/kraken/i.test(n)) {
    for (const [i, bx] of [-7, -3, 2, 6].entries()) { const pts = catmull([[bx, -7], [bx + (i % 2 ? 3 : -3), -3], [bx + (i % 2 ? -1 : 1), -1], [bx + (i < 2 ? -5 : 5), -2.5]], 4); c.chain(pts, (k) => 2.2 - k * 0.08, (k) => k % 3 === 0 ? lt : dk); for (const p of pts.filter((_, k) => k % 3 === 1)) c.p1(p[0], p[1], '#fff3d0'); }
    c.O(0, -15.5, 8, 7.4, col); c.O(-3, -19, 2.8, 1.8, lt, true);
    c.E(-2.6, -15.5); c.E(3.6, -15.5); c.R(-1, -11.2, 3.6, 1, '#3a1a30');
    c.R(-6.4, -12.6, 2, 2, '#a02a6a'); c.R(4.8, -12, 1.6, 1.6, '#a02a6a');
    K.face = col;
    return A({ head: { x: 0.5, y: -15.5, rx: 7, ry: 6.6 }, chin: { x: 1, y: -9.5 }, hand: { x: 9.4, y: -5 }, hand2: { x: -9, y: -5 }, torso: { x0: -6, x1: 6, y0: -12, y1: -4 } });
  }
  if (/worm/i.test(n)) {
    for (let i = 0; i < 6; i++) c.O(-3 + i * 0.25, -2 - i * 3.1, 7 - i * 0.2, 3.6, i % 2 ? col : dk);
    c.O(3, -22, 7.8, 4.4, col);
    c.O(5.2, -22, 4.4, 3.5, '#4A1530', true); c.O(5.4, -22, 3, 2.3, '#c44a6a', true);
    for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2, x = 5.2 + Math.cos(a) * 4.2, y = -22 + Math.sin(a) * 3.4; c.R(x - 0.5, y - 0.5, 1.2, 1.2, '#fff'); }
    c.E(-0.6, -25.6); c.E(2.8, -26);
    K.face = col;
    return A({ head: { x: 3, y: -22, rx: 7, ry: 4.4 }, chin: { x: 5, y: -17 }, hand: { x: 10, y: -12 }, hand2: { x: -8, y: -8 }, torso: { x0: -8, x1: 8, y0: -18, y1: -2 } });
  }
  if (/hydra/i.test(n)) {
    const hh = [[[3, -8], [7, -13], [10, -18], [12.5, -22]], [[-1, -8], [-6, -13], [-8, -18], [-6.5, -22]]];
    c.O(-1, -6, 9, 5.6, col); c.R(-6, -5, 10, 1, dk);
    for (const [i, p] of hh.entries()) {
      const pts = catmull(p, 5);
      c.chain(pts, () => 2, (k) => k % 4 < 2 ? col : dk);
      if (i === 0) snakeHead(c, K, p[3][0], p[3][1] - 1.5, 1);
      else { c.O(p[3][0], p[3][1], 2.3, 2.3, '#c44a6a', true); c.R(p[3][0] - 2.5, p[3][1] + 1, 5, 1.5, '#fff3d0'); c.P(p[3][0] - 1, p[3][1] - 0.8, '#7a1030'); }
    }
    c.L(-9, -4, -13, -2, dk, 2);
    K.face = col;
    return A({ head: { x: 12.5, y: -23.5, rx: 4, ry: 3.2 }, chin: { x: 11, y: -19 }, hand: { x: 14, y: -9 }, hand2: { x: -4, y: -8 }, torso: { x0: -8, x1: 7, y0: -11, y1: -3 } });
  }
  // classic coiled snake
  const j = () => (r() - 0.5) * 1.2;
  const pts = catmull([[-11, -1.5], [-6, -2.2 + j()], [0, -1.6], [6, -3.2], [7.5, -7], [2, -9 + j()], [-5, -9.6], [-5.6, -14], [-1, -17 + j()], [3.4, -20], [5, -22.5]], 5);
  const Nn = pts.length;
  c.chain(pts, (i) => i < 6 ? 0.9 + i * 0.28 : 2.5, (i) => (i >> 1) % 3 === 0 ? dk : (i >> 1) % 3 === 1 ? col : lt);
  for (let i = 4; i < Nn - 6; i += 4) c.p1(pts[i][0] + 0.5, pts[i][1] - 1, sh(col, 2));
  snakeHead(c, K, 6, -22.4, 1);
  K.face = col;
  return A({ head: { x: 6, y: -22.4, rx: 4, ry: 3.2 }, chin: { x: 3, y: -17.5 }, hand: { x: 8.5, y: -13.5 }, hand2: { x: -3, y: -8 }, torso: { x0: -6, x1: 6, y0: -11, y1: -3 } });
}

// ---- reptile ---------------------------------------------------------------------------------------
function reptile(c, K) {
  const n = K.name, col = K.col, dk = sh(col, -1), dk2 = sh(col, -2), lt = sh(col, 1);
  const frog = /frog|toad|newt/i.test(n), croc = /croc|gator|alligator/i.test(n);
  if (frog) {
    c.O(-1, -7.5, 7.6, 6.4, col); c.O(1, -5, 5, 3.4, lt, true);
    c.O(-5, -4.6, 4.4, 3.6, dk); c.R(-9, -1.4, 6, 1.4, dk2); c.R(-9, -1.4, 1.2, 1.4, lt);
    c.R(3.6, -6, 2.6, 6, dk); c.R(3.4, -1.2, 4, 1.2, dk2);
    c.O(5, -10.4, 5, 3.6, col);
    c.O(2.4, -15, 2.7, 2.7, col); c.O(7.2, -14.6, 2.7, 2.7, col);                   // bulging eyes
    c.E(2.4, -15); c.E(7.2, -14.6);
    c.R(3, -9.4, 8, 1, '#3a1a30'); c.O(4.5, -6.4, 2.4, 1.6, '#F08FA0', true);
    c.O(-3, -11, 1, 1, dk2, true); c.O(0, -12, 1, 1, dk2, true);
    K.face = col;
    return A({ head: { x: 5, y: -10.5, rx: 5, ry: 3.6 }, chin: { x: 5, y: -7.2 }, hand: { x: 9, y: -4.4 }, hand2: { x: 0, y: -8 }, torso: { x0: -7, x1: 6, y0: -14, y1: -3 } });
  }
  const long = croc ? 1.1 : 1, lz = !croc;
  const body = croc ? 8.4 : 6.8;
  // far legs
  c.R(-6.5, -4, 2.4, 4, dk2); c.R(2.5, -4, 2.4, 4, dk2);
  // tail
  c.G([[-7, -7.4], [-14.5, croc ? -4.4 : -11], [-15, croc ? -2.8 : -9.4], [-8, -3.4]], dk);
  c.G([[-9, -6.6], [-14.5, croc ? -4 : -10.5], [-10, -4.4]], col);
  c.O(-1.2, -7.4, body, 4.4 * long, col); c.O(0, -5.2, body - 1.6, 2.2, lt, true);
  for (let x = -9; x < 6; x += 2.4) c.G([[x, -11.2], [x + 1.2, croc ? -12.4 : -14.4], [x + 2.4, -11.2]], lz ? lt : dk);
  // near legs
  c.B(-7.5, -5.6, 3, 5.6, dk); c.B(3, -5.6, 3, 5.6, col); c.R(-8.2, -1.2, 4.2, 1.2, dk2); c.R(2.6, -1.2, 4.4, 1.2, dk2);
  // head
  const hx = croc ? 9 : 8.2;
  c.O(hx, -8.4, 4, 3.2, col);
  c.B(hx + 1, -9.6, croc ? 7 : 5, 2.8, lt);                                           // upper snout
  c.R(hx + 1, -6.2, croc ? 6.6 : 4.6, 1.5, dk);                                        // lower jaw
  for (let i = 0; i < (croc ? 4 : 3); i++) { c.R(hx + 1.8 + i * 1.7, -6.9, 0.9, 1, '#ffffff'); c.R(hx + 2.6 + i * 1.7, -6.1, 0.9, 1, '#ffffff'); }
  c.P(hx + (croc ? 7 : 5) - 0.4, -9.6, '#1A1023');
  c.E(hx - 1.6, -10.6); c.E(hx + 2.2, -10.6);
  K.face = col;
  return A({ head: { x: hx, y: -8.6, rx: 4, ry: 3.2 }, chin: { x: hx - 4.5, y: -5.6 }, hand: { x: hx + 2.6, y: -3 }, hand2: { x: 0, y: -8 }, torso: { x0: -7, x1: 5.5, y0: -12, y1: -3 } });
}

// ---- dragon ----------------------------------------------------------------------------------------
function dragon(c, K) {
  const col = K.col, dk = sh(col, -1), dk2 = sh(col, -2), lt = sh(col, 1), whelp = /whelp/i.test(K.name);
  const mem = mix(col, '#B04A8A', 0.45), wy = whelp ? 0.78 : 1;
  c.under(() => {
    c.G([[-2, -14], [-11, -14 - 11 * wy], [-8, -14 - 7 * wy], [-5, -14 - 12 * wy], [-2.5, -14 - 6.5 * wy], [1, -14 - 11 * wy], [2.5, -14 - 4 * wy], [3, -12]], sh(mem, -1));
    c.L(-2, -14, -11, -14 - 11 * wy, dk2, 0.9); c.L(-2, -14, -5, -14 - 12 * wy, dk2, 0.9); c.L(-2, -14, 1, -14 - 11 * wy, dk2, 0.9);
  });
  c.G([[-7, -12], [-14, -10], [-16, -6], [-12.5, -6.6], [-13, -9], [-8, -8]], dk);
  c.G([[-14, -9.6], [-17, -9.6], [-16, -5], [-12.8, -6.8]], dk2);
  c.R(-7, -6.5, 3, 6.5, dk2); c.R(-4.6, -1.2, 3.5, 1.2, dk2);
  c.O(-1, -10, 7.8, 4.8, col); c.O(0.5, -7.8, 6, 2.6, '#F5DCA0', true);
  for (let x = -4; x < 5; x += 2.4) c.R(x, -8.8, 1.2, 0.7, '#D9B878');
  for (let x = -7; x < 3; x += 2.6) c.G([[x, -14.4], [x + 1, -16.6], [x + 2, -14.4]], dk2);
  c.B(2.2, -7, 3.2, 7, col); c.R(2.2, -1.2, 4.4, 1.2, dk2);
  c.chain([[3.5, -12], [4.7, -15], [6, -18], [7.5, -20]], () => 2.1, (i) => i % 2 ? col : lt);
  c.O(9, -21.5, 3.6, 3, col); c.B(10.4, -21.8, 4.4, 2.6, lt); c.R(10.4, -19.2, 4, 1, dk2); c.P(13.6, -21.6, '#1A1023');
  c.G([[7, -23.4], [4, -27], [8.6, -24.6]], '#F5DCA0'); c.G([[9.6, -24], [8.6, -27.6], [11.6, -24.2]], '#E9D8A8');
  c.E(7.7, -22.4); c.E(10.8, -22.8);
  c.P(11.5, -18.9, '#fff'); c.P(13, -18.9, '#fff');
  K.face = col;
  return A({ head: { x: 9, y: -21.5, rx: 3.6, ry: 3, }, chin: { x: 7.5, y: -17.8 }, hand: { x: 6.8, y: -6 }, hand2: { x: -3, y: -8 }, torso: { x0: -7, x1: 5, y0: -15, y1: -6 }, topY: -27.6 });
}

// ---- plant -----------------------------------------------------------------------------------------
function plant(c, K) {
  const n = K.name, col = K.col, stem = mix(col, '#3E8E2E', 0.62), sd = ramp(stem), dk = sh(col, -1), lt = sh(col, 1);
  c.O(0, -1.5, 7, 2.6, '#6E4E2C'); c.R(-4, -2.5, 3, 1, '#866043'); c.R(2, -2, 2, 1, '#5E4526');
  if (/vine/i.test(n)) {
    const pts = []; for (let i = 0; i <= 18; i++) pts.push([2.6 * Math.sin(i * 0.8), -2 - i]);
    c.chain(pts, () => 1.6, (i) => i % 4 < 2 ? stem : sd[1]);
    for (const [y, s] of [[-6, -1], [-11, 1], [-15, -1]]) c.G([[0, y], [s * 8, y - 3], [s * 5, y + 2]], i0(s) ? sd[2] : sd[3]);
    c.O(1, -22.5, 4.6, 4.4, col); c.E(0.2, -22.8); c.E(3.8, -22.8); c.R(0.6, -20, 3.6, 1, '#3a1a30');
    c.G([[0, -26.5], [-4, -30], [-1, -27]], sd[2]);
    K.face = col;
    return A({ head: { x: 1, y: -22.5, rx: 4.6, ry: 4.4 }, chin: { x: 2, y: -18 }, hand: { x: 8, y: -12.5 }, hand2: { x: -8, y: -10 }, torso: { x0: -3, x1: 3, y0: -18, y1: -4 } });
  }
  if (/fern/i.test(n)) {
    for (const [dx, dy, d] of [[-9, -17, 1], [-6, -22, 1], [0, -26, 0], [7, -21, 1], [9, -14, 1], [-10, -10, 1]]) {
      const pts = catmull([[0, -4], [dx * 0.35, dy * 0.4 - 2], [dx, dy]], 5); c.chain(pts, (i, k) => 1.3 - i * 0.04, () => sd[2]);
      for (let k = 1; k < pts.length - 1; k += 2) { c.P(pts[k][0] - 1.4, pts[k][1], sd[3]); c.P(pts[k][0] + 1.4, pts[k][1], sd[1]); }
    }
    c.O(0.5, -9.5, 5.6, 5.4, col);
    c.E(-1.6, -10.6); c.E(2.8, -10.6); c.R(-0.4, -6.6, 4, 1.6, '#3a1a30'); c.P(0, -6.6, '#fff'); c.P(2.6, -6.6, '#fff');
    K.face = col;
    return A({ head: { x: 0.5, y: -9.5, rx: 5.6, ry: 5.4 }, chin: { x: 1, y: -5 }, hand: { x: 9, y: -8 }, hand2: { x: -9, y: -8 }, torso: { x0: -4, x1: 4, y0: -14, y1: -4 } });
  }
  // flytrap
  c.L(0, -3, -1, -13, stem, 2.6); c.L(0.4, -3, -0.6, -13, sd[3], 0.8);
  c.G([[-1, -6], [-9, -10], [-10, -7], [-3, -4]], sd[2]); c.G([[1, -8], [8, -6], [9, -2], [2, -4]], sd[3]); c.L(-1, -6, -8, -8, sd[0], 0.7);
  c.O(1.5, -13.6, 6, 3.6, dk); c.R(-3, -15.6, 12, 1.6, '#4A1530');                         // lower jaw + mouth gap
  c.O(1.8, -19.2, 6.4, 4.2, col);                                                            // upper jaw / head
  c.R(-3.4, -16.2, 12, 1, lt);
  for (let x = -2.4; x < 8; x += 2.4) { c.G([[x, -16.2], [x + 1.2, -14], [x + 2.4, -16.2]], '#fff'); c.G([[x + 1.2, -15.2], [x + 2.4, -17.2], [x + 3.6, -15.2]], '#EEEEDD'); }
  c.R(1, -15, 5, 1, '#c44a6a');
  c.E(0.4, -21); c.E(4.6, -21);
  for (const [x, y] of [[-3, -22], [0, -23.4], [5.8, -22.8]]) c.P(x, y, sh(col, 2));
  K.face = col;
  return A({ head: { x: 1.8, y: -19.2, rx: 6.4, ry: 4.2 }, chin: { x: 1.5, y: -12 }, hand: { x: 9.6, y: -5 }, hand2: { x: -9, y: -8 }, torso: { x0: -3, x1: 3, y0: -13, y1: -4 } });
}
const i0 = s => s < 0;

// ---- blob (+ pudding, leech) -----------------------------------------------------------------------
function blob(c, K) {
  const n = K.name, col = K.col, lt = sh(col, 2), dk = sh(col, -1);
  if (/pudding/i.test(n)) {
    const flan = mix(col, '#F2C36A', 0.55), fr = ramp(flan);
    c.G([[-8.4, 0], [-6.6, -12], [6.6, -12], [8.4, 0]], flan); c.R(4, -11, 3, 11, fr[1]); c.R(-8, -9, 1.2, 8, fr[3]);
    c.O(0, -12, 7, 3, '#7a3d12'); for (const x of [-6, -2.4, 1.6, 5]) c.R(x, -11, 1.8, 3 + ((x * 7) & 3), '#7a3d12');
    c.O(0.6, -15.4, 1.8, 1.8, RED); c.P(0, -16.2, '#ffb0b0'); c.L(0.8, -17, 2.4, -19.4, '#3E8E2E', 0.8);
    c.E(-2.4, -6.2); c.E(2.8, -6.2); c.R(-0.6, -3, 3.6, 1, '#3a1a30');
    K.face = flan;
    return A({ head: { x: 0.2, y: -7, rx: 6, ry: 5 }, chin: { x: 0.5, y: -3 }, hand: { x: 10, y: -5 }, hand2: { x: -9, y: -5 }, torso: { x0: -7, x1: 7, y0: -12, y1: -2 } });
  }
  if (/leech/i.test(n)) {
    const pts = catmull([[-10, -2], [-5, -4], [0, -3.5], [5, -5.5], [8, -10]], 5);
    c.chain(pts, (i, k) => 2.1 + Math.sin(i / k * 3.1) * 1.8, (i) => (i >> 1) % 2 ? col : dk, false);
    for (let i = 3; i < pts.length - 3; i += 3) c.R(pts[i][0], pts[i][1] - 3, 0.9, 5.4, sh(col, -2));
    c.O(8.6, -11.2, 3.4, 3.1, col); c.O(11.4, -11, 1.6, 1.8, '#3a1a30', true); for (const dy of [-1.6, 1.4]) c.P(11.4, -11 + dy, '#fff');
    c.E(7, -12.6); c.E(9.6, -12.6); c.O(-5, -6.5, 1.3, 0.9, lt, true);
    K.face = col;
    return A({ head: { x: 8.6, y: -11.2, rx: 3.4, ry: 3.1 }, chin: { x: 8.6, y: -8 }, hand: { x: 12, y: -4 }, hand2: { x: -4, y: -6 }, torso: { x0: -8, x1: 6, y0: -8, y1: -1 } });
  }
  c.O(0, -8.2, 9.6, 8, col); c.R(-9, -1, 18, 1, dk);
  c.O(-6, -2, 4, 2.2, col, false); c.O(6, -2, 3.6, 2, dk, false);
  c.O(-4.2, -13, 2.6, 1.7, '#ffffff', true); c.R(-7, -10.4, 1, 2, '#ffffff'); c.p1(-1, -14.2, lt);
  c.E(-1.6, -9.4); c.E(3.6, -9.4);
  c.R(0, -5.2, 4.6, 1.2, '#3a1a30'); c.P(2.2, -4.2, '#F08FA0');
  c.R(8.8, -4, 1.6, 4, col); c.O(9.6, 1, 1, 1.2, col, true);                                        // drip
  c.O(12, -3, 1.4, 1.6, lt, true);
  K.face = col;
  return A({ head: { x: 1, y: -9, rx: 7, ry: 6 }, chin: { x: 2, y: -4.4 }, hand: { x: 10.4, y: -6 }, hand2: { x: -9, y: -6 }, torso: { x0: -8, x1: 8, y0: -14, y1: -2 } });
}

// ---- elemental -------------------------------------------------------------------------------------
function elemental(c, K) {
  const n = K.name, r = K.r;
  let el, shape;
  if (/fire|flame|burn/i.test(n)) { el = '#FF8A2A'; shape = 'flame'; }
  else if (/ice|frost/i.test(n)) { el = '#A5D8FF'; shape = 'crystal'; }
  else if (/wind|dust|storm|sand|mirage/i.test(n)) { el = /sand|dust/i.test(n) ? '#DBC890' : /mirage/i.test(n) ? '#F0D8A0' : '#BFD8E8'; shape = /mirage/i.test(n) ? 'shimmer' : 'tornado'; }
  else if (/earth|moss/i.test(n)) { el = /moss/i.test(n) ? '#6BA84A' : '#9C7A4E'; shape = 'rock'; }
  else if (/gas/i.test(n)) { el = '#9BC44A'; shape = 'cloud'; }
  else { el = '#5FA83A'; shape = 'leaves'; }
  const col = mix(K.col, el, 0.55), cr = ramp(col), core = mix(col, '#ffffff', 0.55);
  let head = { x: 1, y: -14, rx: 5, ry: 5 };
  if (shape === 'flame') {
    c.G([[0, -1], [-6.5, -6], [-7, -13], [-3.4, -18.5], [-2.6, -25], [1.2, -20], [3.4, -27], [5.6, -18.5], [7.4, -9.5], [5.4, -3]], cr[2]);
    c.G([[0, -2], [-4.4, -6], [-4.6, -12], [-1.4, -17], [1, -14], [3, -18], [4.6, -10], [3.4, -4]], mix(col, '#FFD060', 0.6));
    c.G([[0, -3], [-2.6, -7], [-1, -11], [1.6, -9], [2.6, -5]], '#FFF1A0');
    c.E(-1.6, -13, 'glow', '#fff1a0'); c.E(3, -13, 'glow', '#fff1a0');
  } else if (shape === 'crystal') {
    c.G([[0, -1], [-6.5, -8], [-4.6, -20], [0.6, -26], [5, -20], [7.4, -8]], cr[2]);
    c.G([[0, -1], [-6.5, -8], [-4.6, -20], [-0.8, -9]], cr[3]); c.G([[0.6, -26], [5, -20], [3, -9], [-0.8, -9]], cr[1]);
    c.L(-0.8, -9, 0.6, -26, '#ffffff', 0.7); c.L(-0.8, -9, 0, -1, cr[0], 0.8);
    c.E(-1.8, -13, 'glow', '#dff4ff'); c.E(3, -13, 'glow', '#dff4ff');
    head = { x: 1, y: -16, rx: 4, ry: 4 };
  } else if (shape === 'tornado') {
    for (let i = 0; i < 8; i++) { const y = -3 - i * 2.9, w = 2.4 + i * 0.95; c.O(((i % 2) ? 0.6 : -0.6), y, w, 1.9, i % 2 ? cr[3] : cr[1], true); c.R(-w * 0.7, y - 0.4, w * 0.9, 0.8, '#ffffff'); }
    c.E(-1.6, -22, 'glow', '#ffffff'); c.E(3, -22, 'glow', '#ffffff');
    head = { x: 1, y: -22, rx: 5, ry: 4 };
  } else if (shape === 'shimmer') {
    for (let i = 0; i < 8; i++) { const y = -2 - i * 3.2, w = 6 + Math.sin(i * 1.3) * 1.6; c.R(-w + (i % 2) * 0.8, y, 2 * w, 1.6, i % 2 ? cr[3] : cr[2]); }
    for (let i = 0; i < 14; i++) c.p1(-7 + r.int(15), -4 - r.int(22), '#ffffff');
    c.E(-1.6, -18, 'glow', '#ffffff'); c.E(3, -18, 'glow', '#ffffff');
    head = { x: 1, y: -18, rx: 5, ry: 4 };
  } else if (shape === 'rock') {
    c.B(-6, -14, 12, 12, cr[2]); c.B(-9, -10, 5, 6, cr[1]); c.B(4.6, -11, 5, 6, cr[3]); c.B(-3.4, -8, 7, 8, cr[2]); c.B(-4, -21, 8, 7, cr[3]);
    c.R(-5, -13, 3, 1, cr[0]); c.R(1, -7, 4, 1, cr[0]); if (/moss/i.test(n)) for (const [x, y] of [[-6, -14], [-3, -21], [2, -21], [4, -11]]) c.R(x, y, 3, 1.4, '#6BA84A');
    c.E(-1.8, -17.5, 'glow', '#fff1a0'); c.E(2.4, -17.5, 'glow', '#fff1a0');
    head = { x: 0, y: -17, rx: 4, ry: 3.5 };
  } else if (shape === 'cloud') {
    for (const [x, y, rr] of [[-4.5, -8, 5], [4, -8, 5], [0, -14, 6], [-5.5, -14.5, 3.6], [5.5, -14, 3.6], [0, -5, 5]]) c.O(x, y, rr, rr, cr[2]);
    c.O(-2, -15, 3, 2, cr[3], true);
    c.E(-1.8, -12, 'glow', '#eaffb0'); c.E(2.6, -12, 'glow', '#eaffb0');
    head = { x: 0.5, y: -12, rx: 5, ry: 4 };
  } else {                                                                                       // leaves / orb
    c.O(0.5, -12, 7, 7.2, cr[2]);
    for (const [x, y, s] of [[-8, -8, -1], [8, -14, 1], [-7, -18, -1], [6, -4, 1]]) { c.G([[x, y], [x + s * 4, y - 3], [x + s * 6, y + 0.5], [x + s * 3, y + 2]], '#5FA83A'); c.L(x, y, x + s * 5, y - 0.5, '#3E8E2E', 0.7); }
    c.E(-1.6, -12.4, 'glow', '#eaffb0'); c.E(3, -12.4, 'glow', '#eaffb0');
    head = { x: 0.6, y: -12.4, rx: 5, ry: 4.4 };
  }
  // floating shards around the core
  for (let i = 0; i < 4; i++) {
    const a = r() * 6.28, d = 8.5 + r() * 2.5, x = Math.cos(a) * d, y = -13 + Math.sin(a) * d * 0.9;
    if (y > -1.5) continue;
    c.G([[x, y - 1.5], [x + 1.2, y], [x, y + 1.5], [x - 1.2, y]], i % 2 ? core : cr[3]);
  }
  K.face = col;
  return A({ head, chin: { x: head.x + 0.5, y: head.y + head.ry }, hand: { x: 9.2, y: -9 }, hand2: { x: -9, y: -9 }, torso: { x0: -6, x1: 6, y0: -18, y1: -4 }, topY: undefined });
}

// ---- object (mimics, golems, logs, rocks) ----------------------------------------------------------
function object(c, K) {
  const n = K.name, col = K.col, r = K.r;
  if (/chair/i.test(n)) {
    const wood = mix('#9C7A4E', col, 0.25), wr = ramp(wood);
    for (const x of [-8, 5.4]) c.B(x, -9, 2.8, 9, wr[1]); c.B(-6.5, -9, 2, 8, wr[0]); c.B(4.4, -9, 2, 8, wr[0]);
    c.B(-6.5, -25, 13, 14, wr[2]); for (const x of [-3.2, 0, 3.2]) c.R(x, -23, 1.1, 10, wr[0]);
    c.B(-8.4, -12, 16.8, 4, wr[3]); c.R(-8, -9.5, 16, 2, '#7A1030'); for (let x = -7.4; x < 7; x += 2.6) { c.G([[x, -9.7], [x + 1.3, -7.6], [x + 2.6, -9.7]], '#fff'); }
    c.R(-1, -8, 3.4, 1.6, '#e0607a');
    c.E(-3.4, -20); c.E(3, -20); c.R(-6.4, -24.4, 4.8, 1, '#3a2418'); c.R(1.6, -24.4, 4.8, 1, '#3a2418');
    K.face = wood;
    return A({ head: { x: 0, y: -20, rx: 6, ry: 5 }, chin: { x: 0, y: -14.6 }, hand: { x: 10, y: -6 }, hand2: { x: -10, y: -6 }, torso: { x0: -6.5, x1: 6.5, y0: -24, y1: -11 } });
  }
  if (/chandelier/i.test(n)) {
    const br = ramp('#E6B93C');
    c.L(0, -30, 0, -21, '#9aa0ac', 1); c.R(-1.4, -21, 2.8, 2, br[1]);
    c.L(-9, -13.5, 0, -19.5, br[2], 1.4); c.L(9, -13.5, 0, -19.5, br[2], 1.4);
    c.B(-10, -14, 20, 2.4, br[2]);
    c.O(0, -13, 5, 4.6, br[3]);
    for (const x of [-8.5, -4.5, 4, 8]) { c.R(x, -19, 1.8, 5, CREAM); c.G([[x - 0.2, -19], [x + 0.9, -23], [x + 2, -19]], '#FF8A2A'); c.P(x + 0.4, -20, '#FFF1A0'); }
    for (const x of [-8, -4, 3.4, 7.4]) { c.R(x + 0.4, -11.8, 1, 3, '#aee8ff'); c.G([[x, -9], [x + 1, -7], [x + 2, -9]], '#cdf2ff'); }
    c.R(-4, -2.4, 2.4, 2.4, br[0]); c.R(3, -2.4, 2.4, 2.4, br[0]);
    c.E(-1.8, -13.6, 'normal'); c.E(2.4, -13.6, 'normal'); c.R(-1, -10, 3.6, 1, '#3a1a30');
    K.face = br[2];
    return A({ head: { x: 0.3, y: -13.4, rx: 5, ry: 4.6 }, chin: { x: 0.5, y: -9 }, hand: { x: 11, y: -8 }, hand2: { x: -11, y: -8 }, torso: { x0: -8, x1: 8, y0: -14, y1: -8 }, topY: -29 });
  }
  if (/log\b/i.test(n)) {
    const bark = mix('#5E4526', col, 0.2), br = ramp(bark);
    c.R(-8, -2.5, 2, 2.5, br[0]); c.R(-2, -2.5, 2, 2.5, br[0]); c.R(5, -2.5, 2, 2.5, br[0]);
    c.B(-11, -11, 20, 9, bark); for (let i = 0; i < 6; i++) c.R(-10 + i * 3.4, -10.4, 1, 7.6, br[0]);
    c.O(9, -6.5, 3, 4.5, '#D9B77A'); c.O(9, -6.5, 1.8, 3, '#B98F52', true); c.O(9, -6.5, 0.8, 1.2, '#7a5a30', true);
    c.O(-4, -12, 2, 1.2, '#5FA83A', true); c.L(-7, -11, -9, -15, br[1], 1.2); c.O(-9, -15.5, 1.6, 1.2, '#5FA83A', true);
    c.E(2.2, -8.6, 'normal'); c.E(6.2, -8.6, 'normal');
    c.R(2.8, -4.6, 3.6, 1, '#1A1023');
    K.face = bark;
    return A({ head: { x: 4.4, y: -8.2, rx: 4.5, ry: 4 }, chin: { x: 4.4, y: -4 }, hand: { x: 11, y: -5 }, hand2: { x: -11, y: -5 }, torso: { x0: -10, x1: 8, y0: -11, y1: -3 } });
  }
  if (/toenail/i.test(n)) {
    const nail = mix('#E8D8B0', col, 0.2), nr = ramp(nail);
    c.G([[-9, 0], [-8, -12], [-4, -19], [3, -20], [8, -14], [9, 0]], nail);
    c.G([[-9, 0], [-8, -12], [-4, -19], [-4.5, -4]], nr[3]); c.G([[6.5, -15], [8, -14], [9, 0], [6, 0]], nr[1]);
    for (const x of [-3, 1, 5]) c.R(x, -17, 0.9, 16, nr[1]);
    c.R(-9, -1.8, 18, 1.8, '#d09090'); c.E(-3, -11.4); c.E(2.2, -11.4); c.R(-1.4, -6.5, 4.8, 1, '#3a1a30');
    K.face = nail;
    return A({ head: { x: -0.3, y: -11, rx: 5, ry: 4 }, chin: { x: 0, y: -6 }, hand: { x: 10, y: -5 }, hand2: { x: -10, y: -5 }, torso: { x0: -8, x1: 8, y0: -18, y1: -2 } });
  }
  if (/golem/i.test(n)) {
    const brick = /brick|sun-baked/i.test(n), base = brick ? mix('#B8653A', col, 0.2) : mix('#866043', col, 0.25), gr = ramp(base);
    c.B(-5.5, -8, 4.6, 8, gr[1]); c.B(1, -8, 4.6, 8, gr[2]); c.R(-6.4, -1.8, 5.8, 1.8, gr[0]); c.R(1, -1.8, 6, 1.8, gr[0]);
    c.B(-10, -19, 4, 10, gr[1]); c.B(-10.6, -9.5, 4.8, 4.5, gr[2]);
    c.B(-7, -20, 14, 12.4, gr[2]); c.B(-4, -28.4, 9.4, 8.4, gr[3]);
    c.B(6.4, -19, 4, 10, gr[3]); c.B(6.2, -9.5, 5.2, 5, gr[3]);
    if (brick) { for (let y = -19; y < -8; y += 2.6) c.R(-7, y, 14, 0.7, gr[0]); for (let y = -19, k = 0; y < -8; y += 2.6, k++) for (let x = -7 + (k % 2) * 3; x < 7; x += 6) c.R(x, y, 0.7, 2.6, gr[0]); }
    else { for (const [x, y] of [[-5, -16], [2, -13], [-2, -10], [4, -18]]) c.R(x, y, 2, 1.4, gr[0]); c.R(-6, -8, 1.4, 3, gr[1]); c.R(5, -8, 1.4, 4, gr[1]); }
    c.E(-1.8, -25, 'glow', '#fff1a0'); c.E(3, -25, 'glow', '#fff1a0'); c.R(-1.4, -21.4, 5, 1, '#1A1023');
    K.face = gr[3];
    return A({ head: { x: 0.7, y: -24.4, rx: 4.7, ry: 4.2 }, chin: { x: 1, y: -20 }, hand: { x: 9.4, y: -9 }, hand2: { x: -9, y: -9 }, torso: { x0: -7, x1: 7, y0: -20, y1: -8 } });
  }
  if (/rock/i.test(n)) {
    const stone = mix('#8C8C8C', col, 0.3), sr = ramp(stone);
    c.R(-6, -3, 2.4, 3, sr[0]); c.R(-1, -3, 2.4, 3, sr[0]); c.R(4, -3, 2.4, 3, sr[0]);
    c.O(0, -9.4, 8.2, 7.2, stone); c.G([[-1, -16], [1, -12], [-1, -9], [2, -4]], sr[0]); c.O(-3.6, -13, 2.4, 1.4, sr[4], true);
    c.E(-2.6, -10.6); c.E(2.8, -10.6); c.R(-1.2, -6.2, 4.4, 1.2, '#1A1023');
    K.face = stone;
    return A({ head: { x: 0, y: -10, rx: 6, ry: 5 }, chin: { x: 0.4, y: -5 }, hand: { x: 9, y: -5 }, hand2: { x: -9, y: -5 }, torso: { x0: -7, x1: 7, y0: -14, y1: -4 } });
  }
  // generic chest mimic
  const wood = mix(PAL.chest, col, 0.2), wr = ramp(wood);
  c.B(-8, -9, 16, 9, wr[2]); c.R(-8, -4.8, 16, 1, wr[0]); c.R(-1.2, -8, 2.4, 3.6, GOLD);
  c.G([[-8, -9], [-8, -16], [-2, -20], [8, -20], [8, -16], [8, -9]], wr[3]); c.R(-8, -16, 16, 1, wr[1]);
  c.R(-7, -9.6, 14, 1.6, '#7A1030'); for (let x = -6.6; x < 7; x += 2.6) c.G([[x, -9.6], [x + 1.3, -7.6], [x + 2.6, -9.6]], '#fff');
  c.E(-3, -14.6); c.E(2.6, -14.6); c.R(-2, -5, 4, 1.4, '#e0607a');
  K.face = wood;
  return A({ head: { x: 0, y: -14, rx: 6, ry: 4 }, chin: { x: 0, y: -9 }, hand: { x: 9.5, y: -5 }, hand2: { x: -9, y: -5 }, torso: { x0: -8, x1: 8, y0: -16, y1: -4 } });
}

// ---- fish (a catfish out of water, on legs) --------------------------------------------------------
function fish(c, K) {
  const col = K.col, dk = sh(col, -1), dk2 = sh(col, -2), lt = sh(col, 2);
  c.R(-2.5, -5, 2, 5, dk2); c.R(1.5, -5, 2, 5, dk2); c.R(-3.5, -1.2, 3.4, 1.2, dk2); c.R(1.2, -1.2, 3.6, 1.2, dk2);
  c.G([[-7, -11], [-14, -17], [-13, -11], [-14, -6], [-7, -9]], dk);
  c.G([[-3, -15], [-1, -20], [3, -15]], dk2);
  c.O(0, -10.6, 8.4, 5.6, col); c.O(1.4, -8.4, 5.4, 2.6, lt, true);
  c.G([[-1, -11], [-5, -8], [-1, -7]], dk);
  c.O(6.6, -11.6, 3.8, 3.6, col); c.O(8.8, -10.6, 2.2, 2, sh(col, 1));
  c.L(8.4, -8.6, 14, -6.5, dk2, 0.7); c.L(8.4, -9.4, 14, -11.5, dk2, 0.7); c.L(8, -8, 10, -3.6, dk2, 0.7);
  c.O(4.4, -11, 1.4, 1.4, dk, true); c.O(-1, -12.2, 0.9, 0.9, dk2, true); c.O(-3, -9.4, 0.9, 0.9, dk2, true);
  c.E(4.2, -13.8); c.E(7.8, -13.8);
  c.R(8.4, -9.4, 3, 0.9, '#3a1a30');
  K.face = col;
  return A({ head: { x: 6.6, y: -11.6, rx: 3.8, ry: 3.6 }, chin: { x: 5, y: -7.6 }, hand: { x: 5.2, y: -6.2 }, hand2: { x: -2, y: -8 }, torso: { x0: -6, x1: 6, y0: -15, y1: -5 } });
}

// ---- imp (goblin, gremlin, fairy, sprite) ----------------------------------------------------------
function imp(c, K) {
  const n = K.name, col = K.col, dk = sh(col, -1), dk2 = sh(col, -2), fairy = /fairy|sprite/i.test(n);
  c.under(() => {
    if (fairy) {
      c.G([[-1, -12], [-6, -18], [-9, -26], [-3, -22], [-1, -18]], '#E6F6FF'); c.G([[-1, -11], [-8, -13], [-12, -17], [-5, -16]], '#C9E6FF'); c.L(-1, -12, -8, -22, '#9ac8ee', 0.6);
    } else {
      c.G([[-1, -12], [-7, -17], [-12, -15], [-9, -13], [-12, -9], [-6, -10], [-1, -7]], dk2); c.L(-1, -12, -11, -14.5, sh(col, -3), 0.7);
    }
  });
  c.chain(catmull([[-3, -4], [-8, -5], [-10, -9], [-8.6, -13]], 4), () => 0.9, () => dk2);
  c.G([[-8.6, -13.4], [-11.4, -14.6], [-9, -16.4], [-7, -15]], '#a02a4a');
  c.R(-2.6, -5.4, 2.2, 5.4, dk); c.R(0.8, -5.4, 2.2, 5.4, col); c.R(-3.4, -1.2, 3, 1.2, dk2); c.R(0.6, -1.2, 3.8, 1.2, dk2);
  c.O(0, -9.6, 3.9, 4.6, col); c.O(1, -8.4, 2.2, 2.6, sh(col, 2), true);
  c.L(3.4, -12, 5.6, -8, dk, 1.4); c.R(5, -8.2, 1.8, 1.8, col); c.L(-3, -12, -5, -7.5, dk2, 1.2);
  c.G([[-3, -16], [-9.4, -20], [-3.6, -19.4]], dk); c.G([[3.6, -16.4], [8, -21], [4, -19]], col);
  c.O(0.6, -17, 5.4, 4.8, col);
  c.G([[-1.6, -20.6], [-3.6, -25.2], [-0.2, -21.6]], '#F5DCA0'); c.G([[2.4, -21.4], [3.6, -25.6], [4.4, -21]], '#F5DCA0');
  c.E(-0.8, -17.4); c.E(3.8, -17.4);
  c.R(0.4, -14.2, 4.6, 1.2, '#3a1a30'); c.G([[0.6, -14], [1.4, -12.4], [2.2, -14]], '#fff'); c.G([[3, -14], [3.8, -12.4], [4.6, -14]], '#fff');
  K.face = col;
  return A({ head: { x: 0.6, y: -17, rx: 5.4, ry: 4.8 }, chin: { x: 1.2, y: -12.4 }, hand: { x: 6.5, y: -7.4 }, hand2: { x: -4.5, y: -8 }, torso: { x0: -3.9, x1: 3.9, y0: -13, y1: -5 }, topY: -25.4 });
}

// ---- shark: a fin and a wake, nothing else ----------------------------------------------------------
function drawShark(id, e) {
  const B = BOX.enemy, { c, g } = canvas(B.w, B.h), r = rng('enemy/' + id), col = enemyColor(e), rp = ramp(col);
  const t = e.t || 0, tall = 11 + (t === 1 ? 3 : t === 2 ? 1 : 0) + r.int(2), cx = B.ax, by = B.ay - 5;
  const ctx = makeCtx(g, cx, by, 1);
  ctx.O(1, 2.4, 10, 3.4, 'rgba(24,48,140,0.5)', true);                                                         // dark submerged body under the surface
  if (t === 2) { ctx.O(-9, 2, 5, 2.2, 'rgba(24,48,140,0.5)', true); ctx.O(9, 2, 5, 2.2, 'rgba(24,48,140,0.5)', true); }  // hammerhead outline under water
  // dorsal fin (top-left light)
  ctx.G([[-4.5, 1], [-1, -tall], [0.8, -tall - 0.5], [4, -tall * 0.55], [8, 1]], rp[2]);
  ctx.G([[-4.5, 1], [-1, -tall], [0, -tall * 0.4], [0, 1]], rp[3]); ctx.G([[3, -tall * 0.5], [4, -tall * 0.55], [8, 1], [4, 1]], rp[1]);
  if (t === 4) for (let i = 0; i < 3; i++) ctx.R(0.5 + i * 1.5, -tall * 0.4 + i * 2.5, 1, 2, rp[0]);
  ctx.R(-4.5, 0, 12.5, 1.4, rp[1]);
  if (t === 0) ctx.G([[8, 1], [12, -4], [12, 1]], rp[1]);                                           // caudal tip
  outline(c);
  // wake rings drawn over the outline so the water reads as water, not as a sticker
  const ring = (rx, ry, y, cc) => { for (let a = 0; a < 40; a++) { const th = a / 40 * 6.283, x = Math.round(cx + Math.cos(th) * rx), yy = Math.round(by + y + Math.sin(th) * ry); if (yy >= by + y - ry + 0 && (a % 5 !== 4)) px(g, x, yy, cc); } };
  ring(11, 3, 2, '#ffffff'); ring(14, 3.8, 2.4, '#bcd4ff');
  for (const x of [-13, -9, 8, 12]) { px(g, cx + x, by + 6 - (x & 1), '#dff0ff'); px(g, cx + x + 1, by + 6 - (x & 1), '#dff0ff'); }
  for (const [dx, dy] of [[-8, 3], [8, 3], [-4, 5], [5, 5], [0, 6]]) px(g, cx + dx, by + dy, '#ffffff');
  for (let i = 0; i < 5; i++) { px(g, cx + 5 + i * 2, by + 2 + ((i * 3 + 1) & 1), '#ffffff'); }       // V wake streaming behind the fin
  return makeSprite(c, B.ax, B.ay);
}

const GEN = { biped, knight, caster, skeleton, ghost, beast, brute, bird, bug, serpent, reptile, dragon, plant, blob, elemental, object, fish, imp };

// ====================================================================================================
// making a creature
// ====================================================================================================
function clothFor(e, r) {
  const h = (((e.t || 0) * 47 + (e.b || 0) * 90) + 150 + r.int(70)) % 360;
  return hsl(h, 42 + r.int(25), 36 + r.int(12));
}

/** One attempt at drawing at scale S; returns { c, ctx, anchors }. */
function drawCreature(e, id, B, S) {
  const { c: cv, g } = canvas(B.w, B.h), r = rng('enemy/' + id), boss = e.ai === 'boss';
  const ctx = makeCtx(g, B.ax, B.ay, S);
  const arch = ARCH_SET.has(e.arch) && e.arch !== 'shark' ? e.arch : inferArch(e.name || '');
  const acc = Array.isArray(e.acc) ? e.acc.slice() : [];
  if (boss && !acc.includes('crown')) acc.push('crown');
  const K = { r, name: e.name || '', col: enemyColor(e), cl: clothFor(e, r), acc, boss, face: enemyColor(e) };
  const gen = GEN[arch] || biped;
  const a = gen(ctx, K);
  applyAcc(ctx, a, K, K.acc);
  return { cv, ctx, a };
}

const fitsBox = (b, B) => b.x0 >= 2 && b.y0 >= 2 && b.x1 <= B.w - 3 && b.y1 <= B.ay + 1;

/** 1px gold rim on the top/left edges of every opaque region, then sparkles and a star (named rares). */
function goldTrim(cv, a, ctx, B, r) {
  const g = cv.getContext('2d', { willReadFrequently: true }), w = cv.width, h = cv.height, d = g.getImageData(0, 0, w, h).data;
  const op = (x, y) => x >= 0 && y >= 0 && x < w && y < h && d[(y * w + x) * 4 + 3] > 40;
  const rim = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (op(x, y) && (!op(x - 1, y) || !op(x, y - 1))) rim.push(x, y);
  g.fillStyle = GOLD; for (let i = 0; i < rim.length; i += 2) g.fillRect(rim[i], rim[i + 1], 1, 1);
  outline(cv);
  // star above the head (or top-right if there is no room)
  const b = ctx.st.b; let sx = Math.min(B.w - 5, Math.max(4, ctx.X(a.head.x))), sy = b.y0 - 3;
  if (sy < 3) { sy = 4; sx = Math.min(B.w - 4, b.x1 + 2); }
  const star = (x, y, big) => {
    g.fillStyle = GOLD; g.fillRect(x - 1, y, 3, 1); g.fillRect(x, y - 1, 1, 3);
    if (big) { g.fillRect(x - 2, y, 1, 1); g.fillRect(x + 2, y, 1, 1); g.fillRect(x, y - 2, 1, 1); }
    g.fillStyle = '#fff3d0'; g.fillRect(x, y, 1, 1);
  };
  star(sx, sy, true);
  const spots = [[b.x0 - 3, b.y0 + 4], [b.x1 + 3, b.y0 + 9], [b.x0 - 2, b.y1 - 6], [b.x1 + 2, b.y1 - 10]];
  let n = 0;
  for (const [x, y] of spots) { if (n >= 3) break; if (x >= 3 && x <= B.w - 4 && y >= 3 && y <= B.h - 4 && !op(x, y) && !op(x + 1, y) && !op(x - 1, y) && !op(x, y + 1) && !op(x, y - 1)) { star(x, y, false); n++; } }
  return cv;
}

/** Sprite for an enemy id ('jungle-00', 'shark-3', 'rare-castle-1'). Faces RIGHT (the renderer flips).
 *  Box: BOX.enemy (32 x 40, anchor 16,36); tier-24 bosses use BOX.boss (64 x 72, anchor 32,66). Outlined.
 *  Unknown id: a generic outlined blob. Never throws. */
export function makeEnemy(id) {
  try {
    const e = enemyById(id);
    if (!e) return makeGeneric(id);
    if (e.b < 0 || e.arch === 'shark') return drawShark(id, e);
    const boss = e.ai === 'boss', rare = !!e.rare, B = boss ? BOX.boss : BOX.enemy;
    let S = boss ? 2.2 : rare ? 1.23 : (SIZES[e.size] || 1), res = null;
    for (let tries = 0; tries < 16; tries++) {
      res = drawCreature(e, id, B, S);
      if (fitsBox(res.ctx.st.b, B)) break;
      S *= 0.94;
    }
    if (rare) goldTrim(res.cv, res.a, res.ctx, B, rng('rare/' + id)); else outline(res.cv);
    return makeSprite(res.cv, B.ax, B.ay);
  } catch (err) {
    return makeGeneric(id);
  }
}

function makeGeneric(id) {
  const B = BOX.enemy, { c, g } = canvas(B.w, B.h), r = rng('enemy/' + id);
  const ctx = makeCtx(g, B.ax, B.ay, 1), K = { r, name: '', col: '#B8A0D8', cl: '#6a4a98', acc: [] };
  ctx.O(0, -8, 9 + r.int(2), 7.5, K.col); ctx.R(-9, -1, 18, 1, sh(K.col, -1)); ctx.E(-2.4, -9.4); ctx.E(3, -9.4); ctx.R(0, -5.4, 4, 1, '#3a1a30');
  outline(c);
  return makeSprite(c, B.ax, B.ay);
}

// ====================================================================================================
// NPCs
// ====================================================================================================
const SKINS = ['#E8B890', '#D9A06F', '#F2CBA0', '#B9774B', '#8D5A3A'];
const NPC_LOOK = {
  brenda: { skin: SKINS[0], shirt: '#2F8F8A', pants: '#6a6a7a', hair: '#6B4226', hairStyle: 'bob', smile: true },
  phil: { skin: SKINS[2], shirt: '#8A8E9B', pants: '#6E7280', hair: '#8a8a8a', hairStyle: 'sides', smile: true, hw: 5.5 },
  dennis: { skin: SKINS[1], shirt: '#8F3B4A', pants: '#8F3B4A', hair: '#4a3022', hairStyle: 'tufted', smile: true, robe: true, mustache: '#4a3022', shoe: '#e8e0c8' },
  crystal: { skin: SKINS[3], shirt: '#7A4FB0', pants: '#5a3a80', hair: '#E07A30', hairStyle: 'wild', smile: true },
  marguerite: { skin: SKINS[2], shirt: '#3F6E4A', pants: '#4a4a58', hair: '#b0a8a0', hairStyle: 'bun', smile: true },
  gary: { skin: SKINS[1], shirt: '#8B6F45', pants: '#5a4630', hair: '#c8c8c8', hairStyle: 'sides', smile: true, stoop: 2, bent: true, beard: '#d4d4dc', beardLong: false },
  intern: { skin: SKINS[0], shirt: '#C7A86A', pants: '#6a5a40', hair: '#3a2418', hairStyle: 'messy', smile: true, hw: 4.5 },
  clerk: { skin: SKINS[2], shirt: '#E8E4F0', pants: '#4a4a62', hair: '#5a4630', hairStyle: 'tuft', smile: true },
  // ---- v0.3 pool (builder B) ----
  deborah: { skin: SKINS[3], shirt: '#5B4F8C', pants: '#3a3550', hair: '#2a1a14', hairStyle: 'bob', smile: false },
  chad: { skin: SKINS[0], shirt: '#23232F', pants: '#4a5a7a', hair: '#d8b860', hairStyle: 'tufted', smile: true, noBelt: true, shoe: '#f0f0f0' },
  tammy: { skin: SKINS[2], shirt: '#FF7AB6', pants: '#EDE4F2', hair: '#F0D070', hairStyle: 'wild', smile: true },
  skye: { skin: SKINS[1], shirt: '#F5E6D3', pants: '#A8B8C8', hair: '#3a2418', hairStyle: 'bun', smile: true, hw: 4.5 },
  rashid: { skin: SKINS[4], shirt: '#2FA36B', pants: '#3a4a5a', hair: '#1a1010', hairStyle: 'tuft', smile: false, shoe: '#8B5A2B' },
  pemberton: { skin: SKINS[2], shirt: '#B85A8A', pants: '#B85A8A', hair: '#D8D0E0', hairStyle: 'bun', smile: false, robe: true, shoe: '#5a2a40' },
  brick: { skin: SKINS[1], shirt: '#FF6A00', pants: '#2b2b3a', hair: null, hairStyle: null, smile: true, hw: 6.5, shoe: '#f0f0f0' },
  sallow: { skin: '#D8D0C0', shirt: '#2b2233', pants: '#2b2233', hair: '#1a1023', hairStyle: 'sides', smile: false, stoop: 1 },
  jasper: { skin: SKINS[0], shirt: '#8FD3FF', pants: '#C8B898', hair: '#A0582A', hairStyle: 'messy', smile: true, shoe: '#e8e8f0' },
  duke: { skin: SKINS[2], shirt: '#3A3A48', pants: '#5a4630', hair: '#7a6040', hairStyle: 'sides', smile: false, beard: '#7a6040', hw: 5.5 },
  vivienne: { skin: SKINS[3], shirt: '#C0392B', pants: '#2b2233', hair: '#F2D8A0', hairStyle: 'bob', smile: true },
  consultant: { skin: SKINS[2], shirt: '#2E3A55', pants: '#2E3A55', hair: '#3a2a20', hairStyle: 'tuft', smile: false },
  ambrose: { skin: SKINS[1], shirt: '#6A4A32', pants: '#6A4A32', hair: '#5a4630', hairStyle: 'sides', smile: true, robe: true, shoe: '#8B5A2B' },
  warranty: { skin: SKINS[0], shirt: '#F4F1E8', pants: '#4a4a62', hair: '#8a5a30', hairStyle: 'tufted', smile: true },
  grail: { skin: SKINS[2], shirt: '#FFFFFF', pants: '#3a3a48', hair: '#D0D0D8', hairStyle: 'wild', smile: true, mustache: '#D0D0D8' },
  dunleavy: { skin: SKINS[3], shirt: '#2B4A8A', pants: '#1f2f5a', hair: '#2a1a14', hairStyle: 'tufted', smile: false, mustache: '#2a1a14' },
  ombudsman: { skin: SKINS[4], shirt: '#6E6A3A', pants: '#4a4030', hair: '#E8E8E8', hairStyle: 'sides', smile: false, beard: '#E8E8E8', beardLong: true, stoop: 1 },
  careunit: { skin: '#B9C2CC', shirt: '#8FA0B4', pants: '#6E7A8A', hair: null, hairStyle: null, smile: false, shoe: '#4a5260', noBelt: true },
  // ---- ambient folk looks for World Life (builder B, requested by the architect) ----
  'folk-merchant': { skin: SKINS[1], shirt: '#3E7A5A', pants: '#3E7A5A', hair: '#4a3022', hairStyle: 'sides', smile: true, robe: true, mustache: '#4a3022' },
  'folk-gossip': { skin: SKINS[2], shirt: '#9A5CC6', pants: '#5a3a70', hair: '#C87A4A', hairStyle: 'bob', smile: true },
  'folk-pilgrim': { skin: SKINS[1], shirt: '#B8A27A', pants: '#B8A27A', hair: '#5a4630', hairStyle: 'tuft', smile: false, robe: true, shoe: '#8B5A2B' },
  'folk-tourist': { skin: '#F2B8A0', shirt: '#3FB8C8', pants: '#E8D8B0', hair: '#E0C080', hairStyle: 'tuft', smile: true, hw: 5.5, shoe: '#ffffff' },
  'folk-mlm': { skin: SKINS[0], shirt: '#2AA89A', pants: '#2b2b3a', hair: '#7a4a2a', hairStyle: 'bun', smile: true },
  'folk-surveyor': { skin: SKINS[3], shirt: '#4a5a6a', pants: '#3a4050', hair: '#2a1a14', hairStyle: null, smile: false, shoe: '#6a4018' },
  'folk-hermit': { skin: SKINS[2], shirt: '#7A7468', pants: '#7A7468', hair: '#C8C8C8', hairStyle: 'wild', smile: false, robe: true, beard: '#D8D8D8', beardLong: true, stoop: 2 },
  'folk-flat': { skin: SKINS[0], shirt: '#E8E4F0', pants: '#4a4a62', hair: '#6a6a6a', hairStyle: 'messy', smile: true },
  'folk-influencer': { skin: SKINS[1], shirt: '#F2F2F2', pants: '#B8E0D0', hair: '#F0E0B0', hairStyle: 'bun', smile: true, hw: 4.5, noBelt: true },
  'folk-ghost': { skin: '#DDE8FF', shirt: '#C8D8F0', pants: '#C8D8F0', hair: '#E8F0FF', hairStyle: 'sides', smile: false, robe: true, shoe: '#C8D8F0' },
  'folk-busker': { skin: SKINS[4], shirt: '#B3322B', pants: '#3a3a58', hair: '#1a1010', hairStyle: 'messy', smile: true },
  'folk-coach': { skin: SKINS[2], shirt: '#3A5FCD', pants: '#3A5FCD', hair: '#3a2418', hairStyle: 'tufted', smile: true, noBelt: true, shoe: '#ffffff' },
  'folk-courier': { skin: SKINS[3], shirt: '#FF7A1A', pants: '#2b2b3a', hair: '#2a1a14', hairStyle: null, smile: false },
  'folk-assessor': { skin: SKINS[2], shirt: '#6E7280', pants: '#4a4a58', hair: '#8a8a8a', hairStyle: 'sides', smile: false, stoop: 1 },
};

/** Sprite for a friendly NPC id (data/npcs.js NPC_POOL ids: 'brenda', 'phil', …). Box: BOX.npc. Faces right. */
export function makeNPC(id) {
  const B = BOX.npc, key = String(id || '').replace(/^npc\//, '');
  let S = 1, res = null;
  const look = NPC_LOOK[key] || { skin: SKINS[0], shirt: '#8FD3FF', pants: '#5b8cff', hair: '#5a4630', hairStyle: 'tuft', smile: true };
  for (let tries = 0; tries < 10; tries++) {
    const { c: cv, g } = canvas(B.w, B.h), r = rng('npc/' + key), ctx = makeCtx(g, B.ax, B.ay, S);
    const K = { r, name: key, col: look.skin, cl: look.shirt, acc: [], face: look.skin };
    try {
      const a = humanoid(ctx, K, look);
      npcProp(ctx, a, key, K);
    } catch (err) { /* never throw from art */ }
    res = { cv, ctx };
    if (fitsBox(ctx.st.b, B)) break;
    S *= 0.94;
  }
  outline(res.cv);
  if (key === 'folk-ghost') {                                                  // see-through, as is their right
    try { const g2 = res.cv.getContext('2d'); g2.globalCompositeOperation = 'destination-in'; g2.fillStyle = 'rgba(0,0,0,0.6)'; g2.fillRect(0, 0, res.cv.width, res.cv.height); g2.globalCompositeOperation = 'source-over'; } catch (e) { /* art never throws */ }
  }
  return makeSprite(res.cv, B.ax, B.ay);
}

/** Ambient-folk sprite ids (World Life points folk at these via npc.look). */
export const FOLK_LOOKS = ['folk-merchant', 'folk-gossip', 'folk-pilgrim', 'folk-tourist', 'folk-mlm', 'folk-surveyor', 'folk-hermit', 'folk-flat', 'folk-influencer', 'folk-ghost', 'folk-busker', 'folk-coach', 'folk-courier', 'folk-assessor'];

function npcProp(c, a, key, K) {
  const H = a.head, T = a.torso, hand = a.hand;
  if (key === 'brenda') {
    c.R(-1.6, -16, 1.2, 8, '#FF7A1A'); c.R(1.6, -16, 1.2, 8, '#FF7A1A'); c.R(-1.6, -16, 4.4, 1, '#FF7A1A');       // lanyard strap
    c.B(-1.6, -9, 4.4, 4.6, '#FFFFFF'); c.R(-0.8, -8.2, 1.6, 1.6, '#8fd3ff'); c.R(-0.8, -6, 3, 0.7, '#8a8498');
    ACC.clipboard(c, a, K);
  } else if (key === 'phil') {
    c.R(-1, -16, 2, 9, '#DDE0EA'); c.G([[-0.8, -16], [0.8, -16], [0.6, -11], [-0.6, -11]], '#DDE0EA');           // shirt strip
    c.R(-5.5, -16, 3, 5, '#6E7280'); c.R(2.5, -16, 3, 5, '#6E7280');
    ACC.tie(c, { chin: { x: 0, y: -15.5 } }); ACC.briefcase(c, a);
    c.R(H.x - 4, H.y - 4.6, 8, 1.4, '#8a8a8a');
  } else if (key === 'dennis') {
    c.R(-5, -9, 10, 1.4, '#5a1a28'); c.G([[-1.6, -16], [0, -10], [1.6, -16]], '#5a1a28');                         // belt + lapels
    c.R(-1.4, -15, 3, 4, '#e8c4a0');
    const kx = a.hand.x, ky = -7;
    c.O(kx + 1, ky + 1, 2.6, 2.6, GOLD); c.O(kx + 1, ky + 1, 1.4, 1.4, '#3a2a18', true);
    for (const [dx, dy, col] of [[2.4, 2.6, '#c9c9d0'], [0.2, 3.4, '#9aa0ac'], [-1.6, 2.6, '#e6e6ee']]) { c.R(kx + dx, ky + dy, 1.2, 3, col); c.R(kx + dx - 0.4, ky + dy + 2.2, 2, 1, col); }
  } else if (key === 'crystal') {
    for (const [i, col] of ['#FF6A80', '#FFD23F', '#5ECBFF'].entries()) {
      for (let k = 0; k < 7; k++) { const t = k / 6, x = -4 + t * 8, y = -16 + i * 1.8 + Math.sin(t * 3.14) * (3.4 - i * 0.2); c.R(x, y, 1.3, 1.3, k % 2 ? col : sh(col, 1)); }
    }
    c.O(0.4, -9, 1.6, 1.6, '#9A5CC6', true);
  } else if (key === 'marguerite') {
    c.G([[H.x - 4.6, H.y - 3.2], [H.x + 4.8, H.y - 3.2], [H.x + 9, H.y - 2], [H.x + 4.8, H.y - 0.6]], '#3FD46B'); c.R(H.x - 4.6, H.y - 5.4, 9.4, 2.4, '#FFFFFF');
    c.R(H.x - 4.6, H.y - 3.4, 9.4, 0.8, '#3FD46B');
    c.B(hand.x - 2.5, hand.y - 8, 7, 9, '#7A1030'); c.R(hand.x + 3.6, hand.y - 7.2, 1, 7.8, CREAM); c.R(hand.x - 2.5, hand.y - 7.6, 1.2, 1.2, GOLD); c.R(hand.x - 2.5, hand.y - 0.6, 1.2, 1.2, GOLD);
    c.R(hand.x - 0.6, hand.y - 6, 3, 0.7, GOLD); c.R(hand.x - 0.6, hand.y - 4, 3, 0.7, GOLD);
  } else if (key === 'gary') {
    const x = hand.x + 1;
    c.R(x, -14, 1.3, 14, '#8B5A2B'); c.R(x - 1.6, -15, 4, 1.4, '#8B5A2B'); c.R(x + 0.1, -14, 0.5, 14, '#B58652');
    c.R(-4.5, -16, 9, 1.4, '#6a5030'); c.G([[-5, -12], [-8, -2], [-4.5, -2], [-3, -12]], '#7a5a38'); c.R(-1, -12, 6, 1, '#c8a868');       // patched cloak/belt
    c.R(-4.6, -6.4, 3.4, 1.1, '#e8e4f0'); c.R(0, -6.4, 3.4, 1.1, '#e8e4f0');                                     // knee wraps
    c.G([[H.x - 5, H.y - 3], [H.x + 5, H.y - 3], [H.x + 4, H.y - 5.4], [H.x, H.y - 6], [H.x - 4, H.y - 5]], '#8a8a96');
  } else if (key === 'intern') {
    const sc = (x, y, w, col) => { c.R(x, y, w, 2.8, col); c.R(x, y, w, 0.8, '#ffffff'); c.R(x - 0.8, y - 0.5, 1.6, 3.8, '#d8b860'); c.R(x + w - 0.8, y - 0.5, 1.6, 3.8, '#d8b860'); c.P(x + w * 0.4, y + 1.2, '#8a6a30'); };
    sc(-6.5, -25, 2.6, '#F2E8C0'); c.R(-7, -24, 2.8, 10, '#F2E8C0'); c.R(-7, -24, 0.9, 10, '#fffaf0'); c.R(-7.4, -24.6, 3.6, 1.4, '#d8b860');
    c.R(6.2, -23, 2.8, 9, '#FFFFFF'); c.R(6.2, -23, 0.9, 9, '#fffaf0'); c.R(5.8, -23.6, 3.6, 1.4, '#d8b860');
    sc(-6, -17.5, 12.5, '#F2E8C0'); sc(-5, -14.8, 12, '#FFFFFF'); sc(-6.2, -12.1, 12.5, '#F2E8C0'); sc(-4.6, -9.4, 11.6, '#FFFFFF');
    c.R(hand.x - 0.6, -9, 2.4, 2.4, K.face); c.R(-6.5, -8.6, 2, 2, K.face);
    c.redrawEyes();
  } else if (key === 'clerk') {
    c.G([[H.x - 4.6, H.y - 3], [H.x + 4.8, H.y - 3], [H.x + 9, H.y - 1.6], [H.x + 4.8, H.y - 0.2]], '#3FD46B'); c.R(H.x - 4.6, H.y - 3.4, 9.4, 1, '#2aa850');
    c.R(-4.5, -16, 1.2, 8, '#8a8498'); c.R(3.6, -16, 1.2, 8, '#8a8498');
    c.B(3, -12, 11, 12, '#8B5A2B'); c.R(3, -12, 11, 1.6, '#B58652'); c.R(4.6, -4, 8, 0.8, '#6a4018');
    c.B(7, -16.2, 3.2, 4.8, '#1A1023'); c.R(7, -16.2, 3.2, 1.2, RED); c.R(6.2, -12, 4.8, 1, '#c8c8d0');
    c.R(11, -13.4, 2.4, 1.4, '#fff3d0');
    c.redrawEyes();
  } else if (key === 'deborah') {
    c.R(-4.5, -16, 9, 1, '#3a3060'); c.G([[-1.8, -16], [0, -12.5], [1.8, -16]], '#F4F1E8');                        // blazer collar + blouse
    for (let i = 0; i < 5; i++) c.P(-2 + i, -15 + (i === 2 ? 1 : i % 2 ? 0.5 : 0), '#FFF8F0');                    // pearls
    const x = hand.x; c.B(x - 3.5, -13, 7, 8, '#B3322B'); c.R(x - 3.5, -13, 2.4, 1.2, '#e05a50'); c.R(x - 2.5, -10, 5, 0.7, '#FFF3D0'); c.R(x - 2.5, -8.5, 4, 0.7, '#FFF3D0');   // the file
    ACC.glasses(c);
  } else if (key === 'chad') {
    c.R(-5, -16, 10, 2.4, '#33334A'); c.R(-1.2, -14, 2.4, 3, '#33334A');                                         // hoodie neck + pocket
    for (let i = 0; i < 6; i++) c.P(-2.4 + i, -15.4 + Math.abs(2.5 - i) * 0.5, GOLD);                              // chain
    c.O(0.6, -11.5, 1.6, 1.6, GOLD); c.P(0.2, -12, '#fff3d0');
    c.R(H.x - 3.4, H.y - 1.6, 9, 2.4, '#14101C'); c.R(H.x - 2.6, H.y - 1.2, 1.4, 0.8, '#5a7aaa');                    // shades
    ACC.phone(c, a);
  } else if (key === 'tammy') {
    c.G([[-5, -16], [-3, -16], [5, -8], [3, -8]], '#FFFFFF'); c.G([[-4.6, -15.4], [-3.4, -15.4], [4.6, -8.6], [3.4, -8.6]], '#E6B93C');   // sash
    c.G([[-1, -13], [1, -14.6], [3, -13], [1, -10.6]], '#5DECF5'); c.P(0.4, -13.6, '#ffffff');                     // diamond pin
    ACC.bottle(c, a, K);
  } else if (key === 'skye') {
    const x = hand.x + 0.5;
    c.L(x, -8, x + 5, -27, '#3a3548', 1); c.B(x + 3.4, -31, 4, 6, '#2a2438'); c.R(x + 4, -30.3, 2.6, 4.4, '#FFB0D0'); c.p1(x + 4.2, -30, '#ffffff');   // selfie stick
    c.O(H.x - 4.2, H.y + 1, 1, 1, GOLD, true);                                                                    // earring
    c.R(-4.5, -10, 9, 3, K.face); c.R(-4.5, -7.6, 9, 1, '#A8B8C8');                                               // crop top
  } else if (key === 'rashid') {
    c.under(() => { c.B(-12, -20, 9, 11, '#2FA36B'); c.R(-12, -20, 9, 1.6, '#3fd48a'); c.R(-10.5, -16, 6, 1, '#1d7a4a'); });   // insulated bag
    c.R(-5, -15.5, 1.6, 7, '#1d7a4a');                                                                            // strap
    const top = H.y - 5; c.R(H.x - 4.6, top - 0.6, 9.2, 2.6, '#2FA36B'); c.R(H.x + 2, top + 1, 5, 1.2, '#1d7a4a'); // cap
    c.R(-1, -13, 3, 2, '#FFFFFF'); c.P(-0.2, -12.6, '#2FA36B');                                                   // badge
  } else if (key === 'pemberton') {
    for (let i = 0; i < 6; i++) c.P(-2.8 + i * 1.1, -15.5 + (i > 1 && i < 4 ? 1 : 0.4), '#FFF8F0');               // pearls
    const x = hand.x; c.B(x - 3, -15, 6, 8, '#FFF3D0'); c.R(x - 2, -13.5, 4, 0.7, '#8a8498'); c.R(x - 2, -12, 3.4, 0.7, '#8a8498'); c.O(x + 0.6, -9.4, 1.6, 1.4, RED, true);   // violation notice
    c.R(H.x - 6, H.y - 5.6, 12, 1.4, '#8F3B6A'); c.B(H.x - 3.6, H.y - 8.6, 7.2, 3.4, '#B85A8A'); c.R(H.x - 3.6, H.y - 6.4, 7.2, 1, '#FFFFFF');   // church hat
    ACC.glasses(c);
  } else if (key === 'brick') {
    c.R(H.x - 4.6, H.y - 4, 9.2, 1.8, '#D0312D'); c.R(H.x - 4.6, H.y - 3.4, 9.2, 0.5, '#ffffff');                  // sweatband
    c.p1(H.x + 1, H.y - 4.6, '#ffffff');                                                                           // shine
    c.R(-2.5, -16, 5, 4, K.face);                                                                                  // tank-top neckline
    c.L(1.5, -14, 2.4, -10, '#e8e8f0', 0.6); c.B(2, -10.5, 2.6, 2, '#C8C8D0');                                     // whistle
    c.R(H.x + 0.6, H.y + 3.6, 3, 0.9, '#ffffff');                                                                  // teeth
  } else if (key === 'sallow') {
    c.R(-1, -16, 2, 6, '#E8E4F0'); ACC.tie(c, a);
    const top = H.y - 5; c.R(H.x - 6, top + 0.4, 12, 1.4, '#14101C'); c.O(H.x, top - 1, 4.2, 3.2, '#1f1a28'); c.R(H.x - 4, top - 0.2, 8, 0.8, '#5a1a28');   // bowler
    ACC.book(c, a, K);
  } else if (key === 'jasper') {
    c.R(-5, -16, 3, 8, '#5a6a80'); c.R(2, -16, 3, 8, '#5a6a80'); c.R(-0.5, -16, 1, 8, '#C8CCD4');                  // gilet + zip
    c.R(-1.6, -16, 3.2, 1.4, '#C8CCD4');
    c.O(hand.x + 1.2, hand.y - 2.6, 2.8, 2.2, '#8C8C8C'); c.p1(hand.x + 0.2, hand.y - 3.8, '#c8c8c8'); c.p1(hand.x + 2.4, hand.y - 1.6, '#5e5e5e');   // the product
  } else if (key === 'duke') {
    const hx = H.x, hy = H.y;
    c.R(hx - 5.5, hy - 6.4, 11, 1.6, '#1A1023'); c.B(hx - 6.6, hy - 2.6, 2.8, 4.6, '#2a2438'); c.B(hx + 4.2, hy - 2.6, 2.8, 4.6, '#2a2438');   // headphones
    c.R(hx - 6, hy - 2, 1.2, 3, RED);
    c.R(-2, -14, 4, 2.2, '#D0312D'); c.R(-1.4, -13.4, 2.8, 0.6, '#ffffff');                                         // show logo
    ACC.mic(c, a);
  } else if (key === 'vivienne') {
    c.G([[-1.8, -16], [0, -12], [1.8, -16]], '#FFF3D0');
    const x = hand.x + 1; c.R(x, -22, 1.2, 16, '#8B5A2B'); c.R(x - 1, -22, 9, 1, '#8B5A2B');                          // sign post
    c.B(x + 1, -21, 8, 6, '#FFFFFF'); c.R(x + 1.6, -19.2, 6.8, 1.6, RED); c.R(x + 2, -16.6, 5, 0.7, '#8a8498');      // SOLD
    c.O(H.x - 4.2, H.y + 1.4, 1, 1, GOLD, true);
  } else if (key === 'consultant') {
    c.R(-1, -16, 2, 6, '#F4F1E8'); ACC.tie(c, a);
    c.under(() => { c.B(-9.5, -15, 3, 10, '#9AA0AC'); c.R(-9.5, -15, 0.8, 10, '#C8CCD4'); });                      // laptop under arm
    c.R(-2.8, -13.6, 1.6, 0.6, '#8FD3FF');                                                                         // pocket square
    ACC.glasses(c);
  } else if (key === 'ambrose') {
    c.R(-5, -9, 10, 1.2, '#E6B93C');                                                                               // rope belt, gilded
    c.L(-2, -16, 0, -12, GOLD, 0.6); c.L(2, -16, 0, -12, GOLD, 0.6); c.O(0, -10.6, 2, 2, GOLD); c.R(-0.4, -11.8, 0.8, 2.4, '#8a6a10');   // medallion
    c.R(H.x - 2.6, H.y - 5.4, 5.2, 1.6, K.face); c.p1(H.x - 0.6, H.y - 5, '#ffe8d0');                              // tonsure
    ACC.coins(c, a); ACC.halo(c, a);
  } else if (key === 'warranty') {
    ACC.tie(c, a);
    const hx = H.x, hy = H.y;
    c.R(hx - 5.4, hy - 5.6, 10.8, 1.2, '#2a2438'); c.B(hx - 6, hy - 2, 2.4, 3.6, '#2a2438');                         // headset
    c.L(hx - 5, hy + 1.6, hx + 2, hy + 3.6, '#2a2438', 0.6); c.O(hx + 2.6, hy + 3.6, 0.9, 0.9, '#3a3548', true);
    ACC.phone(c, a);
  } else if (key === 'grail') {
    c.R(-5.5, -16, 2.4, 13, '#FFFFFF'); c.R(3.1, -16, 2.4, 13, '#EEEEF4'); c.R(-5.5, -4, 11, 1, '#D8D8E0');           // lab coat tails
    c.R(-3, -16, 6, 7, '#7FB238'); c.G([[-1.8, -16], [0, -13], [1.8, -16]], '#FFFFFF');                             // green shirt
    const x = hand.x; c.B(x - 3.4, -14, 7, 8, '#FFFFFF'); c.R(x - 3.4, -14, 7, 1.6, '#3FD46B'); c.R(x - 2.4, -11, 5, 2.6, '#FF7A1A'); c.p1(x - 1.6, -10.4, '#ffffff');   // the tub
  } else if (key === 'dunleavy') {
    const top = H.y - 5; c.R(H.x - 5, top - 0.8, 10, 2.6, '#1f2f5a'); c.R(H.x - 5, top + 1.2, 11.5, 1, '#14101C'); c.R(H.x - 4, top - 2.6, 8, 2, '#2B4A8A'); c.P(H.x - 0.4, top - 1.6, GOLD);   // peaked cap
    c.R(2, -14.5, 1.6, 1.6, GOLD); c.R(-4, -14.5, 2.6, 0.6, '#E8E4F0');                                            // badge, pocket pen
    const x = hand.x; c.B(x - 2.5, -12.5, 5, 6.5, '#FFF3D0'); c.R(x - 2.5, -12.5, 5, 1.2, '#FFD23F'); c.R(x - 1.6, -10, 3.4, 0.6, '#8a8498');   // ticket book
  } else if (key === 'ombudsman') {
    c.R(-5, -16, 1.2, 9, '#5a5630'); c.R(3.8, -16, 1.2, 9, '#5a5630');
    const x = hand.x; c.B(x - 4, -11.5, 9, 6.5, '#9C6B3A'); c.R(x - 4, -11.5, 9, 1.4, '#B58652'); c.R(x - 1.2, -9, 3, 1, '#C8C8D0');   // the drawer
    c.R(x - 3, -13, 2.4, 2, '#FFF3D0'); c.R(x + 0.6, -13.4, 2.4, 2.4, '#F2E8C0');                                   // complaints
    ACC.glasses(c);
  } else if (key === 'careunit') {
    const hx = H.x, hy = H.y;
    c.B(hx - 6, hy - 6, 12.5, 11.5, '#C8D0DA'); c.R(hx - 4.6, hy - 4.4, 9.6, 7.6, '#1A1023');                      // monitor head
    c.R(hx - 2.6, hy - 2.2, 1.6, 1.6, '#5DECF5'); c.R(hx + 1.8, hy - 2.2, 1.6, 1.6, '#5DECF5'); c.R(hx - 2, hy + 1, 4.8, 0.8, '#5DECF5');   // :|
    c.R(hx, hy - 9, 1, 3, '#9AA0AC'); c.O(hx + 0.5, hy - 9.6, 1.2, 1.2, '#FF5D6C', true);                            // antenna
    c.R(-3, -14.6, 6, 3.4, '#6E7A8A'); c.R(-2.2, -13.8, 1.2, 1.2, '#7dff8a'); c.R(-0.4, -13.8, 1.2, 1.2, '#FFD23F'); c.R(1.4, -13.8, 1.2, 1.2, '#FF5D6C');   // status lights
    c.R(hand.x - 0.6, -9, 2.4, 2.4, '#9AA0AC');                                                                     // grabber
  } else if (key === 'folk-merchant') {
    c.under(() => { c.B(-12, -19, 8, 12, '#8B5A2B'); for (const [x, col] of [[-11, '#FF6A80'], [-8.6, '#5ECBFF'], [-6.4, '#7dff8a']]) { c.R(x, -22, 1.8, 3.4, col); c.R(x + 0.4, -23, 1, 1, '#c9a06a'); } });   // pack of bottles
    c.R(-5, -10, 10, 1.2, '#c9a06a'); ACC.bottle(c, a, K);
  } else if (key === 'folk-gossip') {
    c.G([[-6, -16], [6, -16], [4, -10], [-5, -10]], '#C86AA8'); c.R(-6, -16, 12, 1, '#E8A0C8');                      // shawl
    const x = hand.x; c.B(x - 2, -10, 4, 3.4, '#FFFFFF'); c.R(x + 2, -9.4, 1.2, 1.6, '#FFFFFF'); c.R(x - 1.6, -10, 3.2, 0.8, '#8a5a30');   // teacup
  } else if (key === 'folk-pilgrim') {
    const top = H.y - 5; c.R(H.x - 7, top + 0.6, 14, 1.4, '#8B6F45'); c.O(H.x, top - 0.6, 4, 2.4, '#A88A5A');           // wide hat
    c.O(-0.5, -14, 1.2, 1.2, '#FFF3D0', true); c.R(-5, -9, 10, 1, '#6a5030');
    ACC.staff(c, a);
  } else if (key === 'folk-tourist') {
    for (const [x, y] of [[-3, -14], [1, -12], [-1, -10], [3, -15], [-4, -11]]) c.R(x, y, 1.4, 1.4, '#FFD23F');        // loud shirt
    const top = H.y - 5; c.R(H.x - 7, top + 0.8, 14, 1.4, '#F2E8C0'); c.O(H.x, top, 4.4, 2.2, '#F2E8C0'); c.R(H.x - 4, top + 0.2, 8, 0.8, '#3FB8C8');   // sun hat
    c.L(-2, -16, 1, -11, '#2a2438', 0.6); c.B(-0.5, -12, 4, 3, '#2a2438'); c.O(1.5, -10.5, 1, 1, '#8FD3FF', true);    // camera
    const x = hand.x; c.B(x - 2, -13, 6, 5, '#F2E8C0'); c.R(x - 1, -11.6, 4, 0.6, '#3E8E2E'); c.R(x, -10.4, 0.6, 2, '#3A5FCD');   // map, upside down
  } else if (key === 'folk-mlm') {
    c.R(-1.4, -15, 2.8, 1.6, '#FFFFFF');
    const x = hand.x + 1; c.B(x - 4, -16, 8, 9, '#FFFFFF');                                                         // the chart
    c.G([[x - 3, -8.5], [x + 3, -8.5], [x, -14.5]], '#E6B93C'); c.R(x - 0.4, -14.5, 0.8, 1, '#FF5D6C');                // a pyramid, labelled "opportunity"
  } else if (key === 'folk-surveyor') {
    c.R(-5, -16, 2.6, 8.5, '#FF7A1A'); c.R(2.4, -16, 2.6, 8.5, '#FF7A1A'); c.R(-5, -12, 10, 1, '#F2F2F2');              // hi-vis
    const top = H.y - 5; c.O(H.x, top + 1.4, 5.4, 3.6, '#FFD23F'); c.R(H.x - 6, top + 1.4, 12, 1.2, '#E0B820');         // hard hat
    const x = hand.x + 2; c.L(x, -6, x - 2, 0, '#8B5A2B', 0.7); c.L(x, -6, x + 2, 0, '#8B5A2B', 0.7); c.L(x, -6, x, 0, '#8B5A2B', 0.7);
    c.B(x - 1.6, -9, 3.6, 3, '#E6B93C'); c.R(x + 2, -8.4, 1.6, 1.4, '#3a3548');                                     // theodolite
  } else if (key === 'folk-hermit') {
    c.R(-5, -9, 10, 1, '#5a5040'); c.R(-3, -6, 2, 2, '#5a5448'); c.R(2, -12, 2, 2, '#5a5448');                        // patches
    ACC.staff(c, a);
  } else if (key === 'folk-flat') {
    c.B(-7, -16, 14, 12, '#FFF3D0'); c.R(-6, -14, 12, 1.4, '#1A1023'); c.R(-5.5, -11, 11, 1.6, '#3A5FCD');           // sandwich board
    c.R(-5, -8, 10, 0.7, '#8a8498'); c.R(-7.5, -16, 1, 1.6, '#8B5A2B'); c.R(6.5, -16, 1, 1.6, '#8B5A2B');
  } else if (key === 'folk-influencer') {
    c.R(H.x - 3.4, H.y - 1.6, 9, 2.2, '#2a1a28'); c.R(H.x - 2.6, H.y - 1.2, 1.4, 0.8, '#C86AA8');                    // shades
    c.under(() => { c.B(-10, -15, 3.6, 11, '#7FE0B8'); c.R(-10, -15, 3.6, 1.2, '#B0F0D8'); });                        // rolled yoga mat
    ACC.phone(c, a);
  } else if (key === 'folk-ghost') {
    c.R(-6, -4, 2, 3, '#C8D8F0'); c.R(-2, -3, 2, 2, '#C8D8F0'); c.R(3, -4, 2, 3, '#C8D8F0');                          // wispy hem
    c.R(-4, -15, 8, 1, '#A8B8D8');
    const x = hand.x; c.R(x - 0.6, -18, 1.6, 12, '#B8C8E0'); c.R(x - 2.5, -7.5, 5.5, 1.2, '#A8B8D8');                 // the sword they died holding
  } else if (key === 'folk-busker') {
    c.G([[-6, -10], [-2, -14], [2, -11], [-2, -6]], '#8B5A2B'); c.O(-3, -9.4, 1.2, 1.2, '#3a2418', true);               // guitar body
    c.L(-1, -12, 5, -17, '#5a3a1a', 0.8); c.R(4.6, -18, 1.6, 1.6, '#3a2418');                                       // neck
    c.R(6, -1.6, 5, 1.2, '#3a3548'); c.R(7, -2.6, 3, 1, '#3a3548'); c.P(8, -1.4, GOLD);                               // hat on the ground, one coin
  } else if (key === 'folk-coach') {
    c.R(-5, -16, 0.8, 9, '#FFFFFF'); c.R(4.2, -16, 0.8, 9, '#FFFFFF'); c.R(-3.6, -8, 0.8, 8, '#FFFFFF'); c.R(3, -8, 0.8, 8, '#FFFFFF');   // tracksuit stripes
    const top = H.y - 5; c.R(H.x - 4.6, top - 0.4, 9.2, 2.6, '#FFFFFF'); c.R(H.x + 2, top + 1.4, 5, 1, '#C8C8D0');    // cap
    c.L(1.5, -15, 2, -11, '#e8e8f0', 0.6); c.B(1.4, -11.4, 2.4, 1.8, '#FFD23F');                                    // whistle
    ACC.clipboard(c, a);
  } else if (key === 'folk-courier') {
    const top = H.y - 5; c.O(H.x, top + 1.6, 5.2, 3.4, '#2a2438'); c.R(H.x - 3, top, 6, 0.8, '#FF7A1A');               // helmet
    c.L(-5, -16, 4, -8, '#1A1023', 1); c.B(-8, -9, 7, 5, '#3a3548'); c.R(-8, -9, 7, 1.2, '#FF7A1A');                  // messenger bag
    const x = hand.x; c.B(x - 2.5, -12, 5.5, 5, '#B5833C'); c.R(x - 2.5, -10, 5.5, 0.8, '#E8E0C8');                   // parcel
  } else if (key === 'folk-assessor') {
    c.G([[H.x - 4.6, H.y - 3], [H.x + 4.8, H.y - 3], [H.x + 8.5, H.y - 1.6], [H.x + 4.8, H.y - 0.4]], '#3FD46B');     // green visor
    c.R(-1, -16, 2, 6, '#E8E4F0'); ACC.tie(c, a);
    ACC.book(c, a, K);
    c.O(-7, -10, 1.8, 1.8, '#B8E0FF', true); c.R(-8.4, -8.6, 0.9, 3, '#6a4018');                                    // magnifying glass
  } else {
    c.R(-4, -16, 8, 1, '#ffffff');
  }
  c.redrawEyes && !['clerk', 'careunit', 'chad', 'folk-influencer'].includes(key) && c.redrawEyes();
}
