# Security

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Use GitHub's private
[security advisory form](https://github.com/AleksKamb/reddit-thread-exporter/security/advisories/new)
instead. You'll get an answer within a week, and a fix as soon as one is ready.

## How the extension is protected

The extension handles two kinds of untrusted input: content from Reddit (titles, comments,
links) and files you upload. It's built so neither can run code or reach anything else.

| Risk | Protection |
| --- | --- |
| Script injection from Reddit content | Reddit text is only ever written with `textContent`. ESLint forbids `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` and `eval` in the codebase. |
| Remote or inline scripts | A strict content security policy on all extension pages: `script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`. There are no remote scripts, fonts or styles, and no runtime dependencies. |
| Other websites or extensions talking to it | No `externally_connectable` and no `web_accessible_resources`, so web pages can't load extension pages or send them messages. Internal messages are checked against the extension's own ID. |
| Formulas in CSV exports ("CSV injection") | Text cells that start with `=`, `+`, `-`, `@`, tab or carriage return get a leading `'`, so Excel and Sheets show them as text. |
| Links to other sites in exports | Permalinks must be plain reddit.com paths, and link posts are only kept when they're `http`/`https` URLs, so `javascript:` or protocol-relative links never reach an export. |
| Look-alike domains | Only `reddit.com`, its subdomains and `redd.it` are accepted. `reddit.com.evil.example` and similar are rejected (covered by tests). |
| Slow or hostile files | Uploads are capped at 5 MB, and the link scanner uses bounded patterns, so a crafted file can't freeze the page. |
| Flooding Reddit | One request at a time, a minimum pause enforced in code even if stored settings are tampered with, and Reddit's rate-limit headers are respected. |
| Over-broad access | Host access is limited to `www.`, `old.` and `new.reddit.com`. The extension never reads cookies, history or other sites. |
| Websites driving the agent bridge | The MCP hub only listens on `127.0.0.1` and checks the `Host` header (no DNS rebinding). The extension side must present `Origin: chrome-extension://jjgnebbldngnhpdglbfiddkocigddhlb`; agent clients must send no `Origin` at all, which every browser does, so web pages can't connect. |
| Agents doing more than you allow | Agent access is off by default. The daily limit, per-request limit, pacing, batch breaks and optional approvals are enforced inside the extension, and agents have no tool to change settings. Manual and agent exports never overlap. |

`npm run check` verifies the manifest keeps these settings, and `test/security.test.js` covers the
input handling.

## Supported versions

Only the latest release gets fixes.
