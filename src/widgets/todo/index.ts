import { h } from '../../core/dom';
import { defineWidget } from '../../core/types';
import { openTodoSheet, renderPanel, type PanelOptions } from './panel';
import { sortedItems, todos } from './store';
import './todo.css';

interface TodoConfig {
  showDone: boolean;
  [key: string]: unknown;
}

interface TileState {
  listId?: string;
}

export default defineWidget<TodoConfig>({
  type: 'todo',
  name: 'To-do lists',
  description: 'To-do, grocery and other checklists, shared by every screen',
  icon: '✅',
  sizes: ['small', 'medium', 'tall', 'large', 'xlarge', 'full'],
  defaultSize: 'tall',
  defaultConfig: { showDone: true },
  settings: [{ key: 'showDone', label: 'Show checked items', type: 'boolean' }],

  mount(el, { config, placement, storage }) {
    let tile: TileState = {};
    let alive = true;
    let onTile = () => {};
    const opts = (): PanelOptions => ({
      listId: tile.listId,
      showDone: config.showDone,
      onSelect(listId) {
        tile = { listId };
        storage.save(tile).catch(() => {});
        onTile();
      },
    });

    if (placement !== 'small' && placement !== 'medium') {
      let destroy = () => {};
      // The panel needs the tile's list first, or it would flash the default one.
      storage
        .load<TileState>({})
        .then((t) => {
          if (!alive) return;
          tile = t ?? {};
          destroy = renderPanel(el, opts());
        })
        .catch(() => alive && (destroy = renderPanel(el, opts())));
      return {
        destroy() {
          alive = false;
          destroy();
        },
      };
    }

    // Small tiles: name, count and the next few items; tap for the full view.
    const title = h('div', { class: 'todo-sum-title' });
    const list = h('ul', { class: 'todo-sum-items' });
    const root = h('button', { class: `todo-sum size-${placement}`, onclick: () => openTodoSheet(opts()) }, title, list);
    el.append(root);

    const render = () => {
      const l = todos.list(tile.listId);
      if (!l) return;
      const open = sortedItems(l).filter((i) => !i.done);
      title.replaceChildren(
        h('span', { class: 'todo-sum-name' }, l.name),
        h('span', { class: 'todo-sum-count' }, open.length ? `${open.length} left` : '✓'),
      );
      const max = placement === 'small' ? 3 : 4;
      list.replaceChildren(
        ...open.slice(0, max).map((i) => h('li', {}, i.text)),
        ...(open.length > max ? [h('li', { class: 'todo-sum-more' }, `+${open.length - max} more`)] : []),
        ...(open.length ? [] : [h('li', { class: 'todo-sum-more' }, 'All done')]),
      );
    };

    onTile = render;
    let off = () => {};
    storage
      .load<TileState>({})
      .catch(() => ({}))
      .then((t) => {
        if (!alive) return;
        tile = t ?? {};
        off = todos.subscribe(render);
      });
    // Another screen may switch this tile's list.
    storage.onChange(() => {
      storage
        .load<TileState>({})
        .then((t) => ((tile = t ?? {}), render()))
        .catch(() => {});
    });
    return {
      destroy() {
        alive = false;
        off();
      },
    };
  },
});
