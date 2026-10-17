/**
 * What AI agents can ask the extension to do, through the local MCP bridge.
 *
 * Every limit is enforced here, inside the extension, so an agent can't get around it:
 * agents must be allowed, only one export runs at a time (manual or agent), the daily
 * limit and per-request limit apply, and the user can require an approval for each export.
 * Exports use the same runner, pacing and batch breaks as the Export button.
 *
 * Runs in the background service worker. See docs/AGENTS.md for the protocol.
 *
 * @module agent-jobs
 */

import { ExportRunner } from './export-runner.js';
import { extractThreadLinks } from './reddit-links.js';
import { parseSearchResults, searchPath, validateSearchOptions } from './reddit-search.js';
import { RedditTab } from './reddit-tab.js';
import {
  addAgentLogEntry,
  addAgentUsage,
  addToQueue,
  getAgentUsage,
  getBusySource,
  getQueue,
  getSettings,
  getThreadData,
  IDLE_RUN_STATUS,
  setRunStatus,
} from './store.js';

/** @typedef {import('./store.js').Settings} Settings */
/** @typedef {import('./reddit-links.js').ThreadRef} ThreadRef */

/**
 * @typedef {object} RequestContext
 * @property {string} client  The agent's name, shown to the user.
 * @property {(message: string, done: number, total: number) => void} onProgress
 */

/** An error whose code and message are sent back to the agent as-is. */
export class AgentError extends Error {
  /**
   * @param {string} code     One of the codes in docs/AGENTS.md.
   * @param {string} message  Plain English, telling the agent what to do next.
   */
  constructor(code, message) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
  }
}

const MAX_LINKS = 200;
const MAX_LINK_LENGTH = 2000;
const APPROVAL_TIMEOUT_MS = 120_000;
const APPROVAL_MESSAGE = 'thread-exporter/approval';
const APPROVALS_KEY = 'agentApprovals';
const SORTS = new Set(['confidence', 'top', 'new', 'controversial', 'old', 'qa']);

/** Whether an agent job is running. Agent requests never overlap. */
let agentJobRunning = false;

/**
 * Runs one request from an agent.
 *
 * @param {string} method
 * @param {any} params
 * @param {RequestContext} context
 * @returns {Promise<unknown>}
 * @throws {AgentError}
 */
export async function handleAgentRequest(method, params, context) {
  const settings = await getSettings();
  if (!settings.agents.enabled) {
    throw new AgentError('AGENTS_DISABLED', 'Agent access is switched off in Thread Exporter. Ask the user to turn on "Allow agents".');
  }

  switch (method) {
    case 'status':
      return getStatus(settings);
    case 'export_threads':
      return exportThreads(params ?? {}, context, settings);
    case 'find_threads':
      return findThreads(params ?? {}, context, settings);
    case 'get_exported_threads':
      return getExportedThreads(context);
    case 'add_to_queue':
      return addLinksToQueue(params ?? {}, context);
    case 'get_queue':
      return listQueue();
    default:
      throw new AgentError('UNKNOWN_METHOD', `Unknown method "${method}".`);
  }
}

/* ---- status -------------------------------------------------------------- */

/** @param {Settings} settings */
async function getStatus(settings) {
  const [usage, queue, busy] = await Promise.all([getAgentUsage(), getQueue(), getBusySource()]);
  const counts = { waiting: 0, done: 0, failed: 0 };
  for (const item of queue) {
    if (item.status === 'done') counts.done += 1;
    else if (item.status === 'failed') counts.failed += 1;
    else counts.waiting += 1;
  }
  return {
    version: chrome.runtime.getManifest().version,
    busy,
    usage: describeUsage(usage, settings),
    limits: {
      maxPerRequest: settings.agents.maxPerRequest,
      delaySeconds: settings.delaySeconds,
      batchSize: settings.batchSize,
      batchPauseSeconds: settings.batchPauseSeconds,
      askBeforeExport: settings.agents.askBeforeExport,
    },
    queue: counts,
  };
}

/**
 * @param {import('./store.js').AgentUsage} usage
 * @param {Settings} settings
 */
