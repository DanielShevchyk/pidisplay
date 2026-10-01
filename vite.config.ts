import { defineConfig } from 'vite';

// In dev, Vite serves the UI with hot reload and forwards /api to the Node server.
export default defineConfig({
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8080' },
  },
  build: {
    // Chromium on Raspberry Pi OS is recent; no need to ship legacy syntax.
    target: 'chrome110',
  },
});
