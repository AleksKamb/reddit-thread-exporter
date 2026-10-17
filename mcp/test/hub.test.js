import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { Hub, checkConnection } from '../lib/hub.js';
import { BridgeError } from '../lib/protocol.js';
import { EXTENSION_ID, Sockets, closed, send } from './helpers.js';

const EXTRA_ID = 'abcdefghijklmnopabcdefghijklmnop';

describe('checkConnection', () => {
  const options = { port: 39317, extensionIds: [EXTENSION_ID] };
  const check = (url, headers) => checkConnection({ url, headers }, options);

  it('accepts the extension and local agents on either loopback name', () => {
    assert.deepEqual(check('/?role=extension', { host: '127.0.0.1:39317', origin: `chrome-extension://${EXTENSION_ID}` }), { role: 'extension' });
    assert.deepEqual(check('/?role=agent', { host: 'LOCALHOST:39317' }), { role: 'agent' });
  });

  it('refuses other hosts, ports, paths and roles', () => {
    assert.equal(check('/?role=agent', { host: 'evil.example:39317' }).status, 403);
    assert.equal(check('/?role=agent', { host: '127.0.0.1:80' }).status, 403);
    assert.equal(check('/?role=agent', {}).status, 403);
    assert.equal(check('/other?role=agent', { host: '127.0.0.1:39317' }).status, 404);
    assert.equal(check('/?role=admin', { host: '127.0.0.1:39317' }).status, 400);
  });
});

