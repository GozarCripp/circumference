// input/input.js — pointer (touch + mouse) and keyboard input.
//
//   tap            -> stop any auto-action, inspect the tile (popup)
//   double-tap     -> same tile within TIMING.dblTap: auto-walk there if turn.canAutoWalk, else run the open card's main
//                     action (popup.confirmPrimary; risky ones still wait unless Menu > Double-tap is 'confirm all')
//   drag > 10 px   -> pan the camera to peek (when the renderer exposes panBy / setPan)
//   pinch / wheel / + -  -> renderer.zoomBy(+-1)
//   keyboard       -> screen-relative WASD/arrows, QEZC, wait, spell gems 1-4, G J B R K M, Esc
//
// No top-level side effects: everything happens inside initInput(), which is idempotent.
import { G, say } from '../core/state.js';
import { TIMING } from '../core/config.js';
import { KEY_DIRS } from '../render/iso.js';
import * as renderer from '../render/renderer.js';
import * as turn from '../game/turn.js';
import * as spells from '../game/spells.js';
import * as popup from '../ui/popup.js';
import * as dom from '../ui/dom.js';
import * as title from '../ui/title.js';
import * as gear from '../ui/gear.js';
import * as panels from '../ui/panels.js';

const MOVE_SLOP = 10;          // CSS px a pointer may travel and still count as a tap
const TAP_MAX_MS = 500;        // longest press that still counts as a tap
const PINCH_STEP = 1.35;       // distance ratio per zoom step (hysteresis: baseline resets after each step)
const GESTURE_COOLDOWN = 150;  // ms after the last pointer lifts during which taps are ignored (post-pinch/drag)
const KEY_THROTTLE = 70;       // ms between key-driven verbs (key repeat allowed, but not a firehose)
const WHEEL_DEBOUNCE = 120;    // ms between wheel zoom steps

let bound = null;              // the canvas we are attached to (idempotency guard)

/** Wrap a handler so a bug here can never throw into the page. */
const guard = (name, fn) => function (...a) {
  try { return fn.apply(this, a); } catch (err) { console.error('[input.' + name + ']', err); }
};

