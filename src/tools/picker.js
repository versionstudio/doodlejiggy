/**
 * @module tools/picker
 * Dropdown panels for tool toolbars — anchored list pickers with group
 * mutual-exclusion and outside-click + Escape dismissal.
 *
 * Owns panel DOM, positioning, open/close, and row rendering. The triggering
 * button is owned by the toolbar, which drives the returned handle's
 * toggle(id, anchorEl). Tooling layer only; never imported by the engine.
 */

// ══ Row rendering ════════════════════════

// Row state → row classes. `current` is the active, non-interactive entry;
// `clickable`/`selected` take whole-row selection; `disabled` lights on hover
// but rejects the click. Absent state = a plain row whose only affordance is
// its action glyph (e.g. a delete `x`).
const ROW_CLASS = {
  current:   ' current',
  clickable: ' clickable',
  selected:  ' clickable selected',
  disabled:  ' clickable disabled',
};

function renderRow(row) {
  const el = document.createElement('div');
  el.className = 'tools-dropdown-row' + (ROW_CLASS[row.state] || '');

  const label = document.createElement('span');
  label.className = 'tools-dropdown-label';
  label.textContent = row.label;
  el.appendChild(label);

  if (row.tag) {
    const tag = document.createElement('span');
    tag.className = 'tools-dropdown-type';
    tag.textContent = row.tag;
    el.appendChild(tag);
  }

  if (row.meta) {
    const meta = document.createElement('span');
    meta.className = 'tools-dropdown-meta';
    meta.textContent = row.meta;
    el.appendChild(meta);
  }

  if (row.action) {
    const action = document.createElement('span');
    action.className = 'tools-dropdown-action';
    action.textContent = row.action.glyph;
    // The glyph acts on its own and never closes the panel, so repeated edits
    // (e.g. clearing several flags) stay on one open list.
    action.addEventListener('click', function (e) {
      e.stopPropagation();
      row.action.onClick();
    });
    el.appendChild(action);
  }

  return el;
}

// ══ Panel group ══════════════════════════

/**
 * Builds a set of dropdown panels from a spec keyed by id. Each entry is either
 * a list panel `{ heading, rows, empty?, footer?, search?, group?, onClose?,
 * wide?, relaxed? }` — `rows()` returns row descriptors (see renderRow) freshly
 * on every open, `footer` either returns extra rows or renders its own DOM into
 * the panel, `search` (true or a placeholder string) adds an auto-focused field
 * that filters rows by label as you type, and `relaxed` loosens row spacing for
 * rows that carry badges/metadata (the simpler lists stay compact) — or
 * a custom-content panel `{ heading, content, group?, wide? }` whose
 * `content(panel)` fills the body. Panels sharing a `group` are mutually
 * exclusive — opening one closes its sibling. Outside-click and Escape dismiss
 * the open panel and notify `onClose(id)`; a row's `onSelect` completes the pick
 * and closes the panel without notifying.
 *
 * @returns a handle: toggle(id, anchorEl), open(id, anchorEl), close(id),
 *   refresh(id), isOpen(id). The toolbar owns the triggering button and drives
 *   toggle, passing the button as the anchor for positioning.
 */
