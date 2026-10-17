import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CSV_COLUMNS, EXPORT_FORMATS, headingAnchor, toCsv, toFileStem, toJson, toMarkdown, toRawJson } from '../src/lib/formatters.js';
import { normalizeThread } from '../src/lib/thread-model.js';
import { comment, sampleThread, thread } from './fixtures.js';

const meta = { exportedAt: new Date(2026, 9, 17, 14, 30), toolName: 'Thread Exporter for Reddit', toolVersion: '1.0.0' };

describe('toMarkdown', () => {
  const markdown = toMarkdown([normalizeThread(sampleThread())], meta);

  it('starts with a summary line', () => {
    assert.match(markdown, /^# Reddit threads\n\nExported 2026-10-17 with Thread Exporter for Reddit 1\.0\.0 · 1 thread · 4 comments\n/);
  });

  it('includes the thread heading, meta line and post body', () => {
    assert.match(markdown, /## r\/testing: A test thread/);
    assert.match(markdown, /42 points · 4 of 5 comments · Flair: Discussion · \[Open on Reddit\]\(https:\/\/www\.reddit\.com\/r\/testing\/comments\/post1\/a_test_thread\/\)/);
    assert.match(markdown, /What do you think\?\n\nSecond paragraph\./);
  });

  it('nests replies and keeps multi-line bodies inside their list item', () => {
    assert.match(markdown, /^- 10 points: First comment$/m);
    assert.match(markdown, /^ {2}- \*\*OP\*\* · 3 points: A reply\n {4}with two lines$/m);
  });

  it('shows removed comments that have replies', () => {
    assert.match(markdown, /^- _1 point · \[removed\]_\n {2}- 1 point: Reply to a removed comment$/m);
  });

  it('mentions hidden comments', () => {
    assert.match(markdown, /_2 more comments were behind "load more replies"/);
  });

  it('adds usernames when the thread has them', () => {
    const named = toMarkdown([normalizeThread(sampleThread(), [], { includeUsernames: true })], meta);
    assert.match(named, /^- \*\*u\/user_c1\*\* · 10 points: First comment$/m);
    assert.match(named, /\*\*u\/op_user\*\* \(OP\) · 3 points/);
  });

  it('adds a table of contents for several threads', () => {
    const second = normalizeThread(thread([], { id: 'post2', title: 'Another one?', permalink: '/r/testing/comments/post2/x/' }));
    const md = toMarkdown([normalizeThread(sampleThread()), second], meta);
    assert.match(md, /## Contents\n\n1\. \[r\/testing: A test thread\]\(#rtesting-a-test-thread\)\n2\. \[r\/testing: Another one\?\]\(#rtesting-another-one\)/);
    assert.match(md, /_No comments\._/);
  });
});

describe('toCsv', () => {
  const csv = toCsv([normalizeThread(sampleThread())]);
  const lines = csv.slice(1).trimEnd().split('\r\n');

  it('starts with a BOM and the header row', () => {
    assert.ok(csv.startsWith('\uFEFF'));
    assert.equal(lines[0], CSV_COLUMNS.join(','));
  });

  it('has one row for the post and one per comment', () => {
    assert.equal(lines.filter((line) => line.startsWith('post,')).length, 1);
    assert.equal(lines.filter((line) => line.startsWith('comment,')).length, 4);
  });

  it('quotes cells with commas, quotes and line breaks', () => {
    const tricky = normalizeThread(thread([comment('q1', 'He said "hi", then\nleft')]));
    assert.match(toCsv([tricky]), /"He said ""hi"", then\nleft"/);
  });

  it('points top-level comments at the post', () => {
    assert.match(csv, /^comment,post1,testing,A test thread,c1,post1,0,,false,10,/m);
  });
});

describe('toJson and toRawJson', () => {
  it('wraps normalized threads with export metadata', () => {
    const parsed = JSON.parse(toJson([normalizeThread(sampleThread())], meta));
    assert.equal(parsed.exportedWith, 'Thread Exporter for Reddit 1.0.0');
    assert.equal(parsed.threadCount, 1);
    assert.equal(parsed.threads[0].comments[0].replies[0].id, 'c2');
  });

  it('keeps raw listings untouched', () => {
    const raw = sampleThread();
    assert.deepEqual(JSON.parse(toRawJson([raw])), [raw]);
  });
});

describe('toFileStem', () => {
  it('cleans user input', () => {
    assert.equal(toFileStem('My research: Upwork / Fiverr.md'), 'My-research-Upwork-Fiverr');
    assert.equal(toFileStem('café notes'), 'cafe-notes');
  });

  it('falls back to a dated name', () => {
    assert.equal(toFileStem('', new Date(2026, 9, 17, 9, 5)), 'reddit-threads-2026-10-17-0905');
    assert.equal(toFileStem('///', new Date(2026, 0, 2, 3, 4)), 'reddit-threads-2026-01-02-0304');
  });
});

describe('headingAnchor', () => {
  it('matches GitHub anchors', () => {
    assert.equal(headingAnchor('r/Upwork: 157 Connects on one job!'), 'rupwork-157-connects-on-one-job');
  });
});

describe('EXPORT_FORMATS', () => {
  it('has unique IDs and extensions', () => {
    assert.equal(new Set(EXPORT_FORMATS.map((f) => f.id)).size, EXPORT_FORMATS.length);
    assert.equal(new Set(EXPORT_FORMATS.map((f) => f.extension)).size, EXPORT_FORMATS.length);
  });
});
