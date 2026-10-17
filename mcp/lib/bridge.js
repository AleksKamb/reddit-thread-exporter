/**
 * Bridge: the one object the tools talk to.
 *
 * Several agent sessions can run at once, but only one process can listen on the
 * port. The first one becomes the {@link Hub}; the others connect to it as
 * {@link HubClient}s. When the hub's process exits, its clients wait a short random
 * time (so they don't all race at once) and try again: one of them becomes the new
 * hub, the rest connect to it. The tools see the same interface either way.
 *
 * @module bridge
 */

import { clearTimeout, setTimeout } from 'node:timers';

import { HubClient } from './hub-client.js';
import { Hub } from './hub.js';
import { BridgeError, DEFAULT_EXTENSION_ID, DEFAULT_PORT, HUB_ERRORS, REQUEST_TIMEOUT_MS } from './protocol.js';

/** @typedef {import('./protocol.js').BridgeStatus} BridgeStatus */
/** @typedef {import('./protocol.js').RequestOptions} RequestOptions */
/** @typedef {'hub' | 'client' | 'offline'} BridgeRole */

/**
 * @typedef {BridgeStatus & { role: BridgeRole, port: number }} BridgeState
 */

/** Retries back off up to this multiple of the base delay while the port stays unusable. */
const MAX_BACKOFF = 16;

export class Bridge {
  #port;
  #extensionIds;
  #name;
  #log;
  #requestTimeoutMs;
  #retryDelayMs;
  #connectWaitMs;

  /** @type {Hub | null} */
  #hub = null;
  /** @type {HubClient | null} */
  #client = null;
  /** @type {Promise<void> | null} */
  #started = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  #retryTimer = null;
  #failures = 0;
  #closed = false;
  /**
   * Callers waiting for the bridge to be hub or client again.
   *
   * @type {Set<() => void>}
   */
  #waiters = new Set();

  /**
   * @param {object} [options]
   * @param {number} [options.port]
   * @param {string[]} [options.extensionIds]
   * @param {string} [options.name]  This agent session's name, shown in the extension.
   * @param {(message: string) => void} [options.log]
   * @param {number} [options.requestTimeoutMs]
   * @param {[number, number]} [options.retryDelayMs]  Random delay range before taking over a lost hub.
   * @param {number} [options.connectWaitMs]  How long a request waits for a takeover to finish.
   */
  constructor({
    port = DEFAULT_PORT,
    extensionIds = [DEFAULT_EXTENSION_ID],
    name = 'claude-code',
    log = () => {},
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    retryDelayMs = [250, 1000],
    connectWaitMs = 5000,
  } = {}) {
    this.#port = port;
    this.#extensionIds = extensionIds;
    this.#name = name;
    this.#log = log;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#retryDelayMs = retryDelayMs;
    this.#connectWaitMs = connectWaitMs;
  }

