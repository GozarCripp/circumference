// world/dungeon.js — every dungeon on the planet: 75 named types (data/dungeons.js), five layout families, ten
// twists, the classic pyramid kept as-is. Port of classic enterPyr / gotoFloor / genFloor / openChest, adapted to G:
//   DG -> G.dg   PYR -> G.pyr (Map<WK(entrance), Dungeon>)   mons/items/seen -> G.mons/G.items/G.seen   P -> G.P
//
// Dungeon: { k, n, d, i, floors:[Floor|null…], type, b, dir, tw:{…twist state}, cl? }
//   type  dungeon type id (old saves without one are 'pyramid')     b  biome index   dir  +1 up / -1 down
//   cl    1 once the final chest was opened
// Floor:   { s, map:string[][], down:[x,y], up:[x,y], mons, items:Map<WK,Item>, seen:Uint8Array(s*s), looted?, keyed? }
//   `down` is always the stairs BACK toward the entrance and `up` the way ON (or the chest on the last floor),
//   whatever the stair art says: in a descending dungeon the way back is drawn as 'up' and the way on as 'down'.
// Entering stashes the overworld in G.P.ow = { x, y, mons, items, npcs, seen, seenW, vis } and swaps the live
// lists for the floor's. Leaving restores them. Every swap ends with world.calcVis() and emit('floor').
//
// Twists (data/dungeons.js TWISTS): dark (vision 4, world.calcVis), flooded (deep pools: monsters cannot follow you
// in, the water bills you every other turn), locked (the way on is ringed by locked doors; a guarded key on the
// floor opens them), collapse (a turn budget per visit; at zero you are thrown out hurt and the place rearranges
// itself), swarm (more monsters, and more keep arriving out of sight), cursed (resting heals nothing), hoard (extra
// loot, extra guards, a richer chest), icy (you slide on ice until something stops you), trapped (hidden spike
// plates), toll (each staircase onward charges gold, or HP when you are broke).
//
// The per-turn twist work is one listener on 'turn' that does nothing outside a dungeon and O(1) inside one
// (the swarm spawn tries a few random tiles once every 8 turns). Listeners are wired at import (bus only; no G access).
import { G, say } from '../core/state.js';
import { emit, on } from '../core/bus.js';
import { WS, BAG } from '../core/config.js';
import { R, pick, WK, wx } from '../core/util.js';
import { h2, dist0, calcVis, blocks, isDeep, isVis, free, monAt, terrKey, siteAtDoor, siteInfo, SITE, dgType } from './world.js';
import { mkMon } from '../game/monsters.js';
import { genGear, gearItem, scrollItem, potionItem, goldItem, pickup, pieces } from '../game/loot.js';
import { randomSpell } from '../game/spells.js';
import { hurt } from '../game/combat.js';
import { DTYPE, TWISTS } from '../data/dungeons.js';

const warned = new Set();
/** Run fn; a throw is logged once and never escapes into a turn. */
function guard(label, fn) {
  try { return fn(); } catch (e) {
    const key = label + ':' + (e && e.message);
    if (!warned.has(key)) { warned.add(key); console.error('[dungeon.' + label + ']', e); }
    return undefined;
  }
}

const ROUGH = ['jfloor', 'sfloor', 'cfloor', 'mfloor', 'pfloor'];   // non-slippery floor per biome (icy patches)
const typeOf = D => (D && DTYPE[D.type]) || DTYPE.pyramid;
const dirOf = D => (D && D.dir === -1 ? -1 : 1);
const curFloor = () => (G.dg ? G.dg.floors[G.dg.i] : null);
const fill = (str, D) => String(str || '').replace('{n}', D ? D.n : '?');

// =====================================================================================================================
// Entering, floors, leaving
// =====================================================================================================================

/** Floors in the pyramid whose entrance is at (x,y): 10 + floor(h2(wx(x), wx(y), 51) * 6). */
export function pyrFloorCount(x, y) { return 10 + Math.floor(h2(wx(x), wx(y), 51) * 6); }

/** Dungeon type of the entrance at (x, y) ('pdoor' tiles outside the site grid count as pyramids). */
function typeAtDoor(x, y) {
  const s = siteAtDoor(x, y);
  return (s && DTYPE[s.type]) || DTYPE.pyramid;
}
/** Floors of the dungeon of type t whose entrance is at (x, y) (seeded, so a door always promises the same). */
export function floorCountAt(x, y, t = typeAtDoor(x, y)) {
  if (t.id === 'pyramid') return pyrFloorCount(x, y);
  const [a, b] = t.floors;
  return a + Math.floor(h2(wx(x), wx(y), 57) * (b - a + 1));
}
const collapseBudget = D => 40 + 70 * D.n;

