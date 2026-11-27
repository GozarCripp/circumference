// render3d/fp.js — the first-person 3D view (Three.js). Same contract as render/renderer2d.js, reached through
// render/renderer.js. Reads the game state (G) and world queries only; never changes the game.
//
//   world     every seen tile within DRAW_R of the hero becomes an instanced box (one InstancedMesh per terrain
//             key): ground columns, liquids slightly sunk, solids as tall blocks. Rebuilt only when the turn, the
//             hero's tile, the map or the art changes. Seen-but-not-visible tiles are dimmed (memory).
//   sprites   props (trees, pillars, cacti …), ground items, NPCs, monsters and the campfire are billboards built
//             from the existing procedural art (art/assets.js), pixel-crisp.
//   camera    stands on the hero's tile at eye height, eases between tiles, turns in 45° steps (keys) or freely
//             (drag). Movement keys are view-relative: relDir() maps them to a grid step.
//   light     day/night from config.dayInfo via lighting.ambient(): sun + hemisphere tint, fog closes in at night;
//             in dungeons a torch rides with the camera.
import * as THREE from '../../vendor/three.module.min.js';
import { G } from '../core/state.js';
import { TIMING, WS } from '../core/config.js';
import { on } from '../core/bus.js';
import { TERRAIN } from '../data/terrain.js';
import { terr, isSeen, isVis, heightAt, elevAt, groundKey, isDeep } from '../world/world.js';
import * as assets from '../art/assets.js';
import { ambient } from '../render/lighting.js';
import { shown } from '../game/monsters.js';
import { drawFx, shake, flashOf } from '../render/fx.js';
import { act } from '../game/turn.js';
import { blocks } from '../world/world.js';
import { panelOpen } from '../ui/dom.js';
import { titleVisible } from '../ui/title.js';
import { initCombat3d, drawCombat, combatActive } from './combat3d.js';
import { initHud3d, updateHud3d } from './hud3d.js';
import { con } from '../game/combat.js';

// ---- tunables ------------------------------------------------------------------------------------------------------
const DRAW_R = 44;               // tiles drawn around the hero
const CAP = 8192;                // instance capacity per terrain key
const ZG = 0.11;                 // world units per ZU for ground and terraces
const ZS = 0.24;                 // world units per ZU for solid columns (rocks, pyramid steps)
const WALL_H = 1.9;              // castle and dungeon walls
const EYE = 0.62;                // eye height above the ground under the hero
// The planet: a WS x WS torus drawn as a sphere of the same circumference (768 tiles -> radius ~122.2). Ground at
// distance d sinks R - sqrt(R^2 - d^2) below the hero's horizon (~0.33 at 9 tiles, ~6.6 at 40), so the land curves away.
const PLANET_R = WS / (2 * Math.PI);
const curve = (dx, dy) => { const d2 = dx * dx + dy * dy; return PLANET_R - Math.sqrt(Math.max(0, PLANET_R * PLANET_R - d2)); };
const PROP_FAR = 30, LOW_PROP_FAR = 16;   // billboards cost a draw call each: trees to 30 tiles, ferns/reeds to 16
const BACK = 0.4;                // camera sits this far behind the hero's position (a touch of breathing room)
const SPEED = 3.2;               // glide speed, tiles per second (one game turn per tile crossed)
const TURN_RATE = 2.4;           // radians per second while a turn key is held
const SWING = 260;               // ms between repeated bumps (attacks, chopping) while pushing into a tile
const PX = 26;                   // art pixels per world unit for billboards
const YAW_TAU = 70, POS_TAU = TIMING.tween;
const MEMORY = new THREE.Color(0.34, 0.36, 0.48);   // tint of tiles remembered but not in sight
const STEP = Math.PI / 4;

// ---- state ---------------------------------------------------------------------------------------------------------
let gl = null, scene = null, camera = null, cv3 = null, ov = null, octx = null, fxS = 3;
let sun = null, hemi = null, torch = null;
const meshes = new Map();        // terrain key -> { mesh, tiles: Int32Array(2 * CAP), n }
const boxGeo = new THREE.BoxGeometry(1, 1, 1);
let yaw = 0, yawT = 0, pitch = -0.06, pitchT = -0.06;
let camX = 0, camY = 0, camZ = 0, snap = true, lastNow = 0, animating = false;
let builtSig = '', artVer = 0, dpr = 1, fovBase = 80, zoom = 0;
const stats = { tiles: 0, sprites: 0, ms: 0 };
const raycaster = new THREE.Raycaster();

// combat reactions (see initFp): knockback / lunge per monster, death ghosts, hit-stop, crit camera kick
const react = new WeakMap();     // monster -> { k: 'knock' | 'lunge', t0 }
const ghosts = [];               // dying monsters: { spr, x, y, z, sc, t0, s }
let stopUntil = 0, simShift = 0, kickT0 = -1e9;
const GHOST_MS = 380;

// billboard pool + caches
const spritePool = [];
let spriteN = 0;
const texCache = new WeakMap();  // assets sprite -> { tex, mat }
const disp = new WeakMap();      // entity -> tween record

