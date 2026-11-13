/**
 * @module tools/persist
 * localStorage wrappers for tool preferences. Both swallow storage failures so
 * callers can read/write unconditionally. Tooling layer only.
 */

/**
 * Persists `state` under `key` in localStorage. Silently no-ops on storage
 * failure (quota, blocked, etc.).
 */
export function saveToolState(key, state) {
  try { localStorage.setItem(key, JSON.stringify(state)); } catch (e) {}
}

/**
 * Reads tool state from localStorage. Returns `{}` for missing keys, invalid
 * JSON, or any storage failure — callers can destructure unconditionally.
 */
export function loadToolState(key) {
  try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch (e) { return {}; }
}