function describeUsage(usage, settings) {
  const limit = settings.agents.dailyLimit;
  return { date: usage.date, used: usage.used, limit, remaining: Math.max(0, limit - usage.used) };
}

/* ---- export_threads ------------------------------------------------------ */

/**
 * @param {{ links?: unknown, sort?: unknown, loadHiddenReplies?: unknown }} params
 * @param {RequestContext} context
 * @param {Settings} settings
 */
async function exportThreads(params, context, settings) {
  const links = validateLinks(params.links);
  const { refs, duplicates, notThreads } = extractThreadLinks(links.join('\n'));
  if (!refs.length) {
    throw new AgentError(
      'NO_THREADS',
      notThreads.length ? `None of these are links to Reddit threads: ${notThreads.slice(0, 3).join(', ')}.` : 'No Reddit thread links were given.',
    );
  }

  const { maxPerRequest } = settings.agents;
  if (refs.length > maxPerRequest) {
    throw new AgentError('TOO_MANY_THREADS', `That's ${refs.length} threads, but the user allows ${maxPerRequest} per request. Split it into smaller requests.`);
  }
  await assertIdle();
  await assertDailyBudget(refs.length, settings);

  if (settings.agents.askBeforeExport) {
    await requestApproval({ client: context.client, count: refs.length, links: refs.map((ref) => ref.url) });
  }

  return runExclusive(context, refs.length, async (status) => {
    const tab = new RedditTab();
    const runner = new ExportRunner({
      request: (path) => tab.request(path),
      settings: {
        delaySeconds: settings.delaySeconds,
        sort: SORTS.has(/** @type {string} */ (params.sort)) ? /** @type {string} */ (params.sort) : settings.sort,
        expandMore: params.loadHiddenReplies === true,
        batchSize: settings.batchSize,
        batchPauseSeconds: settings.batchPauseSeconds,
      },
    });

    /** @type {Array<{ link: string, ok: boolean, data?: unknown, error?: string }>} */
    const threads = refs.map((ref) => ({ link: ref.url, ok: false, error: 'Not exported.' }));
    let finished = 0;
    // Saving usage and progress is async; collect it so the result waits for every save.
    /** @type {Promise<void>[]} */
    const saves = [];
    const settle = (/** @type {number} */ index, /** @type {object} */ outcome) => {
      threads[index] = { link: refs[index].url, ...outcome };
      finished += 1;
      context.onProgress(`Exported ${finished} of ${refs.length}`, finished, refs.length);
      const count = finished;
      saves.push(addAgentUsage(1).then(() => status({ finished: count, current: '' })));
    };

    runner.addEventListener('item-start', (event) => {
      const { index } = /** @type {CustomEvent} */ (event).detail;
      status({ finished, current: refs[index].url });
    });
    runner.addEventListener('item-done', (event) => {
      const { index, result } = /** @type {CustomEvent} */ (event).detail;
      settle(index, { ok: true, data: { listing: result.listing, extraThings: result.extraThings } });
    });
    runner.addEventListener('item-failed', (event) => {
      const { index, error } = /** @type {CustomEvent} */ (event).detail;
      settle(index, { ok: false, error });
    });
    runner.addEventListener('wait', (event) => {
      const { reason, seconds } = /** @type {CustomEvent} */ (event).detail;
      if (reason === 'batch') context.onProgress(`Batch break: continuing in ${seconds} s`, finished, refs.length);
      if (reason === 'rate-limit') context.onProgress(`Reddit asked for a break: continuing in ${seconds} s`, finished, refs.length);
    });

    try {
      await tab.connect();
      await runner.run(refs.map((ref, index) => ({ key: String(index), ref })));
    } finally {
      await tab.release();
      await Promise.allSettled(saves);
    }

    const exported = threads.filter((thread) => thread.ok).length;
    await addAgentLogEntry({
      client: context.client,
      action: 'export_threads',
      ok: exported > 0,
      summary: `Exported ${exported} of ${refs.length} thread${refs.length === 1 ? '' : 's'}`,
    });
    return { threads, notThreads, duplicates, usage: describeUsage(await getAgentUsage(), settings) };
  });
}