  /** @returns {BridgeRole} */
  get role() {
    if (this.#hub) return 'hub';
    return this.#client ? 'client' : 'offline';
  }

  get port() {
    return this.#port;
  }

  /**
   * Becomes the hub, or a client of the existing one. Never rejects: if neither works
   * (the port belongs to another program), it keeps retrying in the background.
   *
   * @returns {Promise<void>} Settles after the first attempt.
   */
  start() {
    this.#started ??= this.#attempt();
    return this.#started;
  }

  /**
   * Sends a request to the extension.
   *
   * @param {string} method
   * @param {object} [params]
   * @param {RequestOptions} [options]
   * @returns {Promise<unknown>}  The extension's `result`; rejects with a `BridgeError`.
   */
  async request(method, params, options) {
    const target = await this.#connected();
    return target.request(method, params, options);
  }

  /**
   * Where this process stands and whether the extension is connected. Never rejects.
   *
   * @returns {Promise<BridgeState>}
   */
  async status() {
    const port = this.#port;
    try {
      if (this.#hub) return { role: 'hub', port, ...this.#hub.status() };
      if (this.#client) return { role: 'client', port, ...(await this.#client.status()) };
    } catch {
      // The hub went away while answering, so there is no bridge right now.
    }
    return { role: 'offline', port, extensionConnected: false, extensionVersion: null, agents: 0 };
  }

  /**
   * Updates the name shown in the extension, for example once the MCP client says who it is.
   *
   * @param {string} name
   */
  setName(name) {
    if (!name) return;
    this.#name = name;
    this.#hub?.setName(name);
    this.#client?.setName(name);
  }

  /** @returns {Promise<void>} */
  async close() {
    this.#closed = true;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    this.#notifyWaiters();
    this.#client?.close();
    this.#client = null;
    const hub = this.#hub;
    this.#hub = null;
    await hub?.close();
  }

  /* ---------------------------------------------------------------------- */

  async #attempt() {
    this.#retryTimer = null;
    if (this.#closed) return;

    if (await this.#tryHub()) return;
    if (await this.#tryClient()) return;

    this.#failures += 1;
    if (this.#failures === 1) {
      this.#log(`Could not open or join the bridge on port ${this.#port}; is another program using it? Retrying in the background.`);
    }
    this.#scheduleRetry();
  }

  /** @returns {Promise<boolean>} */
  async #tryHub() {
    const name = this.#name;
    const hub = new Hub({
      port: this.#port,
      extensionIds: this.#extensionIds,
      name,
      log: this.#log,
      requestTimeoutMs: this.#requestTimeoutMs,
    });
    try {
      await hub.listen();
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EADDRINUSE') {
        this.#log(`Could not listen on 127.0.0.1:${this.#port}: ${/** @type {Error} */ (error).message}`);
      }
      return false;
    }
    if (this.#closed) {
      await hub.close();
      return true;
    }
    this.#hub = hub;
    this.#port = hub.port;
    // The MCP client may have said who it is while the port was opening.
    if (this.#name !== name) hub.setName(this.#name);
    this.#connectedNow(`Listening on 127.0.0.1:${hub.port}. Waiting for the extension.`);
    return true;
  }

  /** @returns {Promise<boolean>} */
  async #tryClient() {
    const name = this.#name;
    const client = new HubClient({
      port: this.#port,
      name,
      log: this.#log,
      requestTimeoutMs: this.#requestTimeoutMs,
      onClose: () => this.#onHubLost(client),
    });
    try {
      await client.connect();
    } catch {
      return false;
    }
    if (this.#closed) {
      client.close();
      return true;
    }
    this.#client = client;
    if (this.#name !== name) client.setName(this.#name);
    this.#connectedNow(`Another agent session runs the bridge on port ${this.#port}; connected to it.`);
    return true;
  }

  /** @param {string} message */
  #connectedNow(message) {
    this.#failures = 0;
    this.#log(message);
    this.#notifyWaiters();
  }

  /** @param {HubClient} client */
  #onHubLost(client) {
    if (this.#client !== client) return;
    this.#client = null;
    if (this.#closed) return;
    this.#log('The agent session that ran the bridge has ended; reconnecting.');
    this.#scheduleRetry();
  }

  #scheduleRetry() {
    const [min, max] = this.#retryDelayMs;
    // A random delay keeps several orphaned clients from racing for the port at once.
    const delay = (min + Math.random() * (max - min)) * Math.min(2 ** this.#failures, MAX_BACKOFF);
    this.#retryTimer = setTimeout(() => this.#attempt(), delay);
    this.#retryTimer.unref();
  }

  /**
   * Waits briefly for a takeover in progress, so a tool call made right after the
   * hub's process exits doesn't fail for no reason.
   *
   * @returns {Promise<Hub | HubClient>}
   */
  async #connected() {
    await this.start();
    if (!this.#hub && !this.#client && !this.#closed) {
      await new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.#waiters.delete(done);
          resolve(undefined);
        };
        const timer = setTimeout(done, this.#connectWaitMs);
        this.#waiters.add(done);
      });
    }
    const target = this.#hub ?? this.#client;
    if (!target) {
      throw new BridgeError(
        HUB_ERRORS.NOT_CONNECTED,
        `The local bridge could not use port ${this.#port}; another program may be using it.`,
      );
    }
    return target;
  }

  #notifyWaiters() {
    for (const done of [...this.#waiters]) done();
  }
}
