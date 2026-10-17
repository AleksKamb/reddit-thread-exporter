/**
 * Approval window: shown before an agent export when "Ask before each agent export" is on.
 * The request details come from chrome.storage.session; the decision goes back to the
 * background worker (agent-jobs.js), which closes this window.
 */

import { parseThreadLink, slugToTitle } from '../lib/reddit-links.js';
import { getSettings } from '../lib/store.js';
import { applyTheme, plural } from '../shared/ui.js';

const APPROVAL_MESSAGE = 'thread-exporter/approval';
const APPROVALS_KEY = 'agentApprovals';

const id = new URLSearchParams(location.search).get('id') ?? '';
const summary = /** @type {HTMLElement} */ (document.getElementById('approve-summary'));
const list = /** @type {HTMLElement} */ (document.getElementById('approve-list'));
const timer = /** @type {HTMLElement} */ (document.getElementById('approve-timer'));
const allow = /** @type {HTMLButtonElement} */ (document.getElementById('allow'));
const deny = /** @type {HTMLButtonElement} */ (document.getElementById('deny'));

init();

async function init() {
  applyTheme((await getSettings()).theme);
  const { [APPROVALS_KEY]: approvals = {} } = await chrome.storage.session.get(APPROVALS_KEY);
  const request = approvals[id];
  if (!request) {
    summary.textContent = 'This request has expired.';
    allow.disabled = true;
    return;
  }

  summary.textContent = `${request.client} asks to fetch ${plural(request.count, 'thread')} from Reddit with your browser.`;
  list.replaceChildren(...request.links.map(renderLink));
  startCountdown(request.expiresAt);

  allow.addEventListener('click', () => decide('allow'));
  deny.addEventListener('click', () => decide('deny'));
  allow.focus();
}

/** @param {string} link */
function renderLink(link) {
  const ref = parseThreadLink(link);
  const item = document.createElement('li');
  item.textContent = slugToTitle(ref?.slug ?? null) || link;
  if (ref?.subreddit) {
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = `r/${ref.subreddit}`;
    item.append(sub);
  }
  return item;
}

/** @param {number} expiresAt */
function startCountdown(expiresAt) {
  const tick = () => {
    const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    timer.textContent = `Denied automatically in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}.`;
  };
  tick();
  setInterval(tick, 1000);
}

/** @param {'allow' | 'deny'} decision */
function decide(decision) {
  allow.disabled = true;
  deny.disabled = true;
  chrome.runtime.sendMessage({ type: APPROVAL_MESSAGE, id, decision });
}