/** Player just stepped on an entrance ('pdoor' or a 'ddoor*'): create/reuse the Dungeon, stash the overworld, floor 0. */
export function enterPyr() {
  const P = G.P, k = WK(P.x, P.y);
  let D = G.pyr.get(k);
  if (!D) {
    const t = typeAtDoor(P.x, P.y);
    // d must be measured from the overworld, i.e. BEFORE G.dg is set.
    D = { k, n: floorCountAt(P.x, P.y, t), d: dist0(), floors: [], i: 0, type: t.id, b: t.biome, dir: t.dir === 'down' ? -1 : 1, tw: {} };
    if (t.twist === 'collapse') D.tw.left = collapseBudget(D);
    G.pyr.set(k, D);
  }
  if (!D.type) D.type = 'pyramid';
  if (!D.tw) D.tw = {};
  const t = typeOf(D);
  P.ow = { x: P.x, y: P.y, mons: G.mons, items: G.items, npcs: G.npcs, seen: G.seen, seenW: G.seenW, vis: G.vis };
  G.dg = D;
  gotoFloor(0, 'down');
  say(fill(t.enter, D));
  if (t.id !== 'pyramid') {
    say(`${t.name}: ${D.n} ${D.n === 1 ? 'floor' : 'floors'} ${dirOf(D) > 0 ? 'up' : 'down'}. ${t.boss.name} is said to be at the ${dirOf(D) > 0 ? 'top' : 'bottom'}.`, 'zone');
    if (t.twist && TWISTS[t.twist]) say(TWISTS[t.twist].line, 'sys');
    if (t.twist === 'collapse' && !D.cl) say(`By your estimate the ceiling has about ${D.tw.left} turns left in it.`, 'bad');
  }
  emit('dungeon', { kind: 'enter', dtype: t.id, b: t.biome, name: t.name });
}

/** Move to floor i, arriving on its 'down' (back) or 'up' (onward) stairs. i < 0 leaves the dungeon. Idempotent. */
export function gotoFloor(i, arrive) {
  G.auto = null;
  const P = G.P;
  if (i < 0) {
    const o = P.ow, t = typeOf(G.dg);
    if (o) {
      P.x = o.x; P.y = o.y;
      G.mons = o.mons || []; G.items = o.items || new Map(); G.npcs = o.npcs || [];
      G.seen = o.seen || new Uint8Array(WS * WS);
      G.vis = (o.vis && o.vis.length === G.seen.length) ? o.vis : new Uint8Array(G.seen.length);
    }
    G.seenW = WS;
    P.ow = null; G.dg = null;
    say(t.id === 'pyramid' || t.biome === 4 ? 'You step back into daylight. The sun, as ever, does not care.'
      : 'You step back outside. The planet has carried on without you, as is its habit.');
    calcVis();
    emit('floor', { dg: null, i: -1 });
    return;
  }
  const D = G.dg;
  if (!D) return;
  D.i = i;
  if (!D.floors[i]) D.floors[i] = genFloor(i);
  const f = D.floors[i];
  G.mons = f.mons; G.items = f.items; G.npcs = [];
  G.seen = f.seen; G.seenW = f.s; G.vis = new Uint8Array(f.s * f.s);
  const at = f[arrive === 'up' ? 'up' : 'down'];
  P.x = at[0]; P.y = at[1];
  const t = typeOf(D);
  if (t.id === 'pyramid') {
    if (i === D.n - 1) say('The top floor. Something expensive is up here, and something is guarding it.');
    else if (arrive === 'down') say(`Floor ${i + 1}. The ceiling is lower. So are your expectations.`);
  } else if (i === D.n - 1) {
    say(dirOf(D) > 0 ? `The top floor. ${t.boss.name} keeps an office up here, and a chest.`
      : `The bottom. ${t.boss.name} lives down here, with a chest and no plans to share it.`);
  } else if (arrive === 'down' && i > 0) {
    say(dirOf(D) > 0 ? `Floor ${i + 1} of ${D.n}. Higher up, and nobody has made it any nicer.`
      : `Level ${i + 1} of ${D.n}. Deeper, darker, and with worse management.`);
  }
  if (t.twist === 'locked' && !f.keyed && i > 0 && arrive === 'down') say('The way on is locked. The key is somewhere on this floor.', 'sys');
  calcVis();
  emit('floor', { dg: D, i });
}

// =====================================================================================================================
// Generation
// =====================================================================================================================

/** Generate floor i of G.dg. The pyramid keeps the classic generator; every other type goes through genTyped. */
export function genFloor(i) {
  const t = typeOf(G.dg);
  if (t.id === 'pyramid') return genPyramidFloor(i);
  const f = guard('genTyped', () => genTyped(i, t));
  return f || genPyramidFloor(i, t);          // a generator bug must never leave the hero without a floor
}

/** Classic rooms-and-corridors carve on an s x s grid of `wall`. Returns { g, rooms }. */
function carveRooms(s, wall, floor) {
  const g = Array.from({ length: s }, () => Array(s).fill(wall)), rooms = [];
  const maxRooms = Math.max(3, Math.floor(s * s / 130));
  for (let t = 0; t < 200 && rooms.length < maxRooms; t++) {
    const w = 3 + R(Math.min(6, s - 5)), h = 3 + R(Math.min(4, s - 5)), x = 1 + R(s - w - 1), y = 1 + R(s - h - 1);
    if (rooms.some(r => x < r.x + r.w + 1 && x + w + 1 > r.x && y < r.y + r.h + 1 && y + h + 1 > r.y)) continue;
    for (let b = y; b < y + h; b++) for (let a = x; a < x + w; a++) g[b][a] = floor;
    const c = [x + (w >> 1), y + (h >> 1)];
    if (rooms.length) {
      let [px, py] = rooms[rooms.length - 1].c;
      while (px !== c[0] || py !== c[1]) {
        if (px !== c[0] && (R(2) || py === c[1])) px += Math.sign(c[0] - px); else py += Math.sign(c[1] - py);
        g[py][px] = floor;
      }
    }
    rooms.push({ x, y, w, h, c });
  }
  if (!rooms.length) { // vanishingly unlikely; guarantee a playable floor
    const w = Math.min(5, s - 2), h = Math.min(5, s - 2), x = 1, y = 1;
    for (let b = y; b < y + h; b++) for (let a = x; a < x + w; a++) g[b][a] = floor;
    rooms.push({ x, y, w, h, c: [x + (w >> 1), y + (h >> 1)] });
  }
  return { g, rooms };
}