// =================================================================================================================
//  setup
// =================================================================================================================
/** Create the WebGL canvas under `canvas2d` (which stays on top for input). Returns false if WebGL is unavailable. */
export function initFp(canvas2d) {
  cv3 = document.createElement('canvas');
  cv3.id = 'world3d';
  cv3.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';
  canvas2d.parentNode.insertBefore(cv3, canvas2d);
  try { gl = new THREE.WebGLRenderer({ canvas: cv3, antialias: false, powerPreference: 'high-performance' }); }
  catch (e) { cv3.remove(); return false; }
  canvas2d.style.background = 'transparent';
  ov = canvas2d; octx = ov.getContext('2d');

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(fovBase, 1, 0.05, 120);
  camera.rotation.order = 'YXZ';
  hemi = new THREE.HemisphereLight(0xffffff, 0x404050, 0.9);
  sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(0.5, 1, 0.3);
  torch = new THREE.PointLight(0xffb060, 0, 9, 1.4);
  scene.add(hemi, sun, sun.target, torch);
  scene.fog = new THREE.Fog(0x8fb0d8, 6, DRAW_R);

  const reset = () => { snap = true; builtSig = ''; };
  on('newgame', reset); on('loaded', reset); on('floor', reset);
  on('asset', () => { artVer++; builtSig = ''; });
  // ---- combat reactions on billboards (renderer-only; the game resolves everything instantly) ----
  initCombat3d();
  initHud3d({ setStick });
  const t = () => performance.now();
  on('hit', e => {
    if (!e || !e.mon) return;
    react.set(e.mon, { k: 'knock', t0: t() });
    if (e.crit) { kickT0 = t(); stopUntil = t() + 60; }
  });
  on('hurt', e => {
    const m = e && e.by;
    if (m && m.hp !== undefined && Number.isFinite(m.x) && e.kind !== 'poison') react.set(m, { k: 'lunge', t0: t() });
  });
  on('kill', e => {
    const m = e && e.mon; if (!m || !Number.isFinite(m.x)) return;
    const r = disp.get(m);
    ghosts.push({ spr: assets.sprite(assets.monSpriteId(m)), x: r ? r.x : m.x, y: r ? r.y : m.y, z: standY(m.x, m.y), sc: m.boss ? 1.25 : 0.9, t0: t(), s: null });
    stopUntil = t() + 60;
  });
  resize();
  return true;
}

export function resize() {
  if (!gl) return;
  const w = Math.max(1, innerWidth), h = Math.max(1, innerHeight);
  dpr = Math.min(2, window.devicePixelRatio || 1);
  gl.setPixelRatio(dpr * 0.75);               // a little under native: chunky, fast, matches the pixel art
  gl.setSize(w, h, false);
  if (ov) { ov.width = Math.round(w * dpr); ov.height = Math.round(h * dpr); }
  fxS = dpr * Math.max(3, Math.min(5, Math.min(w, h) / 160));   // device px per art px for effect text
  camera.aspect = w / h;
  camera.fov = fovBase - zoom * 6;
  camera.updateProjectionMatrix();
}

export function zoomBy(d) { zoom = Math.max(-3, Math.min(4, zoom + d)); resize(); }
export function panBy(dx, dy) {                 // drag = look around
  yawT += dx * 0.006; yaw = yawT;
  pitchT = Math.max(-0.9, Math.min(0.6, pitchT + dy * 0.004)); pitch = pitchT;
}
export function snapCamera() { snap = true; }
export const isAnimating = () => animating;
export const renderStats = () => stats;

// ---- glide movement: held keys move a continuous position; crossing into a new tile is one game step ---------------
const held = { f: 0, b: 0, l: 0, r: 0, tl: 0, tr: 0 };
export function hold(k, down) { if (k in held) { held[k] = down ? 1 : 0; animating = true; } }
export function releaseAll() { for (const k in held) held[k] = 0; stickF = stickR = 0; }
let px = 0, py = 0, lastAct = -1e9, phase = 0;
let stickF = 0, stickR = 0;      // phone thumb stick, analog -1..1
export function setStick(r, f) { stickR = r; stickF = f; animating = true; }
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function glide(now, dt) {
  const P = G.P;
  if (snap || Math.abs(px - P.x) > 1.6 || Math.abs(py - P.y) > 1.6) { px = P.x; py = P.y; }   // teleports, floors, loads
  if (G.over || panelOpen() || titleVisible()) releaseAll();
  const sec = dt / 1000;
  if (held.tl || held.tr) { yawT += (held.tl - held.tr) * TURN_RATE * sec; yaw = yawT; animating = true; }
  const mf = held.f - held.b + stickF, mr = held.r - held.l + stickR;
  if (!mf && !mr) {                     // settle onto the tile centre (also follows auto-walk and anything that moves the hero)
    const k = 1 - Math.exp(-dt / 90);
    px += (P.x - px) * k; py += (P.y - py) * k;
    if (Math.abs(P.x - px) > 0.002 || Math.abs(P.y - py) > 0.002) animating = true; else { px = P.x; py = P.y; }
    return false;
  }
  animating = true;
  const len = Math.max(1, Math.hypot(mf, mr));   // keys: unit speed; a half-pushed stick walks slower
  let nx = px + (-Math.sin(yawT) * mf + Math.cos(yawT) * mr) / len * SPEED * sec;
  let ny = py + (-Math.cos(yawT) * mf - Math.sin(yawT) * mr) / len * SPEED * sec;
  const tx = Math.round(nx), ty = Math.round(ny);
  if (tx !== P.x || ty !== P.y) {
    let dx = Math.sign(tx - P.x), dy = Math.sign(ty - P.y);
    // cutting a corner into a wall: slide along whichever side is open
    if (dx && dy && blocks(P.x + dx, P.y + dy)) { if (!blocks(P.x + dx, P.y)) dy = 0; else if (!blocks(P.x, P.y + dy)) dx = 0; }
    if (now - lastAct >= SWING) { lastAct = now; act(dx, dy); }
    if (P.x !== tx) nx = clamp(nx, P.x - 0.49, P.x + 0.49);   // did not get there (wall, monster, NPC): stay in our tile
    if (P.y !== ty) ny = clamp(ny, P.y - 0.49, P.y + 0.49);
  }
  phase += Math.hypot(nx - px, ny - py);
  px = nx; py = ny;
  return true;
}

