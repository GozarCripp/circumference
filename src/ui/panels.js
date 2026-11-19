// ui/panels.js — Bestiary, Journal (quests + spellbook), Menu / How to play, NPC dialog and the death screen.
// All hosted in #panel through ui/dom.js showPanel().
import { G, saveOpts } from '../core/state.js';
import { on, emit } from '../core/bus.js';
import { BIOMES, BESTIARY_TOTAL } from '../core/config.js';
import { esc, el, css, tap, showPanel, hidePanel, panelOpen as domPanelOpen } from './dom.js';
import { BEAST, SHARKS, RARES, AIDESC } from '../data/bestiary.js';
import { UNINSURED, EPITAPHS } from '../data/flavor.js';
import { iconURL } from '../art/assets.js';
import { pick } from '../core/util.js';
import * as quests from '../game/quests.js';
import * as life from '../game/life.js';
import * as spells from '../game/spells.js';
import * as save from '../game/save.js';
import * as turn from '../game/turn.js';
import * as verbs from '../game/verbs.js';
import * as net from '../net/net.js';
import * as sfx from '../audio/sfx.js';
import * as renderer from '../render/renderer.js';
import * as world from '../world/world.js';

let inited = false;
let locked = false;          // the death screen cannot be dismissed except by its button
let cssDone = false;

const guard = (tag, fn) => { try { return fn(); } catch (e) { console.error('[panels.' + tag + ']', e); return undefined; } };

// ---------------------------------------------------------------------------------------------------------------------
// styles (prefixed .pn-)
// ---------------------------------------------------------------------------------------------------------------------
function injectCss() {
  if (cssDone) return; cssDone = true;
  css('panels', `
#panel .pn { display: flex; flex-direction: column; gap: 10px; padding-bottom: calc(14px + var(--safe-b)); }
#panel .pn-top { position: sticky; top: -14px; z-index: 2; display: flex; align-items: center; gap: 10px; margin: -14px -14px 0; padding: 12px 14px 8px;
  background: linear-gradient(180deg, rgba(45,20,88,1) 70%, rgba(45,20,88,0)); }
#panel .pn-top .h { flex: 1; font-size: 22px; line-height: 1.1; }
#panel .pn-x { flex: none; width: 44px; height: 44px; min-height: 44px; padding: 0; font-size: 20px; line-height: 1; }
#panel .pn-counts { display: flex; flex-wrap: wrap; gap: 6px; }
#panel .pn-counts .chip { font-family: var(--f-display); font-size: 13px; padding: 4px 10px; }
#panel .pn-sec { font-family: var(--f-display); color: var(--sun); font-size: 15px; margin: 8px 0 -2px; text-shadow: 0 2px 0 var(--ink); }
#panel .pn-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 8px; }
#panel .pn-card { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 8px 6px; text-align: center; border-radius: 10px;
  background: rgba(18, 8, 38, .7); border: 1px solid rgba(143, 211, 255, .3); min-height: 104px; }
#panel .pn-card.met { border-color: rgba(143, 211, 255, .65); }
#panel .pn-card.rare.met { border-color: var(--sun); box-shadow: 0 0 8px rgba(255, 210, 63, .35); }
#panel .pn-card img { width: 40px; height: 40px; object-fit: contain; image-rendering: pixelated; }
#panel .pn-card img.sil { filter: brightness(0) opacity(.75); }
#panel .pn-card .nm { font-size: 11px; line-height: 1.2; word-break: break-word; }
#panel .pn-card .ai { font-size: 10px; line-height: 1.2; color: var(--dim); }
#panel .pn-card.unmet .nm { color: var(--dim); font-family: var(--f-display); font-size: 14px; }
#panel .pn-tabs { display: flex; gap: 8px; }
#panel .pn-tabs .btn { flex: 1; }
#panel .pn-tabs .btn.on { background: linear-gradient(180deg, #ff9a3d, #ff6a1a); border-color: var(--white); }
#panel .pn-row { padding: 10px 12px; border-radius: 10px; background: rgba(18, 8, 38, .7); border: 1px solid rgba(143, 211, 255, .3); display: flex; flex-direction: column; gap: 4px; }
#panel .pn-row.ready { border-color: var(--good); box-shadow: 0 0 10px rgba(125, 255, 138, .35); }
#panel .pn-row.done { opacity: .55; }
#panel .pn-row .t { font-family: var(--f-display); font-size: 16px; color: var(--white); }
#panel .pn-row .g { font-size: 12px; color: var(--dim); }
#panel .pn-row .s { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
#panel .pn-prog { height: 8px; border-radius: 4px; background: #0b0518; overflow: hidden; border: 1px solid var(--ink); }
#panel .pn-prog > i { display: block; height: 100%; background: linear-gradient(180deg, #fff3a0, var(--xp)); }
#panel .pn-empty { font-family: var(--f-flavor); font-size: 1.15em; color: var(--blue); text-align: center; padding: 18px 8px; }
#panel .pn-mp { display: flex; align-items: center; gap: 8px; }
#panel .pn-mp .bar { flex: 1; }
#panel .pn-menu { display: flex; flex-direction: column; gap: 10px; }
#panel .pn-menu .btn, #panel .pn-menu a.btn { min-height: 48px; text-align: center; text-decoration: none; display: flex; align-items: center; justify-content: center; }
#panel .pn-pair { display: flex; gap: 8px; align-items: center; }
#panel .pn-pair .lbl { flex: 1; font-family: var(--f-display); }
#panel .pn-pair .btn { width: 52px; flex: none; }
#panel .pn-how { font-size: 14px; line-height: 1.45; }
#panel .pn-how ul { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 4px; }
#panel .pn-how b { color: var(--sun); font-family: var(--f-display); font-weight: 400; }
#panel .pn-speech { font-family: var(--f-flavor); font-size: 1.35em; line-height: 1.35; color: var(--blue); padding: 6px 2px 10px; }
#panel .pn-acts { display: flex; flex-direction: column; gap: 8px; }
#panel .pn-acts .btn { min-height: 48px; width: 100%; text-align: center; }
#panel .pn-death { align-items: stretch; text-align: center; font-family: var(--f-flavor); gap: 12px; padding: 12px 4px calc(10px + var(--safe-b)); }
#panel .pn-death h2 { font-family: var(--f-display); font-weight: 400; font-size: 44px; margin: 4px 0 0; color: var(--bad); text-shadow: 0 3px 0 #000, 0 0 18px rgba(255, 93, 108, .6); }
#panel .pn-death p { margin: 0; font-size: 1.3em; line-height: 1.3; }
#panel .pn-death .stats { font-family: var(--f-display); font-size: 15px; color: var(--white); letter-spacing: .3px; line-height: 1.5; }
#panel .pn-death .verdict { color: var(--sun); }
#panel .pn-death .epi { color: var(--dim); font-style: italic; }
#panel .pn-death .btn { min-height: 54px; font-size: 19px; margin-top: 6px; }
`);
}

