// ui/gear.js — the Gear screen (classic openGear, restyled onto the shared #panel modal).
// Weapon + four armour slots (icon, rarity-coloured name, gearDesc), set-bonus lines, and the bag with Equip / Drop.
// Equipping and dropping cost no turn (classic). Everything user-visible is written with textContent via el().
import { G } from '../core/state.js';
import { on } from '../core/bus.js';
import { BAG } from '../core/config.js';
import { SLOTS, MATERIALS, defense, pieces, gearDesc, equip, dropGear } from '../game/loot.js';
import * as assets from '../art/assets.js';
import { el, css, tap, showPanel, hidePanel } from './dom.js';
import { belt, drink } from '../game/potions.js';
import { endTurn } from '../game/turn.js';

let inited = false;
let open = false;     // true while our panel is the one showing
let root = null;      // the .panel node we last put in #panel

const STYLE = `
#gear { width: min(620px, 100%); max-height: 100%; display: flex; flex-direction: column; gap: 10px; overflow: hidden;
  padding: 14px calc(14px + env(safe-area-inset-right, 0px)) calc(14px + env(safe-area-inset-bottom, 0px)) calc(14px + env(safe-area-inset-left, 0px)); }
#gear .gear-head { display: flex; align-items: center; gap: 6px; flex-wrap: nowrap; }
#gear .gear-title { font-size: 30px; flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#gear .gear-pill { font-family: var(--f-display); font-size: 13px; padding: 5px 11px; border-radius: 999px; white-space: nowrap;
  border: 2px solid rgba(143, 211, 255, .45); background: rgba(18, 8, 38, .7); color: var(--white); }
@media (max-width: 380px) { #gear .gear-title { font-size: 24px; } #gear .gear-pill { font-size: 11px; padding: 4px 7px; } #gear .gear-head { gap: 4px; } }
#gear .gear-x { flex: none; min-width: 44px; min-height: 44px; padding: 0; font-size: 18px; }
#gear .btn { min-height: 44px; }
#gear .gear-body { display: flex; flex-direction: column; gap: 12px; overflow-y: auto; -webkit-overflow-scrolling: touch;
  max-height: min(76vh, 760px); padding: 2px 4px 2px 0; overscroll-behavior: contain; }
#gear .gear-body > * { flex: none; }   /* rows keep their natural height; the body scrolls instead of squashing them */
#gear .gear-sec { font-family: var(--f-display); font-size: 15px; letter-spacing: .5px; color: var(--orange); margin: 6px 0 0; }
#gear .gear-row { display: flex; gap: 12px; align-items: center; padding: 8px 10px; border-radius: 14px; min-height: 56px;
  background: rgba(18, 8, 38, .55); border: 1px solid rgba(143, 211, 255, .22); }
#gear .gear-ico { flex: 0 0 40px; width: 40px; height: 40px; border-radius: 10px; display: grid; place-items: center;
  background: rgba(8, 4, 20, .6); border: 1px solid rgba(143, 211, 255, .25); }
#gear .gear-ico.empty { background: transparent; border: 2px dashed rgba(143, 211, 255, .4); }
#gear .gear-ico img { width: 40px; height: 40px; image-rendering: pixelated; image-rendering: crisp-edges; display: block; }
#gear .gear-txt { flex: 1 1 auto; min-width: 0; }
#gear .gear-lbl { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: var(--dim); }
#gear .gear-name { font-family: var(--f-display); font-size: 16px; line-height: 1.2; overflow-wrap: anywhere; }
#gear .gear-name.dim { color: var(--dim); font-style: italic; }
#gear .gear-desc { font-size: 13px; color: var(--dim); margin-top: 3px; line-height: 1.35; overflow-wrap: anywhere; }
#gear .gear-hint { font-size: 12px; font-weight: 700; margin-top: 4px; }
#gear .gear-up { color: #7f7; } #gear .gear-down { color: #f77; } #gear .gear-same { color: var(--dim); }
#gear .gear-acts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
#gear .gear-acts .btn { min-width: 96px; }
#gear .gear-set { font-size: 13px; line-height: 1.35; padding: 7px 10px; border-radius: 8px; border-left: 3px solid var(--orange);
  background: rgba(255, 122, 26, .1); }
#gear .gear-set.off { opacity: .55; border-left-color: rgba(143, 211, 255, .35); background: rgba(18, 8, 38, .45); }
#gear .gear-set .gear-need { font-weight: 700; color: var(--dim); font-style: italic; }
#gear .gear-pot { flex: none; font-family: var(--f-display); font-size: 18px; min-width: 34px; text-align: right; }
#gear .gear-empty { font-style: italic; color: var(--dim); text-align: center; padding: 14px 8px; }
@media (max-width: 420px) {
  #gear .gear-title { font-size: 26px; }
  #gear .gear-row { padding: 8px; gap: 10px; }
}`;

