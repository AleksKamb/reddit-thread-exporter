/**
 * Sanity checks that catch packaging mistakes before they reach Chrome:
 * every file the manifest points at exists, versions match, and locale keys resolve.
 *
 * Usage: node scripts/check-manifest.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const readJson = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));

const manifest = readJson('manifest.json');
const pkg = readJson('package.json');
const messages = readJson(`_locales/${manifest.default_locale}/messages.json`);
const problems = [];

if (manifest.manifest_version !== 3) problems.push('manifest_version must be 3.');
if (!/object-src 'none'/.test(manifest.content_security_policy?.extension_pages ?? '')) problems.push("The extension CSP should set object-src 'none'.");
if (manifest.externally_connectable) problems.push('externally_connectable is set: other sites or extensions could message this one.');
if (manifest.web_accessible_resources) problems.push('web_accessible_resources is set: websites could load extension files.');
if (manifest.version !== pkg.version) problems.push(`manifest.json version ${manifest.version} ≠ package.json version ${pkg.version}.`);

const files = [
  manifest.background.service_worker,
  'src/app/index.html',
  manifest.action.default_popup,
  'src/shared/theme.css',
  'src/shared/icons.svg',
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
];
for (const file of files) if (!existsSync(join(root, file))) problems.push(`Missing file: ${file}`);

for (const value of [manifest.name, manifest.description, manifest.action.default_title]) {
  const key = /^__MSG_(\w+)__$/.exec(value)?.[1];
  if (key && !messages[key]) problems.push(`Missing locale message: ${key}`);
}
if (messages.extDescription?.message.length > 132) problems.push('extDescription is longer than 132 characters (Chrome Web Store limit).');

if (problems.length) {
  console.error(`✖ ${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`✔ manifest.json is valid (v${manifest.version}, ${files.length} files checked).`);
