import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { sampleThread } from '../../test/fixtures.js';
import { Bridge } from '../lib/bridge.js';
import { createMcpServer } from '../lib/tools.js';
import { EXTENSION_ID, Sockets, getFreePort, send } from './helpers.js';

const THREAD_URL = 'https://www.reddit.com/r/testing/comments/post1/a_test_thread/';

/** What the fake extension answers, by method. */
const ANSWERS = {
  status: {
    version: '1.3.0',
    busy: null,
    usage: { date: '2026-10-17', used: 1, limit: 100, remaining: 99 },
    limits: { maxPerRequest: 25, delaySeconds: 3, batchSize: 25, batchPauseSeconds: 30, askBeforeExport: false },
    queue: { waiting: 0, done: 1, failed: 0 },
  },
  export_threads: {
    threads: [{ link: THREAD_URL, ok: true, data: { listing: sampleThread(), extraThings: [] } }],
    notThreads: [],
    duplicates: 0,
    usage: { date: '2026-10-17', used: 1, limit: 100, remaining: 99 },
  },
};

/**
 * Plays the extension: answers every request from {@link ANSWERS}, with one progress update first.
 *
 * @param {Sockets} sockets
 */
async function startFakeExtension(sockets) {
  const extension = await sockets.extension();
  extension.ws.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type !== 'request') return;
    send(extension.ws, { type: 'progress', id: message.id, message: 'Working', done: 1, total: 1 });
    send(extension.ws, { type: 'response', id: message.id, ok: true, result: ANSWERS[message.method] });
  });
  return extension;
}

describe('end to end', { timeout: 15_000 }, () => {
  let port = 0;
  /** @type {Sockets} */
  let sockets;
  /** @type {(() => Promise<void>)[]} */
  let cleanups = [];

  beforeEach(async () => {
    port = await getFreePort();
    sockets = new Sockets(() => port);
    cleanups = [];
  });

  afterEach(async () => {
    sockets.closeAll();
    for (const cleanup of cleanups.reverse()) await cleanup();
  });

  /** Starts a bridge and an MCP server on it, and connects an MCP client. */
  async function startSession(name) {
    const bridge = new Bridge({ port, extensionIds: [EXTENSION_ID], name, log: () => {} });
    await bridge.start();
    const server = createMcpServer({ bridge, config: { inlineLimit: 60_000, outputDir: '/nonexistent' } });
    const client = new Client({ name, version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(async () => {
      await client.close();
      await server.close();
      await bridge.close();
    });
    return { bridge, client };
  }

  it('exports a thread through the hub and the extension', async () => {
    const { bridge, client } = await startSession('claude-code');
    assert.equal(bridge.role, 'hub');
    await startFakeExtension(sockets);

    const result = await client.callTool({ name: 'export_threads', arguments: { links: [THREAD_URL] } });
    assert.match(result.content[0].text, /^Exported 1 of 1 thread \(4 comments\) as Markdown\./);
    assert.match(result.content[1].text, /^# Reddit threads\n\nExported \d{4}-\d{2}-\d{2} with Thread Exporter for Reddit \(MCP\) 1\.3\.0/);
  });

  it('serves a second session through the first one', async () => {
    await startSession('claude-code');
    const second = await startSession('cursor');
    assert.equal(second.bridge.role, 'client');
    await startFakeExtension(sockets);

    const status = await second.client.callTool({ name: 'get_status', arguments: {} });
    assert.match(status.content[0].text, /^Thread Exporter for Reddit 1\.3\.0 is connected/);
    assert.match(status.content[0].text, /run by another agent session\. 2 agent sessions share it\.$/);

    const result = await second.client.callTool({ name: 'export_threads', arguments: { links: [THREAD_URL], format: 'json' } });
    assert.equal(JSON.parse(result.content[1].text).threadCount, 1);
  });

  it('tells the agent how to connect when the extension is missing', async () => {
    const { client } = await startSession('claude-code');
    const status = await client.callTool({ name: 'get_status', arguments: {} });
    assert.equal(status.isError, undefined);
    assert.match(status.content[0].text, /not connected/);

    const result = await client.callTool({ name: 'export_threads', arguments: { links: [THREAD_URL] } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^EXTENSION_NOT_CONNECTED: /);
  });
});
