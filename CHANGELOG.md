# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [1.3.1] - 2026-10-17

### Added

- **One-click agent switch in the popup.** The pill next to the name turns agent access on and off and shows its state: off, on (waiting for the MCP server), connected, or working.

## [1.3.0] - 2026-10-17

### Added

- **Agent access (MCP).** A local MCP server in `mcp/` lets Claude Code, Claude Desktop, Cursor and other MCP clients use the extension: `find_threads`, `export_threads`, `get_exported_threads`, `add_to_queue`, `get_queue` and `get_status`. The extension still does the fetching in your Chrome.
- **Agent limits you control:** off by default, a daily limit, a limit per request, an optional approval window for every export, an **AI** toolbar badge and progress while an agent works, and a log of agent requests. Agents can't change these settings.
- **Batch breaks:** a longer pause after every batch of threads (batch size and break length in Options). Applies to manual and agent exports.
- Reddit search support (`find_threads`).

### Changed

- The extension now has a fixed ID (`jjgnebbldngnhpdglbfiddkocigddhlb`), so the MCP server can trust it. If you loaded an earlier version unpacked, Chrome treats this as a new extension: your old queue and settings stay with the old copy, which you can remove.
- Manual and agent exports never run at the same time.

## [1.2.0] - 2026-10-17

### Added

- **Upload from the popup.** The upload icon next to the popup's paste field opens the overview on *Upload file*, with the drop zone highlighted and ready. (Chrome closes a popup while a file picker is open, so the picker itself opens on the page.)

## [1.1.0] - 2026-10-17

### Added

- **Toolbar popup** with quick settings: add the thread in the current tab, paste links, see queue counts and live export progress, change formats, comment order, pause, hidden replies and usernames, then export or open the overview.
- Commands from the popup reach an open exporter tab directly (start the export, open the help).
- `SECURITY.md` with the threat model and how to report a vulnerability, and Dependabot for dependency updates.

### Changed

- New look: airy cards, soft tinted panels, floating pills, a glowing progress orb and gradient buttons in Reddit orange. Shared theme and icon sprite for the page and the popup.
- Queue rows show a subreddit avatar and the comment count; formats are picked from icon tiles.
- Host access narrowed to `www.`, `old.` and `new.reddit.com`.

### Security

- CSV exports neutralise cells that spreadsheets would run as formulas.
- Links in exports are restricted to reddit.com permalinks and `http`/`https` link posts.
- Strict content security policy for extension pages; ESLint now forbids `innerHTML`, `eval` and similar.
- Bounded link-scanning patterns so huge or hostile files can't freeze the page.
- A minimum pause between requests is enforced regardless of stored settings.

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
