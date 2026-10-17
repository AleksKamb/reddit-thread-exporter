/**
 * Background service worker.
 *
 * - Opens the exporter (or focuses it) when the toolbar button is clicked.
 * - Adds "Add to Thread Exporter" to the right-click menu on Reddit links and thread pages.
 * - Shows the number of threads waiting in the queue on the toolbar badge.
 */

import { parseThreadLink } from './lib/reddit-links.js';
import { addToQueue, getQueue, onQueueChanged } from './lib/store.js';

const APP_PATH = 'src/app/index.html';
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

chrome.action.onClicked.addListener(() => openApp());

chrome.contextMenus.onClicked.addListener(async (info) => {
  const url = info.menuItemId === MENU_LINK ? info.linkUrl : info.pageUrl;
  const ref = url ? parseThreadLink(url) : null;
  if (!ref) return;

  const { added } = await addToQueue([ref]);
  await flashBadge(added ? '+1' : '✓');
});

onQueueChanged(updateBadge);

/**
 * Focuses the exporter tab if it is open, otherwise opens it.
 *
 * @param {{ welcome?: boolean }} [options]
 */
async function openApp({ welcome = false } = {}) {
  const appUrl = chrome.runtime.getURL(APP_PATH);
  const [context] = await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [appUrl] });

  if (context && context.tabId >= 0) {
    await chrome.tabs.update(context.tabId, { active: true });
    if (context.windowId >= 0) await chrome.windows.update(context.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: welcome ? `${appUrl}?welcome=1` : appUrl });
}

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
