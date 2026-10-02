// "Exit to desktop" for the wall display. deploy/kiosk.sh is kept alive by
// lwrespawn, so killing Chromium alone would just relaunch it. Instead we drop a
// flag file that kiosk.sh waits on, then close Chromium. The flag lives in the
// user's runtime dir (tmpfs), so a reboot always brings the dashboard back, and
// deploy/open-dashboard.sh (the desktop/menu launcher) removes it.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const FLAG_NAME = 'pidisplay-desktop';
// Matches only the kiosk browser (its command line holds the dashboard URL).
const CHROMIUM_PATTERN = 'chromium.*127.0.0.1:808[0]';

export function defaultFlagFile() {
  const runtime = process.env.XDG_RUNTIME_DIR || (process.getuid ? `/run/user/${process.getuid()}` : null);
  return runtime ? path.join(runtime, FLAG_NAME) : null;
}

export function createKiosk({
  flagFile = defaultFlagFile(),
  supported = process.platform === 'linux',
  closeBrowser = () =>
    new Promise((resolve) => {
      // pkill exits 1 when nothing matched; that's fine.
      execFile('pkill', ['-f', CHROMIUM_PATTERN], () => resolve());
    }),
} = {}) {
  return {
    supported: Boolean(supported && flagFile),
    async exit() {
      await fs.writeFile(flagFile, `${new Date().toISOString()}\n`);
      // Give the HTTP response a moment to reach the browser before closing it.
      setTimeout(() => void closeBrowser(), 500).unref();
    },
  };
}
