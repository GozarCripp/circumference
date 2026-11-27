// art/hero.js — the hero paper doll and every item icon (ARCHITECTURE §3.3, §7.1, §8.A9). OWNER: Foreman A / hero art.
//
// HERO: every layer lives in BOX.hero (32 x 40, anchor 16,36 = feet), faces RIGHT and is drawn from ONE shared body
// template (the T constants below), so any combination of layers composites cleanly. assets.heroSprite() stacks
// base, legs, body, arms, head, wep and outlines the composite; layers here are never outlined individually
// (except nothing: 'base' and 'swim' also read fine when the caller outlines them on their own).
//
//   base                the naked hero, pale, messy-haired, bewildered, with a tasteful censor bar
//   swim                head, shoulders and flailing arms above a blue ripple (replaces every layer)
//   legs|body|arms|head-<material>   36 armour overlays: a different SHAPE per slot, COLOUR from the material,
//                       and exactly one TELL per material (see tell tables)
//   wep-<weapon>        25 weapons held in the front hand (hand = T.hand); 'wep-fists' is null (unarmed)
//
// ITEMS: BOX.item (16 x 16, anchor 8,13), outlined, 64 icons: 25 weapons (same silhouettes as in hand, laid on the
// diagonal), 36 armour pieces (a helm / cuirass / gauntlet / greaves tinted by material, tell reduced to 1-2 px),
// potion, gold and scroll. Unknown names give a small question-mark box. Nothing here throws, nothing here calls
// Math.random (rng(name) only), and there are no top-level side effects.
import { canvas, makeSprite, outline, rect, px, shade, toRGB, toHex, grid } from './pixel.js';
import { BOX } from '../../assets/manifest.js';
import { slug } from '../core/util.js';

/** Draw order of hero layers, back to front. assets.heroSprite() composites them. */
export const HERO_LAYERS = ['base', 'legs', 'body', 'arms', 'head', 'wep'];

// ---- data mirrored from game/loot.js (kept in sync by hand so art never imports gameplay) ---------------------------
/** Armour materials in loot.js order: [name, colour]. Obsidian/Diamond/Space-Age get richer art colours below. */
const MATS = [['Leather', '#a86'], ['Iron', '#bbb'], ['Bone', '#eed'], ['Dog', '#c96'], ['Bureaucrat', '#99a'],
  ['Ghost', '#cdf'], ['Obsidian', '#a6f'], ['Diamond', '#6ff'], ['Space-Age', '#fff']];
const SLOT_IDS = ['head', 'body', 'arms', 'legs'];
const WEAPON_NAMES = ['Dagger', 'Straight Sword', 'Greatsword', 'Ultra Greatsword', 'Curved Sword', 'Katana', 'Curved Greatsword',
  'Thrusting Sword', 'Axe', 'Greataxe', 'Hammer', 'Great Hammer', 'Pickaxe', 'Spear', 'Halberd', 'Scythe', 'Whip', 'Fist Weapons',
  'Claws', 'Twinblade', 'Bow', 'Greatbow', 'Crossbow', 'Sorcery Staff', 'Pyromancy Flame'];
const MAT_SLUGS = MATS.map(m => slug(m[0]));
const WEP_SLUGS = WEAPON_NAMES.map(slug);
/** Base colour each material is painted in (3-digit hex expanded; the dark/rich materials keep their own body colour). */
const MAT_BODY = { leather: '#aa8866', iron: '#bbbbbb', bone: '#eeeedd', dog: '#cc9966', bureaucrat: '#9999aa', ghost: '#ccddff',
  obsidian: '#2b1b4a', diamond: '#5decf5', 'space-age': '#e6edf5' };

// ---- the shared body template (hero layers, 32 x 40, feet at y 36) ---------------------------------------------------
const T = {
  head: { x0: 12, x1: 19, y0: 6, y1: 13 },        // 8 x 8
  torso: { x0: 11, x1: 20, y0: 14, y1: 23 },      // 10 x 10
  bar: { x0: 11, x1: 20, y0: 24, y1: 26 },        // the censor bar (hips)
  hips: { x0: 12, x1: 19, y0: 25, y1: 28 },
  legB: { x0: 12, x1: 14 }, legF: { x0: 17, x1: 19 }, legY0: 29, footY: 35,
  armF: { x0: 21, x1: 22, y0: 15, y1: 23 },       // front (right) arm, nearest the viewer
  armB: { x0: 9, x1: 10, y0: 15, y1: 23 },        // back arm
  hand: { x: 22, y: 21 },                          // weapon hand
};
const INK = '#1a1023';
const SKIN = '#e8b890', HAIR = '#6b4423';
const GOLD = '#e6b93c', RED = '#d0312d', LAVA = '#ff6a00', GLOW = '#3fa9ff';

const put = (g, x, y, col, W = 32, H = 40) => { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < W && y < H) px(g, x, y, col); };

/** Tone set from one base colour: dd < d < b < l < ll. */
function tone(hex) { const b = toHex(toRGB(hex)); return { b, d: shade(b, -1), dd: shade(b, -2), l: shade(b, 1), ll: shade(b, 2) }; }

/** Fill row spans [[y, x0, x1], ...] with shaded tones (light left/top, dark right/bottom). */
function spans(g, list, m, W = 32, H = 40) {
  let y0 = 1e9, y1 = -1e9;
  for (const [y] of list) { if (y < y0) y0 = y; if (y > y1) y1 = y; }
  for (const [y, a, b] of list) for (let x = a; x <= b; x++) {
    let c = m.b;
    if (x === a) c = m.l; else if (x === b) c = m.d;
    if (y === y0) c = m.l; else if (y === y1) c = x === b ? m.dd : m.d;
    put(g, x, y, c, W, H);
  }
}
const rows = (y0, y1, a, b) => { const o = []; for (let y = y0; y <= y1; y++) o.push([y, a, b]); return o; };
const pts = (g, list, col) => { for (const [x, y] of list) put(g, x, y, col); };

// ============================================================================================================================
//   BASE and SWIM
// ============================================================================================================================
function drawBase(g) {
  const s = [shade(SKIN, -2), shade(SKIN, -1), SKIN, shade(SKIN, 1), shade(SKIN, 2)];
  const hr = [shade(HAIR, -2), shade(HAIR, -1), HAIR, shade(HAIR, 1)];
  // back arm and back leg sit in shadow
  rect(g, T.armB.x0, T.armB.y0, 2, 9, s[1]); rect(g, T.armB.x0, 22, 2, 2, s[0]);
  rect(g, T.hips.x0, T.hips.y0, 8, 4, s[2]); rect(g, T.hips.x0, T.hips.y0, 4, 4, s[1]);
  rect(g, T.legB.x0, T.legY0, 3, 7, s[1]); rect(g, T.legF.x0, T.legY0, 3, 7, s[2]);
  rect(g, T.legF.x0, T.legY0, 1, 7, s[3]); put(g, 15, 35, s[1]); put(g, 20, 35, s[2]); put(g, 12, 34, s[0]); put(g, 12, 35, s[0]);
  // torso
  rect(g, T.torso.x0, T.torso.y0, 10, 10, s[2]);
  rect(g, 11, 15, 1, 8, s[3]); rect(g, 20, 15, 1, 9, s[1]); rect(g, 14, 14, 3, 1, s[1]);
  put(g, 11, 14, 0); g.clearRect(11, 14, 1, 1); g.clearRect(20, 14, 1, 1);
  px(g, 13, 17, s[3]); px(g, 17, 17, s[3]); px(g, 15, 21, s[1]);       // pec glints and a belly button
  // head
  rect(g, T.head.x0, T.head.y0, 8, 8, s[2]);
  rect(g, 12, 7, 1, 6, s[3]); rect(g, 12, 13, 8, 1, s[1]); rect(g, 19, 9, 1, 4, s[1]);
  pts(g, [[20, 10], [20, 11]], s[2]); put(g, 20, 11, s[1]); put(g, 20, 10, s[3]);      // nose
  pts(g, [[13, 10], [13, 11]], s[1]);                                                    // ear
  // hair: a mess
  rect(g, 12, 5, 8, 4, hr[2]); rect(g, 12, 9, 2, 3, hr[1]); rect(g, 13, 4, 6, 1, hr[2]);
  pts(g, [[13, 3], [15, 2], [16, 3], [18, 3], [19, 4], [11, 5], [11, 7], [20, 6], [10, 8]], hr[2]);
  pts(g, [[14, 3], [17, 3], [15, 4], [12, 6], [16, 5]], hr[3]);
  pts(g, [[13, 8], [12, 8], [13, 7]], hr[1]);
  pts(g, [[14, 8], [16, 8], [18, 8], [19, 8]], hr[2]);                                  // fringe in the eyes
  // wide bewildered eyes and a tiny open mouth
  rect(g, 14, 9, 2, 3, '#fff'); rect(g, 17, 9, 2, 3, '#fff');
  px(g, 15, 10, INK); px(g, 18, 10, INK); px(g, 15, 11, '#8aa'); px(g, 18, 11, '#8aa');
  px(g, 14, 12, s[1]); px(g, 17, 12, s[1]);
  rect(g, 18, 12, 2, 2, '#5a1d2a'); px(g, 18, 12, '#2b0d16');
  // front arm and the hand that will hold things
  rect(g, T.armF.x0, T.armF.y0, 2, 7, s[2]); rect(g, 21, 15, 1, 7, s[3]); rect(g, 22, 15, 1, 7, s[1]);
  rect(g, 21, 21, 2, 3, s[3]); px(g, 22, 23, s[1]);
  // the censor bar (he is Naked & Uninsured)
  rect(g, T.bar.x0, T.bar.y0, 10, 3, INK); rect(g, 13, 24, 2, 1, '#6a5780'); px(g, 18, 24, '#6a5780'); px(g, 12, 25, '#3a2a4e');
}

