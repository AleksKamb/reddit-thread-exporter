import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractThreadLinks, moreChildrenPath, parseThreadLink, refKey, slugToTitle, threadJsonPath } from '../src/lib/reddit-links.js';

describe('parseThreadLink', () => {
  const expected = {
    kind: 'thread',
    id: '1kgwx17',
    subreddit: 'webdev',
    slug: 'if_anyone_tried',
    url: 'https://www.reddit.com/r/webdev/comments/1kgwx17/if_anyone_tried/',
  };

  for (const input of [
    'https://www.reddit.com/r/webdev/comments/1kgwx17/if_anyone_tried/',
    'https://www.reddit.com/r/webdev/comments/1kgwx17/if_anyone_tried',
    'https://old.reddit.com/r/webdev/comments/1kgwx17/if_anyone_tried/?sort=top',
    'http://np.reddit.com/r/webdev/comments/1kgwx17/if_anyone_tried/#comments',
    'reddit.com/r/webdev/comments/1kgwx17/if_anyone_tried/',
    'www.reddit.com/r/webdev/comments/1KGWX17/if_anyone_tried/',
    '/r/webdev/comments/1kgwx17/if_anyone_tried/',
    '<https://www.reddit.com/r/webdev/comments/1kgwx17/if_anyone_tried/>',
    '"https://www.reddit.com/r/webdev/comments/1kgwx17/if_anyone_tried/".',
  ]) {
    it(`reads ${input}`, () => assert.deepEqual(parseThreadLink(input), expected));
  }

  it('reads a comment permalink as its thread', () => {
    const ref = parseThreadLink('https://www.reddit.com/r/webdev/comments/1kgwx17/if_anyone_tried/mqx9z1a/');
    assert.equal(ref?.id, '1kgwx17');
    assert.equal(ref?.slug, 'if_anyone_tried');
  });

  it('reads links without a subreddit', () => {
    assert.deepEqual(parseThreadLink('https://www.reddit.com/comments/abc123/'), {
      kind: 'thread',
      id: 'abc123',
      subreddit: null,
      slug: null,
      url: 'https://www.reddit.com/comments/abc123/',
    });
  });

  it('reads redd.it short links', () => {
    assert.equal(parseThreadLink('https://redd.it/1nvw4vi')?.id, '1nvw4vi');
    assert.equal(parseThreadLink('redd.it/1nvw4vi')?.url, 'https://www.reddit.com/comments/1nvw4vi/');
  });

  it('reads share links and marks them for resolving', () => {
    assert.deepEqual(parseThreadLink('https://www.reddit.com/r/Upwork/s/AbC123xYz'), {
      kind: 'share',
      id: 'AbC123xYz',
      subreddit: 'Upwork',
      slug: null,
      url: 'https://www.reddit.com/r/Upwork/s/AbC123xYz',
    });
  });

  for (const input of [
    '',
    'not a link',
    'https://www.reddit.com/r/webdev/',
    'https://www.reddit.com/user/someone/',
    'https://www.reddit.com/r/webdev/wiki/index',
    'https://example.com/r/webdev/comments/1kgwx17/',
    'https://notreddit.com/r/webdev/comments/1kgwx17/',
    'https://reddit.com.evil.example/r/webdev/comments/1kgwx17/',
  ]) {
    it(`rejects ${JSON.stringify(input)}`, () => assert.equal(parseThreadLink(input), null));
  }
});

describe('extractThreadLinks', () => {
  it('finds links in mixed text and removes duplicates', () => {
    const text = `
      Check these:
      https://www.reddit.com/r/a_sub/comments/aaa111/first/ and also
      old.reddit.com/r/a_sub/comments/AAA111/first/?context=3 (same thread)
      - [second](https://redd.it/bbb222)
      /r/other/comments/ccc333/third
    `;
    const result = extractThreadLinks(text);
    assert.deepEqual(
      result.refs.map((ref) => ref.id),
      ['aaa111', 'bbb222', 'ccc333'],
    );
    assert.equal(result.duplicates, 1);
    assert.deepEqual(result.notThreads, []);
  });

  it('finds links in any CSV column, quoted or not', () => {
    const csv = [
      'title,url,notes',
      '"Thread one","https://www.reddit.com/r/x/comments/aaa111/one/","has, commas"',
      'Thread two,https://www.reddit.com/r/x/comments/bbb222/two/,',
      'No link here,,',
    ].join('\n');
    assert.deepEqual(
      extractThreadLinks(csv).refs.map((ref) => ref.id),
      ['aaa111', 'bbb222'],
    );
  });

  it('lists Reddit links that are not threads', () => {
    const result = extractThreadLinks('https://www.reddit.com/r/webdev/ and https://www.reddit.com/user/someone');
    assert.equal(result.refs.length, 0);
    assert.deepEqual(result.notThreads, ['https://www.reddit.com/r/webdev/', 'https://www.reddit.com/user/someone']);
  });

  it('counts threads already in the queue as duplicates', () => {
    const result = extractThreadLinks('https://redd.it/aaa111 https://redd.it/bbb222', ['AAA111']);
    assert.deepEqual(
      result.refs.map((ref) => ref.id),
      ['bbb222'],
    );
    assert.equal(result.duplicates, 1);
  });

  it('handles empty input', () => {
    assert.deepEqual(extractThreadLinks(''), { refs: [], duplicates: 0, notThreads: [] });
    assert.deepEqual(extractThreadLinks(undefined), { refs: [], duplicates: 0, notThreads: [] });
  });
});

describe('helpers', () => {
  it('builds the thread JSON path', () => {
    assert.equal(threadJsonPath('ABC123', { sort: 'top' }), '/comments/abc123/.json?limit=500&sort=top&raw_json=1');
  });

  it('builds the morechildren path', () => {
    assert.equal(
      moreChildrenPath('abc123', ['x1', 'x2']),
      '/api/morechildren.json?api_type=json&link_id=t3_abc123&children=x1%2Cx2&sort=confidence&limit_children=false&raw_json=1',
    );
  });

  it('keys share links separately from threads', () => {
    assert.equal(refKey({ kind: 'thread', id: 'ABC', subreddit: null, slug: null, url: '' }), 'abc');
    assert.equal(refKey({ kind: 'share', id: 'XyZ', subreddit: 's', slug: null, url: '' }), 'share:xyz');
  });

  it('turns slugs into titles', () => {
    assert.equal(slugToTitle('if_anyone_tried_fiver'), 'If anyone tried fiver');
    assert.equal(slugToTitle('petite_p%C3%A9pite_du_matin'), 'Petite pépite du matin');
    assert.equal(slugToTitle('bad%slug'), 'Bad%slug');
    assert.equal(slugToTitle(null), '');
  });
});
