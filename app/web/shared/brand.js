// Senju's brand pieces, shared by the launcher and the web page: the turning sticker and the yellow scribble.
// Both are fixed markup (no data goes into them).
const fromMarkup = (markup) => { const t = document.createElement('template'); t.innerHTML = markup; return t.content.firstElementChild; };

export const sticker = (text = 'Senju · swarm on your screen · ') => {
  const n = fromMarkup(`<div class="sticker"><svg class="ring" viewBox="0 0 132 132" aria-hidden="true"><defs><path id="senju-ring" d="M66,66 m-50,0 a50,50 0 1,1 100,0 a50,50 0 1,1 -100,0"/></defs><text><textPath href="#senju-ring"></textPath></text></svg><svg class="mark" viewBox="0 0 48 48" aria-hidden="true"><path d="M10 30 C 14 12, 30 10, 30 24 S 18 38, 38 18" fill="none" stroke="#141414" stroke-width="4.5" stroke-linecap="round"/><path d="M30 16 L39 17 L37 26" fill="none" stroke="#141414" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`);
  n.querySelector('textPath').textContent = text;
  return n;
};

export const scribbleArrow = () => fromMarkup('<svg class="scribble-arrow" viewBox="0 0 220 160" aria-hidden="true"><path class="scribble" d="M20 30 C 90 0, 170 40, 150 90 C 135 128, 70 120, 95 85 C 115 58, 175 80, 190 135"/><path class="scribble" d="M165 128 L192 140 L198 110"/></svg>');

// A small DOM builder: text is always set as text.
export function h(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style') Object.assign(n.style, v);
    else if (k === 'value') n.value = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : String(kid));
  return n;
}