// ---------------------------------------------------------------------------------------------------------------------
// shared bits
// ---------------------------------------------------------------------------------------------------------------------
/** Panel shell: sticky title row with a 44px close button, then content. */
function shell(title, kids, opts = {}) {
  const top = el('div', { class: 'pn-top' }, [
    el('h2', { class: 'h' }, title),
  ]);
  if (opts.onClose !== null) {
    const x = el('button', { class: 'btn ghost pn-x', 'aria-label': 'Close', type: 'button' }, '✕');
    tap(x, opts.onClose || closePanels);
    top.append(x);
  }
  return el('div', { class: 'panel pn' + (opts.cls ? ' ' + opts.cls : '') }, [top, ...kids]);
}
function button(label, fn, cls = '') {
  const b = el('button', { class: 'btn ' + cls, type: 'button' }, label);
  tap(b, fn);
  return b;
}
function show(node) { injectCss(); locked = false; showPanel(node); const p = document.getElementById('panel'); if (p) p.scrollTop = 0; }
/** Replace the panel's content but keep the scroll position of its scroller (re-renders after Forget etc). */
function reshow(node) {
  const old = document.querySelector('#panel > .panel'), y = old ? old.scrollTop : 0;
  showPanel(node);
  const next = document.querySelector('#panel > .panel'); if (next) next.scrollTop = y;
}
const ok = () => !!(G && G.P);

