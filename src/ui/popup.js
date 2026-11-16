// ui/popup.js — the tap-to-inspect card. A port of classic `openPop` (same rules, same strings), restyled
// with styles/ui.css, plus: sprite icon, con colour + line + star for enemies, status chips, spell buttons,
// Hail for NPCs, Make camp / Rest at camp on yourself.
//
// One card at a time. It is anchored to the tapped tile (renderer.tileToClient), never covers that tile, stays inside
// the viewport and the safe-area insets, re-renders in place on every 'turn', and closes itself when its target
// vanishes, a panel opens, the run ends, or an auto-action starts.
// Coordinates are the hero's unwrapped frame; every keyed lookup goes through util.WK.
import { G } from '../core/state.js';
import { on, emit } from '../core/bus.js';
import { WK } from '../core/util.js';
import { BIOMES } from '../core/config.js';
import { $, el, css, tap, panelOpen } from './dom.js';
import { terr, biome, zoneAt, isSeen, isVis, monAt, npcAt, findPath, blocks, isDeep } from '../world/world.js';
import { siteNote, featureNote, dungeonName } from '../world/dungeon.js';
import { AIDESC } from '../data/bestiary.js';
import { shown as monShown } from '../game/monsters.js';
import { inRange, attack, con } from '../game/combat.js';
import { startAuto, endTurn, workInfo, workHint, makeCamp } from '../game/turn.js';
import { SPELLS, spellTargets, castBlock, castSpell } from '../game/spells.js';
import { NPCS } from '../game/quests.js';
import { gearDesc, defense, pickup, potName, potColor, isKnown, POTION_INFO } from '../game/loot.js';
import { belt, drink, canThrowPoison, throwBlock, throwPoison, potCount } from '../game/potions.js';
import { openGear } from './gear.js';
import { iconURL, itemSpriteId, heroSprite, sprite } from '../art/assets.js';
import { tileToClient } from '../render/renderer.js';

// ---------------------------------------------------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------------------------------------------------
/** What the card is about. mon / npc are followed if they move; x,y is the tile the card is anchored to. */
let T = null;            // { x, y, mon, npc, px, py } while open
let primary = null;      // the card's main action { fn, danger }, run by a second tap on the same tile (see confirmPrimary)
let probe = null;        // hidden element whose padding resolves the safe-area insets to pixels
let ready = false;

const MARGIN = 8;
const STATUS = [['bleed', 'Bleeding', '#ff5d6c'], ['burn', 'Burning', '#ff9a3d'], ['stun', 'Stunned', '#ffd23f'],
  ['root', 'Rooted', '#9be26a'], ['mez', 'Mesmerized', '#8fd3ff'], ['poison', 'Poisoned', '#99ff55']];

