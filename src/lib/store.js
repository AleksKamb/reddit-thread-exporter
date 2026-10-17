/**
 * Persistent state in `chrome.storage.local`.
 *
 * - `queue`     The list of threads and their export status.
 * - `settings`  Export options, remembered between sessions.
 * - `thread:<id>` Downloaded data for one thread, so finished work survives a closed tab.
 * - `runStatus` (in `chrome.storage.session`) Progress of the export that is running,
 *   so the toolbar popup can show it. Cleared when the browser restarts.
 *
 * Shared by the app page, the toolbar popup and the background service worker
 * (which adds threads from the right-click menu).
 *
 * @module store
 */

import { refKey, slugToTitle } from './reddit-links.js';

/** @typedef {import('./reddit-links.js').ThreadRef} ThreadRef */

/**
 * @typedef {'queued' | 'running' | 'done' | 'failed'} ItemStatus
 */

/**
 * One row of the queue.
 *
 * @typedef {object} QueueItem
 * @property {string} key         De-duplication key (see `refKey`).
 * @property {ThreadRef} ref
 * @property {string} title       Placeholder from the URL slug until the thread is fetched.
 * @property {string | null} subreddit
 * @property {ItemStatus} status
 * @property {string | null} error
 * @property {{ exported: number, reported: number } | null} comments
 * @property {number} addedAt     Unix time in milliseconds.
 * @property {number | null} fetchedAt
 */

/**
 * @typedef {object} Settings
 * @property {Record<'markdown' | 'csv' | 'json' | 'raw', boolean>} formats
 * @property {'confidence' | 'top' | 'new' | 'controversial' | 'old' | 'qa'} sort
 * @property {number} delaySeconds
 * @property {boolean} expandMore
 * @property {boolean} includeUsernames
 * @property {boolean} autoDownload
 * @property {string} fileName
 * @property {'system' | 'light' | 'dark'} theme
 * @property {boolean} welcomeDismissed
 */

/** @type {Settings} */
export const DEFAULT_SETTINGS = Object.freeze({
  formats: { markdown: true, csv: false, json: true, raw: false },
  sort: 'confidence',
  delaySeconds: 3,
  expandMore: false,
  includeUsernames: false,
  autoDownload: true,
  fileName: '',
  theme: 'system',
  welcomeDismissed: false,
});

const QUEUE_KEY = 'queue';
const SETTINGS_KEY = 'settings';
const THREAD_PREFIX = 'thread:';

/** @returns {Promise<QueueItem[]>} */
export async function getQueue() {
  const { [QUEUE_KEY]: queue = [] } = await chrome.storage.local.get(QUEUE_KEY);
  return queue;
}

/** @param {QueueItem[]} queue */
export async function saveQueue(queue) {
  await chrome.storage.local.set({ [QUEUE_KEY]: queue });
}

/**
 * Queue writes are chained so that two quick updates (say, "running" and then
 * "done") can never read the same old queue and overwrite each other.
 * @type {Promise<unknown>}
 */
let queueWrites = Promise.resolve();

/**
 * Runs `change` on the latest queue and saves the result, one change at a time.
 *
 * @template T
 * @param {(queue: QueueItem[]) => T} change  Mutates the queue in place; its return value is passed through.
 * @returns {Promise<T>}
 */
function changeQueue(change) {
  const next = queueWrites.then(async () => {
    const queue = await getQueue();
    const result = change(queue);
    await saveQueue(queue);
    return result;
  });
  queueWrites = next.catch(() => {});
  return next;
}

/**
 * Adds threads to the end of the queue, skipping ones already there.
 *
 * @param {ThreadRef[]} refs
 * @returns {Promise<{ added: number, duplicates: number }>}
 */
export function addToQueue(refs) {
  return changeQueue((queue) => {
    const known = new Set(queue.map((item) => item.key));
    let added = 0;
    for (const ref of refs) {
      const key = refKey(ref);
      if (known.has(key)) continue;
      known.add(key);
      queue.push(createQueueItem(ref));
      added += 1;
    }
    return { added, duplicates: refs.length - added };
  });
}

/**
 * Applies a change to one queue item.
 *
 * @param {string} key
 * @param {Partial<QueueItem>} patch
 */
