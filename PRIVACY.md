# Privacy policy

_Last updated: 17 October 2026 (v1.3.0)_

Thread Exporter for Reddit is a browser extension that exports Reddit threads you choose into files on your computer. It is built to collect as little as possible, and it collects nothing about you.

## What the extension does not do

- It has **no server**. Nothing you export is sent to the developer or to any third party.
- It has **no analytics, telemetry, ads or tracking**.
- It does **not read your Reddit account**, messages, votes or browsing history.
- It does **not run on any website** except reddit.com, and on reddit.com only when you start an export.

## What it stores, and where

Everything is stored locally in your browser with `chrome.storage.local`:

| Data | Why | How to delete it |
| --- | --- | --- |
| The queue: thread links, titles and export status | So the queue survives closing the tab | Remove items, or **Clear all** |
| Downloaded thread data (post and comments) | So you can download the files again without re-fetching | **Clear exported** or **Clear all** |
| Your settings (formats, options, theme) | So you don't have to set them each time | Remove the extension |

Exported files are saved to your Downloads folder like any other download. They are yours, and the extension never reads them again.

## Network requests

The extension only talks to `reddit.com`, and only to fetch the threads you added. Requests are made from inside a reddit.com tab, the same way Reddit's own pages load comments, so they carry your normal reddit.com cookies. Those cookies stay in the browser: the extension never reads, copies or sends them anywhere.

## Usernames

Exports leave usernames out by default. If you turn on **Include usernames**, author names are written into your exported files. Please handle those files with care and respect the people who wrote the comments.

## Permissions

| Permission | Used for |
| --- | --- |
| Access to `www.`, `old.` and `new.reddit.com` | Fetching the threads you added from a reddit.com tab, and offering the thread you're viewing in the popup |
| `scripting` | Running that fetch inside the reddit.com tab |
| `storage`, `unlimitedStorage` | Keeping the queue, settings and downloaded threads on your computer |
| `downloads` | Saving the exported files to `Downloads/Reddit Thread Exporter/` |
| `contextMenus` | The "Add thread to Thread Exporter" right-click item |
| `alarms` | Checking once a minute for the local MCP server, only while agent access is on |

## AI agents

Agent access is off by default. When you switch it on, the extension connects to an MCP server running on your own computer (`127.0.0.1`), and threads that agents request are passed to that local server and on to the agent you run. Where the agent sends them next depends on that agent (for example, a cloud AI model). Nothing goes to the developer of this extension. Agent requests, their counts and a short activity log are stored locally.

## Contact

Questions or concerns: [open an issue](https://github.com/AleksKamb/reddit-thread-exporter/issues).
