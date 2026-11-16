// ui/hud.js — the HUD. Everything that floats over the world: the top bar (#hud: Lv, HP / MP bars, five-bubble XP bar, gold, weapon,
// DEF, zone + distance + danger skulls, day phase, bestiary count, status chips, minimap), the message log (#log),
// the hotbar (#hotbar: spell gems + Gear / Journal / Camp-Rest / Menu / Bestiary) and the zone banner (#banner).
//
// Rules this module keeps: no top-level side effects (all DOM is built in initHud), every refresh is a diff
// (text / width / class only change when the value changed, nodes are never rebuilt per turn), user-facing text goes
// through textContent, nothing here can throw into the bus or the turn pipeline, and the whole HUD is hidden while the
// title screen is up. The minimap is repainted only on turn / loaded / newgame / floor (+ start / zone / resize / toggle).
import { G, say } from '../core/state.js';
import { on } from '../core/bus.js';
import { WS, BESTIARY_TOTAL, dayInfo } from '../core/config.js';
import { TERRAIN } from '../data/terrain.js';
import * as world from '../world/world.js';
import * as turn from '../game/turn.js';
import * as spells from '../game/spells.js';
import * as loot from '../game/loot.js';
import { openGear } from './gear.js';
import { openJournal, openMenu, openBestiary } from './panels.js';
import { $, el, css, tap } from './dom.js';
import { titleVisible } from './title.js';

// ---- constants -----------------------------------------------------------------------------------------------
const MAP_R = 23;                    // minimap radius in tiles: (2R+1)^2 = 2209 fills <= 2300
const MAP_N = MAP_R * 2 + 1;
const MAP_PX = 3;                    // backing pixels per tile (CSS scales the canvas, nearest-neighbour)
const LOG_SHORT = 5, LOG_LONG = 30;
const BANNER_MS = 2500;
const MAP_EVENTS = new Set(['turn', 'loaded', 'newgame', 'floor', 'start', 'zone']);
const PHASE = {
  day: { g: '☀', c: '#ffd23f', t: 'Day' },
  dusk: { g: '☀', c: '#ff8a3d', t: 'Dusk' },
  night: { g: '☾', c: '#8fb4ff', t: 'Night' },
  dawn: { g: '☀', c: '#ff9ec4', t: 'Dawn' },
};
const LOG_COL = { good: '#7dff8a', bad: '#ff5d6c', loot: '#ffd23f', sys: '#a898c8', zone: '#ff9a3d', '': '#efe9ff' };

// ---- module state (touched only from functions) ------------------------------------------------------------------
const ui = {};                       // cached DOM nodes
const last = {};                     // last-written values, for diffing
let built = false, queued = false, mapDirty = true, logOpen = false, mapBig = false, started = false;
let bannerFade = 0, bannerHide = 0, mapCtx = null, mapImg = null;
const colorCache = new Map();

const num = v => (Number.isFinite(v) ? v : 0);

/** Write text / class / style only when it changed. */
function setText(node, key, v) { v = String(v); if (last[key] !== v) { last[key] = v; node.textContent = v; } }
function setStyle(node, key, prop, v) { if (last[key] !== v) { last[key] = v; node.style[prop] = v; } }
function setClass(node, key, v) { if (last[key] !== v) { last[key] = v; node.className = v; } }
function setAttr(node, key, name, v) { if (last[key] !== v) { last[key] = v; node.setAttribute(name, v); } }
function show(node, key, visible, disp = '') { const v = visible ? disp : 'none'; if (last[key] !== v) { last[key] = v; node.style.display = v; } }

