/**
 * Error messages for agents: what went wrong, in plain English, and what to do next.
 *
 * @module errors
 */

import { BridgeError } from './protocol.js';

const CONNECT_STEPS =
  'Ask the user to open Chrome with Thread Exporter for Reddit enabled, open the exporter, find Agent access and switch on "Allow agents". ' +
  'Then call get_status to check the connection and try again.';

/** What the agent should do next, by error code. */
const NEXT_STEPS = {
  EXTENSION_NOT_CONNECTED: `The Thread Exporter extension is not connected. ${CONNECT_STEPS}`,
  EXTENSION_DISCONNECTED:
    'The extension disconnected before it finished (Chrome closed, the extension reloaded, or agent access was switched off). ' +
    'Call get_status; once it shows the extension as connected, retry the request.',
  AGENTS_DISABLED: `Agent access is switched off in the extension. ${CONNECT_STEPS}`,
  BUSY:
    'The extension is busy with another export (started by the user or another agent). Wait a minute or two and retry; ' +
    'get_status shows when it is idle.',
  DAILY_LIMIT:
    "The user's daily limit for agent requests doesn't cover this. If some are left (get_status shows how many), ask for fewer threads; otherwise do not retry today. Tell the user; only they can raise the limit, under Agent access in the extension.",
  TOO_MANY_THREADS:
    'This request has more threads than the user allows per agent request. Call get_status to see the limit, split the links into smaller batches and send them one call at a time.',
  NO_THREADS:
    'None of the links point to a Reddit thread. Pass links like https://www.reddit.com/r/<subreddit>/comments/<id>/…, or use find_threads to find threads first.',
  DENIED:
    'The user declined this request in the extension (or did not answer the approval prompt within two minutes). Do not retry unless the user asks you to.',
  RATE_LIMITED: 'Reddit is limiting how fast requests can be made. Wait a few minutes before retrying, and ask for fewer threads at a time.',
  BLOCKED:
    'Reddit showed a login or verification page instead of data. Ask the user to open reddit.com in Chrome, log in or finish any check it shows, then retry.',
  BAD_RESPONSE: 'Reddit answered with something unexpected. Retry once; if it fails again, tell the user.',
  BAD_REQUEST: 'The extension rejected the request as invalid. Check the arguments and try again.',
  UNKNOWN_METHOD:
    'The installed extension does not support this tool. Ask the user to update Thread Exporter for Reddit to the latest version.',
  INTERNAL: 'The extension hit an unexpected error. Retry once; if it fails again, tell the user.',
  TIMEOUT:
    'The extension did not answer in time. Call get_status to check that it is still connected and idle, then retry with fewer threads.',
};

/**
 * @param {unknown} error
 * @returns {string}
 */
export function describeError(error) {
  if (error instanceof BridgeError) {
    const nextStep = NEXT_STEPS[/** @type {keyof typeof NEXT_STEPS} */ (error.code)];
    const details = error.message ? `${error.code}: ${error.message}` : error.code;
    return nextStep ? `${details}\n\n${nextStep}` : details;
  }
  // Unexpected errors (a full disk, a bug) are logged with their stack on stderr; the agent gets the message only.
  const message = error instanceof Error ? error.message : String(error);
  return `The Thread Exporter MCP server hit an unexpected error: ${message}\n\nRetry once; if it fails again, tell the user.`;
}

/**
 * An MCP tool result for an error.
 *
 * @param {unknown} error
 * @returns {{ isError: true, content: [{ type: 'text', text: string }] }}
 */
export function errorResult(error) {
  return { isError: true, content: [{ type: 'text', text: describeError(error) }] };
}
