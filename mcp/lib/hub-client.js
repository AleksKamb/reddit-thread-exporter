/**
 * Hub client: how a second MCP server process reaches the extension.
 *
 * Only one process can own the port, so every other agent session connects to that
 * hub with `?role=agent` and sends its requests through it. Progress and responses
 * come back under the client's own request IDs.
 *
 * @module hub-client
 */

import { clearTimeout, setTimeout } from 'node:timers';
import WebSocket from 'ws';

import {
  HUB_ERRORS,
  MAX_PAYLOAD_BYTES,
  PendingRequests,
  REQUEST_TIMEOUT_MS,
  errorResponse,
  parseMessage,
  sendMessage,
  settlePromise,
  toProgress,
  toResponse,
} from './protocol.js';

/** @typedef {import('./protocol.js').BridgeStatus} BridgeStatus */
/** @typedef {import('./protocol.js').RequestOptions} RequestOptions */
/** @typedef {{ resolve: (status: BridgeStatus) => void, reject: (error: Error) => void, timer: ReturnType<typeof setTimeout> }} StatusWaiter */

/** Something that holds the port but never finishes the handshake is not our hub. */
const HANDSHAKE_TIMEOUT_MS = 3000;
const STATUS_TIMEOUT_MS = 5000;

export class HubClient {
  #port;
  #name;
  #log;
  #onClose;
  #pending;
  #nextId = 1;
  /** @type {WebSocket | null} */
  #ws = null;
  /**
   * `status` replies carry no ID; the hub answers in order, so a queue matches them up.
   *
   * @type {StatusWaiter[]}
   */
  #statusWaiters = [];

  /**
   * @param {object} options
   * @param {number} options.port
   * @param {string} options.name  This agent session's name, shown in the extension.
   * @param {(message: string) => void} options.log
   * @param {() => void} [options.onClose]  Called once when an open connection to the hub ends.
   * @param {number} [options.requestTimeoutMs]
   */
  constructor({ port, name, log, onClose = () => {}, requestTimeoutMs = REQUEST_TIMEOUT_MS }) {
    this.#port = port;
    this.#name = name;
    this.#log = log;
    this.#onClose = onClose;
    this.#pending = new PendingRequests(requestTimeoutMs);
  }

  /**
   * Connects to the hub and introduces this session. Rejects when nothing on the
   * port speaks the bridge protocol.
   *
   * @returns {Promise<void>}
   */
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.#port}/?role=agent`, {
        maxPayload: MAX_PAYLOAD_BYTES,
        handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      });
      ws.once('error', reject);
      ws.once('open', () => {
        ws.off('error', reject);
        this.#ws = ws;
        ws.on('error', (error) => this.#log(`Hub connection error: ${error.message}`));
        ws.on('message', (data) => this.#onMessage(data));
        ws.once('close', () => this.#onDisconnect());
        sendMessage(ws, { type: 'hello', role: 'agent', name: this.#name });
        resolve();
      });
    });
  }

  /**
   * @param {string} method
   * @param {object} [params]
   * @param {RequestOptions} [options]
   * @returns {Promise<unknown>}  The extension's `result`; rejects with a `BridgeError`.
   */
  request(method, params, { onProgress } = {}) {
    return new Promise((resolve, reject) => {
      const onResponse = settlePromise(resolve, reject);
      const id = `c-${this.#nextId++}`;
      if (!this.#ws || !sendMessage(this.#ws, { type: 'request', id, method, params: params ?? {} })) {
        onResponse(errorResponse(HUB_ERRORS.NOT_CONNECTED, 'Not connected to the local bridge.'));
        return;
      }
      this.#pending.add(id, { onProgress, onResponse });
    });
  }

  /** @returns {Promise<BridgeStatus>} */
  status() {
    return new Promise((resolve, reject) => {
      if (!this.#ws || !sendMessage(this.#ws, { type: 'status' })) {
        reject(new Error('Not connected to the local bridge.'));
        return;
      }
      /** @type {StatusWaiter} */
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => this.#failStatus(waiter, 'The bridge did not answer.'), STATUS_TIMEOUT_MS),
      };
      this.#statusWaiters.push(waiter);
    });
  }

  /**
   * Renames this session in the extension. Sending `hello` again is how the hub learns it.
   *
   * @param {string} name
   */
  setName(name) {
    this.#name = name;
    if (this.#ws) sendMessage(this.#ws, { type: 'hello', role: 'agent', name });
  }

  /** Closes the connection without calling `onClose`: leaving on purpose is not a failover. */
  close() {
    this.#onClose = () => {};
    this.#ws?.terminate();
  }

  /* ---------------------------------------------------------------------- */

  /** @param {import('ws').RawData} data */
  #onMessage(data) {
    const message = parseMessage(data);
    if (!message) return this.#log('Ignored a malformed message from the hub.');

    switch (message.type) {
      case 'progress':
        this.#pending.progress(message.id, toProgress(message));
        break;
      case 'response':
        this.#pending.settle(message.id, toResponse(message));
        break;
      case 'status': {
        const waiter = this.#statusWaiters.shift();
        if (!waiter) break;
        clearTimeout(waiter.timer);
        waiter.resolve({
          extensionConnected: message.extensionConnected === true,
          extensionVersion: typeof message.extensionVersion === 'string' ? message.extensionVersion : null,
          agents: Number(message.agents) || 0,
        });
        break;
      }
      case 'pong':
        break;
      default:
        this.#log(`Ignored a hub message of type "${message.type}".`);
    }
  }

  #onDisconnect() {
    this.#ws = null;
    // The hub process exited (its agent session ended). The extension may still be
    // working on these requests, but their responses went to the old hub and are lost.
    this.#pending.settleAll(
      errorResponse(HUB_ERRORS.DISCONNECTED, 'The local bridge closed before the extension answered.'),
    );
    for (const waiter of [...this.#statusWaiters]) this.#failStatus(waiter, 'The local bridge closed.');
    this.#onClose();
  }

  /**
   * @param {StatusWaiter} waiter
   * @param {string} message
   */
  #failStatus(waiter, message) {
    clearTimeout(waiter.timer);
    this.#statusWaiters = this.#statusWaiters.filter((other) => other !== waiter);
    waiter.reject(new Error(message));
  }
}
