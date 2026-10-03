# Writing a widget

A widget is a folder in `src/widgets/` with an `index.ts` that default-exports a definition. It is picked up automatically on the next build; nothing else needs registering. Folders starting with `_` are ignored.

```ts
// src/widgets/hello/index.ts
import { h } from '../../core/dom';
import { defineWidget } from '../../core/types';
import './hello.css'; // optional; prefix class names with the widget id

interface HelloConfig {
  name: string;
  [key: string]: unknown;
}

export default defineWidget<HelloConfig>({
  type: 'hello',              // stored in layout.json, never rename once used
  name: 'Hello',
  description: 'Greets someone',
  icon: '👋',
  sizes: ['small', 'medium', 'large'],
  defaultSize: 'small',
  defaultConfig: { name: 'Dan' },
  settings: [{ key: 'name', label: 'Name', type: 'text' }],

  mount(el, ctx) {
    el.append(h('div', { class: 'hello' }, `Hello, ${ctx.config.name}`));
    return { destroy() { /* clear timers, abort fetches */ } };
  },
});
```

## The contract

`mount(el, ctx)` renders into `el` and may return `{ destroy }`. The shell calls `destroy()` and mounts again whenever the tile's size or settings change, so treat `ctx` as fixed for one mount.

`ctx` gives you:

| Field | Use |
| --- | --- |
| `placement` | `'small' \| 'medium' \| 'tall' \| 'large' \| 'xlarge' \| 'full'`, or `'bar'` in the top bar. Use it to show more or less. The shell also offers every widget three page-spanning sizes: a Full-width row renders as `'medium'`, a Top/bottom half as `'xlarge'` and a Left/right half as `'large'`, stretched to fit (the tile element carries the real size in `data-size`). Widgets only need to list sizes they handle themselves. |
| `config` | `defaultConfig` merged with what the user set in ⚙. |
| `settings` (on the definition) | Fields of type `boolean`, `text`, `number`, `select`; the shell builds the form. |
| `storage` | Persistent JSON for this tile only: `await storage.load(fallback)`, `await storage.save(value)`, `storage.onChange(fn)`. |
| `sharedStorage` | Same, shared by every tile of this widget type (e.g. one grocery list shown on two pages). |
| `notify({ title, body, level })` | Toast plus an entry in the bell, tagged with the widget's name. |
| `on(event, fn)` | Server events, e.g. `'notification'`. |
| `editing` | True while the user is rearranging; tiles don't receive touches then. |

Subscriptions made through `storage.onChange` and `on` are cleaned up automatically on unmount; your own timers and listeners are your job in `destroy()`.

## Sizing

`el` is a CSS size container, so `cqw`/`cqh` units scale text to the tile: `font-size: min(26cqw, 48cqh)`. The `clock` widget is the reference example, including a compact top-bar view (`supportsBar: true` and `placement === 'bar'`).

## Colors

Use the CSS variables from `src/styles.css` (`--text`, `--text-dim`, `--surface-2`, `--border`, `--accent`, `--success`, `--warning`, `--danger`, `--shadow`) instead of fixed colors, so the widget works in both the dark and light themes. If you need a rule for one theme only, scope it with `:root[data-theme='light']`.

## Data from the network

Keep API keys and polling on the server side when a service needs secrets; add a route in `server/server.js` and fetch it from the widget. Public APIs without keys can be called from the widget directly. Cache last results in `sharedStorage` so the tile shows something immediately after a reboot.
