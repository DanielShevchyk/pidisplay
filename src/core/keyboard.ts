// Built-in on-screen keyboard. The kiosk runs Chromium full screen, which covers
// the OS keyboard (squeekboard), so the app brings its own. It slides up whenever
// a text field gets focus and goes away when focus leaves or Hide is tapped.
import { h } from './dom';
import './keyboard.css';

type Field = HTMLInputElement | HTMLTextAreaElement;
type Layer = 'letters' | 'symbols' | 'numbers';

const TEXT_TYPES = new Set(['text', 'search', 'password', 'email', 'url', 'tel', 'number']);
// Chromium only allows selection APIs (setRangeText, selectionStart) on these.
const SELECTABLE = new Set(['text', 'search', 'password', 'url', 'tel']);

// Special keys: ⌫ backspace, ↵ enter, ⇧ shift, ␣ space, plus layer switches.
const LAYOUTS: Record<Layer, string[][]> = {
  letters: [
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', '⌫'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', "'", '↵'],
    ['⇧', 'z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '-'],
    ['?123', '@', '␣', 'hide'],
  ],
  symbols: [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '⌫'],
    ['!', '?', '#', '$', '%', '&', '*', '(', ')', '"', '↵'],
    ['+', '=', '/', '\\', ':', ';', '_', '~', '<', '>', '|'],
    ['ABC', '.', '␣', 'hide'],
  ],
  numbers: [
    ['1', '2', '3'],
    ['4', '5', '6'],
    ['7', '8', '9'],
    ['-', '0', '.', '⌫'],
    ['hide', '↵'],
  ],
};

const LABELS: Record<string, string> = { '⌫': '⌫', '↵': 'Enter', '⇧': '⇧', '␣': 'space', hide: 'Hide ⌄' };

function isField(el: Element | null): el is Field {
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  return el instanceof HTMLInputElement && TEXT_TYPES.has(el.type) && !el.readOnly && !el.disabled;
}

export function initKeyboard(): void {
  let target: Field | null = null;
  let layer: Layer = 'letters';
  let shift = false;
  let repeat: number | undefined;
  let watch: number | undefined;
  const startValues = new WeakMap<Field, string>();

  const keys = h('div', { class: 'osk-keys' });
  const root = h('div', { class: 'osk', 'aria-hidden': 'true' }, keys);
  // Keep focus in the field: no key press may blur it.
  root.addEventListener('pointerdown', (e) => e.preventDefault());
  root.addEventListener('mousedown', (e) => e.preventDefault());
  document.body.append(root);

  function render() {
    const rows = LAYOUTS[layer].map((row) =>
      h(
        'div',
        { class: 'osk-row' },
        ...row.map((k) => {
          const label = LABELS[k] ?? (shift && k.length === 1 ? k.toUpperCase() : k);
          const key = h('button', { class: `osk-key osk-${keyClass(k)}${k === '⇧' && shift ? ' on' : ''}`, tabindex: -1 }, label);
          key.addEventListener('pointerdown', () => press(k, key));
          for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) {
            key.addEventListener(ev, () => {
              key.classList.remove('down');
              clearTimeout(repeat);
            });
          }
          return key;
        }),
      ),
    );
    keys.className = `osk-keys osk-${layer}`;
    keys.replaceChildren(...rows);
  }

  function keyClass(k: string): string {
    if (k === '␣') return 'space';
    if (k === '↵') return 'enter';
    if (k === '⌫') return 'back';
    if (k.length > 1 || k === '⇧') return 'mod';
    return 'char';
  }

  function press(k: string, key: HTMLElement) {
    key.classList.add('down');
    if (!target) return;
    switch (k) {
      case '⌫':
        backspace();
        // Hold to keep deleting.
        repeat = window.setTimeout(function again() {
          backspace();
          repeat = window.setTimeout(again, 70);
        }, 450);
        return;
      case '↵':
        return enter();
      case '⇧':
        shift = !shift;
        return render();
      case '?123':
        layer = 'symbols';
        return render();
      case 'ABC':
        layer = 'letters';
        return render();
      case 'hide':
        return target.blur();
      case '␣':
        return insert(' ');
      default:
        insert(shift ? k.toUpperCase() : k);
        if (shift) {
          shift = false;
          render();
        }
    }
  }

  function canSelect(el: Field) {
    return el instanceof HTMLTextAreaElement || SELECTABLE.has(el.type);
  }

  function insert(text: string) {
    const el = target!;
    if (el.maxLength > 0 && el.value.length >= el.maxLength) return;
    if (canSelect(el)) {
      el.setRangeText(text, el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length, 'end');
    } else {
      el.value += text;
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }

  function backspace() {
    const el = target;
    if (!el) return;
    if (canSelect(el)) {
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? start;
      if (start === end && start === 0) return;
      el.setRangeText('', start === end ? start - 1 : start, end, 'end');
    } else {
      if (!el.value) return;
      el.value = el.value.slice(0, -1);
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
  }

  function enter() {
    const el = target!;
    if (el instanceof HTMLTextAreaElement) return insert('\n');
    const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
    // Like a phone keyboard: Enter on a single-line field means done.
    if (document.activeElement === el) el.blur();
  }

  function show(el: Field) {
    target = el;
    if (!startValues.has(el)) startValues.set(el, el.value);
    layer = el.type === 'number' || el.inputMode === 'numeric' || el.inputMode === 'decimal' || el.type === 'tel' ? 'numbers' : 'letters';
    shift = false;
    render();
    root.classList.add('open');
    document.body.classList.add('osk-open');
    document.documentElement.style.setProperty('--osk-h', `${root.offsetHeight}px`);
    // Once the sheet has moved up, make sure the field is above the keyboard.
    setTimeout(() => target === el && el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 260);
    // Closing a sheet removes its fields without a blur event; don't leave the keyboard up.
    clearInterval(watch);
    watch = window.setInterval(() => target?.isConnected || hide(), 300);
  }

  function hide() {
    target = null;
    clearTimeout(repeat);
    clearInterval(watch);
    root.classList.remove('open');
    document.body.classList.remove('osk-open');
  }

  document.addEventListener('focusin', (e) => {
    if (isField(e.target as Element)) show(e.target as Field);
  });

  document.addEventListener('focusout', (e) => {
    const el = e.target as Element;
    if (!isField(el)) return;
    // Typing here is programmatic, so the browser won't fire change on blur by itself.
    const before = startValues.get(el);
    startValues.delete(el);
    if (before !== undefined && before !== el.value) el.dispatchEvent(new Event('change', { bubbles: true }));
    // Focus may be moving straight to another field; only hide if it isn't.
    setTimeout(() => {
      if (!isField(document.activeElement)) hide();
    });
  });
}
