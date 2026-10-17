/**
 * Toolbar popup: quick access without opening the full exporter.
 *
 * - "This page": adds the thread in the current tab with one click.
 * - Shows the queue counts and, while an export runs, its progress.
 * - Quick add for pasted links, a shortcut to file upload, and the most-used settings.
 * - Export opens the exporter page and starts the export there, because a popup
 *   closes as soon as it loses focus and can't run long tasks itself.
 */

import { openApp } from '../lib/app-tab.js';
import { EXPORT_FORMATS } from '../lib/formatters.js';
import { cleanTabTitle, extractThreadLinks, parseThreadLink, refKey, slugToTitle } from '../lib/reddit-links.js';
import {
  addToQueue,
  getAgentConnection,
  getQueue,
  getRunStatus,
  getSettings,
  IDLE_RUN_STATUS,
  onAgentStateChanged,
  onQueueChanged,
  onRunStatusChanged,
  onSettingsChanged,
  saveSettings,
} from '../lib/store.js';
import { applyTheme, createIcon, fillAvatar, plural, setIcon } from '../shared/ui.js';

/** @typedef {import('../lib/store.js').QueueItem} QueueItem */
/** @typedef {import('../lib/store.js').Settings} Settings */
/** @typedef {import('../lib/store.js').RunStatus} RunStatus */
/** @typedef {import('../lib/reddit-links.js').ThreadRef} ThreadRef */

/** Shorthand for `document.getElementById` that fails loudly on typos. */
const $ = (/** @type {string} */ id) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element;
};

const ui = {
  current: $('current'),
  currentAvatar: $('current-avatar'),
  currentTitle: $('current-title'),
  currentAdd: /** @type {HTMLButtonElement} */ ($('current-add')),
  currentAddLabel: $('current-add-label'),
  run: $('run'),
  runTitle: $('run-title'),
  runProgress: $('run-progress'),
  runBar: $('run-bar'),
  statWaiting: $('stat-waiting'),
  statDone: $('stat-done'),
  statDoneItem: $('stat-done-item'),
  statFailed: $('stat-failed'),
  statFailedItem: $('stat-failed-item'),
  quickAdd: /** @type {HTMLFormElement} */ ($('quick-add')),
  quickInput: /** @type {HTMLInputElement} */ ($('quick-input')),
  addStatus: $('add-status'),
  formats: $('formats'),
  optSort: /** @type {HTMLSelectElement} */ ($('opt-sort')),
  optDelay: /** @type {HTMLSelectElement} */ ($('opt-delay')),
  optExpand: /** @type {HTMLInputElement} */ ($('opt-expand')),
  optUsernames: /** @type {HTMLInputElement} */ ($('opt-usernames')),
  exportButton: /** @type {HTMLButtonElement} */ ($('export')),
  exportLabel: $('export-label'),
  exportHint: $('export-hint'),
};

const state = {
  /** @type {QueueItem[]} */
  queue: [],
  /** @type {Settings} */
  settings: /** @type {Settings} */ ({}),
  /** @type {RunStatus} */
  run: IDLE_RUN_STATUS,
  /** An agent export running in the background worker. @type {RunStatus} */
  agentRun: IDLE_RUN_STATUS,
  /** @type {import('../lib/store.js').AgentConnection} */
  agentConnection: { state: 'off', agents: [] },
  /** The thread open in the current tab, if any. @type {ThreadRef | null} */
  pageThread: null,
};

init().catch((error) => {
  ui.addStatus.dataset.tone = 'error';
  ui.addStatus.textContent = `Something went wrong: ${error?.message ?? error}`;
});

async function init() {
  [state.settings, state.queue, state.run, state.agentRun, state.agentConnection] = await Promise.all([
    getSettings(),
    getQueue(),
    getRunStatus('page'),
    getRunStatus('agent'),
    getAgentConnection(),
  ]);
  applyTheme(state.settings.theme);

  renderFormatChips();
  renderSettings();
  renderQueueState();
  await detectPageThread();
  bindEvents();

  onQueueChanged((queue) => {
    state.queue = queue;
    renderQueueState();
  });
  onRunStatusChanged((run) => {
    state.run = run;
    renderQueueState();
  });
  onRunStatusChanged((run) => {
    state.agentRun = run;
    renderQueueState();
  }, 'agent');
  onAgentStateChanged(({ connection }) => {
    if (!connection) return;
    state.agentConnection = connection;
    renderAgentBadge();
  });
  onSettingsChanged((settings) => {
    state.settings = settings;
    renderAgentBadge();
  });
}