export function updateQueueItem(key, patch) {
  return changeQueue((queue) => {
    const item = queue.find((entry) => entry.key === key);
    if (item) Object.assign(item, patch);
  });
}

/**
 * Removes items from the queue together with their downloaded data.
 *
 * @param {(item: QueueItem) => boolean} predicate
 */
export async function removeFromQueue(predicate) {
  const removed = await changeQueue((queue) => {
    const gone = queue.filter(predicate);
    const kept = queue.filter((item) => !predicate(item));
    queue.splice(0, queue.length, ...kept);
    return gone;
  });
  if (removed.length) await chrome.storage.local.remove(removed.map((item) => THREAD_PREFIX + item.key));
}

/**
 * After a crash or a closed tab, items stuck in `running` go back to `queued`.
 */
export function resetInterruptedItems() {
  return changeQueue((queue) => {
    for (const item of queue) {
      if (item.status === 'running') item.status = 'queued';
    }
  });
}

/**
 * @param {string} key
 * @param {{ listing: unknown, extraThings: unknown[] }} data
 */
export async function saveThreadData(key, data) {
  await chrome.storage.local.set({ [THREAD_PREFIX + key]: data });
}

/**
 * @param {string[]} keys
 * @returns {Promise<Map<string, { listing: unknown, extraThings: unknown[] }>>}
 */
export async function getThreadData(keys) {
  const stored = await chrome.storage.local.get(keys.map((key) => THREAD_PREFIX + key));
  return new Map(keys.filter((key) => stored[THREAD_PREFIX + key]).map((key) => [key, stored[THREAD_PREFIX + key]]));
}

/** @returns {Promise<Settings>} */
export async function getSettings() {
  const { [SETTINGS_KEY]: saved = {} } = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...saved, formats: { ...DEFAULT_SETTINGS.formats, ...saved.formats } };
}

/**
 * @param {Partial<Settings>} patch
 * @returns {Promise<Settings>}
 */
export async function saveSettings(patch) {
  const settings = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  return settings;
}

/**
 * Calls `listener` whenever the queue changes, from any page or the background worker.
 *
 * @param {(queue: QueueItem[]) => void} listener
 */
export function onQueueChanged(listener) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[QUEUE_KEY]) listener(changes[QUEUE_KEY].newValue ?? []);
  });
}

/**
 * @param {ThreadRef} ref
 * @returns {QueueItem}
 */
export function createQueueItem(ref) {
  return {
    key: refKey(ref),
    ref,
    title: slugToTitle(ref.slug),
    subreddit: ref.subreddit,
    status: 'queued',
    error: null,
    comments: null,
    addedAt: Date.now(),
    fetchedAt: null,
  };
}

/**
 * @typedef {object} RunStatus
 * @property {'idle' | 'running' | 'paused' | 'stopping'} state
 * @property {number} finished
 * @property {number} total
 * @property {string} current   Title of the thread being exported.
 */

const RUN_STATUS_KEY = 'runStatus';

/** @type {RunStatus} */
export const IDLE_RUN_STATUS = Object.freeze({ state: 'idle', finished: 0, total: 0, current: '' });

/** @param {RunStatus} status */
export async function setRunStatus(status) {
  await chrome.storage.session.set({ [RUN_STATUS_KEY]: status });
}

/** @returns {Promise<RunStatus>} */
export async function getRunStatus() {
  const { [RUN_STATUS_KEY]: status } = await chrome.storage.session.get(RUN_STATUS_KEY);
  return status ?? IDLE_RUN_STATUS;
}

/** @param {(status: RunStatus) => void} listener */
export function onRunStatusChanged(listener) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes[RUN_STATUS_KEY]) listener(changes[RUN_STATUS_KEY].newValue ?? IDLE_RUN_STATUS);
  });
}

/** @param {(settings: Settings) => void} listener */
export function onSettingsChanged(listener) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[SETTINGS_KEY]) {
      const saved = changes[SETTINGS_KEY].newValue ?? {};
      listener({ ...DEFAULT_SETTINGS, ...saved, formats: { ...DEFAULT_SETTINGS.formats, ...saved.formats } });
    }
  });
}