/** The classic pyramid floor (shrinking rooms-and-corridors map; boss + chest on the top floor). Behaviour as v0.2.
 *  `t` is only passed by the emergency fallback for other types (their tiles, same shape). */
function genPyramidFloor(i, t = null) {
  const D = G.dg, n = D.n, W = t ? t.wall : 'pwall', F = t ? t.floor : 'pfloor';
  const s = Math.max(11, 45 - Math.round(i * 34 / Math.max(1, n - 1)));
  const { g, rooms } = carveRooms(s, W, F);
  const top = i === n - 1, last = rooms[rooms.length - 1], a = rooms[0].c, b = rooms.length > 1 ? last.c : [last.x, last.y];
  const up = dirOf(D) > 0;
  g[a[1]][a[0]] = up ? 'down' : 'up'; g[b[1]][b[0]] = top ? 'chest' : up ? 'up' : 'down';
  const f = { s, map: g, down: a, up: b, mons: [], items: new Map(), seen: new Uint8Array(s * s) };
  const used = new Set([a + '', b + '']);
  const spot = rs => {
    for (let k = 0; k < 40; k++) {
      const r = pick(rs), x = r.x + R(r.w), y = r.y + R(r.h);
      if (g[y][x] === F && !used.has(x + ',' + y)) { used.add(x + ',' + y); return [x, y]; }
    }
    return null;
  };
  const d = D.d + i * 25;
  for (let k = 0; k < 2 + Math.floor(s * s / 240); k++) {
    const p = spot(rooms.length > 1 ? rooms.slice(1) : rooms);
    const m = p && mkMon(p[0], p[1], d);
    if (m) f.mons.push(m);
  }
  if (top) {
    const p = spot([last]), m = p && mkMon(p[0], p[1], d, 24);
    if (m) { if (t) nameBoss(m, t); f.mons.push(m); }
  }
  if (R(2) === 0) {
    const p = spot(rooms);
    if (p) f.items.set(WK(p[0], p[1]), potionItem());
  }
  if (R(3) === 0) {
    const p = spot(rooms);
    if (p) f.items.set(WK(p[0], p[1]), gearItem(genGear(Math.floor(d / 30), 0)));
  }
  return f;
}

// ---- layout carvers: Uint8Array grids, 1 = wall, 0 = floor --------------------------------------------------------
function gridFromRooms(s) {
  const { g } = carveRooms(s, 1, 0), u = new Uint8Array(s * s);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) u[y * s + x] = g[y][x];
  return u;
}
function carveMaze(s) {
  const u = new Uint8Array(s * s).fill(1), cw = (s - 1) >> 1;
  const seen = new Uint8Array(cw * cw), stack = [[R(cw), R(cw)]];
  seen[stack[0][1] * cw + stack[0][0]] = 1;
  u[(stack[0][1] * 2 + 1) * s + stack[0][0] * 2 + 1] = 0;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  while (stack.length) {
    const [cx, cy] = stack[stack.length - 1];
    const opts = dirs.filter(([a, b]) => { const nx = cx + a, ny = cy + b; return nx >= 0 && ny >= 0 && nx < cw && ny < cw && !seen[ny * cw + nx]; });
    if (!opts.length) { stack.pop(); continue; }
    const [a, b] = pick(opts), nx = cx + a, ny = cy + b;
    seen[ny * cw + nx] = 1;
    u[(cy * 2 + 1 + b) * s + cx * 2 + 1 + a] = 0;
    u[(ny * 2 + 1) * s + nx * 2 + 1] = 0;
    stack.push([nx, ny]);
  }
  // braid: knock out some walls between corridors so it is a maze, not a single hallway
  for (let y = 1; y < s - 1; y++) for (let x = 1; x < s - 1; x++) {
    if (u[y * s + x] !== 1 || ((x ^ y) & 1) === 0) continue;
    const h = u[y * s + x - 1] === 0 && u[y * s + x + 1] === 0, v = u[(y - 1) * s + x] === 0 && u[(y + 1) * s + x] === 0;
    if ((h || v) && R(100) < 9) u[y * s + x] = 0;
  }
  // two or three small chambers, so fights have somewhere to happen
  for (let k = 0, n = 2 + R(2); k < n; k++) {
    const x0 = 1 + 2 * R(Math.max(1, cw - 2)), y0 = 1 + 2 * R(Math.max(1, cw - 2));
    for (let y = y0; y < Math.min(s - 1, y0 + 3); y++) for (let x = x0; x < Math.min(s - 1, x0 + 3); x++) u[y * s + x] = 0;
  }
  return u;
}
function carveHall(s) {
  const u = new Uint8Array(s * s).fill(1), c = s >> 1, set = (x, y, v) => { if (x > 0 && y > 0 && x < s - 1 && y < s - 1) u[y * s + x] = v; };
  for (let y = c - 2; y <= c + 2; y++) for (let x = 2; x < s - 2; x++) set(x, y, 0);
  for (let x = 4; x < s - 4; x += 4) { set(x, c - 1, 1); set(x, c + 1, 1); }          // two colonnades
  for (let x0 = 3; x0 + 4 < s - 2; x0 += 6) for (const side of [-1, 1]) {
    if (R(4) === 0) continue;
    const w = 3 + R(2), h = 2 + R(4), door = x0 + 1 + R(w - 1);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) set(x0 + i, c + side * (4 + j), 0);
    set(door, c + side * 3, 0);
  }
  if (R(2)) {                                                                          // stand the hall the other way
    const v = new Uint8Array(s * s);
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) v[x * s + y] = u[y * s + x];
    return v;
  }
  return u;
}
function carveCaves(s) {
  for (let tries = 0; tries < 6; tries++) {
    let u = new Uint8Array(s * s);
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) u[y * s + x] = (x === 0 || y === 0 || x === s - 1 || y === s - 1 || Math.random() < .45) ? 1 : 0;
    for (let it = 0; it < 4; it++) {
      const v = new Uint8Array(s * s).fill(1);
      for (let y = 1; y < s - 1; y++) for (let x = 1; x < s - 1; x++) {
        let n = 0;
        for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) if ((a || b) && u[(y + b) * s + x + a]) n++;
        v[y * s + x] = n >= 5 || (it < 2 && n === 0) ? 1 : n <= 3 ? 0 : u[y * s + x];
      }
      u = v;
    }
    // keep only the largest open region
    const lab = new Int32Array(s * s).fill(-1), q = new Int32Array(s * s);
    let best = -1, bestN = 0;
    for (let i = 0; i < s * s; i++) {
      if (u[i] || lab[i] >= 0) continue;
      let qn = 0, qi = 0; q[qn++] = i; lab[i] = i;
      while (qi < qn) {
        const c = q[qi++], x = c % s, y = (c / s) | 0;
        for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
          const nx = x + a, ny = y + b; if (nx < 0 || ny < 0 || nx >= s || ny >= s) continue;
          const ni = ny * s + nx; if (u[ni] || lab[ni] >= 0) continue;
          lab[ni] = i; q[qn++] = ni;
        }
      }
      if (qn > bestN) { bestN = qn; best = i; }
    }
    if (bestN >= s * s * .28) { for (let i = 0; i < s * s; i++) if (lab[i] !== best) u[i] = 1; return u; }
  }
  return gridFromRooms(s);
}

