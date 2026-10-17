import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ExportRunner, expectThreadJson } from '../src/lib/export-runner.js';
import { parseThreadLink } from '../src/lib/reddit-links.js';
import { comment, more, sampleThread, thread } from './fixtures.js';

/**
 * A runner with a fake clock: `sleep` advances time instantly and records each wait.
 *
 * @param {(path: string) => object} respond  Returns the fake response for a path.
 * @param {object} [settings]
 */
function createRunner(respond, settings = {}) {
  let now = 0;
  const requests = [];
  const waits = [];
  const runner = new ExportRunner({
    request: async (path) => {
      requests.push(path);
      return respond(path, requests.length);
    },
    settings: { delaySeconds: 3, sort: 'confidence', expandMore: false, ...settings },
    sleep: async (ms) => {
      waits.push(ms);
      now += ms;
    },
    now: () => now,
  });
  const events = [];
  for (const type of ['item-start', 'item-done', 'item-failed', 'wait', 'finished', 'log']) {
    runner.addEventListener(type, (event) => events.push({ type, ...event.detail }));
  }
  return { runner, requests, waits, events };
}

const ok = (json) => ({ status: 200, isJson: true, json });
const job = (url) => ({ key: url, ref: parseThreadLink(url) });

describe('ExportRunner', () => {
  it('exports each thread and waits between requests', async () => {
    const { runner, requests, waits, events } = createRunner(() => ok(sampleThread()));
    const summary = await runner.run([job('https://redd.it/aaa111'), job('https://redd.it/bbb222')]);

    assert.deepEqual(summary, { done: 2, failed: 0, stopped: false });
    assert.deepEqual(requests, [
      '/comments/aaa111/.json?limit=500&sort=confidence&raw_json=1',
      '/comments/bbb222/.json?limit=500&sort=confidence&raw_json=1',
    ]);
    assert.deepEqual(waits, [3000]);
    assert.equal(events.filter((e) => e.type === 'item-done').length, 2);
    assert.equal(runner.state, 'finished');
  });

  it('takes a break between batches', async () => {
    const { runner, waits, events } = createRunner(() => ok(sampleThread()), { batchSize: 2, batchPauseSeconds: 30 });
    const ids = ['aaa111', 'bbb222', 'ccc333', 'ddd444', 'eee555'];
    await runner.run(ids.map((id) => job(`https://redd.it/${id}`)));

    assert.equal(waits.filter((ms) => ms === 30_000).length, 2);
    assert.equal(events.filter((e) => e.type === 'wait' && e.reason === 'batch').length, 2);
  });

  it('skips batch breaks when batches are off', async () => {
    const { runner, events } = createRunner(() => ok(sampleThread()), { batchSize: 0, batchPauseSeconds: 30 });
    await runner.run(['aaa111', 'bbb222', 'ccc333'].map((id) => job(`https://redd.it/${id}`)));
    assert.equal(events.filter((e) => e.type === 'wait' && e.reason === 'batch').length, 0);
  });

  it('waits out a rate limit and retries', async () => {
    const { runner, waits, events } = createRunner((_, n) => (n === 1 ? { status: 429, retryAfter: '42' } : ok(sampleThread())));
    const summary = await runner.run([job('https://redd.it/aaa111')]);

    assert.equal(summary.done, 1);
    assert.ok(waits.includes(42_000));
    assert.ok(events.some((e) => e.type === 'wait' && e.reason === 'rate-limit' && e.seconds === 42));
  });

  it('honours an empty request budget before the next request', async () => {
    const { runner, waits } = createRunner(() => ({ ...ok(sampleThread()), rateLimitRemaining: '0', rateLimitReset: '17' }));
    await runner.run([job('https://redd.it/aaa111'), job('https://redd.it/bbb222')]);
    assert.deepEqual(waits, [17_000]);
  });

  it('gives up after repeated rate limits', async () => {
    const { runner, events } = createRunner(() => ({ status: 429 }));
    const summary = await runner.run([job('https://redd.it/aaa111')]);
    assert.equal(summary.failed, 1);
    assert.match(events.find((e) => e.type === 'item-failed').error, /kept rate-limiting/);
  });

  it('retries server errors, then succeeds', async () => {
    const { runner } = createRunner((_, n) => (n < 3 ? { status: 503 } : ok(sampleThread())));
    assert.equal((await runner.run([job('https://redd.it/aaa111')])).done, 1);
  });

  it('reports failures with a readable reason and carries on', async () => {
    const { runner, events } = createRunner((path) => (path.includes('aaa111') ? { status: 404 } : ok(sampleThread())));
    const summary = await runner.run([job('https://redd.it/aaa111'), job('https://redd.it/bbb222')]);

    assert.deepEqual(summary, { done: 1, failed: 1, stopped: false });
    assert.match(events.find((e) => e.type === 'item-failed').error, /Thread not found/);
  });

  it('resolves share links through their redirect', async () => {
    const { runner, requests, events } = createRunner((path) =>
      path.startsWith('/r/')
        ? { status: 200, isJson: false, url: 'https://www.reddit.com/r/testing/comments/post1/a_test_thread/?share_id=x' }
        : ok(sampleThread()),
    );
    await runner.run([job('https://www.reddit.com/r/testing/s/AbC123')]);

    assert.equal(requests[0], '/r/testing/s/AbC123');
    assert.equal(requests[1], '/comments/post1/.json?limit=500&sort=confidence&raw_json=1');
    assert.equal(events.find((e) => e.type === 'item-done').result.ref.id, 'post1');
  });

  it('loads hidden replies when asked', async () => {
    const listing = thread([comment('c1', 'top'), more(['h1', 'h2'])]);
    const { runner, requests, events } = createRunner(
      (path) =>
        path.startsWith('/api/morechildren')
          ? ok({ json: { data: { things: [comment('h1', 'hidden one'), comment('h2', 'hidden two')] } } })
          : ok(listing),
      { expandMore: true },
    );
    await runner.run([job('https://redd.it/post1')]);

    assert.equal(requests.length, 2);
    assert.match(requests[1], /children=h1%2Ch2/);
    assert.equal(events.find((e) => e.type === 'item-done').result.extraThings.length, 2);
  });

  it('stops between threads and keeps finished work', async () => {
    const { runner, events } = createRunner(() => ok(sampleThread()));
    runner.addEventListener('item-done', () => runner.stop());
    const summary = await runner.run([job('https://redd.it/aaa111'), job('https://redd.it/bbb222')]);

    assert.deepEqual(summary, { done: 1, failed: 0, stopped: true });
    assert.equal(events.filter((e) => e.type === 'item-start').length, 1);
  });

  it('pauses between threads until resumed', async () => {
    const { runner, events } = createRunner(() => ok(sampleThread()));
    runner.addEventListener('item-done', () => {
      if (runner.state === 'running') runner.pause();
    });
    const running = runner.run([job('https://redd.it/aaa111'), job('https://redd.it/bbb222')]);

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runner.state, 'paused');
    assert.equal(events.filter((e) => e.type === 'item-start').length, 1);

    runner.resume();
    assert.equal((await running).done, 2);
  });

  it('refuses to run twice at once', async () => {
    const { runner } = createRunner(() => ok(sampleThread()));
    const first = runner.run([job('https://redd.it/aaa111')]);
    await assert.rejects(runner.run([job('https://redd.it/bbb222')]), /already running/);
    await first;
  });
});

describe('expectThreadJson', () => {
  it('explains each kind of failure', () => {
    assert.throws(() => expectThreadJson({ status: 200, isJson: false }), /web page instead of data/);
    assert.throws(() => expectThreadJson({ status: 200, isJson: true, json: { kind: 'Listing' } }), /not with a thread/);
    assert.throws(() => expectThreadJson({ status: 403, isJson: false }), /web page instead of data/);
    assert.throws(() => expectThreadJson({ status: 403, isJson: true, json: {} }), /refused access/);
    assert.throws(() => expectThreadJson({ status: 404 }), /not found/);
    assert.throws(() => expectThreadJson({ status: 0, error: 'offline' }), /Network error \(offline\)/);
  });
});
