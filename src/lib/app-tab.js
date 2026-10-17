/**
 * Opening the exporter page, shared by the background worker and the toolbar popup.
 *
 * There is only ever one exporter tab: if it's already open it's focused, and a
 * command (start an export, show the help) is sent to it as a runtime message.
 *
 * @module app-tab
 */

export const APP_PATH = 'src/app/index.html';

/** Message type the exporter page listens for. */
export const APP_COMMAND = 'thread-exporter/app-command';

/**
 * @typedef {object} AppCommand
 * @property {boolean} [start]    Start exporting the queue.
 * @property {boolean} [help]     Open the help dialog.
 * @property {boolean} [upload]   Show the "Upload file" area, ready for a file.
 * @property {boolean} [welcome]  Show the first-run welcome banner (new tab only).
 */

/**
 * Focuses the exporter tab, or opens it, and passes along a command.
 *
 * @param {AppCommand} [command]
 */
export async function openApp(command = {}) {
  const appUrl = chrome.runtime.getURL(APP_PATH);
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
  const existing = contexts.find((context) => context.documentUrl?.startsWith(appUrl) && context.tabId >= 0);

  if (existing) {
    await chrome.tabs.update(existing.tabId, { active: true });
    if (existing.windowId >= 0) await chrome.windows.update(existing.windowId, { focused: true });
    if (command.start || command.help || command.upload) {
      const message = { type: APP_COMMAND, start: Boolean(command.start), help: Boolean(command.help), upload: Boolean(command.upload) };
      await chrome.runtime.sendMessage(message).catch(() => {});
    }
    return;
  }

  const params = new URLSearchParams();
  if (command.welcome) params.set('welcome', '1');
  if (command.start) params.set('start', '1');
  if (command.help) params.set('help', '1');
  if (command.upload) params.set('upload', '1');
  const query = params.size ? `?${params}` : '';
  await chrome.tabs.create({ url: `${appUrl}${query}` });
}

/**
 * Whether a runtime message is an app command sent by this extension.
 * Messages from anywhere else are ignored.
 *
 * @param {unknown} message
 * @param {chrome.runtime.MessageSender} sender
 * @returns {message is { type: string, start: boolean, help: boolean, upload: boolean }}
 */
export function isAppCommand(message, sender) {
  return sender.id === chrome.runtime.id && typeof message === 'object' && message !== null && /** @type {any} */ (message).type === APP_COMMAND;
}