function drawSwim(g) {
  const s = [shade(SKIN, -2), shade(SKIN, -1), SKIN, shade(SKIN, 1)];
  const hair = '#3a2a22', hairL = '#5a463a';
  const dy = 8;                                              // the head is lowered into the water
  // arms flailing above the surface
  rect(g, 8, 17, 2, 7, s[1]); rect(g, 7, 16, 2, 2, s[1]); px(g, 7, 15, s[1]); px(g, 9, 15, s[1]);
  rect(g, 22, 15, 2, 9, s[2]); rect(g, 22, 15, 1, 8, s[3]); rect(g, 22, 13, 3, 2, s[2]); px(g, 21, 13, s[3]); px(g, 24, 12, s[2]); px(g, 23, 12, s[2]);
  // shoulders
  rect(g, 10, 22, 12, 5, s[2]); rect(g, 10, 22, 2, 5, s[3]); rect(g, 20, 22, 2, 5, s[1]);
  // head
  rect(g, T.head.x0, T.head.y0 + dy, 8, 8, s[2]); rect(g, 12, 15, 1, 6, s[3]); rect(g, 19, 17, 1, 4, s[1]); rect(g, 12, 21, 8, 1, s[1]);
  pts(g, [[20, 18], [20, 19]], s[2]); px(g, 20, 19, s[1]);
  // wet, plastered hair
  rect(g, 12, 13, 8, 4, hair); rect(g, 11, 14, 1, 6, hair); rect(g, 12, 17, 2, 4, hair); rect(g, 13, 12, 6, 1, hair);
  rect(g, 13, 13, 5, 1, hairL); pts(g, [[14, 17], [16, 17], [19, 16]], hair); px(g, 11, 20, hair); px(g, 12, 21, hair);
  px(g, 17, 21, '#7fb8ff');                                                           // a drip
  // eyes: wide and worried, brows slanting up in the middle
  rect(g, 14, 17, 2, 3, '#fff'); rect(g, 17, 17, 2, 3, '#fff'); px(g, 15, 18, INK); px(g, 18, 18, INK);
  pts(g, [[13, 16], [14, 16], [15, 15]], hair); pts(g, [[17, 15], [18, 16], [19, 16]], hair);
  pts(g, [[17, 21], [18, 20], [19, 21]], '#5a1d2a');                                  // wobbly mouth
  // the ripple
  const cx = 16, cy = 28;
  const ell = (rx, ry, col, fill) => {
    for (let y = -ry; y <= ry; y++) {
      const w = Math.round(rx * Math.sqrt(Math.max(0, 1 - (y * y) / (ry * ry + 0.4))));
      if (fill) rect(g, cx - w, cy + y, w * 2, 1, col); else { px(g, cx - w, cy + y, col); px(g, cx + w - 1, cy + y, col); }
    }
  };
  ell(15, 4, '#2c5cc0', true); ell(13, 3, '#3f76e4', true); ell(10, 2, '#4b86f0', true);
  ell(15, 4, '#a5d8ff', false);
  rect(g, 4, 31, 3, 1, '#a5d8ff'); rect(g, 24, 31, 3, 1, '#a5d8ff'); rect(g, 8, 29, 2, 1, '#a5d8ff'); rect(g, 22, 28, 2, 1, '#a5d8ff');
  rect(g, 13, 30, 3, 1, '#a5d8ff'); rect(g, 5, 27, 2, 1, '#a5d8ff'); rect(g, 26, 27, 1, 1, '#fff'); rect(g, 7, 30, 1, 1, '#fff');
  rect(g, 11, 26, 2, 1, '#a5d8ff'); rect(g, 19, 26, 3, 1, '#a5d8ff');
}

// ============================================================================================================================
//   ARMOUR OVERLAYS
// ============================================================================================================================
const HELM = [[3, 13, 18], [4, 12, 19], [5, 11, 20], [6, 11, 20], [7, 11, 20], [8, 11, 21], [9, 11, 13], [10, 11, 13], [11, 11, 12], [12, 11, 12]];
const BODY = [[14, 11, 13], [14, 18, 20], ...rows(15, 23, 11, 20), ...rows(24, 26, 10, 21)];
const FARM = (hand = true) => [[14, 21, 22], [15, 20, 23], [16, 20, 23], ...rows(17, 19, 21, 22), [20, 20, 23], ...(hand ? [[21, 21, 23], [22, 21, 23], [23, 21, 22]] : [])];
const BARM = (hand = true) => [[14, 9, 10], [15, 8, 10], [16, 8, 10], ...rows(17, 19, 9, 10), [20, 8, 10], ...(hand ? rows(21, 23, 9, 10) : [])];
const LEGS_TOP = [...rows(24, 25, 11, 20), ...rows(26, 28, 11, 20)];

function overlayHead(g, mat, m) {
  switch (mat) {
    case 'bureaucrat': {                                              // a flat grey fedora-ish cap
      spans(g, [[2, 13, 18], ...rows(3, 6, 12, 19)], m); spans(g, [[7, 9, 22], [8, 10, 21]], { ...m, b: m.d, l: m.b, d: m.dd }); rect(g, 12, 6, 8, 1, m.dd);
      px(g, 19, 5, '#f4f4f8'); px(g, 19, 6, '#c9c9d8'); rect(g, 13, 3, 3, 1, m.ll); return;
    }
    case 'dog': {                                                     // brown helm with floppy ears
      spans(g, HELM, m);
      const ear = tone('#7a4a2a');
      spans(g, [[7, 10, 13], ...rows(8, 11, 9, 12), [12, 10, 12], [13, 10, 11], [14, 10, 10]], ear);          // near ear flops over the cheek
      spans(g, [[3, 8, 10], [4, 7, 10], [5, 7, 9], [6, 7, 9], [7, 7, 8]], { ...ear, b: ear.d, l: ear.b });    // far ear
      px(g, 14, 4, m.ll); px(g, 15, 4, m.ll); pts(g, [[17, 6], [18, 6]], m.dd); return;
    }
    case 'ghost': {                                                   // a hood with hollow slits where the eyes are
      g.globalAlpha = 0.62; spans(g, [[1, 15, 16], [2, 14, 17], ...HELM], m); g.globalAlpha = 1;
      rect(g, 14, 9, 2, 2, INK); rect(g, 17, 9, 2, 2, INK); px(g, 15, 9, '#5a6a8a'); px(g, 18, 9, '#5a6a8a'); return;
    }
    case 'space-age': {
      spans(g, HELM.slice(0, 5).concat([[8, 11, 21], [9, 11, 13], [10, 11, 12], [11, 11, 12]]), m);
      g.globalAlpha = 0.6; rect(g, 14, 8, 7, 4, '#4fa0ff'); g.globalAlpha = 1;                                 // mirrored visor over the eyes
      rect(g, 14, 8, 7, 1, '#bfe3ff'); px(g, 15, 10, '#fff'); px(g, 16, 9, '#dff0ff'); px(g, 19, 10, '#bfe3ff'); rect(g, 14, 12, 7, 1, '#2a6ed0');
      px(g, 16, 1, GLOW); px(g, 16, 2, m.d); px(g, 13, 4, '#fff'); px(g, 14, 4, '#fff'); return;
    }
    default: spans(g, HELM, m);
  }
  if (mat === 'leather') { for (let x = 13; x <= 18; x += 2) px(g, x, 6, m.dd); pts(g, [[12, 8], [14, 8], [16, 8], [18, 8]], m.dd); rect(g, 19, 6, 2, 3, GOLD); px(g, 20, 7, '#8a6a1c'); px(g, 19, 6, '#fff3a0'); }
  else if (mat === 'iron') { rect(g, 13, 4, 6, 1, m.ll); rect(g, 11, 8, 11, 1, m.dd); pts(g, [[12, 6], [19, 6], [16, 6]], '#fff'); pts(g, [[12, 7], [19, 7], [16, 7]], m.dd); rect(g, 15, 3, 2, 1, m.ll); }
  else if (mat === 'bone') { for (const x of [13, 15, 17]) { rect(g, x, 4, 1, 4, m.dd); px(g, x + 1, 4, m.ll); } pts(g, [[12, 8], [14, 8], [16, 8], [18, 8], [20, 8]], m.dd); px(g, 12, 2, m.l); px(g, 12, 3, m.b); px(g, 19, 2, m.l); px(g, 19, 3, m.b); }
  else if (mat === 'obsidian') { pts(g, [[13, 6], [14, 5], [15, 4], [16, 6], [17, 5], [12, 8], [13, 7]], '#a66bff'); pts(g, [[15, 7], [16, 7], [17, 8]], LAVA); px(g, 15, 2, '#a66bff'); px(g, 16, 2, m.d); px(g, 16, 1, '#a66bff'); }
  else if (mat === 'diamond') { rect(g, 13, 4, 3, 2, m.ll); rect(g, 17, 5, 3, 2, m.d); pts(g, [[14, 3], [13, 4], [14, 4], [15, 4], [14, 5]], '#fff'); px(g, 14, 4, '#e6ffff'); pts(g, [[19, 6], [19, 5], [18, 6], [20, 6], [19, 7]], '#fff'); }
}

