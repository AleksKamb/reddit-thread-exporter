/**
 * The exporter page: wires the UI to the queue, the export runner and downloads.
 *
 * Rendering is plain DOM: each `render*` function reads the current state and
 * updates its part of the page. Text from Reddit is only ever set with
 * `textContent`, never parsed as HTML.
 */

import { isAppCommand } from '../lib/app-tab.js';
import { ExportRunner } from '../lib/export-runner.js';
import { EXPORT_FORMATS, toCsv, toFileStem, toJson, toMarkdown, toRawJson } from '../lib/formatters.js';
import { cleanTabTitle, extractThreadLinks, parseThreadLink, slugToTitle } from '../lib/reddit-links.js';
import { RedditTab } from '../lib/reddit-tab.js';
import {
  addToQueue,
  getAgentConnection,
  getAgentLog,
  getAgentUsage,
  getQueue,
  getRunStatus,
  getSettings,
  getThreadData,
  IDLE_RUN_STATUS,
  localDate,
  onAgentStateChanged,
  onQueueChanged,
  onRunStatusChanged,
  onSettingsChanged,
  removeFromQueue,
  resetInterruptedItems,
  saveSettings,
  saveThreadData,
  setRunStatus,
  updateQueueItem,
} from '../lib/store.js';
import { normalizeThread } from '../lib/thread-model.js';
import { applyTheme, createIcon, fillAvatar, plural, setIcon } from '../shared/ui.js';

/** @typedef {import('../lib/store.js').QueueItem} QueueItem */
/** @typedef {import('../lib/store.js').Settings} Settings */

const TOOL_NAME = 'Thread Exporter for Reddit';
const TOOL_VERSION = chrome.runtime.getManifest().version;
const DOWNLOAD_FOLDER = 'Reddit Thread Exporter';
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_LOG_ENTRIES = 300;
const THEMES = /** @type {const} */ (['system', 'light', 'dark']);
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
/** Reddit sites the extension has access to (see host_permissions in manifest.json). */
const REDDIT_TAB_PATTERNS = ['https://www.reddit.com/*', 'https://old.reddit.com/*', 'https://new.reddit.com/*'];

/** Shorthand for `document.getElementById` that fails loudly on typos. */
const $ = (/** @type {string} */ id) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element;
};

const ui = {
  welcome: $('welcome'),
  pasteInput: /** @type {HTMLTextAreaElement} */ ($('paste-input')),
  fileInput: /** @type {HTMLInputElement} */ ($('file-input')),
  dropzone: $('dropzone'),
  openTabsList: $('open-tabs-list'),
  openTabsSummary: $('open-tabs-summary'),
  openTabsAdd: /** @type {HTMLButtonElement} */ ($('open-tabs-add')),
  addResult: $('add-result'),
  queueList: $('queue-list'),
  queueEmpty: $('queue-empty'),
  queueSummary: $('queue-summary'),
  clearDone: $('clear-done'),
  clearAll: $('clear-all'),
  formats: $('formats'),
  optionsSummary: $('options-summary'),
  optSort: /** @type {HTMLSelectElement} */ ($('opt-sort')),
  optDelay: /** @type {HTMLSelectElement} */ ($('opt-delay')),
  optExpand: /** @type {HTMLInputElement} */ ($('opt-expand')),
  optUsernames: /** @type {HTMLInputElement} */ ($('opt-usernames')),
  optAutoDownload: /** @type {HTMLInputElement} */ ($('opt-autodownload')),
  optFileName: /** @type {HTMLInputElement} */ ($('opt-filename')),
  optBatchSize: /** @type {HTMLSelectElement} */ ($('opt-batch-size')),
  optBatchPause: /** @type {HTMLSelectElement} */ ($('opt-batch-pause')),
  agentBadge: $('agent-badge'),
  agentEnabled: /** @type {HTMLInputElement} */ ($('agent-enabled')),
  agentConnectionText: $('agent-connection-text'),
  agentRun: $('agent-run'),
  agentRunTitle: $('agent-run-title'),
  agentRunProgress: $('agent-run-progress'),
  agentRunBar: $('agent-run-bar'),
  agentUsage: $('agent-usage'),
  agentUsageCount: $('agent-usage-count'),
  agentUsageProgress: $('agent-usage-progress'),
  agentUsageBar: $('agent-usage-bar'),
  agentSettings: $('agent-settings'),
  agentDailyLimit: /** @type {HTMLSelectElement} */ ($('agent-daily-limit')),
  agentMaxRequest: /** @type {HTMLSelectElement} */ ($('agent-max-request')),
  agentAsk: /** @type {HTMLInputElement} */ ($('agent-ask')),
  agentPort: /** @type {HTMLInputElement} */ ($('agent-port')),
  agentActivity: $('agent-activity'),
  runIdle: $('run-idle'),
  runActive: $('run-active'),
  runState: $('run-state'),
  runCount: $('run-count'),
  runPercent: $('run-percent'),
  progress: $('progress'),
  progressBar: $('progress-bar'),
  runCurrent: $('run-current'),
  runWait: $('run-wait'),
  runWaitText: $('run-wait-text'),
  start: /** @type {HTMLButtonElement} */ ($('start')),
  startLabel: $('start-label'),
  startHint: $('start-hint'),
  pause: $('pause'),
  pauseLabel: $('pause-label'),
  stop: $('stop'),
  result: $('result'),
  resultTitle: $('result-title'),
  resultDetail: $('result-detail'),
  download: /** @type {HTMLButtonElement} */ ($('download')),
  downloadLabel: $('download-label'),
  downloadHint: $('download-hint'),
  copyMarkdown: /** @type {HTMLButtonElement} */ ($('copy-markdown')),
  copyLabel: $('copy-label'),
  logList: $('log-list'),
  logCount: $('log-count'),
  themeToggle: $('theme-toggle'),
  helpDialog: /** @type {HTMLDialogElement} */ ($('help-dialog')),
  helpBody: $('help-body'),
  confirmDialog: /** @type {HTMLDialogElement} */ ($('confirm-dialog')),
  queueItemTemplate: /** @type {HTMLTemplateElement} */ ($('queue-item-template')),
};