/* ---- find_threads -------------------------------------------------------- */

/**
 * @param {object} params
 * @param {RequestContext} context
 * @param {Settings} settings
 */
async function findThreads(params, context, settings) {
  let options;
  try {
    options = validateSearchOptions(params);
  } catch (error) {
    throw new AgentError('BAD_REQUEST', /** @type {Error} */ (error).message);
  }
  await assertIdle();
  await assertDailyBudget(1, settings);

  return runExclusive(context, 1, async (status) => {
    const tab = new RedditTab();
    let response;
    try {
      await status({ finished: 0, current: `Searching for "${options.query}"` });
      response = await tab.request(searchPath(options));
    } finally {
      await tab.release();
    }
    await addAgentUsage(1);

    if (response.status === 429) throw new AgentError('RATE_LIMITED', 'Reddit asked to slow down. Wait a minute before searching again.');
    if (!response.isJson) {
      throw new AgentError('BLOCKED', 'Reddit sent a web page instead of results. Ask the user to open reddit.com in Chrome and log in or finish any check.');
    }
    let results;
    try {
      results = parseSearchResults(response.json);
    } catch (error) {
      throw new AgentError('BAD_RESPONSE', /** @type {Error} */ (error).message);
    }

    const scope = options.subreddit ? ` in r/${options.subreddit}` : '';
    await addAgentLogEntry({ client: context.client, action: 'find_threads', ok: true, summary: `Searched "${options.query}"${scope}: ${results.length} results` });
    return { results, usage: describeUsage(await getAgentUsage(), settings) };
  });
}

/* ---- Queue tools (no requests to Reddit) --------------------------------- */

/** @param {RequestContext} context */
async function getExportedThreads(context) {
  const done = (await getQueue()).filter((item) => item.status === 'done');
  const data = await getThreadData(done.map((item) => item.key));
  const threads = done.filter((item) => data.has(item.key)).map((item) => ({ key: item.key, data: data.get(item.key) }));
  await addAgentLogEntry({ client: context.client, action: 'get_exported_threads', ok: true, summary: `Read ${threads.length} exported thread${threads.length === 1 ? '' : 's'}` });
  return { threads };
}

/**
 * @param {{ links?: unknown }} params
 * @param {RequestContext} context
 */
async function addLinksToQueue(params, context) {
  const { refs, duplicates, notThreads } = extractThreadLinks(validateLinks(params.links).join('\n'));
  const { added } = await addToQueue(refs);
  await addAgentLogEntry({ client: context.client, action: 'add_to_queue', ok: added > 0, summary: `Added ${added} thread${added === 1 ? '' : 's'} to the queue` });
  return { added, duplicates: duplicates + (refs.length - added), notThreads };
}

async function listQueue() {
  const queue = await getQueue();
  return {
    items: queue.map((item) => ({
      title: item.title,
      subreddit: item.subreddit,
      url: item.ref.url,
      status: item.status,
      comments: item.comments?.exported ?? null,
      error: item.error,
    })),
  };
}

/* ---- Guards -------------------------------------------------------------- */

/**
 * @param {unknown} links
 * @returns {string[]}
 */
function validateLinks(links) {
  if (!Array.isArray(links) || !links.length) throw new AgentError('BAD_REQUEST', 'Pass "links" as a list of Reddit thread URLs.');
  if (links.length > MAX_LINKS) throw new AgentError('BAD_REQUEST', `Pass at most ${MAX_LINKS} links at once.`);
  return links.map((link) => {
    if (typeof link !== 'string' || link.length > MAX_LINK_LENGTH) throw new AgentError('BAD_REQUEST', 'Every link must be a URL string.');
    return link;
  });
}

async function assertIdle() {
  const busy = agentJobRunning ? 'agent' : await getBusySource();
  if (busy === 'page') throw new AgentError('BUSY', 'The user is running an export in Thread Exporter. Wait a few minutes and try again.');
  if (busy === 'agent') throw new AgentError('BUSY', 'Another agent request is running. Wait for it to finish and try again.');
}

/**
 * @param {number} needed
 * @param {Settings} settings
 */