function bindEvents() {
  ui.currentAdd.addEventListener('click', addPageThread);
  ui.quickAdd.addEventListener('submit', (event) => {
    event.preventDefault();
    addPastedLinks();
  });

  ui.formats.addEventListener('change', (event) => {
    const input = /** @type {HTMLInputElement} */ (event.target);
    updateSettings({ formats: { ...state.settings.formats, [input.value]: input.checked } });
  });
  ui.optSort.addEventListener('change', () => updateSettings({ sort: /** @type {Settings['sort']} */ (ui.optSort.value) }));
  ui.optDelay.addEventListener('change', () => updateSettings({ delaySeconds: Number(ui.optDelay.value) }));
  ui.optExpand.addEventListener('change', () => updateSettings({ expandMore: ui.optExpand.checked }));
  ui.optUsernames.addEventListener('change', () => updateSettings({ includeUsernames: ui.optUsernames.checked }));

  ui.exportButton.addEventListener('click', () => openAndClose(isRunning() ? {} : { start: true }));
  $('open-overview').addEventListener('click', () => openAndClose());
  $('open-app').addEventListener('click', () => openAndClose());
  $('open-help').addEventListener('click', () => openAndClose({ help: true }));
  $('agent-toggle').addEventListener('click', () =>
    updateSettings({ agents: { ...state.settings.agents, enabled: !state.settings.agents.enabled } }),
  );
  // A file picker can't be opened from the popup reliably: the popup closes as soon as
  // the picker takes focus, and the file is lost. The overview page handles uploads.
  $('open-upload').addEventListener('click', () => openAndClose({ upload: true }));
}

/* ---- This page ---------------------------------------------------------- */

/** Offers the thread in the active tab. Tab URLs are only visible on Reddit, where the extension has access. */
async function detectPageThread() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const ref = tab?.url ? parseThreadLink(tab.url) : null;
  if (!ref || ref.kind !== 'thread') return;

  state.pageThread = ref;
  ui.currentTitle.textContent = cleanTabTitle(tab.title) || slugToTitle(ref.slug) || ref.url;
  ui.currentTitle.title = ui.currentTitle.textContent;
  fillAvatar(ui.currentAvatar, { subreddit: ref.subreddit });
  ui.current.hidden = false;
  renderPageThread();
}

function renderPageThread() {
  if (!state.pageThread) return;
  const queued = state.queue.some((item) => item.key === refKey(/** @type {ThreadRef} */ (state.pageThread)));
  ui.currentAdd.disabled = queued;
  ui.currentAddLabel.textContent = queued ? 'Added' : 'Add';
  setIcon(ui.currentAdd, queued ? 'i-check' : 'i-plus');
}

async function addPageThread() {
  if (!state.pageThread) return;
  await addToQueue([state.pageThread]);
}

/* ---- Quick add ---------------------------------------------------------- */

async function addPastedLinks() {
  const text = ui.quickInput.value;
  if (!text.trim()) {
    showAddStatus('error', 'Paste a Reddit thread link first.');
    ui.quickInput.focus();
    return;
  }
  const { refs, duplicates } = extractThreadLinks(
    text,
    state.queue.map((item) => item.key),
  );
  const { added } = await addToQueue(refs);
  if (added) {
    ui.quickInput.value = '';
    showAddStatus('success', `Added ${plural(added, 'thread')}${duplicates ? `, ${duplicates} already queued` : ''}.`);
  } else if (duplicates) {
    showAddStatus('error', 'Already in the queue.');
  } else {
    showAddStatus('error', 'No Reddit thread links found.');
  }
}

/**
 * @param {'success' | 'error'} tone
 * @param {string} message
 */
function showAddStatus(tone, message) {
  ui.addStatus.dataset.tone = tone;
  ui.addStatus.textContent = message;
}

/* ---- Settings ----------------------------------------------------------- */