const typing = t => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''));
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function initInput(canvas) {
  if (!canvas || bound) return;                    // idempotent: no duplicate listeners
  bound = canvas;

  canvas.style.touchAction = 'none';               // we own every gesture on the world canvas
  canvas.style.webkitTouchCallout = 'none';
  canvas.style.userSelect = 'none';
  canvas.style.webkitUserSelect = 'none';

  // ---- gesture state --------------------------------------------------------------------------------------------
  const ptrs = new Map();        // pointerId -> {x, y} for every pointer currently down on the canvas
  let down = null;               // the single-pointer press under consideration {id, x, y, lx, ly, t, moved}
  let gestureUsed = false;       // a pinch or drag happened: swallow the tap until everything is up + cooldown
  let gestureEnd = 0;            // timestamp until which taps are ignored
  let pinchBase = 0;             // reference finger distance for the next zoom step
  let lastTap = null;            // {x, y, t} of the previous tap (double-tap detection)
  let lastWheel = 0;
  let lastKey = 0;

  const inputBlocked = () => G.over || title.titleVisible() || dom.panelOpen();

  const spread = () => {
    const [a, b] = [...ptrs.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  const resetGesture = () => {
    ptrs.clear(); down = null; gestureUsed = false; gestureEnd = 0; pinchBase = 0;
  };

  // Dragging is ignored gracefully when the renderer exposes no pan hook; the camera is the renderer's business.
  const pan = (dx, dy) => {
    if (typeof renderer.panBy === 'function') renderer.panBy(dx, dy);
    else if (typeof renderer.setPan === 'function') renderer.setPan(dx, dy);
  };

  const zoom = d => renderer.zoomBy(d);

  // ---- pointer events -------------------------------------------------------------------------------------------
  canvas.addEventListener('pointerdown', guard('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;       // ignore secondary buttons
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* synthetic or already-gone pointers */ }
    if (ptrs.size === 1) {
      down = { id: e.pointerId, x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, t: now(), moved: false };
    } else {
      // second finger: this is a pinch. Cancel any pending tap.
      down = null; gestureUsed = true; pinchBase = spread();
    }
  }));

  canvas.addEventListener('pointermove', guard('pointermove', e => {
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX; p.y = e.clientY;

    if (ptrs.size >= 2) {                                           // pinch zoom with hysteresis
      const d = spread();
      if (!pinchBase) pinchBase = d;
      if (pinchBase > 0 && d > 0) {
        const ratio = d / pinchBase;
        if (ratio >= PINCH_STEP) { zoom(+1); pinchBase = d; }
        else if (ratio <= 1 / PINCH_STEP) { zoom(-1); pinchBase = d; }
      }
      return;
    }

    if (!down || down.id !== e.pointerId) return;
    if (!down.moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) > MOVE_SLOP) {
      down.moved = true; gestureUsed = true;                        // it is a drag now, never a tap
    }
    if (down.moved) {
      pan(e.clientX - down.lx, e.clientY - down.ly);
      down.lx = e.clientX; down.ly = e.clientY;
    }
  }));

  const release = guard('pointerup', e => {
    const wasDown = down && down.id === e.pointerId ? down : null;
    const had = ptrs.delete(e.pointerId);
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) { /* not captured */ }
    if (!had) return;
    if (ptrs.size === 0) {
      const wasGesture = gestureUsed;
      if (wasGesture) gestureEnd = now() + GESTURE_COOLDOWN;
      gestureUsed = false; pinchBase = 0; down = null;
      if (wasGesture || !wasDown) return;
    } else {
      pinchBase = spread();                                          // one finger left: re-baseline, no tap
      down = null;
      return;
    }
    if (e.type === 'pointercancel') return;
    if (now() < gestureEnd) return;                                  // accidental tap right after a pinch/drag
    if (wasDown.moved || now() - wasDown.t > TAP_MAX_MS) return;
    if (Math.hypot(e.clientX - wasDown.x, e.clientY - wasDown.y) > MOVE_SLOP) return;
    handleTap(e.clientX, e.clientY);
  });
  canvas.addEventListener('pointerup', release);

  canvas.addEventListener('pointercancel', guard('pointercancel', e => {
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) { /* not captured */ }
    resetGesture();
  }));

  function handleTap(cx, cy) {
    if (inputBlocked()) return;
    turn.stopAuto();
    const tile = renderer.pickTile(cx, cy);
    if (!tile) return;
    const t = now();
    const dbl = !!lastTap && lastTap.x === tile.x && lastTap.y === tile.y && t - lastTap.t < TIMING.dblTap;
    if (dbl) {
      lastTap = null;
      if (turn.canAutoWalk(tile.x, tile.y)) { popup.closePop(); turn.startAuto({ kind: 'go', x: tile.x, y: tile.y }); return; }
      if (popup.popOpen()) { popup.confirmPrimary(); return; }       // first tap's popup stays unless its main action ran
    } else {
      lastTap = { x: tile.x, y: tile.y, t };
    }
    popup.openPop(tile.x, tile.y, cx, cy);
  }

  // ---- wheel zoom -----------------------------------------------------------------------------------------------
  canvas.addEventListener('wheel', guard('wheel', e => {
    e.preventDefault();
    if (inputBlocked() || !e.deltaY) return;
    const t = now();
    if (t - lastWheel < WHEEL_DEBOUNCE) return;
    lastWheel = t;
    zoom(-Math.sign(e.deltaY));
  }), { passive: false });

  // no context menu / iOS callout / double-tap magnify on the world
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('dblclick', e => e.preventDefault());
  canvas.addEventListener('gesturestart', e => e.preventDefault());   // Safari pinch-page-zoom

  // ---- keyboard -------------------------------------------------------------------------------------------------
  const castGem = n => {
    const id = G.P && G.P.spells && G.P.spells[n - 1];
    if (!id) return;
    const target = spells.spellTargets(id)[0];                      // undefined for self spells
    const why = spells.castBlock(id, target);
    if (why) { say(why, 'sys'); return; }
    if (spells.castSpell(id, target)) turn.endTurn();
  };

  document.addEventListener('keydown', guard('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || typing(e.target)) return;
    if (title.titleVisible() || G.over) return;
    if (dom.panelOpen()) {                                           // a modal is up: only Escape does anything (the death screen refuses)
      if (e.key === 'Escape') { e.preventDefault(); panels.closePanels(); }
      return;
    }

    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

    if (key === 'Escape') {
      if (popup.popOpen()) popup.closePop(); else panels.closePanels();
      return;
    }

    // zoom keys (no turn, no throttle)
    if (key === '+' || key === '=') { e.preventDefault(); zoom(+1); return; }
    if (key === '-' || key === '_') { e.preventDefault(); zoom(-1); return; }

    const dir = KEY_DIRS[key] || KEY_DIRS[e.key];
    const gem = /^[1-4]$/.test(key) ? +key : 0;
    const verb = dir || gem || ('gjbrkm'.includes(key) && key.length === 1);
    if (!verb) return;

    if (dir && (key.startsWith('Arrow') || key === ' ')) e.preventDefault();
    const t = now();
    if (t - lastKey < KEY_THROTTLE) { if (dir) e.preventDefault(); return; }
    lastKey = t;

    turn.stopAuto();
    if (dir) {
      popup.closePop();
      turn.act(dir[0], dir[1]);
    } else if (gem) {
      popup.closePop();
      castGem(gem);
    } else {
      switch (key) {
        case 'g': gear.openGear(); break;
        case 'j': panels.openJournal(); break;
        case 'b': panels.openBestiary(); break;
        case 'm': panels.openMenu(); break;
        case 'r': popup.closePop(); turn.startAuto({ kind: 'rest' }); break;
        case 'k': popup.closePop(); turn.makeCamp(); break;
        default: break;
      }
    }
  }));

  // losing focus mid-gesture must not leave a stale pointer behind
  window.addEventListener('blur', guard('blur', resetGesture));
}