const STYLE = `
#hud { display: block; }
#hud .hd-wrap { position: relative; display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; pointer-events: none; }
#hud .hd-main { flex: 1 1 auto; min-width: 0; max-width: 600px; display: flex; flex-direction: column; gap: 4px; pointer-events: none; }
#hud .hd-r1 { display: flex; align-items: center; gap: 6px; }
#hud .hd-lv { flex: none; min-width: 34px; height: 30px; padding: 0 8px; display: flex; align-items: center; justify-content: center; gap: 3px;
  border-radius: 10px; border: 2px solid var(--line); background: linear-gradient(180deg, #3a1c74, #1d1140); box-shadow: 0 2px 0 var(--ink), 0 3px 0 var(--orange);
  font-family: var(--f-display); font-size: 15px; color: #fff; text-shadow: 0 2px 0 var(--orange); }
#hud .hd-lv small { font-size: 9px; color: var(--blue); text-shadow: none; letter-spacing: 1px; }
#hud .hd-bars { flex: 1 1 auto; min-width: 0; display: flex; gap: 6px; }
#hud .hd-bars .bar { flex: 1 1 0; min-width: 0; height: 20px; }
#hud .hd-bars .bar > b { font-size: 12px; }
#hud .hd-bars .bar.mp { flex: .8 1 0; }
#hud .hd-xp { height: 10px; margin: 0 2px; }
#hud .hd-chips { display: flex; flex-wrap: wrap; gap: 3px 4px; align-items: center; }
#hud .hd-chips .chip { font-size: 12px; padding: 1px 7px; line-height: 18px; background: rgba(18, 8, 38, .72); }
#hud .hd-gold { color: var(--sun); font-family: var(--f-display); }
#hud .hd-gold::before { content: ''; width: 9px; height: 9px; border-radius: 50%; background: var(--sun); box-shadow: inset -2px -2px 0 #e0a21f, 0 0 0 1px var(--ink); flex: none; }
#hud .hd-zone { border-color: rgba(255, 154, 61, .7); color: #ffd9b0; max-width: min(100%, 52%); min-width: 0; white-space: nowrap; line-height: 17px; height: 20px; box-sizing: border-box; overflow: hidden; }
#hud .hd-zone b { font-family: var(--f-flavor); font-weight: 600; font-size: 14px; color: #fff; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
#hud .hd-zone .hd-dim, #hud .hd-zone .hd-sk { flex: none; }
#hud .hd-sk { letter-spacing: -1px; font-size: 11px; }
#hud .hd-sk i { font-style: normal; color: rgba(168, 152, 200, .4); }
#hud .hd-sk i.on { color: var(--bad); text-shadow: 0 0 4px rgba(255, 93, 108, .6); }
#hud .hd-dim { color: var(--dim); }
#hud .hd-dex b { font-family: var(--f-display); font-weight: 400; color: var(--blue); }
#hud .hd-st { border-width: 1px; font-family: var(--f-display); font-size: 11px; letter-spacing: .3px; }
#hud .hd-st.poison { color: #b6ff5a; border-color: #7ac43a; } #hud .hd-st.haste { color: var(--sun); border-color: var(--sun); }
#hud .hd-st.feign { color: #cdb8ff; border-color: #9a7ae0; } #hud .hd-st.insured { color: var(--good); border-color: #4fbf5f; }
#hud .hd-st.slowed { color: var(--bad); border-color: var(--bad); } #hud .hd-st.camp { color: #ff9a3d; border-color: var(--orange); }
#hud .hd-slot { flex: none; width: 100px; height: 100px; pointer-events: none; }
#hud .hd-map { position: absolute; right: 0; top: 0; width: 100px; height: 100px; border-radius: 12px; border: 2px solid var(--line); background: #08060f;
  box-shadow: 0 0 0 2px var(--ink), 0 0 12px rgba(255, 47, 160, .35), 0 4px 10px rgba(0, 0, 0, .5); overflow: hidden; pointer-events: auto; cursor: pointer; z-index: 2;
  transition: width .15s, height .15s; }
/* the map is turned 45 degrees so that up on the map is up on the screen (the world is drawn isometric) */
#hud .hd-map canvas { display: block; width: 100%; height: 100%; image-rendering: pixelated; image-rendering: crisp-edges; transform: rotate(45deg) scale(1.42); }
#hud .hd-map.big { width: min(60vw, 300px); height: min(60vw, 300px); }
#hud .hd-map .hd-n { position: absolute; left: 4px; top: 2px; font: 9px var(--f-display); color: rgba(255, 255, 255, .8); text-shadow: 0 1px 0 #000; pointer-events: none; }
#hud .hd-narrow { display: none; }
@media (max-width: 420px) { #hud .hd-narrow { display: inline; } }
@media (min-width: 700px) { #hud .hd-slot { width: 124px; height: 124px; } #hud .hd-map { width: 124px; height: 124px; } #hud .hd-map.big { width: 320px; height: 320px; }
  #hud .hd-chips .chip { font-size: 13px; } #hud .hd-bars .bar { height: 22px; } #hud .hd-bars .bar > b { font-size: 13px; } }
@media (max-width: 420px) { #hud .hd-chips .chip { font-size: 11px; padding: 0 6px; line-height: 17px; } #hud .hd-wide { display: none; }
  #hud .hd-zone { max-width: 100%; flex: 1 1 100%; white-space: nowrap; height: 19px; box-sizing: border-box; } #hud .hd-zone b { flex: 0 1 auto; } #hud .hd-zone .hd-dim .hd-wide { display: none; } }

#log .hl-box { position: relative; pointer-events: none; cursor: pointer; padding: 4px 8px 4px 8px; border-radius: 10px; width: fit-content; max-width: 100%;
  background: linear-gradient(90deg, rgba(18, 8, 38, .62), rgba(18, 8, 38, .25)); }
#log .hl-box.open { pointer-events: auto; width: 100%; max-height: min(42vh, 360px); overflow-y: auto; touch-action: pan-y; -webkit-overflow-scrolling: touch; background: rgba(18, 8, 38, .86);
  border: 1px solid rgba(255, 47, 160, .5); }
#log .hl-tab { position: absolute; right: 0; bottom: 0; pointer-events: auto; cursor: pointer; font: 10px var(--f-display); letter-spacing: 1px; color: var(--dim); padding: 3px 7px; border-radius: 8px; background: rgba(18, 8, 38, .7); text-shadow: none; }
#log .hl-l { overflow-wrap: anywhere; }
#log .hl-l.zone { font-family: var(--f-flavor); font-size: 1.12em; font-weight: 600; }
#log .hl-hint { font: 10px var(--f-display); color: var(--dim); text-align: right; letter-spacing: 1px; padding-top: 2px; }

#hotbar { flex-direction: column; align-items: center; gap: 6px; }
#hotbar .hb-gems, #hotbar .hb-btns { display: flex; justify-content: center; gap: 6px; width: 100%; pointer-events: none; }
#hotbar .hb-gems > *, #hotbar .hb-btns > * { pointer-events: auto; }
#hotbar .hb-btns { max-width: 520px; }
#hotbar .hb-gem { position: relative; width: 48px; height: 48px; flex: none; border-radius: 50%; cursor: pointer; padding: 0;
  font-family: var(--f-display); font-size: 21px; color: #fff; text-shadow: 0 2px 0 #1b0f3b;
  background: radial-gradient(circle at 35% 30%, #9fd8ff, #3c6ee0 45%, #1b2a80); border: 2px solid var(--white);
  box-shadow: 0 3px 0 var(--ink), 0 4px 0 var(--orange), 0 0 12px rgba(91, 140, 255, .5); transition: transform .05s, filter .15s; }
#hotbar .hb-gem.enemy { background: radial-gradient(circle at 35% 30%, #ffc7a0, #ff6a2a 45%, #8a1d12); box-shadow: 0 3px 0 var(--ink), 0 4px 0 var(--line), 0 0 12px rgba(255, 106, 42, .5); }
#hotbar .hb-gem:active { transform: translateY(3px); }
#hotbar .hb-gem .hb-c { position: absolute; right: -4px; bottom: -4px; min-width: 20px; height: 20px; padding: 0 4px; border-radius: 10px; font-size: 12px; line-height: 17px; text-align: center;
  background: var(--ink); border: 1px solid var(--blue); color: var(--blue); text-shadow: none; }
#hotbar .hb-gem .hb-k { position: absolute; left: -2px; top: -4px; font-size: 10px; color: var(--sun); text-shadow: 0 1px 0 #000; }
#hotbar .hb-gem.off { filter: grayscale(.85) brightness(.6); }
#hotbar .hb-b { flex: 1 1 0; min-width: 0; max-width: 104px; min-height: 48px; padding: 4px 2px 3px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0; line-height: 1; }
#hotbar .hb-b .hb-i { font-size: 19px; line-height: 20px; }
#hotbar .hb-b .hb-t { font-size: 11px; letter-spacing: .2px; white-space: nowrap; }
#hotbar .hb-b.camp .hb-i { color: #ffb347; }
@media (max-width: 420px) { #log { font-size: 12px; } #hotbar .hb-b .hb-t { font-size: 10px; } #hotbar .hb-b { padding: 4px 0 3px; } }

@media (max-height: 500px) {
  #log { font-size: 11px; line-height: 1.25; width: min(420px, calc(100% - 16px)); }
  #log .hl-box { padding: 2px 6px; border-radius: 8px; }
  #log .hl-box.open { max-height: 55vh; }
  #log .hl-tab { font-size: 9px; padding: 1px 5px; }
}

#banner { display: block; }
#banner .hb-z { opacity: 0; transform: translateY(-8px) scale(.96); transition: opacity .55s ease, transform .55s ease; display: inline-block; padding: 6px 22px 10px; max-width: calc(100% - 24px); }
#banner .hb-z.in { opacity: 1; transform: none; }
#banner .hb-zn { font-family: var(--f-flavor); font-weight: 700; font-size: clamp(30px, 8.4vw, 58px); line-height: 1.05; color: #fff;
  text-shadow: 0 3px 0 var(--orange), 0 0 22px rgba(255, 47, 160, .7), 0 0 4px #000; }
#banner .hb-zs { margin-top: 6px; font-family: var(--f-display); font-size: 13px; letter-spacing: 1.5px; color: var(--blue); text-shadow: 0 1px 0 #000, 0 0 6px #000; }
#banner .hb-zs .hd-sk i { font-style: normal; color: rgba(168, 152, 200, .45); } #banner .hb-zs .hd-sk i.on { color: var(--bad); }
@media (prefers-reduced-motion: reduce) { #banner .hb-z, #hud .hd-map { transition: none; } }
`;