export function pickerGroup(spec) {
  const ids = Object.keys(spec);
  const panels = {};
  const anchors = {}; // id → the button a panel is positioned under, for outside-click hit testing
  const queries = {}; // id → live search text, for panels with def.search

  for (let i = 0; i < ids.length; i++) {
    const panel = document.createElement('div');
    panel.className = 'tools-dropdown';
    if (spec[ids[i]].wide) panel.classList.add('wide');
    if (spec[ids[i]].relaxed) panel.classList.add('relaxed');
    panel.style.display = 'none';
    document.body.appendChild(panel);
    panels[ids[i]] = panel;
  }

  function isOpen(id) {
    return panels[id].style.display !== 'none';
  }

  function appendRow(panel, id, row) {
    const el = renderRow(row);
    if (row.onSelect && (row.state === 'clickable' || row.state === 'selected')) {
      el.addEventListener('click', function () { row.onSelect(); close(id); });
    }
    panel.appendChild(el);
  }

  // A search field below the heading; client-side filters the rendered rows by
  // label as you type. Escape bubbles to the dismiss handler; other keys are
  // swallowed so typing never reaches tool shortcuts or the game beneath.
  function renderSearch(id, panel) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'tools-dropdown-search';
    input.placeholder = typeof spec[id].search === 'string' ? spec[id].search : 'search…';
    input.value = queries[id] || '';
    input.addEventListener('input', function () { queries[id] = input.value; applyFilter(id); });
    input.addEventListener('keydown', function (e) { if (e.key !== 'Escape') e.stopPropagation(); });
    panel.appendChild(input);
  }

  function applyFilter(id) {
    const q = (queries[id] || '').trim().toLowerCase();
    const rows = panels[id].querySelectorAll('.tools-dropdown-row');
    for (let i = 0; i < rows.length; i++) {
      const label = rows[i].querySelector('.tools-dropdown-label');
      const text = label ? label.textContent.toLowerCase() : '';
      rows[i].style.display = !q || text.indexOf(q) !== -1 ? '' : 'none';
    }
  }

  function render(id) {
    const def = spec[id];
    const panel = panels[id];
    panel.innerHTML = '';

    const heading = document.createElement('div');
    heading.className = 'tools-dropdown-heading';
    heading.textContent = def.heading;
    panel.appendChild(heading);

    if (def.search) renderSearch(id, panel);

    // Custom-content panel (e.g. a form) owns its own body below the heading.
    if (def.content) { def.content(panel); return; }

    const rows = def.rows();
    if (rows.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'tools-label';
      empty.textContent = def.empty || '';
      panel.appendChild(empty);
    } else {
      for (let i = 0; i < rows.length; i++) appendRow(panel, id, rows[i]);
    }

    // A footer either returns extra rows or renders arbitrary DOM (e.g. an
    // input) into the panel itself.
    if (def.footer) {
      const extra = def.footer(panel);
      if (Array.isArray(extra)) for (let i = 0; i < extra.length; i++) appendRow(panel, id, extra[i]);
    }

    if (def.search) applyFilter(id);
  }

  function open(id, anchorEl) {
    const group = spec[id].group;
    if (group) {
      for (let i = 0; i < ids.length; i++) {
        if (ids[i] !== id && spec[ids[i]].group === group && isOpen(ids[i])) close(ids[i]);
      }
    }

    anchors[id] = anchorEl;
    render(id);

    const r = anchorEl.getBoundingClientRect();
    panels[id].style.left = Math.round(r.left) + 'px';
    panels[id].style.display = 'flex';

    if (spec[id].search) {
      const input = panels[id].querySelector('.tools-dropdown-search');
      if (input) input.focus();
    }
  }

  // Closes one panel, or all of them when called with no id.
  function close(id) {
    if (id === undefined) {
      for (let i = 0; i < ids.length; i++) panels[ids[i]].style.display = 'none';
      return;
    }

    panels[id].style.display = 'none';
  }

  // Dismissal is an outside-click / Escape close — distinct from a programmatic
  // close() or an onSelect pick, in that it notifies the tool via onClose.
  function dismiss(id) {
    close(id);
    if (spec[id].onClose) spec[id].onClose(id);
  }

  function toggle(id, anchorEl) {
    if (isOpen(id)) close(id);
    else open(id, anchorEl);
  }

  function refresh(id) {
    if (isOpen(id)) render(id);
  }

  // Capture phase + halting propagation keeps an outside click that dismisses a
  // panel from also reaching the canvas/world beneath the toolbar.
  document.addEventListener('mousedown', function (e) {
    let dismissed = false;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (!isOpen(id)) continue;
      if (panels[id].contains(e.target) || (anchors[id] && anchors[id].contains(e.target))) continue;
      dismiss(id);
      dismissed = true;
    }

    if (dismissed) e.stopImmediatePropagation();
  }, true);

  // Escape dismisses the open panel and consumes the event, so a tool's own
  // Escape shortcut only fires when nothing is open.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;

    let dismissed = false;
    for (let i = 0; i < ids.length; i++) if (isOpen(ids[i])) { dismiss(ids[i]); dismissed = true; }

    if (dismissed) e.stopImmediatePropagation();
  });

  return { toggle: toggle, open: open, close: close, refresh: refresh, isOpen: isOpen };
}
