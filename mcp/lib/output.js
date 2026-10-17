/**
 * Turns raw threads from the extension into export text, with the same code the
 * extension uses for its files, and saves large results to disk.
 *
 * @module output
 */

import { Buffer } from 'node:buffer';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { EXPORT_FORMATS, toCsv, toFileStem, toJson, toMarkdown } from '../../src/lib/formatters.js';
import { normalizeThread } from '../../src/lib/thread-model.js';
import { SERVER_VERSION } from './config.js';

/** @typedef {import('../../src/lib/thread-model.js').Thread} Thread */
/** @typedef {'markdown' | 'json' | 'csv'} FormatId */

/** Formats agents can ask for. "Raw JSON" stays an extension-only option. */
export const AGENT_FORMATS = /** @type {const} */ (['markdown', 'json', 'csv']);

export const TOOL_NAME = 'Thread Exporter for Reddit (MCP)';

/** Excel needs the byte order mark in a file, but in inline text it is just noise. */
const UTF8_BOM = '﻿';

/**
 * @typedef {object} RawThread
 * @property {string} link
 * @property {{ listing: unknown, extraThings?: unknown[] }} data
 */

/**
 * Normalizes raw threads. A response that is not a thread fails on its own instead
 * of failing the whole export.
 *
 * @param {RawThread[]} rawThreads
 * @param {{ includeUsernames: boolean }} options
 * @returns {{ threads: Thread[], failures: { link: string, error: string }[] }}
 */
export function normalizeThreads(rawThreads, { includeUsernames }) {
  const threads = [];
  const failures = [];
  for (const { link, data } of rawThreads) {
    try {
      threads.push(normalizeThread(data?.listing, Array.isArray(data?.extraThings) ? data.extraThings : [], { includeUsernames }));
    } catch {
      failures.push({ link, error: 'The extension returned data that is not a Reddit thread.' });
    }
  }
  return { threads, failures };
}

/**
 * @param {Thread[]} threads
 * @param {FormatId} formatId
 * @param {Date} exportedAt
 * @returns {string}
 */
export function formatThreads(threads, formatId, exportedAt) {
  const meta = { exportedAt, toolName: TOOL_NAME, toolVersion: SERVER_VERSION };
  if (formatId === 'csv') return toCsv(threads);
  if (formatId === 'json') return toJson(threads, meta);
  return toMarkdown(threads, meta);
}

/**
 * @param {FormatId} formatId
 * @returns {(typeof EXPORT_FORMATS)[number]}
 */
export function getFormat(formatId) {
  return EXPORT_FORMATS.find((format) => format.id === formatId) ?? EXPORT_FORMATS[0];
}

/**
 * @typedef {object} Delivery
 * @property {'inline' | 'file'} kind
 * @property {string} text  The export for `inline`; for `file`, a note with the path and size.
 */

/**
 * Returns the export inline, or saves it and returns where it went. Long results go
 * to a file because they would crowd out the agent's context.
 *
 * @param {string} content
 * @param {object} options
 * @param {FormatId} options.formatId
 * @param {boolean} [options.saveToFile]
 * @param {number} options.inlineLimit
 * @param {string} options.outputDir
 * @param {Date} options.now
 * @returns {Promise<Delivery>}
 */
export async function deliver(content, { formatId, saveToFile = false, inlineLimit, outputDir, now }) {
  const tooLong = content.length > inlineLimit;
  if (!saveToFile && !tooLong) {
    return { kind: 'inline', text: content.startsWith(UTF8_BOM) ? content.slice(UTF8_BOM.length) : content };
  }

  const path = await saveExport(content, { formatId, outputDir, now });
  const format = getFormat(formatId);
  const why = saveToFile ? 'as requested' : `because it is longer than ${inlineLimit.toLocaleString('en-US')} characters`;
  return {
    kind: 'file',
    text:
      `Saved the ${format.label} export ${why}:\n${path}\n` +
      `Size: ${formatBytes(Buffer.byteLength(content))}, ${content.length.toLocaleString('en-US')} characters. ` +
      'Read the file to work with the threads.',
  };
}

/**
 * Writes the export to `<outputDir>/agent-<stem>.<ext>`. Existing files are never
 * overwritten: `-2`, `-3`… are added until a name is free.
 *
 * @param {string} content
 * @param {{ formatId: FormatId, outputDir: string, now: Date }} options
 * @returns {Promise<string>} The absolute path.
 */
export async function saveExport(content, { formatId, outputDir, now }) {
  await mkdir(outputDir, { recursive: true });
  const stem = `agent-${toFileStem('', now)}`;
  const { extension } = getFormat(formatId);

  for (let attempt = 1; ; attempt += 1) {
    const path = join(outputDir, `${stem}${attempt > 1 ? `-${attempt}` : ''}.${extension}`);
    try {
      // `wx` fails if the file exists, so two sessions saving at the same minute can't clobber each other.
      await writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
      return path;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error;
    }
  }
}

/**
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