/** 8-way BFS distances over a walk predicate, from (x, y). -1 = unreachable. */
function bfs(s, ok, x, y) {
  const dist = new Int32Array(s * s).fill(-1), q = new Int32Array(s * s);
  let qn = 0, qi = 0; dist[y * s + x] = 0; q[qn++] = y * s + x;
  while (qi < qn) {
    const c = q[qi++], cx = c % s, cy = (c / s) | 0, dc = dist[c] + 1;
    for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
      const nx = cx + a, ny = cy + b; if (nx < 0 || ny < 0 || nx >= s || ny >= s) continue;
      const ni = ny * s + nx; if (dist[ni] >= 0 || !ok(nx, ny)) continue;
      dist[ni] = dc; q[qn++] = ni;
    }
  }
  return dist;
}

function floorSize(t, i, n) {
  const k = Math.min(i, 4);
  switch (t.layout) {
    case 'up': { const base = Math.min(45, 21 + 3 * n); return Math.max(11, base - Math.round(i * (base - 11) / Math.max(1, n - 1))); }
    case 'down': return Math.min(45, 23 + i * 4);
    case 'maze': return t.dir === 'up' ? 33 - 4 * Math.min(i, 3) : 21 + 4 * Math.min(i, 3);   // always odd
    case 'hall': return 29 + 2 * k;
    case 'caves': return 30 + 3 * Math.min(i, 3);
    default: return 31;
  }
}

/** Name and toughen a boss for type t (bestiary entries stay untouched). */
function nameBoss(m, t) {
  m.name = t.boss.name;
  if (t.boss.title) m.title = t.boss.title;
  m.hp = m.max = Math.round(m.max * 1.2);
  m.atk += 1;
  m.dboss = t.id;
}

