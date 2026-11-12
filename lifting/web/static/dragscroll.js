// Drag-to-scroll, ported from the dashboard (src/core/dragscroll.ts). labwc can hand the
// wall panel's touches to Chromium as an emulated mouse, and a mouse drag selects text
// instead of scrolling. This scrolls whatever is under the finger (the page itself when
// nothing inside scrolls), with a little momentum, and swallows the click that ends it.
// Real touch events are left alone: Chromium already scrolls those natively.

const START_PX = 8;
const FRICTION = 0.95;

function scrollable(el, axis) {
  const s = getComputedStyle(el);
  const overflow = axis === 'y' ? s.overflowY : s.overflowX;
  if (overflow !== 'auto' && overflow !== 'scroll') return false;
  return axis === 'y' ? el.scrollHeight > el.clientHeight + 1 : el.scrollWidth > el.clientWidth + 1;
}

function findScroller(target) {
  for (let el = target; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    if (getComputedStyle(el).touchAction === 'none') return null;
    const y = scrollable(el, 'y');
    const x = scrollable(el, 'x');
    if (x || y) return { el, x, y };
  }
  // Nothing inside scrolls: scroll the page.
  const page = document.scrollingElement || document.documentElement;
  const y = page.scrollHeight > page.clientHeight + 1;
  const x = page.scrollWidth > page.clientWidth + 1;
  return x || y ? { el: page, x, y } : null;
}

export function initDragScroll() {
  let anim = 0;
  document.addEventListener('dragstart', (e) => e.preventDefault());
  document.addEventListener(
    'pointerdown',
    (down) => {
      cancelAnimationFrame(anim);
      if (down.pointerType === 'touch' || down.button !== 0) return;
      const target = down.target;
      if (!(target instanceof Element) || target.closest('input, textarea, select, [contenteditable]')) return;
      const sc = findScroller(target);
      if (!sc) return;
      const { el } = sc;
      const startLeft = el.scrollLeft;
      const startTop = el.scrollTop;
      let dragging = false;
      let lastX = down.clientX;
      let lastY = down.clientY;
      let lastT = down.timeStamp;
      let vx = 0;
      let vy = 0;

      const move = (e) => {
        if (e.pointerId !== down.pointerId) return;
        const dx = e.clientX - down.clientX;
        const dy = e.clientY - down.clientY;
        if (!dragging) {
          const alongY = Math.abs(dy) >= Math.abs(dx);
          if (Math.hypot(dx, dy) < START_PX) return;
          // A drag across a table that only scrolls the other way falls back to the page.
          if (alongY ? !sc.y : !sc.x) return stop();
          dragging = true;
        }
        e.preventDefault();
        if (sc.x) el.scrollLeft = startLeft - dx;
        if (sc.y) el.scrollTop = startTop - dy;
        const dt = Math.max(1, e.timeStamp - lastT);
        vx = (e.clientX - lastX) / dt;
        vy = (e.clientY - lastY) / dt;
        lastX = e.clientX;
        lastY = e.clientY;
        lastT = e.timeStamp;
      };

      const up = (e) => {
        if (e.pointerId !== down.pointerId) return;
        stop();
        if (!dragging) return;
        const swallow = (c) => {
          c.preventDefault();
          c.stopPropagation();
        };
        window.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('click', swallow, true), 50);
        if (e.timeStamp - lastT > 80) return;
        let last = performance.now();
        const glide = (now) => {
          const dt = now - last;
          last = now;
          if (sc.x) el.scrollLeft -= vx * dt;
          if (sc.y) el.scrollTop -= vy * dt;
          const decay = Math.pow(FRICTION, dt / 16);
          vx *= decay;
          vy *= decay;
          if (Math.abs(vx) > 0.02 || Math.abs(vy) > 0.02) anim = requestAnimationFrame(glide);
        };
        anim = requestAnimationFrame(glide);
      };

      function stop() {
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', up, true);
        window.removeEventListener('pointercancel', up, true);
      }
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', up, true);
      window.addEventListener('pointercancel', up, true);
    },
    true,
  );
}