function overlayBody(g, mat, m) {
  if (mat === 'ghost') {
    g.globalAlpha = 0.62; spans(g, BODY.filter(r => r[0] < 26), m);
    for (let x = 10; x <= 21; x++) if (x % 2 === 0 || x % 3 === 0) px(g, x, 26, m.b);                                 // ragged hem
    g.globalAlpha = 1; return;
  }
  if (mat === 'bureaucrat') {                                           // grey suit, lapel V, red tie
    spans(g, BODY, m);
    rect(g, 14, 15, 4, 2, '#f1f1f7'); rect(g, 15, 17, 2, 2, '#f1f1f7');
    pts(g, [[13, 15], [13, 16], [14, 17], [14, 18], [15, 19], [18, 15], [18, 16], [17, 17], [17, 18], [16, 19]], m.dd);
    rect(g, 15, 16, 2, 1, RED); rect(g, 15, 17, 2, 5, RED); px(g, 16, 18, '#8e1c1a'); px(g, 16, 19, '#8e1c1a'); px(g, 16, 22, '#8e1c1a'); px(g, 15, 22, '#8e1c1a');
    pts(g, [[13, 22], [18, 22], [13, 24], [18, 24]], m.dd); rect(g, 11, 24, 10, 1, m.d); return;
  }
  spans(g, BODY, m);
  switch (mat) {
    case 'leather':
      for (let y = 15; y <= 21; y += 2) { px(g, 15, y, m.dd); px(g, 16, y + 1, m.dd); }
      rect(g, 11, 22, 10, 1, '#5a3d2a'); rect(g, 15, 22, 3, 2, GOLD); px(g, 16, 23, '#8a6a1c'); px(g, 15, 22, '#fff3a0'); pts(g, [[12, 18], [14, 20], [19, 17]], m.dd); break;
    case 'iron':
      rect(g, 11, 15, 10, 1, m.ll); rect(g, 11, 19, 10, 1, m.dd); rect(g, 11, 23, 10, 1, m.dd); rect(g, 10, 24, 12, 1, m.l);
      pts(g, [[12, 17], [19, 17], [12, 21], [19, 21], [15, 17], [16, 21]], '#fff'); pts(g, [[12, 18], [19, 18], [12, 22], [19, 22]], m.dd); rect(g, 15, 15, 2, 4, m.l); break;
    case 'bone':
      rect(g, 15, 15, 2, 9, m.d); rect(g, 15, 15, 1, 9, m.l);
      for (const y of [16, 18, 20, 22]) { rect(g, 12, y, 8, 1, m.ll); rect(g, 12, y + 1, 8, 1, m.dd); rect(g, 15, y, 2, 1, m.b); } break;
    case 'dog':
      rect(g, 12, 16, 2, 2, m.dd); rect(g, 18, 19, 3, 2, m.dd); px(g, 13, 20, m.d); px(g, 17, 16, m.d); rect(g, 11, 22, 10, 1, '#7a4a2a');
      pts(g, [[14, 21], [14, 23], [17, 21], [17, 23]], '#f6f1d8'); rect(g, 14, 22, 4, 1, '#f6f1d8'); rect(g, 15, 22, 2, 1, '#cfc7a2'); break;
    case 'obsidian':
      pts(g, [[12, 15], [13, 16], [13, 17], [14, 18], [15, 19], [19, 16], [18, 18], [18, 19], [17, 21], [12, 22]], '#a66bff'); pts(g, [[15, 20], [16, 20], [16, 21], [14, 19]], LAVA); px(g, 16, 20, '#ffc86a'); break;
    case 'diamond':
      rect(g, 12, 15, 3, 3, m.ll); rect(g, 17, 18, 3, 3, m.d); rect(g, 12, 20, 3, 2, m.d); pts(g, [[13, 17], [12, 17], [14, 17], [13, 16], [13, 18]], '#fff'); pts(g, [[18, 23], [18, 22], [17, 23], [19, 23]], '#fff'); break;
    case 'space-age':
      rect(g, 11, 14, 10, 1, '#fff'); rect(g, 14, 17, 5, 5, '#fff'); rect(g, 15, 18, 3, 3, '#9fd0ff'); rect(g, 15, 18, 3, 1, '#cfe8ff');
      pts(g, [[15, 20], [17, 20], [16, 19]], GLOW); rect(g, 11, 24, 10, 1, '#7fb8f0'); px(g, 12, 21, GLOW); px(g, 19, 21, GLOW); break;
    default:
  }
}

function overlayArms(g, mat, m) {
  const mb = tone(shade(m.b, -1));
  const hand = mat !== 'bureaucrat';
  if (mat === 'ghost') {
    g.globalAlpha = 0.6; spans(g, BARM(false).concat([[21, 9, 10]]), mb); spans(g, FARM(false), m);
    g.globalAlpha = 1; rect(g, 21, 20, 3, 1, '#fff'); pts(g, [[20, 21], [23, 21], [22, 22]], '#cfe3ff'); return;
  }
  spans(g, BARM(hand), mb); spans(g, FARM(hand), m);
  switch (mat) {
    case 'leather': for (const y of [16, 18]) { px(g, 22, y, m.dd); px(g, 9, y, mb.dd); } rect(g, 20, 20, 4, 1, '#5a3d2a'); px(g, 22, 20, GOLD); px(g, 21, 15, m.ll); break;
    case 'iron': rect(g, 20, 15, 4, 1, m.ll); rect(g, 21, 18, 2, 1, m.dd); rect(g, 20, 20, 4, 1, m.dd); pts(g, [[21, 16], [22, 16], [22, 22]], '#fff'); px(g, 9, 17, mb.ll); rect(g, 8, 20, 3, 1, mb.dd); break;
    case 'bone': rect(g, 20, 16, 4, 1, m.ll); rect(g, 21, 18, 2, 1, m.dd); rect(g, 21, 22, 2, 1, m.dd); px(g, 22, 13, m.l); px(g, 22, 14, m.b); px(g, 9, 13, mb.b); px(g, 9, 14, mb.b); px(g, 10, 18, mb.dd); break;
    case 'dog': pts(g, [[20, 21], [23, 21], [20, 22], [22, 24], [21, 24]], '#7a4a2a'); pts(g, [[8, 20], [10, 22]], '#7a4a2a'); px(g, 21, 16, m.ll); break;
    case 'bureaucrat': rect(g, 21, 19, 2, 2, '#f4f4f8'); rect(g, 9, 19, 2, 2, '#c4c4d2'); px(g, 22, 20, GOLD); rect(g, 20, 20, 1, 1, '#f4f4f8'); rect(g, 23, 20, 1, 1, '#f4f4f8'); break;
    case 'obsidian': pts(g, [[21, 16], [22, 17], [22, 18], [21, 19]], '#a66bff'); pts(g, [[21, 21], [22, 22]], LAVA); px(g, 9, 16, '#a66bff'); px(g, 9, 21, LAVA); break;
    case 'diamond': rect(g, 20, 15, 2, 2, m.ll); pts(g, [[22, 18], [21, 18], [23, 18], [22, 17], [22, 19]], '#fff'); px(g, 9, 17, '#fff'); rect(g, 21, 21, 2, 1, m.ll); break;
    case 'space-age': rect(g, 20, 20, 4, 1, GLOW); rect(g, 8, 20, 3, 1, '#2a6ed0'); rect(g, 21, 17, 2, 1, '#cfe8ff'); rect(g, 21, 21, 3, 2, '#fff'); px(g, 22, 22, '#bfe3ff'); break;
    default:
  }
}