/** Everything the page renders from. */
const state = {
  /** @type {QueueItem[]} */
  queue: [],
  /** @type {Settings} */
  settings: /** @type {Settings} */ ({}),
  /** @type {ExportRunner | null} */
  runner: null,
  /** Progress of the export that is running now. */
  run: { total: 0, finished: 0, currentTitle: '', waitUntil: 0, waitReason: '' },
  /** @type {{ done: number, failed: number, stopped: boolean, comments: number } | null} */
  lastResult: null,
  /** @type {number | undefined} */
  waitTimer: undefined,
  /** Last run status sent to the popup, to avoid redundant writes. */
  publishedStatus: '',
  /** Agent access, shown in its own card. */
  agent: {
    /** @type {import('../lib/store.js').AgentConnection} */
    connection: { state: 'off', agents: [] },
    /** @type {import('../lib/store.js').AgentUsage} */
    usage: { date: '', used: 0 },
    /** @type {import('../lib/store.js').AgentLogEntry[]} */
    log: [],
    /** @type {import('../lib/store.js').RunStatus} */
    run: IDLE_RUN_STATUS,
  },
};

/* ==========================================================================
   Start-up
   ========================================================================== */

init().catch((error) => {
  console.error(error);
  showNotice('error', 'The exporter could not start.', [String(error?.message ?? error)]);
});

async function init() {
  $('app-version').textContent = `v${TOOL_VERSION}`;
  document.querySelectorAll('kbd[data-mod]').forEach((kbd) => {
    kbd.textContent = IS_MAC ? '⌘' : 'Ctrl';
  });

  await resetInterruptedItems();
  await setRunStatus(IDLE_RUN_STATUS);
  [state.settings, state.queue, state.agent.connection, state.agent.usage, state.agent.log, state.agent.run] = await Promise.all([
    getSettings(),
    getQueue(),
    getAgentConnection(),
    getAgentUsage(),
    getAgentLog(),
    getRunStatus('agent'),
  ]);

  renderTheme(state.settings.theme);
  renderFormatOptions();
  renderSettings();
  renderQueue();
  renderRunPanel();
  renderAgentAccess();

  const params = new URLSearchParams(location.search);
  ui.welcome.hidden = !(params.has('welcome') && !state.settings.welcomeDismissed);

  bindEvents();
  onQueueChanged((queue) => {
    state.queue = queue;
    renderQueue();
    renderRunPanel();
  });
  // The toolbar popup edits the same settings; keep this page in sync.
  onSettingsChanged((settings) => {
    state.settings = settings;
    renderTheme(settings.theme);
    renderSettings();
    renderRunPanel();
    renderAgentAccess();
  });
  // Agent connection, usage, activity and running exports (from the background worker).
  onAgentStateChanged((change) => {
    Object.assign(state.agent, change);
    renderAgentAccess();
  });
  onRunStatusChanged((run) => {
    state.agent.run = run;
    renderAgentAccess();
    renderRunPanel();
  }, 'agent');
  // Commands from the toolbar popup when this tab is already open.
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (isAppCommand(message, sender)) runCommand(message);
  });

  // Commands from the popup when it had to open this tab.
  if (params.has('start') || params.has('help') || params.has('upload')) {
    history.replaceState(null, '', location.pathname + (params.has('welcome') ? '?welcome=1' : ''));
    runCommand({ start: params.has('start'), help: params.has('help'), upload: params.has('upload') });
  }
}

/**
 * Runs a command sent by the toolbar popup.
 *
 * @param {import('../lib/app-tab.js').AppCommand} command
 */
function runCommand({ start, help, upload }) {
  if (help) openHelp();
  else if (upload) showUploadArea();
  else if (start && !isRunning()) startExport();
}

/**
 * Switches to "Upload file" and draws attention to the drop zone. The file picker
 * itself can only open from a click on this page (browsers require that).
 */
function showUploadArea() {
  selectTab(/** @type {HTMLButtonElement} */ ($('tab-file')));
  ui.dropzone.scrollIntoView({ block: 'center', behavior: 'smooth' });
  ui.fileInput.focus({ preventScroll: true });
  ui.dropzone.classList.remove('is-highlighted');
  // Restart the highlight animation even if it ran before.
  void ui.dropzone.offsetWidth;
  ui.dropzone.classList.add('is-highlighted');
}

function bindEvents() {
  // Adding threads
  $('paste-add').addEventListener('click', addPastedLinks);
  ui.pasteInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      addPastedLinks();
    }
  });
  ui.fileInput.addEventListener('change', () => {
    const [file] = ui.fileInput.files ?? [];
    if (file) addLinksFromFile(file);
    ui.fileInput.value = '';
  });
  bindDropzone();
  bindTabs();
  $('open-tabs-refresh').addEventListener('click', loadOpenTabs);
  ui.openTabsAdd.addEventListener('click', addSelectedTabs);
  ui.openTabsList.addEventListener('change', updateOpenTabsButton);

  // Queue
  ui.queueList.addEventListener('click', async (event) => {
    const button = /** @type {HTMLElement} */ (event.target).closest('.qi-remove');
    const key = button?.closest('li')?.dataset.key;
    if (key) await removeFromQueue((item) => item.key === key);
  });
  ui.clearDone.addEventListener('click', () => removeFromQueue((item) => item.status === 'done'));
  ui.clearAll.addEventListener('click', clearQueue);

  // Export settings
  ui.formats.addEventListener('change', async (event) => {
    const input = /** @type {HTMLInputElement} */ (event.target);
    await updateSettings({ formats: { ...state.settings.formats, [input.value]: input.checked } });
  });
  ui.optSort.addEventListener('change', () => updateSettings({ sort: /** @type {Settings['sort']} */ (ui.optSort.value) }));
  ui.optDelay.addEventListener('change', () => updateSettings({ delaySeconds: Number(ui.optDelay.value) }));
  ui.optExpand.addEventListener('change', () => updateSettings({ expandMore: ui.optExpand.checked }));
  ui.optUsernames.addEventListener('change', () => updateSettings({ includeUsernames: ui.optUsernames.checked }));
  ui.optAutoDownload.addEventListener('change', () => updateSettings({ autoDownload: ui.optAutoDownload.checked }));
  ui.optFileName.addEventListener('change', () => updateSettings({ fileName: ui.optFileName.value.trim() }));
  ui.optBatchSize.addEventListener('change', () => updateSettings({ batchSize: Number(ui.optBatchSize.value) }));
  ui.optBatchPause.addEventListener('change', () => updateSettings({ batchPauseSeconds: Number(ui.optBatchPause.value) }));

  // Agent access
  ui.agentEnabled.addEventListener('change', () => updateAgentSettings({ enabled: ui.agentEnabled.checked }));
  ui.agentDailyLimit.addEventListener('change', () => updateAgentSettings({ dailyLimit: Number(ui.agentDailyLimit.value) }));
  ui.agentMaxRequest.addEventListener('change', () => updateAgentSettings({ maxPerRequest: Number(ui.agentMaxRequest.value) }));
  ui.agentAsk.addEventListener('change', () => updateAgentSettings({ askBeforeExport: ui.agentAsk.checked }));
  ui.agentPort.addEventListener('change', () => {
    const port = Math.round(Number(ui.agentPort.value));
    if (port >= 1024 && port <= 65535) updateAgentSettings({ port });
    else ui.agentPort.value = String(state.settings.agents.port);
  });
  $('agent-copy').addEventListener('click', copyAgentCommand);

  // Running
  ui.start.addEventListener('click', startExport);
  ui.pause.addEventListener('click', togglePause);
  ui.stop.addEventListener('click', () => {
    state.runner?.stop();
    appendLog('info', 'Stopping after the current request…');
  });
  ui.download.addEventListener('click', () => downloadExports());
  ui.copyMarkdown.addEventListener('click', copyMarkdown);

  // Chrome, help, theme
  ui.themeToggle.addEventListener('click', cycleTheme);
  $('help-open').addEventListener('click', openHelp);
  $('welcome-guide').addEventListener('click', openHelp);
  $('welcome-close').addEventListener('click', dismissWelcome);
  ui.helpDialog.querySelector('[data-close]')?.addEventListener('click', () => ui.helpDialog.close());
  ui.helpDialog.addEventListener('click', (event) => {
    if (event.target === ui.helpDialog) ui.helpDialog.close();
  });
  bindHelpNavigation();

  document.addEventListener('keydown', (event) => {
    const typing = /** @type {HTMLElement} */ (event.target).closest('input, textarea, select, [contenteditable]');
    if (event.key === '?' && !typing && !ui.helpDialog.open) {
      event.preventDefault();
      openHelp();
    }
  });

  window.addEventListener('beforeunload', (event) => {
    if (isRunning()) event.preventDefault();
  });
}

