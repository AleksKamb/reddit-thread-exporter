/**
 * Export runner.
 *
 * Works through the queue one thread at a time: resolves share links, downloads the
 * thread JSON, optionally loads hidden replies, and keeps a polite pace. It handles
 * rate limits (HTTP 429) and temporary server errors by waiting and retrying.
 *
 * The runner does not know how requests are made. The app passes in a `request`
 * function that runs `fetch` inside a reddit.com tab (see `reddit-tab.js`); the tests
 * pass in a fake one. Progress is reported with DOM events, so any UI can listen.
 *
 * @module export-runner
 */

import { moreChildrenPath, parseThreadLink, threadJsonPath } from './reddit-links.js';
import { findMoreStubs, getPostData } from './thread-model.js';

/** @typedef {import('./reddit-links.js').ThreadRef} ThreadRef */

/**
 * What a request into the Reddit tab returns.
 *
 * @typedef {object} PageResponse
 * @property {number} status              HTTP status, or 0 when the request never got an answer.
 * @property {string} [url]               Final URL after redirects.
 * @property {unknown} [json]             Parsed body, when Reddit answered with JSON.
 * @property {boolean} [isJson]
 * @property {string | null} [retryAfter] `Retry-After` header, in seconds.
 * @property {string | null} [rateLimitRemaining] `x-ratelimit-remaining` header.
 * @property {string | null} [rateLimitReset]     `x-ratelimit-reset` header, in seconds.
 * @property {string} [error]             Network error message, when `status` is 0.
 */

/**
 * @typedef {object} RunnerSettings
 * @property {number} delaySeconds      Minimum pause between two requests.
 * @property {string} sort              Comment sort order passed to Reddit.
 * @property {boolean} expandMore       Also load replies hidden behind "load more replies".
 * @property {number} [maxMoreRequests] Cap on extra requests per thread when `expandMore` is on.
 */

/**
 * @typedef {object} QueueJob
 * @property {string} key   Queue key of the item.
 * @property {ThreadRef} ref
 */

/**
 * @typedef {object} ThreadResult
 * @property {ThreadRef} ref           The resolved thread (share links become normal thread refs).
 * @property {unknown} listing          Reddit's thread response.
 * @property {unknown[]} extraThings    Comments loaded from "load more replies" stubs.
 */

/** @typedef {'idle' | 'running' | 'paused' | 'stopping' | 'finished'} RunnerState */

/** An error with a message that can be shown to the user as-is. */
export class ExportError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, retryable?: boolean }} [details]
   */
  constructor(message, { status = 0, retryable = false } = {}) {
    super(message);
    this.name = 'ExportError';
    this.status = status;
    this.retryable = retryable;
  }
}

const MAX_ATTEMPTS = 4;
const DEFAULT_RATE_LIMIT_WAIT_S = 60;
const MAX_WAIT_S = 600;
const MORE_CHILDREN_BATCH = 100;
/** Floor for the pause between requests, even if stored settings say otherwise. */
export const MIN_DELAY_S = 1;

export class ExportRunner extends EventTarget {
  /** @type {RunnerState} */
  #state = 'idle';
  #abort = new AbortController();
  /** @type {(() => void) | null} */
  #resumeWaiter = null;
  #lastRequestAt = -Infinity;
  /** Seconds to wait before the next request, from Reddit's rate-limit headers. */
  #rateLimitWaitS = 0;

  /**
   * @param {object} deps
   * @param {(path: string) => Promise<PageResponse>} deps.request  Makes one same-origin request on reddit.com.
   * @param {RunnerSettings} deps.settings
   * @param {(ms: number, signal: AbortSignal) => Promise<void>} [deps.sleep]
   * @param {() => number} [deps.now]  Clock in milliseconds; injectable for tests.
   */
  constructor({ request, settings, sleep = abortableSleep, now = () => Date.now() }) {
    super();
    this.request = request;
    this.settings = {
      maxMoreRequests: 10,
      ...settings,
      delaySeconds: Math.max(MIN_DELAY_S, Number(settings.delaySeconds) || MIN_DELAY_S),
    };
    this.sleep = sleep;
    this.now = now;
  }

  /** @returns {RunnerState} */
  get state() {
    return this.#state;
  }

