// render/lighting.js — soft fog-of-war, day/night tint and warm point lights in ONE multiply pass.
//
// How it works
//   1. A low-resolution lightmap (one texel = 4 art px = 4*S device px) is kept in an offscreen canvas.
//      Its texel grid is anchored to the world through view.ox/oy (origin = ox mod texelSize), so light never shimmers
//      while the camera glides.
//   2. A small per-frame "tile field" (RGB + visible weight per tile) is filled from world.isVis / isSeen:
//        never seen  -> near black (the renderer does not draw those tiles anyway; hides any fringe)
//        remembered  -> cool plum-grey (~35% brightness, like classic's 32% alpha)
//        visible     -> dayInfo(turn).tint (or torch amber inside pyramids) with a gentle falloff toward the sight edge
//   3. Each lightmap texel samples the tile field bilinearly in continuous tile space (so fog edges are a soft gradient
//      about a tile wide, not a stair of diamonds), then warm point lights are ADDED (quadratic falloff), masked by the
//      visible weight so lights never brighten unseen tiles.
//   4. The lightmap (with a faint plum vignette folded in) is drawn over the canvas with 'multiply' and bilinear
//      smoothing, then the mist; each pass is clipped to the cells of the screen that actually need it.
// Everything is reused between frames (typed arrays, ImageData, canvases, gradient): zero allocation after warm-up.
import { G } from '../core/state.js';
import { dayInfo, HW, HH } from '../core/config.js';
import { terr, isVis, isSeen, heightAt, dgVisR } from '../world/world.js';

const TEXEL = 4;                      // art px per lightmap texel
const NEVER = [8, 6, 15];             // #08060f
const REMEMBER = [122, 108, 152];     // cool plum-grey multiply colour for remembered tiles
const TORCH = [255, 214, 150];        // pyramid torch amber
const WARM = [255, 176, 96];          // lantern / campfire / glow colour
const BURN = [255, 126, 48];
const GLOW_COL = [255, 214, 120];
const MAX_LIGHTS = 64;
const MAX_TILES = 26000;              // cap of the tile field (guards against absurd zoom-outs)

let lm = null, lmCtx = null, img = null, imgData = null;       // lightmap canvas, its context and ImageData
let nw = 0, nh = 0, texelDev = 0;
let acc = new Float32Array(0);                                  // per texel RGB + visible weight (4 floats)
let field = new Float32Array(0);                                // per tile RGB + visible weight (4 floats)
let fieldCap = 0;
let known = new Float32Array(0);                                // per tile: 1 = something is drawn there (seen, or a
                                                                // tall lit thing stands in front of it), 0 = never seen
let kacc = new Float32Array(0);                                 // per texel: bilinear `known` (0 = pure fog)
let fog = null, fogCtx = null, fogData = null;                  // the mist that fills the unexplored (same texel grid)
// 64 x 64 tileable value noise for the mist (deterministic)
const NZ = 64, noise = new Float32Array(NZ * NZ);
{ let a = 0x51ed27; for (let i = 0; i < NZ * NZ; i++) { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; noise[i] = a / 4294967296; } }
function nz(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const x0 = xi & 63, x1 = (xi + 1) & 63, y0 = (yi & 63) * NZ, y1 = ((yi + 1) & 63) * NZ;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = noise[y0 + x0], b = noise[y0 + x1], c = noise[y1 + x0], d = noise[y1 + x1];
  return a + (b - a) * sx + (c - a + (a - b + d - c) * sx) * sy;
}
const lights = { x: new Float32Array(MAX_LIGHTS), y: new Float32Array(MAX_LIGHTS), r: new Float32Array(MAX_LIGHTS),
  s: new Float32Array(MAX_LIGHTS), c: new Array(MAX_LIGHTS).fill(WARM), z: new Float32Array(MAX_LIGHTS), n: 0 };
