// ui/hang.js — the MULTIPLAYER waiting screen: a pixel cat hanging from a rope, "hang in there!".
// Shown while joining a room and while the host is being handed over. showHang(status) / hideHang().

// 0 transparent, 1 outline, 2 fur, 3 belly/muzzle, 4 rope, 5 eye, 6 pink (nose, ears)
const CAT = [
  '.......44.......',
  '.......44.......',
  '.......44.......',
  '.......44.......',
  '.....1144111....',
  '....122442221...',
  '....122222221...',
  '.11..1222221..11',
  '.161.1222221.161',
  '.1221222222212221',
  '.12222222222221.',
  '.12522222225221.',
  '.12222266222221.',
  '..1223333332221.',
  '...12233332221..',
  '....122222221...',
  '....122333221...',
  '...12233333221..',
  '...12233333221..',
  '...12233333221..',
  '....122333221...',
  '....1222.2221...',
  '....122...221...',
  '.....11...11....',
  '..........11....',
  '...........11...',
  '............1...',
];
const PAL = { 1: '#1b1026', 2: '#f0a040', 3: '#ffe2b8', 4: '#b98a4e', 5: '#1b1026', 6: '#ff7aa8' };

let node = null, raf = 0, label = null;

function build() {
  node = document.createElement('div');
  node.id = 'hang';
  node.style.cssText = 'position:fixed;inset:0;z-index:9999;display:none;flex-direction:column;align-items:center;justify-content:center;gap:14px;'
    + 'background:radial-gradient(circle at 50% 40%,#2a1640,#08060f 70%);color:#fff;text-align:center;padding:16px;';
  const cv = document.createElement('canvas');
  const S = 8; cv.width = 18 * S; cv.height = 40 * S;
  cv.style.cssText = 'image-rendering:pixelated;width:144px;height:320px;transform-origin:50% 0;';
  const g = cv.getContext('2d');
  g.fillStyle = PAL[4];
  g.fillRect(8 * S, 0, 2 * S, 12 * S);                          // rope from the top of the screen
  CAT.forEach((row, y) => { for (let x = 0; x < row.length; x++) { const c = PAL[row[x]]; if (c) { g.fillStyle = c; g.fillRect(x * S + S, (y + 10) * S, S, S); } } });
  const h = document.createElement('div');
  h.className = 'h';
  h.textContent = 'hang in there!';
  h.style.cssText = 'font-size:40px;transform:rotate(-4deg);';
  label = document.createElement('div');
  label.className = 'flavor';
  label.style.cssText = 'max-width:340px;';
  node.append(cv, h, label);
  document.body.append(node);
  let t0 = 0;
  const swing = now => { if (!t0) t0 = now; cv.style.transform = `rotate(${Math.sin((now - t0) / 700) * 7}deg)`; raf = requestAnimationFrame(swing); };
  node.swing = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(swing); };
}

export function showHang(status = '') {
  if (typeof document === 'undefined') return;
  if (!node) build();
  label.textContent = status;
  node.style.display = 'flex';
  node.swing();
}

export function hideHang() {
  if (!node) return;
  node.style.display = 'none';
  cancelAnimationFrame(raf);
}

export const hangVisible = () => !!node && node.style.display === 'flex';
