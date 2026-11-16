// render/iso.js — the isometric projection. Pure math in logical art pixels (no camera, no zoom).
//
//   +x runs down-right on screen, +y runs down-left, +z lifts straight up.
//   A tile (x,y) at height z is a 32x16 diamond whose CENTRE is tileCenter(x,y,z).
//   Draw order is back-to-front by depth(x,y) = x + y; ties are independent (draw in x order).
//   The two visible side faces of a block are its +y face (screen left, lit medium) and its +x face (screen right, darkest).
import { HW, HH, ZU } from '../core/config.js';

/** Logical-pixel centre of the top face of tile (x,y) lifted z height units. x/y may be fractional (tweens). */
export function tileCenter(x, y, z = 0) {
  return { x: (x - y) * HW, y: (x + y) * HH + HH - z * ZU };
}

/** Inverse of tileCenter on the plane of height z: logical pixel -> fractional tile coords. floor() them for the tile. */
export function screenToTile(px, py, z = 0) {
  const v = (py + z * ZU) / HH, u = px / HW;
  return { x: (u + v) / 2, y: (v - u) / 2 };
}

/** Painter's-algorithm key. Larger = nearer the viewer = drawn later. */
export const depth = (x, y) => x + y;

/** 8 neighbours in classic order. */
export const DIRS8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

/** Keyboard -> grid delta, SCREEN-RELATIVE: "up" moves the hero straight up the screen (a grid diagonal).
 *  Q/E/Z/C move along the grid axes (screen diagonals) — the way through 1-tile corridors and doors. '.'/space waits. */
export const KEY_DIRS = {
  ArrowUp: [-1, -1], ArrowDown: [1, 1], ArrowLeft: [-1, 1], ArrowRight: [1, -1],
  w: [-1, -1], s: [1, 1], a: [-1, 1], d: [1, -1],
  q: [-1, 0], e: [0, -1], z: [0, 1], c: [1, 0],
  Home: [-1, 0], PageUp: [0, -1], End: [0, 1], PageDown: [1, 0],
  '.': [0, 0], ' ': [0, 0],
};
