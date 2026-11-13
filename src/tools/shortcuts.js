/**
 * @module tools/shortcuts
 * Keyboard shortcut registration — a single keydown listener that maps key
 * combos to named actions, with a typing-focus guard. Owns the listener and
 * dispatch; the handlers and their ids live in the caller (deps.actions).
 * Tooling layer only.
 */

function isTyping() {
  const a = document.activeElement;
  return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA');
}

// A shortcut is `{ combo }` or `{ key }`: `combo` is '+'-separated modifiers
// (mod = ctrl/meta, plus shift/alt) and one key, e.g. 'mod+shift+z'; `key` is a
// bare key with no modifiers, e.g. 'ArrowUp'. Key match is case-insensitive.
// An empty binding never matches, so a shortcut bound to a disabled
// `CONFIG.controls` entry registers harmlessly and stays dead.
function matches(sc, e) {
  const binding = sc.combo || sc.key;
  if (!binding) return false;

  const parts = binding.split('+');
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if ((mods.indexOf('mod') >= 0) !== (e.ctrlKey || e.metaKey)) return false;
  if ((mods.indexOf('shift') >= 0) !== e.shiftKey) return false;
  if ((mods.indexOf('alt') >= 0) !== e.altKey) return false;
  return e.key.toLowerCase() === key.toLowerCase();
}

/**
 * Binds `list` (Shortcut[]) to a single keydown listener. Shortcuts are skipped
 * while typing in an input/textarea unless `whenTyping` is set. The first match
 * wins, calls its `deps.actions[action]`, and prevents the default.
 */
export function registerShortcuts(list, deps) {
  const shortcuts = list.slice();
  const actions = deps.actions;

  function onKeyDown(e) {
    const typing = isTyping();
    for (let i = 0; i < shortcuts.length; i++) {
      const sc = shortcuts[i];
      if (typing && !sc.whenTyping) continue;
      if (!matches(sc, e)) continue;
      e.preventDefault();
      invoke(actions, sc.action);
      return;
    }
  }

  window.addEventListener('keydown', onKeyDown);
}

function invoke(actions, id) {
  const fn = actions[id];
  if (fn) fn();
  else console.warn(`shortcut references unknown action: ${id}`);
}