const cur = { r: 255, g: 252, b: 244, night: 0, init: false, t: 0 };   // eased ambient (avoids a pop on each turn)
let infoTurn = NaN, info = null;
let vig = new Float32Array(0), vigW = 0, vigH = 0, vigN = 0;    // per texel: 0 at the centre .. 1 in the screen corners
const CELL = 8;                                                 // texels per side of a composite cell (32 art px)
let cellLit = new Uint8Array(0), cellFog = new Uint8Array(0);   // per cell: needs the multiply pass / the mist pass

let fogAny = true;                    // false when the mist layer has nothing to draw this frame
/** Resets lighting state. The lightmap is built lazily and resized with the viewport. */
export function initLighting() {
  lm = null; lmCtx = null; imgData = null; nw = nh = 0; texelDev = 0; vigW = vigH = vigN = 0;
  fog = null; fogCtx = null; fogData = null;
  cur.init = false; infoTurn = NaN; info = null;
  try { ensureCanvas(); } catch (e) { /* no DOM (tests): drawLighting will try again */ }
}

function ensureCanvas() {
  if (lm) return;
  lm = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(8, 8) : document.createElement('canvas');
  lmCtx = lm.getContext('2d');
  fog = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(8, 8) : document.createElement('canvas');
  fogCtx = fog.getContext('2d');
}

function getInfo() {
  if (G.turn !== infoTurn || !info) { infoTurn = G.turn; info = dayInfo(G.turn || 0); }
  return info;
}

/** Ambient description for UI (e.g. HUD clock icon). Overworld: dayInfo(turn); inside a pyramid: tomb light. */
export function ambient() {
  if (G.dg) { const r = dgVisR(); return { phase: 'tomb', light: r < 9 ? 0.4 : 0.6, tint: TORCH, radius: r }; }
  return dayInfo(G.turn);
}

function addLight(x, y, r, s, col, z) {
  const n = lights.n; if (n >= MAX_LIGHTS) return;
  lights.x[n] = x; lights.y[n] = y; lights.r[n] = r; lights.s[n] = s; lights.c[n] = col; lights.z[n] = z || 0; lights.n = n + 1;
}
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const smooth = v => { v = clamp01(v); return v * v * (3 - 2 * v); };

/** Called by the renderer after the world is drawn and before overlay fx. Multiplies the lightmap over ctx.
 *  view: {S, ox, oy, w, h, dpr, toScreen}. Never throws; ctx state is restored exactly. */
