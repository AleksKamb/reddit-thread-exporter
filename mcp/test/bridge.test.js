import assert from 'node:assert/strict';
import http from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { Bridge } from '../lib/bridge.js';
import { EXTENSION_ID, Sockets, eventually, getFreePort, send } from './helpers.js';

/**
 * @param {number} port
 * @param {string} name
 * @param {object} [options]
 */
function createBridge(port, name, options = {}) {
  return new Bridge({ port, extensionIds: [EXTENSION_ID], name, log: () => {}, retryDelayMs: [10, 30], ...options });
}

describe('Bridge', { timeout: 15_000 }, () => {
  let port = 0;
  /** @type {Bridge[]} */
  let bridges = [];
  /** @type {Sockets} */
  let sockets;

  beforeEach(async () => {
    port = await getFreePort();
    bridges = [];
    sockets = new Sockets(() => port);
  });

  afterEach(async () => {
    sockets.closeAll();
    await Promise.all(bridges.map((bridge) => bridge.close()));
  });

  /** @param {string} name @param {object} [options] */
  async function start(name, options) {
    const bridge = createBridge(port, name, options);
    bridges.push(bridge);
    await bridge.start();
    return bridge;
  }

  it('makes the first session the hub and the next one its client', async () => {
    const first = await start('session-a');
    const second = await start('session-b');
    assert.equal(first.role, 'hub');
    assert.equal(second.role, 'client');

    const extension = await sockets.extension();
    const clients = await extension.inbox.next('clients');
    assert.deepEqual(clients.agents.map((agent) => agent.name).sort(), ['session-a', 'session-b']);
  });

  it('routes a client session request through the hub, with progress', async () => {
    await start('session-a');
    const second = await start('session-b');
    const extension = await sockets.extension();

    const progress = [];
    const pending = second.request('export_threads', { links: ['https://redd.it/abc123'] }, { onProgress: (p) => progress.push(p) });
    const request = await extension.inbox.next('request');
    assert.deepEqual(request.client, { name: 'session-b' });
    assert.deepEqual(request.params, { links: ['https://redd.it/abc123'] });

    send(extension.ws, { type: 'progress', id: request.id, message: 'Exported 1 of 1', done: 1, total: 1 });
    send(extension.ws, { type: 'response', id: request.id, ok: true, result: { threads: [], notThreads: [], duplicates: 0 } });

    assert.deepEqual(await pending, { threads: [], notThreads: [], duplicates: 0 });
    assert.deepEqual(progress, [{ message: 'Exported 1 of 1', done: 1, total: 1 }]);
  });

  it('reports status in both roles', async () => {
    const first = await start('session-a');
    const second = await start('session-b');
    assert.equal((await second.status()).extensionConnected, false);

    const extension = await sockets.extension({ version: '1.3.0' });
    // Messages are handled in order, so the pong means the hub has read the hello.
    send(extension.ws, { type: 'ping' });
    await extension.inbox.next('pong');
    const expected = { port, extensionConnected: true, extensionVersion: '1.3.0', agents: 2 };
    assert.deepEqual(await first.status(), { role: 'hub', ...expected });
    assert.deepEqual(await second.status(), { role: 'client', ...expected });
  });

  it('passes EXTENSION_NOT_CONNECTED through to client sessions', async () => {
    await start('session-a');
    const second = await start('session-b');
    await assert.rejects(second.request('status'), { code: 'EXTENSION_NOT_CONNECTED' });
  });

  it('renames a session once the MCP client says who it is', async () => {
    await start('claude-code');
    const second = await start('claude-code');
    const extension = await sockets.extension();
    await extension.inbox.next('clients');

    second.setName('cursor');
    const clients = await extension.inbox.next('clients');
    assert.deepEqual(clients.agents.map((agent) => agent.name), ['claude-code', 'cursor']);
  });

  it('keeps a name given while the session is still connecting', async () => {
    await start('claude-code');
    const second = createBridge(port, 'claude-code');
    bridges.push(second);
    const started = second.start();
    second.setName('cursor');
    await started;

    const extension = await sockets.extension();
    let clients = await extension.inbox.next('clients');
    // The rename may arrive as a second update, depending on timing.
    if (!clients.agents.some((agent) => agent.name === 'cursor')) clients = await extension.inbox.next('clients');
    assert.deepEqual(clients.agents.map((agent) => agent.name), ['claude-code', 'cursor']);
  });

  it('takes over the port when the hub session ends', async () => {
    const first = await start('session-a');
    const second = await start('session-b');
    const extension = await sockets.extension();

    const lost = assert.rejects(second.request('get_queue'), { code: 'EXTENSION_DISCONNECTED' });
    await extension.inbox.next('request');
    await first.close();
    await lost;

    await eventually(() => second.role === 'hub', 'the client to become the hub');

    // The extension reconnects to the new hub and requests flow again.
    const reconnected = await sockets.extension();
    const pending = second.request('get_queue');
    const request = await reconnected.inbox.next('request');
    send(reconnected.ws, { type: 'response', id: request.id, ok: true, result: { items: [] } });
    assert.deepEqual(await pending, { items: [] });
  });

  it('stays offline, and says so, when another program holds the port', async () => {
    const squatter = http.createServer((_, response) => response.end('not a bridge'));
    await new Promise((resolve) => squatter.listen(port, '127.0.0.1', resolve));
    try {
      const bridge = await start('session-a', { connectWaitMs: 50 });
      assert.equal(bridge.role, 'offline');
      assert.equal((await bridge.status()).role, 'offline');
      await assert.rejects(bridge.request('status'), { code: 'EXTENSION_NOT_CONNECTED' });
    } finally {
      await new Promise((resolve) => squatter.close(resolve));
    }
  });
});