/** Any non-pyramid floor: carve by layout, then stairs, twist features, monsters, items, boss + chest. */
function genTyped(i, t) {
  const D = G.dg, n = D.n, top = i === n - 1, up = dirOf(D) > 0, s = floorSize(t, i, n);
  const u = t.layout === 'maze' ? carveMaze(s) : t.layout === 'hall' ? carveHall(s) : t.layout === 'caves' ? carveCaves(s) : gridFromRooms(s);
  const W = t.wall, rough = ROUGH[t.biome] || 'pfloor';
  const icy = t.twist === 'icy', patch = new Map();
  const floorAt = (x, y) => {
    if (!icy) return t.floor;
    const k = (x >> 1) + ',' + (y >> 1);
    if (!patch.has(k)) patch.set(k, Math.random() < .2);
    return patch.get(k) ? rough : t.floor;
  };
  const g = Array.from({ length: s }, (_, y) => Array.from({ length: s }, (_, x) => (u[y * s + x] ? W : floorAt(x, y))));
  const cells = [];
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) if (!u[y * s + x]) cells.push([x, y]);

  // stairs: back = a random open cell, onward = the farthest reachable cell from it
  const back = pick(cells);
  const open = (x, y) => !u[y * s + x];
  let dist = bfs(s, open, back[0], back[1]);
  let onward = back, far = 0;
  for (const [x, y] of cells) { const dd = dist[y * s + x]; if (dd > far) { far = dd; onward = [x, y]; } }
  if (onward === back) {                                     // a one-cell floor: make a neighbour walkable
    const x = Math.min(s - 2, back[0] + 1); u[back[1] * s + x] = 0; g[back[1]][x] = t.floor; onward = [x, back[1]];
  }
  g[back[1]][back[0]] = up ? 'down' : 'up';
  g[onward[1]][onward[0]] = top ? 'chest' : up ? 'up' : 'down';
  const isStair = (x, y) => (x === back[0] && y === back[1]) || (x === onward[0] && y === onward[1]);
  const near = (x, y, p, r) => Math.max(Math.abs(x - p[0]), Math.abs(y - p[1])) <= r;
  const plain = (x, y) => !u[y * s + x] && !isStair(x, y) && (g[y][x] === t.floor || g[y][x] === rough);

  const f = { s, map: g, down: back, up: onward, mons: [], items: new Map(), seen: new Uint8Array(s * s) };
  const tw = t.twist, used = new Set([back + '', onward + '']);

  // ---- twists that reshape the floor -----------------------------------------------------------------------------
  if (tw === 'flooded') {
    const nb = 2 + Math.floor(cells.length / 150);
    for (let k = 0; k < nb; k++) {
      const c = pick(cells), rad = 2 + R(2);
      if (near(c[0], c[1], back, 3) || near(c[0], c[1], onward, 2)) continue;
      for (let y = c[1] - rad; y <= c[1] + rad; y++) for (let x = c[0] - rad; x <= c[0] + rad; x++) {
        if (x < 1 || y < 1 || x >= s - 1 || y >= s - 1 || !plain(x, y) || near(x, y, back, 1) || near(x, y, onward, 1)) continue;
        const r = Math.hypot(x - c[0], y - c[1]);
        if (r <= rad * .6) g[y][x] = 'deep'; else if (r <= rad + .3) g[y][x] = 'water';
      }
    }
  }
  if (tw === 'trapped') {
    const nt = Math.max(3, Math.round(cells.length * .035));
    for (let k = 0, tries = 0; k < nt && tries < nt * 20; tries++) {
      const [x, y] = pick(cells);
      if (!plain(x, y) || near(x, y, back, 2) || near(x, y, onward, 1)) continue;
      g[y][x] = 'trap'; k++;
    }
  }
  let reach = dist;
  if (tw === 'locked') {
    for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
      const x = onward[0] + a, y = onward[1] + b;
      if ((a || b) && x > 0 && y > 0 && x < s - 1 && y < s - 1 && !u[y * s + x] && !isStair(x, y)) g[y][x] = 'dlock';
    }
    reach = bfs(s, (x, y) => !u[y * s + x] && g[y][x] !== 'dlock', back[0], back[1]);
    let best = null, bd = -1;
    const maxd = Math.max(1, far);
    for (const [x, y] of cells) {
      const dd = reach[y * s + x];
      if (dd < 3 || !plain(x, y) || g[y][x] === 'trap') continue;
      const score = dd >= maxd * .45 ? dd + Math.random() * maxd * .6 : dd * .3;
      if (score > bd) { bd = score; best = [x, y]; }
    }
    if (best) { g[best[1]][best[0]] = 'dkey'; used.add(best + ''); f.key = best; }
    else for (let b = 0; b < s; b++) for (let a = 0; a < s; a++) if (g[b][a] === 'dlock') g[b][a] = 'dopen';   // nowhere to put a key
  }

  // ---- inhabitants ----------------------------------------------------------------------------------------------------
  const spots = cells.filter(([x, y]) => reach[y * s + x] >= 4 && plain(x, y) && !used.has(x + ',' + y));
  const spot = () => {
    for (let k = 0; k < 30 && spots.length; k++) {
      const j = R(spots.length), p = spots[j];
      spots[j] = spots[spots.length - 1]; spots.pop();
      if (!used.has(p + '')) { used.add(p + ''); return p; }
    }
    return null;
  };
  const d = D.d + i * 20;
  let nm = 2 + Math.floor(cells.length / 110);
  if (tw === 'swarm') nm = Math.round(nm * 1.5) + 2;
  if (tw === 'hoard') nm += 2;
  for (let k = 0; k < nm; k++) { const p = spot(); const m = p && mkMon(p[0], p[1], d); if (m) f.mons.push(m); }
  if (f.key) {                                                // someone is minding the key
    for (const [a, b] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1]]) {
      const x = f.key[0] + a, y = f.key[1] + b;
      if (x > 0 && y > 0 && x < s - 1 && y < s - 1 && plain(x, y) && !used.has(x + ',' + y)) {
        used.add(x + ',' + y); const m = mkMon(x, y, d + 15); if (m) f.mons.push(m); break;
      }
    }
  }
  if (top) {
    const fromChest = bfs(s, (x, y) => !u[y * s + x] && g[y][x] !== 'dlock', onward[0], onward[1]);
    let bp = null;
    for (const r of [2, 3, 1, 4, 5, 6]) {
      const c = cells.filter(([x, y]) => (fromChest[y * s + x] === r || (tw === 'locked' && reach[y * s + x] >= 0 && near(x, y, onward, r + 1)))
        && plain(x, y) && !used.has(x + ',' + y));
      if (c.length) { bp = pick(c); break; }
    }
    if (!bp) bp = spot();
    if (bp) { used.add(bp + ''); const m = mkMon(bp[0], bp[1], d, 24); if (m) { nameBoss(m, t); f.mons.push(m); } }
  }

  // ---- items ----------------------------------------------------------------------------------------------------------
  const put = it => { const p = spot(); if (p && it) f.items.set(WK(p[0], p[1]), it); };
  if (R(2) === 0) put(potionItem());
  if (R(3) === 0) put(gearItem(genGear(Math.floor(d / 30), 0)));
  if (tw === 'hoard') {
    put(goldItem()); put(goldItem()); put(goldItem()); put(potionItem());
    if (R(2) === 0) put(gearItem(genGear(Math.floor(d / 30) + 1, 0)));
  }
  return f;
}

