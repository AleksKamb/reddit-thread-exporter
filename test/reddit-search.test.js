import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseSearchResults, searchPath, validateSearchOptions } from '../src/lib/reddit-search.js';

describe('validateSearchOptions', () => {
  it('fills in defaults', () => {
    assert.deepEqual(validateSearchOptions({ query: ' upwork alternatives ' }), {
      query: 'upwork alternatives',
      subreddit: '',
      sort: 'relevance',
      time: 'all',
      limit: 10,
    });
  });

  it('cleans the subreddit and clamps the limit', () => {
    const options = validateSearchOptions({ query: 'x', subreddit: 'r/Upwork', limit: 500, sort: 'top', time: 'year' });
    assert.equal(options.subreddit, 'Upwork');
    assert.equal(options.limit, 25);
    assert.equal(options.sort, 'top');
    assert.equal(options.time, 'year');
    assert.equal(validateSearchOptions({ query: 'x', limit: -3 }).limit, 1);
  });

  it('ignores unknown sort and time values', () => {
    const options = validateSearchOptions({ query: 'x', sort: 'hot', time: 'decade' });
    assert.equal(options.sort, 'relevance');
    assert.equal(options.time, 'all');
  });

  it('rejects empty queries and bad subreddit names', () => {
    assert.throws(() => validateSearchOptions({ query: '  ' }), /search query/);
    assert.throws(() => validateSearchOptions({}), /search query/);
    assert.throws(() => validateSearchOptions({ query: 'x', subreddit: '../evil' }), /valid subreddit/);
    assert.throws(() => validateSearchOptions({ query: 'x'.repeat(301) }), /under 300/);
  });
});

describe('searchPath', () => {
  it('searches all of Reddit', () => {
    assert.equal(
      searchPath(validateSearchOptions({ query: 'cold email' })),
      '/search.json?q=cold+email&sort=relevance&t=all&limit=10&type=link&raw_json=1',
    );
  });

  it('searches one subreddit', () => {
    assert.equal(
      searchPath(validateSearchOptions({ query: 'connects', subreddit: 'Upwork', sort: 'new' })),
      '/r/Upwork/search.json?q=connects&sort=new&t=all&limit=10&type=link&raw_json=1&restrict_sr=1',
    );
  });
});

describe('parseSearchResults', () => {
  const listing = {
    kind: 'Listing',
    data: {
      children: [
        {
          kind: 't3',
          data: {
            id: 'abc123',
            title: 'Is boosting worth it?',
            subreddit: 'Upwork',
            permalink: '/r/Upwork/comments/abc123/is_boosting_worth_it/',
            score: 12,
            num_comments: 30,
            created_utc: 1_760_000_000,
            selftext: 'Line one\n\nLine   two',
          },
        },
        { kind: 't3', data: { id: 'bad', title: 'Unsafe', permalink: '//evil.example/' } },
        { kind: 't5', data: { id: 'sub' } },
      ],
    },
  };

  it('maps posts and drops anything unsafe or not a post', () => {
    assert.deepEqual(parseSearchResults(listing), [
      {
        id: 'abc123',
        title: 'Is boosting worth it?',
        subreddit: 'Upwork',
        url: 'https://www.reddit.com/r/Upwork/comments/abc123/is_boosting_worth_it/',
        score: 12,
        comments: 30,
        createdAt: '2025-10-09T08:53:20.000Z',
        snippet: 'Line one Line two',
      },
    ]);
  });

  it('shortens long post text', () => {
    const long = { data: { children: [{ kind: 't3', data: { ...listing.data.children[0].data, selftext: 'word '.repeat(200) } }] } };
    const [result] = parseSearchResults(long);
    assert.ok(result.snippet.length <= 280);
    assert.ok(result.snippet.endsWith('…'));
  });

  it('rejects responses that are not listings', () => {
    assert.throws(() => parseSearchResults({ message: 'Forbidden' }), /not with search results/);
  });
});
