// The full to-do view: list tabs, an add field and the items. Used by big tiles
// and by the sheet that small tiles open.
import { h } from '../../core/dom';
import { openSheet } from '../../core/sheet';
import { sortedItems, todos, type TodoItem, type TodoList } from './store';

export interface PanelOptions {
  listId: string | undefined;
  showDone: boolean;
  /** Called when the user switches lists, so the tile can remember it. */
  onSelect(listId: string): void;
  /** Set inside a sheet: brings the panel back after an edit sheet replaces it. */
  reopen?: () => void;
}

const LONG_PRESS_MS = 550;

export function renderPanel(el: HTMLElement, opts: PanelOptions): () => void {
  let listId = opts.listId;

  const tabs = h('div', { class: 'todo-tabs' });
  const menuBtn = h('button', { class: 'btn btn-ghost todo-menu', 'aria-label': 'List options' }, '⋯');
  const input = h('input', { type: 'text', class: 'todo-input', placeholder: 'Add an item', enterkeyhint: 'done' });
  const addBtn = h('button', { class: 'btn btn-primary todo-add', 'aria-label': 'Add' }, '＋');
  const items = h('div', { class: 'todo-items' });
  const footer = h('div', { class: 'todo-footer' });
  const root = h(
    'div',
    { class: 'todo' },
    h('div', { class: 'todo-head' }, tabs, menuBtn),
    h('form', { class: 'todo-form', onsubmit: (e: Event) => (e.preventDefault(), add()) }, input, addBtn),
    items,
    footer,
  );
  el.append(root);

  // The on-screen keyboard blurs single-line fields after Enter; keep it open so
  // several items can be typed in a row.
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (add()) setTimeout(() => input.focus(), 0);
  });

  function add(): boolean {
    const text = input.value.trim();
    const list = todos.list(listId);
    if (!text || !list) return false;
    todos.addItem(list.id, text);
    input.value = '';
    items.scrollTop = 0;
    return true;
  }

  addBtn.addEventListener('click', (e) => {
    e.preventDefault();
    add();
  });
  menuBtn.addEventListener('click', () => {
    const list = todos.list(listId);
    if (list) openListSheet(list, (id) => select(id), opts.reopen);
  });

  function select(id: string) {
    listId = id;
    opts.onSelect(id);
    render();
  }

  function render() {
    const s = todos.state;
    if (!s) return;
    const list = todos.list(listId)!;

    tabs.replaceChildren(
      ...s.lists.map((l) => {
        const open = l.items.filter((i) => !i.done).length;
        return h(
          'button',
          { class: `chip${l.id === list.id ? ' active' : ''}`, onclick: () => select(l.id) },
          l.name,
          open ? h('span', { class: 'todo-count' }, open) : null,
        );
      }),
      h('button', { class: 'chip todo-new', 'aria-label': 'New list', onclick: () => newList((id) => select(id), opts.reopen) }, '＋ List'),
    );

    // Narrow tiles scroll the tabs sideways; keep the current list in view.
    const active = tabs.querySelector<HTMLElement>('.chip.active');
    if (active) {
      const left = active.offsetLeft - tabs.offsetLeft;
      if (left < tabs.scrollLeft || left + active.offsetWidth > tabs.scrollLeft + tabs.clientWidth) {
        tabs.scrollLeft = left - 8;
      }
    }

    const shown = sortedItems(list).filter((i) => opts.showDone || !i.done);
    items.replaceChildren(
      ...(shown.length
        ? shown.map((item) => itemRow(list, item, opts.reopen))
        : [h('div', { class: 'empty' }, list.items.length ? 'All done 🎉' : 'Nothing here yet')]),
    );

    const done = list.items.filter((i) => i.done).length;
    footer.replaceChildren(
      ...(done && opts.showDone
        ? [h('button', { class: 'btn btn-ghost todo-clear', onclick: () => todos.clearDone(list.id) }, `Clear ${done} checked`)]
        : []),
    );
  }

  const off = todos.subscribe(render);
  render();
  return off;
}

