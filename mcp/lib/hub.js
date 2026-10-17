/**
 * The hub: a WebSocket server on 127.0.0.1 that the extension and other agent
 * sessions connect to.
 *
 * The extension connects with `?role=extension`, other MCP server processes with
 * `?role=agent`. The hub forwards every request to the extension under a hub-unique
 * ID and routes progress and the response back to whoever asked: its own agent
 * session (in-process) or a connected agent client.
 *
 * @module hub
 */

import http from 'node:http';
import { URL } from 'node:url';
import { WebSocketServer } from 'ws';

import {
  HUB_ERRORS,
  MAX_PAYLOAD_BYTES,
  PendingRequests,
  REQUEST_TIMEOUT_MS,
  errorResponse,
  isRequestId,
  parseMessage,
  sendMessage,
  settlePromise,
  toProgress,
  toResponse,
} from './protocol.js';

/** @typedef {import('ws').WebSocket} WebSocket */
/** @typedef {import('./protocol.js').BridgeResponse} BridgeResponse */
/** @typedef {import('./protocol.js').BridgeStatus} BridgeStatus */
/** @typedef {import('./protocol.js').RequestOptions} RequestOptions */

/**
 * @typedef {{ role: 'extension' | 'agent' } | { status: number, reason: string }} ConnectionVerdict
 */

/** Close code sent to an extension connection that a newer one replaced. */
const CLOSE_REPLACED = 4001;
const MAX_NAME_LENGTH = 64;

/**
 * Decides whether a WebSocket upgrade may connect, and in which role.
 *
 * - The `Host` header must name the loopback port, which stops DNS-rebinding pages.
 * - The extension must send its `chrome-extension://` origin.
 * - Agents must send no `Origin` at all: browsers always send one, local processes don't.
 *
 * @param {{ url?: string, headers: Record<string, string | string[] | undefined> }} request
 * @param {{ port: number, extensionIds: string[] }} options
 * @returns {ConnectionVerdict}
 */
export function checkConnection({ url = '', headers }, { port, extensionIds }) {
  const host = String(headers.host ?? '').toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    return { status: 403, reason: `unexpected Host header "${host}"` };
  }

  let target;
  try {
    target = new URL(url, `http://127.0.0.1:${port}`);
  } catch {
    return { status: 400, reason: 'malformed request URL' };
  }
  if (target.pathname !== '/') return { status: 404, reason: `unknown path ${target.pathname}` };

  const role = target.searchParams.get('role');
  const origin = headers.origin;
  if (role === 'extension') {
    const allowed = extensionIds.some((id) => origin === `chrome-extension://${id}`);
    return allowed ? { role } : { status: 403, reason: `extension origin "${origin ?? ''}" is not accepted` };
  }
  if (role === 'agent') {
    return origin === undefined ? { role } : { status: 403, reason: 'agents must not send an Origin header' };
  }
  return { status: 400, reason: 'missing or unknown role' };
}

export class Hub {
  #port;
  #extensionIds;
  #log;
  #http = http.createServer((_, response) => response.writeHead(404).end());
  #wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  #pending;
  #nextId = 1;

  /** @type {WebSocket | null} */
  #extension = null;
  /** @type {string | null} */
  #extensionVersion = null;
  /** @type {Map<WebSocket, { name: string, connectedAt: number }>} */
  #agents = new Map();
  /** The agent session in this process, which uses the hub without a socket. */
  #self;

  /**
   * @param {object} options
   * @param {number} options.port            0 picks a free port (tests).
   * @param {string[]} options.extensionIds  Extension IDs allowed to connect as `role=extension`.
   * @param {string} options.name            This agent session's name, shown in the extension.
   * @param {(message: string) => void} options.log
   * @param {number} [options.requestTimeoutMs]
   */
  constructor({ port, extensionIds, name, log, requestTimeoutMs = REQUEST_TIMEOUT_MS }) {
    this.#port = port;
    this.#extensionIds = extensionIds;
    this.#log = log;
    this.#pending = new PendingRequests(requestTimeoutMs);
    this.#self = { name, connectedAt: Date.now() };
    this.#http.on('upgrade', (request, socket, head) => this.#onUpgrade(request, socket, head));
  }

