// Shared bits for the lifting pages: theme, navigation, API calls, formatting.
// URLs are relative so the pages work at PiDisplay's /lifting/ and on port 8090.

const params = new URLSearchParams(location.search);
function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    return null;
  }
}
// ?theme from the dashboard tile, else PiDisplay's own saved theme (same origin under /lifting/).
const theme = params.get('theme') || store('lifting-theme') || store('pidisplay.theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
if (params.get('theme')) store('lifting-theme', theme);
document.documentElement.dataset.theme = theme;

export function nav(active) {
  const links = [
    ['trend', 'Trends', './#trend'],
    ['volume', 'Volume', './#volume'],
    ['prs', 'PRs', './#prs'],
    ['dunk', 'Dunk goal', './#dunk'],
    ['log', 'Log', 'log'],
    ['import', 'Import', 'import'],
  ];
  const el = h('nav', { class: 'nav' }, h('span', { class: 'brand' }, '🏋️ Lifting'));
  for (const [id, label, href] of links) {
    el.append(h('a', { href, class: id === active ? 'active' : '', 'data-view': id }, label));
  }
  document.body.prepend(el);
  return el;
}

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export async function api(path, opts = {}) {
  const init = { ...opts, headers: { ...(opts.headers || {}) } };
  if (opts.json !== undefined) {
    init.body = JSON.stringify(opts.json);
    init.headers['Content-Type'] = 'application/json';
    delete init.json;
  }
  const res = await fetch(path, init);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { detail: text };
  }
  if (!res.ok) {
    const d = data && (data.detail ?? data.errors ?? data.error);
    const msg = Array.isArray(d) ? d.map((x) => (typeof x === 'string' ? x : x.msg)).join('; ') : d || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

let toastTimer;
export function toast(msg, isError = false) {
  document.querySelector('.toast')?.remove();
  const el = h('div', { class: `toast${isError ? ' error' : ''}` }, msg);
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 3500);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function shortDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}
export function longDate(iso) {
  const dt = new Date(`${iso}T12:00:00`);
  return `${dt.toLocaleDateString(undefined, { weekday: 'short' })} ${shortDate(iso)}, ${iso.slice(0, 4)}`;
}
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function num(v, digits = 1) {
  if (v === null || v === undefined) return '–';
  return Number.isInteger(v) ? String(v) : v.toFixed(digits).replace(/\.0$/, '');
}
export function lb(v) {
  return v === null || v === undefined ? '–' : `${num(v)} lb`;
}
export const BASIS = { total: 'total', per_hand: 'each hand', per_arm: 'each arm', per_side: 'each side' };
export function feetInches(inches) {
  const ft = Math.floor(inches / 12);
  const rest = Math.round((inches - ft * 12) * 2) / 2;
  return `${ft}′${num(rest)}″`;
}
