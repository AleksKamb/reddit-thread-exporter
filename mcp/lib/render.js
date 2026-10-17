/**
 * Plain-text summaries and lists for tool results. Agents read these, so they are
 * short, consistent, and say what to do next where that isn't obvious.
 *
 * Titles, snippets and errors come from Reddit or the extension, so they are squeezed
 * onto one line: a line break inside a title must not look like a new list item.
 *
 * @module render
 */

/**
 * @typedef {object} Usage
 * @property {string} [date]
 * @property {number} used
 * @property {number} limit
 * @property {number} [remaining]
 */

/**
 * @typedef {object} ExportSummary
 * @property {string} heading         First line, e.g. "Exported 2 of 3 threads".
 * @property {number} comments
 * @property {string} formatLabel
 * @property {{ link: string, error: string }[]} [failures]
 * @property {string[]} [notThreads]
 * @property {number} [duplicates]
 * @property {Usage} [usage]
 */

/**
 * @param {ExportSummary} summary
 * @returns {string}
 */
export function renderExportSummary({ heading, comments, formatLabel, failures = [], notThreads = [], duplicates = 0, usage }) {
  const lines = [`${heading} (${plural(comments, 'comment')}) as ${formatLabel}.`];
  if (failures.length) {
    lines.push(`Failed (${failures.length}):`, ...failures.map(({ link, error }) => `- ${oneLine(link)}: ${oneLine(error)}`));
  }
  if (notThreads.length) {
    lines.push(`Skipped, not Reddit threads (${notThreads.length}): ${notThreads.map((link) => oneLine(link)).join(', ')}`);
  }
  if (duplicates > 0) lines.push(`Skipped duplicate links: ${duplicates}.`);
  const usageLine = renderUsage(usage);
  if (usageLine) lines.push(usageLine);
  return lines.join('\n');
}

/**
 * @param {Usage | undefined} usage
 * @returns {string}  Empty when the extension sent no usage.
 */
export function renderUsage(usage) {
  if (!usage || !Number.isFinite(usage.used) || !Number.isFinite(usage.limit)) return '';
  const remaining = Number.isFinite(usage.remaining) ? usage.remaining : Math.max(0, usage.limit - usage.used);
  return `Today's agent usage: ${usage.used}/${usage.limit} (${remaining} left).`;
}

/**
 * @typedef {object} SearchResult
 * @property {string} title
 * @property {string} subreddit
 * @property {string} url
 * @property {number} score
 * @property {number} comments
 * @property {string | number} createdAt
 * @property {string} [snippet]
 */

/**
 * @param {{ results?: SearchResult[], usage?: Usage }} result
 * @param {{ query: string, subreddit?: string, sort: string, time: string }} search
 * @returns {string}
 */
