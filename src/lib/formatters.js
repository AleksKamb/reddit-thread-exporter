/**
 * Export formats.
 *
 * Each formatter takes normalized {@link import('./thread-model.js').Thread} objects
 * and returns the file contents as a string. Nothing here touches the browser.
 *
 * @module formatters
 */

import { walkComments } from './thread-model.js';

/** @typedef {import('./thread-model.js').Thread} Thread */
/** @typedef {import('./thread-model.js').Comment} Comment */

/**
 * @typedef {object} ExportFormat
 * @property {string} id
 * @property {string} label
 * @property {string} extension
 * @property {string} mimeType
 * @property {string} description
 */

/** Every format the exporter can write, in the order they are shown in the UI. */
export const EXPORT_FORMATS = /** @type {const} */ ([
  {
    id: 'markdown',
    label: 'Markdown',
    extension: 'md',
    mimeType: 'text/markdown',
    description: 'Readable document with nested replies. Good for reading, notes and AI tools.',
  },
  {
    id: 'csv',
    label: 'CSV',
    extension: 'csv',
    mimeType: 'text/csv',
    description: 'One row per post and comment. Opens in Excel, Numbers and Google Sheets.',
  },
  {
    id: 'json',
    label: 'JSON',
    extension: 'json',
    mimeType: 'application/json',
    description: 'Clean, documented structure with nested replies. Good for scripts and data work.',
  },
  {
    id: 'raw',
    label: 'Raw Reddit JSON',
    extension: 'raw.json',
    mimeType: 'application/json',
    description: "Reddit's original API response, untouched. For developers.",
  },
]);

/**
 * @typedef {object} ExportMeta
 * @property {Date} exportedAt
 * @property {string} toolName
 * @property {string} toolVersion
 */

/**
 * A Markdown document: a short header, a table of contents when there is more than
 * one thread, then each thread with its post and nested comments.
 *
 * @param {Thread[]} threads
 * @param {ExportMeta} meta
 * @returns {string}
 */
