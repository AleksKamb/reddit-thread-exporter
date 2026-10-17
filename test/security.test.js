/**
 * Tests for the defensive parts of the extension: untrusted text from Reddit and from
 * user files must never turn into formulas, foreign links or a frozen page.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ExportRunner, MIN_DELAY_S } from '../src/lib/export-runner.js';
import { csvCell } from '../src/lib/formatters.js';
import { extractThreadLinks, parseThreadLink, redditUrl, safeWebUrl } from '../src/lib/reddit-links.js';
import { normalizeThread } from '../src/lib/thread-model.js';
import { thread } from './fixtures.js';

describe('CSV injection', () => {
  for (const formula of ['=HYPERLINK("http://evil.example","x")', '+1+1', '-2+3', '@SUM(A1)', '\tTAB', '\rCR']) {
    it(`neutralises ${JSON.stringify(formula.slice(0, 12))}`, () => {
      assert.match(csvCell(formula), /^"?'/);
    });
  }

  it('leaves numbers, including negative scores, alone', () => {
    assert.equal(csvCell(-12), '-12');
    assert.equal(csvCell(42), '42');
  });

  it('leaves ordinary text alone', () => {
    assert.equal(csvCell('Just a comment'), 'Just a comment');
  });
});

describe('links built from Reddit data', () => {
  it('only accepts site-relative permalinks', () => {
    assert.equal(redditUrl('/r/x/comments/abc123/t/'), 'https://www.reddit.com/r/x/comments/abc123/t/');
    for (const bad of ['//evil.example/x', '@evil.example/', 'https://evil.example/', '/\\evil', '', null, 42]) {
      assert.equal(redditUrl(bad), '', `should reject ${String(bad)}`);
    }
  });

  it('only keeps http and https link posts', () => {
    assert.equal(safeWebUrl('https://example.com/a'), 'https://example.com/a');
    assert.equal(safeWebUrl('javascript:alert(1)'), null);
    assert.equal(safeWebUrl('data:text/html,hi'), null);
    assert.equal(safeWebUrl('not a url'), null);
  });

  it('drops unsafe URLs from normalized threads', () => {
    const result = normalizeThread(thread([], { permalink: '//evil.example/', is_self: false, url: 'javascript:alert(1)' }));
    assert.equal(result.url, '');
    assert.equal(result.linkUrl, null);
  });

  it('does not accept look-alike hosts', () => {
    for (const host of ['reddit.com.evil.example', 'evilreddit.com', 'reddit.co', 'xn--reddit-evil.com']) {
      assert.equal(parseThreadLink(`https://${host}/r/x/comments/abc123/`), null, host);
    }
  });
});

describe('hostile input files', () => {
  it('scans a 3 MB file without slowing down', () => {
    const hostile = 'a.'.repeat(1_000_000) + 'x '.repeat(500_000);
    const started = performance.now();
    extractThreadLinks(hostile);
    assert.ok(performance.now() - started < 2000, 'took too long');
  });
});

describe('request pacing', () => {
  it('never goes below the minimum delay, whatever the settings say', () => {
    for (const delaySeconds of [0, -5, Number.NaN, '0']) {
      const runner = new ExportRunner({ request: async () => ({ status: 0 }), settings: { delaySeconds, sort: 'top', expandMore: false } });
      assert.equal(runner.settings.delaySeconds, MIN_DELAY_S);
    }
  });
});