// ---------------------------------------------------------------------------------------------------------------------
// init / close
// ---------------------------------------------------------------------------------------------------------------------
export function initPanels() {
  if (inited) return; inited = true;
  injectCss();
  on('death', d => guard('death', () => showDeath(d && d.by, d && d.claim)));
  on('hail', d => guard('hail', () => openDialog(d && d.npc)));
  // MULTIPLAYER client: the host answers a dialog choice with the next page
  on('dialog', d => guard('dialog', () => { if (!verbs.isRemote() || !d) return; if (d.model) renderDialog(d.npc, d.model, true); else hidePanel(); }));
  on('newgame', () => { locked = false; if (domPanelOpen()) hidePanel(); });
}

/** Close whatever is open. The death screen refuses: its only way out is "Be born again". */
export function closePanels() { if (locked) return; hidePanel(); }
export const panelOpen = () => domPanelOpen();

// ---------------------------------------------------------------------------------------------------------------------
// Bestiary
// ---------------------------------------------------------------------------------------------------------------------
function beastCard(e, met, rare) {
  const cls = 'pn-card ' + (met ? 'met' : 'unmet') + (rare ? ' rare' : '');
  if (!met) {
    return el('div', { class: cls }, [
      el('img', { class: 'sil', src: guard('icon', () => iconURL('enemy/' + e.id)) || '', alt: '' }),
      el('div', { class: 'nm' }, '???'),
    ]);
  }
  return el('div', { class: cls }, [
    el('img', { src: guard('icon', () => iconURL('enemy/' + e.id)) || '', alt: '' }),
    el('div', { class: 'nm', style: rare ? { color: 'var(--sun)' } : {} }, (rare ? '★ ' : '') + e.name),
    el('div', { class: 'ai' }, AIDESC[e.ai] || ''),
  ]);
}

