// To-do lists, shared by every to-do tile and screen. Stored as one JSON document
// under the widget's shared storage key, so a list shown on two pages stays in sync.
import { createStorage } from '../../core/api';
import { randomId } from '../../core/dom';

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  /** When it was checked off (ms), so recently done items sort first. */
  doneAt?: number;
}

export interface TodoList {
  id: string;
  name: string;
  items: TodoItem[];
}

export interface TodoState {
  lists: TodoList[];
}

const DEFAULT: TodoState = {
  lists: [
    { id: 'todo', name: 'To-do', items: [] },
    { id: 'groceries', name: 'Groceries', items: [] },
  ],
};

const storage = createStorage('todo');
const listeners = new Set<() => void>();
let state: TodoState | null = null;
let loading: Promise<void> | null = null;

function emit() {
  listeners.forEach((fn) => fn());
}

async function reload() {
  const loaded = await storage.load<TodoState>(DEFAULT);
  state = Array.isArray(loaded?.lists) && loaded.lists.length ? loaded : structuredClone(DEFAULT);
  emit();
}

// Our own saves echo back as change events; reloading mid-save could briefly
// show an older copy, so wait until every save has landed.
let saving = 0;
let staleWhileSaving = false;
storage.onChange(() => {
  if (saving) staleWhileSaving = true;
  else void reload().catch(() => {});
});

export const todos = {
  get state(): TodoState | null {
    return state;
  },

  /** Calls fn on every change; loads the lists on first use. Returns an unsubscribe. */
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    if (!state && !loading) loading = reload().catch(() => {}).finally(() => (loading = null));
    else if (state) fn();
    return () => listeners.delete(fn);
  },

  list(id: string | undefined): TodoList | undefined {
    return state?.lists.find((l) => l.id === id) ?? state?.lists[0];
  },

  addItem(listId: string, text: string) {
    mutate(listId, (l) => l.items.unshift({ id: randomId(6), text, done: false }));
  },

  toggle(listId: string, itemId: string) {
    mutate(listId, (l) => {
      const item = l.items.find((i) => i.id === itemId);
      if (!item) return;
      item.done = !item.done;
      item.doneAt = item.done ? Date.now() : undefined;
    });
  },

  editItem(listId: string, itemId: string, text: string) {
    mutate(listId, (l) => {
      const item = l.items.find((i) => i.id === itemId);
      if (item) item.text = text;
    });
  },

  removeItem(listId: string, itemId: string) {
    mutate(listId, (l) => (l.items = l.items.filter((i) => i.id !== itemId)));
  },

  clearDone(listId: string) {
    mutate(listId, (l) => (l.items = l.items.filter((i) => !i.done)));
  },

  addList(name: string): string {
    const id = randomId(6);
    change((s) => s.lists.push({ id, name, items: [] }));
    return id;
  },

  renameList(listId: string, name: string) {
    mutate(listId, (l) => (l.name = name));
  },

  removeList(listId: string) {
    change((s) => {
      s.lists = s.lists.filter((l) => l.id !== listId);
      if (!s.lists.length) s.lists.push({ id: randomId(6), name: 'To-do', items: [] });
    });
  },
};

/** Open items in the order added (newest first), then checked items, most recent first. */
export function sortedItems(list: TodoList): TodoItem[] {
  const open = list.items.filter((i) => !i.done);
  const done = list.items.filter((i) => i.done).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
  return [...open, ...done];
}

function change(fn: (s: TodoState) => void) {
  if (!state) return;
  const next = structuredClone(state);
  fn(next);
  state = next;
  emit();
  saving++;
  storage
    .save(state)
    .catch(() => {})
    .finally(() => {
      if (--saving || !staleWhileSaving) return;
      staleWhileSaving = false;
      void reload().catch(() => {});
    });
}

function mutate(listId: string, fn: (l: TodoList) => void) {
  change((s) => {
    const list = s.lists.find((l) => l.id === listId);
    if (list) fn(list);
  });
}
