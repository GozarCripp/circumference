// main.js — boot order and the frame loop, and nothing else. All behaviour lives in the modules.
import { TIMING, VERSION } from './core/config.js';
import { G, resetState } from './core/state.js';
import { on, emit } from './core/bus.js';
import * as clock from './core/clock.js';
import * as util from './core/util.js';

// World, rendering and art
import * as world from './world/world.js';
import * as dungeon from './world/dungeon.js';
import * as assets from './art/assets.js';
import * as renderer from './render/renderer.js';
import * as lighting from './render/lighting.js';
import * as fx from './render/fx.js';

// Gameplay, systems and UI
import * as turn from './game/turn.js';
import * as combat from './game/combat.js';
import * as monsters from './game/monsters.js';
import * as loot from './game/loot.js';
import * as spells from './game/spells.js';
import * as quests from './game/quests.js';
import * as potions from './game/potions.js';
import * as life from './game/life.js';
import * as players from './game/players.js';
import * as net from './net/net.js';
import { showHang, hideHang } from './ui/hang.js';
import { initDirector } from './game/director.js';
import * as save from './game/save.js';
import * as input from './input/input.js';
import * as hud from './ui/hud.js';
import * as popup from './ui/popup.js';
import * as gear from './ui/gear.js';
import * as panels from './ui/panels.js';
import * as sfx from './audio/sfx.js';
import { showTitle, titleVisible } from './ui/title.js';
import { $, panelOpen } from './ui/dom.js';

// ---- dev aid: surface errors on screen (phones have no console) ---------------------------
function toast(msg) {
  const t = $('toast'); if (!t) return;
  t.textContent = String(msg).slice(0, 600); t.style.display = 'block';
  clearTimeout(toast.h); toast.h = setTimeout(() => { t.style.display = 'none'; }, 9000);
}
addEventListener('error', e => toast('Error: ' + (e.message || e.error) + (e.filename ? '\n' + e.filename.split('/').slice(-2).join('/') + ':' + e.lineno : '')));
addEventListener('unhandledrejection', e => toast('Error: ' + (e.reason && (e.reason.stack || e.reason.message) || e.reason)));

// ---- frame loop: render only when something changed or is animating ------------------------
let dirty = true, last = 0, lastWater = 0;
export const requestRender = () => { dirty = true; };
on('*', requestRender);                               // every game event invalidates the frame

function frame(now) {
  const dt = Math.min(100, now - last); last = now;
  try {
    fx.updateFx(dt);
    const waterTick = now - lastWater >= TIMING.water;   // water + torch flicker animate at ~4 fps even when idle
    if (dirty || waterTick || renderer.isAnimating() || fx.fxActive()) {
      if (waterTick) lastWater = now;
      dirty = false;
      renderer.render(now);
    }
  } catch (e) { console.error(e); toast('Render error: ' + (e.stack || e)); }
  requestAnimationFrame(frame);
}

// ---- boot ------------------------------------------------------------------------------------
async function boot() {
  showHang('Waking the planet up...');                 // the global loading screen
  resetState();                                        // G exists before any module touches it
  await assets.initAssets();                           // generators registered, manifest read (never blocks on PNGs)
  renderer.initRenderer($('world'));
  lighting.initLighting();
  fx.initFx();
  sfx.initSfx();
  hud.initHud();
  popup.initPopup();
  gear.initGear();
  panels.initPanels();
  spells.initSpells();
  quests.initQuests();
  dungeon.initDungeons();
  potions.initPotions();
  life.initLife();
  initDirector();
  save.initSave();                                     // autosave on 'turn', wipe on 'death', save on tab hide
  input.initInput($('world'));

  const resumed = save.loadGame();                     // true if a saved life was restored (emits 'loaded')
  if (!resumed) turn.newGame();                        // emits 'newgame' (and adopts the hero as the room's local player)
  else players.adopt();                                // a loaded life becomes the room's local player                        // emits 'newgame'

  addEventListener('resize', () => { renderer.resize(); requestRender(); });
  addEventListener('orientationchange', () => setTimeout(() => { renderer.resize(); requestRender(); }, 60));
  renderer.resize();
  requestAnimationFrame(frame);

  // LIVE: the world turns on its own. It holds while the title or a modal panel (gear, journal, menu) is up,
  // and pauses when the tab is hidden (solo only; multiplayer will never pause).
  // In a MULTIPLAYER room nothing holds or pauses the world; net.tick runs it on the host and mirrors it on clients.
  clock.startClock(net.tick, TIMING.tick, () => !G.room && (titleVisible() || panelOpen()));
  net.initNet();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && !G.room && !clock.isPaused()) { clock.setPaused(true); emit('pause', { paused: true, auto: true }); }
  });

  hideHang();                                          // the title is next (a room link joins once it is dismissed)
  await showTitle({ resume: resumed });                // the game is already live underneath, as in classic
  emit('start', { resumed });                          // first user gesture: sfx unlocks audio here
  try { emit('zone', { zone: world.zoneAt(G.P.x, G.P.y) }); } catch (e) { /* the banner is a courtesy */ }
}

// Debug / QA handle (Playwright tests and curious players): window.circ.G, window.circ.turn.step(1,0) …
window.circ = { VERSION, G, util, on, emit, clock, players, net, world, dungeon, assets, renderer, lighting, fx, turn, combat, monsters, loot, spells, quests, save, input, hud, popup, gear, panels, sfx, requestRender };

boot().catch(e => { console.error(e); toast('Boot failed: ' + (e.stack || e)); });
