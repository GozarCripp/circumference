// render3d/hud3d.js — HUD pieces only the first-person view needs (all DOM, created lazily, styled inline):
//   * a heading arrow on the minimap (north is up, so it turns as you turn)
//   * a crosshair with a name tag for whatever sits under it; F / Enter inspects it (input.js -> renderer.interact)
//   * a left thumb stick on touch screens (walk / strafe; drag the rest of the screen to look)
import { G } from '../core/state.js';
import { theName, con } from '../game/combat.js';   // con(m) = {color, text} threat colour
import { monAt, npcAt, isVis } from '../world/world.js';
import { shown } from '../game/monsters.js';

const STYLE = `
.h3-arrow{position:absolute;left:50%;top:50%;width:0;height:0;pointer-events:none;z-index:2}
.h3-arrow i{position:absolute;left:-6px;top:-13px;border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:12px solid #ffd23f;filter:drop-shadow(0 0 1px #120826) drop-shadow(0 0 1px #120826)}
.h3-cross{position:fixed;left:50%;top:50%;width:6px;height:6px;margin:-3px 0 0 -3px;background:#fff;border:2px solid #2a0a3a;border-radius:1px;pointer-events:none;z-index:5;opacity:.75}
.h3-tag{position:fixed;left:50%;top:calc(50% + 16px);transform:translateX(-50%);font:14px "Titan One",system-ui,sans-serif;color:#fff;
  -webkit-text-stroke:3px #2a0a3a;paint-order:stroke fill;pointer-events:none;z-index:5;white-space:nowrap;text-align:center}
.h3-tag small{display:block;font:11px system-ui,sans-serif;-webkit-text-stroke:0;color:#efe9ff;text-shadow:0 1px 2px #120826}
.h3-stick{position:fixed;left:22px;bottom:150px;width:124px;height:124px;border-radius:50%;z-index:6;touch-action:none;
  background:radial-gradient(circle,#2d145888 0 55%,#1b0f3baa 56%);border:3px solid #ff2fa0aa;box-shadow:0 0 0 2px #120826}
.h3-stick b{position:absolute;left:50%;top:50%;width:54px;height:54px;margin:-27px 0 0 -27px;border-radius:50%;
  background:radial-gradient(circle at 40% 35%,#ffd23f,#ff7a1a);border:3px solid #2a0a3a;pointer-events:none}
html.view3d #hud .hd-map canvas{transform:none}   /* 3D: the minimap is north-up, not turned to the isometric view */
html:not(.view3d) .h3-cross,html:not(.view3d) .h3-tag,html:not(.view3d) .h3-stick,html:not(.view3d) .h3-arrow{display:none}
`;

let arrow = null, cross = null, tag = null, tagKey = '';
let stickApi = null;

export function initHud3d(api) {
  stickApi = api;
  const st = document.createElement('style'); st.textContent = STYLE; document.head.appendChild(st);
  cross = document.createElement('div'); cross.className = 'h3-cross';
  tag = document.createElement('div'); tag.className = 'h3-tag';
  document.body.append(cross, tag);
  if (matchMedia('(pointer: coarse)').matches) makeStick();
}

function makeStick() {
  const pad = document.createElement('div'); pad.className = 'h3-stick';
  const knob = document.createElement('b'); pad.appendChild(knob);
  document.body.appendChild(pad);
  let id = null;
  const set = (e) => {
    const r = pad.getBoundingClientRect(), R = r.width / 2;
    let x = (e.clientX - r.left - R) / R, y = (e.clientY - r.top - R) / R;
    const L = Math.hypot(x, y); if (L > 1) { x /= L; y /= L; }
    knob.style.transform = `translate(${x * R * 0.55}px,${y * R * 0.55}px)`;
    const dead = L < 0.18;                                   // small dead zone so a resting thumb does not creep
    stickApi.setStick(dead ? 0 : x, dead ? 0 : -y);
  };
  const end = () => { id = null; knob.style.transform = ''; stickApi.setStick(0, 0); };
  pad.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); id = e.pointerId; try { pad.setPointerCapture(id); } catch (_) { /* ignore */ } set(e); });
  pad.addEventListener('pointermove', e => { if (e.pointerId === id) set(e); });
  pad.addEventListener('pointerup', e => { if (e.pointerId === id) end(); });
  pad.addEventListener('pointercancel', end);
  pad.addEventListener('contextmenu', e => e.preventDefault());
}

/** What the crosshair is on: a tile {x, y} from the 3D pick, or null. Returns the label shown, if any. */
function labelFor(t) {
  if (!t || !G.P) return null;
  const m = monAt(t.x, t.y);
  if (m && shown(m)) { let c = '#fff', txt = ''; try { const k = con(m); c = k.color; txt = k.text; } catch (e) { /* ignore */ } return { name: m.name || theName(m, true), sub: txt, col: c }; }
  const n = npcAt(t.x, t.y);
  if (n && isVis(n.x, n.y)) return { name: n.name || 'Someone', sub: 'F to talk', col: '#ff9ec4' };
  return null;
}

/** Per frame (cheap): heading arrow. Every ~150 ms: the crosshair target (a ray pick). */
let lastPick = 0;
export function updateHud3d(yaw, now, pick) {
  if (!arrow) {
    const map = document.querySelector('.hd-map');
    if (map) { if (getComputedStyle(map).position === 'static') map.style.position = 'relative'; arrow = document.createElement('div'); arrow.className = 'h3-arrow'; arrow.appendChild(document.createElement('i')); map.appendChild(arrow); }
  }
  if (arrow) arrow.style.transform = `rotate(${(-yaw * 180 / Math.PI).toFixed(1)}deg)`;
  if (now - lastPick < 150 || !tag) return;
  lastPick = now;
  const L = labelFor(pick());
  const key = L ? L.name + '|' + L.sub + '|' + L.col : '';
  if (key === tagKey) return;
  tagKey = key;
  tag.innerHTML = '';
  if (L) { tag.style.color = L.col; tag.textContent = L.name; if (L.sub) { const s = document.createElement('small'); s.textContent = L.sub; tag.appendChild(s); } }
}
