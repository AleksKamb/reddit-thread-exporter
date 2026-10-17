/**
 * Configuration from environment variables (see docs/AGENTS.md, "Configuration").
 *
 * @module config
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { URL } from 'node:url';

import { DEFAULT_EXTENSION_ID, DEFAULT_PORT } from './protocol.js';

/** This server's version, shown in exports ("Exported with … 1.3.0"). */
export const SERVER_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export const DEFAULT_INLINE_LIMIT = 60_000;

/** Chrome extension IDs are 32 letters from a to p. */
const EXTENSION_ID = /^[a-p]{32}$/;

/**
 * @typedef {object} Config
 * @property {number} port
 * @property {string[]} extensionIds  Always includes the Chrome Web Store ID.
 * @property {string} outputDir       Absolute path for saved results.
 * @property {number} inlineLimit     Results longer than this many characters are saved to a file.
 * @property {string[]} warnings      Values that were ignored, for the log.
 */

/**
 * Reads the configuration. Invalid values fall back to the defaults with a warning
 * rather than stopping the server, because the agent can't fix a startup error.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Config}
 */
export function loadConfig(env) {
  const warnings = [];

  let port = DEFAULT_PORT;
  if (env.THREAD_EXPORTER_PORT) {
    const value = Number(env.THREAD_EXPORTER_PORT);
    if (Number.isInteger(value) && value > 0 && value < 65_536) port = value;
    else warnings.push(`THREAD_EXPORTER_PORT "${env.THREAD_EXPORTER_PORT}" is not a port number; using ${DEFAULT_PORT}.`);
  }

  const extraIds = (env.THREAD_EXPORTER_EXTENSION_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  for (const id of extraIds.filter((id) => !EXTENSION_ID.test(id))) {
    warnings.push(`THREAD_EXPORTER_EXTENSION_IDS: "${id}" is not a Chrome extension ID; ignored.`);
  }

  let inlineLimit = DEFAULT_INLINE_LIMIT;
  if (env.THREAD_EXPORTER_INLINE_LIMIT) {
    const value = Number(env.THREAD_EXPORTER_INLINE_LIMIT);
    if (Number.isInteger(value) && value >= 0) inlineLimit = value;
    else warnings.push(`THREAD_EXPORTER_INLINE_LIMIT "${env.THREAD_EXPORTER_INLINE_LIMIT}" is not a number; using ${DEFAULT_INLINE_LIMIT}.`);
  }

  const outputDir = expandHome(env.THREAD_EXPORTER_OUTPUT_DIR?.trim());
  return {
    port,
    extensionIds: [...new Set([DEFAULT_EXTENSION_ID, ...extraIds.filter((id) => EXTENSION_ID.test(id))])],
    outputDir: outputDir ? resolve(outputDir) : join(homedir(), 'Downloads', 'Reddit Thread Exporter'),
    inlineLimit,
    warnings,
  };
}

/**
 * MCP clients pass environment variables as-is, without a shell to expand `~`.
 *
 * @param {string | undefined} path
 * @returns {string | undefined}
 */
function expandHome(path) {
  if (path === '~') return homedir();
  return path?.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}