  /**
   * Exports each job in order. Resolves when the queue is finished or stopped.
   * Results are delivered through `item-done` and `item-failed` events as they happen.
   *
   * @param {QueueJob[]} jobs
   * @returns {Promise<{ done: number, failed: number, stopped: boolean }>}
   */
  async run(jobs) {
    if (this.#state === 'running' || this.#state === 'paused') {
      throw new Error('This export is already running.');
    }
    this.#setState('running');
    const summary = { done: 0, failed: 0, stopped: false };

    for (const [index, job] of jobs.entries()) {
      await this.#waitWhilePaused();
      if (this.#abort.signal.aborted) break;

      this.#emit('item-start', { job, index, total: jobs.length });
      try {
        const result = await this.#exportThread(job);
        summary.done += 1;
        this.#emit('item-done', { job, index, total: jobs.length, result });
      } catch (error) {
        if (this.#abort.signal.aborted) break;
        summary.failed += 1;
        const message = error instanceof ExportError ? error.message : `Unexpected error: ${error?.message ?? error}`;
        this.#emit('item-failed', { job, index, total: jobs.length, error: message });
      }
    }

    summary.stopped = this.#abort.signal.aborted;
    this.#setState('finished');
    this.#emit('finished', summary);
    return summary;
  }

  /** Finishes the current thread, then waits until {@link resume} is called. */
  pause() {
    if (this.#state === 'running') this.#setState('paused');
  }

  resume() {
    if (this.#state !== 'paused') return;
    this.#setState('running');
    this.#resumeWaiter?.();
    this.#resumeWaiter = null;
  }

  /** Stops after the current request. Threads already exported are kept. */
  stop() {
    if (this.#state !== 'running' && this.#state !== 'paused') return;
    this.#setState('stopping');
    this.#abort.abort();
    this.#resumeWaiter?.();
    this.#resumeWaiter = null;
  }

  /* ---------------------------------------------------------------------- */

  /**
   * @param {QueueJob} job
   * @returns {Promise<ThreadResult>}
   */
  async #exportThread(job) {
    let ref = job.ref;
    if (ref.kind === 'share') {
      ref = await this.#resolveShareLink(ref);
      this.#log('info', `Share link opened as thread ${ref.id}.`);
    }

    const response = await this.#requestWithRetry(threadJsonPath(ref.id, { sort: this.settings.sort }));
    const listing = expectThreadJson(response);
    const extraThings = this.settings.expandMore ? await this.#loadHiddenReplies(ref.id, listing) : [];
    return { ref, listing, extraThings };
  }

  /**
   * Share links redirect to the real thread URL, so following the redirect is enough.
   *
   * @param {ThreadRef} ref
   * @returns {Promise<ThreadRef>}
   */
  async #resolveShareLink(ref) {
    const response = await this.#requestWithRetry(new URL(ref.url).pathname);
    const resolved = response.url ? parseThreadLink(response.url) : null;
    if (!resolved || resolved.kind !== 'thread') {
      throw new ExportError('This share link did not lead to a thread. Open it on Reddit and copy the address bar link instead.', {
        status: response.status,
      });
    }
    return resolved;
  }

  /**
   * Requests the comments behind "load more replies" stubs, 100 at a time.
   *
   * @param {string} postId
   * @param {unknown} listing
   * @returns {Promise<unknown[]>}
   */
  async #loadHiddenReplies(postId, listing) {
    /** @type {unknown[]} */
    const extraThings = [];
    const requested = new Set();

    for (let round = 0; round < this.settings.maxMoreRequests; round += 1) {
      const ids = findMoreStubs(listing, extraThings).filter((id) => !requested.has(id)).slice(0, MORE_CHILDREN_BATCH);
      if (!ids.length || this.#abort.signal.aborted) break;
      ids.forEach((id) => requested.add(id));

      const response = await this.#requestWithRetry(moreChildrenPath(postId, ids, this.settings.sort));
      const things = /** @type {any} */ (response.json)?.json?.data?.things;
      if (response.status !== 200 || !Array.isArray(things)) {
        this.#log('warn', 'Reddit did not return the hidden replies. Keeping the comments loaded so far.');
        break;
      }
      extraThings.push(...things);
      this.#log('info', `Loaded ${things.length} hidden replies.`);
    }
    return extraThings;
  }

  /**
   * Makes a request, waiting out rate limits and retrying temporary failures.
   *
   * @param {string} path
   * @returns {Promise<PageResponse>}
   */
  async #requestWithRetry(path) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await this.#paceNextRequest();
      if (this.#abort.signal.aborted) throw new ExportError('Stopped.');

      const response = await this.request(path);
      this.#lastRequestAt = this.now();
      this.#readRateLimit(response);

      if (response.status === 429) {
        const seconds = clampSeconds(Number(response.retryAfter) || Number(response.rateLimitReset) || DEFAULT_RATE_LIMIT_WAIT_S * attempt);
        if (attempt === MAX_ATTEMPTS) break;
        this.#log('warn', `Reddit asked us to slow down. Waiting ${seconds} s before trying again.`);
        await this.#wait(seconds, 'rate-limit');
        continue;
      }

      const temporary = response.status === 0 || response.status >= 500;
      if (temporary && attempt < MAX_ATTEMPTS) {
        const seconds = 5 * attempt;
        this.#log('warn', `${describeStatus(response)}. Trying again in ${seconds} s.`);
        await this.#wait(seconds, 'retry');
        continue;
      }
      return response;
    }
    throw new ExportError('Reddit kept rate-limiting the requests. Choose a longer delay in Options and try again.', {
      status: 429,
      retryable: true,
    });
  }

  /** Waits for the configured delay and for any rate-limit reset Reddit announced. */
  async #paceNextRequest() {
    const sinceLast = (this.now() - this.#lastRequestAt) / 1000;
    const delay = Math.max(this.settings.delaySeconds - sinceLast, this.#rateLimitWaitS);
    this.#rateLimitWaitS = 0;
    if (delay > 0) await this.#wait(delay, 'delay');
  }

  /** @param {PageResponse} response */
  #readRateLimit(response) {
    const remaining = Number(response.rateLimitRemaining);
    const reset = Number(response.rateLimitReset);
    if (response.rateLimitRemaining != null && remaining < 1 && reset > 0) {
      this.#rateLimitWaitS = clampSeconds(reset);
      this.#log('info', `Reddit's request budget is used up. Waiting ${this.#rateLimitWaitS} s for it to refill.`);
    }
  }

  /**
   * @param {number} seconds
   * @param {'delay' | 'rate-limit' | 'retry'} reason
   */
  async #wait(seconds, reason) {
    const ms = Math.round(seconds * 1000);
    this.#emit('wait', { reason, seconds, until: this.now() + ms });
    await this.sleep(ms, this.#abort.signal);
  }

  async #waitWhilePaused() {
    if (this.#state !== 'paused') return;
    await new Promise((resolve) => {
      this.#resumeWaiter = resolve;
    });
  }

  /** @param {RunnerState} state */
  #setState(state) {
    this.#state = state;
    this.#emit('state', { state });
  }

  /**
   * @param {'info' | 'warn' | 'error'} level
   * @param {string} message
   */
  #log(level, message) {
    this.#emit('log', { level, message });
  }