export function openBestiary() {
  guard('openBestiary', () => {
    if (!ok()) return;
    const dex = G.dex || new Set();
    const metRares = RARES.filter(r => dex.has(r.name)).length;
    const kids = [el('div', { class: 'pn-counts' }, [
      el('span', { class: 'chip' }, `Bestiary ${Math.min(dex.size, BESTIARY_TOTAL)}/${BESTIARY_TOTAL}`),
      el('span', { class: 'chip', style: { borderColor: 'var(--sun)' } }, `Named ${metRares}/${RARES.length}`),
    ])];
    BEAST.forEach((list, b) => {
      kids.push(el('div', { class: 'pn-sec' }, `${BIOMES[b] || 'Biome ' + b} · ${list.filter(e => dex.has(e.name)).length}/${list.length}`));
      kids.push(el('div', { class: 'pn-grid' }, list.map(e => beastCard(e, dex.has(e.name), false))));
    });
    kids.push(el('div', { class: 'pn-sec' }, `Deep water · ${SHARKS.filter(e => dex.has(e.name)).length}/${SHARKS.length}`));
    kids.push(el('div', { class: 'pn-grid' }, SHARKS.map(e => beastCard(e, dex.has(e.name), false))));
    kids.push(el('div', { class: 'pn-sec' }, `Named · ${metRares}/${RARES.length}`));
    kids.push(el('div', { class: 'pn-grid' }, RARES.map(e => beastCard(e, dex.has(e.name), true))));
    show(shell('Bestiary', kids));
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------------------------------------------------
let jTab = 'quests';

function questRow(q, done) {
  const pct = q.n > 0 ? Math.max(0, Math.min(100, Math.round(100 * q.have / q.n))) : 0;
  const kids = [
    el('div', { class: 's' }, [
      el('span', { class: 't' }, q.title),
      done ? el('span', { class: 'chip' }, 'Filed') : el('span', { class: 'chip num', style: q.ready ? { borderColor: 'var(--good)', color: 'var(--good)' } : {} },
        q.ready ? 'Ready' : `${Math.min(q.have, q.n)}/${q.n}`),
    ]),
    el('div', { class: 'g' }, q.giver || ''),
  ];
  if (!done) kids.push(el('div', { class: 'pn-prog' }, el('i', { style: { width: pct + '%' } })));
  if (q.text) kids.push(el('div', { class: 'flavor', style: { fontSize: '1.05em' } }, q.text));
  return el('div', { class: 'pn-row' + (done ? ' done' : q.ready ? ' ready' : '') }, kids);
}

function journalBody() {
  const P = G.P, kids = [];
  if (jTab === 'quests') {
    const log = quests.questLog() || { active: [], done: [] };
    if (!log.active.length && !log.done.length) {
      kids.push(el('div', { class: 'pn-empty' }, 'Nobody has asked anything of you. This is the most respect you will receive all week.'));
    }
    if (log.active.length) {
      kids.push(el('div', { class: 'pn-sec' }, 'Active'));
      log.active.forEach(q => kids.push(questRow(q, false)));
    } else if (log.done.length) {
      kids.push(el('div', { class: 'pn-empty' }, 'Nothing outstanding. Enjoy it; it is the shape of the thing right before more paperwork.'));
    }
    if (log.done.length) {
      kids.push(el('div', { class: 'pn-sec' }, 'Completed'));
      log.done.forEach(q => kids.push(questRow(q, true)));
    }
  } else {
    const mpMax = P.mpMax || 0;
    kids.push(el('div', { class: 'pn-mp' }, [
      el('span', { class: 'chip num' }, `MP ${Math.round(P.mp || 0)}/${mpMax}`),
      el('div', { class: 'bar mp' }, el('i', { style: { width: (mpMax ? Math.max(0, Math.min(100, 100 * P.mp / mpMax)) : 0) + '%' } })),
      el('span', { class: 'chip' }, `${(P.spells || []).length}/${spells.MAX_SPELLS || 4} gems`),
    ]));
    const known = (P.spells || []).map(id => spells.SPELLS[id]).filter(Boolean);
    if (!known.length) {
      kids.push(el('div', { class: 'pn-empty' }, 'Your spellbook is empty, like your calendar after the reorg. Scrolls turn up in loot. Reading them is, regrettably, up to you.'));
    }
    known.forEach(sp => {
      const forget = button('Forget', () => { guard('forget', () => verbs.run('forget', sp.id)); renderJournal(true); }, 'small danger');
      kids.push(el('div', { class: 'pn-row' }, [
        el('div', { class: 's' }, [el('span', { class: 't' }, sp.name), el('span', { class: 'chip num' }, sp.cost + ' MP')]),
        el('div', { class: 'flavor', style: { fontSize: '1.05em' } }, sp.desc),
        el('div', { class: 's' }, [el('span', { class: 'g' }, sp.target === 'enemy' ? `Target: enemy, range ${sp.range || 6}` : 'Target: self'), forget]),
      ]));
    });
  }
  return kids;
}

function renderJournal(keepScroll) {
  guard('renderJournal', () => {
    if (!ok()) return;
    const tabs = el('div', { class: 'pn-tabs' }, [
      button('Quests', () => { jTab = 'quests'; renderJournal(); }, 'small' + (jTab === 'quests' ? ' on' : '')),
      button('Spellbook', () => { jTab = 'spells'; renderJournal(); }, 'small' + (jTab === 'spells' ? ' on' : '')),
    ]);
    const node = shell('Journal', [tabs, ...journalBody()]);
    injectCss();
    if (keepScroll) reshow(node); else show(node);
  });
}
export function openJournal() { renderJournal(false); }

// ---------------------------------------------------------------------------------------------------------------------
// Menu and How to play
// ---------------------------------------------------------------------------------------------------------------------
export function openMenu() {
  guard('openMenu', () => {
    if (!G.opts) G.opts = { muted: false, zoom: 0 };
    const soundBtn = button('', () => {
      guard('sound', () => { sfx.setMuted(!G.opts.muted); G.opts.muted = !!G.opts.muted; emit('opts', {}); });
      soundBtn.textContent = soundLabel();
    });
    const soundLabel = () => 'Sound: ' + (G.opts.muted ? 'off' : 'on');
    soundBtn.textContent = soundLabel();
    const dblLabel = () => 'Double-tap: ' + (G.opts.dbl === 'all' ? 'confirm all' : 'ask for danger');
    const dblBtn = button('', () => {
      guard('dbl', () => { G.opts.dbl = G.opts.dbl === 'all' ? 'danger' : 'all'; saveOpts(); });
      dblBtn.textContent = dblLabel();
    });
    dblBtn.textContent = dblLabel();
    const zoomLbl = el('span', { class: 'lbl' }, 'Zoom ' + zoomText());
    const z = d => () => { guard('zoom', () => renderer.zoomBy(d)); zoomLbl.textContent = 'Zoom ' + zoomText(); };
    // a tap()-button, not a bare link: a link would also answer the stray click that trails the tap which opened this menu
    const classic = button('Play the original ASCII version', () => { guard('classic', () => { save.saveGame(); location.href = 'classic/index.html'; }); }, 'ghost');
    show(shell('Menu', [el('div', { class: 'pn-menu' }, [
      button('Resume', closePanels, 'primary'),
      button(G.room ? `Room ${G.room}` : 'Play together', openRoom),
      soundBtn,
      dblBtn,
      el('div', { class: 'pn-pair' }, [button('−', z(-1)), zoomLbl, button('+', z(1))]),
      button('How to play', openHowTo),
      classic,
      button('Give up', openGiveUp, 'danger'),
    ])]));
  });
}
// ---------------------------------------------------------------------------------------------------------------------
// Play together (MULTIPLAYER rooms)
// ---------------------------------------------------------------------------------------------------------------------
function openRoom() {
  guard('openRoom', () => {
    const nameIn = el('input', { class: 'pn-input', value: net.getName(), maxlength: '16', placeholder: 'Your name' });
    nameIn.addEventListener('change', () => net.setName(nameIn.value));
    const nameRow = el('label', { class: 'pn-field' }, [el('span', {}, 'Name'), nameIn]);
    if (!G.room) {
      const codeIn = el('input', { class: 'pn-input', maxlength: '8', placeholder: 'ROOM CODE', style: { textTransform: 'uppercase' } });
      show(shell('Play together', [
        el('div', { class: 'pn-empty' }, `Up to ${net.MAX_PLAYERS} heroes on one planet. No accounts, no installs: share a link or a code. Monsters multiply with company.`),
        nameRow,
        button('Host a room', () => { net.setName(nameIn.value); hidePanel(); net.hostRoom().then(() => openRoom()); }, 'primary'),
        el('label', { class: 'pn-field' }, [el('span', {}, 'Code'), codeIn]),
        button('Join a room', () => { net.setName(nameIn.value); if (!codeIn.value.trim()) return; hidePanel(); net.goToRoom(codeIn.value); }),
        button('Back', openMenu, 'ghost'),
      ], { onClose: openMenu }));
      return;
    }
    const link = net.shareLink();
    const copy = button('Copy invite link', () => {
      try { navigator.clipboard.writeText(link).then(() => { copy.textContent = 'Copied!'; }); } catch (e) { copy.textContent = link; }
    }, 'primary');
    const list = net.roomPlayers().map(p => el('div', { class: 'pn-empty', style: { padding: '2px 0' } },
      `${p.me ? '▶ ' : ''}${p.name || 'Someone'}${p.over ? ' (dead)' : p.collapsed ? ' (collapsed)' : ''}`));
    show(shell(`Room ${G.room}`, [
      el('div', { class: 'h', style: { fontSize: '34px', textAlign: 'center', letterSpacing: '6px' } }, G.room),
      el('div', { class: 'pn-empty' }, net.roomRole() === 'host' ? 'You are hosting: the planet runs in your browser. If you leave, someone else takes over.' : 'Connected. The host is keeping the planet spinning.'),
      copy,
      el('div', { class: 'pn-empty', style: { wordBreak: 'break-all', fontSize: '12px' } }, link),
      ...list,
      button('Leave room', () => { hidePanel(); net.exitRoom(); }, 'danger'),
      button('Back', openMenu, 'ghost'),
    ], { onClose: openMenu }));
  });
}

const zoomText = () => { const z = (G.opts && G.opts.zoom) || 0; return z > 0 ? '+' + z : String(z); };

function openHowTo() {
  show(shell('How to play', [
    el('div', { class: 'pn-how', html: `<ul>
      <li><b>Tap</b> anything to inspect it. A card appears with what you can do.</li>
      <li><b>Double-tap</b> to confirm: plain ground auto-walks, and anything else runs its main action (Attack, Hail, Chop, Pick up). In the Menu, "Double-tap" chooses whether risky ones (bosses, much tougher enemies, deep water, low health) still ask first.</li>
      <li><b>Keys:</b> WASD or arrows to move, Q E Z C for diagonals.</li>
      <li><b>1-4</b> cast your memorised spells. <b>G</b> gear, <b>J</b> journal, <b>B</b> bestiary, <b>R</b> rest, <b>K</b> make camp, <b>M</b> menu.</li>
      <li>The game is <b>strictly turn-based</b>. Nothing moves until you do. This is the only fair thing here.</li>
    </ul>` }),
    el('div', { class: 'pn-empty' }, 'Death is permanent. Insurance is available, which is not the same thing as coverage.'),
    el('div', { class: 'pn-empty', style: { paddingTop: 0 } }, 'The planet is round. Nobody checked. That is your job now.'),
    button('Back', openMenu, 'primary'),
  ], { onClose: openMenu }));
}

function openGiveUp() {
  show(shell('Give up?', [
    el('div', { class: 'pn-empty' }, 'This ends the current life, deletes the save, and starts a new one with no refund. The planet will not notice.'),
    el('div', { class: 'btn-row' }, [
      button('Keep going', openMenu, 'primary'),
      button('Yes, give up', () => {
        guard('giveUp', () => { if (G.room) emit('respawn', {}); else { save.wipeSave(); turn.newGame(); } });
        locked = false; hidePanel();
      }, 'danger'),
    ]),
  ], { onClose: openMenu }));
}

// ---------------------------------------------------------------------------------------------------------------------
// NPC dialog
// ---------------------------------------------------------------------------------------------------------------------
const npcHere = npc => !!npc && Array.isArray(G.npcs) && G.npcs.includes(npc);

export function openDialog(npc) {
  guard('openDialog', () => {
    if (!ok() || !npc || G.over) return;
    renderDialog(npc, (npc.amb && life.dialog(npc)) || quests.dialog(npc), false);
  });
}

function renderDialog(npc, model, keep) {
  if (!model) { hidePanel(); return; }
  if (!npcHere(npc)) { hidePanel(); return; }               // they wandered off (or the zone changed)
  const actions = (model.actions || []).slice();
  if (!actions.some(a => a.id === 'bye')) actions.push({ id: 'bye', label: 'Goodbye' });
  const btns = actions.map(a => button(a.label, () => {
    guard('choose', () => {
      if (a.id === 'bye') { hidePanel(); return; }
      const next = verbs.run('choose', npc, a.id);
      if (verbs.isRemote()) return;                                // the host answers with a 'dialog' event
      if (!next) { hidePanel(); return; }
      renderDialog(npc, next, true);
    });
  }, a.primary ? 'primary' : ''));
  const node = shell(model.name || npc.name || 'Stranger', [
    el('div', { class: 'pn-speech' }, model.text || '...'),
    el('div', { class: 'pn-acts' }, btns),
  ]);
  injectCss();
  if (keep) reshow(node); else show(node);
}

// ---------------------------------------------------------------------------------------------------------------------
// Death
// ---------------------------------------------------------------------------------------------------------------------
function placeName() {
  try {
    if (G.dg) return world.locName();
    const z = world.zoneAt && world.zoneAt(G.P.x, G.P.y);
    if (z && z.name) return z.name;
  } catch (e) { /* fall through */ }
  return 'wilderness';
}

export function showDeath(by, claim) {
  guard('showDeath', () => {
    if (!ok()) return;
    injectCss();
    const who = (by && by.name) || 'something unnamed';
    const col = (by && by.col) || 'var(--bad)';
    const P = G.P;
    const steps = guard('dist', () => world.dist0()) ?? 0;
    const verdict = claim && claim.text ? claim.text : UNINSURED;
    const born = button('Be born again', () => {
      locked = false; hidePanel();
      guard('reborn', () => { if (G.room) emit('respawn', {}); else { save.wipeSave(); turn.newGame(); } });
    }, 'primary');
    const node = el('div', { class: 'panel pn pn-death' }, [
      el('h2', {}, 'You died.'),
      el('p', { html: `Slain by <b style="color:${esc(col)}">${esc(who)}</b> in ${esc(placeName())}.` }),
      el('p', { class: 'stats' }, `Level ${P.lvl} · ${P.gold} gold · ${steps} steps from home · ${Math.min((G.dex && G.dex.size) || 0, BESTIARY_TOTAL)}/${BESTIARY_TOTAL} bestiary`),
      el('p', { class: 'verdict' }, verdict),
      el('p', { class: 'epi' }, pick(EPITAPHS)),
      born,
    ]);
    showPanel(node);
    locked = true;
  });
}