/** Grid step for a view-relative move: f = forward (+1) / back (-1), r = right (+1) / left (-1). */
export function relDir(f, r) {
  const s = Math.round(yawT / STEP) * STEP;
  const vx = -Math.sin(s) * f + Math.cos(s) * r, vy = -Math.cos(s) * f - Math.sin(s) * r;
  const q = v => (v > 0.35 ? 1 : v < -0.35 ? -1 : 0);
  return [q(vx), q(vy)];
}

// =================================================================================================================
//  textures
// =================================================================================================================
function hashc(x, y, s) { let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }

/** A 16x16 pixel-noise texture from a terrain's palette colour. Solids get brick / block lines. */
function terrainTexture(def) {
  const c = document.createElement('canvas'); c.width = c.height = 16;
  const g = c.getContext('2d'), base = new THREE.Color(def.color || '#888');
  const seed = [...def.key].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7) & 0xffff;
  const brick = def.kind === 'solid';
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    let k = 0.82 + hashc(x, y, seed) * 0.3;
    if (brick) {
      const row = y >> 2, off = (row & 1) * 4;
      if ((y & 3) === 3 || ((x + off) & 7) === 7) k *= 0.62;
    } else if (def.kind === 'liquid') k = 0.85 + 0.2 * Math.sin((x + y * 0.5) * 0.8 + hashc(x >> 2, y, seed) * 2);
    g.fillStyle = '#' + base.clone().multiplyScalar(k).getHexString();
    g.fillRect(x, y, 1, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function meshFor(key) {
  let m = meshes.get(key);
  if (m) return m;
  const def = TERRAIN[key] || { key, color: '#888', kind: 'ground' };
  const liquid = def.kind === 'liquid';
  const mat = new THREE.MeshLambertMaterial({ map: terrainTexture(def), transparent: liquid, opacity: liquid ? 0.82 : 1 });
  const mesh = new THREE.InstancedMesh(boxGeo, mat, CAP);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.setColorAt(0, new THREE.Color(1, 1, 1));
  mesh.frustumCulled = false;
  mesh.userData.key = key;
  scene.add(mesh);
  m = { mesh, tiles: new Int32Array(2 * CAP), n: 0, liquid };
  meshes.set(key, m);
  return m;
}

/** Billboard material for an art sprite (first frame, crisp pixels). */
function matFor(spr) {
  let e = texCache.get(spr);
  if (e) return e;
  const t = new THREE.CanvasTexture(spr.img);
  t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.colorSpace = THREE.SRGBColorSpace;
  t.repeat.set(1 / (spr.frames || 1), 1);
  const mat = new THREE.SpriteMaterial({ map: t, alphaTest: 0.5, fog: true });
  e = { tex: t, mat };
  texCache.set(spr, e);
  return e;
}

// =================================================================================================================
//  world build
// =================================================================================================================
const M4 = new THREE.Matrix4(), V3 = new THREE.Vector3(), Q = new THREE.Quaternion(), SC = new THREE.Vector3(), COL = new THREE.Color();

function place(key, x, y, bottom, top, vis) {
  const m = meshFor(key);
  if (m.n >= CAP) return;
  const h = Math.max(0.02, top - bottom), sink = G.dg ? 0 : curve(x - G.P.x, y - G.P.y);
  M4.compose(V3.set(x, bottom + h / 2 - sink, y), Q, SC.set(1, h, 1));
  m.mesh.setMatrixAt(m.n, M4);
  m.mesh.setColorAt(m.n, vis ? COL.setRGB(1, 1, 1) : MEMORY);
  m.tiles[2 * m.n] = x; m.tiles[2 * m.n + 1] = y;
  m.n++;
}

/** Surface height (world units) a creature stands on at tile (x, y). */
function standY(x, y) {
  if (G.dg && !isSeen(x, y)) return 0;
  const d = terr(x, y);
  if (d.kind === 'liquid') return -0.12;
  if (d.kind === 'solid') return solidTop(d, x, y);
  return Math.max(0, heightAt(x, y)) * ZG;
}
function solidTop(d, x, y) {
  if (G.dg || d.key === 'wall') return WALL_H + (G.dg ? 0 : elevAt(x, y) * ZG);
  return Math.max(1.1, heightAt(x, y) * ZS);
}

const props = [];                // [{ spr, x, y, z }] rebuilt with the world
function buildWorld() {
  const P = G.P;
  for (const m of meshes.values()) m.n = 0;
  props.length = 0;
  let tiles = 0;
  for (let y = P.y - DRAW_R; y <= P.y + DRAW_R; y++) for (let x = P.x - DRAW_R; x <= P.x + DRAW_R; x++) {
    const ddx = x - P.x, ddy = y - P.y;
    const dd = ddx * ddx + ddy * ddy;
    // overworld: the land itself is drawn to the horizon (unexplored = hazy); dungeons stay explored-only
    if (dd > DRAW_R * DRAW_R || (G.dg && !isSeen(x, y))) continue;
    const d = terr(x, y);
    if (d.kind === 'none') continue;
    const vis = isVis(x, y);
    tiles++;
    if (d.kind === 'liquid') { place(d.key, x, y, -1, -0.12, vis); continue; }
    if (d.kind === 'solid') {
      place(d.key, x, y, -1, solidTop(d, x, y), vis);
      continue;
    }
    const top = Math.max(0, heightAt(x, y)) * ZG;
    const gk = d.kind === 'prop' ? (d.ground === 'auto' ? groundKey(x, y) : d.ground) : d.key;
    place(gk, x, y, -1, top, vis);
    if (d.kind === 'prop' && !(x === P.x && y === P.y) && dd <= (d.tall ? PROP_FAR * PROP_FAR : LOW_PROP_FAR * LOW_PROP_FAR)) props.push({ spr: assets.sprite('prop/' + d.key, hashv(x, y)), x, y, z: top, vis, sc: d.tall ? 1.15 : 0.5 });
  }
  if (!G.dg && P.camp && isSeen(P.camp.x, P.camp.y)) props.push({ spr: assets.sprite('prop/campfire', 0), x: P.camp.x, y: P.camp.y, z: standY(P.camp.x, P.camp.y), vis: isVis(P.camp.x, P.camp.y) });
  for (const m of meshes.values()) {
    m.mesh.count = m.n;
    m.mesh.instanceMatrix.needsUpdate = true;
    if (m.mesh.instanceColor) m.mesh.instanceColor.needsUpdate = true;
  }
  stats.tiles = tiles;
}
const hashv = (x, y) => Math.floor(hashc(((x % WS) + WS) % WS, ((y % WS) + WS) % WS, 91) * 4);

// =================================================================================================================
//  billboards
// =================================================================================================================
function billboard(spr, x, y, z, dim, tag, scale = 1) {
  let s = spritePool[spriteN];
  if (!s) { s = spritePool[spriteN] = new THREE.Sprite(); scene.add(s); }
  spriteN++;
  const e = matFor(spr);
  s.material = e.mat;
  s.visible = true;
  s.center.set(spr.ax / spr.w, 1 - spr.ay / spr.h);
  s.scale.set(spr.w / PX * scale, spr.h / PX * scale, 1);
  s.position.set(x, z - (G.dg ? 0 : curve(x - G.P.x, y - G.P.y)), y);
  e.mat.color.copy(lit); if (dim) e.mat.color.multiply(MEMORY);
  s.userData.tile = tag;
  s.renderOrder = 0;
  return s;
}
/** A hit flash: the same billboard again, additively, so the creature blinks white like the 2.5D sprites. */
function flashOver(base, spr, f) {
  const e = matFor(spr);
  if (!e.flash) e.flash = new THREE.SpriteMaterial({ map: e.tex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false });
  let s = spritePool[spriteN];
  if (!s) { s = spritePool[spriteN] = new THREE.Sprite(); scene.add(s); }
  spriteN++;
  s.material = e.flash; e.flash.opacity = Math.min(1, f * 1.2);
  s.visible = true; s.center.copy(base.center); s.scale.copy(base.scale); s.position.copy(base.position);
  s.userData.tile = base.userData.tile; s.renderOrder = 1;
}

function track(e, now) {
  let r = disp.get(e);
  if (!r || snap) { r = { x: e.x, y: e.y, sx: e.x, sy: e.y, tx: e.x, ty: e.y, t0: -1 }; disp.set(e, r); }
  if (e.x !== r.tx || e.y !== r.ty) {
    if (Math.abs(e.x - r.x) > 2.01 || Math.abs(e.y - r.y) > 2.01) { r.x = r.tx = e.x; r.y = r.ty = e.y; r.t0 = -1; }
    else { r.sx = r.x; r.sy = r.y; r.tx = e.x; r.ty = e.y; r.t0 = now; }
  }
  if (r.t0 >= 0) {
    const k = (now - r.t0) / POS_TAU;
    if (k >= 1) { r.x = r.tx; r.y = r.ty; r.t0 = -1; }
    else { r.x = r.sx + (r.tx - r.sx) * k; r.y = r.sy + (r.ty - r.sy) * k; animating = true; }
  }
  return r;
}

function buildSprites(now) {
  const P = G.P;
  spriteN = 0;
  for (const p of props) billboard(p.spr, p.x, p.y, p.z, !p.vis, { x: p.x, y: p.y }, p.sc || 1);
  if (G.items && G.items.size) G.items.forEach((it, key) => {
    const c = key.indexOf(',');
    let ux = +key.slice(0, c), uy = +key.slice(c + 1);
    if (!G.dg) { ux += Math.round((P.x - ux) / WS) * WS; uy += Math.round((P.y - uy) / WS) * WS; }
    if (Math.abs(ux - P.x) > 30 || Math.abs(uy - P.y) > 30 || !isVis(ux, uy)) return;
    billboard(assets.sprite(assets.itemSpriteId(it)), ux, uy, standY(ux, uy) + 0.04 * Math.sin(now / 300 + ux), false, { x: ux, y: uy }, 0.65);
  });
  for (const n of G.npcs || []) {
    if (Math.abs(n.x - P.x) > 30 || Math.abs(n.y - P.y) > 30) continue;
    const r = track(n, now);
    if (!isVis(n.x, n.y)) continue;
    const spr = assets.sprite('npc/' + (n.look || n.id)), b = billboard(spr, r.x, r.y, standY(n.x, n.y), false, { x: n.x, y: n.y }, 0.9);
    const f = flashOf(n); if (f > 0) { flashOver(b, spr, f); animating = true; }
  }
  for (const m of G.mons || []) {
    if (Math.abs(m.x - P.x) > 30 || Math.abs(m.y - P.y) > 30) continue;
    const r = track(m, now);
    if (!shown(m)) continue;
    const z = isDeep(m.x, m.y) ? -0.35 : standY(m.x, m.y);
    const spr = assets.sprite(assets.monSpriteId(m)), b = billboard(spr, r.x, r.y, z, false, { x: m.x, y: m.y }, m.boss ? 1.25 : 0.9);
    const rc = react.get(m);
    if (rc) {                                   // knockback away from us when hit; lunge at us when it hits
      const k = (performance.now() - rc.t0) / (rc.k === 'knock' ? 140 : 170);
      if (k >= 1 || k < 0) react.delete(m);
      else {
        const e = Math.sin(k * Math.PI), dx = r.x - px, dy = r.y - py, L = Math.hypot(dx, dy) || 1;
        const amt = rc.k === 'knock' ? 0.15 : -0.35;
        b.position.x += dx / L * amt * e; b.position.z += dy / L * amt * e;
        b.scale.x *= 1 + 0.15 * e; b.scale.y *= rc.k === 'knock' ? 1 - 0.15 * e : 1 + 0.15 * e;   // squash / grow
        animating = true;
      }
    }
    const f = flashOf(m); if (f > 0) { flashOver(b, spr, f); animating = true; }
  }
  for (let i = spriteN; i < spritePool.length; i++) spritePool[i].visible = false;
  // dying monsters tip over from the feet, sink and fade (own material: rotation/opacity are per sprite)
  const rn = performance.now();
  for (let i = ghosts.length - 1; i >= 0; i--) {
    const g = ghosts[i], k = (rn - g.t0) / GHOST_MS;
    if (k >= 1) { if (g.s) { scene.remove(g.s); g.s.material.dispose(); } ghosts.splice(i, 1); continue; }
    if (!g.s) {
      const sp = g.spr;
      g.s = new THREE.Sprite(matFor(sp).mat.clone());
      g.s.material.transparent = true; g.s.material.alphaTest = 0.05;
      g.s.center.set(sp.ax / sp.w, 1 - sp.ay / sp.h); g.s.scale.set(sp.w / PX * g.sc, sp.h / PX * g.sc, 1);
      scene.add(g.s);
    }
    g.s.material.rotation = (g.x >= px ? -1 : 1) * 1.45 * Math.min(1, k * 1.6);
    g.s.material.opacity = 1 - k * k;
    g.s.material.color.copy(lit);
    g.s.position.set(g.x, g.z - curve(g.x - P.x, g.y - P.y) - 0.3 * k, g.y);
    animating = true;
  }
  stats.sprites = spriteN;
}

// =================================================================================================================
//  light, sky, fog
// =================================================================================================================
const SKY_DAY = new THREE.Color(0x8fb6e6), SKY_NIGHT = new THREE.Color(0x0d0a26), TOMB = new THREE.Color(0x0a0710);
const tint = new THREE.Color(), sky = new THREE.Color(), lit = new THREE.Color(1, 1, 1);   // lit: billboards are unlit, so they take the light by colour
function updateLight() {
  const a = ambient();
  if (G.dg) {
    sky.copy(TOMB);
    hemi.intensity = 0.18; sun.intensity = 0.05;
    torch.intensity = 2.4; torch.distance = (a.radius || 9) + 2;
    scene.fog.near = 1.5; scene.fog.far = (a.radius || 9) + 1;
  } else {
    const L = a.light ?? 1;
    tint.setRGB(a.tint[0] / 255, a.tint[1] / 255, a.tint[2] / 255);
    sky.copy(SKY_NIGHT).lerp(SKY_DAY, (L - 0.42) / 0.58).multiply(tint);
    hemi.color.copy(tint); hemi.intensity = 0.35 + 0.6 * L;
    sun.color.copy(tint); sun.intensity = 0.2 + 1.1 * L;
    torch.intensity = L < 0.6 ? 1.2 : 0; torch.distance = 7;
    scene.fog.near = 6; scene.fog.far = a.phase === 'night' ? (a.radius || 7) * 2 + 4 : DRAW_R - 1;
  }
  if (G.dg) lit.setRGB(0.75, 0.62, 0.5); else lit.copy(tint).multiplyScalar(0.3 + 0.7 * (a.light ?? 1));
  scene.fog.color.copy(sky);
  gl.setClearColor(sky);
}

// =================================================================================================================
//  sky: sun + moon on the game clock, a fixed north star. Directions are true to the map: north = -y (three -z),
//  east = +x. The sun rises due east at dawn (t 0.25), peaks a little to the south at noon, sets due west at dusk
//  (t 0.78); the moon runs the same arc half a day later. Drawn far out, past the land, so hills can hide them.
// =================================================================================================================
const SKY_D = 100;
const sky3 = { sun: null, moon: null, star: null, clouds: [] };
function skyTex(draw, n = 16) {
  const c = document.createElement('canvas'); c.width = c.height = n;
  draw(c.getContext('2d'), n);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function disc(g, n, r, col) { for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if ((x - n / 2 + .5) ** 2 + (y - n / 2 + .5) ** 2 <= r * r) { g.fillStyle = col; g.fillRect(x, y, 1, 1); } }
function skySprite(tex, size) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, fog: false, transparent: true, depthWrite: false }));
  s.scale.set(size, size, 1); s.renderOrder = -1; scene.add(s); return s;
}
function initSky() {
  sky3.sun = skySprite(skyTex((g, n) => {                // title-screen sun: yellow disc, orange bands
    disc(g, n, 7.5, '#ffd23f'); g.fillStyle = '#f5874a';
    for (const y of [9, 11, 13]) for (let x = 0; x < n; x++) { const d = g.getImageData(x, y, 1, 1).data; if (d[3]) g.fillRect(x, y, 1, 1); }
  }), 14);
  sky3.moon = skySprite(skyTex((g, n) => {
    disc(g, n, 6.5, '#e9e4ff'); g.fillStyle = '#b8b0d8';
    for (const [x, y] of [[5, 6], [6, 6], [9, 9], [10, 9], [9, 10], [7, 11]]) g.fillRect(x, y, 1, 1);
  }), 9);
  sky3.star = skySprite(skyTex((g) => {                  // four-point sparkle
    g.fillStyle = '#ffffff'; g.fillRect(3, 0, 1, 7); g.fillRect(0, 3, 7, 1);
    g.fillStyle = '#8fd3ff'; g.fillRect(2, 2, 3, 3); g.fillStyle = '#ffffff'; g.fillRect(3, 3, 1, 1);
  }, 7), 3.2);
  // clouds in the title screen's style: white puffs over a baby-blue underside, pixel-crisp
  const puffs = [[[6, 8, 4], [12, 6, 6], [19, 7, 5], [25, 9, 3]], [[5, 8, 3], [10, 7, 5], [16, 5, 6], [22, 7, 5], [27, 9, 3]], [[8, 8, 4], [14, 6, 5], [20, 8, 4]]];
  const texs = puffs.map(set => {
    const c = document.createElement('canvas'); c.width = 32; c.height = 14;
    const g = c.getContext('2d');
    const blob = (col, dy, dr) => { g.fillStyle = col; for (const [x, y, r] of set) for (let py = 0; py < 14; py++) for (let px = 0; px < 32; px++) if ((px - x) ** 2 + (py - y - dy) ** 2 <= (r + dr) ** 2) g.fillRect(px, py, 1, 1); };
    blob('#9fd8ff', 1.5, 0); blob('#ffffff', 0, -0.5);
    const t = new THREE.CanvasTexture(c); t.magFilter = t.minFilter = THREE.NearestFilter; t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
  let a = 0x51ced;
  const rnd = () => { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return a / 4294967296; };
  for (let i = 0; i < 18; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: texs[i % 3], fog: false, transparent: true, depthWrite: false, alphaTest: 0.5 }));
    const w = 14 + rnd() * 12;
    s.scale.set(w, w * 14 / 32, 1); s.renderOrder = -1; scene.add(s);
    sky3.clouds.push({ s, az: rnd() * Math.PI * 2, el: 0.1 + rnd() * 0.32, drift: 0.004 + rnd() * 0.006 });
  }
}
const SKV = new THREE.Vector3();
function placeSky(s, x, y, z) { SKV.set(x, y, z).normalize().multiplyScalar(SKY_D); s.position.copy(camera.position).add(SKV); }
function updateSky() {
  if (!sky3.sun) initSky();
  const out = !G.dg;
  sky3.sun.visible = sky3.moon.visible = sky3.star.visible = out;
  for (const c of sky3.clouds) c.s.visible = out;
  if (!out) return;
  const a = ambient(), t = a.t ?? 0.5;
  const arc = (k) => { const th = k * Math.PI; return [Math.cos(th), Math.sin(th), 0.35 * Math.sin(th)]; };   // x east->west, up, south lean
  const ks = (t - 0.25) / 0.53;                         // 0 at sunrise, 1 at sunset
  const km = ((t + 0.5) % 1 - 0.25) / 0.53;             // the moon, half a day out of step
  const [sx, sy, sz] = arc(ks), [mx, my, mz] = arc(km);
  placeSky(sky3.sun, sx, sy, sz); sky3.sun.visible = sy > -0.15;
  stats.sky = { t: +t.toFixed(3), sun: [sx, sy, sz].map(v => +v.toFixed(2)), yaw: +yaw.toFixed(2) };   // for tests
  placeSky(sky3.moon, mx, my, mz); sky3.moon.visible = my > -0.15;
  placeSky(sky3.star, 0, 0.42, -1);                     // due north, fixed
  const L = a.light ?? 1;
  sky3.star.material.opacity = Math.max(0.18, 1 - (L - 0.42) / 0.45);   // bright at night, a faint glint by day
  sky3.moon.material.opacity = Math.max(0.35, 1 - (L - 0.42) / 0.7);
  // clouds drift west on the wind (moved whenever a frame is drawn; no extra frames just for them) and take the
  // light's tint: white by day, peach at dawn/dusk, dim indigo at night
  const sec = performance.now() / 1000;
  COL.setRGB(a.tint[0] / 255, a.tint[1] / 255, a.tint[2] / 255).multiplyScalar(0.35 + 0.65 * L);
  for (const c of sky3.clouds) {
    const az = c.az + sec * c.drift;
    placeSky(c.s, -Math.cos(az), c.el, Math.sin(az));
    c.s.material.color.copy(COL);
  }
}

