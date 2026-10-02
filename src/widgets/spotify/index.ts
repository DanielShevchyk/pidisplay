import { h } from '../../core/dom';
import { openSheet } from '../../core/sheet';
import { defineWidget } from '../../core/types';
import { mountPlayer } from './player';
import './spotify.css';

/** The full player in a sheet, for small tiles and the top bar. */
function openPlayerSheet() {
  let destroy = () => {};
  const box = h('div', { class: 'spt-player-sheet' });
  openSheet('Spotify', [box], { onClose: () => destroy() });
  destroy = mountPlayer(box, { placement: 'sheet' });
}

export default defineWidget({
  type: 'spotify',
  name: 'Spotify',
  description: 'Now playing and controls for your Spotify, on this display or any speaker',
  icon: '🎵',
  sizes: ['small', 'medium', 'tall', 'large', 'xlarge', 'full'],
  defaultSize: 'large',
  supportsBar: true,
  defaultConfig: {},

  mount(el, { placement }) {
    const compact = placement === 'small' || placement === 'medium' || placement === 'tall' || placement === 'bar';
    return { destroy: mountPlayer(el, { placement, onExpand: compact ? openPlayerSheet : undefined }) };
  },
});
