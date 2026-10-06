import { h } from '../../core/dom';
import { defineWidget } from '../../core/types';
import { openBrowseSheet } from './sheets';
import { mountBrowser, mountRemote } from './view';
import './youtube.css';

export default defineWidget({
  type: 'youtube',
  name: 'YouTube',
  description: 'Search YouTube and play videos on your smart TV, with a remote for what is on',
  icon: '📺',
  sizes: ['small', 'medium', 'tall', 'large', 'xlarge', 'full'],
  defaultSize: 'large',
  defaultConfig: {},

  mount(el, { placement }) {
    // Big tiles browse right in the tile with the remote underneath; small ones show
    // the remote and open the browser in a sheet.
    if (placement === 'large' || placement === 'xlarge' || placement === 'full') {
      const browser = h('div', { class: 'yt-tile-browse' });
      const remote = h('div', { class: 'yt-tile-remote' });
      el.append(h('div', { class: `yt-tile size-${placement}` }, browser, remote));
      const off = [mountBrowser(browser), mountRemote(remote, { placement: 'strip' })];
      return { destroy: () => off.forEach((fn) => fn()) };
    }
    return { destroy: mountRemote(el, { placement, onExpand: openBrowseSheet }) };
  },
});