// =================================================================================================================
//  frame
// =================================================================================================================
export function render(now) {
  if (!gl || !G.P) return;
  const t0 = performance.now();
  try { frame(now); } catch (e) { console.error('[fp] frame failed:', e); }
  stats.ms = performance.now() - t0;
}

function frame(now) {
  const P = G.P;
  const dt = Math.max(1, Math.min(60, now - lastNow)); lastNow = now;
  animating = false;

  const sig = [G.turn, P.x, P.y, G.dg ? 'd' : 'o', artVer, P.camp ? P.camp.x + ',' + P.camp.y : ''].join('|');
  if (sig !== builtSig) { buildWorld(); builtSig = sig; }

  // camera position: ease toward the hero's tile
  const moving = glide(now, dt);
  const tz = standY(P.x, P.y) + EYE;
  if (snap) { camZ = tz; snap = false; }
  else {
    camZ += (tz - camZ) * (1 - Math.exp(-dt / 60));
    if (Math.abs(tz - camZ) > 0.005) animating = true;
  }
  camX = px + Math.sin(yaw) * BACK; camY = py + Math.cos(yaw) * BACK;
  const ky = 1 - Math.exp(-dt / YAW_TAU);
  yaw += (yawT - yaw) * ky; pitch += (pitchT - pitch) * ky;
  if (Math.abs(yawT - yaw) > 0.002 || Math.abs(pitchT - pitch) > 0.002) animating = true; else { yaw = yawT; pitch = pitchT; }
  const bob = moving ? Math.abs(Math.sin(phase * Math.PI)) * 0.03 : 0;
  const sk = shake(), sx = sk ? (sk.x || 0) * 0.004 : 0, sy = sk ? (sk.y || 0) * 0.004 : 0;
  camera.position.set(camX + sx * Math.cos(yaw), camZ + bob + sy, camY - sx * Math.sin(yaw));
  const kick = Math.max(0, 1 - (performance.now() - kickT0) / 160);
  camera.rotation.set(pitch + 0.05 * kick * kick, yaw, 0);
  if (kick > 0) animating = true;
  torch.position.copy(camera.position);

  updateLight();
  updateSky();
  if (performance.now() < stopUntil) { simShift += dt; animating = true; }   // hit-stop: creature tweens hold still
  buildSprites(now - simShift);
  if (combatActive()) animating = true;
  updateHud3d(yaw, performance.now(), centerTile);
  // gentle liquid shimmer
  for (const m of meshes.values()) if (m.liquid && m.mesh.material.map) m.mesh.material.map.offset.set((now / 4000) % 1, (now / 6000) % 1);

  gl.render(scene, camera);
  drawEffects();
}

