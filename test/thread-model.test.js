import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { countComments, findMoreStubs, getPostData, normalizeThread, walkComments } from '../src/lib/thread-model.js';
import { comment, more, sampleThread, thread } from './fixtures.js';

describe('normalizeThread', () => {
  it('maps the post fields', () => {
    const result = normalizeThread(sampleThread());
    assert.equal(result.id, 'post1');
    assert.equal(result.subreddit, 'testing');
    assert.equal(result.title, 'A test thread');
    assert.equal(result.score, 42);
    assert.equal(result.flair, 'Discussion');
    assert.equal(result.url, 'https://www.reddit.com/r/testing/comments/post1/a_test_thread/');
    assert.equal(result.linkUrl, null);
    assert.equal(result.createdAt, '2025-10-09T08:53:20.000Z');
  });

  it('leaves usernames out by default', () => {
    const result = normalizeThread(sampleThread());
    assert.equal(result.author, null);
    assert.ok([...walkComments(result.comments)].every((c) => c.author === null));
  });

  it('keeps usernames when asked', () => {
    const result = normalizeThread(sampleThread(), [], { includeUsernames: true });
    assert.equal(result.author, 'op_user');
    assert.equal(result.comments[0].author, 'user_c1');
    assert.equal(result.comments[0].replies[0].isSubmitter, true);
  });

  it('builds the reply tree with parents and depth', () => {
    const [first] = normalizeThread(sampleThread()).comments;
    assert.equal(first.id, 'c1');
    assert.equal(first.parentId, null);
    assert.equal(first.replies[0].parentId, 'c1');
    assert.equal(first.replies[0].depth, 1);
    assert.equal(first.replies[0].body, 'A reply\nwith two lines');
  });

  it('keeps removed comments only when they have replies', () => {
    const ids = [...walkComments(normalizeThread(sampleThread()).comments)].map((c) => c.id);
    assert.deepEqual(ids, ['c1', 'c2', 'c3', 'c4']);
    const removed = normalizeThread(sampleThread()).comments[1];
    assert.equal(removed.isRemoved, true);
    assert.equal(removed.body, '');
  });

  it('counts reported, exported and hidden comments', () => {
    assert.deepEqual(normalizeThread(sampleThread()).commentCounts, { reported: 5, exported: 4, hidden: 2 });
  });

  it('grafts comments loaded from "load more replies"', () => {
    const extra = [
      comment('c6', 'Loaded later', { parent: 't3_post1' }),
      comment('c7', 'Reply to c1, loaded later', { parent: 't1_c1', depth: 1 }),
      comment('c8', 'Reply to c7', { parent: 't1_c7', depth: 2 }),
    ];
    const result = normalizeThread(sampleThread(), extra);
    assert.equal(result.comments.at(-1).id, 'c6');
    assert.deepEqual(
      result.comments[0].replies.map((c) => c.id),
      ['c2', 'c7'],
    );
    assert.equal(result.comments[0].replies[1].replies[0].depth, 2);
    assert.equal(result.commentCounts.exported, 7);
    assert.equal(result.commentCounts.hidden, 0);
  });

  it('marks link posts', () => {
    const result = normalizeThread(thread([], { is_self: false, url: 'https://example.com/article', selftext: '' }));
    assert.equal(result.linkUrl, 'https://example.com/article');
  });

  it('rejects responses that are not threads', () => {
    assert.throws(() => normalizeThread({}), TypeError);
    assert.throws(() => normalizeThread([{ data: { children: [] } }]), TypeError);
    assert.throws(() => getPostData(null), TypeError);
  });
});

describe('findMoreStubs', () => {
  it('lists stub IDs, nested ones included', () => {
    const listing = thread([comment('c1', 'x', { replies: [more(['n1', 'n2'])] }), more(['t1', 't2'])]);
    assert.deepEqual(findMoreStubs(listing), ['n1', 'n2', 't1', 't2']);
  });

  it('skips "continue this thread" stubs and already loaded comments', () => {
    const listing = thread([more(['_']), more(['a', 'b'])]);
    assert.deepEqual(findMoreStubs(listing, [comment('a', 'loaded')]), ['b']);
  });

  it('includes stubs that came back inside loaded comments', () => {
    const listing = thread([more(['a'])]);
    assert.deepEqual(findMoreStubs(listing, [comment('a', 'loaded'), more(['z'])]), ['z']);
  });
});

describe('countComments', () => {
  it('counts nested replies', () => {
    assert.equal(countComments(normalizeThread(sampleThread()).comments), 4);
    assert.equal(countComments([]), 0);
  });
});