function overlayLegs(g, mat, m) {
  const boot = { leather: '#5a3d2a', iron: '#6f6f7f', bone: '#cfc7a2', dog: '#7a4a2a', bureaucrat: '#2a2a35', ghost: '#9fb4d8', obsidian: '#150c2a', diamond: '#2fb3c0', 'space-age': '#c8d4e6' }[mat];
  const bt = tone(boot), mB = tone(shade(m.b, -1));
  const wavy = mat === 'ghost';
  if (wavy) {
    g.globalAlpha = 0.62; spans(g, [...LEGS_TOP, ...rows(29, 31, 11, 20)], m);
    for (let x = 11; x <= 20; x++) { px(g, x, 32, m.b); if (x % 2) px(g, x, 33, m.d); }
    g.globalAlpha = 1; pts(g, [[13, 32], [18, 32]], '#e8f2ff'); return;
  }
  spans(g, LEGS_TOP, m);
  spans(g, rows(29, 32, 12, 14), mB); spans(g, rows(29, 32, 17, 19), m);
  spans(g, [...rows(33, 35, 12, 15)], tone(shade(boot, -1))); spans(g, [...rows(33, 35, 17, 20)], bt);
  rect(g, 11, 24, 10, 1, m.d); px(g, 11, 24, m.l);
  switch (mat) {
    case 'leather': rect(g, 11, 24, 10, 1, '#5a3d2a'); rect(g, 15, 24, 2, 2, GOLD); px(g, 15, 24, '#fff3a0'); for (const y of [29, 31]) { px(g, 14, y, m.dd); px(g, 19, y, m.dd); } px(g, 12, 33, '#8a5c3a'); px(g, 17, 33, '#8a5c3a'); break;
    case 'iron': rect(g, 12, 29, 3, 2, m.ll); rect(g, 17, 29, 3, 2, m.ll); rect(g, 12, 31, 3, 1, m.dd); rect(g, 17, 31, 3, 1, m.dd); pts(g, [[13, 26], [18, 26], [13, 33], [18, 33]], '#fff'); rect(g, 11, 24, 10, 1, m.ll); break;
    case 'bone': for (const y of [30, 32]) { rect(g, 12, y, 3, 1, m.ll); rect(g, 17, y, 3, 1, m.ll); rect(g, 12, y + 1, 3, 1, m.dd); } pts(g, [[13, 29], [18, 29]], '#fff'); pts(g, [[13, 27], [18, 27]], m.dd); break;
    case 'dog': {
      const tail = tone('#b07a46');                                    // the tail curls up behind
      pts(g, [[10, 27], [9, 27], [8, 26], [8, 25], [7, 24], [7, 23], [8, 22], [9, 22], [10, 23]], tail.b); pts(g, [[10, 28], [9, 28], [9, 26], [8, 24], [7, 22]], tail.d); pts(g, [[7, 22], [8, 23]], tail.ll);
      pts(g, [[12, 24], [12, 26], [15, 24], [15, 26]], '#f6f1d8'); rect(g, 12, 25, 4, 1, '#f6f1d8'); px(g, 13, 25, '#cfc7a2'); break;
    }
    case 'bureaucrat': rect(g, 13, 29, 1, 4, m.ll); rect(g, 18, 29, 1, 4, m.ll); rect(g, 11, 24, 10, 1, '#2a2a35'); px(g, 15, 24, GOLD); pts(g, [[12, 32], [17, 32]], '#f1f1f7'); break;
    case 'obsidian': pts(g, [[12, 26], [13, 27], [12, 29], [13, 30], [18, 27], [19, 28], [18, 30]], '#a66bff'); pts(g, [[14, 28], [18, 31], [13, 31]], LAVA); break;
    case 'diamond': rect(g, 12, 26, 2, 2, m.ll); rect(g, 17, 29, 3, 2, m.ll); pts(g, [[13, 30], [12, 30], [14, 30], [13, 29], [13, 31]], '#fff'); px(g, 19, 26, '#fff'); break;
    case 'space-age': rect(g, 12, 33, 3, 1, GLOW); rect(g, 17, 33, 3, 1, GLOW); rect(g, 11, 24, 10, 1, '#7fb8f0'); pts(g, [[15, 26], [16, 26]], GLOW); px(g, 13, 29, '#fff'); px(g, 18, 29, '#fff'); break;
    default:
  }
}

function drawArmour(g, slot, mat) {
  const col = MAT_BODY[mat];
  const m = tone(col);
  if (mat === 'obsidian') { m.l = '#4a2f7c'; m.ll = '#6a45a8'; }
  if (mat === 'space-age') { m.d = '#bfcade'; m.dd = '#8fa0bc'; }
  ({ head: overlayHead, body: overlayBody, arms: overlayArms, legs: overlayLegs })[slot](g, mat, m);
}

// ============================================================================================================================
//   WEAPONS (one "pen" drives both the in-hand layer and the diagonal inventory icon)
// ============================================================================================================================
const STEEL = '#d8d8d8', STEEL_H = '#ffffff', STEEL_D = '#8e94a6', WOOD = '#9c7a4e', WOOD_H = '#b8935f', WOOD_D = '#6f5436';
const GRIP = '#6b4a3a', GRIP_D = '#4a3226', BRASS = '#c8a24a';

/** A drawing pen on an axis: origin (ox,oy), pointing up-forward by angle a (0 = straight up, + = leaning right), scale k.
 *  t runs along the shaft (+ toward the tip), s across it (+ to the right). Units are hero pixels (k = 1). */
function makePen(g, ox, oy, a, k, W, H, wk = 1) {   // wk: stroke-width scale (viewmodel draws at k = wk = 2: same shape, finer pixels)
  const sn = Math.sin(a), cs = Math.cos(a);
  const at = (t, s) => [ox + sn * t * k + cs * s * k, oy - cs * t * k + sn * s * k];
  const dot = (t, s, col) => { if (!col) return; const [x, y] = at(t, s); put(g, x, y, col, W, H); };
  const fill = (t0, t1, s0, s1, fn) => {
    const st = 0.34 / Math.max(k, 0.4);
    for (let t = t0; t <= t1 + 1e-6; t += st) for (let s = s0; s <= s1 + 1e-6; s += st) { const c = fn(t, s); if (c) dot(t, s, c); }
  };
  /** A strip of cross-section colours `cols` (light to dark, left to right), optionally bending forward by `bend` units. */
  const seg = (t0, t1, cols, bend = 0, off = 0) => {
    const nw = k >= 0.95 ? Math.round(cols.length * wk) : Math.max(1, Math.round(cols.length * Math.max(k, 0.5)));
    const pick = i => nw === cols.length ? cols[i] : nw === 1 ? cols[Math.floor(cols.length / 2)] : cols[Math.round(i * (cols.length - 1) / (nw - 1))];
    const st = 0.3 / Math.max(k, 0.4), len = Math.max(1e-6, t1 - t0);
    for (let t = t0; t <= t1 + 1e-6; t += st) {
      const f = (t - t0) / len, sb = bend * f * f;
      for (let i = 0; i < nw; i++) for (const d of [-0.42, -0.14, 0.14, 0.42]) {
        const sPx = (i - (nw - 1) / 2) + d;
        dot(t, sPx / k + sb + off, pick(i));
      }
    }
  };
  const bar = (t, w, col, th = 1) => fill(t, t + th - 0.4, -w / 2, w / 2, () => col);
  return { dot, fill, seg, bar, at, k };
}
const bl = w => w <= 1 ? [STEEL] : w === 2 ? [STEEL_H, STEEL_D] : w === 3 ? [STEEL_H, STEEL, STEEL_D] : [STEEL_H, ...Array(w - 2).fill(STEEL), STEEL_D];
const haft = (w = 2) => w === 1 ? [WOOD] : w === 2 ? [WOOD_H, WOOD_D] : [WOOD_H, WOOD, WOOD_D];
const grip = (p, t0, t1) => { p.seg(t0, t1, [GRIP, GRIP_D]); };
const pommel = (p, t) => { p.dot(t, 0, BRASS); p.dot(t, 0.6, '#8a6a1c'); };
/** Blade with a pointed tip: body to tEnd, then taper over `tipLen` units. */
const sword = (p, t0, t1, w, tip = 2, bend = 0) => { p.seg(t0, t1, bl(w), bend); if (tip) p.seg(t1, t1 + tip, bl(Math.max(1, w - 2)), bend * (1 + tip / (t1 - t0 + 1e-6)) * 1); };
const guard = (p, t, w, th = 1, col = BRASS) => p.bar(t, w, col, th);

