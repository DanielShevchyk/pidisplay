import { h } from '../../core/dom';

// 24x24 glyphs, drawn in currentColor.
const ICONS = {
  power: '<path d="M11 3h2v9h-2z"/><path d="M7.05 5.6l1.4 1.42A6 6 0 1 0 15.55 7l1.4-1.42A8 8 0 1 1 7.05 5.6z"/>',
  up: '<path d="M12 7.5l7 7-1.6 1.6L12 10.7l-5.4 5.4L5 14.5z"/>',
  down: '<path d="M12 16.5l-7-7 1.6-1.6 5.4 5.4 5.4-5.4L19 9.5z"/>',
  left: '<path d="M7.5 12l7-7 1.6 1.6-5.4 5.4 5.4 5.4-1.6 1.6z"/>',
  right: '<path d="M16.5 12l-7 7-1.6-1.6 5.4-5.4-5.4-5.4L9.5 5z"/>',
  back: '<path d="M9.5 5.5L3 11l6.5 5.5V13H14a4 4 0 0 1 0 8h-2v2h2a6 6 0 0 0 0-12H9.5z"/>',
  home: '<path d="M12 3l9 7.5-1.3 1.5L19 11.4V20a1 1 0 0 1-1 1h-4v-6h-4v6H6a1 1 0 0 1-1-1v-8.6l-.7.6L3 10.5z"/>',
  menu: '<path d="M10.3 2h3.4l.5 2.6 1.6.9 2.5-.9 1.7 2.9-2 1.8v1.8l2 1.8-1.7 2.9-2.5-.9-1.6.9-.5 2.6h-3.4l-.5-2.6-1.6-.9-2.5.9-1.7-2.9 2-1.8V9.3l-2-1.8 1.7-2.9 2.5.9 1.6-.9zM12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z" transform="translate(0 1)"/>',
  plus: '<path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/>',
  minus: '<path d="M5 11h14v2H5z"/>',
  speaker: '<path d="M4 9h3.5L12 5v14l-4.5-4H4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1zm11.5-1.3a6 6 0 0 1 0 8.6l-1.4-1.4a4 4 0 0 0 0-5.8z"/>',
  muted: '<path d="M4 9h3.5L12 5v14l-4.5-4H4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1zm10.3.7l1.4-1.4L18 10.6l2.3-2.3 1.4 1.4-2.3 2.3 2.3 2.3-1.4 1.4-2.3-2.3-2.3 2.3-1.4-1.4 2.3-2.3z"/>',
  play: '<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  rewind: '<path d="M11 6.5v11L3 12zm9 0v11L12 12z"/>',
  forward: '<path d="M13 6.5v11l8-5.5zm-9 0v11l8-5.5z"/>',
  apps: '<rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="4" width="6" height="6" rx="1.5"/><rect x="4" y="14" width="6" height="6" rx="1.5"/><rect x="14" y="14" width="6" height="6" rx="1.5"/>',
  keypad: '<circle cx="6" cy="5" r="2"/><circle cx="12" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="6" cy="11" r="2"/><circle cx="12" cy="11" r="2"/><circle cx="18" cy="11" r="2"/><circle cx="6" cy="17" r="2"/><circle cx="12" cy="17" r="2"/><circle cx="18" cy="17" r="2"/><circle cx="12" cy="22" r="1.6"/>',
  touchpad: '<path d="M4 3h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm1 2v10h14V5zM3 19h8v2H3zm10 0h8v2h-8z"/>',
  keyboard: '<path d="M3 6h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zm2 3v2h2V9zm4 0v2h2V9zm4 0v2h2V9zm4 0v2h2V9zM5 13v2h2v-2zm4 0v2h6v-2zm8 0v2h2v-2z"/>',
  more: '<circle cx="5" cy="12" r="2.2"/><circle cx="12" cy="12" r="2.2"/><circle cx="19" cy="12" r="2.2"/>',
  tv: '<path d="M3 5h18a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm1 2v9h16V7zm4 13h8v1.5H8z"/>',
  input: '<path d="M3 5h12v2H5v10h10v2H3zm11 3l5 4-5 4v-3H8v-2h6z"/>',
  refresh: '<path d="M12 4a8 8 0 0 1 7.4 5H17v2h6V5h-2v2.3A10 10 0 1 0 22 13h-2a8 8 0 1 1-8-9z"/>',
};

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, cls = ''): HTMLElement {
  const span = h('span', { class: `tvr-icon ${cls}`, 'aria-hidden': 'true' });
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor">${ICONS[name]}</svg>`;
  return span;
}
