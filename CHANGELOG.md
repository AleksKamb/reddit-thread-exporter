# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-10-17

First public release.

### Added

- Add threads by pasting links, uploading a CSV/TSV/TXT/Markdown/JSON file, picking open Reddit tabs, or right-clicking a thread link.
- Recognises full URLs, old/new/np/mobile Reddit, comment permalinks, `redd.it` short links, app share links (`/r/<sub>/s/<code>`) and bare `/r/…/comments/…` paths.
- Export to Markdown, CSV, clean JSON and raw Reddit JSON, or copy the Markdown to the clipboard.
- Options for comment order, pause between requests, loading hidden replies, including usernames, automatic download and file name.
- Runs requests inside a reddit.com tab with the browser's own session, and opens a background tab when none is open.
- Waits out rate limits (HTTP 429) and announced request budgets, and retries temporary server errors.
- Pause, resume and stop. Finished threads are stored and survive a closed tab.
- Built-in help with troubleshooting, light and dark themes, keyboard support and a responsive layout.