export function drawLighting(ctx, view) {
  if (!G.P || !view || !ctx) return;
  let saved = false;
  try {
    ensureCanvas();
    const S = view.S, T = TEXEL * S, W = view.w, H = view.h;
    if (!(S > 0) || W < 2 || H < 2) return;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const P = G.P, dg = !!G.dg, inf = getInfo();

    // ---- eased ambient ---------------------------------------------------------------------------------------
    const tgt = dg ? TORCH : inf.tint;
    const tgtNight = dg ? 1 : clamp01((1 - inf.light) / 0.58);
    if (!cur.init) { cur.r = tgt[0]; cur.g = tgt[1]; cur.b = tgt[2]; cur.night = tgtNight; cur.init = true; cur.t = now; }
    else {
      const dt = Math.min(250, Math.max(0, now - cur.t)); cur.t = now;
      const k = 1 - Math.exp(-dt / 180);
      cur.r += (tgt[0] - cur.r) * k; cur.g += (tgt[1] - cur.g) * k; cur.b += (tgt[2] - cur.b) * k; cur.night += (tgtNight - cur.night) * k;
    }

    // ---- lightmap sizing (reallocate only when it changes) -------------------------------------------------
    const tw = Math.ceil(W / T) + 2, th = Math.ceil(H / T) + 2;
    if (tw !== nw || th !== nh || T !== texelDev || !imgData) {
      nw = tw; nh = th; texelDev = T;
      lm.width = nw; lm.height = nh;
      lmCtx = lm.getContext('2d');
      imgData = lmCtx.createImageData(nw, nh);
      acc = new Float32Array(nw * nh * 4);
      kacc = new Float32Array(nw * nh);
      fog.width = nw; fog.height = nh;
      fogCtx = fog.getContext('2d');
      fogData = fogCtx.createImageData(nw, nh);
    }
    // texel grid origin in device px, anchored to the world
    const gx0 = (((view.ox % T) + T) % T) - T, gy0 = (((view.oy % T) + T) % T) - T;
    const stepA = T / S;                                   // art px per texel
    // continuous tile coords of texel centre (i,j): u=ax/HW, v=ay/HH, fx=(u+v)/2, fy=(v-u)/2  (tile centre = x+.5)
    const uAt = i => ((gx0 + (i + 0.5) * T - view.ox) / S) / HW;
    const vAt = j => ((gy0 + (j + 0.5) * T - view.oy) / S) / HH;
    const uMin = uAt(-1), uMax = uAt(nw), vMin = vAt(-1), vMax = vAt(nh);
    const fxMin = (uMin + vMin) / 2, fxMax = (uMax + vMax) / 2, fyMin = (vMin - uMax) / 2, fyMax = (vMax - uMin) / 2;
    const tx0 = Math.floor(fxMin) - 3, ty0 = Math.floor(fyMin) - 3;                 // margin for raised blocks
    let gw = Math.ceil(fxMax) + 3 - tx0 + 1, gh = Math.ceil(fyMax) + 3 - ty0 + 1;
    if (gw * gh > MAX_TILES) { const f = Math.sqrt(MAX_TILES / (gw * gh)); gw = Math.floor(gw * f); gh = Math.floor(gh * f); }
    if (gw * gh * 4 > fieldCap) { fieldCap = gw * gh * 4; field = new Float32Array(fieldCap); known = new Float32Array(gw * gh); }

    // ---- tile field + light list -----------------------------------------------------------------------------
    lights.n = 0;
    const night = cur.night;
    const R = dg ? dgVisR() : (inf.radius || 9);
    const nR = dg ? 2 : 4;                                  // full brightness inside this many tiles
    const edge = dg ? 0.52 : 0.82;                          // brightness at the vision edge
    const remK = dg ? 0.9 : 0.72 + 0.28 * clamp01(inf.light);   // remembered tiles get a bit darker at night
    const tr = cur.r, tg = cur.g, tb = cur.b;
    const camp = (!dg && P.camp) ? P.camp : null;
    const dayK = 0.35 + 0.65 * night;                       // non-hero lights: subtle by day, strong by night
    for (let ty = 0; ty < gh; ty++) {
      const y = ty0 + ty;
      for (let tx = 0; tx < gw; tx++) {
        const x = tx0 + tx, o = (ty * gw + tx) * 4;
        if (isVis(x, y)) {
          const d = Math.hypot(x - P.x, y - P.y);
          let f = 1 - (1 - edge) * smooth((d - nR) / Math.max(1, R - nR));
          if (camp && Math.abs(x - camp.x) <= 4 && Math.abs(y - camp.y) <= 4) f = Math.max(f, 1 - (1 - edge) * smooth((Math.hypot(x - camp.x, y - camp.y) - 2) / 4) * 0.5);
          field[o] = tr * f; field[o + 1] = tg * f; field[o + 2] = tb * f; field[o + 3] = 1; known[o >> 2] = 1;
          const t = terr(x, y);
          if (t && t.glow > 0) addLight(x + 0.5, y + 0.5, t.glow, 0.8 * dayK, GLOW_COL, 4);
        } else if (isSeen(x, y)) {
          field[o] = REMEMBER[0] * remK; field[o + 1] = REMEMBER[1] * remK; field[o + 2] = REMEMBER[2] * remK; field[o + 3] = 0; known[o >> 2] = 1;
        } else {
          field[o] = NEVER[0]; field[o + 1] = NEVER[1]; field[o + 2] = NEVER[2]; field[o + 3] = 0; known[o >> 2] = 0;
        }
      }
    }
    // Tall things are drawn ABOVE their own tile, i.e. over the ground of the tiles behind them (a block lifted z ZU
    // covers the plane z/4 tiles up the screen). Where that ground has never been seen, hand it the tall thing's
    // light so walls, crags, tree crowns and pyramid tops at the edge of the known world are not swallowed by fog.
    for (let ty = 1; ty < gh; ty++) {
      const y = ty0 + ty;
      for (let tx = 1; tx < gw; tx++) {
        const ti = ty * gw + tx;
        if (known[ti] !== 1) continue;
        const t = terr(tx0 + tx, y);
        if (!t || !t.tall) continue;
        const z = t.kind === 'prop' ? 12 : heightAt(tx0 + tx, y);
        const reach = Math.min(8, Math.ceil(z / 4));
        for (let k = 1; k <= reach && tx - k >= 0 && ty - k >= 0; k++) {
          const bi = ti - k * (gw + 1);
          if (known[bi] !== 0) continue;
          const o = ti * 4, b = bi * 4;
          field[b] = field[o]; field[b + 1] = field[o + 1]; field[b + 2] = field[o + 2]; field[b + 3] = field[o + 3];
          known[bi] = 0.999;                                    // covered: not fog, but not a source either
        }
      }
    }
    // hero lantern (night / dusk / dawn, always in pyramids), campfire, burning monsters
    if (night > 0.02) addLight(P.x + 0.5, P.y + 0.5, dg ? 3.6 : 3.2, 0.95 * Math.max(night, dg ? 1 : 0), WARM, 8);
    if (camp) {
      const fl = Math.floor(now / 260);
      const h = (((fl * 2654435761) >>> 0) % 1000) / 1000 * 2 - 1;
      if (isVis(camp.x, camp.y) || (Math.abs(camp.x - P.x) <= R && Math.abs(camp.y - P.y) <= R && isSeen(camp.x, camp.y)))
        addLight(camp.x + 0.5, camp.y + 0.5, 4 + 0.4 * h, 0.95 + 0.1 * h, WARM, 3);
    }
    const mons = G.mons;
    if (mons) for (let i = 0; i < mons.length; i++) {
      const m = mons[i];
      if (m.burn > 0 && isVis(m.x, m.y)) addLight(m.x + 0.5, m.y + 0.5, 2.3, 0.85, BURN, 4);
    }

    // ---- per-texel: bilinear sample of the tile field -----------------------------------------------------------
    const dU = stepA / HW, dV = stepA / HH;
    const gwm = gw - 1, ghm = gh - 1;
    let ai = 0;
    for (let j = 0; j < nh; j++) {
      const v = vAt(j);
      let u = uAt(0);
      for (let i = 0; i < nw; i++, u += dU, ai += 4) {
        let sx = (u + v) * 0.5 - 0.5 - tx0, sy = (v - u) * 0.5 - 0.5 - ty0;
        if (sx < 0) sx = 0; else if (sx > gwm - 0.001) sx = gwm - 0.001;
        if (sy < 0) sy = 0; else if (sy > ghm - 0.001) sy = ghm - 0.001;
        const ix = sx | 0, iy = sy | 0, fx = sx - ix, fy = sy - iy;
        const o00 = (iy * gw + ix) * 4, o10 = o00 + 4, o01 = o00 + gw * 4, o11 = o01 + 4;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        acc[ai] = field[o00] * w00 + field[o10] * w10 + field[o01] * w01 + field[o11] * w11;
        acc[ai + 1] = field[o00 + 1] * w00 + field[o10 + 1] * w10 + field[o01 + 1] * w01 + field[o11 + 1] * w11;
        acc[ai + 2] = field[o00 + 2] * w00 + field[o10 + 2] * w10 + field[o01 + 2] * w01 + field[o11 + 2] * w11;
        acc[ai + 3] = field[o00 + 3] * w00 + field[o10 + 3] * w10 + field[o01 + 3] * w01 + field[o11 + 3] * w11;
        const k00 = o00 >> 2;
        kacc[ai >> 2] = known[k00] * w00 + known[k00 + 1] * w10 + known[k00 + gw] * w01 + known[k00 + gw + 1] * w11;
      }
    }

    // ---- point lights (additive, masked by visibility) -------------------------------------------------------
    for (let n = 0; n < lights.n; n++) {
      const lx = lights.x[n], ly = lights.y[n], r = lights.r[n], s = lights.s[n], col = lights.c[n];
      const ax = (lx - ly) * HW, ay = (lx + ly) * HH;
      const cxT = ((ax * S + view.ox) - gx0) / T - 0.5, cyT = ((ay * S + view.oy) - gy0) / T - 0.5;
      const ex = (r * HW * 1.42 + 6) / stepA + 2, ey = (r * HH * 1.42 + 6 + lights.z[n]) / stepA + 2;
      const i0 = Math.max(0, Math.floor(cxT - ex)), i1 = Math.min(nw - 1, Math.ceil(cxT + ex));
      const j0 = Math.max(0, Math.floor(cyT - ey)), j1 = Math.min(nh - 1, Math.ceil(cyT + ey));
      const cr = col[0] * s, cg = col[1] * s, cb = col[2] * s, inv = 1 / r;
      for (let j = j0; j <= j1; j++) {
        const v = vAt(j);
        for (let i = i0; i <= i1; i++) {
          const u = uAt(i);
          const dx = (u + v) * 0.5 - lx, dy = (v - u) * 0.5 - ly;
          const k = 1 - Math.sqrt(dx * dx + dy * dy) * inv;
          if (k <= 0) continue;
          const ai2 = (j * nw + i) * 4, m = k * k * acc[ai2 + 3];
          if (m <= 0) continue;
          acc[ai2] += cr * m; acc[ai2 + 1] += cg * m; acc[ai2 + 2] += cb * m;
        }
      }
    }

    // ---- to bytes -------------------------------------------------------------------------------------------------
    // The faint plum vignette is folded into the lightmap (and into the mist below) instead of being a third
    // full-screen blend: vig[k] is 0 in the middle of the screen and 1 in the corners.
    if (vigW !== W || vigH !== H || vigN !== nw * nh) {
      vigW = W; vigH = H; vigN = nw * nh;
      if (vig.length < vigN) vig = new Float32Array(vigN);
      const rr = Math.hypot(W, H) / 2;
      for (let j = 0, k = 0; j < nh; j++) for (let i = 0; i < nw; i++, k++) {
        const t = (Math.hypot((i - 0.5) * T - W / 2, (j - 0.5) * T - H / 2) / rr - 0.55) / 0.45;
        vig[k] = t < 0 ? 0 : t > 1 ? 1 : t;
      }
    }
    const px = imgData.data;
    for (let k = 0, n = nw * nh; k < n; k++) {
      const a = k * 4, t = vig[k];
      let r = acc[a], g = acc[a + 1], b = acc[a + 2];
      if (r > 255) r = 255; if (g > 255) g = 255; if (b > 255) b = 255;
      px[a] = r * (1 - 0.137 * t); px[a + 1] = g * (1 - 0.204 * t); px[a + 2] = b * (1 - 0.075 * t); px[a + 3] = 255;
    }
    lmCtx.putImageData(imgData, 0, 0);

    // ---- mist over the never-seen: the title screen's dusk sky, as slow weather at the edge of the map -------------
    // Deep indigo at the top of the screen warming to plum at the bottom, with drifting magenta cloud. Anchored to
    // the world (it scrolls with the ground), alpha = how unknown the spot is, so the known world fades into it.
    {
      const fp = fogData.data, drift = now / 9000;
      const nx0 = (gx0 - view.ox) / S / 150, ny0 = (gy0 - view.oy) / S / 75, nd = stepA / 150, ndy = stepA / 75;
      let k = 0;
      fogAny = false;
      for (let j = 0; j < nh; j++) {
        const gy = j / (nh - 1), ny = ny0 + j * ndy;
        const br = 20 + 30 * gy, bg = 10 + 8 * gy, bb = 46 + 44 * gy;            // #140a2e -> #32125a
        for (let i = 0; i < nw; i++, k++) {
          const a = k * 4, un = 1 - kacc[k];
          if (un <= 0.004) { fp[a + 3] = 0; continue; }
          const nx = nx0 + i * nd;
          let c = nz(nx + drift, ny - drift * .4) * .65 + nz(nx * 2.3 - drift * .7 + 17, ny * 2.3 + 9) * .35;
          c = c < .42 ? 0 : (c - .42) * 1.72; c = c * c * (3 - 2 * c);          // only the crests of the noise glow
          const t = vig[k];
          fp[a] = (br + 92 * c) * (1 - 0.137 * t); fp[a + 1] = (bg + 16 * c) * (1 - 0.204 * t); fp[a + 2] = (bb + 58 * c) * (1 - 0.075 * t);
          fp[a + 3] = un >= 1 ? 255 : 255 * un * (2 - un); fogAny = true;
        }
      }
      fogCtx.putImageData(fogData, 0, 0);
    }

    // ---- composite (state restored exactly) ------------------------------------------------------------------------
    // Two blends, each clipped to the part of the screen that needs it: the multiply pass is skipped where there is
    // nothing but mist (the mist is opaque there), the mist pass where everything is known. Full-screen blends are
    // the whole cost of lighting on a big canvas, so on a phone (a lit pocket in a sea of mist) and on a tablet
    // (a lit screen with mist round the edge) each pass touches roughly half of it. Cells are CELL texels square
    // and classified with a one-texel margin, because the upscale is bilinear.
    const cw = Math.ceil(nw / CELL), ch = Math.ceil(nh / CELL);
    if (cellLit.length < cw * ch) { cellLit = new Uint8Array(cw * ch); cellFog = new Uint8Array(cw * ch); }
    for (let cj = 0; cj < ch; cj++) for (let ci = 0; ci < cw; ci++) {
      const i0 = Math.max(0, ci * CELL - 1), i1 = Math.min(nw - 1, ci * CELL + CELL), j0 = Math.max(0, cj * CELL - 1), j1 = Math.min(nh - 1, cj * CELL + CELL);
      let lo = 1, hi = 0;
      for (let j = j0; j <= j1; j++) for (let i = i0, k = j * nw + i0; i <= i1; i++, k++) { const v = kacc[k]; if (v < lo) lo = v; if (v > hi) hi = v; }
      cellLit[cj * cw + ci] = hi > 0 ? 1 : 0;              // something here is not pure mist
      cellFog[cj * cw + ci] = lo < 0.996 ? 1 : 0;          // some mist shows here
    }
    const CT = CELL * T;
    const clipTo = cells => {                              // clip to the union of flagged cells (runs merged per row)
      let any = false;
      ctx.beginPath();
      for (let cj = 0; cj < ch; cj++) for (let ci = 0; ci < cw; ci++) {
        if (!cells[cj * cw + ci]) continue;
        let ce = ci; while (ce + 1 < cw && cells[cj * cw + ce + 1]) ce++;
        ctx.rect(gx0 + ci * CT, gy0 + cj * CT, (ce - ci + 1) * CT, CT);
        ci = ce; any = true;
      }
      if (any) ctx.clip();
      return any;
    };
    ctx.save(); saved = true;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'low';
    ctx.save();
    if (clipTo(cellLit)) { ctx.globalCompositeOperation = 'multiply'; ctx.drawImage(lm, gx0, gy0, nw * T, nh * T); }
    ctx.restore();
    if (fogAny) {
      ctx.save();
      if (clipTo(cellFog)) { ctx.globalCompositeOperation = 'source-over'; ctx.drawImage(fog, gx0, gy0, nw * T, nh * T); }
      ctx.restore();
    }
  } catch (e) {
    /* never let lighting break a frame */
  } finally {
    if (saved) { try { ctx.restore(); } catch (e) { /* ignore */ } }
  }
}
