// icons.js — inline SVG 圖示(Feather 風格線條;尺寸由 CSS 控)

const ATTR = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"'
  + ' stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'
  + ' aria-hidden="true" focusable="false"';

const wrap = (inner) => `<svg ${ATTR}>${inner}</svg>`;

const STAR_PTS = '12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2';

export const ICON = {
  trash: wrap(
    '<polyline points="3 6 5 6 21 6"/>'
    + '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'
    + '<line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>'),

  restore: wrap(
    '<polyline points="1 4 1 10 7 10"/>'
    + '<path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>'),

  eye: wrap(
    '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>'
    + '<circle cx="12" cy="12" r="3"/>'),

  eyeOff: wrap(
    '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>'
    + '<line x1="1" y1="1" x2="23" y2="23"/>'),

  star: wrap(`<polygon points="${STAR_PTS}"/>`),
  starOutline: wrap(`<polygon points="${STAR_PTS}"/>`),
  starFill: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true" focusable="false"><polygon points="${STAR_PTS}"/></svg>`,

  edit: wrap('<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>'),

  close: wrap('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),

  plus: wrap('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),

  locate: wrap(
    '<circle cx="12" cy="12" r="10"/>'
    + '<line x1="22" y1="12" x2="18" y2="12"/><line x1="6" y1="12" x2="2" y2="12"/>'
    + '<line x1="12" y1="6" x2="12" y2="2"/><line x1="12" y1="22" x2="12" y2="18"/>'),

  fit: wrap('<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>'),

  sun: wrap(
    '<circle cx="12" cy="12" r="5"/>'
    + '<line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>'
    + '<line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>'
    + '<line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>'
    + '<line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>'),

  moon: wrap('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'),

  monitor: wrap(
    '<rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>'
    + '<line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>'),

  route: wrap(
    '<circle cx="6" cy="19" r="3"/>'
    + '<path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/>'
    + '<circle cx="18" cy="5" r="3"/>'),

  gmaps: wrap('<polygon points="3 11 22 2 13 21 11 13 3 11"/>'),
};

/** 把 SVG 字串解析成 SVGElement;cls 可選,設為 class */
export function iconEl(svg, cls) {
  const t = document.createElement('template');
  t.innerHTML = svg.trim();
  const node = t.content.firstElementChild;
  if (node && cls) node.setAttribute('class', cls);
  return node;
}