/** Each weapon: { a: hero lean, tmin, tmax: extent along the shaft (units), draw(p) }. */
const WEAPONS = {
  'dagger': { a: 0.25, tmin: -3, tmax: 10, draw: p => { grip(p, -3, 0.5); pommel(p, -3.5); guard(p, 1, 4); sword(p, 2, 8, 2, 2); } },
  'straight-sword': { a: 0.22, tmin: -4, tmax: 19, draw: p => { grip(p, -3, 0.5); pommel(p, -4); guard(p, 1, 6); sword(p, 2, 16, 3, 3); } },
  'greatsword': { a: 0.2, tmin: -5, tmax: 22, draw: p => { grip(p, -4, 0.5); pommel(p, -5); guard(p, 1, 8, 2); sword(p, 3, 19, 4, 3); p.seg(4, 17, [null, '#b9bfd0', '#b9bfd0', null]); } },
  'ultra-greatsword': { a: 0.2, tmin: -6, tmax: 22, draw: p => { grip(p, -5, 0.5); pommel(p, -6); guard(p, 1, 10, 2, '#a88a3e'); p.seg(3, 19, [STEEL_H, '#c7ccdb', '#aeb4c6', '#8a91a8', STEEL_D, STEEL_D]); sword(p, 19, 20, 6, 2.5); p.seg(5, 17, [null, null, null, '#6f7690', null, null]); } },
  'curved-sword': { a: 0.12, tmin: -3, tmax: 17, draw: p => { grip(p, -3, 0.5); pommel(p, -3.5); guard(p, 1, 4); p.seg(2, 15, bl(3), 4); p.seg(15, 17, bl(1), 5); } },
  'katana': { a: 0.12, tmin: -6, tmax: 22, draw: p => { grip(p, -5, 0.5); for (let t = -5; t < 0.5; t += 2) p.bar(t, 2, '#c9b078'); pommel(p, -6); p.bar(1, 4, '#3a3a4a', 1); p.dot(1, 0, BRASS); p.seg(2, 19, [STEEL_H, STEEL_D], 2.5); p.seg(19, 21, [STEEL], 3.2); } },
  'curved-greatsword': { a: 0.1, tmin: -4, tmax: 24, draw: p => { grip(p, -4, 0.5); pommel(p, -5); guard(p, 1, 7, 2); p.seg(3, 21, bl(4), 5.5); p.seg(21, 23.5, bl(2), 6.5); } },
  'thrusting-sword': { a: 0.2, tmin: -4, tmax: 21, draw: p => { grip(p, -3, 0.5); pommel(p, -4); for (let s = -3; s <= 3; s += 1) p.dot(1.3, s, BRASS); p.dot(2.4, -3, BRASS); p.dot(2.4, 3, BRASS); p.dot(0.6, -3.5, '#8a6a1c'); p.dot(0.6, 3.5, '#8a6a1c'); p.seg(2, 18, [STEEL_H], 0); p.seg(2, 18, [STEEL_D], 0, 1); p.seg(18, 19.5, [STEEL]); } },
  'axe': { a: 0.15, tmin: -6, tmax: 16, draw: p => { p.seg(-6, 14, haft(2)); grip(p, -6, -2); axeHead(p, 9, 16, 5, false); } },
  'greataxe': { a: 0.1, tmin: -9, tmax: 18, draw: p => { p.seg(-9, 17, haft(2)); grip(p, -9, -3); axeHead(p, 9, 18, 6, true); p.dot(18.4, 0, STEEL_H); p.dot(19.2, 0, STEEL); } },
  'hammer': { a: 0.15, tmin: -6, tmax: 17, draw: p => { p.seg(-6, 14, haft(2)); grip(p, -6, -2); p.fill(12, 17, -3.4, 3.4, (t, s) => s < -2.4 || t > 16 ? STEEL_H : s > 2.4 || t < 13 ? STEEL_D : STEEL); p.bar(12, 7, '#7a8094', 1); } },
  'great-hammer': { a: 0.1, tmin: -9, tmax: 21, draw: p => { p.seg(-9, 17, haft(3)); grip(p, -9, -3); p.fill(14, 21, -5.4, 5.4, (t, s) => t > 20 || s < -4.4 ? STEEL_H : s > 4.4 || t < 15 ? '#7a8094' : (Math.abs(s) < 0.8 ? '#b9bfd0' : STEEL_D)); p.bar(14, 11, '#5f657a', 1); p.dot(17, 0, STEEL_H); } },
  'pickaxe': { a: 0.12, tmin: -6, tmax: 18, draw: p => { p.seg(-6, 17, haft(2)); grip(p, -6, -2); for (let s = -7; s <= 7; s += 0.5) { const t = 17 - 0.07 * s * s; p.dot(t, s, Math.abs(s) < 2 ? STEEL : s < 0 ? STEEL_H : STEEL_D); p.dot(t + 1, s, Math.abs(s) < 2 ? STEEL_H : STEEL); p.dot(t - 1, s, STEEL_D); } } },
  'spear': { a: 0.34, tmin: -9, tmax: 22, draw: p => { p.seg(-9, 19, haft(2)); grip(p, -4, 0); p.seg(19, 21.5, bl(3)); p.seg(21.5, 23, bl(1)); p.bar(18.5, 4, '#b8352f', 1); } },
  'halberd': { a: 0.34, tmin: -9, tmax: 22, draw: p => { p.seg(-9, 20, haft(2)); grip(p, -4, 0); p.seg(19, 22.5, bl(1)); axeHead(p, 12, 19, 5, false); p.fill(13, 17.5, -4, -1, (t, s) => (s > -3 + (t - 13) * 0.3) ? STEEL_D : null); } },
  'scythe': { a: 0.14, tmin: -10, tmax: 20, draw: p => { p.seg(-10, 19, haft(2)); grip(p, -6, -1); for (let s = 0; s <= 11; s += 0.4) { const t = 19.4 - s * s * 0.075; p.dot(t, s, STEEL_H); p.dot(t - 1, s, STEEL); p.dot(t - 2, s, s > 3 ? STEEL_D : STEEL); } p.dot(19, 0, STEEL_D); p.dot(18, 5, STEEL_H); } },
  'whip': { a: 0.1, tmin: -4, tmax: 22, draw: p => { p.seg(-4, 3, [GRIP, GRIP_D]); p.bar(3, 3, BRASS, 1); for (let u = 0; u <= 1.001; u += 0.03) { const t = 4 + u * 17, s = Math.sin(u * 8.5) * (2 + u * 3) + u * u * 5; p.dot(t, s, u > 0.9 ? RED : '#8a5a36'); p.dot(t, s + 0.6, '#5a3a24'); } } },
  'fist-weapons': { a: 0, tmin: -3, tmax: 8, draw: p => { p.fill(-1, 2, -3, 3, (t, s) => t > 1 ? STEEL_H : s > 2 ? STEEL_D : STEEL); for (const s of [-2.5, 0, 2.5]) { p.seg(2.5, 5.5, [STEEL_H, STEEL_D], 0, s); p.dot(6.4, s, STEEL); } p.bar(-3, 7, GRIP, 1.4); p.dot(0, 0, '#7a8094'); } },
  'claws': { a: 0.1, tmin: -3, tmax: 12, draw: p => { p.bar(-2, 6, GRIP, 2); p.bar(-0.5, 6, '#7a8094', 1); for (const s of [-2.6, 0, 2.6]) { p.seg(1, 9, [STEEL_H, STEEL_D].slice(0, 1).concat([STEEL_D]), 3.5, s); p.dot(9.5, s + 3.8, STEEL_H); p.dot(10.5, s + 4.3, '#fff'); } } },
  'twinblade': { a: 0.28, tmin: -17, tmax: 17, draw: p => { grip(p, -4, 4); p.bar(5, 4, BRASS, 1); p.bar(-5, 4, BRASS, 1); p.seg(6, 14, bl(3)); p.seg(14, 17, bl(1)); p.seg(-14, -6, bl(3)); p.seg(-17, -14, bl(1)); p.dot(0, 0, '#c9b078'); } },
  'bow': { a: 0, tmin: -12, tmax: 12, draw: p => bowShape(p, 12, 3.5) },
  'greatbow': { a: 0, tmin: -17, tmax: 17, draw: p => bowShape(p, 17, 5.5, true) },
  'crossbow': { a: 1.5, tmin: -6, tmax: 10, draw: p => { p.seg(-6, 9, haft(3)); p.bar(-6, 3, WOOD_D, 1);
    for (let s = -7; s <= 7; s += 0.35) { const t = 3 + 0.08 * s * s; p.dot(t, s, WOOD); p.dot(t + 0.8, s, WOOD_H); p.dot(t - 0.8, s, WOOD_D); }
    for (let s = -7; s <= 7; s += 0.3) p.dot(2.2 + 4.6 * Math.abs(s) / 7, s, '#efe6c8');
    p.seg(2, 10, [STEEL_D]); p.dot(10.6, 0, STEEL_H); p.dot(4, 0, '#b8352f'); p.dot(-1, 0, STEEL_D); } },
  'sorcery-staff': { a: 0.2, tmin: -9, tmax: 24, draw: p => { p.seg(-9, 17, haft(2)); grip(p, -4, 0); p.dot(17.5, -2, WOOD_D); p.dot(18.5, -2.5, WOOD); p.dot(17.5, 2, WOOD_D); p.dot(18.5, 2.5, WOOD); p.dot(21.5, -2.5, WOOD); p.dot(21.5, 2.5, WOOD); p.dot(22.5, 2.5, WOOD_H);
    for (let t = 17; t <= 23; t += 0.4) for (let s = -3.2; s <= 3.2; s += 0.4) { const r = Math.hypot(t - 20, s); if (r <= 2.6) p.dot(t, s, r < 1 ? '#fff' : r < 1.8 ? '#a8d4ff' : '#66aaff'); else if (r < 3.4 && ((Math.round(t * 2) + Math.round(s * 2)) % 3 === 0)) p.dot(t, s, '#b9deff'); } } },
  'pyromancy-flame': { a: 0, tmin: -2, tmax: 18, draw: p => { p.fill(-1, 0.6, -3, 3.5, (t, s) => '#e0a878'); p.fill(0.4, 1.4, -3, 3.5, (t, s) => '#c88e62'); p.dot(0, -3.8, '#c88e62'); p.dot(0.6, -3.8, '#e0a878');
    const fl = [[3, 3.2, '#c23a00'], [8, 4.5, '#ff6a00'], [13, 3.2, '#ff8a1a'], [16, 1.6, '#ff6a00']];
    for (let t = 2; t <= 18; t += 0.35) { const f = (t - 2) / 16, w = Math.sin(Math.min(1, f * 1.15) * Math.PI) * 4.2 * (1 - f * 0.55) + (f > 0.9 ? 0 : 0.4); for (let s = -w; s <= w; s += 0.35) { const q = Math.abs(s) / (w + 0.01); p.dot(t, s + Math.sin(t * 0.7) * 0.6, q > 0.75 ? '#e5400a' : q > 0.45 ? '#ff7a12' : f < 0.55 && q < 0.35 ? '#fff6c0' : '#ffd23f'); } } p.dot(19, 0.4, '#ff8a1a'); p.dot(1.5, 0, '#ffd23f'); } },
};
function axeHead(p, t0, t1, w, double) {
  const mid = (t0 + t1) / 2, hh = (t1 - t0) / 2;
  p.fill(t0 - 0.5, t1 + 0.5, double ? -w : 0.3, w, (t, s) => {
    const q = (t - mid) / hh, edge = (double ? Math.abs(s) : s) / (w * (0.55 + 0.45 * q * q));
    if (edge < 0 || edge > 1.05 || (!double && s < 0.3)) return null;
    if (Math.abs(s) < 1.1) return WOOD_D;
    return edge > 0.86 ? STEEL_H : edge > 0.35 ? (s > 0 ? STEEL : STEEL_D) : STEEL_D;
  });
}
function bowShape(p, half, bulge, great) {
  const wood = great ? [WOOD_H, WOOD] : [WOOD_H];
  for (let t = -half; t <= half; t += 0.3) { const f = t / half, s = bulge * (1 - f * f) + 0.8; p.dot(t, s, f > 0 ? WOOD_H : WOOD); p.dot(t, s + 0.8, WOOD_D); if (great) p.dot(t, s - 0.7, wood[0]); }
  p.dot(half + 0.4, 0.2, '#e8e0c8'); p.dot(-half - 0.4, 0.2, '#e8e0c8');
  for (let t = -half; t <= half; t += 0.3) p.dot(t, -1.2 + (great ? -0.6 : 0), '#efe6c8');
  p.fill(-1.5, 1.5, 1.2 + bulge * 0.9, 2.6 + bulge * 0.9, () => GRIP);
}