const CSS = `
#pop { padding: 10px 12px 12px; width: min(320px, 92vw); max-width: 92vw; min-width: 0; max-height: calc(100vh - 16px);
  overflow-y: auto; overflow-x: hidden; -webkit-overflow-scrolling: touch; touch-action: pan-y; }
#pop.pop-in { animation: popIn .14s ease-out; }
@keyframes popIn { from { opacity: 0; transform: translateY(6px) scale(.97); } to { opacity: 1; transform: none; } }
#pop .pp-head { display: flex; gap: 10px; align-items: flex-start; }
#pop .pp-ico { flex: none; width: 56px; height: 56px; display: flex; align-items: center; justify-content: center;
  border-radius: 10px; background: radial-gradient(circle at 50% 38%, #8a7fc4, #4b3f86 80%);
  border: 2px solid rgba(143, 211, 255, .55); box-shadow: inset 0 0 6px rgba(0, 0, 0, .35); overflow: hidden; }
#pop .pp-ico img { width: 48px; height: 48px; object-fit: contain; image-rendering: pixelated; image-rendering: crisp-edges; }
#pop .pp-title { flex: 1 1 auto; min-width: 0; padding-top: 1px; }
#pop .pp-name { font-family: var(--f-display); font-size: 18px; line-height: 1.15; letter-spacing: .3px; word-break: break-word;
  text-shadow: 0 2px 0 rgba(0, 0, 0, .55); }
#pop .pp-sub { font-size: 12.5px; color: var(--dim); margin-top: 2px; }
#pop .pp-x { flex: none; width: 44px; height: 44px; margin: -6px -8px 0 0; border: 0; background: none; color: var(--dim);
  font: 20px/1 var(--f-display); cursor: pointer; border-radius: 12px; }
#pop .pp-x:active { background: rgba(255, 255, 255, .1); }
#pop .pp-line { margin-top: 6px; }
#pop .pp-line.flavor { font-size: 1.12em; line-height: 1.3; }
#pop .pp-note { margin-top: 6px; font-style: italic; font-size: 13px; }
#pop .pp-item { display: flex; gap: 8px; align-items: center; margin-top: 8px; padding: 6px 8px; border-radius: 10px;
  background: rgba(0, 0, 0, .28); border: 1px solid rgba(255, 210, 63, .3); }
#pop .pp-item img { width: 32px; height: 32px; object-fit: contain; image-rendering: pixelated; flex: none; }
#pop .pp-item .pp-it-t { min-width: 0; } #pop .pp-item small { display: block; color: var(--dim); font-size: 12px; }
#pop .pp-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
#pop .btn-row { margin-top: 10px; }
#pop .btn-row .btn { flex: 1 1 calc(50% - 8px); min-width: 0; }
#pop .btn-row .btn.wide { flex-basis: 100%; }
#pop .pp-why { flex: 1 1 100%; margin: -4px 0 0; font-size: 11.5px; color: var(--dim); font-style: italic; }
#pop .hpbar { margin-top: 6px; }
@media (prefers-reduced-motion: reduce) { #pop.pop-in { animation: none; } }
`;

// ---------------------------------------------------------------------------------------------------------------------
// tiny helpers (text always goes through textContent / el(), so nothing needs escaping by hand)
// ---------------------------------------------------------------------------------------------------------------------
const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : s);
const div = (cls, text, style) => el('div', { class: cls, style }, text == null ? null : text);
const span = (text, cls, color) => el('span', { class: cls || null, style: color ? { color } : null }, text);
const plural = n => (n === 1 ? '' : 's');

function img(url, cls) {
  if (!url) return null;
  const i = el('img', { src: url, alt: '', draggable: 'false' });
  if (cls) i.className = cls;
  return i;
}
function safeIcon(id) { try { return iconURL(id); } catch (e) { return null; } }

/** Hero portrait: the composited hero sprite drawn to a data URL. */
function heroIcon() {
  try {
    const s = heroSprite(G.P, isDeep(G.P.x, G.P.y)), c = document.createElement('canvas');
    c.width = s.w; c.height = s.h;
    c.getContext('2d').drawImage(s.img, 0, 0);
    return c.toDataURL();
  } catch (e) { return null; }
}

/** Top-down swatch of a tile: only the top diamond (plus a sliver of side), not the full tall block. */
function tileSwatch(id) {
  try {
    const s = sprite(id, 0), w = s.w, h = Math.min(s.h, 18), c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(s.img, 0, 0, w, h, 0, 0, w, h);
    return c.toDataURL();
  } catch (e) { return safeIcon(id); }
}