  /** The port the hub listens on (useful after listening on port 0). */
  get port() {
    return this.#port;
  }

  /**
   * Starts listening on 127.0.0.1. Rejects with the `listen` error, so the caller
   * can tell `EADDRINUSE` (another session is the hub) from real problems.
   *
   * @returns {Promise<void>}
   */
  listen() {
    return new Promise((resolve, reject) => {
      this.#http.once('error', reject);
      this.#http.listen(this.#port, '127.0.0.1', () => {
        this.#http.off('error', reject);
        this.#http.on('error', (error) => this.#log(`Hub error: ${error.message}`));
        this.#port = /** @type {import('node:net').AddressInfo} */ (this.#http.address()).port;
        resolve();
      });
    });
  }

  /**
   * Sends a request to the extension on behalf of this process's agent session.
   *
   * @param {string} method
   * @param {object} [params]
   * @param {RequestOptions} [options]
   * @returns {Promise<unknown>}  The extension's `result`; rejects with a `BridgeError`.
   */
  request(method, params, { onProgress } = {}) {
    return new Promise((resolve, reject) => {
      this.#forward(method, params, this.#self.name, { onProgress, onResponse: settlePromise(resolve, reject) });
    });
  }

  /** @returns {BridgeStatus} */
  status() {
    return {
      extensionConnected: this.#extension !== null,
      extensionVersion: this.#extensionVersion,
      agents: this.#agents.size + 1,
    };
  }

  /** @param {string} name */
  setName(name) {
    this.#self.name = cleanName(name, this.#self.name);
    this.#sendClients();
  }

  /**
   * Stops listening and drops every connection. Requests still waiting get
   * `EXTENSION_DISCONNECTED`, because nobody will deliver their response now.
   *
   * @returns {Promise<void>}
   */
  close() {
    this.#pending.settleAll(errorResponse(HUB_ERRORS.DISCONNECTED, 'The bridge shut down before the extension answered.'));
    for (const ws of this.#wss.clients) ws.terminate();
    this.#wss.close();
    return new Promise((resolve) => {
      if (!this.#http.listening) return resolve();
      this.#http.close(() => resolve());
      this.#http.closeAllConnections();
    });
  }

  /* ---------------------------------------------------------------------- */

  /**
   * @param {http.IncomingMessage} request
   * @param {import('node:stream').Duplex} socket
   * @param {Buffer} head
   */
  #onUpgrade(request, socket, head) {
    socket.on('error', () => socket.destroy());
    const verdict = checkConnection(request, { port: this.#port, extensionIds: this.#extensionIds });
    if ('status' in verdict) {
      this.#log(`Refused a connection: ${verdict.reason}.`);
      socket.end(`HTTP/1.1 ${verdict.status} ${http.STATUS_CODES[verdict.status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    this.#wss.handleUpgrade(request, socket, head, (ws) => {
      ws.on('error', (error) => this.#log(`Connection error (${verdict.role}): ${error.message}`));
      if (verdict.role === 'extension') this.#acceptExtension(ws);
      else this.#acceptAgent(ws);
    });
  }

  /** @param {WebSocket} ws */
  #acceptExtension(ws) {
    const previous = this.#extension;
    this.#extension = ws;
    this.#extensionVersion = null;
    if (previous) {
      // Chrome restarts service workers; the newest connection is the live one.
      this.#dropExtension(previous);
      previous.close(CLOSE_REPLACED, 'Replaced by a newer connection');
    }
    this.#log('Extension connected.');

    ws.on('message', (data) => this.#onExtensionMessage(ws, data));
    ws.on('close', () => this.#dropExtension(ws));
    // Tell the extension right away who is connected, so its Agent access card is current.
    this.#sendClients();
  }

  /** @param {WebSocket} ws */
  #dropExtension(ws) {
    this.#pending.settleAll(
      errorResponse(HUB_ERRORS.DISCONNECTED, 'The extension disconnected before it finished this request.'),
      ws,
    );
    if (this.#extension !== ws) return;
    this.#extension = null;
    this.#extensionVersion = null;
    this.#log('Extension disconnected.');
  }

  /**
   * @param {WebSocket} ws
   * @param {import('ws').RawData} data
   */
  #onExtensionMessage(ws, data) {
    const message = parseMessage(data);
    if (!message) return this.#log('Ignored a malformed message from the extension.');
    if (ws !== this.#extension) return;

    switch (message.type) {
      case 'hello':
        this.#extensionVersion = typeof message.version === 'string' ? message.version : null;
        break;
      case 'ping':
        sendMessage(ws, { type: 'pong' });
        break;
      case 'progress':
        this.#pending.progress(message.id, toProgress(message));
        break;
      case 'response':
        this.#pending.settle(message.id, toResponse(message));
        break;
      default:
        this.#log(`Ignored an extension message of type "${message.type}".`);
    }
  }

  /** @param {WebSocket} ws */
  #acceptAgent(ws) {
    this.#agents.set(ws, { name: 'agent', connectedAt: Date.now() });
    ws.on('message', (data) => this.#onAgentMessage(ws, data));
    ws.on('close', () => {
      this.#agents.delete(ws);
      this.#sendClients();
    });
  }

  /**
   * @param {WebSocket} ws
   * @param {import('ws').RawData} data
   */
  #onAgentMessage(ws, data) {
    const message = parseMessage(data);
    const agent = this.#agents.get(ws);
    if (!message) return this.#log('Ignored a malformed message from an agent client.');
    if (!agent) return;

    switch (message.type) {
      case 'hello':
        agent.name = cleanName(message.name, agent.name);
        this.#sendClients();
        break;
      case 'ping':
        sendMessage(ws, { type: 'pong' });
        break;
      case 'status':
        sendMessage(ws, { type: 'status', ...this.status() });
        break;
      case 'request':
        this.#forwardFromAgent(ws, agent.name, message);
        break;
      default:
        this.#log(`Ignored an agent message of type "${message.type}".`);
    }
  }

  /**
   * @param {WebSocket} ws
   * @param {string} name
   * @param {Record<string, any>} message
   */
  #forwardFromAgent(ws, name, { id, method, params }) {
    if (!isRequestId(id)) return this.#log('Ignored an agent request without a valid id.');
    const reply = (/** @type {BridgeResponse} */ response) => sendMessage(ws, { type: 'response', id, ...response });
    if (typeof method !== 'string' || !method) {
      reply(errorResponse(HUB_ERRORS.BAD_REQUEST, 'The request has no method.'));
      return;
    }
    this.#forward(method, params, name, {
      onProgress: (progress) => sendMessage(ws, { type: 'progress', id, ...progress }),
      onResponse: reply,
    });
  }

  /**
   * Sends a request to the extension and tracks it under a hub-unique ID, because
   * several agent clients may use the same IDs.
   *
   * @param {string} method
   * @param {unknown} params
   * @param {string} clientName
   * @param {import('./protocol.js').PendingHandlers} handlers
   */
  #forward(method, params, clientName, handlers) {
    const extension = this.#extension;
    if (!extension) {
      handlers.onResponse(
        errorResponse(HUB_ERRORS.NOT_CONNECTED, 'The Thread Exporter extension is not connected to the local bridge.'),
      );
      return;
    }
    const id = `h-${this.#nextId++}`;
    this.#pending.add(id, handlers, extension);
    sendMessage(extension, { type: 'request', id, method, params: params ?? {}, client: { name: clientName } });
  }

  #sendClients() {
    if (!this.#extension) return;
    const agents = [this.#self, ...this.#agents.values()].map(({ name, connectedAt }) => ({ name, connectedAt }));
    sendMessage(this.#extension, { type: 'clients', agents });
  }
}

/**
 * @param {unknown} name
 * @param {string} fallback
 */
function cleanName(name, fallback) {
  const cleaned = typeof name === 'string' ? name.replace(/[\p{C}]/gu, '').trim().slice(0, MAX_NAME_LENGTH) : '';
  return cleaned || fallback;
}
