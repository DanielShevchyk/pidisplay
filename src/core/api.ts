// Thin client for the Node backend in server/server.js.
import { randomId } from './dom';
import type { AppNotification, Layout, NotificationInput, WidgetStorage } from './types';

const clientId = randomId();
const headers = { 'Content-Type': 'application/json', 'X-Client-Id': clientId };

async function request(method: string, url: string, body?: unknown): Promise<Response> {
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok && res.status !== 404) throw new Error(`${method} ${url} failed: ${res.status}`);
  return res;
}

export const api = {
  async getLayout(): Promise<Layout> {
    return (await request('GET', '/api/layout')).json();
  },
  async saveLayout(layout: Layout): Promise<void> {
    await request('PUT', '/api/layout', layout);
  },
  async resetLayout(): Promise<void> {
    await request('DELETE', '/api/layout');
  },
  async listNotifications(): Promise<AppNotification[]> {
    return (await request('GET', '/api/notifications')).json();
  },
  async notify(n: NotificationInput & { source: string }): Promise<void> {
    await request('POST', '/api/notifications', n);
  },
  async dismissNotification(id?: string): Promise<void> {
    await request('DELETE', id ? `/api/notifications/${encodeURIComponent(id)}` : '/api/notifications');
  },
  /** Closes the kiosk browser on the Pi and leaves the desktop showing. */
  async exitToDesktop(): Promise<void> {
    const res = await request('POST', '/api/kiosk/exit');
    if (!res.ok) throw new Error('Exit is not available here');
  },
};

// ---- Server-sent events -------------------------------------------------

type Handler = (data: any) => void;
const handlers = new Map<string, Set<Handler>>();
let source: EventSource | null = null;

function ensureSource(event: string) {
  if (!source) source = new EventSource('/api/events');
  if (handlers.has(event)) return;
  handlers.set(event, new Set());
  source.addEventListener(event, (e) => {
    const data = JSON.parse((e as MessageEvent).data);
    // This screen already applied its own changes; only react to other screens.
    if (data && data.clientId === clientId) return;
    handlers.get(event)?.forEach((h) => h(data));
  });
}

export function onServerEvent<T>(event: string, handler: (data: T) => void): () => void {
  ensureSource(event);
  handlers.get(event)!.add(handler);
  return () => handlers.get(event)?.delete(handler);
}

// ---- Widget storage -----------------------------------------------------

const localListeners = new Map<string, Set<{ owner: object; handler: () => void }>>();

export function createStorage(key: string): WidgetStorage {
  const owner = {};
  return {
    async load<T>(fallback: T): Promise<T> {
      const res = await request('GET', `/api/store/${encodeURIComponent(key)}`);
      return res.status === 404 ? fallback : ((await res.json()) as T);
    },
    async save(value) {
      await request('PUT', `/api/store/${encodeURIComponent(key)}`, value);
      // Tell other tiles on this screen that share the key.
      localListeners.get(key)?.forEach((l) => l.owner !== owner && l.handler());
    },
    onChange(handler) {
      const entry = { owner, handler };
      if (!localListeners.has(key)) localListeners.set(key, new Set());
      localListeners.get(key)!.add(entry);
      const off = onServerEvent<{ key: string }>('store', (d) => d.key === key && handler());
      return () => {
        localListeners.get(key)?.delete(entry);
        off();
      };
    },
  };
}
