/**
 * @module tools/modal
 * Thin wrapper around the browser's native <dialog>.
 *
 * Tooling layer only.
 */

/**
 * Opens `html` in a modal <dialog>; a ✕ close button is prepended automatically.
 * Each call builds a fresh dialog that is discarded once closed.
 * @returns {HTMLDialogElement} the dialog, so callers can query their own
 *   controls (e.g. `dialog.querySelector('button.confirm')`).
 */
export function showModal(html) {
  const dialog = document.createElement('dialog');
  dialog.className = 'tools-modal';
  dialog.innerHTML =
    '<form method="dialog"><button class="tools-modal-close" value="close">×</button></form>' + html;

  // Consume the closing Escape so a tool's own window-level Escape shortcut
  // (e.g. design's drawing-cancel) doesn't also fire beneath the modal; the
  // dialog still closes natively. Mirrors picker.js.
  dialog.addEventListener('keydown', function (e) { if (e.key === 'Escape') e.stopPropagation(); });
  dialog.addEventListener('close', function () { dialog.remove(); });

  document.body.appendChild(dialog);
  dialog.showModal();
  return dialog;
}

/**
 * Confirmation modal: title + body + a Cancel / confirm button pair, both
 * closing the dialog natively. `onConfirm` runs after it closes, and only when
 * the confirm button was chosen — Escape, ✕, and Cancel all dismiss silently.
 * @param opts { title, body, confirm, cancel?, onConfirm }
 */
export function confirmModal(opts) {
  const dialog = showModal(
    '<h2>' + opts.title + '</h2>' +
    '<p>' + opts.body + '</p>' +
    '<form method="dialog" class="tools-actions">' +
    '<button class="tools-btn">' + (opts.cancel || 'CANCEL') + '</button>' +
    '<button class="tools-btn" value="confirm">' + opts.confirm + '</button>' +
    '</form>'
  );

  dialog.addEventListener('close', function () {
    if (dialog.returnValue === 'confirm') opts.onConfirm();
  });
}