describe('Hub', { timeout: 10_000 }, () => {
  /** @type {Hub} */
  let hub;
  /** @type {Sockets} */
  let sockets;

  beforeEach(async () => {
    hub = new Hub({ port: 0, extensionIds: [EXTENSION_ID, EXTRA_ID], name: 'local-agent', log: () => {} });
    await hub.listen();
    sockets = new Sockets(() => hub.port);
  });

  afterEach(async () => {
    sockets.closeAll();
    await hub.close();
  });

  describe('connections', () => {
    it('accepts the extension and tells it which agents are connected', async () => {
      const { inbox } = await sockets.extension();
      const clients = await inbox.next('clients');
      assert.equal(clients.agents.length, 1);
      assert.equal(clients.agents[0].name, 'local-agent');
      assert.equal(typeof clients.agents[0].connectedAt, 'number');
    });

    it('accepts extra extension IDs and the localhost Host name', async () => {
      await sockets.connect({ role: 'extension', origin: `chrome-extension://${EXTRA_ID}`, host: `localhost:${hub.port}` });
    });

    it('refuses an extension connection with the wrong origin', async () => {
      assert.equal(await sockets.refused({ role: 'extension', origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }), 403);
      assert.equal(await sockets.refused({ role: 'extension', origin: 'https://www.reddit.com' }), 403);
      assert.equal(await sockets.refused({ role: 'extension' }), 403);
    });

    it('refuses agents that send an Origin header, as web pages do', async () => {
      assert.equal(await sockets.refused({ role: 'agent', origin: 'https://evil.example' }), 403);
    });

    it('refuses a Host header other than the loopback port', async () => {
      assert.equal(await sockets.refused({ role: 'agent', host: `evil.example:${hub.port}` }), 403);
      assert.equal(await sockets.refused({ role: 'extension', origin: `chrome-extension://${EXTENSION_ID}`, host: '127.0.0.1:1' }), 403);
    });

    it('refuses connections without a role or on another path', async () => {
      assert.equal(await sockets.refused({}), 400);
      assert.equal(await sockets.refused({ role: 'agent', path: '/admin' }), 404);
    });

    it('answers pings with pongs and ignores malformed messages', async () => {
      const { ws, inbox } = await sockets.extension();
      send(ws, 'not json');
      send(ws, '[1, 2, 3]');
      send(ws, { type: 'ping' });
      await inbox.next('pong');
    });

    it('updates the extension when agent clients connect and disconnect', async () => {
      const { inbox } = await sockets.extension();
      await inbox.next('clients');

      const agent = await sockets.agent('cursor');
      assert.deepEqual((await inbox.next('clients')).agents.map((a) => a.name), ['local-agent', 'cursor']);

      agent.ws.close();
      assert.deepEqual((await inbox.next('clients')).agents.map((a) => a.name), ['local-agent']);
    });

    it('replaces an older extension connection with a newer one', async () => {
      const first = await sockets.extension();
      const firstClosed = closed(first.ws);
      // Assert on the promise right away: it rejects while the test awaits other things.
      const pending = assert.rejects(hub.request('get_queue'), { code: 'EXTENSION_DISCONNECTED' });
      await first.inbox.next('request');

      const second = await sockets.extension({ version: '1.3.1' });
      assert.equal(await firstClosed, 4001);
      await pending;

      const next = hub.request('get_queue');
      const request = await second.inbox.next('request');
      send(second.ws, { type: 'response', id: request.id, ok: true, result: { items: [] } });
      assert.deepEqual(await next, { items: [] });
      assert.equal(hub.status().extensionVersion, '1.3.1');
    });
  });

  describe('routing', () => {
    it('forwards an agent request under a hub ID and routes progress and the response back', async () => {
      const extension = await sockets.extension();
      const agent = await sockets.agent('cursor');
      await extension.inbox.next('clients');

      const params = { links: ['https://redd.it/abc123'], sort: 'top', loadHiddenReplies: false };
      send(agent.ws, { type: 'request', id: 7, method: 'export_threads', params });

      const request = await extension.inbox.next('request');
      assert.match(request.id, /^h-\d+$/);
      assert.equal(request.method, 'export_threads');
      assert.deepEqual(request.params, params);
      assert.deepEqual(request.client, { name: 'cursor' });

      send(extension.ws, { type: 'progress', id: request.id, message: 'Exported 1 of 2', done: 1, total: 2, extra: 'dropped' });
      assert.deepEqual(await agent.inbox.next('progress'), { type: 'progress', id: 7, message: 'Exported 1 of 2', done: 1, total: 2 });

      send(extension.ws, { type: 'response', id: request.id, ok: true, result: { threads: [] } });
      assert.deepEqual(await agent.inbox.next('response'), { type: 'response', id: 7, ok: true, result: { threads: [] } });
    });

    it('keeps agents apart when they use the same request IDs', async () => {
      const extension = await sockets.extension();
      const one = await sockets.agent('one');
      const two = await sockets.agent('two');

      send(one.ws, { type: 'request', id: 1, method: 'get_queue' });
      send(two.ws, { type: 'request', id: 1, method: 'get_queue' });
      const first = await extension.inbox.next('request');
      const second = await extension.inbox.next('request');
      assert.notEqual(first.id, second.id);

      for (const request of [first, second]) {
        send(extension.ws, { type: 'response', id: request.id, ok: true, result: { for: request.client.name } });
      }
      assert.deepEqual((await one.inbox.next('response')).result, { for: 'one' });
      assert.deepEqual((await two.inbox.next('response')).result, { for: 'two' });
    });

    it("serves this process's own requests with progress", async () => {
      const extension = await sockets.extension();
      const progress = [];
      const pending = hub.request('find_threads', { query: 'tea' }, { onProgress: (p) => progress.push(p) });

      const request = await extension.inbox.next('request');
      assert.deepEqual(request.client, { name: 'local-agent' });
      send(extension.ws, { type: 'progress', id: request.id, message: 'Searching' });
      send(extension.ws, { type: 'response', id: request.id, ok: false, error: { code: 'DAILY_LIMIT', message: 'Limit reached.' } });

      await assert.rejects(pending, (error) => error instanceof BridgeError && error.code === 'DAILY_LIMIT' && error.message === 'Limit reached.');
      assert.deepEqual(progress, [{ message: 'Searching' }]);
    });

    it('answers status requests from agents', async () => {
      await sockets.extension({ version: '1.3.0' });
      const agent = await sockets.agent();
      send(agent.ws, { type: 'status' });
      assert.deepEqual(await agent.inbox.next('status'), { type: 'status', extensionConnected: true, extensionVersion: '1.3.0', agents: 2 });
    });

    it('answers EXTENSION_NOT_CONNECTED when there is no extension', async () => {
      const agent = await sockets.agent();
      send(agent.ws, { type: 'request', id: 'a', method: 'status' });
      const response = await agent.inbox.next('response');
      assert.equal(response.id, 'a');
      assert.equal(response.ok, false);
      assert.equal(response.error.code, 'EXTENSION_NOT_CONNECTED');

      await assert.rejects(hub.request('status'), { code: 'EXTENSION_NOT_CONNECTED' });
    });

    it('answers EXTENSION_DISCONNECTED when the extension goes away mid-request', async () => {
      const extension = await sockets.extension();
      const agent = await sockets.agent();
      send(agent.ws, { type: 'request', id: 'a', method: 'export_threads', params: { links: ['x'] } });
      const local = assert.rejects(hub.request('get_queue'), { code: 'EXTENSION_DISCONNECTED' });
      await extension.inbox.next('request');
      await extension.inbox.next('request');

      extension.ws.close();
      assert.equal((await agent.inbox.next('response')).error.code, 'EXTENSION_DISCONNECTED');
      await local;
      assert.equal(hub.status().extensionConnected, false);
    });

    it('rejects agent requests without a method', async () => {
      const agent = await sockets.agent();
      send(agent.ws, { type: 'request', id: 3 });
      assert.equal((await agent.inbox.next('response')).error.code, 'BAD_REQUEST');
    });
  });
});

describe('Hub timeouts', { timeout: 10_000 }, () => {
  it('ends requests the extension never answers', async () => {
    const hub = new Hub({ port: 0, extensionIds: [EXTENSION_ID], name: 'local', log: () => {}, requestTimeoutMs: 50 });
    await hub.listen();
    const sockets = new Sockets(() => hub.port);
    try {
      await sockets.extension();
      await assert.rejects(hub.request('status'), { code: 'TIMEOUT' });
    } finally {
      sockets.closeAll();
      await hub.close();
    }
  });
});