  /**
   * @param {string} type
   * @param {unknown} detail
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

/**
 * Checks that a response is a thread, and turns every other answer into a clear message.
 *
 * @param {PageResponse} response
 * @returns {unknown} The thread listing.
 * @throws {ExportError}
 */
export function expectThreadJson(response) {
  const { status } = response;
  if (status === 200 && response.isJson) {
    try {
      getPostData(response.json);
      return response.json;
    } catch {
      throw new ExportError('Reddit answered, but not with a thread. Check that the link points to a post.', { status });
    }
  }
  if (status === 200 || (status === 403 && response.isJson === false)) {
    // Reddit answers with an HTML page when it wants a login or a "are you human" check.
    throw new ExportError(
      'Reddit sent a web page instead of data. Open reddit.com in this browser, log in or finish any check it shows, then try again.',
      { status, retryable: true },
    );
  }
  if (status === 403) {
    throw new ExportError(
      'Reddit refused access. The community may be private, quarantined or banned. If the thread opens for you, log in to reddit.com and retry.',
      { status },
    );
  }
  if (status === 404) throw new ExportError('Thread not found. It may have been deleted, or the link is wrong.', { status });
  throw new ExportError(`${describeStatus(response)}.`, { status, retryable: true });
}

/**
 * Resolves after `ms` milliseconds, or right away when `signal` aborts.
 *
 * @param {number} ms
 * @param {AbortSignal} signal
 * @returns {Promise<void>}
 */
export function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

/** @param {PageResponse} response */
function describeStatus(response) {
  if (response.status === 0) return `Network error${response.error ? ` (${response.error})` : ''}`;
  if (response.status >= 500) return `Reddit had a server error (HTTP ${response.status})`;
  return `Reddit answered with HTTP ${response.status}`;
}

/** @param {number} seconds */
function clampSeconds(seconds) {
  return Math.min(MAX_WAIT_S, Math.max(1, Math.ceil(seconds)));
}