// =====================================================================================================================
// Stepping inside a dungeon (called from turn.step after the hero moved)
// =====================================================================================================================

/** The hero just moved by (dx, dy) inside a dungeon: ice, traps, keys, stairs, chest. */
export function dungeonStep(dx, dy) {
  const D = G.dg, P = G.P;
  if (!D) return;
  const t = typeOf(D);
  if (t.twist === 'icy' && (dx || dy)) guard('slide', () => slide(dx, dy));
  if (G.over || G.dg !== D) return;
  const tk = terrKey(P.x, P.y);
  if (tk === 'trap') guard('trap', springTrap);
  else if (tk === 'dkey') guard('key', takeKey);
  else if (tk === 'up' || tk === 'down') guard('stairs', () => useStairs(tk));
  else if (tk === 'chest') guard('chest', openChest);
}

/** Icy floors: keep going in (dx, dy) until something that is not ice, or something solid, stops you. */
function slide(dx, dy) {
  const P = G.P;
  let n = 0;
  while (n < 12 && terrKey(P.x, P.y) === 'ice') {
    const nx = P.x + dx, ny = P.y + dy;
    if (!free(nx, ny) || isDeep(nx, ny)) {
      const m = monAt(nx, ny);
      if (n && m) say(`You slide into ${m.name}. Neither of you comes out of it with any dignity.`);
      break;
    }
    const from = { x: P.x, y: P.y };
    P.x = nx; P.y = ny; n++;
    emit('moved', { from, to: { x: nx, y: ny } });
    pickup();
    const k = terrKey(nx, ny);
    if (k === 'up' || k === 'down' || k === 'chest' || k === 'dkey' || k === 'trap') break;
  }
  if (n >= 3 && R(3) === 0) say(pick(['You slide. Gracefully, if anyone asks.', 'Physics takes over. Physics has never liked you.', 'You skate the full length of the room on your dignity.']));
}

function springTrap() {
  const D = G.dg, P = G.P, f = curFloor();
  if (!f) return;
  f.map[P.y][P.x] = 'trapd';
  emit('terrain', { x: P.x, y: P.y, from: 'trap', to: 'trapd' });
  hurt({ name: 'a spike trap', col: '#d8d8d8' }, 2 + D.i + Math.floor(D.d / 40),
    pick(['Spikes come up out of the floor, as they had planned to all along.', 'The floor was a lie. The spikes were honest.', 'Click. Spikes. The architect would be thrilled.']), 'trap');
}

function takeKey() {
  const P = G.P, f = curFloor(), t = typeOf(G.dg);
  if (!f) return;
  f.map[P.y][P.x] = t.twist === 'icy' ? 'ice' : t.floor;
  let opened = 0;
  for (const row of f.map) for (let x = 0; x < row.length; x++) if (row[x] === 'dlock') { row[x] = 'dopen'; opened++; }
  f.keyed = 1;
  say(opened ? 'You take the key. Somewhere on this floor, a set of locks gives up and swings open.' : 'You take the key. It fits nothing. Very on brand.', 'good');
  emit('terrain', { x: P.x, y: P.y, from: 'dkey', to: f.map[P.y][P.x] });
}

/** Stairs: onward (toward the boss) or back (toward the exit), whatever the art. */
function useStairs(tk) {
  const D = G.dg, onward = dirOf(D) > 0 ? tk === 'up' : tk === 'down';
  if (onward) {
    if (D.i >= D.n - 1) return;
    if (typeOf(D).twist === 'toll' && !payToll(D)) return;
    gotoFloor(D.i + 1, 'down');
  } else gotoFloor(D.i - 1, 'up');
}

/** Toll: gold if you have it, HP if you don't. Returns false if it killed you. */
function payToll(D) {
  const P = G.P, cost = 5 + 4 * D.i + Math.floor(D.d / 12);
  if (P.gold >= cost) {
    P.gold -= cost;
    say(`A brass box by the stairs takes ${cost} gold. No receipt is offered. You did not ask.`, 'loot');
    return true;
  }
  const short = cost - P.gold;
  if (P.gold > 0) say(`The brass box takes your last ${P.gold} gold and indicates that this is a start.`);
  P.gold = 0;
  hurt({ name: 'an itemised toll', col: '#ffd23f' }, Math.max(2, Math.min(Math.ceil(short / 5), Math.ceil(P.max / 4))), 'You are short. The difference is collected in a more personal currency.', 'toll');
  return !G.over;
}

// =====================================================================================================================
// The chest
// =====================================================================================================================