export function renderSearchResults({ results = [], usage }, { query, subreddit, sort, time }) {
  const scope = `"${oneLine(query)}"${subreddit ? ` in r/${subreddit.replace(/^\/?r\//i, '')}` : ''} (sort: ${sort}, time: ${time})`;
  const usageLine = renderUsage(usage);

  if (!results.length) {
    return [`No threads found for ${scope}.`, 'Try other words, a longer time range, or no subreddit.', usageLine].filter(Boolean).join('\n');
  }

  const items = results.map((item, index) => {
    const facts = [plural(item.score ?? 0, 'point'), plural(item.comments ?? 0, 'comment'), formatDay(item.createdAt)].filter(Boolean);
    const lines = [`${index + 1}. r/${oneLine(item.subreddit)} · ${oneLine(item.title)}`, `   ${item.url}`, `   ${facts.join(' · ')}`];
    const snippet = oneLine(item.snippet ?? '', 200);
    if (snippet) lines.push(`   ${snippet}`);
    return lines.join('\n');
  });

  const lines = [
    `Found ${plural(results.length, 'thread')} for ${scope}:`,
    '',
    items.join('\n\n'),
    '',
    'To get a thread with all its comments, pass its URL to export_threads (several URLs can go in one call).',
  ];
  if (usageLine) lines.push(usageLine);
  return lines.join('\n');
}

/**
 * @param {{ added?: number, duplicates?: number, notThreads?: string[] }} result
 * @returns {string}
 */
export function renderQueueAdd({ added = 0, duplicates = 0, notThreads = [] }) {
  const lines = [
    added > 0
      ? `Added ${plural(added, 'thread')} to the extension's queue. Nothing was fetched yet; the user can export the queue in the extension.`
      : "No threads were added to the extension's queue.",
  ];
  if (duplicates > 0) lines.push(`Already in the queue: ${duplicates}.`);
  if (notThreads.length) lines.push(`Skipped, not Reddit threads: ${notThreads.map((link) => oneLine(link)).join(', ')}`);
  return lines.join('\n');
}

/**
 * @typedef {object} QueueItem
 * @property {string} [title]
 * @property {string} [subreddit]
 * @property {string} url
 * @property {string} status
 * @property {number} [comments]
 * @property {string} [error]
 */

/**
 * @param {{ items?: QueueItem[] }} result
 * @returns {string}
 */
export function renderQueue({ items = [] }) {
  if (!items.length) return "The extension's queue is empty.";

  const counts = new Map();
  for (const item of items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  const breakdown = [...counts].map(([status, count]) => `${count} ${status}`).join(', ');

  const lines = items.map((item, index) => {
    const name = [item.subreddit ? `r/${oneLine(item.subreddit)}` : '', oneLine(item.title ?? '')].filter(Boolean).join(' · ') || item.url;
    const comments = Number.isFinite(item.comments) ? ` · ${plural(item.comments ?? 0, 'comment')}` : '';
    const entry = [`${index + 1}. [${item.status}] ${name}${comments}`, `   ${item.url}`];
    if (item.error) entry.push(`   Error: ${oneLine(item.error)}`);
    return entry.join('\n');
  });

  return [`Queue: ${plural(items.length, 'thread')} (${breakdown}).`, '', ...lines].join('\n');
}

/**
 * @typedef {object} ExtensionStatus
 * @property {string} [version]
 * @property {null | 'page' | 'agent'} [busy]
 * @property {Usage} [usage]
 * @property {{ maxPerRequest: number, delaySeconds: number, batchSize: number, batchPauseSeconds: number, askBeforeExport: boolean }} [limits]
 * @property {{ waiting: number, done: number, failed: number }} [queue]
 */

/**
 * @param {ExtensionStatus} status
 * @param {import('./bridge.js').BridgeState} bridge
 * @returns {string}
 */
export function renderStatus({ version, busy, usage, limits, queue }, bridge) {
  const lines = [`Thread Exporter for Reddit${version ? ` ${version}` : ''} is connected and accepts agent requests.`];
  lines.push(`Export running: ${busy === 'page' ? 'yes, the user is exporting in the extension' : busy === 'agent' ? 'yes, an agent export' : 'no'}.`);
  const usageLine = renderUsage(usage);
  if (usageLine) lines.push(usageLine);
  if (limits) {
    lines.push(
      `Limits set by the user: up to ${limits.maxPerRequest} threads per request; ${limits.delaySeconds} s between requests; ` +
        `batches of ${limits.batchSize} with ${limits.batchPauseSeconds} s pauses; ` +
        `approval before each agent export: ${limits.askBeforeExport ? 'on' : 'off'}.`,
    );
  }
  if (queue) lines.push(`Queue: ${queue.waiting} waiting, ${queue.done} done, ${queue.failed} failed.`);
  lines.push(renderBridge(bridge));
  return lines.join('\n');
}

/**
 * @param {import('./bridge.js').BridgeState} bridge
 * @returns {string}
 */
export function renderNotConnected(bridge) {
  return [
    'The Thread Exporter for Reddit extension is not connected, so threads cannot be exported right now.',
    'To connect it, ask the user to open Chrome with the extension enabled, click the Thread Exporter toolbar button and switch the "Agents off" pill to "Agents on" (or use Allow agents in the Agent access card of the exporter). ' +
      'The pill turns green when an agent is connected. Then call get_status again.',
    renderBridge(bridge),
  ].join('\n');
}

/**
 * @param {import('./bridge.js').BridgeState} bridge
 * @returns {string}
 */
function renderBridge({ role, port, agents }) {
  if (role === 'offline') {
    return (
      `Local bridge: not running, because port ${port} is used by another program. ` +
      'Set THREAD_EXPORTER_PORT to a free port, and the same port under Agent access → Advanced in the extension.'
    );
  }
  const sessions = agents > 1 ? ` ${agents} agent sessions share it.` : '';
  return `Local bridge: 127.0.0.1:${port}${role === 'client' ? ', run by another agent session' : ''}.${sessions}`;
}

/* ------------------------------------------------------------------------ */

/**
 * @param {unknown} value  ISO 8601 text or Unix time (seconds or milliseconds).
 * @returns {string}  `YYYY-MM-DD`, or empty when unknown.
 */
export function formatDay(value) {
  if (value == null || value === '') return '';
  const date = typeof value === 'number' ? new Date(value < 1e12 ? value * 1000 : value) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

/**
 * @param {number} count
 * @param {string} noun  Singular form.
 * @returns {string}
 */
export function plural(count, noun) {
  return `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Collapses whitespace and line breaks, and shortens long text.
 *
 * @param {unknown} text
 * @param {number} [max]
 * @returns {string}
 */
function oneLine(text, max = 300) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}
