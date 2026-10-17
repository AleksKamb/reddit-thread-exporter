import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { toMarkdown } from '../../src/lib/formatters.js';
import { normalizeThread } from '../../src/lib/thread-model.js';
import { comment, sampleThread, thread } from '../../test/fixtures.js';
import { BridgeError } from '../lib/protocol.js';
import { createMcpServer, createToolHandlers } from '../lib/tools.js';

const NOW = new Date(2026, 9, 17, 14, 30);
const THREAD_URL = 'https://www.reddit.com/r/testing/comments/post1/a_test_thread/';
const META = { exportedAt: NOW, toolName: 'Thread Exporter for Reddit (MCP)', toolVersion: '1.3.0' };
const USAGE = { date: '2026-10-17', used: 2, limit: 100, remaining: 98 };

/**
 * A bridge that answers each method from `answers`: a value, an error to throw, or a function.
 *
 * @param {Record<string, unknown>} answers
 * @param {{ connected?: boolean }} [options]
 */
function fakeBridge(answers, { connected = true } = {}) {
  const calls = [];
  return {
    calls,
    async request(method, params, options = {}) {
      calls.push({ method, params });
      const answer = answers[method];
      if (answer instanceof Error) throw answer;
      return typeof answer === 'function' ? answer(params, options) : answer;
    },
    async status() {
      return { role: 'hub', port: 39317, extensionConnected: connected, extensionVersion: connected ? '1.3.0' : null, agents: 1 };
    },
  };
}

/** @param {unknown} listing */
const fetched = (listing = sampleThread(), link = THREAD_URL) => ({ link, ok: true, data: { listing, extraThings: [] } });

const exportArgs = (overrides = {}) => ({
  links: [THREAD_URL],
  format: 'markdown',
  include_usernames: false,
  load_hidden_replies: false,
  sort: 'confidence',
  ...overrides,
});

/** @param {{ content: { text: string }[] }} result */
const allText = (result) => result.content.map((part) => part.text).join('\n\n');