function renderFormatChips() {
  ui.formats.append(
    ...EXPORT_FORMATS.map((format) => {
      const chip = document.createElement('label');
      chip.className = 'chip';
      chip.title = format.description;
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = format.id;
      const check = document.createElement('span');
      check.className = 'chip-check';
      check.append(createIcon('i-check'));
      chip.append(input, check, document.createTextNode(format.shortLabel));
      return chip;
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
  ui.optExpand.checked = settings.expandMore;
  ui.optUsernames.checked = settings.includeUsernames;
}

/** @param {Partial<Settings>} patch */
async function updateSettings(patch) {
  state.settings = await saveSettings(patch);
  renderQueueState();
}

/* ---- Queue state and the Export button ---------------------------------- */

function isRunning() {
  return state.run.state !== 'idle';
}

function renderQueueState() {
  const counts = { waiting: 0, done: 0, failed: 0 };
  for (const item of state.queue) {
    if (item.status === 'done') counts.done += 1;
    else if (item.status === 'failed') counts.failed += 1;
    else counts.waiting += 1;
  }
  ui.statWaiting.textContent = counts.waiting.toLocaleString();
  ui.statDone.textContent = counts.done.toLocaleString();
  ui.statFailed.textContent = counts.failed.toLocaleString();
  ui.statFailedItem.dataset.tone = counts.failed ? 'danger' : '';
  ui.statDoneItem.dataset.tone = counts.done ? 'success' : '';

  // Progress of a running export: yours, or an agent's
  const running = isRunning();
  const agentRunning = state.agentRun.state !== 'idle';
  const shown = running ? state.run : agentRunning ? state.agentRun : null;
  ui.run.hidden = !shown;
  if (shown) {
    const { finished, total, current } = shown;
    const percent = total ? Math.round((finished / total) * 100) : 0;
    const who = running ? '' : `${shown.client ?? 'Agent'}: `;
    const verb = shown.state === 'paused' ? 'Paused' : shown.state === 'stopping' ? 'Stopping' : 'Exporting';
    ui.runTitle.textContent = `${who}${verb} ${finished} of ${total}${current ? ` · ${current}` : ''}`;
    ui.runProgress.setAttribute('aria-valuenow', String(percent));
    ui.runBar.style.width = `${percent}%`;
  }

  // Export button: always says why it can't be used
  const pending = counts.waiting + counts.failed;
  const formatsChosen = Object.values(state.settings.formats ?? {}).some(Boolean);
  ui.exportButton.disabled = !running && (agentRunning || pending === 0 || !formatsChosen);
  ui.exportLabel.textContent = running ? 'Show progress' : pending ? `Export ${plural(pending, 'thread')}` : 'Export';
  ui.exportHint.textContent = describeExportHint({ running, agentRunning, formatsChosen, pending, done: counts.done });

  renderPageThread();
  renderAgentBadge();
}

/**
 * Says why Export can't be pressed, if it can't.
 *
 * @param {{ running: boolean, agentRunning: boolean, formatsChosen: boolean, pending: number, done: number }} state
 */
function describeExportHint({ running, agentRunning, formatsChosen, pending, done }) {
  if (running) return '';
  if (agentRunning) return "An agent is exporting. You can start once it's done.";
  if (!formatsChosen) return 'Choose at least one format.';
  if (pending === 0) return done ? 'Everything is exported. Open the overview to download.' : 'Add a thread to start.';
  return '';
}

/** The one-click agent switch next to the name, showing off, on, connected or working. */
function renderAgentBadge() {
  const toggle = /** @type {HTMLElement} */ (document.getElementById('agent-toggle'));
  const label = /** @type {HTMLElement} */ (document.getElementById('agent-toggle-label'));
  const enabled = Boolean(state.settings.agents?.enabled);
  const busy = enabled && state.agentRun.state !== 'idle';
  const connected = enabled && state.agentConnection.state === 'connected';

  toggle.setAttribute('aria-pressed', String(enabled));
  toggle.dataset.state = busy ? 'busy' : connected ? 'connected' : enabled ? 'on' : 'off';
  label.textContent = busy ? 'AI working' : connected ? 'Connected' : enabled ? 'Agents on' : 'Agents off';
  toggle.setAttribute('aria-label', `Agent access: ${label.textContent}. Click to turn ${enabled ? 'off' : 'on'}.`);
}

/**
 * Opens (or focuses) the exporter page, then closes the popup.
 *
 * @param {import('../lib/app-tab.js').AppCommand} [command]
 */
async function openAndClose(command = {}) {
  await openApp(command);
  window.close();
}
