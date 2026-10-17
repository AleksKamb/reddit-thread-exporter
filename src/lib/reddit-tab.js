/**
 * The bridge to reddit.com.
 *
 * Requests are made from inside a reddit.com tab, exactly like the page's own
 * scripts make them. That way they carry the browser's normal reddit.com session,
 * and Reddit treats them like any other visit instead of blocking an unknown client.
 * If no Reddit tab is open, one is opened in the background and closed afterwards.
 *
 * @module reddit-tab
 */

/** @typedef {import('./export-runner.js').PageResponse} PageResponse */

const REDDIT_HOME = 'https://www.reddit.com/';
/** Tabs that can run requests: Reddit sites in host_permissions that serve the JSON API. */
const REDDIT_TAB_PATTERNS = ['https://www.reddit.com/*', 'https://old.reddit.com/*'];
const TAB_LOAD_TIMEOUT_MS = 30_000;
const BROWSER_CHECK_TIMEOUT_MS = 20_000;

export class RedditTab {
  /** @type {number | null} */
  #tabId = null;
  #openedByUs = false;

  /** `true` when the exporter opened the tab itself (and should close it when done). */
  get openedByUs() {
    return this.#openedByUs;
  }

  /**
   * Finds an open reddit.com tab, or opens one in the background.
   *
   * @returns {Promise<{ tabId: number, opened: boolean }>}
   */
  async connect() {
    if (this.#tabId !== null && (await tabExists(this.#tabId))) {
      return { tabId: this.#tabId, opened: false };
    }

    const [existing] = await chrome.tabs.query({ url: REDDIT_TAB_PATTERNS, discarded: false });
    if (existing?.id !== undefined) {
      this.#tabId = existing.id;
      return { tabId: existing.id, opened: false };
    }

    const tab = await chrome.tabs.create({ url: REDDIT_HOME, active: false });
    if (tab.id === undefined) throw new Error('Chrome did not open a Reddit tab.');
    await waitForTabLoad(tab.id);
    await waitForBrowserCheck(tab.id);
    this.#tabId = tab.id;
    this.#openedByUs = true;
    return { tabId: tab.id, opened: true };
  }

  /**
   * Fetches a reddit.com path from inside the Reddit tab. If the tab was closed
   * in the meantime, a new one is opened and the request is tried once more.
   *
   * @param {string} path  Host-relative path, for example `/comments/abc123/.json`.
   * @returns {Promise<PageResponse>}
   */
  async request(path) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { tabId } = await this.connect();
      try {
        const [injection] = await chrome.scripting.executeScript({
          target: { tabId },
          func: fetchFromRedditPage,
          args: [path],
        });
        if (injection?.result) return injection.result;
        return { status: 0, error: 'The Reddit tab did not answer.' };
      } catch (error) {
        // The tab was closed, navigated away, or crashed. Reconnect once.
        this.#tabId = null;
        if (attempt === 1) return { status: 0, error: String(error?.message ?? error) };
      }
    }
    return { status: 0, error: 'The Reddit tab is not available.' };
  }

  /** Closes the tab if the exporter opened it. Tabs the user opened are left alone. */
  async release() {
    if (this.#openedByUs && this.#tabId !== null) {
      await chrome.tabs.remove(this.#tabId).catch(() => {});
    }
    this.#tabId = null;
    this.#openedByUs = false;
  }
}

/**
 * Runs inside the reddit.com page (injected with `chrome.scripting.executeScript`).
 * It must be self-contained: it cannot use anything from this module's scope.
 *
 * @param {string} path
 * @returns {Promise<PageResponse>}
 */
export async function fetchFromRedditPage(path) {
  try {
    const response = await fetch(path, { credentials: 'include', headers: { Accept: 'application/json' } });
    const isJson = (response.headers.get('content-type') ?? '').includes('json');
    return {
      status: response.status,
      url: response.url,
      isJson,
      json: isJson ? await response.json() : null,
      retryAfter: response.headers.get('retry-after'),
      rateLimitRemaining: response.headers.get('x-ratelimit-remaining'),
      rateLimitReset: response.headers.get('x-ratelimit-reset'),
    };
  } catch (error) {
    return { status: 0, error: String(error?.message ?? error) };
  }
}

/**
 * Reddit sometimes shows a short "checking your browser" page (`?js_challenge=1`)
 * before the real site. Requests made during the check are refused, so wait for
 * it to pass. If it doesn't, the first request reports a clear error.
 *
 * @param {number} tabId
 */
async function waitForBrowserCheck(tabId) {
  const deadline = Date.now() + BROWSER_CHECK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.url || !tab.url.includes('js_challenge')) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** @param {number} tabId */
async function tabExists(tabId) {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves when the tab finishes loading.
 *
 * @param {number} tabId
 * @returns {Promise<void>}
 */
function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Reddit took too long to load. Check your connection and try again.'));
    }, TAB_LOAD_TIMEOUT_MS);

    /** @param {number} id @param {chrome.tabs.TabChangeInfo} info */
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        cleanup();
        resolve();
      }
    };
    /** @param {number} id */
    const onRemoved = (id) => {
      if (id === tabId) {
        cleanup();
        reject(new Error('The Reddit tab was closed before it finished loading.'));
      }
    };
    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') {
        cleanup();
        resolve();
      }
    }, () => {});
  });
}
