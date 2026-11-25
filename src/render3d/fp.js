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

// ---- tunables ------------------------------------------------------------------------------------------------------
const DRAW_R = 22;               // tiles drawn around the hero
const CAP = 2400;                // instance capacity per terrain key
const ZG = 0.11;                 // world units per ZU for ground and terraces
const ZS = 0.24;                 // world units per ZU for solid columns (rocks, pyramid steps)
const WALL_H = 1.9;              // castle and dungeon walls
const EYE = 0.62;                // eye height above the ground under the hero
const PX = 26;                   // art pixels per world unit for billboards
const YAW_TAU = 70, POS_TAU = TIMING.tween;
const MEMORY = new THREE.Color(0.34, 0.36, 0.48);   // tint of tiles remembered but not in sight
const STEP = Math.PI / 4;

// ---- state ---------------------------------------------------------------------------------------------------------
let gl = null, scene = null, camera = null, cv3 = null;
let sun = null, hemi = null, torch = null;
const meshes = new Map();        // terrain key -> { mesh, tiles: Int32Array(2 * CAP), n }
const boxGeo = new THREE.BoxGeometry(1, 1, 1);
let yaw = 0, yawT = 0, pitch = -0.06, pitchT = -0.06;
let camX = 0, camY = 0, camZ = 0, snap = true, lastNow = 0, animating = false;
let builtSig = '', artVer = 0, dpr = 1, fovBase = 72, zoom = 0;
const stats = { tiles: 0, sprites: 0, ms: 0 };
const raycaster = new THREE.Raycaster();

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

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(fovBase, 1, 0.05, 80);
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
  on('hurt', e => { if (e && e.by && e.by.x !== undefined) faceToward(e.by.x, e.by.y); });
  resize();
  return true;
}

export function resize() {
  if (!gl) return;
  const w = Math.max(1, innerWidth), h = Math.max(1, innerHeight);
  dpr = Math.min(2, window.devicePixelRatio || 1);
  gl.setPixelRatio(dpr * 0.75);               // a little under native: chunky, fast, matches the pixel art
  gl.setSize(w, h, false);
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

/** Turn by n eighths of a circle (+ = left), snapping to the 45° grid. */
export function turnBy(n) { yawT = Math.round(yawT / STEP) * STEP + n * STEP; pitchT = -0.06; }
function faceToward(x, y) {
  const P = G.P; if (!P) return;
  const dx = x - P.x, dy = y - P.y; if (!dx && !dy) return;
  const want = Math.atan2(-dx, -dy);
  let d = want - yawT; d = Math.atan2(Math.sin(d), Math.cos(d));
  if (Math.abs(d) > STEP * 1.5) yawT += d;       // only turn for attacks from well off to the side
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
  const h = Math.max(0.02, top - bottom);
  M4.compose(V3.set(x, bottom + h / 2, y), Q, SC.set(1, h, 1));
  m.mesh.setMatrixAt(m.n, M4);
  m.mesh.setColorAt(m.n, vis ? COL.setRGB(1, 1, 1) : MEMORY);
  m.tiles[2 * m.n] = x; m.tiles[2 * m.n + 1] = y;
  m.n++;
}

/** Surface height (world units) a creature stands on at tile (x, y). */
function standY(x, y) {
  if (!isSeen(x, y)) return 0;
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
    if (ddx * ddx + ddy * ddy > DRAW_R * DRAW_R || !isSeen(x, y)) continue;
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
    if (d.kind === 'prop' && !(x === P.x && y === P.y)) props.push({ spr: assets.sprite('prop/' + d.key, hashv(x, y)), x, y, z: top, vis, sc: d.tall ? 1.35 : 0.6 });
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
  s.position.set(x, z, y);
  e.mat.color.copy(dim ? MEMORY : COL.setRGB(1, 1, 1));
  s.userData.tile = tag;
  return s;
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
    if (Math.abs(ux - P.x) > 20 || Math.abs(uy - P.y) > 20 || !isVis(ux, uy)) return;
    billboard(assets.sprite(assets.itemSpriteId(it)), ux, uy, standY(ux, uy) + 0.04 * Math.sin(now / 300 + ux), false, { x: ux, y: uy }, 0.8);
  });
  for (const n of G.npcs || []) {
    if (Math.abs(n.x - P.x) > 20 || Math.abs(n.y - P.y) > 20) continue;
    const r = track(n, now);
    if (!isVis(n.x, n.y)) continue;
    billboard(assets.sprite('npc/' + (n.look || n.id)), r.x, r.y, standY(n.x, n.y), false, { x: n.x, y: n.y }, 1.2);
  }
  for (const m of G.mons || []) {
    if (Math.abs(m.x - P.x) > 18 || Math.abs(m.y - P.y) > 18) continue;
    const r = track(m, now);
    if (!shown(m)) continue;
    const z = isDeep(m.x, m.y) ? -0.35 : standY(m.x, m.y);
    billboard(assets.sprite(assets.monSpriteId(m)), r.x, r.y, z, false, { x: m.x, y: m.y }, m.boss ? 1.6 : 1.2);
  }
  for (let i = spriteN; i < spritePool.length; i++) spritePool[i].visible = false;
  stats.sprites = spriteN;
}

// =================================================================================================================
//  light, sky, fog
// =================================================================================================================
const SKY_DAY = new THREE.Color(0x8fb6e6), SKY_NIGHT = new THREE.Color(0x0d0a26), TOMB = new THREE.Color(0x0a0710);
const tint = new THREE.Color(), sky = new THREE.Color();
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
    scene.fog.near = 4; scene.fog.far = Math.min(DRAW_R, (a.radius || 9) * 2 + 2);
  }
  scene.fog.color.copy(sky);
  gl.setClearColor(sky);
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
  const hr = track(P, now);
  const tx = hr.x, ty = hr.y, tz = standY(P.x, P.y) + EYE;
  if (snap) { camX = tx; camY = ty; camZ = tz; snap = false; }
  else {
    const k = 1 - Math.exp(-dt / 60);
    camX = tx; camY = ty; camZ += (tz - camZ) * k;
    if (Math.abs(tz - camZ) > 0.005) animating = true;
  }
  const ky = 1 - Math.exp(-dt / YAW_TAU);
  yaw += (yawT - yaw) * ky; pitch += (pitchT - pitch) * ky;
  if (Math.abs(yawT - yaw) > 0.002 || Math.abs(pitchT - pitch) > 0.002) animating = true; else { yaw = yawT; pitch = pitchT; }
  const bob = hr.t0 >= 0 ? Math.sin(Math.min(1, (now - hr.t0) / POS_TAU) * Math.PI) * 0.035 : 0;
  camera.position.set(camX, camZ + bob, camY);
  camera.rotation.set(pitch, yaw, 0);
  torch.position.copy(camera.position);

  updateLight();
  buildSprites(now);
  // gentle liquid shimmer
  for (const m of meshes.values()) if (m.liquid && m.mesh.material.map) m.mesh.material.map.offset.set((now / 4000) % 1, (now / 6000) % 1);

  gl.render(scene, camera);
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
