// Notification center: a bell in the top bar, toasts for new arrivals, and a
// sheet listing recent ones. Anything can POST /api/notifications to show here.
import { api, onServerEvent } from './api';
import { h } from './dom';
import { openSheet, type SheetHandle } from './sheet';
import type { AppNotification } from './types';

const TOAST_MS = 8000;
const LEVEL_ICON = { info: 'ℹ️', success: '✅', warning: '⚠️', alert: '🚨' } as const;

export class Notifications {
  private items: AppNotification[] = [];
  private badge = h('span', { class: 'badge', hidden: true });
  private toasts = h('div', { class: 'toasts', 'aria-live': 'polite' });
  private sheet: SheetHandle | null = null;
  readonly button = h(
    'button',
    { class: 'btn btn-ghost bar-btn', 'aria-label': 'Notifications', onclick: () => this.open() },
    '🔔',
    this.badge,
  );

  constructor(host: HTMLElement) {
    host.append(this.toasts);
    api.listNotifications().then((list) => {
      this.items = list;
      this.refresh();
    });
    onServerEvent<AppNotification>('notification', (n) => this.add(n));
    onServerEvent<{ id: string | null }>('notifications-cleared', ({ id }) => {
      this.items = id ? this.items.filter((n) => n.id !== id) : [];
      this.refresh();
    });
  }

  private add(n: AppNotification) {
    this.items = [n, ...this.items.filter((x) => x.id !== n.id)];
    this.refresh();
    const toast = h(
      'button',
      { class: `toast level-${n.level}`, onclick: () => (toast.remove(), this.open()) },
      h('span', { class: 'toast-icon' }, LEVEL_ICON[n.level]),
      h('span', { class: 'toast-text' }, h('strong', {}, n.title), n.body && h('small', {}, n.body)),
    );
    this.toasts.prepend(toast);
    setTimeout(() => toast.remove(), TOAST_MS);
  }

  private async dismiss(id?: string) {
    this.items = id ? this.items.filter((n) => n.id !== id) : [];
    this.refresh();
    await api.dismissNotification(id);
  }

  private refresh() {
    this.badge.hidden = this.items.length === 0;
    this.badge.textContent = this.items.length > 99 ? '99+' : String(this.items.length);
    if (this.sheet) this.sheet.body.replaceChildren(...this.renderList());
  }

  private renderList(): Node[] {
    if (this.items.length === 0) return [h('p', { class: 'empty' }, 'No notifications')];
    return [
      h(
        'ul',
        { class: 'notif-list' },
        ...this.items.map((n) =>
          h(
            'li',
            { class: `notif level-${n.level}` },
            h('span', { class: 'toast-icon' }, LEVEL_ICON[n.level]),
            h(
              'div',
              { class: 'notif-text' },
              h('strong', {}, n.title),
              n.body && h('p', {}, n.body),
              h('small', {}, `${n.source} · ${formatTime(n.time)}`),
            ),
            h('button', { class: 'btn btn-ghost', onclick: () => this.dismiss(n.id), 'aria-label': 'Dismiss' }, '✕'),
          ),
        ),
      ),
      h('button', { class: 'btn btn-wide', onclick: () => this.dismiss() }, 'Clear all'),
    ];
  }

  open() {
    this.sheet = openSheet('Notifications', this.renderList(), { onClose: () => (this.sheet = null) });
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