/** Nearest tile around the hero (hero's own tile last) with no item on it that is not a wall. */
function dropSpot() {
  const P = G.P, f = G.dg && G.dg.floors[G.dg.i];
  const ok = (x, y) => {
    if (f && (x < 0 || y < 0 || x >= f.s || y >= f.s)) return false;
    return !blocks(x, y) && !isDeep(x, y) && !G.items.has(WK(x, y));
  };
  const ring = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
  for (const [dx, dy] of ring) if (ok(P.x + dx, P.y + dy)) return [P.x + dx, P.y + dy];
  return [P.x + 1, P.y];
}

/** Player stepped on the chest: gold + boss-quality items + one scroll, once. Emits 'chest' and 'dungeon' clear. */
export function openChest() {
  const D = G.dg, P = G.P;
  if (!D) return;
  const f = D.floors[D.i];
  if (!f) return;
  if (f.looted) { say('The chest is empty. You already robbed it. Twice, emotionally.'); return; }
  f.looted = 1;
  const t = typeOf(D), L = t.loot || { gold: [50, 99], gearBonus: 0 };
  const gold = L.gold[0] + R(L.gold[1] - L.gold[0] + 1) + Math.floor(D.d);
  P.gold += gold;
  say(t.id === 'pyramid' ? `The chest holds ${gold} gold and a note: "If found, please return to the afterlife."`
    : `The chest holds ${gold} gold and a note from ${t.boss.name}: "${pick(CHEST_NOTES)}"`, 'loot');
  const nGear = t.twist === 'hoard' ? 3 : 2;
  for (let k = 0; k < nGear; k++) {
    const it = genGear(Math.floor(D.d / 30) + D.n + (L.gearBonus || 0), 1);
    if (P.inv.length < BAG) { P.inv.push(it); say(`You take the ${it.name}.`, 'loot'); }
    else { const [x, y] = dropSpot(); G.items.set(WK(x, y), gearItem(it)); say('Your bag is full. Something stays behind.'); }
  }
  // Bonus: a scroll. It lies on a free adjacent tile; stepping on it reads it (loot.pickup).
  const sc = scrollItem(randomSpell());
  const [sx, sy] = dropSpot();
  G.items.set(WK(sx, sy), sc);
  say('A scroll flutters out of the chest and lands nearby. It looks pleased with itself.', 'loot');
  emit('chest', { gold, dtype: t.id, b: t.biome });
  if (!D.cl) {
    D.cl = 1;
    if (t.id !== 'pyramid') say(`${t.name} is cleared. Nobody will update the sign.`, 'good');
    emit('dungeon', { kind: 'clear', dtype: t.id, b: t.biome, name: t.name });
  }
}
const CHEST_NOTES = [
  'This chest is the property of management. Please do not remove it from the premises.',
  'If you are reading this, I have been let go.',
  'All contents are non-refundable and, legally, imaginary.',
  'Do not tell the shareholders.',
  'To whoever finds this: the password is also in here. Do not read it.',
  'Please rate your looting experience from one to five.',
];

// =====================================================================================================================
// Twists that act every turn
// =====================================================================================================================
let lastHp = -1, lastTurn = -1, cursedSaid = -999, curD = null;

function onTurn(e) {
  const D = G.dg, P = G.P;
  if (!D || G.over || !P) { lastTurn = -1; return; }
  const t = typeOf(D), tw = t.twist;
  if (tw === 'collapse') tickCollapse(D, t);
  else if (tw === 'flooded') {
    if (isDeep(P.x, P.y) && G.turn % 2 === 0) {
      const heavy = (guard('pieces', pieces) || {}).heavy || 0;
      hurt({ name: 'the water rates', col: '#3f76e4' }, 1 + (heavy >= 2 ? 1 : 0),
        heavy >= 2 ? 'The water bills you, with a surcharge for the armour.' : 'The water takes its cut.', 'drown');
    }
  } else if (tw === 'swarm') {
    if (G.turn % 8 === 0) swarmSpawn(D);
  } else if (tw === 'cursed') {
    if (e && e.resting && lastTurn === G.turn - 1 && lastHp >= 0 && lastHp < P.max && P.hp > 1) P.hp -= 1;   // undo the rest heal
    if (e && e.resting && G.auto && G.auto.kind === 'rest') {
      G.auto = null; emit('auto', { auto: null });
      if (G.turn - cursedSaid > 15) { cursedSaid = G.turn; say('You try to rest. The curse declines your application.', 'bad'); }
    }
  }
  lastHp = P.hp; lastTurn = G.turn;
}

function tickCollapse(D, t) {
  if (D.cl) return;
  if (!(D.tw.left > 0)) D.tw.left = collapseBudget(D);
  D.tw.left--;
  const left = D.tw.left, full = collapseBudget(D);
  if (left === Math.floor(full / 2)) say('Dust sifts down from the ceiling. It is about half way through its notice period.', 'bad');
  else if (left === 40) say('A beam groans. You estimate forty turns before the ceiling makes its decision final.', 'bad');
  else if (left === 15) say('Pieces of ceiling are now arriving independently. Fifteen turns, at most.', 'bad');
  else if (left === 5) say('Five turns. The building is clearing its desk.', 'bad');
  if (left > 0) return;
  hurt({ name: 'a falling ceiling', col: '#8c8c8c' }, Math.max(3, Math.ceil(G.P.max * .2)),
    'The ceiling comes down. You are expelled through a gap with the efficiency of a redundancy.', 'crush');
  if (G.over || G.dg !== D) return;      // insurance may already have moved the hero out
  D.floors = []; D.i = 0; D.tw.left = full;
  gotoFloor(-1);
  say(`${t.name} settles into a new shape behind you. Whatever you mapped in there is no longer accurate.`, 'sys');
}