async function assertDailyBudget(needed, settings) {
  const { used, remaining, limit } = describeUsage(await getAgentUsage(), settings);
  if (needed > remaining) {
    throw new AgentError(
      'DAILY_LIMIT',
      remaining === 0
        ? `The daily agent limit is used up (${used} of ${limit}). Don't retry today; the user can raise it in Thread Exporter.`
        : `Only ${remaining} of today's ${limit} agent requests are left, and this needs ${needed}. Ask for fewer threads.`,
    );
  }
}

/**
 * Runs an agent job while publishing its progress, so the popup, the exporter page and
 * the toolbar badge show it, and so no other export starts at the same time.
 *
 * @template T
 * @param {RequestContext} context
 * @param {number} total
 * @param {(status: (patch: { finished: number, current: string }) => Promise<void>) => Promise<T>} job
 * @returns {Promise<T>}
 */
async function runExclusive(context, total, job) {
  // Claim the slot before the first await, so two requests arriving together can't both start.
  if (agentJobRunning) throw new AgentError('BUSY', 'Another agent request is running. Wait for it to finish and try again.');
  agentJobRunning = true;

  const publish = (/** @type {{ finished: number, current: string }} */ patch) =>
    setRunStatus({ state: 'running', total, client: context.client, ...patch }, 'agent');
  try {
    if ((await getBusySource()) === 'page') {
      throw new AgentError('BUSY', 'The user is running an export in Thread Exporter. Wait a few minutes and try again.');
    }
    await publish({ finished: 0, current: '' });
    return await job(publish);
  } finally {
    await setRunStatus(IDLE_RUN_STATUS, 'agent');
    agentJobRunning = false;
  }
}

/* ---- Approval window ----------------------------------------------------- */

/** @type {Map<string, (allowed: boolean) => void>} */
const pendingApprovals = new Map();

/**
 * Opens a small window asking the user to allow or deny an agent export.
 * Resolves when allowed; throws `DENIED` when denied, closed or left unanswered.
 *
 * @param {{ client: string, count: number, links: string[] }} request
 */
async function requestApproval(request) {
  const id = crypto.randomUUID();
  const expiresAt = Date.now() + APPROVAL_TIMEOUT_MS;
  const { [APPROVALS_KEY]: approvals = {} } = await chrome.storage.session.get(APPROVALS_KEY);
  await chrome.storage.session.set({ [APPROVALS_KEY]: { ...approvals, [id]: { ...request, expiresAt } } });

  const window = await chrome.windows.create({
    url: chrome.runtime.getURL(`src/approve/approve.html?id=${id}`),
    type: 'popup',
    width: 440,
    height: 560,
    focused: true,
  });

  const allowed = await new Promise((resolve) => {
    const timer = setTimeout(() => finish(false), APPROVAL_TIMEOUT_MS);
    const onRemoved = (/** @type {number} */ windowId) => {
      if (windowId === window.id) finish(false);
    };
    function finish(/** @type {boolean} */ decision) {
      clearTimeout(timer);
      chrome.windows.onRemoved.removeListener(onRemoved);
      pendingApprovals.delete(id);
      resolve(decision);
    }
    pendingApprovals.set(id, finish);
    chrome.windows.onRemoved.addListener(onRemoved);
  });

  const { [APPROVALS_KEY]: current = {} } = await chrome.storage.session.get(APPROVALS_KEY);
  delete current[id];
  await chrome.storage.session.set({ [APPROVALS_KEY]: current });
  if (window.id !== undefined) chrome.windows.remove(window.id).catch(() => {});

  if (!allowed) {
    await addAgentLogEntry({ client: request.client, action: 'export_threads', ok: false, summary: `Denied an export of ${request.count} thread${request.count === 1 ? '' : 's'}` });
    throw new AgentError('DENIED', 'The user declined this export. Don\'t retry unless they ask you to.');
  }
}

// Decisions come from the approval window (src/approve), which only this extension can open.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== chrome.runtime.id || message?.type !== APPROVAL_MESSAGE) return;
  pendingApprovals.get(message.id)?.(message.decision === 'allow');
});
