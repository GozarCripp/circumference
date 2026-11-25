// render/renderer.js — the renderer façade. Every module imports this file; it forwards to one of two views:
//   3D  (default on this branch): render3d/fp.js, a first-person Three.js view, loaded on demand.
//   2.5D (?view=2.5d, or when WebGL / Three.js cannot load): render/renderer2d.js, the isometric canvas.
// The 3D view draws into its own WebGL canvas placed under the #world canvas; #world stays on top, transparent,
// so input.js keeps receiving every pointer event unchanged.
import * as r2 from './renderer2d.js';
import { emit } from '../core/bus.js';

const want3d = typeof location !== 'undefined' && !/[?&]view=2/.test(location.search);
let fp = null;                     // the 3D module once loaded
let mode = want3d ? 'loading' : '2d';
let canvas2d = null;

export const viewMode = () => (mode === '3d' ? '3d' : '2d');
export const is3d = () => mode === '3d';

export function initRenderer(canvas) {
  canvas2d = canvas;
  if (mode === '2d') { r2.initRenderer(canvas); return; }
  import('../render3d/fp.js')
    .then(m => {
      if (!m.initFp(canvas)) throw new Error('WebGL unavailable');
      fp = m; mode = '3d';
      document.documentElement.classList.add('view3d');
      emit('opts', { view: '3d' });
    })
    .catch(e => {
      console.warn('[renderer] 3D view unavailable, using 2.5D:', e);
      mode = '2d'; r2.initRenderer(canvas2d); r2.resize();
      emit('opts', { view: '2d' });
    });
}

const pick = () => (mode === '3d' ? fp : mode === '2d' ? r2 : null);

export function render(now) { const r = pick(); if (r) r.render(now); }
export function resize() { const r = pick(); if (r) r.resize(); }
export function zoomBy(d) { const r = pick(); if (r) r.zoomBy(d); }
export function panBy(dx, dy) { const r = pick(); if (r) r.panBy(dx, dy); }
export function setCameraOffset(dx, dy) { const r = pick(); if (r && r.setCameraOffset) r.setCameraOffset(dx, dy); }
export function snapCamera() { const r = pick(); if (r) r.snapCamera(); }
export function getView(withShake) { return mode === '2d' ? r2.getView(withShake) : null; }
export const isAnimating = () => { const r = pick(); return r ? r.isAnimating() : true; };
export const renderStats = () => { const r = pick(); return r ? r.renderStats() : {}; };
export function pickTile(cx, cy) { const r = pick(); return r ? r.pickTile(cx, cy) : null; }
export function tileToClient(x, y) {
  const r = pick();
  return r ? r.tileToClient(x, y) : { x: innerWidth / 2, y: innerHeight / 2 };
}

// ---- first-person only (no-ops in 2.5D) ----------------------------------------------------------------------------
/** Glide movement: press / release a held movement key ('f','b','l','r' move; 'tl','tr' turn). */
export function hold(k, down) { if (mode === '3d') fp.hold(k, down); }
export function releaseAll() { if (mode === '3d') fp.releaseAll(); }
/** Grid step for a move relative to the view: f = +1 forward / -1 back, r = +1 right / -1 left. */
export function relDir(f, r) { return mode === '3d' ? fp.relDir(f, r) : null; }