// ---- effects (render/fx.js) on the transparent overlay canvas, projected through the 3D camera ----------------------
const FXV = new THREE.Vector3();
const fxView = { S: 3, ox: 0, oy: 0, w: 1, h: 1, dpr: 1, toScreen: null };
fxView.toScreen = (x, y) => {
  // the hero's own tile is under the camera: their numbers rise from the lower middle of the screen
  if (Math.round(x) === G.P.x && Math.round(y) === G.P.y) return { x: ov.width / 2, y: ov.height * 0.86, k: fxS * 0.9 };
  FXV.set(x, standY(Math.round(x), Math.round(y)), y);
  const dist = FXV.distanceTo(camera.position);
  FXV.project(camera);
  if (FXV.z > 1 || FXV.z < -1) return { x: -1e5, y: -1e5, k: 1 };
  // art px -> device px at this depth: billboards use PX art px per world unit
  const ppu = ov.height / (2 * Math.tan(camera.fov * Math.PI / 360) * Math.max(0.3, dist));
  // 0.6: the 2.5D lifts clear an isometric head; billboards are drawn shorter per art px. Capped so a monster in your
  // face does not throw its numbers off the top of the screen.
  const k = Math.min(fxS * 2.2, ppu / PX * 0.6);
  return { x: (FXV.x + 1) / 2 * ov.width, y: Math.max(ov.height * 0.12 + 52 * k, (1 - FXV.y) / 2 * ov.height), k };
};
function drawEffects() {
  if (!octx) return;
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.clearRect(0, 0, ov.width, ov.height);
  fxView.S = fxS; fxView.w = ov.width; fxView.h = ov.height; fxView.dpr = dpr;
  drawFx(octx, fxView, 'world');
  drawMonsterBars();
  const a = ambient();
  drawCombat(octx, ov.width, ov.height, yaw, phase, G.dg ? 0.75 : (a.light ?? 1));
  drawFx(octx, fxView, 'overlay');
}

