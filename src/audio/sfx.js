// audio/sfx.js — OWNER: Foreman B / sfx worker (B15). Tiny procedural WebAudio blips (no audio files).
// Silent until the first user gesture ('start' event, plus a document-level fallback), respects G.opts.muted,
// and never throws when WebAudio is missing or the context is closed. Contract: docs/ARCHITECTURE.md §8 B15.
import { on, emit } from '../core/bus.js';
import { G, saveOpts } from '../core/state.js';
import { isDeep } from '../world/world.js';

const MASTER_LEVEL = 0.2;      // master gain ceiling; per-sound gains stay <= 1
const MAX_VOICES = 12;         // simultaneous voices; new sounds are dropped beyond this
const RATE_MS = 40;            // ignore a repeat of the same name inside this window

let ctx = null;                // AudioContext, created lazily (never at import time)
let master = null;             // GainNode -> destination; the mute switch
let noise = null;              // one reusable 1 s white-noise buffer
let inited = false;
let gestureWired = false;
let stepFlip = false;          // land steps play on every other move
const lastAt = Object.create(null);  // name -> performance.now() of last play
let voiceEnds = [];            // AudioContext times at which live voices finish

const masterLevel = () => (G.opts && G.opts.muted ? 0 : MASTER_LEVEL);

/** Create the AudioContext on demand (only from a user-gesture path). Returns it or null. */
function ensureCtx(create) {
  if (ctx) return ctx;
  if (!create) return null;
  const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (!AC) return null;
  try {
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = masterLevel();
    master.connect(ctx.destination);
  } catch (e) {
    ctx = null; master = null;
  }
  return ctx;
}

/** Try to wake a suspended context. Browsers may refuse outside a gesture; that is fine. */
function wake(c) {
  try {
    if (c && c.state === 'suspended') {
      const p = c.resume();
      if (p && p.catch) p.catch(() => { /* still locked; next gesture retries */ });
    }
  } catch (e) { /* ignore */ }
}