/** A sprite's first frame cropped to its opaque pixels (a fern in a 48 x 64 prop box is otherwise a speck). Cached. */
const trimCache = new Map();
function trimmedIcon(id) {
  if (trimCache.has(id)) return trimCache.get(id);
  let url = null;
  try {
    const s = sprite(id, 0), c = document.createElement('canvas');
    c.width = s.w; c.height = s.h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingEnabled = false;
    g.drawImage(s.img, 0, 0, s.w, s.h, 0, 0, s.w, s.h);
    const px = g.getImageData(0, 0, s.w, s.h).data;
    let x0 = s.w, y0 = s.h, x1 = -1, y1 = -1;
    for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) if (px[(y * s.w + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) url = safeIcon(id);
    else {
      const side = Math.max(x1 - x0 + 1, y1 - y0 + 1, 12) + 2, o = document.createElement('canvas');   // square, so small things are not blown up into a blur of pixels
      o.width = o.height = side;
      const og = o.getContext('2d');
      og.imageSmoothingEnabled = false;
      og.drawImage(c, x0, y0, x1 - x0 + 1, y1 - y0 + 1, Math.floor((side - (x1 - x0 + 1)) / 2), side - 1 - (y1 - y0 + 1), x1 - x0 + 1, y1 - y0 + 1);
      url = o.toDataURL();
    }
  } catch (e) { url = safeIcon(id); }
  if (trimCache.size > 64) trimCache.clear();
  trimCache.set(id, url);
  return url;
}

/** Icon for a terrain tile: props show their prop sprite, everything else the tile block. */
function terrainIcon(x, y) {
  try {
    const t = terr(x, y);
    if (t.kind === 'none') return null;
    if (t.kind === 'prop') return trimmedIcon('prop/' + t.key);
    return tileSwatch('tile/' + t.key);
  } catch (e) { return null; }
}

function button(label, fn, cls = '', opts = {}) {
  const b = el('button', { class: ('btn ' + cls).trim(), type: 'button', disabled: opts.disabled ? 'disabled' : null, title: opts.title || null }, label);
  if (!opts.disabled) {
    tap(b, () => { try { fn(); } catch (e) { console.error('[popup]', e); } });
    if (opts.main && !primary) primary = { fn, danger: !!opts.danger };
  }
  return b;
}

const hasCamp = () => !!G.P.camp && !G.dg && Math.abs(G.P.camp.x - G.P.x) <= 2 && Math.abs(G.P.camp.y - G.P.y) <= 2;

/** A route exists to (x,y) over known, walkable (or swimmable) ground. Same test as turn.canAutoWalk minus the
 *  "nothing on it" and "not a special tile" rules, so items, doors, stairs and chests can be walked to. */
function canGo(x, y) {
  if ((x === G.P.x && y === G.P.y) || !isSeen(x, y) || blocks(x, y)) return false;
  const m = monAt(x, y);
  if (m && monShown(m)) return false;
  if (npcAt(x, y)) return false;
  try {
    const o = { shown: monShown };
    const p = findPath(x, y, o) || findPath(x, y, { ...o, wet: true });
    return !!p && p.length > 0;
  } catch (e) { return false; }
}

// ---------------------------------------------------------------------------------------------------------------------
// content
// ---------------------------------------------------------------------------------------------------------------------

/** The thing at (x,y) the card is about, resolved fresh from G every render. */
function resolve(x, y) {
  const P = G.P, self = x === P.x && y === P.y;
  const vis = isVis(x, y);
  let mon = !self && vis ? monAt(x, y) : null;
  if (mon && !monShown(mon)) mon = null;
  const npc = !self && vis ? npcAt(x, y) || null : null;
  const it = vis || self ? G.items.get(WK(x, y)) || null : null;
  return { self, vis, known: isSeen(x, y) || self, mon, npc, it };
}

function itemBlock(it) {
  const row = el('div', { class: 'pp-item' });
  const ic = img(safeIcon(itemSpriteId(it)));
  if (ic) row.append(ic);
  const t = el('div', { class: 'pp-it-t' });
  if (it.kind === 'gear' && it.gear) {
    t.append(span(it.name, 'q-' + (it.gear.q || 'Plain')), el('small', {}, gearDesc(it.gear)));
  } else if (it.kind === 'potion') {
    const known = isKnown(it.pot), info = POTION_INFO[it.pot];
    t.append(span(it.pot ? potName(it.pot) : it.name, null, it.pot ? potColor(it.pot) : '#ff7a8a'),
      el('small', {}, known && info ? info.desc : 'Unlabelled. Drinking it is the whole plan. Step on it to pocket it.'));
  } else if (it.kind === 'gold') {
    t.append(span(it.name, 'loot'), el('small', {}, 'Currency. The one thing everybody agrees on.'));
  } else if (it.kind === 'scroll') {
    const sp = it.spell && SPELLS[it.spell];
    t.append(span(sp ? 'Scroll of ' + sp.name : it.name, null, '#efe9ff'), el('small', {}, sp ? sp.desc : 'Reads itself, usually.'));
  } else {
    t.append(span(it.name || 'Something', null, it.col));
  }
  row.append(t);
  return row;
}

function statusChips(m) {
  const chips = [];
  for (const [k, label, col] of STATUS) if (m[k] > 0) chips.push(el('span', { class: 'chip', style: { color: col, borderColor: col } }, `${label}${m[k] > 1 && k !== 'mez' ? ' ' + m[k] : ''}`));
  if (m.awake === false) chips.push(el('span', { class: 'chip dim' }, 'Asleep'));
  return chips.length ? el('div', { class: 'pp-chips' }, chips) : null;
}

/** Would a one-gesture attack on m be reckless? Bosses, named rares, anything 3+ levels over you, or you under a third health. */
const risky = m => !!(m.boss || m.rare) || Math.ceil(m.lvl || 1) - G.P.lvl >= 3 || G.P.hp < G.P.max * 0.34;

/** Build the whole card for the current target. Returns the elements to put in #pop. */
function build() {
  primary = null;
  const { x, y } = T, P = G.P, R = resolve(x, y), t = terr(x, y), known = R.known;
  const out = [], btns = [], close = el('button', { class: 'pp-x', type: 'button', 'aria-label': 'Close' }, '✕');
  tap(close, closePop);

  let icon = null, name = null, sub = null;
  const body = [];

  // ---- the hero -------------------------------------------------------------------------------------------------
  if (R.self) {
    icon = heroIcon();
    name = span('You', 'pp-name');
    sub = `Lv ${P.lvl} · DEF ${defense()}`;
    const bar = el('div', { class: 'bar hp hpbar' }, [el('i', { style: { width: Math.max(0, Math.min(100, P.hp / P.max * 100)) + '%' } }), el('b', {}, `HP ${P.hp}/${P.max}`)]);
    body.push(bar);
    const w = div('pp-line');
    w.append(span(P.wep.name, 'q-' + (P.wep.q || 'Plain'), P.wep.col));
    if (P.wep.fists !== 1 && gearDesc(P.wep)) w.append(span(' · ' + gearDesc(P.wep), 'dim'));
    if (P.poison) w.append(span(' · poisoned', null, '#99ff55'));
    body.push(w);
    body.push(div('pp-line flavor', `Standing on ${t.name}, as one does.`));
    if (R.it) body.push(itemBlock(R.it));

    btns.push(button('Wait', () => { closePop(); endTurn(true); }));
    btns.push(button('Gear', () => { closePop(); openGear(); }));
    if (hasCamp()) btns.push(button('Rest at camp', () => { closePop(); startAuto({ kind: 'rest' }); }, 'primary'));
    else {
      btns.push(button('Rest', () => { closePop(); startAuto({ kind: 'rest' }); }, 'primary'));
      if (!G.dg) btns.push(button('Make camp', () => { closePop(); makeCamp(); }));
    }
    if (R.it) btns.push(button('Pick up', () => {
      const k = WK(x, y), before = G.items.get(k);
      pickup();
      if (G.items.get(k) !== before || !G.items.has(k)) { closePop(); endTurn(); } else refresh();   // bag full / scroll refused: no turn spent
    }, 'primary wide', { main: true }));
    // the potion belt: one Drink button per kind carried (never a main action: drinking is always a deliberate tap)
    for (const b of belt()) {
      const btn = button(`Drink ${b.name} (${b.n})`, () => {
        closePop();
        if (drink(b.pot) && !G.over) endTurn();
      }, 'wide', { title: b.desc });
      btn.style.borderColor = b.col;
      btn.style.boxShadow = `inset 4px 0 0 ${b.col}`;
      btns.push(btn);
    }
  }

  // ---- an enemy ---------------------------------------------------------------------------------------------------
  else if (R.mon) {
    const m = R.mon, c = con(m);
    icon = safeIcon('enemy/' + (m.rare || m.id));
    name = span((m.rare ? '★ ' : '') + m.name, 'pp-name', c.color);
    sub = `Lv ${Math.max(1, Math.ceil(m.lvl || 1))}${m.boss ? ' · Boss' : ''}${m.rare ? ' · Named rare' : ''} · ${AIDESC[m.ai] || m.ai}`;
    body.push(el('div', { class: 'bar hp hpbar' }, [el('i', { style: { width: Math.max(0, Math.min(100, m.hp / m.max * 100)) + '%' } }), el('b', {}, `HP ${m.hp}/${m.max}`)]));
    if (c.text) body.push(div('pp-line flavor', c.text, { color: c.color }));
    const chips = statusChips(m);
    if (chips) body.push(chips);
    if (R.it) body.push(itemBlock(R.it));

    const near = inRange(m);
    btns.push(button(near ? 'Attack' : 'Charge!', () => {
      if (inRange(m)) {
        attack(m); endTurn();
        if (G.over || !G.mons.includes(m) || !monShown(m)) closePop(); else refresh();
      } else { closePop(); startAuto({ kind: 'go', mon: m }); }
    }, 'primary wide', { main: true, danger: risky(m) }));

    if (canThrowPoison()) {
      const why = throwBlock(m);
      const tb = button(`Throw poison (${potCount('poison')})`, () => {
        if (throwPoison(m)) endTurn();
        if (G.over || !G.mons.includes(m) || !monShown(m)) closePop(); else refresh();
      }, 'wide', { disabled: !!why, title: why });
      tb.style.borderColor = potColor('poison');
      btns.push(tb);
      if (why) btns.push(el('div', { class: 'pp-why' }, why));
    }

    for (const id of (P.spells || [])) {
      const sp = SPELLS[id];
      if (!sp || sp.target !== 'enemy') continue;
      let ok = false;
      try { ok = spellTargets(id).includes(m); } catch (e) { ok = false; }
      if (!ok) continue;
      const why = castBlock(id, m);
      btns.push(button(`${sp.name} · ${sp.cost} MP`, () => {
        if (castSpell(id, m)) endTurn();
        if (G.over) closePop(); else refresh();
      }, 'wide', { disabled: !!why, title: why }));
      if (why) btns.push(el('div', { class: 'pp-why' }, why));
    }
  }

  // ---- an NPC -----------------------------------------------------------------------------------------------------
  else if (R.npc) {
    const n = R.npc, d = NPCS[n.id] || {};
    icon = safeIcon('npc/' + (n.look || n.id));
    name = span(n.name || d.name || 'Somebody', 'pp-name', '#8fd3ff');
    sub = n.sub || (d.quest ? 'Has a quest: ' + d.quest.title : d.adjuster ? 'Insurance, allegedly' : 'Standing here, officially');
    if (d.greet) body.push(div('pp-line flavor', '“' + d.greet + '”'));
    if (R.it) body.push(itemBlock(R.it));
    const adjacent = Math.abs(n.x - P.x) <= 1 && Math.abs(n.y - P.y) <= 1;
    btns.push(button('Hail', () => {
      closePop();
      if (adjacent) emit('hail', { npc: n }); else startAuto({ kind: 'npc', npc: n });
    }, 'primary wide', { main: true }));
  }

  // ---- terrain (and any item lying on it) ---------------------------------------------------------------------------
  else {
    icon = known ? terrainIcon(x, y) : null;
    name = span(known ? cap(t.name) : 'Unexplored', 'pp-name');
    if (known) {
      let where = '';
      try { where = G.dg ? (dungeonName() || 'Dungeon') : BIOMES[biome(x, y)]; } catch (e) { /* fall through */ }
      let zn = '';
      try { zn = zoneAt(x, y).name; } catch (e) { /* fall through */ }
      sub = [where, zn].filter(Boolean).join(' · ');
    }
    if (R.it) body.push(itemBlock(R.it));
    if (!known) body.push(div('pp-line flavor', 'Unexplored. Statistically, probably fine.'));

    const wi = known && t.blocks ? workInfo(x, y) : null;
    if (wi) {
      const left = Math.max(1, wi.n - (P.work.get(WK(x, y)) || 0));
      btns.push(button(`${wi.verb} (${left} turn${plural(left)})`, () => { closePop(); startAuto({ kind: 'work', x, y }); }, 'primary wide', { main: true }));
    } else if (known && t.blocks) {
      body.push(div('pp-note dim', `You can't walk there. You checked. ${workHint(t)}`.trim()));
    }
    const k = known ? t.key : '';
    if (k === 'pdoor' || (known && t.dd)) body.push(div('pp-note', siteNote(x, y), { color: '#ffb866' }));
    const fnote = k ? featureNote(k) : '';
    if (fnote && k !== 'dlock') body.push(div('pp-note', fnote, { color: k === 'chest' || k === 'dkey' ? '#ffe066' : '#ffb866' }));
    if (known && t.deep) body.push(div('pp-note', 'Deep. You can swim it. Things live in it.', { color: '#aab4ff' }));

    if (!wi && canGo(x, y)) btns.push(button(R.it ? 'Go grab it' : t.deep ? 'Swim here' : 'Walk here', () => { closePop(); startAuto({ kind: 'go', x, y }); }, 'primary wide', { main: true, danger: !!t.deep || k === 'pdoor' || !!t.dd }));
  }

  const head = el('div', { class: 'pp-head' });
  const ic = img(icon);
  if (ic) head.append(el('div', { class: 'pp-ico' }, ic));
  const title = el('div', { class: 'pp-title' }, [name]);
  if (sub) title.append(div('pp-sub', sub));
  head.append(title, close);
  out.push(head, ...body);
  if (btns.length) out.push(el('div', { class: 'btn-row' }, btns));
  return out;
}

/** Last-resort card if build() threw: just a name and a close button. */
function fallbackCard() {
  const c = el('button', { class: 'btn ghost', type: 'button' }, 'Close');
  tap(c, closePop);
  return [div('pp-line', 'Something is here. The details are being withheld for administrative reasons.'), el('div', { class: 'btn-row' }, [c])];
}

// ---------------------------------------------------------------------------------------------------------------------
// placement
// ---------------------------------------------------------------------------------------------------------------------
function insets() {
  try {
    const cs = getComputedStyle(probe);
    return { t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0, b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0 };
  } catch (e) { return { t: 0, r: 0, b: 0, l: 0 }; }
}

/** Anchor the card to the tapped tile: above it when the tile is in the lower half of the screen, below it when in
 *  the upper half, flipping if there is no room, docking to the opposite band as a last resort. Never covers the tile. */
function place() {
  const pop = $('pop'), vw = innerWidth, vh = innerHeight, s = insets();
  const left0 = MARGIN + s.l, right0 = vw - MARGIN - s.r, top0 = MARGIN + s.t;
  let bot0 = vh - MARGIN - s.b;
  // keep clear of the bottom nav (hotbar) and the message log so neither is ever hidden by the card
  for (const id of ['hotbar', 'log']) {
    const e = $(id);
    if (!e || !e.firstElementChild) continue;
    const r = e.getBoundingClientRect();
    if (r.height > 0 && r.top > vh / 2) bot0 = Math.min(bot0, r.top - 4);
  }
  pop.style.maxHeight = Math.max(120, bot0 - top0) + 'px';
  const w = pop.offsetWidth, h = pop.offsetHeight;

  let a = null, b = null;
  try { a = tileToClient(T.x, T.y); b = tileToClient(T.x + 1, T.y + 1); } catch (e) { /* fall back to the tap */ }
  if (!a || !isFinite(a.x) || !isFinite(a.y)) a = { x: T.px, y: T.py };
  const tileH = b && isFinite(b.y) ? Math.max(8, Math.abs(b.y - a.y)) : 24;
  const upClear = tileH * 2.8 + 6;          // sprites and trees stand above the top face
  const downClear = tileH * .75 + 8;        // the front edge / cliff face hangs below it

  const above = a.y - upClear - h, below = a.y + downClear;
  const fitsAbove = above >= top0, fitsBelow = below + h <= bot0;
  const preferAbove = a.y > vh / 2;
  let top;
  if (preferAbove && fitsAbove) top = above;
  else if (!preferAbove && fitsBelow) top = below;
  else if (fitsAbove) top = above;
  else if (fitsBelow) top = below;
  else top = a.y > vh / 2 ? top0 : bot0 - h;       // dock into the band the tile is not in
  top = Math.max(top0, Math.min(bot0 - h, top));

  let leftPx = Math.max(left0, Math.min(right0 - w, a.x - w / 2));
  if (right0 - left0 < w) leftPx = left0;

  // Never cover the hero either: if the card would sit on the hero's tile, try the other side, then slide sideways.
  let hero = null;
  try {
    if (T.x !== G.P.x || T.y !== G.P.y) {
      const hp = tileToClient(G.P.x, G.P.y), tileW = b && isFinite(b.x) ? Math.max(16, Math.abs(b.x - a.x) * 2) : 48;
      if (isFinite(hp.x) && isFinite(hp.y)) hero = { l: hp.x - tileW / 2, r: hp.x + tileW / 2, t: hp.y - upClear, b: hp.y + downClear };
    }
  } catch (e) { hero = null; }
  const hits = (l, t) => hero && l < hero.r && l + w > hero.l && t < hero.b && t + h > hero.t;
  if (hits(leftPx, top)) {
    const tops = [above, below].map(v => Math.max(top0, Math.min(bot0 - h, v)));
    const lefts = [leftPx, a.x - w - 8, a.x + 8].map(v => Math.max(left0, Math.min(right0 - w, v)));
    let found = null;
    for (const t of tops) for (const l of lefts) if (!found && !hits(l, t)) found = [l, t];
    if (found) [leftPx, top] = found;
    else if (hero) { const t2 = hero.t - h - 4 >= top0 ? hero.t - h - 4 : hero.b + 4; top = Math.max(top0, Math.min(bot0 - h, t2)); }
  }
  pop.style.left = Math.round(leftPx) + 'px';
  pop.style.top = Math.round(top) + 'px';
}

// ---------------------------------------------------------------------------------------------------------------------
// open / close / refresh
// ---------------------------------------------------------------------------------------------------------------------
function paint(fresh) {
  const pop = $('pop');
  if (!pop || !T) return;
  let kids;
  try { kids = build(); } catch (e) { console.error('[popup.build]', e); kids = fallbackCard(); }
  pop.replaceChildren(...kids);
  pop.style.display = 'block';
  pop.classList.toggle('pop-in', !!fresh);
  try { place(); } catch (e) { console.error('[popup.place]', e); }
}

/** Open the popup for tile (x,y), anchored near client point (px,py).
 *  Sets G.sel = {x,y} (the renderer highlights it) and emits 'select'. */
export function openPop(x, y, px = innerWidth / 2, py = innerHeight / 2) {
  try {
    if (!$('pop') || !G.P) return;
    const R = resolve(x, y);
    T = { x, y, mon: R.mon, npc: R.npc, px, py };
    const was = popOpen();
    G.sel = { x, y };
    paint(!was);
    emit('select', { x, y });
  } catch (e) { console.error('[popup.openPop]', e); }
}

/** Close the popup and clear G.sel. */
export function closePop() {
  const pop = $('pop');
  if (pop) { pop.style.display = 'none'; pop.classList.remove('pop-in'); }
  T = null;
  if (G.sel) { G.sel = null; emit('select', null); }
}

export const popOpen = () => { const p = $('pop'); return !!p && p.style.display === 'block'; };

/** Second tap on the open card's tile: run its main action (Attack, Hail, Chop, Walk here, Pick up...).
 *  Honors the menu setting G.opts.dbl: 'all' runs everything, 'danger' (default) leaves risky actions on the card for a deliberate tap.
 *  Returns true if it ran something. */
export function confirmPrimary() {
  if (!T || !popOpen() || !primary) return false;
  if (((G.opts && G.opts.dbl) || 'danger') !== 'all' && primary.danger) return false;
  try { primary.fn(); } catch (e) { console.error('[popup.confirmPrimary]', e); return false; }
  return true;
}

/** Re-render in place after the world moved on. Follows a monster or NPC that stepped; closes if the target is gone. */
function refresh() {
  if (!T || !popOpen()) return;
  if (G.over || !G.P || panelOpen()) { closePop(); return; }
  if (T.mon) {
    const m = T.mon;
    if (!G.mons.includes(m) || m.hp <= 0 || !monShown(m)) { closePop(); return; }
    if (m.x !== T.x || m.y !== T.y) { T.x = m.x; T.y = m.y; G.sel = { x: m.x, y: m.y }; emit('select', { x: m.x, y: m.y }); }
  } else if (T.npc) {
    const n = T.npc;
    if (!G.npcs.includes(n)) { closePop(); return; }
    if (n.x !== T.x || n.y !== T.y) { T.x = n.x; T.y = n.y; G.sel = { x: n.x, y: n.y }; emit('select', { x: n.x, y: n.y }); }
  } else {
    // a tile card: if something now stands on it, hand over to that card
    const R = resolve(T.x, T.y);
    if (R.mon) T.mon = R.mon; else if (R.npc) T.npc = R.npc;
  }
  paint(false);
}

export function initPopup() {
  if (ready) return;
  ready = true;
  css('pop', CSS);
  const pop = $('pop'), app = $('app') || document.body;
  if (!pop) return;
  pop.style.display = 'none';
  tap(pop, () => { /* swallow: a tap on the card never reaches the world canvas */ });
  probe = el('div', { 'aria-hidden': 'true', style: { position: 'absolute', visibility: 'hidden', pointerEvents: 'none', left: '0', top: '0', width: '0', height: '0',
    padding: 'var(--safe-t) var(--safe-r) var(--safe-b) var(--safe-l)' } });
  app.append(probe);

  on('asset', () => trimCache.clear());
  on('turn', refresh);
  on('moved', () => { if (T) refresh(); });
  on('terrain', () => { if (T) refresh(); });
  on('drop', () => { if (T) refresh(); });
  on('pickup', () => { if (T) refresh(); });
  on('auto', e => { if (e && e.auto && popOpen()) closePop(); });
  for (const ev of ['death', 'newgame', 'loaded', 'floor', 'hail', 'far']) on(ev, () => { if (popOpen()) closePop(); });
  addEventListener('resize', () => { if (popOpen()) try { place(); } catch (e) { /* ignore */ } });

  // a panel (gear, journal, dialog, death screen) opening must dismiss the card
  const panel = $('panel');
  if (panel && typeof MutationObserver === 'function') {
    new MutationObserver(() => { if (popOpen() && panelOpen()) closePop(); }).observe(panel, { attributes: true, attributeFilter: ['style'] });
  }
}