/* ==========================================================================
   Adding threads
   ========================================================================== */

function addPastedLinks() {
  const text = ui.pasteInput.value;
  if (!text.trim()) {
    showNotice('warning', 'Paste at least one Reddit thread link first.');
    ui.pasteInput.focus();
    return;
  }
  addLinksFromText(text, 'pasted text').then((added) => {
    if (added) ui.pasteInput.value = '';
  });
}

/**
 * @param {File} file
 */
async function addLinksFromFile(file) {
  if (file.size > MAX_FILE_BYTES) {
    showNotice('error', `${file.name} is larger than 5 MB.`, ['Split it into smaller files, or paste just the links.']);
    return;
  }
  try {
    await addLinksFromText(await file.text(), file.name);
  } catch (error) {
    showNotice('error', `${file.name} could not be read.`, [String(error?.message ?? error)]);
  }
}

/**
 * Finds thread links in any text and adds the new ones to the queue.
 *
 * @param {string} text
 * @param {string} source  Shown in the result message, e.g. the file name.
 * @returns {Promise<number>} Number of threads added.
 */
async function addLinksFromText(text, source) {
  const { refs, duplicates, notThreads } = extractThreadLinks(
    text,
    state.queue.map((item) => item.key),
  );
  const { added } = await addToQueue(refs);
  const alreadyQueued = duplicates + (refs.length - added);

  const details = [];
  if (alreadyQueued) details.push(`${plural(alreadyQueued, 'link')} already in the queue, skipped.`);
  if (notThreads.length) {
    details.push(
      `${plural(notThreads.length, 'Reddit link')} ${notThreads.length === 1 ? "isn't a thread" : "aren't threads"} (subreddit, user or other pages):`,
      ...notThreads.slice(0, 5).map((link) => `  ${link}`),
    );
    if (notThreads.length > 5) details.push(`  …and ${notThreads.length - 5} more`);
  }

  if (added) {
    showNotice(details.length ? 'warning' : 'success', `Added ${plural(added, 'thread')} from ${source}.`, details);
  } else if (alreadyQueued) {
    showNotice('warning', `No new threads in ${source}.`, details);
  } else {
    showNotice('error', `No Reddit thread links found in ${source}.`, [
      ...details,
      'Thread links look like reddit.com/r/<subreddit>/comments/<id>/… or redd.it/<id>.',
    ]);
  }
  return added;
}

function bindDropzone() {
  const zone = ui.dropzone;
  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    zone.classList.add('is-dragging');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('is-dragging'));
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    zone.classList.remove('is-dragging');
    const [file] = event.dataTransfer?.files ?? [];
    if (file) addLinksFromFile(file);
  });
}

/**
 * Shows one of the "Add threads" tabs and hides the others.
 *
 * @param {HTMLButtonElement} tab
 */
function selectTab(tab) {
  for (const other of document.querySelectorAll('[role="tab"]')) {
    const selected = other === tab;
    other.setAttribute('aria-selected', String(selected));
    /** @type {HTMLElement} */ (other).tabIndex = selected ? 0 : -1;
    $(/** @type {string} */ (other.getAttribute('aria-controls'))).hidden = !selected;
  }
  if (tab.id === 'tab-tabs') loadOpenTabs();
}

/** Tabs with arrow-key navigation, following the WAI-ARIA tabs pattern. */
function bindTabs() {
  const tabs = /** @type {HTMLButtonElement[]} */ ([...document.querySelectorAll('[role="tab"]')]);

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', (event) => {
      const offset = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
      const target = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : offset ? tabs[(index + offset + tabs.length) % tabs.length] : null;
      if (!target) return;
      event.preventDefault();
      target.focus();
      selectTab(target);
    });
  });
}

