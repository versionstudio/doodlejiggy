/**
 * @module random
 * Shared randomness primitives.
 *
 * The engine's single source of randomness: domain code calls these primitives
 * rather than `Math.random()`, so randomness call sites stay few and
 * discoverable. Domain-specific selection policy stays with its domain and
 * calls down into these primitives.
 */

export function randomFloat(min, max) {
  return min + Math.random() * (max - min);
}

/**
 * Uniform random index into `items` excluding `lastIdx`; single-item arrays
 * always return 0.
 */
export function pickNonRepeatingIdx(items, lastIdx) {
  if (items.length === 1) return 0;
  let idx;
  do { idx = Math.floor(Math.random() * items.length); } while (idx === lastIdx);
  return idx;
}