// threat rings at the feet + HP bars over the head (as the 2.5D view draws them), for monsters within 10 tiles
const BV = new THREE.Vector3();
function proj(x, y, z) {
  BV.set(x, z, y);
  const dist = BV.distanceTo(camera.position);
  BV.project(camera);
  if (BV.z > 1 || BV.z < -1) return null;
  return { x: (BV.x + 1) / 2 * ov.width, y: (1 - BV.y) / 2 * ov.height, ppu: ov.height / (2 * Math.tan(camera.fov * Math.PI / 360) * Math.max(0.3, dist)), dist };
}
function drawMonsterBars() {
  const P = G.P;
  for (const m of G.mons || []) {
    if (Math.abs(m.x - P.x) > 10 || Math.abs(m.y - P.y) > 10 || !shown(m)) continue;
    const r = disp.get(m), x = r ? r.x : m.x, y = r ? r.y : m.y;
    const z0 = (isDeep(m.x, m.y) ? -0.35 : standY(m.x, m.y)) - curve(x - P.x, y - P.y);
    const feet = proj(x, y, z0); if (!feet) continue;
    let col = '#fff'; try { col = con(m).color || '#fff'; } catch (e) { /* ignore */ }
    const rx = 0.42 * feet.ppu * (m.boss ? 1.4 : 1), ry = rx * Math.max(0.12, Math.min(0.5, EYE / feet.dist));
    octx.lineWidth = Math.max(2, rx * 0.08);
    octx.strokeStyle = '#2a0a3a'; octx.beginPath(); octx.ellipse(feet.x, feet.y, rx + 1.5, ry + 1.5, 0, 0, Math.PI * 2); octx.stroke();
    octx.strokeStyle = col; octx.beginPath(); octx.ellipse(feet.x, feet.y, rx, ry, 0, 0, Math.PI * 2); octx.stroke();
    if (m.hp < m.max) {
      const spr = assets.sprite(assets.monSpriteId(m)), hgt = spr.ay / PX * (m.boss ? 1.25 : 0.9);
      const head = proj(x, y, z0 + hgt + 0.12); if (!head) continue;
      const bw = Math.max(26, 0.8 * head.ppu * (m.boss ? 1.5 : 1)), bh = Math.max(4, bw * 0.12), f = Math.max(0, m.hp / m.max);
      const bx = Math.round(head.x - bw / 2), by = Math.round(head.y - bh);
      octx.fillStyle = '#1a1023'; octx.fillRect(bx - 2, by - 2, bw + 4, bh + 4);
      octx.fillStyle = f > .5 ? '#7dff8a' : f > .25 ? '#ffd23f' : '#ff5d6c';
      octx.fillRect(bx, by, Math.max(2, Math.round(bw * f)), bh);
    }
  }
}

