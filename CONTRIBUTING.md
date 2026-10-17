# Contributing

Thanks for taking the time to improve Thread Exporter. Bug reports, ideas and pull requests are all welcome.

## Reporting a problem

[Open an issue](https://github.com/AleksKamb/reddit-thread-exporter/issues/new/choose) and include the lines from the **Activity log** (under the Export panel) around the problem. They say exactly what Reddit answered.

## Working on the code

The extension is plain JavaScript (ES modules) with no build step and no runtime dependencies. Node is only used for linting and tests.

```bash
git clone https://github.com/AleksKamb/reddit-thread-exporter.git
cd reddit-thread-exporter
npm install
npm run check      # lint + unit tests + manifest check
```

Load it in Chrome:

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick the repository folder.
3. After changing code, click the reload icon on the extension's card, then reload the exporter tab. To inspect the popup, right-click the toolbar button and choose **Inspect popup**.

The service worker's console is under **Inspect views: service worker** on the same card.

## Guidelines

- **Keep logic testable.** Anything that doesn't need Chrome APIs belongs in `src/lib/` as a pure function, with tests in `test/`. Chrome-specific code stays thin (`reddit-tab.js`, `store.js`, `app-tab.js`, `background.js`, `app.js`, `popup.js`).
- **Share the design.** Colours, buttons, inputs, pills and orbs live in `src/shared/theme.css`, icons in `src/shared/icons.svg`. Use the tokens instead of hard-coded colours.
- **Never put Reddit content into HTML.** Use `textContent` and DOM methods. Titles and comments are untrusted input, and ESLint rejects `innerHTML` and friends. See [SECURITY.md](SECURITY.md).
- **Be gentle with Reddit.** Don't lower the minimum delay or add parallel requests.
- **Match the style.** Small functions with descriptive names, JSDoc on exported functions, comments that explain _why_. Run `npm run lint` before you push.
- **Update the docs** (`README.md`, the in-app help in `src/app/index.html`, and `CHANGELOG.md`) when behaviour changes.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit together.

## Releasing

1. Bump `version` in both `manifest.json` and `package.json` (`npm run check` fails if they differ).
2. Add a section to `CHANGELOG.md`.
3. `npm run package` builds `dist/reddit-thread-exporter-v<version>.zip`.
4. Tag `v<version>`, push, and attach the zip to a GitHub release.