/** Hero weapon layer. */
function drawWeapon(g, slugName) {
  const spec = WEAPONS[slugName]; if (!spec) return false;
  const B = BOX.hero, p = makePen(g, T.hand.x, T.hand.y, spec.a, 1, B.w, B.h);
  spec.draw(p);
  // the hand closes over the grip
  rect(g, 21, 20, 3, 3, '#e8b890'); px(g, 21, 20, '#f6d4b0'); px(g, 23, 22, '#c99a74'); px(g, 22, 21, '#c99a74');
  return true;
}

// ============================================================================================================================
//   ITEM ICONS
// ============================================================================================================================
const ARMOUR_ICON = {
  head: [
    '                ',
    '                ',
    '      wwhh      ',
    '    whhhaaad    ',
    '   whhaaaaaad   ',
    '  whhaaaaaaaad  ',
    '  haaaaatttaad  ',
    '  haaaaaaaaadd  ',
    '  haaeeeeeeadd  ',
    '  haaedddddadd  ',
    '  hadd    add   ',
    '  hd        d   ',
    '                ',
    '                ',
    '                ',
    '                ',
  ],
  body: [
    '                ',
    '                ',
    '   hhh    hhh   ',
    '  hhaaa  aaadd  ',
    '  haaaaaaaaadd  ',
    '   haaaaaaaadd  ',
    '   haaattaaadd  ',
    '   haaaaaaaadd  ',
    '   haaaaaaaadd  ',
    '   haaaaaaadd   ',
    '   haaaaaaadd   ',
    '   hddddddddd   ',
    '    d d  d d    ',
    '                ',
    '                ',
    '                ',
  ],
  arms: [
    '                ',
    '                ',
    '     hhhhhh     ',
    '    hhaaaaad    ',
    '    haaaaaadd   ',
    '    hdddddddd   ',
    '    haatttaadd  ',
    '    haaaaaaadd  ',
    '   hhaaaaaaaadd ',
    '   haaaaaaaaadd ',
    '   haa haaaaadd ',
    '   haa haaaadd  ',
    '   hdddddddd    ',
    '    dd  dd      ',
    '                ',
    '                ',
  ],
  legs: [
    '                ',
    '                ',
    '   hhhhhhhhhh   ',
    '   haaaaaaaadd  ',
    '   haaaaaaaadd  ',
    '   haaa  aaadd  ',
    '   haaa  aaadd  ',
    '   haat  aatd   ',
    '   haaa  aaadd  ',
    '   haaa  aaadd  ',
    '   haaa  aaadd  ',
    '   hddd  dddd   ',
    '  hhdddd dddd   ',
    '                ',
    '                ',
    '                ',
  ],
};
const TELL = { leather: GOLD, iron: '#ffffff', bone: '#6b5f45', dog: '#7a4a2a', bureaucrat: RED, ghost: '#1a1023', obsidian: LAVA, diamond: '#ffffff', 'space-age': GLOW };

