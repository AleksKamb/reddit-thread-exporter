/**
 * Bridge protocol.
 *
 * Constants, the error type and small helpers shared by the hub, its agent clients
 * and the tools. The message shapes are documented in docs/AGENTS.md ("Bridge protocol").
 *
 * @module protocol
 */

import { clearTimeout, setTimeout } from 'node:timers';
import WebSocket from 'ws';

export const DEFAULT_PORT = 39317;

/** The extension's ID when installed from the Chrome Web Store. */
export const DEFAULT_EXTENSION_ID = 'jjgnebbldngnhpdglbfiddkocigddhlb';

/** Raw thread responses with hidden replies can be several MB each, and a request can hold 25 of them. */
export const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;

/**
 * A safety net, not a pace: a 25-thread export with batch pauses and an approval
 * prompt takes minutes, so only a request the extension has lost should get here.
 */
export const REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

/** Error codes produced by the bridge itself. Everything else comes from the extension. */
export const HUB_ERRORS = /** @type {const} */ ({
  NOT_CONNECTED: 'EXTENSION_NOT_CONNECTED',
  DISCONNECTED: 'EXTENSION_DISCONNECTED',
  TIMEOUT: 'TIMEOUT',
  BAD_REQUEST: 'BAD_REQUEST',
});

/**
 * @typedef {{ ok: true, result: unknown } | { ok: false, error: { code: string, message: string } }} BridgeResponse
 */

/**
 * @typedef {object} ProgressMessage
 * @property {string} [message]  Human-readable progress, for example "Exported 3 of 10".
 * @property {number} [done]
 * @property {number} [total]
 */

/**
 * @typedef {object} RequestOptions
 * @property {(progress: ProgressMessage) => void} [onProgress]
 */

/**
 * @typedef {object} BridgeStatus
 * @property {boolean} extensionConnected
 * @property {string | null} extensionVersion
 * @property {number} agents  Agent sessions sharing the hub, this one included.
 */

/** An error with a protocol code, from the extension or from the bridge. */
export class BridgeError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

/**
 * @param {string} code
 * @param {string} message
 * @returns {BridgeResponse}
 */
export function errorResponse(code, message) {
  return { ok: false, error: { code, message } };
}

/**
 * Settles a promise with a response: the result, or a {@link BridgeError}.
 *
 * @param {(value: unknown) => void} resolve
 * @param {(error: BridgeError) => void} reject
 * @returns {(response: BridgeResponse) => void}
 */
export function settlePromise(resolve, reject) {
  return (response) => {
    if (response.ok) resolve(response.result);
    else reject(new BridgeError(response.error.code, response.error.message));
  };
}

/**
 * Reads the documented fields of a `progress` message and drops everything else,
 * so nothing unexpected is passed on.
 *
 * @param {Record<string, any>} message
 * @returns {ProgressMessage}
 */
export function toProgress({ message, done, total }) {
  return {
    ...(typeof message === 'string' && { message }),
    ...(Number.isFinite(done) && { done }),
    ...(Number.isFinite(total) && { total }),
  };
}

/**
 * Reads a `response` message. Anything that is not clearly a success is an error.
 *
 * @param {Record<string, any>} message
 * @returns {BridgeResponse}
 */
export function toResponse({ ok, result, error }) {
  if (ok === true) return { ok: true, result };
  return errorResponse(String(error?.code ?? 'INTERNAL'), String(error?.message ?? 'The extension reported an error.'));
}

/**
 * Parses one WebSocket message. Anything that is not a JSON object is `null`.
 *
 * @param {import('ws').RawData} data
 * @returns {Record<string, any> | null}
 */
export function parseMessage(data) {
  try {
    const message = JSON.parse(data.toString());
    return message && typeof message === 'object' && !Array.isArray(message) ? message : null;
  } catch {
    return null;
  }
}

/**
 * Sends a message if the socket is still open. Messages to a closed socket are
 * dropped on purpose: the other side is gone and has nothing to receive them.
 *
 * @param {WebSocket} ws
 * @param {object} message
 * @returns {boolean} Whether the message was sent.
 */
export function sendMessage(ws, message) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(message));
  return true;
}

/**
 * @param {unknown} id
 * @returns {id is string | number}
 */
export function isRequestId(id) {
  return (typeof id === 'string' && id.length > 0 && id.length <= 200) || Number.isSafeInteger(id);
}

/**
 * @typedef {object} PendingHandlers
 * @property {(progress: ProgressMessage) => void} [onProgress]
 * @property {(response: BridgeResponse) => void} onResponse  Called exactly once.
 */

/**
 * Requests waiting for a response, each with a timeout. Every request ends in exactly
 * one `onResponse` call: the real response, a timeout, or a disconnect.
 */
export class PendingRequests {
  /** @type {Map<string | number, PendingHandlers & { timer: ReturnType<typeof setTimeout>, tag?: unknown }>} */
  #entries = new Map();
  #timeoutMs;

  /** @param {number} [timeoutMs] */
  constructor(timeoutMs = REQUEST_TIMEOUT_MS) {
    this.#timeoutMs = timeoutMs;
  }

  get size() {
    return this.#entries.size;
  }

  /**
   * @param {string | number} id
   * @param {PendingHandlers} handlers
   * @param {unknown} [tag]  Groups requests, for example by the socket they were sent to.
   */
  add(id, handlers, tag) {
    const timer = setTimeout(() => {
      const minutes = Math.round(this.#timeoutMs / 60_000);
      this.settle(id, errorResponse(HUB_ERRORS.TIMEOUT, `The extension did not answer within ${minutes} minutes.`));
    }, this.#timeoutMs);
    // A forgotten request must never keep the process alive.
    timer.unref();
    this.#entries.set(id, { ...handlers, timer, tag });
  }

  /**
   * @param {string | number} id
   * @param {ProgressMessage} progress
   */
  progress(id, progress) {
    this.#entries.get(id)?.onProgress?.(progress);
  }

  /**
   * @param {string | number} id
   * @param {BridgeResponse} response
   * @returns {boolean} `false` when nothing was waiting for this ID.
   */
  settle(id, response) {
    const entry = this.#entries.get(id);
    if (!entry) return false;
    this.#entries.delete(id);
    clearTimeout(entry.timer);
    entry.onResponse(response);
    return true;
  }

  /**
   * Ends every request with the given tag, or all requests when `tag` is omitted.
   *
   * @param {BridgeResponse} response
   * @param {unknown} [tag]
   */
  settleAll(response, tag) {
    for (const [id, entry] of [...this.#entries]) {
      if (tag === undefined || entry.tag === tag) this.settle(id, response);
    }
  }
}