// =====================================================================================================================
// Build
// =====================================================================================================================

/** Build the DOM once and subscribe to the bus ('*' -> coalesced refresh; 'zone' -> banner). */
export function initHud() {
  if (built) return;
  try {
    css('hud', STYLE);
    buildTop(); buildLog(); buildHotbar(); buildBanner();
    built = true;
    on('*', ev => { if (MAP_EVENTS.has(ev)) mapDirty = true; schedule(); });
    on('zone', p => { try { if (p && !p.quiet) showBanner(p.zone); } catch (e) { console.error('[hud.banner]', e); } });
    // a new life after the first one ("Be born again", Give up) wakes somewhere too; the first is announced by main.js on 'start'
    on('start', () => { started = true; });
    on('newgame', () => { try { if (started) showBanner(world.zoneAt(G.P.x, G.P.y)); } catch (e) { console.error('[hud.banner]', e); } });
    // pyramid floors share one zone id, so turn.js emits 'zone' only once; re-announce the live floor on every change
    on('floor', p => { try { if (p && p.dg) showBanner(world.zoneAt(G.P.x, G.P.y)); } catch (e) { console.error('[hud.banner]', e); } });
    addEventListener('resize', () => { fitLog(); last.logSig = null; renderLog(); });
    if (typeof ResizeObserver === 'function') new ResizeObserver(fitLog).observe(ui.hotbar);
    refreshHud();
  } catch (e) { console.error('[hud.init]', e); }
}