function drawArmourIcon(g, mat, slot) {
  const body = MAT_BODY[mat], m = tone(body);
  if (mat === 'obsidian') { m.l = '#5a3d9a'; m.ll = '#a66bff'; }
  if (mat === 'space-age') { m.d = '#bfcade'; m.dd = '#8fa0bc'; }
  const tell = TELL[mat];
  const pal = { a: m.b, h: m.l, w: m.ll, d: m.d, e: m.dd, t: tell };
  if (mat === 'ghost') g.globalAlpha = 0.78;
  grid(g, 0, 0, ARMOUR_ICON[slot], pal);
  g.globalAlpha = 1;
  // one distinct extra pixel per material so near-twin tints still read differently at a glance
  const extra = {
    leather: [[5, 5]], iron: [[4, 5], [11, 5]], bone: [[10, 4]], dog: [[3, 7], [3, 8]], bureaucrat: [[7, 3]], ghost: [[4, 4]], obsidian: [[9, 4]], diamond: [[5, 4]], 'space-age': [[6, 3]],
  }[mat];
  const ex = { leather: m.dd, iron: '#fff', bone: m.ll, dog: '#7a4a2a', bureaucrat: '#f4f4f8', ghost: '#eef6ff', obsidian: '#a66bff', diamond: '#fff', 'space-age': '#bfe3ff' }[mat];
  if (slot !== 'head' || mat !== 'dog') for (const [x, y] of extra) { const yy = slot === 'head' ? y : slot === 'body' ? y + 1 : slot === 'arms' ? y + 1 : y + 1; if (g.getImageData(x, yy, 1, 1).data[3]) px(g, x, yy, ex); }
  if (slot === 'head' && mat === 'dog') { pts(g, [[2, 6], [2, 7], [2, 8], [13, 6]], '#7a4a2a'); pts(g, [[1, 7], [1, 8], [1, 9]], '#5a361f'); }
}

/** Hand-pixelled icons for the two weapons whose in-hand silhouette is too small to survive the diagonal rotation. */
const HAND_ICONS = {
  'fist-weapons': ['', '', '', '', '     w w w w', '     h h h h', '    hhhhhhhhd', '    hhhhhhhhdd', '    hxaxaxaxadd', '    hxaxaxaxadd', '   hhaaaaaaaadd', '   hdddddddddd', '    ggggggggg', '    gG    Gg'],
  'claws': ['', '', '          w', '         wh   w', '    w    h    wh', '    wh   h   hd', '    h    hd  hd', '   hd    d   d', '   h     d  dd', '   dd   dd  d', '    ddddddd', '   ggggggggg', '   gGGGGGGGg', '    gggggggg'],
};
const HAND_PAL = { w: '#ffffff', h: STEEL, a: '#a7aec2', d: STEEL_D, x: '#2b1d3a', g: GRIP, G: GRIP_D };

