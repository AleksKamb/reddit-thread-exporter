/**
 * Small UI helpers shared by the exporter page and the toolbar popup.
 * Both pages live one folder below `src/`, so the sprite path is the same for both.
 *
 * @module ui
 */

const ICON_SPRITE = '../shared/icons.svg';
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The `href` for an icon in the shared sprite.
 *
 * @param {string} id  Symbol ID, e.g. `i-check`.
 */
export function iconHref(id) {
  return `${ICON_SPRITE}#${id}`;
}

/**
 * Creates an `<svg><use></svg>` icon element (decorative, hidden from screen readers).
 *
 * @param {string} id
 * @param {string} [className='icon']
 * @returns {SVGSVGElement}
 */
export function createIcon(id, className = 'icon') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', iconHref(id));
  svg.append(use);
  return svg;
}

/**
 * Points an existing `<svg><use>` at another icon.
 *
 * @param {Element | null} container  An element that contains the `<use>`.
 * @param {string} id
 */
export function setIcon(container, id) {
  container?.querySelector('use')?.setAttribute('href', iconHref(id));
}

/** Warm gradient pairs for subreddit avatars, all in the Reddit orange family. */
const AVATAR_GRADIENTS = [
  ['#ff8a50', '#ff4500'],
  ['#ffb067', '#f2541b'],
  ['#ff7a7a', '#e5400a'],
  ['#ffc46b', '#f07818'],
  ['#ff9a8b', '#d6336c'],
  ['#ffa94d', '#e8590c'],
];

/**
 * Picks a stable avatar gradient for a subreddit name.
 *
 * @param {string} name
 * @returns {[string, string]}
 */
export function avatarGradient(name = '') {
  let hash = 0;
  for (const char of name.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return /** @type {[string, string]} */ (AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length]);
}

/**
 * Fills an `.avatar` element with a subreddit initial, or an icon.
 *
 * @param {HTMLElement} avatar
 * @param {{ subreddit?: string | null, icon?: string }} content
 */
export function fillAvatar(avatar, { subreddit, icon }) {
  const [from, to] = avatarGradient(subreddit ?? '');
  avatar.style.setProperty('--avatar-from', from);
  avatar.style.setProperty('--avatar-to', to);
  avatar.replaceChildren(icon ? createIcon(icon) : document.createTextNode((subreddit ?? '?').charAt(0)));
}

/**
 * Applies the theme preference to the page.
 *
 * @param {'system' | 'light' | 'dark'} theme
 */
export function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

/**
 * @param {number} count
 * @param {string} noun  Singular form.
 */
export function plural(count, noun) {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
}