function schedule() {
  if (queued) return; queued = true;
  const run = () => { queued = false; refreshHud(); };
  if (typeof requestAnimationFrame === 'function' && !document.hidden) requestAnimationFrame(run); else queueMicrotask(run);
}

function buildTop() {
  const host = $('hud'); if (!host) return;
  ui.hud = host;
  ui.lvNum = el('span', { class: 'num' }, '1');
  ui.lv = el('div', { class: 'hd-lv', title: 'Level' }, [el('small', {}, 'LV'), ui.lvNum]);
  ui.hpFill = el('i'); ui.hpTxt = el('b');
  ui.hp = el('div', { class: 'bar hp', title: 'Hit Points' }, [ui.hpFill, ui.hpTxt]);
  ui.mpFill = el('i'); ui.mpTxt = el('b');
  ui.mp = el('div', { class: 'bar mp', title: 'Motivation Points', style: { display: 'none' } }, [ui.mpFill, ui.mpTxt]);
  ui.xpFill = el('i');
  ui.xp = el('div', { class: 'bar xp hd-xp', title: 'Experience' }, [ui.xpFill]);

  ui.zoneName = el('b'); ui.zoneDistN = el('span'); ui.zoneDistL = el('span', { class: 'hd-wide' }, ' from home');
  ui.zoneDist = el('span', { class: 'hd-dim' }, [ui.zoneDistN, ui.zoneDistL]);
  ui.skulls = el('span', { class: 'hd-sk', title: 'Danger' }, [0, 1, 2, 3, 4].map(() => el('i', {}, '☠')));
  ui.zone = el('span', { class: 'chip hd-zone' }, [ui.zoneName, ui.zoneDist, ui.skulls]);
  ui.dnG = el('span'); ui.dnT = el('span', { class: 'hd-dim' });
  ui.dn = el('span', { class: 'chip', title: 'Time of day' }, [ui.dnG, ui.dnT]);
  ui.gold = el('span', { class: 'chip hd-gold', title: 'Gold' });
  ui.wep = el('span', { class: 'chip' }); ui.wepN = el('b', { style: { fontWeight: 600 } }); ui.wep.append(ui.wepN);
  ui.def = el('span', { class: 'chip', title: 'Defense' });
  ui.dexN = el('span');
  ui.dex = el('span', { class: 'chip hd-dex', title: 'Bestiary' }, [el('span', { class: 'hd-wide' }, 'Bestiary '), el('span', { class: 'hd-narrow' }, '\u{1F43E} '), ui.dexN]);
  ui.stat = el('span', { style: { display: 'contents' } });
  ui.statChips = {};
  const chips = el('div', { class: 'hd-chips' }, [ui.zone, ui.gold, ui.wep, ui.def, ui.dn, ui.dex, ui.stat]);

  const main = el('div', { class: 'hd-main' }, [el('div', { class: 'hd-r1' }, [ui.lv, el('div', { class: 'hd-bars' }, [ui.hp, ui.mp])]), ui.xp, chips]);

  ui.mapCv = el('canvas', { width: MAP_N * MAP_PX, height: MAP_N * MAP_PX });
  ui.mapNote = el('span', { class: 'hd-n' });
  ui.map = el('div', { class: 'hd-map', title: 'Map (tap to enlarge)' }, [ui.mapCv, ui.mapNote]);
  tap(ui.map, () => { mapBig = !mapBig; ui.map.classList.toggle('big', mapBig); });
  try { mapCtx = ui.mapCv.getContext('2d'); mapImg = null; if (mapCtx) mapCtx.imageSmoothingEnabled = false; } catch (e) { mapCtx = null; }

  host.replaceChildren(el('div', { class: 'hd-wrap' }, [main, el('div', { class: 'hd-slot' }, [ui.map])]));
}

