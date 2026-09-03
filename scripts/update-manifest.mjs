// Regenerates updates.json, the JSON update manifest Firefox polls to discover
// new self-hosted releases.
//
// Firefox reads `browser_specific_settings.gecko.update_url` from the manifest
// of the *installed* build, fetches that URL, and looks for the highest listed
// version it is compatible with. A build with no update_url never checks, and a
// version missing from this file is a version no existing install can reach.
// That makes this file part of the release, not an afterthought: `npm version`
// runs this script and stages the result, so the bump commit always carries it.
//
// Older entries are kept. Firefox picks the newest compatible one, and leaving
// history in place means a user on an ancient build still finds a path forward.

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = require(join(root, 'package.json'));

const { geckoId, strictMinVersion, releaseDownloadBase } = pkg.cairn ?? {};
if (!geckoId || !strictMinVersion || !releaseDownloadBase) {
  throw new Error('package.json "cairn" must set geckoId, strictMinVersion and releaseDownloadBase');
}

const manifestPath = join(root, 'updates.json');

// The signed asset the release workflow publishes: cairn-<version>.xpi under
// the v<version> tag. Keep this in step with the workflow's `mv` target.
const updateLink = (version) =>
  `${releaseDownloadBase}/v${version}/cairn-${version}.xpi`;

const entry = (version) => ({
  version,
  update_link: updateLink(version),
  applications: { gecko: { strict_min_version: strictMinVersion } },
});

let existing = [];
try {
  const current = JSON.parse(readFileSync(manifestPath, 'utf8'));
  existing = current.addons?.[geckoId]?.updates ?? [];
} catch (cause) {
  if (cause.code !== 'ENOENT') throw cause;
}

const updates = existing.filter((update) => update.version !== pkg.version);
updates.push(entry(pkg.version));

// Ascending by version so the file reads as a history. Firefox does not care
// about order, but a diff should show one appended line per release.
const parse = (version) => version.split('.').map((part) => Number(part) || 0);
updates.sort((left, right) => {
  const a = parse(left.version);
  const b = parse(right.version);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  }
  return 0;
});

writeFileSync(
  manifestPath,
  `${JSON.stringify({ addons: { [geckoId]: { updates } } }, null, 2)}\n`,
);

console.log(`updates.json now lists ${updates.length} version(s), newest ${pkg.version}`);
