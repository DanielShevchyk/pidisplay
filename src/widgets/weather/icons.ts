// Two-tone weather icons drawn as inline SVG, replacing the emoji the widget used
// to show (which looked different on every system and clashed with the rest).
// wxIcon() returns an element sized by font-size, so existing CSS sizes still apply.

const NS = 'http://www.w3.org/2000/svg';

const DEFS = `
<linearGradient id="wxg-sun" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffdc73"/><stop offset="1" stop-color="#ff9f2e"/></linearGradient>
<linearGradient id="wxg-cloud" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#d5e1f4"/></linearGradient>
<linearGradient id="wxg-dark" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#dfe6f2"/><stop offset="1" stop-color="#9eabc4"/></linearGradient>`;

const cloud = (fill: string, dy = 0, dx = 0) =>
  `<g fill="url(#${fill})" transform="translate(${dx} ${dy})"><circle cx="25.6" cy="42.2" r="9.6"/><circle cx="38.4" cy="35.8" r="12.8"/><circle cx="50" cy="42.2" r="9"/><rect x="25.6" y="39.7" width="24.4" height="12.1"/><rect x="16" y="42.2" width="43" height="9.6" rx="4.8"/></g>`;
const RAYS = [0, 45, 90, 135, 180, 225, 270, 315]
  .map((a) => `<line x1="32" y1="6" x2="32" y2="10.5" transform="rotate(${a} 32 32)"/>`)
  .join('');
const SUN = `<circle cx="32" cy="32" r="14.5" fill="url(#wxg-sun)"/><g stroke="#ffb53d" stroke-width="3.6" stroke-linecap="round">${RAYS}</g>`;
const SUN_BEHIND = `<circle cx="24" cy="23" r="13.5" fill="url(#wxg-sun)"/>`;
const MOON = `<path transform="translate(7.5 7) scale(2.05)" fill="#ffe7a3" d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>`;
const MOON_BEHIND = `<path transform="translate(4 3) scale(1.5)" fill="#ffe7a3" d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>`;
const drops = (xs: number[]) =>
  `<g stroke="#7cc4ff" stroke-width="3.6" stroke-linecap="round">${xs.map((x) => `<line x1="${x}" y1="50" x2="${x - 2.4}" y2="58"/>`).join('')}</g>`;
const flakes = (xs: number[]) => `<g fill="#ffffff">${xs.map((x, i) => `<circle cx="${x}" cy="${i % 2 ? 58 : 53}" r="2.7"/>`).join('')}</g>`;
const BOLT = `<path fill="#ffd34d" d="M36 44l-8.5 11h6L30 63l11-12.5h-6.2L38 44z"/>`;
const FOG = `<g stroke="#ffffff" stroke-opacity="0.8" stroke-width="3.6" stroke-linecap="round"><line x1="14" y1="50" x2="50" y2="50"/><line x1="20" y1="58" x2="44" y2="58"/></g>`;

const ART: Record<string, string> = {
  sun: SUN,
  moon: MOON,
  'partly-day': SUN_BEHIND + cloud('wxg-cloud', 2, 1),
  'partly-night': MOON_BEHIND + cloud('wxg-cloud', 2, 1),
  cloudy: cloud('wxg-dark', -12, 8).replace('<g ', '<g opacity="0.75" ') + cloud('wxg-cloud', 2, -4),
  fog: cloud('wxg-cloud', -12) + FOG,
  drizzle: cloud('wxg-cloud', -10) + drops([27, 41]),
  rain: cloud('wxg-dark', -10) + drops([24, 35, 46]),
  snow: cloud('wxg-cloud', -10) + flakes([24, 32, 40, 48]),
  storm: cloud('wxg-dark', -10) + BOLT,
};

function kind(code: number, isDay: boolean): string {
  if (code === 0 || code === 1) return isDay ? (code ? 'partly-day' : 'sun') : 'moon';
  if (code === 2) return isDay ? 'partly-day' : 'partly-night';
  if (code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 57) return 'drizzle';
  if (code >= 61 && code <= 67) return 'rain';
  if (code >= 71 && code <= 77) return 'snow';
  if (code >= 80 && code <= 82) return 'rain';
  if (code === 85 || code === 86) return 'snow';
  if (code >= 95) return 'storm';
  return 'cloudy';
}

function ensureDefs() {
  if (document.getElementById('wx-defs')) return;
  const svg = document.createElementNS(NS, 'svg');
  svg.id = 'wx-defs';
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.setAttribute('style', 'position:absolute');
  svg.innerHTML = `<defs>${DEFS}</defs>`;
  document.body.append(svg);
}

/** Icon for a WMO weather code (Open-Meteo). */
export function wxIcon(code: number, isDay: boolean): SVGSVGElement {
  ensureDefs();
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('class', 'wx-ico');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ART[kind(code, isDay)];
  return svg;
}