function buildLog() {
  const host = $('log'); if (!host) return;
  ui.log = host;
  ui.logBox = el('div', { class: 'hl-box' });
  const toggleLog = () => { logOpen = !logOpen; last.logSig = null; renderLog(); };
  tap(ui.logBox, toggleLog);
  // Collapsed, the box lets taps fall through to the world; this small tab is the only collapsed hit target.
  ui.logTab = el('div', { class: 'hl-tab', role: 'button', 'aria-label': 'Open message log' }, 'LOG');
  tap(ui.logTab, toggleLog);
  host.replaceChildren(ui.logBox, ui.logTab);
}

function buildHotbar() {
  const host = $('hotbar'); if (!host) return;
  ui.hotbar = host;
  ui.gems = el('div', { class: 'hb-gems' });
  ui.gemNodes = [];
  const mk = (cls, icon, label, fn, extra = {}) => {
    const b = el('button', { class: 'btn hb-b ' + cls, type: 'button', ...extra }, [el('span', { class: 'hb-i' }, icon), el('span', { class: 'hb-t' }, label)]);
    tap(b, () => { try { fn(); } catch (e) { console.error('[hud.btn]', e); } });
    return b;
  };
  ui.bGear = mk('gear', '⚔', 'Gear', () => openGear(), { title: 'Gear (G)' });
  ui.bJournal = mk('journal', '\u{1F4D6}', 'Journal', () => openJournal(), { title: 'Journal (J)' });
  ui.bCamp = mk('camp', '♨', 'Camp', campAction, { title: 'Make camp / rest (K / R)' });
  ui.bCampI = ui.bCamp.firstChild; ui.bCampT = ui.bCamp.lastChild;
  ui.bMenu = mk('menu', '☰', 'Menu', () => openMenu(), { title: 'Menu (M)' });
  ui.bDex = mk('dex', '\u{1F43E}', 'Beasts', () => openBestiary(), { title: 'Bestiary (B)' });
  ui.btns = el('div', { class: 'hb-btns' }, [ui.bGear, ui.bJournal, ui.bCamp, ui.bDex, ui.bMenu]);
  host.replaceChildren(ui.gems, ui.btns);
}

function buildBanner() {
  const host = $('banner'); if (!host) return;
  ui.banner = host;
  ui.bnName = el('div', { class: 'hb-zn' });
  ui.bnSub = el('div', { class: 'hb-zs' });
  ui.bnBox = el('div', { class: 'hb-z' }, [ui.bnName, ui.bnSub]);
  host.replaceChildren(ui.bnBox);
}

// =====================================================================================================================
// Actions
// =====================================================================================================================

function campNear() {
  const P = G.P, c = P && P.camp;
  return !!c && !G.dg && Math.abs(c.x - P.x) <= 2 && Math.abs(c.y - P.y) <= 2;
}

function campAction() {
  if (!G.P || G.over) return;
  if (campNear()) turn.startAuto({ kind: 'rest' }); else turn.makeCamp();
}

/** Tap a spell gem: self spells fire at once, enemy spells at the nearest valid target. */
function castGem(id) {
  if (!G.P || G.over) return;
  const sp = spells.SPELLS[id]; if (!sp) return;
  let target;
  if (sp.target === 'enemy') target = (spells.spellTargets(id) || [])[0];
  const why = spells.castBlock(id, target);
  if (why) { say(why, 'sys'); return; }
  if (spells.castSpell(id, target)) turn.endTurn();
}

// =====================================================================================================================
// Refresh
// =====================================================================================================================

/** Idempotent: update only what changed. Never throws. */
export function refreshHud() {
  if (!built) return;
  try {
    const hidden = titleVisible() || !G.P;
    const v = hidden ? 'hidden' : '';
    for (const k of ['hud', 'log', 'hotbar', 'banner']) if (ui[k] && last['vis' + k] !== v) { last['vis' + k] = v; ui[k].style.visibility = v; }
    if (hidden) return;
    refreshTop(); renderLog(); refreshHotbar(); fitLog();
    if (mapDirty) { mapDirty = false; drawMap(); }
  } catch (e) { if (!refreshHud.warned) { refreshHud.warned = 1; console.error('[hud.refresh]', e); } }
}