/** Lists Reddit threads open in any window, so they can be added with a tick. */
async function loadOpenTabs() {
  const tabs = await chrome.tabs.query({ url: REDDIT_TAB_PATTERNS });
  const queued = new Set(state.queue.map((item) => item.key));
  const threads = [];
  const seen = new Set();

  for (const tab of tabs) {
    const ref = tab.url ? parseThreadLink(tab.url) : null;
    if (!ref || ref.kind !== 'thread' || seen.has(ref.id)) continue;
    seen.add(ref.id);
    threads.push({ ref, title: cleanTabTitle(tab.title) || slugToTitle(ref.slug) || ref.url, queued: queued.has(ref.id) });
  }

  ui.openTabsList.replaceChildren(
    ...threads.map(({ ref, title, queued: isQueued }) => {
      const item = document.createElement('li');
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = ref.url;
      checkbox.checked = !isQueued;
      checkbox.disabled = isQueued;
      const text = document.createElement('span');
      text.className = 'ct-text';
      const titleEl = document.createElement('span');
      titleEl.className = 'ct-title';
      titleEl.textContent = title;
      const sub = document.createElement('span');
      sub.className = 'ct-sub';
      sub.textContent = `r/${ref.subreddit ?? '?'}${isQueued ? ' · already in the queue' : ''}`;
      text.append(titleEl, sub);
      label.append(checkbox, text);
      if (isQueued) label.classList.add('is-queued');
      item.append(label);
      return item;
    }),
  );

  ui.openTabsSummary.textContent = threads.length
    ? `${plural(threads.length, 'Reddit thread')} open in your browser.`
    : 'No Reddit threads are open right now. Open a thread in another tab, then press Refresh.';
  updateOpenTabsButton();
}

function updateOpenTabsButton() {
  const count = ui.openTabsList.querySelectorAll('input:checked:not(:disabled)').length;
  ui.openTabsAdd.disabled = count === 0;
  ui.openTabsAdd.textContent = count ? `Add ${plural(count, 'thread')}` : 'Add selected';
}

async function addSelectedTabs() {
  const urls = [...ui.openTabsList.querySelectorAll('input:checked:not(:disabled)')].map(
    (input) => /** @type {HTMLInputElement} */ (input).value,
  );
  await addLinksFromText(urls.join('\n'), 'your open tabs');
  await loadOpenTabs();
}

/* ==========================================================================
   Queue
   ========================================================================== */

function renderQueue() {
  const { queue } = state;
  const counts = countByStatus(queue);

  ui.queueEmpty.hidden = queue.length > 0;
  ui.clearAll.hidden = queue.length === 0;
  ui.clearDone.hidden = counts.done === 0 || counts.done === queue.length;
  ui.queueSummary.textContent = queue.length
    ? [
        plural(queue.length, 'thread'),
        counts.done ? `${counts.done} exported` : '',
        counts.failed ? `${counts.failed} failed` : '',
        counts.queued + counts.running ? `${counts.queued + counts.running} to go` : '',
      ]
        .filter(Boolean)
        .join(' · ')
    : 'No threads yet';

  // Reuse existing rows so focus and hover survive re-renders.
  const existing = new Map([...ui.queueList.children].map((li) => [/** @type {HTMLElement} */ (li).dataset.key, li]));
  const rows = queue.map((item) => {
    let row = existing.get(item.key);
    if (!row) {
      // Only rows that are new to the list animate in; re-rendered rows stay put.
      row = /** @type {HTMLLIElement} */ (ui.queueItemTemplate.content.firstElementChild?.cloneNode(true));
      row.classList.add('is-new');
      row.addEventListener('animationend', () => row?.classList.remove('is-new'), { once: true });
    }
    fillQueueRow(/** @type {HTMLLIElement} */ (row), item);
    return row;
  });
  // Moving nodes restarts their CSS animations, so only touch the DOM when the order changed.
  const sameOrder = rows.length === ui.queueList.children.length && rows.every((row, index) => ui.queueList.children[index] === row);
  if (!sameOrder) ui.queueList.replaceChildren(...rows);
}

/**
 * @param {HTMLLIElement} row
 * @param {QueueItem} item
 */
function fillQueueRow(row, item) {
  row.dataset.key = item.key;
  row.dataset.status = item.status;

  const title = item.title || (item.ref.kind === 'share' ? 'Share link (opened during export)' : `Thread ${item.ref.id}`);
  const link = /** @type {HTMLAnchorElement} */ (row.querySelector('.qi-title'));
  link.textContent = title;
  link.href = item.ref.url;
  link.title = 'Open on Reddit (new tab)';

  /** @type {HTMLElement} */ (row.querySelector('.qi-sub')).textContent = item.subreddit ? `r/${item.subreddit}` : '';
  /** @type {HTMLElement} */ (row.querySelector('.qi-error')).textContent = item.status === 'failed' ? item.error ?? '' : '';

  const badge = /** @type {HTMLElement} */ (row.querySelector('.qi-status'));
  badge.textContent = describeItemStatus(item);
  badge.dataset.tone = { queued: '', running: 'accent', done: 'success', failed: 'danger' }[item.status];

  // Subreddit initial, or an icon while exporting, after a failure, or before the subreddit is known.
  const statusIcon = { queued: undefined, running: 'i-loader', done: undefined, failed: 'i-alert' }[item.status];
  fillAvatar(/** @type {HTMLElement} */ (row.querySelector('.avatar')), {
    subreddit: item.subreddit,
    icon: statusIcon ?? (item.subreddit ? undefined : 'i-link'),
  });

  // The comment count, shown large on the right like a score.
  const metric = /** @type {HTMLElement} */ (row.querySelector('.qi-metric'));
  if (item.status === 'done' && item.comments) {
    const unit = document.createElement('small');
    unit.textContent = item.comments.exported === 1 ? 'comment' : 'comments';
    metric.replaceChildren(document.createTextNode(item.comments.exported.toLocaleString()), unit);
  } else {
    metric.replaceChildren();
  }

  const remove = /** @type {HTMLButtonElement} */ (row.querySelector('.qi-remove'));
  remove.setAttribute('aria-label', `Remove "${title}" from the queue`);
  remove.disabled = item.status === 'running';
}

/** @param {QueueItem} item */
function describeItemStatus(item) {
  switch (item.status) {
    case 'running':
      return 'Exporting…';
    case 'failed':
      return 'Failed';
    case 'done': {
      const { exported = 0, reported = 0 } = item.comments ?? {};
      return exported < reported ? `Exported · ${exported.toLocaleString()} of ${reported.toLocaleString()}` : 'Exported';
    }
    default:
      return 'Waiting';
  }
}

async function clearQueue() {
  const confirmed = await confirmAction({
    title: 'Clear the whole queue?',
    text: `This removes ${plural(state.queue.length, 'thread')} and any exported data that hasn't been downloaded. Files already in your Downloads folder stay.`,
    confirmLabel: 'Clear all',
  });
  if (confirmed) {
    await removeFromQueue(() => true);
    state.lastResult = null;
    renderRunPanel();
  }
}

/* ==========================================================================
   Settings
   ========================================================================== */

