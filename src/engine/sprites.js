/**
 * @module sprites
 * The engine's cached sprite-asset subsystem: owns asset identity — where each
 * kind of image asset lives — and the decoded-Image cache.
 *
 * Callers name an asset by type + filename; directory layout is private, so no
 * other module constructs asset URLs. Reusing decoded Image instances prevents
 * transient incomplete-image states during scene reloads and scripted respawns.
 *
 * Cached Images expose a `.ready` Promise for callers that need to await load;
 * render-time consumers can keep their `img.complete` / `img.naturalWidth`
 * checks unchanged. Failures are cached too — a 404'd Image is reused on every
 * subsequent call, no retry storm.
 */

import CONFIG from './config.js';

const cache = new Map();

// The kinds of sprite asset the subsystem caches. Each is a category within the
// subsystem, not a separate concept: the type selects the directory. Names are
// authored as filenames throughout, so they carry their own extension.
export const ASSET_TYPES = Object.freeze({
  sprite:    'sprite',
  icon:      'icon',
  insert:    'insert',
  backdrop:  'backdrop',
  interface: 'interface',
});

const ASSET_DIRS = Object.freeze({
  [ASSET_TYPES.sprite]:    CONFIG.paths.sprites,
  [ASSET_TYPES.icon]:      CONFIG.paths.icons,
  [ASSET_TYPES.insert]:    CONFIG.paths.inserts,
  [ASSET_TYPES.backdrop]:  CONFIG.paths.backdrops,
  [ASSET_TYPES.interface]: CONFIG.paths.interface,
});

function assetUrl(type, name) {
  const dir = ASSET_DIRS[type];
  if (dir === undefined) {
    console.error(`[sprites] unknown asset type "${type}" for "${name}"`);
    return name;
  }
  return dir + name;
}

function cachedImage(url) {
  let img = cache.get(url);
  if (img) return img;

  img = new Image();
  img.ready = new Promise(function (resolve) {
    img.addEventListener('load', resolve, { once: true });
    img.addEventListener('error', function () {
      console.warn(`[sprites] failed to load: ${url}`);
      resolve();
    }, { once: true });
  });
  img.src = url;

  cache.set(url, img);
  return img;
}

/**
 * Returns the cached Image for a sprite asset, creating it on first request.
 * The same (type, name) always returns the same instance.
 *
 * @param {string} type One of ASSET_TYPES.
 * @returns {HTMLImageElement & { ready: Promise<void> }}
 */
export function getSprite(type, name) {
  return cachedImage(assetUrl(type, name));
}

/** @returns {Promise<void>} Resolves when the asset's Image has loaded or failed. */
export function preloadSprite(type, name) {
  return getSprite(type, name).ready;
}