function refreshTop() {
  const P = G.P;
  const hp = Math.max(0, Math.round(num(P.hp))), mx = Math.max(1, Math.round(num(P.max)));
  setText(ui.hpTxt, 'hpT', `HP ${hp}/${mx}`);
  setStyle(ui.hpFill, 'hpW', 'width', Math.round(Math.max(0, Math.min(1, hp / mx)) * 100) + '%');
  setClass(ui.hp, 'hpC', 'bar hp' + (hp / mx <= .25 ? ' low' : ''));
  if (hp / mx <= .25) setStyle(ui.hpTxt, 'hpCol', 'color', '#ffd0d6'); else setStyle(ui.hpTxt, 'hpCol', 'color', '');

  const mpMax = Math.round(num(P.mpMax));
  show(ui.mp, 'mpShow', mpMax > 0, '');
  if (mpMax > 0) {
    const mp = Math.max(0, Math.round(num(P.mp)));
    setText(ui.mpTxt, 'mpT', `MP ${mp}/${mpMax}`);
    setStyle(ui.mpFill, 'mpW', 'width', Math.round(Math.max(0, Math.min(1, mp / mpMax)) * 100) + '%');
  }

  setText(ui.lvNum, 'lv', Math.max(1, Math.round(num(P.lvl)) || 1));
  const next = Math.max(1, num(P.next) || 1);
  setStyle(ui.xpFill, 'xpW', 'width', Math.round(Math.max(0, Math.min(1, num(P.xp) / next)) * 100) + '%');
  setAttr(ui.xp, 'xpT', 'title', `Experience ${Math.round(num(P.xp))}/${Math.round(next)}`);

  setText(ui.gold, 'gold', Math.round(num(P.gold)));
  const w = P.wep || {};
  setText(ui.wepN, 'wepN', w.name || 'Bare Hands');
  setClass(ui.wepN, 'wepQ', 'q-' + (w.q || 'Plain'));
  setAttr(ui.wep, 'wepT', 'title', w.min != null ? `Weapon: ${w.min}-${w.max} damage` : 'Weapon');
  let def = 0; try { def = loot.defense(); } catch (e) { /* mid-reset */ }
  setText(ui.def, 'def', `DEF ${num(def)}`);

  // zone + distance + danger
  let z = null, dist = 0, inPyr = !!G.dg;
  try { z = world.zoneAt(P.x, P.y); dist = world.dist0(); } catch (e) { /* mid-reset */ }
  if (z) {
    setText(ui.zoneName, 'zn', inPyr ? (world.locName() || z.name) : z.name);
    setText(ui.zoneDistN, 'zd', inPyr ? '' : ` · ${dist}`);
    show(ui.zoneDistL, 'zdl', !inPyr, '');
    paintSkulls(ui.skulls, 'sk', z.danger);
    show(ui.zone, 'zoneShow', true, '');
  }

  // day / night
  let ph = null; try { ph = dayInfo(num(G.turn)).phase; } catch (e) { /* ignore */ }
  const pd = PHASE[ph] || PHASE.day;
  if (G.dg) { setText(ui.dnG, 'dnG', '\u2668'); setStyle(ui.dnG, 'dnC', 'color', '#ffd23f'); setText(ui.dnT, 'dnT', ''); setAttr(ui.dn, 'dnTi', 'title', 'Torchlight'); }
  else { setText(ui.dnG, 'dnG', pd.g); setStyle(ui.dnG, 'dnC', 'color', pd.c); setText(ui.dnT, 'dnT', pd.t); setAttr(ui.dn, 'dnTi', 'title', 'Time of day: ' + pd.t); }

  setText(ui.dexN, 'dex', `${(G.dex && G.dex.size) || 0}/${BESTIARY_TOTAL}`);

  // status chips
  const b = P.buffs || {};
  const st = [
    ['poison', P.poison > 0, 'Poisoned'], ['haste', b.haste > 0, 'Haste'], ['feign', b.feign > 0, 'Feigning'],
    ['insured', !!P.insured, 'Insured'], ['slowed', P.slowed > 0, 'Slowed'], ['camp', !!P.camp && !G.dg, campNear() ? 'Camp (near)' : 'Camp'],
  ];
  for (const [k, active, label] of st) {
    let c = ui.statChips[k];
    if (active && !c) { c = ui.statChips[k] = el('span', { class: 'chip hd-st ' + k }, label); ui.stat.append(c); }
    if (c) { show(c, 'st' + k, active, ''); if (active) setText(c, 'stl' + k, label); }
  }
}