function renderFormatOptions() {
  ui.formats.append(
    ...EXPORT_FORMATS.map((format) => {
      const label = document.createElement('label');
      label.className = 'format';
      label.title = format.description;

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.name = 'format';
      input.value = format.id;

      const icon = document.createElement('span');
      icon.className = 'format-icon';
      icon.append(createIcon(format.icon));

      const check = document.createElement('span');
      check.className = 'format-check';
      check.append(createIcon('i-check'));

      const name = document.createElement('span');
      name.className = 'format-name';
      name.textContent = format.label;
      const ext = document.createElement('span');
      ext.className = 'format-ext';
      ext.textContent = `.${format.extension}`;
      name.append(ext);

      const tagline = document.createElement('span');
      tagline.className = 'format-desc';
      tagline.textContent = format.tagline;

      label.append(input, icon, check, name, tagline);
      return label;
    }),
  );
}

function renderSettings() {
  const { settings } = state;
  ui.formats.querySelectorAll('input').forEach((input) => {
    input.checked = Boolean(settings.formats[/** @type {keyof Settings['formats']} */ (input.value)]);
  });
  ui.optSort.value = settings.sort;
  ui.optDelay.value = String(settings.delaySeconds);
  ui.optBatchSize.value = String(settings.batchSize);
  ui.optBatchPause.value = String(settings.batchPauseSeconds);
  ui.optBatchPause.disabled = settings.batchSize === 0;
  ui.optExpand.checked = settings.expandMore;
  ui.optUsernames.checked = settings.includeUsernames;
  ui.optAutoDownload.checked = settings.autoDownload;
  ui.optFileName.value = settings.fileName;
  ui.optFileName.placeholder = toFileStem('');

  const sortLabel = ui.optSort.selectedOptions[0]?.textContent ?? '';
  ui.optionsSummary.textContent = [sortLabel, `${settings.delaySeconds} s`, settings.expandMore ? 'all replies' : '', settings.includeUsernames ? 'usernames' : '']
    .filter(Boolean)
    .join(' · ');
}

/** @param {Partial<Settings>} patch */
async function updateSettings(patch) {
  state.settings = await saveSettings(patch);
  renderSettings();
  renderRunPanel();
}

/* ==========================================================================
   Exporting
   ========================================================================== */

/** An export is in progress from the moment Start is pressed until the runner finishes. */
function isRunning() {
  return state.runner !== null;
}

async function startExport() {
  const jobs = state.queue.filter((item) => item.status !== 'done').map((item) => ({ key: item.key, ref: item.ref }));
  if (!jobs.length || isRunning()) return;
  if (isAgentRunning()) {
    showNotice('warning', 'An agent is exporting right now.', ['You can start your export as soon as it finishes.']);
    return;
  }

  const redditTab = new RedditTab();
  const runner = new ExportRunner({
    request: (path) => redditTab.request(path),
    settings: {
      delaySeconds: state.settings.delaySeconds,
      sort: state.settings.sort,
      expandMore: state.settings.expandMore,
      batchSize: state.settings.batchSize,
      batchPauseSeconds: state.settings.batchPauseSeconds,
    },
  });
  state.runner = runner;
  state.lastResult = null;
  state.run = { total: jobs.length, finished: 0, currentTitle: '', waitUntil: 0, waitReason: '' };
  let exportedComments = 0;

  // Event handlers save to storage asynchronously; collect them so the run only
  // counts as finished once every result is stored.
  /** @type {Set<Promise<void>>} */
  const pendingSaves = new Set();
  /** @param {(event: CustomEvent) => Promise<void>} handler */
  const tracked = (handler) => (/** @type {Event} */ event) => {
    const save = handler(/** @type {CustomEvent} */ (event)).catch((error) => appendLog('error', String(error?.message ?? error)));
    pendingSaves.add(save);
    save.finally(() => pendingSaves.delete(save));
  };

  runner.addEventListener('state', () => renderRunPanel());
  runner.addEventListener('log', (event) => appendLog(event.detail.level, event.detail.message));

  runner.addEventListener('item-start', tracked(async (event) => {
    const { job, index, total } = event.detail;
    const item = state.queue.find((entry) => entry.key === job.key);
    state.run.currentTitle = item?.title || job.ref.url;
    appendLog('info', `(${index + 1}/${total}) ${state.run.currentTitle}`);
    renderRunPanel();
    await updateQueueItem(job.key, { status: 'running', error: null });
  }));

  runner.addEventListener('item-done', tracked(async (event) => {
    const { job, result } = event.detail;
    const thread = normalizeThread(result.listing, result.extraThings);
    exportedComments += thread.commentCounts.exported;
    state.run.finished += 1;
    appendLog('info', `Done: ${plural(thread.commentCounts.exported, 'comment')}.`);
    renderRunPanel();
    await saveThreadData(job.key, { listing: result.listing, extraThings: result.extraThings });
    await updateQueueItem(job.key, {
      status: 'done',
      error: null,
      ref: result.ref,
      title: thread.title,
      subreddit: thread.subreddit,
      comments: { exported: thread.commentCounts.exported, reported: thread.commentCounts.reported },
      fetchedAt: Date.now(),
    });
  }));

  runner.addEventListener('item-failed', tracked(async (event) => {
    const { job, error } = event.detail;
    state.run.finished += 1;
    appendLog('error', error);
    renderRunPanel();
    await updateQueueItem(job.key, { status: 'failed', error });
  }));

  runner.addEventListener('wait', (event) => {
    const { reason, until } = event.detail;
    state.run.waitUntil = until;
    state.run.waitReason = reason;
    startWaitCountdown();
  });

  appendLog('info', `Starting export of ${plural(jobs.length, 'thread')}.`);
  renderRunPanel();

  try {
    const { opened } = await redditTab.connect();
    appendLog('info', opened ? 'Opened a Reddit tab in the background. It closes again when the export ends.' : 'Using your open Reddit tab.');
  } catch (error) {
    appendLog('error', String(error?.message ?? error));
    state.runner = null;
    showNotice('error', 'Could not open Reddit.', [String(error?.message ?? error)]);
    renderRunPanel();
    return;
  }

  const summary = await runner.run(jobs);
  await Promise.allSettled([...pendingSaves]);
  await redditTab.release();
  stopWaitCountdown();

  await resetInterruptedItems();
  state.queue = await getQueue();
  state.lastResult = { ...summary, comments: exportedComments };
  state.runner = null;
  appendLog(
    summary.failed ? 'warn' : 'info',
    `${summary.stopped ? 'Stopped' : 'Finished'}: ${summary.done} exported, ${summary.failed} failed.`,
  );
  renderRunPanel();

  if (summary.done && state.settings.autoDownload) await downloadExports();
}

