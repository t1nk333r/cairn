import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Firefox reads `update_url` from the manifest of the build a user already has,
// fetches that JSON, and offers the highest listed version. The failure mode is
// silent in both directions: a release missing from updates.json is a release
// nobody can reach, and a bad update_link is an update that fails behind the
// scenes. Neither shows up in a build, a typecheck, or a manual click-through,
// so it is asserted here.

const root = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(root, 'updates.json'), 'utf8'));

interface UpdateEntry {
  version: string;
  update_link: string;
  applications?: { gecko?: { strict_min_version?: string } };
}

const identity = pkg.cairn as {
  geckoId: string;
  strictMinVersion: string;
  updateManifestUrl: string;
  releaseDownloadBase: string;
};

const updates: UpdateEntry[] = manifest.addons?.[identity.geckoId]?.updates ?? [];

describe('the self-hosted update manifest', () => {
  it('is keyed by the shipping add-on id', () => {
    expect(Object.keys(manifest.addons)).toEqual([identity.geckoId]);
  });

  it('lists the version in package.json', () => {
    // `npm version` regenerates this file and stages it. A release cut without
    // that step leaves every existing install with nothing to update to.
    expect(updates.map((update) => update.version)).toContain(pkg.version);
  });

  it('points every version at its signed release asset over https', () => {
    expect(updates.length).toBeGreaterThan(0);
    for (const update of updates) {
      expect(update.update_link).toBe(
        `${identity.releaseDownloadBase}/v${update.version}/cairn-${update.version}.xpi`,
      );
      // Mozilla requires update_hash for plain http; staying on https keeps
      // the manifest simple and the download verified by TLS.
      expect(update.update_link.startsWith('https://')).toBe(true);
    }
  });

  it('declares the same minimum Firefox as the extension manifest', () => {
    for (const update of updates) {
      expect(update.applications?.gecko?.strict_min_version).toBe(identity.strictMinVersion);
    }
  });

  it('lists each version once', () => {
    const versions = updates.map((update) => update.version);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('serves the manifest itself over https', () => {
    expect(identity.updateManifestUrl.startsWith('https://')).toBe(true);
  });
});