function paintSkulls(node, key, n) {
  n = Math.max(1, Math.min(5, Math.round(num(n)) || 1));
  if (last[key] === n) return; last[key] = n;
  node.setAttribute('title', `Danger ${n}/5`);
  Array.prototype.forEach.call(node.children, (c, i) => c.className = i < n ? 'on' : '');
}

// ---- message log -----------------------------------------------------------------------------------------------

function renderLog() {
  if (!ui.logBox) return;
  const lg = G.log || [], n = logOpen ? LOG_LONG : (innerHeight <= 500 ? 1 : innerWidth < 500 ? 3 : LOG_SHORT);   // phones: the world needs the room
  const sig = (lg[0] || 0) + '|' + lg.length + '|' + logOpen + '|' + n;       // object identity of the newest entry + length
  const key = lg[0] ? lg[0].turn + ':' + lg[0].msg : '';
  if (last.logSig === sig && last.logKey === key) return;
  last.logSig = sig; last.logKey = key;
  const rows = lg.slice(0, n).reverse();                             // oldest first, newest at the bottom
  const kids = rows.map((l, i) => {
    const age = rows.length - 1 - i;                                 // 0 = newest
    const d = el('div', { class: 'hl-l' + (l.cls === 'zone' ? ' zone' : '') });
    d.textContent = String(l.msg == null ? '' : l.msg);
    d.style.color = LOG_COL[l.cls] || LOG_COL[''];
    d.style.opacity = logOpen ? (age < 6 ? 1 : .85) : String(Math.max(.28, 1 - age * .17).toFixed(2));
    return d;
  });
  ui.logBox.className = 'hl-box' + (logOpen ? ' open' : '');
  if (ui.logTab) ui.logTab.style.display = logOpen ? 'none' : '';
  ui.logBox.replaceChildren(...kids);
  if (logOpen) { ui.logBox.append(el('div', { class: 'hl-hint' }, 'TAP TO CLOSE')); ui.logBox.scrollTop = ui.logBox.scrollHeight; }
}

/** Keep the log sitting just above the hotbar however tall the hotbar is (gems row present or not). */
function fitLog() {
  if (!ui.log || !ui.hotbar) return;
  const h = ui.hotbar.offsetHeight || 0;
  const v = `${h + 4}px`;
  if (last.logB !== v) { last.logB = v; ui.log.style.bottom = v; }
}

// ---- hotbar --------------------------------------------------------------------------------------------------------

function refreshHotbar() {
  const P = G.P, ids = (P.spells || []).slice(0, 4);
  // (re)build gems only when the memorised list changes
  const sig = ids.join(',');
  if (last.gemSig !== sig) {
    last.gemSig = sig; ui.gemNodes = [];
    const kids = ids.map((id, i) => {
      const sp = spells.SPELLS[id]; if (!sp) return null;
      const cost = el('span', { class: 'hb-c' }, String(sp.cost));
      const g = el('button', { class: 'hb-gem ' + (sp.target === 'enemy' ? 'enemy' : 'self'), type: 'button', 'aria-label': sp.name },
        [String(sp.name || '?').trim().charAt(0).toUpperCase(), cost, el('span', { class: 'hb-k' }, String(i + 1))]);
      tap(g, () => { try { castGem(id); } catch (e) { console.error('[hud.cast]', e); } });
      ui.gemNodes.push({ id, node: g, cost: sp.cost, sp });
      return g;
    }).filter(Boolean);
    ui.gems.replaceChildren(...kids);
    ui.gems.style.display = kids.length ? '' : 'none';
    last.gemState = null;
  }
  // dim gems that cannot be cast right now
  const mp = num(P.mp);
  let st = '';
  for (const g of ui.gemNodes) {
    let off = mp < g.cost;
    if (!off) { try { off = !!spells.castBlock(g.id, g.sp.target === 'enemy' ? (spells.spellTargets(g.id) || [])[0] : undefined); } catch (e) { off = true; } }
    g.off = off; st += off ? '1' : '0';
  }
  if (last.gemState !== st) {
    last.gemState = st;
    for (const g of ui.gemNodes) {
      g.node.classList.toggle('off', g.off);
      g.node.setAttribute('title', `${g.sp.name} — ${g.cost} MP\n${g.sp.desc || ''}`);
    }
  }
  // camp / rest
  const near = campNear();
  setText(ui.bCampT, 'campT', near ? 'Rest' : 'Camp');
  setText(ui.bCampI, 'campI', near ? '☾' : '♨');
  setAttr(ui.bCamp, 'campTi', 'title', near ? 'Rest by the fire (R)' : (P.camp && !G.dg ? 'Make a new camp here (K)' : 'Make camp (K)'));
}

// ---- zone banner --------------------------------------------------------------------------------------------------

