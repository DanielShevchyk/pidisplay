// Bottom-sheet modal plus a form renderer for widget settings. Sized for fingers.
import { h } from './dom';
import type { SettingField, WidgetConfig } from './types';

export interface SheetHandle {
  close(): void;
  body: HTMLElement;
}

let current: SheetHandle | null = null;

export function openSheet(title: string, content: Node[], opts: { onClose?: () => void } = {}): SheetHandle {
  current?.close();
  const body = h('div', { class: 'sheet-body' }, ...content);
  const panel = h(
    'div',
    { class: 'sheet', role: 'dialog', 'aria-label': title },
    h(
      'div',
      { class: 'sheet-head' },
      h('h2', {}, title),
      h('button', { class: 'btn btn-ghost', onclick: () => handle.close(), 'aria-label': 'Close' }, '✕'),
    ),
    body,
  );
  const backdrop = h('div', { class: 'sheet-backdrop' }, panel);
  backdrop.addEventListener('pointerdown', (e) => {
    if (e.target === backdrop) handle.close();
  });
  document.body.append(backdrop);
  requestAnimationFrame(() => backdrop.classList.add('open'));

  const handle: SheetHandle = {
    body,
    close() {
      if (current === handle) current = null;
      backdrop.remove();
      opts.onClose?.();
    },
  };
  current = handle;
  return handle;
}

/** Renders inputs for fields; calls onChange with the full updated config on every edit. */
export function settingsForm(
  fields: SettingField[],
  config: WidgetConfig,
  onChange: (next: WidgetConfig) => void,
): HTMLElement {
  const values: WidgetConfig = { ...config };
  const set = (key: string, value: unknown) => {
    values[key] = value;
    onChange({ ...values });
  };

  return h(
    'div',
    { class: 'form' },
    ...fields.map((f) => {
      const id = `field-${f.key}`;
      let input: HTMLElement;
      switch (f.type) {
        case 'boolean':
          input = h('input', {
            id,
            type: 'checkbox',
            class: 'toggle',
            checked: Boolean(values[f.key]),
            onchange: (e: Event) => set(f.key, (e.target as HTMLInputElement).checked),
          });
          break;
        case 'number':
          input = h('input', {
            id,
            type: 'number',
            inputmode: 'numeric',
            value: String(values[f.key] ?? ''),
            min: f.min,
            max: f.max,
            step: f.step,
            onchange: (e: Event) => {
              const n = Number((e.target as HTMLInputElement).value);
              if (!Number.isNaN(n)) set(f.key, n);
            },
          });
          break;
        case 'select':
          input = h(
            'select',
            { id, onchange: (e: Event) => set(f.key, (e.target as HTMLSelectElement).value) },
            ...f.options.map((o) =>
              h('option', { value: o.value, selected: values[f.key] === o.value }, o.label),
            ),
          );
          break;
        case 'text':
          input = h('input', {
            id,
            type: 'text',
            value: String(values[f.key] ?? ''),
            placeholder: f.placeholder,
            onchange: (e: Event) => set(f.key, (e.target as HTMLInputElement).value),
          });
          break;
      }
      return h('label', { class: `field field-${f.type}`, for: id }, h('span', {}, f.label), input);
    }),
  );
}