const kids = (...xs) => xs.filter(x => x != null && x !== false);
const avg = g => (g.min + g.max) / 2;

/** Icon for a gear object; a blank box when there is no gear or the sprite cannot be made. */
function icon(g, empty = false) {
  let img = null;
  if (g) {
    try {
      img = el('img', { src: assets.iconURL(assets.gearIconId(g)), alt: '', width: 40, height: 40, draggable: 'false' });
    } catch (e) { console.error('[gear.icon]', e); }
  }
  return el('div', { class: 'gear-ico' + (empty ? ' empty' : '') }, img ? [img] : []);
}

/** Small coloured delta text: green better, red worse, muted when equal. */
function delta(d, unit) {
  const r = Math.round(d * 10) / 10;
  const cls = r > 0 ? 'gear-up' : r < 0 ? 'gear-down' : 'gear-same';
  return el('div', { class: 'gear-hint ' + cls }, `${r > 0 ? '+' : ''}${r} ${unit}`);
}

/** One item row. g null = empty slot. hint/actions optional. */
function itemRow({ label, g, slotName, hint, actions }) {
  const txt = el('div', { class: 'gear-txt' }, kids(
    label && el('div', { class: 'gear-lbl' }, label),
    g
      ? el('div', { class: 'gear-name q-' + (g.q || 'Plain') }, g.name)
      : el('div', { class: 'gear-name dim' }, slotName ? 'Nothing worn' : 'Empty'),
    g && el('div', { class: 'gear-desc' }, gearDesc(g)),
    hint,
    actions && el('div', { class: 'gear-acts' }, actions),
  ));
  return el('div', { class: 'gear-row' }, kids(icon(g, !g && !!slotName), txt));
}

/** Action button wired with tap (pointer-safe, no 300 ms delay, stops the tap reaching the canvas). */
function actBtn(label, cls, fn) {
  const b = el('button', { class: 'btn small ' + cls, type: 'button' }, label);
  tap(b, fn);
  return b;
}

function bagRow(g, i) {
  let hint = null;
  if (g.kind === 'wep') {
    const cur = G.P.wep;
    hint = delta(avg(g) - (cur ? avg(cur) : 0), 'avg dmg');
  } else {
    const cur = G.P.arm[g.slot];
    hint = delta(g.def - (cur ? cur.def : 0), 'DEF');
  }
  return itemRow({
    g, hint,
    actions: [
      actBtn('Equip', 'primary', () => { equip(i); openGear({ top: true }); }),
      actBtn('Drop', 'danger', () => { dropGear(i); openGear(); }),
    ],
  });
}

/** One belt row: tinted potion icon, colour (or identified) name, count, what it does if known, and Drink. */
function potRow(b) {
  let img = null;
  try { img = el('img', { src: assets.iconURL(b.sprite), alt: '', width: 40, height: 40, draggable: 'false' }); } catch (e) { console.error('[gear.potIcon]', e); }
  const ico = el('div', { class: 'gear-ico' }, img ? [img] : []);
  ico.style.borderColor = b.col;
  const txt = el('div', { class: 'gear-txt' }, [
    el('div', { class: 'gear-name', style: { color: b.col } }, b.name),
    el('div', { class: 'gear-desc' }, b.desc),
    el('div', { class: 'gear-acts' }, [actBtn('Drink', b.pot === 'nuke' || b.pot === 'poison' ? 'danger' : 'primary', () => {
      closeGear();
      if (drink(b.pot) && !G.over) endTurn();
    })]),
  ]);
  return el('div', { class: 'gear-row' }, [ico, txt, el('div', { class: 'gear-pot' }, '×' + b.n)]);
}