export function toMarkdown(threads, meta) {
  const totalComments = threads.reduce((sum, t) => sum + t.commentCounts.exported, 0);
  const lines = [
    '# Reddit threads',
    '',
    `Exported ${formatDate(meta.exportedAt)} with ${meta.toolName} ${meta.toolVersion} · ` +
      `${plural(threads.length, 'thread')} · ${plural(totalComments, 'comment')}`,
    '',
  ];

  if (threads.length > 1) {
    lines.push('## Contents', '');
    threads.forEach((thread, index) => {
      lines.push(`${index + 1}. [${escapeInline(threadHeading(thread))}](#${headingAnchor(threadHeading(thread))})`);
    });
    lines.push('');
  }

  for (const thread of threads) {
    lines.push('---', '', `## ${threadHeading(thread)}`, '');
    lines.push(threadMetaLine(thread), '');
    if (thread.linkUrl) lines.push(`Link: <${thread.linkUrl}>`, '');
    if (thread.body.trim()) lines.push(thread.body.trim(), '');

    lines.push(`### Comments (${thread.commentCounts.exported})`, '');
    if (!thread.comments.length) lines.push('_No comments._', '');
    for (const comment of walkComments(thread.comments)) {
      lines.push(...commentToMarkdown(comment));
    }
    if (thread.commentCounts.hidden > 0) {
      const { hidden } = thread.commentCounts;
      lines.push(
        '',
        `_${plural(hidden, 'more comment')} ${hidden === 1 ? 'was' : 'were'} behind "load more replies" ` +
          'and not included. Turn on "Load hidden replies" to fetch them._',
      );
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/** Byte order mark: tells Excel the CSV is UTF-8. */
const UTF8_BOM = '\uFEFF';

/** Columns of the CSV export, in order. */
export const CSV_COLUMNS = /** @type {const} */ ([
  'type',
  'thread_id',
  'subreddit',
  'thread_title',
  'id',
  'parent_id',
  'depth',
  'author',
  'is_op',
  'score',
  'created_at',
  'body',
  'url',
]);

/**
 * A CSV file with one row for each post and each comment. It starts with a UTF-8 BOM
 * and uses CRLF line endings so Excel opens it with the right encoding.
 *
 * @param {Thread[]} threads
 * @returns {string}
 */
export function toCsv(threads) {
  const rows = [CSV_COLUMNS];
  for (const thread of threads) {
    rows.push([
      'post',
      thread.id,
      thread.subreddit,
      thread.title,
      thread.id,
      '',
      '',
      thread.author ?? '',
      'true',
      thread.score,
      thread.createdAt,
      thread.linkUrl ? `${thread.linkUrl}\n\n${thread.body}`.trim() : thread.body,
      thread.url,
    ]);
    for (const comment of walkComments(thread.comments)) {
      rows.push([
        'comment',
        thread.id,
        thread.subreddit,
        thread.title,
        comment.id,
        comment.parentId ?? thread.id,
        comment.depth,
        comment.author ?? '',
        String(comment.isSubmitter),
        comment.score,
        comment.createdAt,
        comment.isRemoved ? '[removed]' : comment.body,
        comment.url,
      ]);
    }
  }
  return `${UTF8_BOM}${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/**
 * The clean JSON export: export metadata plus the normalized threads.
 *
 * @param {Thread[]} threads
 * @param {ExportMeta} meta
 * @returns {string}
 */
export function toJson(threads, meta) {
  return `${JSON.stringify(
    {
      exportedAt: meta.exportedAt.toISOString(),
      exportedWith: `${meta.toolName} ${meta.toolVersion}`,
      threadCount: threads.length,
      threads,
    },
    null,
    2,
  )}\n`;
}

/**
 * Reddit's own responses, one per thread, in a JSON array.
 *
 * @param {unknown[]} listings
 * @returns {string}
 */
export function toRawJson(listings) {
  return `${JSON.stringify(listings)}\n`;
}

/**
 * A safe file name stem: letters, digits, dashes, dots and underscores only.
 *
 * @param {string} name
 * @param {Date} [now]
 * @returns {string}
 */
export function toFileStem(name, now = new Date()) {
  const cleaned = String(name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\.(md|csv|json)$/i, '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return cleaned || `reddit-threads-${formatDate(now)}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/* ------------------------------------------------------------------------ */

/**
 * @param {Comment} comment
 * @returns {string[]}
 */
function commentToMarkdown(comment) {
  const indent = '  '.repeat(comment.depth);
  const who = comment.author ? `**u/${comment.author}**${comment.isSubmitter ? ' (OP)' : ''} · ` : comment.isSubmitter ? '**OP** · ' : '';
  const label = `${who}${comment.score} ${Math.abs(comment.score) === 1 ? 'point' : 'points'}`;

  if (comment.isRemoved) return [`${indent}- _${label} · [removed]_`];

  const [first, ...rest] = comment.body.split(/\r?\n/);
  return [
    `${indent}- ${label}: ${first}`,
    ...rest.map((line) => (line.trim() ? `${indent}  ${line}` : '')),
  ];
}

/** @param {Thread} thread */
function threadHeading(thread) {
  return `r/${thread.subreddit}: ${thread.title}`;
}

/** @param {Thread} thread */
function threadMetaLine(thread) {
  const parts = [
    thread.createdAt ? formatDate(new Date(thread.createdAt)) : null,
    thread.author ? `u/${thread.author}` : null,
    plural(thread.score, 'point'),
    thread.commentCounts.reported === thread.commentCounts.exported
      ? plural(thread.commentCounts.exported, 'comment')
      : `${thread.commentCounts.exported} of ${plural(thread.commentCounts.reported, 'comment')}`,
    thread.flair ? `Flair: ${thread.flair}` : null,
    `[Open on Reddit](${thread.url})`,
  ];
  return parts.filter(Boolean).join(' · ');
}

/**
 * The anchor GitHub generates for a heading, so the table of contents links work.
 *
 * @param {string} heading
 * @returns {string}
 */
export function headingAnchor(heading) {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

/** Escapes characters that would break a Markdown link label. */
function escapeInline(text) {
  return text.replace(/([[\]\\])/g, '\\$1');
}

/** Quotes a CSV cell when it contains a comma, quote or line break. */
function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** @param {Date} date */
function formatDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** @param {number} value */
function pad(value) {
  return String(value).padStart(2, '0');
}

/**
 * @param {number} count
 * @param {string} noun  Singular form.
 */
function plural(count, noun) {
  return `${count.toLocaleString('en-US')} ${noun}${Math.abs(count) === 1 ? '' : 's'}`;
}
