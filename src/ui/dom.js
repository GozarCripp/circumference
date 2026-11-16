// ui/dom.js — tiny DOM helpers shared by every UI module.
export { esc } from '../core/util.js';

/** document.getElementById */
export const $ = id => document.getElementById(id);

/** Create an element: el('button', {class:'btn', 'data-a':'go', onclick: fn}, 'Walk here' | [children]) */
export function el(tag, attrs = {}, kids = null) {
  const e = document.createElement(tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k === 'html') e.innerHTML = v;                 // only with esc()'d content
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  if (kids != null) for (const c of [].concat(kids)) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}

/** Inject a module's CSS once. id keeps it idempotent: css('hud', `#hud .row{…}`) */
export function css(id, text) {
  const sid = 'css-' + id;
  if (document.getElementById(sid)) return;
  const s = document.createElement('style');
  s.id = sid; s.textContent = text;
  document.head.appendChild(s);
}

/** Pointer-safe click: fires on pointerup without the 300ms delay and stops the tap reaching the world canvas.
 *  The browser still synthesises a 'click' after the pointerup, aimed at whatever is under the finger BY THEN — which,
 *  if fn just opened a panel, can be a control that did not exist when the finger went down. Nothing in the UI acts
 *  on 'click', and one capture-phase guard swallows the click that trails a handled tap, so it cannot follow a link. */
let lastTap = -1e9, guarded = false;
export function tap(node, fn) {
  if (!guarded) {
    guarded = true;
    document.addEventListener('click', e => { if (performance.now() - lastTap < 500) { e.preventDefault(); e.stopPropagation(); } }, true);
  }
  node.addEventListener('pointerup', e => { e.stopPropagation(); e.preventDefault(); lastTap = performance.now(); fn(e); });
  node.addEventListener('pointerdown', e => e.stopPropagation());
  node.addEventListener('click', e => e.stopPropagation());
}

// ---- the shared modal host (#panel). Gear, Bestiary, Journal, Menu, NPC dialog and the death screen all live here. ----
/** Show a modal: content is a DOM node (usually el('div', {class:'panel'}, …)). Replaces whatever was open. */
export function showPanel(node) {
  const p = $('panel'); if (!p) return;
  p.replaceChildren(node); p.style.display = 'flex';
}
export function hidePanel() { const p = $('panel'); if (p) { p.style.display = 'none'; p.replaceChildren(); } }
export const panelOpen = () => { const p = $('panel'); return !!p && p.style.display === 'flex'; };