/** The tile under the crosshair (screen centre), or null. */
export function centerTile() {
  if (!cv3) return null;
  const r = cv3.getBoundingClientRect();
  return pickTile(r.left + r.width / 2, r.top + r.height / 2);
}

// =================================================================================================================
//  picking + anchoring
// =================================================================================================================
const NDC = new THREE.Vector2();
export function pickTile(clientX, clientY) {
  if (!camera) return null;
  const r = cv3.getBoundingClientRect();
  NDC.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(NDC, camera);
  raycaster.far = DRAW_R + 2;
  const targets = [];
  for (let i = 0; i < spriteN; i++) targets.push(spritePool[i]);
  for (const m of meshes.values()) if (m.n) targets.push(m.mesh);
  const hits = raycaster.intersectObjects(targets, false);
  for (const h of hits) {
    if (h.object.isSprite) { const t = h.object.userData.tile; if (t && !(t.x === G.P.x && t.y === G.P.y)) return { x: t.x, y: t.y }; continue; }
    const m = meshes.get(h.object.userData.key);
    if (m && h.instanceId !== undefined && h.instanceId < m.n) {
      const x = m.tiles[2 * h.instanceId], y = m.tiles[2 * h.instanceId + 1];
      return { x, y };
    }
  }
  // looking at the sky: the tile straight ahead
  const [dx, dy] = relDir(1, 0);
  return { x: G.P.x + dx, y: G.P.y + dy };
}

export function tileToClient(x, y) {
  const r = cv3.getBoundingClientRect();
  V3.set(x, standY(x, y) + 0.4, y).project(camera);
  if (V3.z > 1 || V3.z < -1) return { x: r.left + r.width / 2, y: r.top + r.height * 0.6 };
  return { x: r.left + (V3.x + 1) / 2 * r.width, y: r.top + (1 - V3.y) / 2 * r.height };
}
