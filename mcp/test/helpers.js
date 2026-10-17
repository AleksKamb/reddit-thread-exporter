/**
 * Test helpers: free ports, WebSocket clients playing the extension or an agent,
 * and an inbox to await the messages they receive.
 */

import net from 'node:net';
import { clearTimeout, setTimeout } from 'node:timers';
import WebSocket from 'ws';

export const EXTENSION_ID = 'jjgnebbldngnhpdglbfiddkocigddhlb';
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const WAIT_MS = 2000;

/** A port nothing listens on right now. */
export function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {net.AddressInfo} */ (server.address());
      server.close(() => resolve(port));
    });
  });
}

/** Collects JSON messages from a socket so tests can wait for one of a given type. */
export class Inbox {
  /** @type {Record<string, any>[]} */
  #messages = [];
  /** @type {Set<() => void>} */
  #waiters = new Set();

  /** @param {WebSocket} ws */
  constructor(ws) {
    ws.on('message', (data) => {
      this.#messages.push(JSON.parse(data.toString()));
      for (const check of [...this.#waiters]) check();
    });
  }

  /**
   * Resolves with the oldest unread message of this type.
   *
   * @param {string} type
   * @returns {Promise<Record<string, any>>}
   */
  next(type) {
    return new Promise((resolve, reject) => {
      const take = () => {
        const index = this.#messages.findIndex((message) => message.type === type);
        if (index === -1) return false;
        resolve(this.#messages.splice(index, 1)[0]);
        return true;
      };
      if (take()) return;
      const check = () => {
        if (!take()) return;
        clearTimeout(timer);
        this.#waiters.delete(check);
      };
      const timer = setTimeout(() => {
        this.#waiters.delete(check);
        reject(new Error(`No "${type}" message arrived.`));
      }, WAIT_MS);
      this.#waiters.add(check);
    });
  }
}

/**
 * Opens WebSocket connections to a hub and closes them all at the end of a test.
 */
export class Sockets {
  /** @type {WebSocket[]} */
  #open = [];

  /** @param {() => number} port  Read lazily, because hubs on port 0 learn theirs on listen. */
  constructor(port) {
    this.port = port;
  }

  /**
   * @param {object} options
   * @param {'extension' | 'agent' | string} [options.role]
   * @param {string} [options.origin]
   * @param {string} [options.host]
   * @param {string} [options.path]
   */
  #create({ role, origin, host, path = '/' }) {
    const query = role ? `?role=${role}` : '';
    const ws = new WebSocket(`ws://127.0.0.1:${this.port()}${path}${query}`, {
      ...(origin && { origin }),
      ...(host && { headers: { host } }),
    });
    this.#open.push(ws);
    return ws;
  }

  /**
   * Connects and resolves once the connection is open.
   *
   * @param {Parameters<Sockets['connect']>[0]} [options]
   * @returns {Promise<{ ws: WebSocket, inbox: Inbox }>}
   */
  connect(options = {}) {
    const ws = this.#create(options);
    const inbox = new Inbox(ws);
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve({ ws, inbox }));
      ws.once('error', reject);
    });
  }

  /** The fake extension: connects with the extension's origin and says hello. */
  async extension({ origin = EXTENSION_ORIGIN, version = '1.3.0' } = {}) {
    const connection = await this.connect({ role: 'extension', origin });
    connection.ws.send(JSON.stringify({ type: 'hello', role: 'extension', version }));
    return connection;
  }

  /** An agent client, as a second MCP server process would connect. */
  async agent(name = 'test-agent') {
    const connection = await this.connect({ role: 'agent' });
    connection.ws.send(JSON.stringify({ type: 'hello', role: 'agent', name }));
    return connection;
  }

  /**
   * Resolves with the HTTP status the hub refused the connection with.
   *
   * @param {Parameters<Sockets['connect']>[0]} options
   * @returns {Promise<number>}
   */
  refused(options) {
    const ws = this.#create(options);
    return new Promise((resolve, reject) => {
      ws.once('open', () => reject(new Error('The connection was accepted.')));
      ws.once('error', (error) => {
        const status = /Unexpected server response: (\d+)/.exec(error.message)?.[1];
        if (status) resolve(Number(status));
        else reject(error);
      });
    });
  }

  closeAll() {
    for (const ws of this.#open) ws.terminate();
    this.#open = [];
  }
}

/**
 * @param {WebSocket} ws
 * @param {object} message
 */
export function send(ws, message) {
  ws.send(typeof message === 'string' ? message : JSON.stringify(message));
}

/**
 * Resolves with the close code once the socket closes.
 *
 * @param {WebSocket} ws
 * @returns {Promise<number>}
 */
export function closed(ws) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) resolve(1006);
    else ws.once('close', (code) => resolve(code));
  });
}

/**
 * Polls until `condition` is true, for state that changes in the background.
 *
 * @param {() => boolean} condition
 * @param {string} what  For the error message.
 */
export async function eventually(condition, what) {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
