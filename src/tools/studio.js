/**
 * @module tools/studio
 * Standalone tool host: composes the toolbar, pickers, and shortcuts from a
 * single descriptor and owns the page-level concerns (title, the `--vh` viewport
 * unit, the content region adopted from #app). Hosted tools like debug.js skip this
 * and compose the descriptor-layer modules (toolbar/picker/shortcuts) directly with
 * the same descriptors.
 */

import { buildToolbar } from './toolbar.js';
import { pickerGroup } from './picker.js';
import { registerShortcuts } from './shortcuts.js';

/**
 * Builds and mounts a standalone tool from a descriptor
 * `{ title?, actions?, toolbar, pickers?, shortcuts? }`. The toolbar overlays
 * the content region; pickers and shortcuts resolve against `actions`.
 *
 * @returns the studio: `content` (the work surface), `get(id)` for toolbar
 *   control handles, `setEnabled(on)` (the no-scene disabled state),
 *   `createCanvas(opts)` (opt-in overlay canvas), and `open`/`close`/`refresh`
 *   over the pickers.
 */
export function createStudio(desc) {
  if (desc.title) document.title = desc.title;

  // The content region is the work surface beneath the overlaid toolbar. Adopt
  // #app — the layout/sizing contract already shared with the engine — and tag
  // it as a styling hook. Default cursor; canvas tools set their own.
  const content = document.getElementById('app');
  content.classList.add('studio-content');
  content.style.cursor = 'default';

  const pickers = pickerGroup(desc.pickers || {});
  const toolbar = buildToolbar({ toolbar: desc.toolbar }, { actions: desc.actions, pickers: pickers });
  document.body.appendChild(toolbar.el);

  if (desc.shortcuts) registerShortcuts(desc.shortcuts, { actions: desc.actions || {} });

  // --vh is what base.css sizes `html, body` with, standing in for `1vh` because
  // mobile Safari's vh unit measures the viewport with the URL bar collapsed —
  // taller than what's actually visible. A page-level concern, so it belongs to
  // the studio itself: every tool page loads base.css, canvas or not (the MIDI
  // Studio has no canvas). The engine does the same for the game page (game.js).
  function refreshVh() {
    document.documentElement.style.setProperty('--vh', window.innerHeight * 0.01 + 'px');
  }
  window.addEventListener('resize', refreshVh);
  refreshVh();

  // Optional capability: a full-bleed overlay canvas in the content region.
  // Studio owns the canvas's viewport dimensions and its resize listener, and
  // drives `loop` via requestAnimationFrame; the tool owns all drawing.
  function createCanvas(opts) {
    opts = opts || {};
    const canvas = document.createElement('canvas');
    canvas.className = 'tools-canvas';
    content.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    // Studio owns this canvas's logical viewport size (viewW/viewH, CSS px), mirroring
    // the runtime's ownership in render.js. The backing store is device px (CSS px ×
    // dpr) with a matching transform so overlays stay crisp on HiDPI/iOS; drawing code
    // works in CSS px and reads the viewport (via viewportSize) for layout, never the
    // device-px canvas.width/height. setTransform must follow the width/height
    // assignment, which resets the context state.
    //
    // The layout viewport is the right source here, and the same box `.tools-canvas`
    // covers (position:fixed at 100%/100%, no scrollbars). render.js instead follows
    // the *visual* viewport, because the game has to stay pinned under pinch-zoom and
    // the iOS keyboard; an authoring page doesn't. Not a divergence to unify.
    let viewW = 0, viewH = 0;
    function size() {
      viewW = window.innerWidth;
      viewH = window.innerHeight;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(viewW * dpr);
      canvas.height = Math.round(viewH * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    window.addEventListener('resize', function () { size(); if (opts.onResize) opts.onResize(); });
    size();
    if (opts.loop) {
      requestAnimationFrame(function frame() { opts.loop(); requestAnimationFrame(frame); });
    }
    return {
      canvas: canvas,
      ctx: ctx,
      viewportSize: function () { return { w: viewW, h: viewH }; },
    };
  }

  return {
    content: content,
    get: toolbar.get,
    setEnabled: toolbar.setEnabled,
    createCanvas: createCanvas,
    open: pickers.open,
    close: pickers.close,
    refresh: pickers.refresh,
  };
}
