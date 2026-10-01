import { api } from './core/api';
import { App } from './core/app';
import './styles.css';

const root = document.getElementById('app')!;
// ?kiosk hides the cursor for the wall display; leave it off when editing from a laptop.
if (new URLSearchParams(location.search).has('kiosk')) document.body.classList.add('kiosk');

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