function togglePause() {
  const runner = state.runner;
  if (!runner) return;
  if (runner.state === 'paused') {
    runner.resume();
    appendLog('info', 'Resumed.');
  } else {
    runner.pause();
    appendLog('info', 'Pausing after the current thread…');
  }
}

function renderRunPanel() {
  const running = isRunning();
  const counts = countByStatus(state.queue);
  const pending = counts.queued + counts.failed + counts.running;
  const formatsChosen = selectedFormats().length;

  ui.runIdle.hidden = running;
  ui.runActive.hidden = !running;

  // Idle: explain exactly why the button is disabled, if it is.
  ui.startLabel.textContent = pending ? `Export ${plural(pending, 'thread')}` : 'Start export';
  const agentRunning = isAgentRunning();
  ui.start.disabled = running || pending === 0 || agentRunning;
  ui.startHint.textContent = describeStartHint(pending, counts.failed, agentRunning);

  // Running
  if (running && state.runner) {
    const { total, finished, currentTitle } = state.run;
    const paused = state.runner.state === 'paused';
    const stopping = state.runner.state === 'stopping';
    const percent = total ? Math.round((finished / total) * 100) : 0;
    ui.runActive.dataset.state = state.runner.state;
    ui.runState.textContent = stopping ? 'Stopping…' : paused ? 'Paused' : 'Exporting';
    ui.runCount.textContent = `${finished} of ${plural(total, 'thread')}`;
    ui.runPercent.textContent = `${percent}%`;
    ui.progress.setAttribute('aria-valuenow', String(percent));
    ui.progressBar.style.width = `${percent}%`;
    ui.runCurrent.textContent = paused ? 'Paused. Press Resume to continue.' : currentTitle ? `Now: ${currentTitle}` : 'Connecting to Reddit…';
    ui.pauseLabel.textContent = paused ? 'Resume' : 'Pause';
    setIcon(ui.pause, paused ? 'i-play' : 'i-pause');
    /** @type {HTMLButtonElement} */ (ui.pause).disabled = stopping;
    /** @type {HTMLButtonElement} */ (ui.stop).disabled = stopping;
  }
  publishRunStatus();

  // Result of the last run
  const result = state.lastResult;
  ui.result.hidden = !result || running;
  if (result) {
    const tone = result.failed || result.stopped ? 'warning' : 'success';
    ui.result.dataset.tone = tone;
    setIcon(ui.result.querySelector('.result-icon'), tone === 'success' ? 'i-check' : 'i-alert');
    ui.resultTitle.textContent = result.stopped
      ? `Stopped after ${plural(result.done, 'thread')}`
      : result.failed
        ? `${result.done} exported, ${result.failed} failed`
        : `Exported ${plural(result.done, 'thread')}`;
    ui.resultDetail.textContent = [
      result.done ? `${plural(result.comments, 'comment')} collected.` : '',
      result.failed ? 'Failed threads show the reason in the queue. Start again to retry them.' : '',
      result.done && state.settings.autoDownload ? 'Files saved to Downloads.' : '',
    ]
      .filter(Boolean)
      .join(' ');
  }

  // Downloads
  const canDownload = counts.done > 0 && formatsChosen > 0 && !running;
  ui.download.disabled = !canDownload;
  ui.copyMarkdown.disabled = counts.done === 0 || running;
  ui.downloadLabel.textContent = counts.done ? `Download ${plural(counts.done, 'exported thread')}` : 'Download files';
  ui.downloadHint.textContent = running
    ? 'Downloads unlock when the export finishes.'
    : counts.done === 0
      ? 'Exported threads can be downloaded here.'
      : formatsChosen === 0
        ? 'Choose at least one format above.'
        : `${selectedFormats()
            .map((format) => `.${format.extension}`)
            .join(', ')} · saved to Downloads/${DOWNLOAD_FOLDER}`;
}

/**
 * Explains what pressing Export will do, or why it can't be pressed.
 *
 * @param {number} pending       Threads that still need exporting.
 * @param {number} failed        Of those, threads that failed before.
 * @param {boolean} agentRunning An agent export is in progress.
 */
function describeStartHint(pending, failed, agentRunning) {
  if (agentRunning) return `${state.agent.run.client ?? 'An agent'} is exporting threads. You can start once it's done.`;
  if (!state.queue.length) return 'Add at least one thread to start.';
  if (pending === 0) return 'Every thread in the queue is exported. Add more, or download the files below.';
  if (failed) return `Includes ${plural(failed, 'failed thread')} to retry. About ${estimateDuration(pending)}.`;
  return `About ${estimateDuration(pending)}. You can keep using Chrome meanwhile.`;
}

/** Shares the export's progress with the toolbar popup. */
function publishRunStatus() {
  const runnerState = state.runner?.state;
  const status = isRunning()
    ? {
        state: runnerState === 'paused' || runnerState === 'stopping' ? runnerState : 'running',
        finished: state.run.finished,
        total: state.run.total,
        current: state.run.currentTitle,
      }
    : IDLE_RUN_STATUS;
  const serialized = JSON.stringify(status);
  if (serialized === state.publishedStatus) return;
  state.publishedStatus = serialized;
  setRunStatus(status).catch(() => {});
}

/** Shows a live countdown while the runner waits for Reddit (rate limits and retries). */
function startWaitCountdown() {
  stopWaitCountdown();
  const tick = () => {
    const seconds = Math.ceil((state.run.waitUntil - Date.now()) / 1000);
    // Short polite delays are routine; only show waits worth explaining.
    const visible = seconds > 0 && state.run.waitReason !== 'delay';
    ui.runWait.hidden = !visible;
    if (visible) {
      ui.runWaitText.textContent =
        state.run.waitReason === 'rate-limit'
          ? `Reddit asked for a short break. Continuing in ${formatSeconds(seconds)}.`
          : state.run.waitReason === 'batch'
            ? `Batch done. Taking a break, continuing in ${formatSeconds(seconds)}.`
            : `Reddit didn't answer. Trying again in ${formatSeconds(seconds)}.`;
    }
    if (seconds <= 0) stopWaitCountdown();
  };
  tick();
  state.waitTimer = window.setInterval(tick, 500);
}

function stopWaitCountdown() {
  window.clearInterval(state.waitTimer);
  ui.runWait.hidden = true;
}

/* ==========================================================================
   Building and saving files
   ========================================================================== */

function selectedFormats() {
  return EXPORT_FORMATS.filter((format) => state.settings.formats?.[format.id]);
}

