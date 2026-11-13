import { defineWidget } from '../../core/types';
import { openRemoteSheet } from './sheets';
import { mountRemote } from './view';
import './tvremote.css';

export default defineWidget({
  type: 'tvremote',
  name: 'TV remote',
  description: 'A remote for the LG TV: power, arrows, volume, channels, apps, inputs and a touchpad',
  icon: '🎛️',
  sizes: ['small', 'medium', 'tall', 'large', 'xlarge', 'full'],
  defaultSize: 'tall',
  defaultConfig: {},

  mount(el, { placement }) {
    const destroy = mountRemote(el, placement);
    // The small tile only has room for power and volume; a tap anywhere else opens the rest.
    if (placement !== 'small') return { destroy };
    const open = () => openRemoteSheet('remote');
    el.addEventListener('click', open);
    return {
      destroy() {
        el.removeEventListener('click', open);
        destroy();
      },
    };
  },
});