function drawWeaponIcon(g, slugName) {
  if (HAND_ICONS[slugName]) { grid(g, 0, 0, HAND_ICONS[slugName].map(r => (slugName === 'claws' ? r.slice(1) : r).padEnd(16)), HAND_PAL); return true; }
  const spec = WEAPONS[slugName]; if (!spec) return false;
  const B = BOX.item, a = Math.PI / 4;
  const len = spec.tmax - spec.tmin;
  let k = slugName === 'dagger' ? 0.58 : Math.min(0.62, 13.2 / len);
  if (slugName === 'crossbow' || slugName === 'pyromancy-flame' || slugName === 'bow' || slugName === 'greatbow' || slugName === 'fist-weapons' || slugName === 'claws') k = Math.min(0.66, 12 / len);
  // the weapon lies on the diagonal: its lowest end starts near the bottom-left, but each lies a little differently
  const dirA = spec.a >= 1.4 ? 0.2 : slugName.endsWith('bow') ? 0.5 : a;
  const ang = slugName === 'crossbow' ? 0.9 : slugName === 'pyromancy-flame' ? 0.35 : slugName === 'bow' || slugName === 'greatbow' ? 0.55 : a;
  const sn = Math.sin(ang), cs = Math.cos(ang);
  const ox = 8 - sn * ((spec.tmax + spec.tmin) / 2) * k, oy = 8.5 + cs * ((spec.tmax + spec.tmin) / 2) * k;
  // draw on a roomier scratch canvas, then slide the result so it sits inside the 1px margin (never clipped)
  const PAD = 6, { c: sc, g: sg } = canvas(B.w + PAD * 2, B.h + PAD * 2);
  const p = makePen(sg, ox + PAD, oy + PAD, ang, k, sc.width, sc.height);
  void dirA;
  spec.draw(p);
  const d = sg.getImageData(0, 0, sc.width, sc.height).data;
  let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
  for (let y = 0; y < sc.height; y++) for (let x = 0; x < sc.width; x++) if (d[(y * sc.width + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return true;
  x0 -= PAD; x1 -= PAD; y0 -= PAD; y1 -= PAD;
  const dx = x0 < 1 ? 1 - x0 : x1 > 14 ? 14 - x1 : 0, dy = y0 < 1 ? 1 - y0 : y1 > 14 ? 14 - y1 : 0;
  g.drawImage(sc, -PAD + dx, -PAD + dy);
  return true;
}

/** Bare Hands: a small, unconvincing fist (the gear screen and popups show it when nothing is wielded). */
function drawFist(g) {
  const skin = '#e8b796', hi = '#f6d2b8', lo = '#c48e6e', dk = '#9b6a50';
  rect(g, 4, 5, 9, 7, skin);                         // the fist
  rect(g, 4, 5, 9, 1, hi); rect(g, 4, 5, 1, 6, hi);
  rect(g, 4, 11, 9, 1, lo); rect(g, 12, 6, 1, 6, lo);
  for (let i = 0; i < 3; i++) rect(g, 6 + i * 2, 6, 1, 4, lo);   // finger creases
  rect(g, 3, 8, 3, 3, skin); px(g, 3, 8, hi); rect(g, 3, 10, 3, 1, lo);   // thumb across the front
  rect(g, 6, 12, 6, 2, lo); rect(g, 6, 13, 6, 1, dk);            // wrist
}
/** Potion colours, mirrored by hand from game/loot.js POTION_COLORS (art never imports gameplay): key -> liquid hex.
 *  'item/potion' (no suffix) keeps the classic red. */
const POTION_TINT = { teal: '#2a9d8f', orange: '#f07a1a', purple: '#8a46c0', beige: '#cdb98a', pink: '#ff6fb5',
  red: '#d0312d', green: '#5f9f2a', blue: '#2f6fe0', yellow: '#e8e23a', grey: '#8a8a9a' };
function drawPotion(g, tint) {
  const base = tint || '#d0312d';
  const glass = base, glassD = shade(base, -2), glassL = shade(base, 2), cork = '#b98a52';
  rect(g, 6, 2, 4, 3, cork); rect(g, 6, 2, 4, 1, '#d6ab70'); px(g, 9, 4, '#8a6236');
  rect(g, 6, 5, 4, 2, '#e8f6ff'); px(g, 6, 5, '#fff'); rect(g, 5, 7, 6, 1, '#e8f6ff');
  const body = [[8, 4, 11], [9, 3, 12], [10, 3, 12], [11, 3, 12], [12, 4, 11], [13, 5, 10]];
  for (const [y, a, b] of body) for (let x = a; x <= b; x++) px(g, x, y, x >= b - 1 ? glassD : glass);
  rect(g, 4, 8, 1, 1, '#e8f6ff'); rect(g, 11, 8, 1, 1, glassD);
  rect(g, 4, 9, 1, 3, glassL); px(g, 5, 8, glassL); px(g, 5, 9, '#fff'); px(g, 5, 10, '#fff'); px(g, 6, 8, glassL);
  rect(g, 5, 12, 6, 1, glassD); px(g, 9, 11, glassL); px(g, 10, 10, glassL);
  px(g, 8, 5, '#fff'); px(g, 7, 6, '#fff');
}
function drawGold(g) {
  const c = '#e6b93c', cl = '#ffd23f', cd = '#a87a1a';
  const coin = (x, y, flat = true) => { rect(g, x, y, 4, 1, cl); rect(g, x, y + 1, 4, 1, c); rect(g, x, y + 2, 4, 1, cd); px(g, x, y, '#fff6c0'); px(g, x + 3, y + 1, cd); if (!flat) px(g, x + 1, y + 1, cd); };
  coin(2, 10); coin(8, 10); coin(5, 9, false); coin(4, 7); coin(8, 7, false); coin(6, 5);
  px(g, 7, 5, '#fff6c0'); px(g, 4, 8, '#fff6c0'); px(g, 9, 8, '#fff'); px(g, 5, 10, '#fff6c0');
}
function drawScroll(g) {
  const par = '#efe9ff', pard = '#e8d6a0', parD = '#b79d58';
  for (let i = 0; i < 9; i++) { const x = 3 + i, y = 11 - i; rect(g, x, y - 1, 4, 3, par); px(g, x, y + 1, pard); px(g, x + 3, y, pard); px(g, x + 3, y - 1, pard); px(g, x + 1, y - 1, '#fff'); }
  for (const [x, y, c] of [[2, 12, parD], [2, 13, parD], [3, 13, parD], [11, 3, parD], [12, 3, parD], [12, 4, parD], [11, 2, pard]]) px(g, x, y, c);
  rect(g, 2, 11, 2, 3, pard); px(g, 2, 11, par);
  rect(g, 10, 2, 3, 3, pard); px(g, 11, 3, '#c9b070'); px(g, 10, 2, '#fff');
  // red ribbon tied round the middle
  for (const [x, y] of [[6, 7], [7, 6], [8, 5], [7, 7], [6, 8], [8, 6], [5, 8]]) px(g, x, y, RED);
  pts(g, [[6, 6], [7, 5], [8, 4]], '#8e1c1a'); pts(g, [[5, 7], [5, 9], [4, 10]], RED); px(g, 4, 9, '#8e1c1a'); px(g, 8, 8, '#8e1c1a');
}
function drawUnknown(g) {
  rect(g, 3, 3, 10, 10, '#7a6a90'); rect(g, 3, 3, 10, 1, '#a898c0'); rect(g, 3, 12, 10, 1, '#4a3d60');
  grid(g, 0, 0, ['', '', '', '', '      eee', '     e   e', '         e', '       ee', '      e', '', '      e'].map(r => r.padEnd(16)), { e: '#f4eaff' });
}

// ============================================================================================================================
//   PUBLIC API
// ============================================================================================================================
const blankHero = () => { const B = BOX.hero, { c, g } = canvas(B.w, B.h); return { c, g, B }; };

/** One hero layer (see header). Returns null for 'wep-fists' and for unknown names. Deterministic, never throws. */
export function makeHeroLayer(name) {
  try {
    if (name === 'wep-fists') return null;
    name = String(name);
    if (name === 'base' || name === 'swim') {
      const { c, g, B } = blankHero();
      (name === 'base' ? drawBase : drawSwim)(g);
      return makeSprite(c, B.ax, B.ay);
    }
    if (name.startsWith('wep-')) {
      const w = name.slice(4);
      if (!WEP_SLUGS.includes(w)) return null;
      const { c, g, B } = blankHero(); drawWeapon(g, w);
      return makeSprite(c, B.ax, B.ay);
    }
    const i = name.indexOf('-'), slot = name.slice(0, i), mat = name.slice(i + 1);
    if (i > 0 && SLOT_IDS.includes(slot) && MAT_SLUGS.includes(mat)) {
      const { c, g, B } = blankHero(); drawArmour(g, slot, mat);
      return makeSprite(c, B.ax, B.ay);
    }
  } catch (e) { /* fall through */ }
  return null;
}

/** Item icon (16 x 16, anchor 8,13, outlined). Unknown names give a question-mark box. Never throws. */
export function makeItem(name) {
  const B = BOX.item, { c, g } = canvas(B.w, B.h);
  try {
    name = String(name);
    let ok = false;
    if (name === 'potion') { drawPotion(g); ok = true; }
    else if (name.startsWith('potion-') && POTION_TINT[name.slice(7)]) { drawPotion(g, POTION_TINT[name.slice(7)]); ok = true; }
    else if (name === 'gold') { drawGold(g); ok = true; }
    else if (name === 'scroll') { drawScroll(g); ok = true; }
    else if (name === 'wep-fists') { drawFist(g); ok = true; }
    else if (name.startsWith('wep-')) { const w = name.slice(4); if (WEP_SLUGS.includes(w)) ok = drawWeaponIcon(g, w); }
    else if (name.startsWith('arm-')) {
      const rest = name.slice(4), j = rest.lastIndexOf('-'), mat = rest.slice(0, j), slot = rest.slice(j + 1);
      if (j > 0 && MAT_SLUGS.includes(mat) && SLOT_IDS.includes(slot)) { drawArmourIcon(g, mat, slot); ok = true; }
    }
    if (!ok) { g.clearRect(0, 0, B.w, B.h); drawUnknown(g); }
  } catch (e) { g.clearRect(0, 0, B.w, B.h); drawUnknown(g); }
  outline(c);
  return makeSprite(c, B.ax, B.ay);
}

/** Every layer / icon name this module can make (handy for galleries and tests). */
export const HERO_LAYER_NAMES = ['base', 'swim'].concat(MAT_SLUGS.flatMap(m => SLOT_IDS.map(s => s + '-' + m)), WEP_SLUGS.map(w => 'wep-' + w));
export const ITEM_NAMES = WEP_SLUGS.map(w => 'wep-' + w).concat(MAT_SLUGS.flatMap(m => SLOT_IDS.map(s => 'arm-' + m + '-' + s)), ['potion', 'gold', 'scroll'], Object.keys(POTION_TINT).map(k => 'potion-' + k));

// ============================================================================================================================
//   FIRST-PERSON VIEWMODEL (3D view): the weapon at full size, upright and leaning in toward the centre of the screen,
//   gripped by a right hand whose fingers wrap round the handle (pommel showing below the fist), forearm running off the
//   bottom-right. Same pen and palette as the in-hand / icon art. Canvas VM.w x VM.h; the grip sits at (VM.gx, VM.gy).
// ============================================================================================================================
export const VM = { w: 96, h: 128, gx: 62, gy: 100, k: 2 };   // drawn at 2x (finer pixels than the 1x item art)
const VSKIN = '#e8b796', VSKIN_H = '#f6d2b8', VSKIN_D = '#c48e6e', VSKIN_DD = '#9b6a50';
export function makeViewmodel(slugName) {
  const { c, g } = canvas(VM.w, VM.h);
  const spec = slugName && WEAPONS[slugName];
  const a = -0.34;                                     // lean: tip up and to the left, toward the crosshair
  const p = makePen(g, VM.gx, VM.gy, a, VM.k, VM.w, VM.h, VM.k);
  if (spec) spec.draw(p);
  // forearm: continues the grip axis down and out of frame, a little narrower than the fist
  p.fill(-26, -3.0, -3.0, 3.0, (t, s) => s > 2.2 ? VSKIN_D : s < -2.3 ? VSKIN_H : (t < -12 && s > 1.2) ? VSKIN_D : VSKIN);
  // the fist: four fingers wrapped across the handle, each with a rounded knuckle on the left, dark creases between
  const unarmed = !spec;
  const f0 = unarmed ? -4.6 : -3.6, f1 = unarmed ? 2.0 : 1.2, sw = unarmed ? 4.2 : 3.6, fw = (f1 - f0) / 4;
  for (let i = 0; i < 4; i++) {
    const t0 = f0 + i * fw, t1 = t0 + fw;
    p.fill(t0, t1, -sw - 0.9, sw - 0.4, (t, s) => {
      const u = (t - t0) / fw, knuckle = -sw - 0.8 * Math.sin(Math.PI * u);   // rounded left edge per finger
      if (s < knuckle) return null;
      if (u > 0.86) return VSKIN_DD;                   // crease to the next finger
      if (s < knuckle + 0.9) return u < 0.5 ? VSKIN_H : VSKIN;   // lit knuckle top
      if (s > sw - 1.3) return VSKIN_D;                // palm side in shadow
      return VSKIN;
    });
  }
  // thumb: over the index finger, pointing up the handle, its own outline line underneath
  p.fill(f1 - 0.2, f1 + 1.6, -0.8, sw - 0.1, (t, s) => {
    const tipR = (t - (f1 + 0.9)) / 0.7;               // round the tip
    if (tipR > 0 && Math.hypot(tipR, (s - (sw * 0.5 - 0.4)) / (sw * 0.6)) > 1.05) return null;
    if (t < f1 + 0.15) return VSKIN_DD;
    if (s > sw - 0.9) return VSKIN_D;
    return t > f1 + 0.9 ? VSKIN_H : VSKIN;
  });
  // hand-held weapons without a pen (claws, fist weapons): their icon rides on the knuckles
  if (!spec && slugName && HAND_ICONS[slugName]) {
    const ic = canvas(16, 16); drawWeaponIcon(ic.g, slugName);
    g.imageSmoothingEnabled = false;
    g.drawImage(ic.c, VM.gx - 30, VM.gy - 28, 32, 32);
  }
  outline(c);
  return c;
}