/**
 * Loads every exported thread from storage, in queue order.
 *
 * @returns {Promise<{ threads: import('../lib/thread-model.js').Thread[], listings: unknown[] }>}
 */
async function loadExportedThreads() {
  const doneItems = state.queue.filter((item) => item.status === 'done');
  const data = await getThreadData(doneItems.map((item) => item.key));
  const threads = [];
  const listings = [];

  for (const item of doneItems) {
    const entry = data.get(item.key);
    if (!entry) continue;
    threads.push(normalizeThread(entry.listing, entry.extraThings, { includeUsernames: state.settings.includeUsernames }));
    listings.push(entry.listing);
  }
  return { threads, listings };
}

/**
 * @param {string} formatId
 * @param {{ threads: import('../lib/thread-model.js').Thread[], listings: unknown[] }} data
 * @param {import('../lib/formatters.js').ExportMeta} meta
 */
function buildFile(formatId, { threads, listings }, meta) {
  switch (formatId) {
    case 'markdown':
      return toMarkdown(threads, meta);
    case 'csv':
      return toCsv(threads);
    case 'json':
      return toJson(threads, meta);
    case 'raw':
      return toRawJson(listings);
    default:
      throw new Error(`Unknown format: ${formatId}`);
  }
}

/** Builds one file per selected format and hands them to Chrome's download manager. */
async function downloadExports() {
  const formats = selectedFormats();
  if (!formats.length) return;

  try {
    const data = await loadExportedThreads();
    if (!data.threads.length) {
      showNotice('warning', 'There is nothing to download yet.', ['Export at least one thread first.']);
      return;
    }
    const meta = { exportedAt: new Date(), toolName: TOOL_NAME, toolVersion: TOOL_VERSION };
    const stem = toFileStem(state.settings.fileName, meta.exportedAt);

    for (const format of formats) {
      const blob = new Blob([buildFile(format.id, data, meta)], { type: `${format.mimeType};charset=utf-8` });
      const url = URL.createObjectURL(blob);
      await chrome.downloads.download({
        url,
        filename: `${DOWNLOAD_FOLDER}/${stem}.${format.extension}`,
        conflictAction: 'uniquify',
        saveAs: false,
      });
      // Chrome has its own copy once the download starts; free the memory a little later.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
    appendLog('info', `Saved ${formats.map((f) => `${stem}.${f.extension}`).join(', ')} to Downloads/${DOWNLOAD_FOLDER}.`);
  } catch (error) {
    showNotice('error', 'The files could not be saved.', [String(error?.message ?? error)]);
    appendLog('error', `Download failed: ${error?.message ?? error}`);
  }
}

async function copyMarkdown() {
  try {
    const data = await loadExportedThreads();
    const markdown = toMarkdown(data.threads, { exportedAt: new Date(), toolName: TOOL_NAME, toolVersion: TOOL_VERSION });
    await navigator.clipboard.writeText(markdown);
    ui.copyLabel.textContent = `Copied ${plural(data.threads.length, 'thread')}`;
    setIcon(ui.copyMarkdown, 'i-check');
    setTimeout(() => {
      ui.copyLabel.textContent = 'Copy as Markdown';
      setIcon(ui.copyMarkdown, 'i-copy');
    }, 2000);
  } catch (error) {
    showNotice('error', 'Could not copy to the clipboard.', [String(error?.message ?? error)]);
  }
}

/* ==========================================================================
   Feedback: notices, log, confirmation
   ========================================================================== */

/**
 * Shows the result of an action under the "Add threads" card. It stays until the
 * next action or until it's dismissed, so nothing important disappears on its own.
 *
 * @param {'success' | 'warning' | 'error'} tone
 * @param {string} title
 * @param {string[]} [details]
 */
function showNotice(tone, title, details = []) {
  const svg = createIcon(tone === 'success' ? 'i-check' : 'i-alert');

  const body = document.createElement('div');
  body.className = 'notice-body';
  const heading = document.createElement('strong');
  heading.textContent = title;
  body.append(heading);
  if (details.length) {
    const list = document.createElement('ul');
    list.append(
      ...details.map((line) => {
        const li = document.createElement('li');
        li.textContent = line.trim();
        return li;
      }),
    );
    body.append(list);
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'icon-btn icon-btn-sm icon-btn-plain';
  close.setAttribute('aria-label', 'Dismiss message');
  close.append(createIcon('i-x'));
  close.addEventListener('click', () => {
    ui.addResult.hidden = true;
  });

  ui.addResult.dataset.tone = tone;
  ui.addResult.replaceChildren(svg, body, close);
  ui.addResult.hidden = false;
}

/**
 * @param {'info' | 'warn' | 'error'} level
 * @param {string} message
 */
function appendLog(level, message) {
  const entry = document.createElement('li');
  entry.dataset.level = level;
  const time = document.createElement('time');
  const now = new Date();
  time.dateTime = now.toISOString();
  time.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const text = document.createElement('span');
  text.textContent = message;
  entry.append(time, text);
  ui.logList.append(entry);

  while (ui.logList.children.length > MAX_LOG_ENTRIES) ui.logList.firstElementChild?.remove();
  ui.logList.scrollTop = ui.logList.scrollHeight;
  ui.logCount.textContent = `(${ui.logList.children.length})`;
}

/**
 * An accessible replacement for `window.confirm`.
 *
 * @param {{ title: string, text: string, confirmLabel: string }} options
 * @returns {Promise<boolean>}
 */
function confirmAction({ title, text, confirmLabel }) {
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  $('confirm-ok').textContent = confirmLabel;
  ui.confirmDialog.returnValue = '';
  ui.confirmDialog.showModal();
  return new Promise((resolve) => {
    ui.confirmDialog.addEventListener('close', () => resolve(ui.confirmDialog.returnValue === 'confirm'), { once: true });
  });
}

/* ==========================================================================
   Agent access (MCP)
   ========================================================================== */

function isAgentRunning() {
  return state.agent.run.state !== 'idle';
}

/** @param {Partial<import('../lib/store.js').AgentSettings>} patch */
async function updateAgentSettings(patch) {
  await updateSettings({ agents: { ...state.settings.agents, ...patch } });
}

function renderAgentAccess() {
  const { agents } = state.settings;
  const { connection, usage, log, run } = state.agent;
  const running = run.state !== 'idle';
  const connected = connection.state === 'connected';

  ui.agentEnabled.checked = agents.enabled;
  ui.agentSettings.hidden = !agents.enabled;
  ui.agentUsage.hidden = !agents.enabled;

  // Status badge and the line under the switch
  const names = connection.agents.length ? connection.agents.join(', ') : '';
  const [badgeText, tone] = !agents.enabled
    ? ['Off', '']
    : running
      ? ['Exporting', 'accent']
      : connected
        ? ['Connected', 'success']
        : ['Waiting', ''];
  ui.agentBadge.textContent = badgeText;
  ui.agentBadge.dataset.tone = tone;
  ui.agentConnectionText.textContent = !agents.enabled
    ? "Agents can't use the extension."
    : connected
      ? names
        ? `Connected to the MCP server. In use by ${names}.`
        : 'Connected to the MCP server. No agent is using it yet.'
      : `Waiting for the MCP server on port ${agents.port}. Start an agent that has it set up.`;

  // A running agent export
  ui.agentRun.hidden = !running;
  if (running) {
    const percent = run.total ? Math.round((run.finished / run.total) * 100) : 0;
    ui.agentRunTitle.textContent = `${run.client ?? 'An agent'} is exporting: ${run.finished} of ${plural(run.total, 'item')}`;
    ui.agentRunProgress.setAttribute('aria-valuenow', String(percent));
    ui.agentRunBar.style.width = `${percent}%`;
  }

  // Today's usage
  const used = usage.date === localDate() ? usage.used : 0;
  const percent = Math.min(100, Math.round((used / agents.dailyLimit) * 100));
  ui.agentUsageCount.textContent = `${used} of ${agents.dailyLimit}`;
  ui.agentUsage.dataset.tone = used >= agents.dailyLimit ? 'full' : '';
  ui.agentUsageProgress.setAttribute('aria-valuenow', String(percent));
  ui.agentUsageBar.style.width = `${percent}%`;

  // Settings
  ui.agentDailyLimit.value = String(agents.dailyLimit);
  ui.agentMaxRequest.value = String(agents.maxPerRequest);
  ui.agentAsk.checked = agents.askBeforeExport;
  if (document.activeElement !== ui.agentPort) ui.agentPort.value = String(agents.port);

  // Recent activity, newest first
  ui.agentActivity.replaceChildren(
    ...log.slice(0, 8).map((entry) => {
      const item = document.createElement('li');
      item.dataset.ok = String(entry.ok);
      const dot = document.createElement('span');
      dot.className = 'activity-dot';
      dot.setAttribute('aria-label', entry.ok ? 'Succeeded' : 'Failed or denied');
      const text = document.createElement('span');
      text.className = 'activity-text';
      const client = document.createElement('span');
      client.className = 'activity-client';
      client.textContent = `${entry.client}: `;
      text.append(client, document.createTextNode(entry.summary));
      const time = document.createElement('time');
      time.dateTime = new Date(entry.time).toISOString();
      time.textContent = formatActivityTime(entry.time);
      item.append(dot, text, time);
      return item;
    }),
  );
}

async function copyAgentCommand() {
  const command = $('agent-command').textContent ?? '';
  try {
    await navigator.clipboard.writeText(command);
    setIcon($('agent-copy'), 'i-check');
    setTimeout(() => setIcon($('agent-copy'), 'i-copy'), 1500);
  } catch (error) {
    showNotice('error', 'Could not copy to the clipboard.', [String(error?.message ?? error)]);
  }
}

/** @param {number} time */
function formatActivityTime(time) {
  const date = new Date(time);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/* ==========================================================================
   Help, welcome and theme
   ========================================================================== */

function openHelp() {
  ui.helpDialog.showModal();
  ui.helpBody.scrollTop = 0;
}

/** Highlights the help topic in view and scrolls to topics when they're clicked. */
function bindHelpNavigation() {
  const links = /** @type {HTMLAnchorElement[]} */ ([...ui.helpDialog.querySelectorAll('.help-nav a')]);
  links.forEach((link) =>
    link.addEventListener('click', (event) => {
      event.preventDefault();
      ui.helpDialog.querySelector(/** @type {string} */ (link.getAttribute('href')))?.scrollIntoView({ block: 'start' });
    }),
  );

  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries.find((entry) => entry.isIntersecting);
      if (!visible) return;
      links.forEach((link) => link.setAttribute('aria-current', String(link.getAttribute('href') === `#${visible.target.id}`)));
    },
    { root: ui.helpBody, rootMargin: '0px 0px -70% 0px' },
  );
  ui.helpBody.querySelectorAll('section').forEach((section) => observer.observe(section));
}

async function dismissWelcome() {
  ui.welcome.hidden = true;
  history.replaceState(null, '', location.pathname);
  await updateSettings({ welcomeDismissed: true });
}

async function cycleTheme() {
  const next = THEMES[(THEMES.indexOf(state.settings.theme) + 1) % THEMES.length];
  renderTheme(next);
  await updateSettings({ theme: next });
}

/**
 * Applies the theme and updates the toggle's icon and label.
 *
 * @param {Settings['theme']} theme
 */
function renderTheme(theme) {
  applyTheme(theme);

  const labels = { system: 'Theme: match system', light: 'Theme: light', dark: 'Theme: dark' };
  const icons = { system: 'i-monitor', light: 'i-sun', dark: 'i-moon' };
  ui.themeToggle.setAttribute('aria-label', `${labels[theme]}. Click to change.`);
  ui.themeToggle.title = labels[theme];
  setIcon(ui.themeToggle, icons[theme]);
}

/* ==========================================================================
   Small helpers
   ========================================================================== */

/** @param {QueueItem[]} queue */
function countByStatus(queue) {
  const counts = { queued: 0, running: 0, done: 0, failed: 0 };
  for (const item of queue) counts[item.status] += 1;
  return counts;
}

/**
 * A rough duration for `threadCount` threads at the current settings.
 *
 * @param {number} threadCount
 */
function estimateDuration(threadCount) {
  const { delaySeconds, expandMore, batchSize, batchPauseSeconds } = state.settings;
  const perThread = delaySeconds + 1 + (expandMore ? 2 * (delaySeconds + 1) : 0);
  const batchBreaks = batchSize > 0 ? Math.floor((threadCount - 1) / batchSize) * batchPauseSeconds : 0;
  const seconds = threadCount * perThread + batchBreaks;
  return seconds < 60 ? `${Math.max(5, Math.round(seconds / 5) * 5)} seconds` : `${Math.round(seconds / 60)} min`;
}

/** @param {number} seconds */
function formatSeconds(seconds) {
  return seconds >= 60 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} min` : `${seconds} s`;
}
