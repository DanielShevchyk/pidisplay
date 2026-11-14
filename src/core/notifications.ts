// Notification center: a bell in the top bar, toasts for new arrivals, and a
// sheet listing recent ones grouped by source. Anything can POST /api/notifications.
import { api, onServerEvent } from './api';
import { h } from './dom';
import { icon } from './icons';
import { openSheet, type SheetHandle } from './sheet';
import type { AppNotification } from './types';

const TOAST_MS = 8000;
/** At most this many toasts on screen; anything past it folds into one "+N more" toast. */
const MAX_TOASTS = 3;
/** Each source shows its newest few until expanded. */
const GROUP_PREVIEW = 3;
const LEVEL_ICON = { info: 'ℹ️', success: '✅', warning: '⚠️', alert: '🚨' } as const;

export class Notifications {
  private items: AppNotification[] = [];
  private badge = h('span', { class: 'badge', hidden: true });
  private toasts = h('div', { class: 'toasts', 'aria-live': 'polite' });
  private overflow = { count: 0, el: null as HTMLElement | null, timer: 0 };
  private expanded = new Set<string>();
  private sheet: SheetHandle | null = null;
  readonly button = h(
    'button',
    { class: 'btn btn-ghost bar-btn bell-btn', 'aria-label': 'Notifications', onclick: () => this.open() },
    icon('bell'),
    this.badge,
  );

  constructor(host: HTMLElement) {
    host.append(this.toasts);
    api.listNotifications().then((list) => {
      this.items = list;
      this.refresh();
    });
    onServerEvent<AppNotification>('notification', (n) => this.add(n));
    onServerEvent<{ id: string | null; source?: string }>('notifications-cleared', ({ id, source }) => {
      this.items = id ? this.items.filter((n) => n.id !== id) : source ? this.items.filter((n) => n.source !== source) : [];
      this.refresh();
    });
  }

  private add(n: AppNotification) {
    const { replaces, ...item } = n;
    this.items = [item, ...this.items.filter((x) => x.id !== n.id && x.id !== replaces)];
    this.refresh();
    this.toast(item);
  }

  private toast(n: AppNotification) {
    const shown = [...this.toasts.querySelectorAll<HTMLElement>('.toast:not(.toast-more)')];
    // The same alert already on screen: refresh it instead of stacking a copy.
    const same = shown.find((t) => t.dataset.key === key(n));
    if (same) same.remove();
    else if (shown.length >= MAX_TOASTS) {
      this.showOverflow();
      return;
    }
    const toast = h(
      'button',
      { class: `toast level-${n.level}`, onclick: () => (toast.remove(), this.open()) },
      h('span', { class: 'toast-icon' }, LEVEL_ICON[n.level]),
      h(
        'span',
        { class: 'toast-text' },
        h('strong', {}, n.title, (n.count ?? 1) > 1 ? h('span', { class: 'notif-count' }, ` ×${n.count}`) : ''),
        n.body && h('small', {}, n.body),
      ),
    );
    toast.dataset.key = key(n);
    this.toasts.prepend(toast);
    setTimeout(() => toast.remove(), TOAST_MS);
  }

  private showOverflow() {
    const o = this.overflow;
    o.count++;
    if (!o.el) {
      o.el = h('button', { class: 'toast toast-more', onclick: () => (this.clearOverflow(), this.open()) });
      this.toasts.append(o.el);
    }
    o.el.textContent = `+${o.count} more · tap to see all`;
    clearTimeout(o.timer);
    o.timer = window.setTimeout(() => this.clearOverflow(), TOAST_MS);
  }

  private clearOverflow() {
    clearTimeout(this.overflow.timer);
    this.overflow.el?.remove();
    this.overflow = { count: 0, el: null, timer: 0 };
  }

  private async dismiss(id?: string) {
    this.items = id ? this.items.filter((n) => n.id !== id) : [];
    if (!id) {
      this.toasts.replaceChildren();
      this.clearOverflow();
    }
    this.refresh();
    await api.dismissNotification(id);
  }

  private async dismissSource(source: string) {
    this.items = this.items.filter((n) => n.source !== source);
    this.refresh();
    await api.dismissNotificationSource(source);
  }

  private refresh() {
    this.badge.hidden = this.items.length === 0;
    this.badge.textContent = this.items.length > 99 ? '99+' : String(this.items.length);
    if (this.sheet) this.sheet.body.replaceChildren(...this.renderList());
  }

  private renderList(): Node[] {
    if (this.items.length === 0) return [h('p', { class: 'empty' }, 'No notifications')];
    // Groups in order of their newest entry (items are newest first).
    const groups = new Map<string, AppNotification[]>();
    for (const n of this.items) {
      const g = groups.get(n.source);
      if (g) g.push(n);
      else groups.set(n.source, [n]);
    }
    const sections = [...groups].map(([source, list]) => {
      const open = this.expanded.has(source) || list.length <= GROUP_PREVIEW + 1;
      const visible = open ? list : list.slice(0, GROUP_PREVIEW);
      const toggle = () => {
        if (this.expanded.has(source)) this.expanded.delete(source);
        else this.expanded.add(source);
        this.refresh();
      };
      return h(
        'section',
        { class: 'notif-group' },
        h(
          'header',
          { class: 'notif-group-head' },
          h('strong', {}, source),
          h('span', { class: 'notif-group-n' }, String(list.length)),
          h('button', { class: 'btn btn-ghost', onclick: () => this.dismissSource(source) }, 'Clear'),
        ),
        h('ul', { class: 'notif-list' }, ...visible.map((n) => this.renderItem(n))),
        list.length > visible.length
          ? h('button', { class: 'btn btn-ghost btn-wide', onclick: toggle }, `Show ${list.length - visible.length} more`)
          : this.expanded.has(source) && list.length > GROUP_PREVIEW + 1
            ? h('button', { class: 'btn btn-ghost btn-wide', onclick: toggle }, 'Show fewer')
            : '',
      );
    });
    return [...sections, h('button', { class: 'btn btn-wide', onclick: () => this.dismiss() }, 'Clear all')];
  }

  private renderItem(n: AppNotification): Node {
    const times = (n.count ?? 1) > 1 ? ` · ${n.count} times, latest` : '';
    return h(
      'li',
      { class: `notif level-${n.level}` },
      h('span', { class: 'toast-icon' }, LEVEL_ICON[n.level]),
      h(
        'div',
        { class: 'notif-text' },
        h('strong', {}, n.title),
        n.body && h('p', {}, n.body),
        h('small', {}, `${formatTime(n.time)}${times}`),
      ),
      h('button', { class: 'btn btn-ghost', onclick: () => this.dismiss(n.id), 'aria-label': 'Dismiss' }, icon('x')),
    );
  }

  open() {
    this.toasts.replaceChildren();
    this.clearOverflow();
    this.sheet = openSheet('Notifications', this.renderList(), { onClose: () => (this.sheet = null) });
  }
}

const key = (n: AppNotification) => `${n.source}\n${n.title}`;

function formatTime(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