function swarmSpawn(D) {
  const f = curFloor(), P = G.P;
  if (!f) return;
  if (!f.cap) f.cap = f.mons.length + 6;
  if (G.mons.length >= f.cap) return;
  for (let k = 0; k < 50; k++) {
    const x = 1 + R(f.s - 2), y = 1 + R(f.s - 2), key = f.map[y][x];
    if (key === 'deep' || blocks(x, y) || !free(x, y) || isVis(x, y) || Math.max(Math.abs(x - P.x), Math.abs(y - P.y)) < 8) continue;
    if (key === 'up' || key === 'down' || key === 'chest' || key === 'dkey') continue;
    const m = mkMon(x, y, D.d + D.i * 20);
    if (m) {
      G.mons.push(m);
      if (!f.sw) { f.sw = 1; say('Somewhere on this floor, a door opens and someone new starts their first day.'); }
    }
    return;
  }
}

/** 'leave' fires for every exit (stairs, collapse, the insurance adjuster's shortcut), from the 'floor' event. */
function onFloor(e) {
  if (e && e.dg) { curD = e.dg; return; }
  if (curD) {
    const t = typeOf(curD);
    curD = null;
    emit('dungeon', { kind: 'leave', dtype: t.id, b: t.biome, name: t.name });
  }
}

let wired = false;
/** Wire the twist listeners (idempotent; also called at import). */
export function initDungeons() {
  if (wired) return;
  wired = true;
  on('turn', e => guard('turn', () => onTurn(e)));
  on('floor', e => guard('floor', () => onFloor(e)));
  on('loaded', () => { curD = G.dg || null; lastTurn = -1; });
  on('newgame', () => { curD = null; lastTurn = -1; });
}
initDungeons();

// =====================================================================================================================
// Queries for other modules
// =====================================================================================================================

/** Nearest dungeon entrance to (x, y) within maxR tiles (torus distance), in coordinates near (x, y):
 *  { x, y, name, dtype, biome, entered, cleared } or null. Cheap: at most ~81 cached site cells. */
export function nearestSite(x, y, maxR = 120) {
  return guard('nearestSite', () => {
    const ax = wx(x), ay = wx(y), c0x = Math.floor(ax / SITE), c0y = Math.floor(ay / SITE), cr = Math.min(8, Math.ceil(maxR / SITE) + 1);
    let best = null, bd = Infinity;
    for (let cy = c0y - cr; cy <= c0y + cr; cy++) for (let cx = c0x - cr; cx <= c0x + cr; cx++) {
      const s = siteInfo(cx, cy);
      if (!s) continue;
      let dx = s.dx - ax, dy = s.dy - ay;
      dx -= Math.round(dx / WS) * WS; dy -= Math.round(dy / WS) * WS;
      const dd = Math.hypot(dx, dy);
      if (dd > maxR || dd >= bd) continue;
      bd = dd;
      const t = DTYPE[s.type], D = G.pyr && G.pyr.get(WK(s.dx, s.dy));
      best = { x: x + dx, y: y + dy, name: t.name, dtype: t.id, biome: t.biome, entered: !!D, cleared: !!(D && D.cl) };
    }
    return best;
  }) || null;
}

/** The current dungeon's display name, or null on the overworld. */
export function dungeonName() { return G.dg ? (typeOf(G.dg).id === 'pyramid' ? 'Pyramid' : typeOf(G.dg).name) : null; }

/** Inspect-popup note for an entrance tile. */
export function siteNote(x, y) {
  const t = typeAtDoor(x, y), n = floorCountAt(x, y, t), D = G.pyr && G.pyr.get(WK(x, y));
  if (t.id === 'pyramid') return `${n} floors up, each smaller and more serious than the last. Step in to enter.`;
  const tw = t.twist && TWISTS[t.twist] ? ` Word is it is ${TWISTS[t.twist].name.toLowerCase()}.` : '';
  return `${t.name}. ${n} ${n === 1 ? 'floor' : 'floors'} ${t.dir === 'down' ? 'down' : 'up'}.${tw}${D && D.cl ? ' Cleared, by you, allegedly.' : ''} Step in to enter.`;
}

/** Inspect-popup note for a dungeon-feature tile (stairs, chest, doors, key, traps), or ''. */
export function featureNote(k) {
  const D = G.dg;
  if (k === 'up' || k === 'down') {
    if (!D) return 'Stairs. Step on it to use it.';
    const onward = dirOf(D) > 0 ? k === 'up' : k === 'down';
    if (onward) return `${dirOf(D) > 0 ? 'Up' : 'Down'}, toward the treasure.${typeOf(D).twist === 'toll' ? ' There is a coin slot.' : ''} Step on it to use it.`;
    return `${D.i === 0 ? 'The way out.' : 'Back the way you came.'} Step on it to use it.`;
  }
  if (k === 'chest') return 'Step on it. You have earned this, legally speaking.';
  if (k === 'dlock') return 'Locked. The key is somewhere on this floor, being looked after by someone with a grudge.';
  if (k === 'dopen') return 'Unlocked, and slightly ajar, as if embarrassed.';
  if (k === 'dkey') return 'A key. Step on it to take it. It opens the locked doors on this floor.';
  if (k === 'trapd') return 'A sprung spike trap. It has done its job and is now harmless, like most retirees.';
  return '';
}