/** Pieces needed before a material's set bonus is live. Materials not listed are per-piece bonuses (active from 1). */
const SET_NEEDS = { obsidian: 2, space: 1 };

/** Set-bonus lines: one per material with at least one worn piece (classic wording).
 *  A bonus below its piece threshold is dimmed and labelled "needs N". */
function setLines() {
  const c = pieces();
  const out = [];
  for (const m of MATERIALS) {
    const n = m.prop ? c[m.prop] || 0 : 0;
    if (!(n > 0 && m.desc)) continue;
    const need = SET_NEEDS[m.prop] || 1;
    if (n >= need) out.push(el('div', { class: 'gear-set' }, `${m.name} ×${n}: ${m.desc}`));
    else out.push(el('div', { class: 'gear-set off' }, kids(`${m.name} ×${n}: ${m.desc} `, el('span', { class: 'gear-need' }, `(inactive, needs ${need})`))));
  }
  return out;
}

function build() {
  const P = G.P;
  const bag = P.inv || [];
  const worn = [];
  worn.push(el('div', { class: 'gear-sec' }, 'Worn'));
  worn.push(itemRow({ label: 'Weapon', g: P.wep }));
  for (const s of SLOTS) {
    const g = P.arm[s.slot] || null;
    worn.push(itemRow({ label: s.slot, g, slotName: s.slot }));
  }
  const sets = setLines();
  let pots = [];
  try { pots = belt(); } catch (e) { console.error('[gear.belt]', e); }

  const closeBtn = el('button', { class: 'btn ghost small gear-x', type: 'button', 'aria-label': 'Close' }, '✕');
  tap(closeBtn, closeGear);

  const head = el('div', { class: 'gear-head' }, [
    el('h2', { class: 'h gear-title' }, 'Gear'),
    el('span', { class: 'gear-pill' }, 'DEF ' + defense()),
    el('span', { class: 'gear-pill' }, `Bag ${bag.length}/${BAG}`),
    closeBtn,
  ]);

  const body = el('div', { class: 'gear-body' }, kids(
    ...worn,
    sets.length ? el('div', { class: 'gear-sec' }, 'Set bonuses') : null,
    sets.length ? el('div', { class: 'gear-sets' }, sets) : null,
    el('div', { class: 'gear-sec' }, 'Potion belt'),
    ...(pots.length ? pots.map(potRow) : [el('div', { class: 'gear-empty' }, 'No potions. Sobriety, by default rather than by choice.')]),
    el('div', { class: 'gear-sec' }, `Bag ${bag.length}/${BAG}`),
    ...(bag.length ? bag.map(bagRow) : [el('div', { class: 'gear-empty' }, 'Empty. Like most promises.')]),
  ));

  return el('div', { class: 'panel', id: 'gear', role: 'dialog', 'aria-label': 'Gear' }, [head, body]);
}

/** Bus refresh: only re-render while our panel is the one showing; otherwise forget that it is open. */
function refresh() {
  if (!open) return;
  if (!root || !root.isConnected) { open = false; root = null; return; }
  openGear();
}

/** Subscribe once and inject the screen's CSS. Idempotent. */
export function initGear() {
  if (inited) return;
  inited = true;
  css('gear', STYLE);
  on('equip', refresh);
  on('pickup', refresh);
  on('drop', refresh);
}

/** Open (or refresh, keeping the scroll position unless opts.top) the Gear screen in the shared modal. */
export function openGear(opts) {
  try {
    if (!inited) initGear();
    if (!G.P) return;
    // After an Equip the change lives in the Worn section, so show it from the top; otherwise keep the scroll.
    const top = !!(opts && opts.top === true);
    const prevScroll = !top && root && root.isConnected ? (root.querySelector('.gear-body')?.scrollTop ?? 0) : 0;
    root = build();
    showPanel(root);
    const body = root.querySelector('.gear-body');
    if (body && prevScroll) body.scrollTop = prevScroll;
    open = true;
  } catch (e) { console.error('[gear.openGear]', e); }
}

/** Close the Gear screen. Leaves the modal alone if another screen has since taken it. */
export function closeGear() {
  const mine = !root || root.isConnected;
  open = false;
  root = null;
  if (mine) hidePanel();
}
