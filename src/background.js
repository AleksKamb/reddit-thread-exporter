/**
 * Background service worker.
 *
 * - Opens the exporter with a welcome message right after install.
 * - Adds "Add to Thread Exporter" to the right-click menu on Reddit links and thread pages.
 * - Shows the number of threads waiting in the queue on the toolbar badge.
 *
 * The toolbar button itself opens the popup (src/popup), not this worker.
 */

import { openApp } from './lib/app-tab.js';
import { parseThreadLink } from './lib/reddit-links.js';
import { addToQueue, getQueue, onQueueChanged } from './lib/store.js';

const MENU_LINK = 'add-link';
const MENU_PAGE = 'add-page';

/** URL patterns of Reddit threads and share links, for the right-click menu. */
const THREAD_URL_PATTERNS = [
  '*://*.reddit.com/r/*/comments/*',
  '*://*.reddit.com/comments/*',
  '*://*.reddit.com/r/*/s/*',
  '*://redd.it/*',
];

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: MENU_LINK,
    title: 'Add thread to Thread Exporter',
    contexts: ['link'],
    targetUrlPatterns: THREAD_URL_PATTERNS,
  });
  chrome.contextMenus.create({
    id: MENU_PAGE,
    title: 'Add this thread to Thread Exporter',
    contexts: ['page'],
    documentUrlPatterns: THREAD_URL_PATTERNS,
  });
  await updateBadge(await getQueue());

  if (reason === chrome.runtime.OnInstalledReason.INSTALL) await openApp({ welcome: true });
});

chrome.runtime.onStartup.addListener(async () => updateBadge(await getQueue()));

chrome.contextMenus.onClicked.addListener(async (info) => {
  const url = info.menuItemId === MENU_LINK ? info.linkUrl : info.pageUrl;
  const ref = url ? parseThreadLink(url) : null;
  if (!ref) return;

  const { added } = await addToQueue([ref]);
  await flashBadge(added ? '+1' : '✓');
});

onQueueChanged(updateBadge);

/**
 * Shows how many threads still need exporting.
 *
 * @param {import('./lib/store.js').QueueItem[]} queue
 */
async function updateBadge(queue) {
  const pending = queue.filter((item) => item.status !== 'done').length;
  await chrome.action.setBadgeBackgroundColor({ color: '#C2410C' });
  await chrome.action.setBadgeText({ text: pending ? String(Math.min(pending, 999)) : '' });
}

/**
 * Briefly shows a confirmation on the badge, then goes back to the count.
 *
 * @param {string} text
 */
async function flashBadge(text) {
  await chrome.action.setBadgeBackgroundColor({ color: '#15803D' });
  await chrome.action.setBadgeText({ text });
  setTimeout(async () => updateBadge(await getQueue()), 1500);
}
