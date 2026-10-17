/**
 * The extension's end of the MCP bridge.
 *
 * When the user allows agents, the background worker keeps a WebSocket open to the
 * local MCP server (ws://127.0.0.1:<port>). Requests that arrive there are handled by
 * agent-jobs.js and answered on the same socket. When no server is running, it
 * quietly retries: soon at first, then every 30 seconds, and once a minute via an alarm
 * in case Chrome put the worker to sleep.
 *
 * Runs in the background service worker. See docs/AGENTS.md for the protocol.
 *
 * @module agent-bridge
 */

import { handleAgentRequest } from './agent-jobs.js';
import { getSettings, OFF_CONNECTION, onSettingsChanged, setAgentConnection, setRunStatus, IDLE_RUN_STATUS } from './store.js';

/** @typedef {import('./store.js').AgentSettings} AgentSettings */

const PING_INTERVAL_MS = 20_000;
const FIRST_RETRY_MS = 2_000;
const MAX_RETRY_MS = 30_000;
const ALARM_NAME = 'agent-bridge-reconnect';

export class AgentBridge {
  /** @type {WebSocket | null} */
  #socket = null;
  /** @type {AgentSettings | null} */
  #settings = null;
  #retryDelay = FIRST_RETRY_MS;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #retryTimer;
  /** @type {ReturnType<typeof setInterval> | undefined} */
  #pingTimer;

  /** Starts following the "Allow agents" setting. Call once when the worker starts. */
  async start() {
    // A worker restart ends any agent job that was running.
    await setRunStatus(IDLE_RUN_STATUS, 'agent');
    onSettingsChanged((settings) => this.#apply(settings.agents));
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === ALARM_NAME) this.#ensureConnected();
    });
    this.#apply((await getSettings()).agents);
  }

  /** @param {AgentSettings} agents */
  #apply(agents) {
    const portChanged = this.#settings !== null && this.#settings.port !== agents.port;
    this.#settings = agents;

    if (!agents.enabled) {
      chrome.alarms.clear(ALARM_NAME);
      this.#disconnect();
      setAgentConnection(OFF_CONNECTION);
      return;
    }
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
    if (portChanged) this.#disconnect();
    this.#ensureConnected();
  }

  #ensureConnected() {
    if (!this.#settings?.enabled || this.#socket) return;
    clearTimeout(this.#retryTimer);
    setAgentConnection({ state: 'waiting', agents: [] });

    const socket = new WebSocket(`ws://127.0.0.1:${this.#settings.port}/?role=extension`);
    this.#socket = socket;

    socket.addEventListener('open', () => {
      this.#retryDelay = FIRST_RETRY_MS;
      this.#send({ type: 'hello', role: 'extension', version: chrome.runtime.getManifest().version });
      // Regular traffic also keeps Chrome from stopping the service worker.
      this.#pingTimer = setInterval(() => this.#send({ type: 'ping' }), PING_INTERVAL_MS);
      setAgentConnection({ state: 'connected', agents: [] });
    });
    socket.addEventListener('message', (event) => this.#onMessage(event.data));
    socket.addEventListener('close', () => {
      if (this.#socket !== socket) return;
      this.#cleanUp();
      if (!this.#settings?.enabled) return;
      setAgentConnection({ state: 'waiting', agents: [] });
      this.#retryTimer = setTimeout(() => this.#ensureConnected(), this.#retryDelay);
      this.#retryDelay = Math.min(this.#retryDelay * 2, MAX_RETRY_MS);
    });
  }

  /** @param {unknown} raw */
  #onMessage(raw) {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (message?.type === 'clients' && Array.isArray(message.agents)) {
      setAgentConnection({ state: 'connected', agents: message.agents.map((/** @type {any} */ agent) => String(agent?.name ?? 'agent')) });
    } else if (message?.type === 'request' && typeof message.id === 'string') {
      this.#answer(message);
    }
  }

  /**
   * @param {{ id: string, method: string, params?: unknown, client?: { name?: string } }} request
   */
  async #answer({ id, method, params, client }) {
    const context = {
      client: String(client?.name ?? 'agent').slice(0, 60),
      onProgress: (/** @type {string} */ message, /** @type {number} */ done, /** @type {number} */ total) =>
        this.#send({ type: 'progress', id, message, done, total }),
    };
    try {
      const result = await handleAgentRequest(String(method), params, context);
      this.#send({ type: 'response', id, ok: true, result });
    } catch (error) {
      const code = /** @type {any} */ (error)?.code ?? 'INTERNAL';
      const message = code === 'INTERNAL' ? `The extension hit an error: ${/** @type {Error} */ (error)?.message ?? error}` : /** @type {Error} */ (error).message;
      this.#send({ type: 'response', id, ok: false, error: { code, message } });
    }
  }

  /** @param {object} message */
  #send(message) {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(message));
  }

  #disconnect() {
    const socket = this.#socket;
    this.#cleanUp();
    socket?.close();
  }

  #cleanUp() {
    clearInterval(this.#pingTimer);
    clearTimeout(this.#retryTimer);
    this.#socket = null;
  }
}
