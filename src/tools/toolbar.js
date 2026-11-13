/**
 * @module tools/toolbar
 * Builds a tool toolbar from a declarative spec and returns a handle for live
 * updates. Owns toolbar/section/control DOM, button wiring (onClick/action/
 * opens), and toggle binding; the action handlers, pickers, and persisted
 * toggle state stay with the caller (passed via deps). Tooling layer only.
 */

// Small element helpers, mirroring the tools.css class names.
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

// Tool buttons are clicked, not keyboard-navigated, so they stay out of the tab
// order — click-focus would otherwise steal Shift/etc. from canvas tools.
function makeButton(cls, text) {
  const b = el('button', cls, text);
  b.tabIndex = -1;
  return b;
}

// ══ Controls ═════════════════════════════

function invoke(actions, id) {
  const fn = actions[id];
  if (fn) fn();
  else console.warn(`toolbar references unknown action: ${id}`);
}

// A live dim text span (scene name, running scripts, coords). `fixed` gives it
// a fixed width so a changing value (e.g. coordinates) doesn't jitter the bar.
// `opens` makes the readout itself the anchor for a picker (it stays a readout,
// so the per-frame `set` handle is unaffected).
function buildReadout(c, container, ctx) {
  let cls = 'tools-dim' + (c.fixed ? ' tools-coords' : '');
  if (c.opens) cls += ' clickable';
  const span = el('span', cls, c.text || '');
  if (c.opens && ctx.pickers) {
    span.addEventListener('click', function () { ctx.pickers.toggle(c.opens, span); });
  }
  container.appendChild(span);
  ctx.registry[c.readout] = { set: function (t) { span.textContent = t; } };
}

function buildButton(c, container, ctx) {
  let cls = 'tools-btn';
  if (c.icon) cls += ' icon';
  if (c.alwaysEnabled) cls += ' always-on';
  const b = makeButton(cls, c.text);
  if (c.title) b.title = c.title;
  // Click resolution, in priority order: a direct handler, a named action, or
  // opening a picker (anchored to this button).
  b.addEventListener('click', function () {
    if (c.onClick) c.onClick();
    else if (c.action) invoke(ctx.actions, c.action);
    else if (c.opens && ctx.pickers) ctx.pickers.toggle(c.opens, b);
  });
  container.appendChild(b);
  ctx.registry[c.button] = {
    el: b,
    setText: function (t) { b.textContent = t; },
  };
}

// Persisted on/off button. State lives in the caller (get/set); the handle's
// setActive lets other code repaint it without owning the source of truth.
function buildToggle(c, container, ctx) {
  const b = makeButton('tools-btn toggle', c.text);
  if (c.color) b.style.color = c.color;
  if (c.get()) b.classList.add('active');
  b.addEventListener('click', function () {
    c.set(!c.get());
    b.classList.toggle('active', c.get());
  });
  container.appendChild(b);
  ctx.registry[c.toggle] = {
    el: b,
    setActive: function (on) { b.classList.toggle('active', on); },
  };
}

function buildControl(c, container, ctx) {
  if (c.badge !== undefined) container.appendChild(el('span', 'tools-badge', c.badge));
  else if (c.readout !== undefined) buildReadout(c, container, ctx);
  else if (c.toggle !== undefined) buildToggle(c, container, ctx);
  else if (c.button !== undefined) buildButton(c, container, ctx);
}

// A `·` separates adjacent interactive controls (buttons/toggles), not a badge
// or readout sitting alongside them.
function isSeparable(c) {
  return c.button !== undefined || c.toggle !== undefined;
}

// ══ Toolbar ══════════════════════════════

/**
 * Builds the toolbar element from `spec.toolbar` (an array of groups). A group
 * is a section `{ label?, controls }` or a `{ spacer: true }` flex gap; controls
 * within a section are auto-separated by a `·`. `deps.actions` resolves button
 * `action` ids; `deps.pickers` (a pickerGroup handle) backs a control's `opens`
 * (buttons and readouts alike).
 *
 * @returns { el, get(id), setEnabled(on) } — the root element to mount, a
 *   registry of control handles keyed by id (button: el/setText; toggle:
 *   el/setActive; readout: set), and a whole-bar enable toggle (the `.no-scene`
 *   state; `alwaysEnabled` controls stay live).
 */
export function buildToolbar(spec, deps) {
  deps = deps || {};
  const ctx = { actions: deps.actions || {}, pickers: deps.pickers, registry: {} };

  const root = el('div', 'tools-toolbar');
  const groups = spec.toolbar;
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    const container = el('div', group.spacer ? 'tools-spacer' : 'tools-section');
    if (group.label) container.appendChild(el('span', 'tools-label', group.label));
    const controls = group.controls || [];
    let prevSeparable = false;
    for (let ci = 0; ci < controls.length; ci++) {
      const c = controls[ci];
      const separable = isSeparable(c);
      if (prevSeparable && separable) container.appendChild(el('span', 'tools-sep', '·'));
      buildControl(c, container, ctx);
      prevSeparable = separable;
    }
    root.appendChild(container);
  }

  return {
    el: root,
    get: function (id) { return ctx.registry[id]; },
    // Disables every control except those marked alwaysEnabled (CSS: .no-scene).
    setEnabled: function (on) { root.classList.toggle('no-scene', !on); },
  };
}
