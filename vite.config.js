import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    // Only the game ships. `input` governs the production build (`vite build`)
    // only — the dev server serves any root .html regardless — so listing just
    // index.html keeps the dev tools (design.html / midi.html, plus the
    // DEV-gated debug.js) out of dist while leaving them reachable in `vite dev`.
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
      },
    },
  },
});