describe('tools', () => {
  let outputDir = '';
  const logged = [];

  before(async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'thread-exporter-mcp-'));
  });

  after(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  /**
   * @param {ReturnType<typeof fakeBridge>} bridge
   * @param {{ inlineLimit?: number }} [config]
   */
  function handlersFor(bridge, { inlineLimit = 60_000 } = {}) {
    return createToolHandlers({ bridge, config: { inlineLimit, outputDir }, log: (message) => logged.push(message), now: () => NOW });
  }

  describe('export_threads', () => {
    it('returns a summary and the Markdown inline', async () => {
      const bridge = fakeBridge({
        export_threads: {
          threads: [fetched(), { link: 'https://redd.it/gone12', ok: false, error: 'Thread not found. It may have been deleted, or the link is wrong.' }],
          notThreads: ['https://www.reddit.com/r/testing/'],
          duplicates: 1,
          usage: USAGE,
        },
      });
      const result = await handlersFor(bridge).export_threads(exportArgs({ sort: 'top', load_hidden_replies: true }));

      assert.deepEqual(bridge.calls, [
        { method: 'export_threads', params: { links: [THREAD_URL], sort: 'top', loadHiddenReplies: true } },
      ]);
      assert.equal(result.isError, undefined);
      assert.equal(
        result.content[0].text,
        [
          'Exported 1 of 2 threads (4 comments) as Markdown.',
          'Failed (1):',
          '- https://redd.it/gone12: Thread not found. It may have been deleted, or the link is wrong.',
          'Skipped, not Reddit threads (1): https://www.reddit.com/r/testing/',
          'Skipped duplicate links: 1.',
          "Today's agent usage: 2/100 (98 left).",
        ].join('\n'),
      );
      assert.equal(result.content[1].text, toMarkdown([normalizeThread(sampleThread())], META));
    });

    it('leaves usernames out unless asked', async () => {
      const bridge = fakeBridge({ export_threads: { threads: [fetched()], notThreads: [], duplicates: 0 } });
      const handlers = handlersFor(bridge);

      assert.doesNotMatch((await handlers.export_threads(exportArgs())).content[1].text, /u\/user_c1/);
      assert.match((await handlers.export_threads(exportArgs({ include_usernames: true }))).content[1].text, /\*\*u\/user_c1\*\*/);
    });

    it('returns JSON and CSV like the extension files', async () => {
      const handlers = handlersFor(fakeBridge({ export_threads: { threads: [fetched()] } }));

      const json = JSON.parse((await handlers.export_threads(exportArgs({ format: 'json' }))).content[1].text);
      assert.equal(json.exportedWith, 'Thread Exporter for Reddit (MCP) 1.3.0');
      assert.equal(json.threads[0].title, 'A test thread');

      const csv = (await handlers.export_threads(exportArgs({ format: 'csv' }))).content[1].text;
      assert.ok(csv.startsWith('type,thread_id,subreddit'), 'inline CSV has no byte order mark');
    });

    it('saves to a file when asked, without overwriting earlier files', async () => {
      const handlers = handlersFor(fakeBridge({ export_threads: { threads: [fetched()] } }));
      const first = await handlers.export_threads(exportArgs({ save_to_file: true }));
      const second = await handlers.export_threads(exportArgs({ save_to_file: true }));

      const firstPath = join(outputDir, 'agent-reddit-threads-2026-10-17-1430.md');
      const secondPath = join(outputDir, 'agent-reddit-threads-2026-10-17-1430-2.md');
      assert.equal(first.content.length, 1);
      assert.match(first.content[0].text, /^Exported 1 of 1 thread \(4 comments\) as Markdown\.\n\nSaved the Markdown export as requested:\n/);
      assert.ok(first.content[0].text.includes(`\n${firstPath}\n`));
      assert.ok(second.content[0].text.includes(`\n${secondPath}\n`));
      assert.equal(await readFile(firstPath, 'utf8'), toMarkdown([normalizeThread(sampleThread())], META));
    });

    it('saves results over the inline limit to a file', async () => {
      const handlers = handlersFor(fakeBridge({ export_threads: { threads: [fetched()] } }), { inlineLimit: 100 });
      const result = await handlers.export_threads(exportArgs({ format: 'csv' }));

      const text = result.content[0].text;
      assert.match(text, /Saved the CSV export because it is longer than 100 characters:/);
      const path = text.split('\n').find((line) => line.startsWith(outputDir));
      assert.match(basename(path), /^agent-reddit-threads-2026-10-17-1430(-\d+)?\.csv$/);
      assert.ok((await readFile(path, 'utf8')).startsWith('﻿type,'), 'the CSV file keeps its byte order mark for Excel');
    });

    it('is an error when no thread could be exported', async () => {
      const bridge = fakeBridge({ export_threads: { threads: [{ link: 'https://redd.it/gone12', ok: false, error: { code: 'HTTP_404', message: 'Thread not found.' } }] } });
      const result = await handlersFor(bridge).export_threads(exportArgs());
      assert.equal(result.isError, true);
      assert.match(allText(result), /Exported 0 of 1 thread .*\n.*\n- https:\/\/redd\.it\/gone12: Thread not found\./);
    });

    it('reports a response that is not a thread as a failure of that link only', async () => {
      const bridge = fakeBridge({ export_threads: { threads: [fetched(), fetched({ nope: true }, 'https://redd.it/odd123')] } });
      const result = await handlersFor(bridge).export_threads(exportArgs());
      assert.match(result.content[0].text, /^Exported 1 of 2 threads/);
      assert.match(result.content[0].text, /- https:\/\/redd\.it\/odd123: The extension returned data that is not a Reddit thread\./);
    });
  });

  describe('get_exported_threads', () => {
    it('formats the threads stored in the extension', async () => {
      const bridge = fakeBridge({
        get_exported_threads: { threads: [{ key: 'post1', data: { listing: sampleThread(), extraThings: [] } }] },
      });
      const result = await handlersFor(bridge).get_exported_threads({ format: 'markdown', include_usernames: false });
      assert.equal(result.content[0].text, 'Returned 1 of 1 previously exported thread from the extension (4 comments) as Markdown.');
      assert.equal(result.content[1].text, toMarkdown([normalizeThread(sampleThread())], META));
    });

    it('says so when there is nothing stored', async () => {
      const result = await handlersFor(fakeBridge({ get_exported_threads: { threads: [] } })).get_exported_threads({ format: 'markdown' });
      assert.equal(result.isError, undefined);
      assert.match(result.content[0].text, /holds no exported threads/);
    });
  });

  describe('find_threads', () => {
    const search = { query: 'best teapot', subreddit: 'r/tea', sort: 'top', time: 'week', limit: 5 };

    it('lists results with a hint to export them', async () => {
      const bridge = fakeBridge({
        find_threads: {
          results: [
            {
              id: 'abc123',
              title: 'Best\nteapot?',
              subreddit: 'tea',
              url: 'https://www.reddit.com/r/tea/comments/abc123/best_teapot/',
              score: 1200,
              comments: 45,
              createdAt: '2026-10-01T12:00:00.000Z',
              snippet: 'Looking for a teapot\n\nthat pours well.',
            },
            { id: 'def456', title: 'Kettles', subreddit: 'tea', url: 'https://www.reddit.com/r/tea/comments/def456/kettles/', score: 1, comments: 1, createdAt: 1_760_000_000 },
          ],
          usage: USAGE,
        },
      });
      const result = await handlersFor(bridge).find_threads(search);

      assert.deepEqual(bridge.calls[0].params, { query: 'best teapot', sort: 'top', time: 'week', limit: 5, subreddit: 'tea' });
      assert.equal(
        result.content[0].text,
        [
          'Found 2 threads for "best teapot" in r/tea (sort: top, time: week):',
          '',
          '1. r/tea · Best teapot?',
          '   https://www.reddit.com/r/tea/comments/abc123/best_teapot/',
          '   1,200 points · 45 comments · 2026-10-01',
          '   Looking for a teapot that pours well.',
          '',
          '2. r/tea · Kettles',
          '   https://www.reddit.com/r/tea/comments/def456/kettles/',
          '   1 point · 1 comment · 2025-10-09',
          '',
          'To get a thread with all its comments, pass its URL to export_threads (several URLs can go in one call).',
          "Today's agent usage: 2/100 (98 left).",
        ].join('\n'),
      );
    });

    it('suggests what to change when nothing is found', async () => {
      const result = await handlersFor(fakeBridge({ find_threads: { results: [] } })).find_threads(search);
      assert.match(result.content[0].text, /^No threads found for "best teapot" in r\/tea \(sort: top, time: week\)\.\nTry other words/);
    });
  });

  describe('queue tools', () => {
    it('add_to_queue says what was added and skipped', async () => {
      const bridge = fakeBridge({ add_to_queue: { added: 2, duplicates: 1, notThreads: ['https://www.reddit.com/user/someone'] } });
      const result = await handlersFor(bridge).add_to_queue({ links: ['a', 'b', 'c', 'd'] });
      assert.deepEqual(bridge.calls[0].params, { links: ['a', 'b', 'c', 'd'] });
      assert.equal(
        result.content[0].text,
        [
          "Added 2 threads to the extension's queue. Nothing was fetched yet; the user can export the queue in the extension.",
          'Already in the queue: 1.',
          'Skipped, not Reddit threads: https://www.reddit.com/user/someone',
        ].join('\n'),
      );
    });

    it('get_queue lists each thread with its status', async () => {
      const bridge = fakeBridge({
        get_queue: {
          items: [
            { title: 'A test thread', subreddit: 'testing', url: THREAD_URL, status: 'done', comments: 4 },
            { title: '', subreddit: null, url: 'https://redd.it/gone12', status: 'failed', error: 'Thread not found.' },
          ],
        },
      });
      const result = await handlersFor(bridge).get_queue({});
      assert.equal(
        result.content[0].text,
        [
          'Queue: 2 threads (1 done, 1 failed).',
          '',
          `1. [done] r/testing · A test thread · 4 comments`,
          `   ${THREAD_URL}`,
          '2. [failed] https://redd.it/gone12',
          '   https://redd.it/gone12',
          '   Error: Thread not found.',
        ].join('\n'),
      );
    });
  });

  describe('get_status', () => {
    it('explains how to connect when the extension is not connected', async () => {
      const bridge = fakeBridge({}, { connected: false });
      const result = await handlersFor(bridge).get_status({});
      assert.equal(result.isError, undefined);
      assert.match(result.content[0].text, /is not connected/);
      assert.match(result.content[0].text, /"Agents off" pill to "Agents on"/);
      assert.deepEqual(bridge.calls, []);
    });

    it("shows the extension's state, usage and limits", async () => {
      const bridge = fakeBridge({
        status: {
          version: '1.3.0',
          busy: 'page',
          usage: USAGE,
          limits: { maxPerRequest: 25, delaySeconds: 3, batchSize: 25, batchPauseSeconds: 30, askBeforeExport: true },
          queue: { waiting: 3, done: 10, failed: 1 },
        },
      });
      const result = await handlersFor(bridge).get_status({});
      assert.equal(
        result.content[0].text,
        [
          'Thread Exporter for Reddit 1.3.0 is connected and accepts agent requests.',
          'Export running: yes, the user is exporting in the extension.',
          "Today's agent usage: 2/100 (98 left).",
          'Limits set by the user: up to 25 threads per request; 3 s between requests; batches of 25 with 30 s pauses; approval before each agent export: on.',
          'Queue: 3 waiting, 10 done, 1 failed.',
          'Local bridge: 127.0.0.1:39317.',
        ].join('\n'),
      );
    });

    it('explains, without failing, when agent access is off', async () => {
      const bridge = fakeBridge({ status: new BridgeError('AGENTS_DISABLED', 'Agents are not allowed.') });
      const result = await handlersFor(bridge).get_status({});
      assert.equal(result.isError, undefined);
      assert.match(result.content[0].text, /Allow agents/);
    });
  });

  describe('errors', () => {
    const cases = [
      ['DAILY_LIMIT', /do not retry today/],
      ['BUSY', /Wait a minute or two and retry/],
      ['DENIED', /declined .*Do not retry/],
      ['EXTENSION_NOT_CONNECTED', /"Agents off" pill to "Agents on"/],
      ['EXTENSION_DISCONNECTED', /Call get_status/],
      ['TOO_MANY_THREADS', /smaller batches/],
      ['TIMEOUT', /fewer threads/],
    ];
    for (const [code, advice] of cases) {
      it(`turns ${code} into advice for the agent`, async () => {
        const bridge = fakeBridge({ export_threads: new BridgeError(code, 'Details from the extension.') });
        const result = await handlersFor(bridge).export_threads(exportArgs());
        assert.equal(result.isError, true);
        assert.ok(result.content[0].text.startsWith(`${code}: Details from the extension.\n\n`));
        assert.match(result.content[0].text, advice);
      });
    }

    it('hides stack traces of unexpected errors from the agent and logs them', async () => {
      const bridge = fakeBridge({ get_queue: new TypeError('items is not iterable') });
      const result = await handlersFor(bridge).get_queue({});
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /unexpected error: items is not iterable/);
      assert.doesNotMatch(result.content[0].text, /\n\s+at /);
      assert.match(logged.at(-1), /get_queue failed: TypeError: items is not iterable\n\s+at /);
    });
  });

  describe('over MCP', () => {
    /**
     * @param {ReturnType<typeof fakeBridge>} bridge
     * @param {(client: Client) => Promise<void>} use
     */
    async function withClient(bridge, use) {
      const server = createMcpServer({ bridge, config: { inlineLimit: 60_000, outputDir }, now: () => NOW });
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        await use(client);
      } finally {
        await client.close();
        await server.close();
      }
    }

    it('lists the six tools', async () => {
      await withClient(fakeBridge({}), async (client) => {
        const { tools } = await client.listTools();
        assert.deepEqual(tools.map((tool) => tool.name), ['export_threads', 'find_threads', 'get_exported_threads', 'add_to_queue', 'get_queue', 'get_status']);
      });
    });

    it('applies defaults and forwards progress as notifications', async () => {
      const bridge = fakeBridge({
        export_threads: async (_, { onProgress }) => {
          onProgress?.({ message: 'Exported 1 of 2', done: 1, total: 2 });
          onProgress?.({ message: 'Pausing for 3 s', done: 1, total: 2 });
          onProgress?.({ message: 'Exported 2 of 2', done: 2, total: 2 });
          return { threads: [fetched(), fetched(thread([comment('x1', 'Hello')]), 'https://redd.it/xyz789')] };
        },
      });
      await withClient(bridge, async (client) => {
        const progress = [];
        const result = await client.callTool({ name: 'export_threads', arguments: { links: [THREAD_URL, 'https://redd.it/xyz789'] } }, undefined, {
          onprogress: (update) => progress.push(update),
        });

        assert.deepEqual(bridge.calls[0].params, { links: [THREAD_URL, 'https://redd.it/xyz789'], sort: 'confidence', loadHiddenReplies: false });
        assert.match(result.content[0].text, /^Exported 2 of 2 threads \(5 comments\) as Markdown\./);
        assert.match(result.content[1].text, /^# Reddit threads/);
        assert.deepEqual(progress, [
          { progress: 1, total: 2, message: 'Exported 1 of 2' },
          { progress: 1.01, total: 2, message: 'Pausing for 3 s' },
          { progress: 2, total: 2, message: 'Exported 2 of 2' },
        ]);
      });
    });

    it('rejects invalid arguments before calling the extension', async () => {
      const bridge = fakeBridge({});
      await withClient(bridge, async (client) => {
        const result = await client.callTool({ name: 'export_threads', arguments: { links: [] } });
        assert.equal(result.isError, true);
        assert.deepEqual(bridge.calls, []);
      });
    });
  });
});
