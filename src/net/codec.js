// net/codec.js — what crosses the wire. Monsters and NPCs travel as {$m: nid} / {$n: nid} references (the host stamps
// every one it sends with a random nid), so a client's "attack THAT rat" resolves to the host's rat. Event payloads are
// made JSON-safe (no Maps, Sets, typed arrays or functions; depth-limited) and their references resolved back to the
// client's mirror objects.
import { G } from '../core/state.js';

/** Stamp o with a network id (kept on the object; harmless in saves). */
export function nid(o) { if (!o.nid) o.nid = 1 + Math.floor(Math.random() * 2 ** 31); return o.nid; }

const refOf = v => {
  if (!v || typeof v !== 'object' || !v.nid) return null;
  if (G.mons && G.mons.includes(v)) return { $m: v.nid };
  if (G.npcs && G.npcs.includes(v)) return { $n: v.nid };
  return null;
};

/** Client -> host verb arguments. */
export function encode(v) {
  const r = refOf(v); if (r) return r;
  if (Array.isArray(v)) return v.map(encode);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = encode(v[k]); return o; }
  return v;
}

/** Host side, in the sender's hero context: references back to live objects (null if gone). */
export function decode(v) {
  if (v && typeof v === 'object') {
    if ('$m' in v) return (G.mons || []).find(m => m.nid === v.$m) || null;
    if ('$n' in v) return (G.npcs || []).find(n => n.nid === v.$n) || null;
    if (Array.isArray(v)) return v.map(decode);
    const o = {}; for (const k of Object.keys(v)) o[k] = decode(v[k]); return o;
  }
  return v;
}

/** Host -> client event payloads: JSON-safe copy; monsters/NPCs become references carrying their plain fields. */
export function wire(v, depth = 0) {
  if (v === null || typeof v !== 'object') return typeof v === 'function' ? undefined : v;
  if (v instanceof Map || v instanceof Set || ArrayBuffer.isView(v)) return undefined;
  if (depth > 4) return undefined;
  if (Array.isArray(v)) return v.map(x => wire(x, depth + 1));
  const r = refOf(v), o = r ? { ...r } : {};
  for (const k of Object.keys(v)) {
    const x = v[k];
    if (r && x && typeof x === 'object') continue;              // a reference keeps only its plain fields
    const w = wire(x, depth + 1);
    if (w !== undefined) o[k] = w;
  }
  return o;
}

/** Client side: resolve references to mirror objects where we have them. */
export function unwire(v) {
  if (v && typeof v === 'object') {
    if ('$m' in v) return (G.mons || []).find(m => m.nid === v.$m) || v;
    if ('$n' in v) return (G.npcs || []).find(n => n.nid === v.$n) || v;
    if (Array.isArray(v)) return v.map(unwire);
    const o = {}; for (const k of Object.keys(v)) o[k] = unwire(v[k]); return o;
  }
  return v;
}