function showBanner(zone) {
  if (!ui.bnBox || !zone || titleVisible()) return;
  clearTimeout(bannerFade); clearTimeout(bannerHide);
  ui.bnName.textContent = String(zone.name || '');
  const dist = (() => { try { return world.dist0(); } catch (e) { return 0; } })();
  const n = Math.max(1, Math.min(5, Math.round(num(zone.danger)) || 1));
  ui.bnSub.replaceChildren(
    document.createTextNode(G.dg ? (world.dgType() && world.dgType().id !== 'pyramid' ? world.dgType().name : 'Pyramid') : `${dist} from home`), document.createTextNode('  ·  danger  '),
    el('span', { class: 'hd-sk' }, [0, 1, 2, 3, 4].map(i => el('i', { class: i < n ? 'on' : '' }, '☠'))));
  ui.bnBox.classList.remove('in'); void ui.bnBox.offsetWidth;          // restart the transition on rapid zone changes
  ui.bnBox.classList.add('in');
  bannerFade = setTimeout(() => ui.bnBox.classList.remove('in'), BANNER_MS - 650);
  bannerHide = setTimeout(() => { ui.bnName.textContent = ''; }, BANNER_MS + 100);
}

// ---- minimap ---------------------------------------------------------------------------------------------------------

function colorOf(key) {
  let c = colorCache.get(key);
  if (c) return c;
  const t = TERRAIN[key];
  const hex = t && t.color ? t.color : '#000000';
  const m = /^#([0-9a-f]{6})$/i.exec(hex) || [];
  const v = m[1] ? parseInt(m[1], 16) : 0;
  c = { r: v >> 16 & 255, g: v >> 8 & 255, b: v & 255, css: hex };
  colorCache.set(key, c);
  return c;
}

/** Paint the minimap: MAP_N x MAP_N tiles around the hero in the hero's unwrapped frame (<= 2209 fillRects). */
function drawMap() {
  const ctx = mapCtx, P = G.P; if (!ctx || !P) return;
  const px = P.x, py = P.y, S = MAP_PX;
  ctx.fillStyle = '#0a0716'; ctx.fillRect(0, 0, MAP_N * S, MAP_N * S);
  const pyr = !!G.dg;
  for (let j = 0; j < MAP_N; j++) {
    const y = py - MAP_R + j;
    for (let i = 0; i < MAP_N; i++) {
      const x = px - MAP_R + i;
      let seen = false; try { seen = world.isSeen(x, y); } catch (e) { /* out of range */ }
      if (!seen) continue;
      const k = world.terrKey(x, y);
      if (k === 'void') continue;
      const c = colorOf(k);
      // dim what is remembered but not in sight, so the lit pocket around the hero stands out
      const lit = world.isVis(x, y);
      ctx.fillStyle = lit ? c.css : `rgb(${c.r * .62 | 0},${c.g * .62 | 0},${c.b * .66 | 0})`;
      ctx.fillRect(i * S, j * S, S, S);
    }
  }
  // home marker (nearest wrapped image), overworld only
  if (!pyr && G.home) {
    const torusDelta = d => ((d + WS / 2) % WS + WS) % WS - WS / 2;      // signed offset to the nearest wrapped image
    const hx = torusDelta(G.home.x - px), hy = torusDelta(G.home.y - py);
    if (Math.abs(hx) <= MAP_R && Math.abs(hy) <= MAP_R) {
      const cx = (hx + MAP_R) * S, cy = (hy + MAP_R) * S;
      ctx.fillStyle = '#120826'; ctx.fillRect(cx - 2, cy - 2, S + 4, S + 4);
      ctx.fillStyle = '#ff2fa0'; ctx.fillRect(cx - 1, cy - 1, S + 2, S + 2);
      ctx.fillStyle = '#fff'; ctx.fillRect(cx, cy, S, S);
    }
  }
  // NPCs
  for (const n of G.npcs || []) {
    const dx = n.x - px, dy = n.y - py;
    if (Math.abs(dx) > MAP_R || Math.abs(dy) > MAP_R) continue;
    ctx.fillStyle = '#120826'; ctx.fillRect((dx + MAP_R) * S - 1, (dy + MAP_R) * S - 1, S + 2, S + 2);
    ctx.fillStyle = '#ff9ec4'; ctx.fillRect((dx + MAP_R) * S, (dy + MAP_R) * S, S, S);
  }
  // hero: sun-yellow dot with a dark rim
  const hc = MAP_R * S;
  ctx.fillStyle = '#120826'; ctx.fillRect(hc - 2, hc - 2, S + 4, S + 4);
  ctx.fillStyle = '#ffd23f'; ctx.fillRect(hc - 1, hc - 1, S + 2, S + 2);
  setText(ui.mapNote, 'mapN', pyr ? `F${G.dg.i + 1}` : '');
}
