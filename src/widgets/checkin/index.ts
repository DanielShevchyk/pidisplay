import { h } from '../../core/dom';
import { checkin } from '../../core/checkin';
import { defineWidget } from '../../core/types';
import { answerPills, DEFAULT_VIEW, openFormSheet, openTrendsSheet, renderPanel, type View } from './panel';
import './checkin.css';

export default defineWidget({
  type: 'checkin',
  name: 'Morning check-in',
  description: 'A quick daily survey on sleep, energy and mood, with trends over time',
  icon: '☀️',
  sizes: ['small', 'medium', 'tall', 'large', 'xlarge', 'full'],
  defaultSize: 'large',
  defaultConfig: {},

  mount(el, { placement, storage }) {
    let view: View = DEFAULT_VIEW;
    let alive = true;
    const saveView = (v: View) => {
      view = v;
      storage.save(v).catch(() => {});
    };

    if (placement !== 'small' && placement !== 'medium') {
      let destroy = () => {};
      // Wait for the tile's saved range and series, or the chart would flash the defaults.
      storage
        .load<View>(DEFAULT_VIEW)
        .catch(() => DEFAULT_VIEW)
        .then((v) => {
          if (!alive) return;
          view = { ...DEFAULT_VIEW, ...v };
          destroy = renderPanel(el, { compact: placement === 'tall' || placement === 'large', narrow: placement === 'tall', view, onView: saveView });
        });
      return {
        destroy() {
          alive = false;
          destroy();
        },
      };
    }

    // Small tiles: a Check in button until today's is done, then today's answers.
    // The tile follows the person last picked in its trends sheet.
    const root = h('button', { class: `ci-sum size-${placement}` });
    el.append(root);
    const render = () => {
      const b = checkin.book(view.profile);
      if (!b) return;
      const done = Boolean(b.entries[b.today]);
      const multi = (checkin.state?.profiles.length ?? 0) > 1;
      root.classList.toggle('done', done);
      root.replaceChildren(
        ...(done
          ? [
              h('div', { class: 'ci-sum-title' }, multi ? `${b.emoji} ${b.name}` : '☀️ Today'),
              h('div', { class: 'ci-sum-pills' }, ...answerPills(b, b.today, placement === 'small' ? 4 : 6)),
            ]
          : [
              h('div', { class: 'ci-sum-icon' }, multi ? b.emoji : '☀️'),
              h('div', { class: 'ci-sum-cta' }, 'Check in'),
              h('div', { class: 'ci-sum-sub' }, multi ? b.name : 'How are you today?'),
            ]),
      );
    };
    root.addEventListener('click', () => {
      const b = checkin.book(view.profile);
      if (b?.entries[b.today])
        openTrendsSheet(view, (v) => {
          saveView(v);
          render();
        });
      else openFormSheet(b?.id);
    });
    storage
      .load<View>(DEFAULT_VIEW)
      .then((v) => {
        view = { ...DEFAULT_VIEW, ...v };
        render();
      })
      .catch(() => {});
    const off = checkin.subscribe(render);
    return {
      destroy() {
        alive = false;
        off();
      },
    };
  },
});
