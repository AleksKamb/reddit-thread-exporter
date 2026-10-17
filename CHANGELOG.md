# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

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