function noiseBuffer(c) {
  if (!noise || noise.sampleRate !== c.sampleRate) {
    noise = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return noise;
}

/** Shared envelope: quick attack to vol, exponential decay to silence at t + dur. */
function envelope(g, t, dur, vol) {
  const a = Math.min(0.012, dur * 0.3);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(Math.max(0.0002, vol), t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
}

/** One oscillator note. Frequency may glide from f0 to f1 over the note. Returns its end time. */
function tone(c, out, t, type, f0, f1, dur, vol) {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  envelope(g, t, dur, vol);
  o.connect(g); g.connect(out);
  o.start(t); o.stop(t + dur + 0.03);
  return t + dur;
}

/** Filtered noise burst (looped buffer, stopped by envelope). Filter may sweep from freq to f1. Returns end time. */
function burst(c, out, t, filter, freq, q, f1, dur, vol) {
  const s = c.createBufferSource();
  const f = c.createBiquadFilter();
  const g = c.createGain();
  s.buffer = noiseBuffer(c);
  s.loop = true;
  f.type = filter;
  f.frequency.setValueAtTime(freq, t);
  if (f1 && f1 !== freq) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
  f.Q.value = q;
  envelope(g, t, dur, vol);
  s.connect(f); f.connect(g); g.connect(out);
  s.start(t, Math.random() * 0.5);
  s.stop(t + dur + 0.03);
  return t + dur;
}

/** Each sound takes (ctx, output, start time) and returns the time its last node finishes. */
const SOUNDS = {
  // footfall on land: a soft wooden tick, barely there
  step(c, o, t) {
    burst(c, o, t, 'lowpass', 700, 0.7, null, 0.05, 0.08);
    return tone(c, o, t, 'triangle', 180, 120, 0.07, 0.12);
  },

  // ordinary melee: a square thwack with a noise crack
  hit(c, o, t) {
    burst(c, o, t, 'bandpass', 1500, 1.2, null, 0.06, 0.2);
    return tone(c, o, t, 'square', 220, 110, 0.12, 0.25);
  },

  // critical: a harder crack, a bright overtone, a little ring
  crit(c, o, t) {
    burst(c, o, t, 'highpass', 3000, 0.7, null, 0.08, 0.18);
    const a = tone(c, o, t, 'square', 330, 165, 0.18, 0.3);
    const b = tone(c, o, t + 0.03, 'sine', 990, null, 0.15, 0.15);
    return Math.max(a, b);
  },

  // taking damage: a low sawtooth sag and a dull thud
  hurt(c, o, t) {
    burst(c, o, t, 'lowpass', 400, 0.8, null, 0.2, 0.15);
    return tone(c, o, t, 'sawtooth', 160, 70, 0.28, 0.22);
  },

  // a kill: a rising two-step triangle chirp
  kill(c, o, t) {
    const a = tone(c, o, t, 'triangle', 523, 784, 0.16, 0.25);
    const b = tone(c, o, t + 0.12, 'triangle', 1047, null, 0.22, 0.22);
    return Math.max(a, b);
  },

  // level-up ding: bright rising two-note bell, decaying sine with a faint 3x harmonic (~0.5 s)
  ding(c, o, t) {
    const a = tone(c, o, t, 'sine', 880, null, 0.34, 0.5);
    const b = tone(c, o, t + 0.12, 'sine', 1320, null, 0.4, 0.5);
    const h = tone(c, o, t + 0.12, 'sine', 3960, null, 0.12, 0.07);
    return Math.max(a, b, h);
  },

  // gold: two quick square coin pings, the second higher
  coin(c, o, t) {
    const a = tone(c, o, t, 'square', 988, null, 0.05, 0.16);
    const b = tone(c, o, t + 0.05, 'square', 1319, null, 0.12, 0.18);
    return Math.max(a, b);
  },

  // potion: a glassy sine glide up, then a bubbling second note
  potion(c, o, t) {
    const a = tone(c, o, t, 'sine', 440, 880, 0.25, 0.3);
    const b = tone(c, o, t + 0.1, 'sine', 660, null, 0.2, 0.15);
    return Math.max(a, b);
  },

  // equipment: a metal clank over a short square blip
  gear(c, o, t) {
    burst(c, o, t, 'bandpass', 2500, 2.5, null, 0.08, 0.2);
    const a = tone(c, o, t + 0.02, 'square', 1200, 900, 0.1, 0.12);
    const b = tone(c, o, t + 0.06, 'triangle', 1800, null, 0.08, 0.08);
    return Math.max(a, b);
  },

  // scroll: a rising triangle with a paper rustle
  scroll(c, o, t) {
    burst(c, o, t, 'highpass', 4000, 0.7, null, 0.12, 0.08);
    return tone(c, o, t, 'triangle', 600, 900, 0.18, 0.2);
  },

  // spell: a rising sine sweep with a shimmer on top
  spell(c, o, t) {
    const a = tone(c, o, t, 'sine', 500, 1000, 0.3, 0.22);
    const b = tone(c, o, t + 0.1, 'sine', 1500, null, 0.2, 0.1);
    return Math.max(a, b);
  },

  // chopping: a wooden thunk with a dry crack
  chop(c, o, t) {
    burst(c, o, t, 'bandpass', 1200, 2, null, 0.07, 0.35);
    return tone(c, o, t, 'square', 150, 90, 0.08, 0.2);
  },

  // terrain breaking: a falling rubble crunch
  break(c, o, t) {
    burst(c, o, t, 'lowpass', 1800, 0.9, 200, 0.35, 0.4);
    return tone(c, o, t, 'square', 120, 60, 0.2, 0.2);
  },

  // splashing into deep water: a descending filtered wash and a low bloop
  splash(c, o, t) {
    burst(c, o, t, 'bandpass', 2500, 0.8, 400, 0.45, 0.4);
    return tone(c, o, t, 'sine', 300, 120, 0.25, 0.1);
  },

  // entering a new zone: a soft three-note triangle arpeggio
  zone(c, o, t) {
    tone(c, o, t, 'triangle', 392, null, 0.22, 0.14);
    tone(c, o, t + 0.14, 'triangle', 523, null, 0.22, 0.14);
    return tone(c, o, t + 0.28, 'triangle', 659, null, 0.22, 0.14);
  },

  // death: a long descending moan (~1.2 s)
  death(c, o, t) {
    burst(c, o, t, 'lowpass', 300, 0.8, 80, 1.2, 0.08);
    tone(c, o, t, 'triangle', 165, 40, 1.2, 0.15);
    return tone(c, o, t, 'sawtooth', 330, 55, 1.2, 0.25);
  },

  // nuke: a white crack, then a long sub-bass boom with a rolling rumble under it (~2 s)
  nuke(c, o, t) {
    burst(c, o, t, 'highpass', 2500, 0.7, null, 0.12, 0.6);
    burst(c, o, t, 'lowpass', 1800, 0.9, 60, 1.9, 1);
    burst(c, o, t + 0.25, 'lowpass', 300, 1.2, 50, 1.6, 0.6);
    tone(c, o, t, 'sine', 110, 28, 1.6, 0.9);
    return tone(c, o, t, 'triangle', 70, 30, 2, 0.5);
  },

  // teleport: a rising whoosh with a bright shimmer on top, then a soft landing blip
  teleport(c, o, t) {
    burst(c, o, t, 'bandpass', 400, 1.5, 4000, 0.35, 0.18);
    tone(c, o, t, 'sine', 260, 1800, 0.35, 0.22);
    tone(c, o, t + 0.12, 'triangle', 2400, 1200, 0.25, 0.08);
    return tone(c, o, t + 0.36, 'sine', 520, 390, 0.12, 0.16);
  },

  // a bottle shattering: a bright crack, glassy tinkles, a small hiss
  glass(c, o, t) {
    burst(c, o, t, 'highpass', 5000, 0.8, null, 0.1, 0.3);
    tone(c, o, t, 'square', 2600, 2200, 0.05, 0.08);
    tone(c, o, t + 0.04, 'sine', 3300, null, 0.12, 0.1);
    tone(c, o, t + 0.09, 'sine', 4100, null, 0.1, 0.07);
    return burst(c, o, t + 0.05, 'bandpass', 1800, 1.5, 900, 0.3, 0.1);
  },

  // UI tick: a very quiet click
  ui(c, o, t) {
    return tone(c, o, t, 'triangle', 1200, null, 0.03, 0.06);
  },
};

/** Play a named blip. Unknown names are ignored silently. Never throws. */
export function play(name) {
  try {
    if (!Object.prototype.hasOwnProperty.call(SOUNDS, name)) return;
    if (G.opts && G.opts.muted) return;
    const c = ensureCtx(false);
    if (!c || !master) return;
    if (c.state !== 'running') { wake(c); return; }
    const now = performance.now();
    if (now - (lastAt[name] || -1e9) < RATE_MS) return;
    lastAt[name] = now;
    const t = c.currentTime;
    voiceEnds = voiceEnds.filter(e => e > t);
    if (voiceEnds.length >= MAX_VOICES) return;
    const end = SOUNDS[name](c, master, t + 0.005);
    voiceEnds.push(end);
  } catch (e) {
    /* WebAudio failed or the context is closed: stay silent */
  }
}

/** Mute / unmute. Persists through G.opts.muted and saveOpts(); the master gain does the silencing. */
export function setMuted(muted) {
  try {
    if (!G.opts) G.opts = { muted: false, zoom: 0 };
    G.opts.muted = !!muted;
    saveOpts();
    if (master) master.gain.value = masterLevel();
    emit('opts', {});
  } catch (e) { /* ignore */ }
}

/** Create the context on the first gesture and route bus events to sounds. Idempotent. */
export function initSfx() {
  if (inited) return;
  inited = true;

  // iOS only unlocks audio inside a gesture; also try once on the first pointer or key anywhere
  if (!gestureWired && typeof document !== 'undefined') {
    gestureWired = true;
    const unlock = () => {
      document.removeEventListener('pointerdown', unlock, true);
      document.removeEventListener('keydown', unlock, true);
      try { wake(ensureCtx(true)); } catch (e) { /* ignore */ }
    };
    document.addEventListener('pointerdown', unlock, true);
    document.addEventListener('keydown', unlock, true);
  }

  on('start', () => { wake(ensureCtx(true)); });
  on('moved', p => {
    wake(ctx);
    try {
      const to = p && p.to;
      if (!to) return;
      if (isDeep(to.x, to.y)) { play('splash'); return; }
      stepFlip = !stepFlip;
      if (stepFlip) play('step');
    } catch (e) { /* ignore */ }
  });
  on('turn', () => wake(ctx));
  on('hit', p => play(p && p.crit ? 'crit' : 'hit'));
  on('hurt', () => play('hurt'));
  on('kill', () => play('kill'));
  on('levelup', () => play('ding'));
  on('pickup', p => {
    const k = p && p.item && p.item.kind;
    play(k === 'gold' ? 'coin' : k === 'potion' ? 'potion' : k === 'gear' ? 'gear' : k === 'scroll' ? 'scroll' : 'ui');
  });
  on('equip', () => play('gear'));
  on('spell', () => play('spell'));
  on('learn', () => play('scroll'));
  on('work', () => play('chop'));
  on('terrain', () => play('break'));
  on('zone', p => { if (!(p && p.quiet)) play('zone'); });
  on('chest', () => { play('coin'); play('zone'); });
  on('death', () => play('death'));
  on('heal', p => { const k = p && p.kind; if (k === 'level' || k === 'policy') return; play(k === 'potion' ? 'potion' : 'spell'); });
  on('miss', () => play('ui'));
  on('potion', p => { if (p && p.by === 'throw') play('glass'); else if (!(p && p.pot === 'heal')) play('potion'); });   // heal plays via 'heal'
  on('nuke', () => play('nuke'));
  on('teleport', () => play('teleport'));
}