function itemRow(list: TodoList, item: TodoItem, reopen?: () => void): HTMLElement {
  const row = h(
    'div',
    { class: `todo-item${item.done ? ' done' : ''}` },
    h('span', { class: 'todo-check', 'aria-hidden': 'true' }, item.done ? '✓' : ''),
    h('span', { class: 'todo-text' }, item.text),
    h(
      'button',
      {
        class: 'btn btn-ghost todo-del',
        'aria-label': 'Delete',
        onclick: (e: Event) => (e.stopPropagation(), todos.removeItem(list.id, item.id)),
      },
      '✕',
    ),
  );

  // Tap toggles; holding opens the editor.
  let timer: number | undefined;
  let held = false;
  row.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('.todo-del')) return;
    held = false;
    timer = window.setTimeout(() => {
      held = true;
      editItem(list, item, reopen);
    }, LONG_PRESS_MS);
  });
  const cancel = () => clearTimeout(timer);
  row.addEventListener('pointerup', cancel);
  row.addEventListener('pointercancel', cancel);
  row.addEventListener('pointerleave', cancel);
  // A drag that scrolls the list moves the pointer; don't count it as a hold.
  row.addEventListener('pointermove', (e) => {
    if (Math.abs(e.movementX) + Math.abs(e.movementY) > 2) cancel();
  });
  row.addEventListener('click', () => {
    if (!held) todos.toggle(list.id, item.id);
  });
  row.addEventListener('contextmenu', (e) => e.preventDefault());
  return row;
}

function textSheet(
  title: string,
  value: string,
  save: string,
  onSave: (text: string) => void,
  extra: Node[] = [],
  onClose?: () => void,
) {
  const input = h('input', { type: 'text', class: 'todo-input', value });
  const submit = () => {
    const text = input.value.trim();
    if (!text) return;
    sheet.close();
    onSave(text);
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  const sheet = openSheet(title, [
    h('div', { class: 'todo-edit' }, input, h('button', { class: 'btn btn-primary', onclick: submit }, save)),
    ...extra,
  ], { onClose });
  setTimeout(() => input.focus(), 50);
  return sheet;
}

function editItem(list: TodoList, item: TodoItem, reopen?: () => void) {
  const del = h(
    'button',
    {
      class: 'btn btn-danger btn-wide',
      onclick: () => {
        sheet.close();
        todos.removeItem(list.id, item.id);
      },
    },
    'Delete item',
  );
  const sheet = textSheet('Edit item', item.text, 'Save', (text) => todos.editItem(list.id, item.id, text), [del], reopen);
}

function newList(onCreated: (id: string) => void, reopen?: () => void) {
  textSheet('New list', '', 'Create', (name) => onCreated(todos.addList(name)), [], reopen);
}

function openListSheet(list: TodoList, onSelect: (id: string) => void, reopen?: () => void) {
  const done = list.items.filter((i) => i.done).length;
  let armed = false;
  const del = h('button', { class: 'btn btn-danger btn-wide' }, 'Delete list');
  del.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      del.textContent = list.items.length ? `Tap again to delete ${list.items.length} items` : 'Tap again to delete';
      return;
    }
    sheet.close();
    todos.removeList(list.id);
    const first = todos.state?.lists[0];
    if (first) onSelect(first.id);
  });
  const extra: Node[] = [];
  if (done) {
    extra.push(
      h(
        'button',
        { class: 'btn btn-wide', onclick: () => (sheet.close(), todos.clearDone(list.id)) },
        `Clear ${done} checked item${done === 1 ? '' : 's'}`,
      ),
    );
  }
  extra.push(del);
  const sheet = textSheet(`List: ${list.name}`, list.name, 'Rename', (name) => todos.renameList(list.id, name), extra, reopen);
}

export function openTodoSheet(opts: PanelOptions) {
  const body = h('div', { class: 'todo-sheet' });
  let cleanup = () => {};
  let listId = opts.listId;
  openSheet('Lists', [body], { onClose: () => cleanup() });
  cleanup = renderPanel(body, {
    ...opts,
    onSelect(id) {
      listId = id;
      opts.onSelect(id);
    },
    // Defer so the closing edit sheet is gone before this one opens.
    reopen: () => setTimeout(() => openTodoSheet({ ...opts, listId })),
  });
}
