/**
 * Builds the zip that is attached to GitHub releases and uploaded to the Chrome Web Store.
 * Only the files the extension needs are included: no tests, docs or tooling.
 *
 * Usage: npm run package   →   dist/reddit-thread-exporter-v<version>.zip
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const { version } = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const out = join(root, 'dist', `reddit-thread-exporter-v${version}.zip`);

mkdirSync(join(root, 'dist'), { recursive: true });
rmSync(out, { force: true });
execFileSync('zip', ['-r', '-q', '-X', out, 'manifest.json', '_locales', 'icons', 'src', 'LICENSE', '-x', '*.DS_Store'], {
  cwd: root,
  stdio: 'inherit',
});
console.log(`✔ ${out.replace(root, '')}`);
