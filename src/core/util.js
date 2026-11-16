// core/util.js — ARCHITECT-OWNED. Tiny pure helpers. Mirrors the classic prototype's one-letter helpers.
import { WS } from './config.js';

/** Random int in [0, n). Gameplay randomness only — ART MUST USE rng(seed) from art/pixel.js so sprites are stable. */
export const R = n => Math.floor(Math.random() * n);
export const pick = a => a[R(a.length)];
export const mod = (a, n) => ((a % n) + n) % n;
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const sign = Math.sign;

/** Wrap a world coordinate onto the torus. */
export const wx = v => mod(v, WS);
/** Wrapped string key "x,y" — the key format for G.items, G.mods, G.pyr, P.work (same as classic WK). */
export const WK = (x, y) => wx(x) + ',' + wx(y);
/** Wrapped numeric index for overworld typed arrays. */
export const WI = (x, y) => wx(y) * WS + wx(x);

/** Classic h2 hash WITHOUT the seed: pass s + G.seed yourself. Returns [0,1). Bit-exact port. */
export function hash2(x, y, s) {
  let n = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 982451653) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/** Stable 32-bit hash of a string (FNV-1a). Use for deterministic per-id art seeds. */
export function strHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** "Great Hammer" -> "great-hammer". Used to build asset ids. */
export const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Escape text for innerHTML. Every string that reaches the DOM goes through this or textContent. */
export const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Run-length encode a Uint8Array of 0/1 flags -> compact string (base36 run lengths, first run is zeros). */
export function rleBits(u8) {
  const out = []; let cur = 0, run = 0;
  for (let i = 0; i < u8.length; i++) {
    const v = u8[i] ? 1 : 0;
    if (v === cur) run++; else { out.push(run.toString(36)); cur = v; run = 1; }
  }
  out.push(run.toString(36));
  return out.join('.');
}
/** Inverse of rleBits. Tolerates garbage by returning an empty array of the right length. */
export function unrleBits(str, len) {
  const u8 = new Uint8Array(len);
  if (typeof str !== 'string' || !str) return u8;
  let i = 0, cur = 0;
  for (const part of str.split('.')) {
    const run = parseInt(part, 36);
    if (!(run >= 0)) return new Uint8Array(len);
    if (cur) u8.fill(1, i, Math.min(len, i + run));
    i += run; cur ^= 1;
    if (i >= len) break;
  }
  return u8;
}
