// net/transport.js — rooms and messages, nothing else. Two interchangeable transports with one shape:
//   { self, send(msg, to = null), onMsg(fn(msg, from)), onJoin(fn(peer)), onLeave(fn(peer)), peers(), close() }
//   rtc   (default): WebRTC peer-to-peer via Trystero over free public Nostr relays. No server, no account.
//   local (?net=local): BroadcastChannel between tabs of one browser, for development and tests.

const APP_ID = 'gozarcripp.circumference.2.5d';

function hub() {
  const fns = { msg: [], join: [], leave: [] };
  return {
    fire: (k, ...a) => { for (const f of fns[k]) { try { f(...a); } catch (e) { console.error('[net]', k, e); } } },
    api: { onMsg: f => fns.msg.push(f), onJoin: f => fns.join.push(f), onLeave: f => fns.leave.push(f) },
  };
}

export async function openTransport(kind, code) {
  return kind === 'local' ? openLocal(code) : openRtc(code);
}

async function openRtc(code) {
  const { joinRoom } = await import('./vendor/trystero.min.js');
  const room = joinRoom({ appId: APP_ID, identity: 'none' }, code);
  const h = hub(), seen = new Set();
  const act = room.makeAction('m');
  act.onMessage((data, ctx) => h.fire('msg', data, ctx.peerId));
  room.onPeerJoin(({ peerId }) => { seen.add(peerId); h.fire('join', peerId); });
  room.onPeerLeave(({ peerId }) => { seen.delete(peerId); h.fire('leave', peerId); });
  let self = '';
  try { self = (await room.getSelf()).peerId; } catch (e) { self = 'me-' + Math.random().toString(36).slice(2, 10); }
  return {
    ...h.api, self,
    send: (msg, to = null) => act.send(msg, to ? { target: to } : undefined).catch(e => console.warn('[net] send', e)),
    peers: () => [...seen],
    close: () => room.leave(),
  };
}

function openLocal(code) {
  const ch = new BroadcastChannel('circ-room-' + code);
  const self = 'tab-' + Math.random().toString(36).slice(2, 10);
  const h = hub(), last = new Map();                       // peer -> last heard (ms)
  const post = (m) => ch.postMessage({ from: self, ...m });
  const heard = (p) => { const isNew = !last.has(p); last.set(p, Date.now()); if (isNew) h.fire('join', p); };
  ch.onmessage = ({ data: d }) => {
    if (!d || d.from === self || (d.to && d.to !== self)) return;
    if (d.k === 'bye') { if (last.delete(d.from)) h.fire('leave', d.from); return; }
    heard(d.from);
    if (d.k === 'hi') post({ k: 'here', to: d.from });
    if (d.k === 'msg') h.fire('msg', structuredClone(d.msg), d.from);
  };
  const beat = setInterval(() => {
    post({ k: 'beat' });
    const now = Date.now();
    for (const [p, t] of last) if (now - t > 4000) { last.delete(p); h.fire('leave', p); }
  }, 1000);
  const bye = () => post({ k: 'bye' });
  addEventListener('pagehide', bye);
  post({ k: 'hi' });
  return {
    ...h.api, self,
    send: (msg, to = null) => post({ k: 'msg', to, msg }),
    peers: () => [...last.keys()],
    close: () => { bye(); clearInterval(beat); removeEventListener('pagehide', bye); ch.close(); },
  };
}
