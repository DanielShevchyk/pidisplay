// Drag-to-scroll for the wall panel. labwc can hand touches to Chromium as an
// emulated mouse, and a mouse drag doesn't scroll a page, so with the scroll
// bars hidden lists would be stuck. This scrolls whatever is under the finger
// on a drag, with a little momentum, and swallows the click that ends it.
// Real touch events are left alone: Chromium already scrolls those natively.

const START_PX = 8;
const FRICTION = 0.95;

function scrollable(el: HTMLElement, axis: 'x' | 'y'): boolean {
  const s = getComputedStyle(el);
  const overflow = axis === 'y' ? s.overflowY : s.overflowX;
  if (overflow !== 'auto' && overflow !== 'scroll') return false;
  return axis === 'y' ? el.scrollHeight > el.clientHeight + 1 : el.scrollWidth > el.clientWidth + 1;
}

// Nearest scrollable ancestor, or null if something on the way handles its own
// drags (touch-action: none marks the stock chart, keyboard and edit-mode tiles).
function findScroller(target: HTMLElement): { el: HTMLElement; x: boolean; y: boolean } | null {
  for (let el: HTMLElement | null = target; el && el !== document.body; el = el.parentElement) {
    if (getComputedStyle(el).touchAction === 'none') return null;
    const y = scrollable(el, 'y');
    const x = scrollable(el, 'x');
    if (x || y) return { el, x, y };
  }
  return null;
}

export function initDragScroll() {
  let anim = 0;

  document.addEventListener('dragstart', (e) => e.preventDefault());

  document.addEventListener(
    'pointerdown',
    (down) => {
      cancelAnimationFrame(anim);
      if (down.pointerType === 'touch' || down.button !== 0) return;
      const target = down.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable]')) return;
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

      const move = (e: PointerEvent) => {
        if (e.pointerId !== down.pointerId) return;
        const dx = e.clientX - down.clientX;
        const dy = e.clientY - down.clientY;
        if (!dragging) {
          // Only claim drags along an axis this element scrolls, so sideways
          // swipes still change dashboard pages.
          const alongY = Math.abs(dy) >= Math.abs(dx);
          if (Math.hypot(dx, dy) < START_PX) return;
          if (alongY ? !sc.y : !sc.x) return stop();
          dragging = true;
        }
        if (sc.x) el.scrollLeft = startLeft - dx;
        if (sc.y) el.scrollTop = startTop - dy;
        const dt = Math.max(1, e.timeStamp - lastT);
        vx = (e.clientX - lastX) / dt;
        vy = (e.clientY - lastY) / dt;
        lastX = e.clientX;
        lastY = e.clientY;
        lastT = e.timeStamp;
      };

      const up = (e: PointerEvent) => {
        if (e.pointerId !== down.pointerId) return;
        stop();
        if (!dragging) return;
        // The release would otherwise count as a tap on whatever is under it.
        const swallow = (c: Event) => {
          c.preventDefault();
          c.stopPropagation();
        };
        window.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('click', swallow, true), 50);
        // A pause before lifting means no fling.
        if (e.timeStamp - lastT > 80) return;
        let last = performance.now();
        const glide = (now: number) => {
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
