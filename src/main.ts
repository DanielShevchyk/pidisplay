import { api } from './core/api';
import { App } from './core/app';
import { initKeyboard } from './core/keyboard';
import { initTheme } from './core/theme';
import './styles.css';

const root = document.getElementById('app')!;
// ?kiosk hides the cursor for the wall display; leave it off when editing from a laptop.
const params = new URLSearchParams(location.search);
if (params.has('kiosk')) document.body.classList.add('kiosk');
initTheme();
// The kiosk covers the OS keyboard, so touch typing uses the app's own (?osk to try it elsewhere).
if (params.has('kiosk') || params.has('osk')) initKeyboard();

async function start() {
  try {
    new App(root, await api.getLayout());
  } catch (err) {
    // On boot Chromium can start before the server; keep retrying instead of showing a dead screen.
    console.error(err);
    root.textContent = 'Waiting for PiDisplay server…';
    setTimeout(start, 3000);
  }
}
start();
