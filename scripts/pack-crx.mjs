// Packs and signs the Chromium build as dist/cairn-<version>.crx.
//
// The signing key *is* the extension id: Chromium derives the id from the
// public key, so signing a release with a different key publishes what looks
// like a different extension and every existing user has to reinstall by hand.
// keys/cairn.pem is therefore the one key that may ever sign Cairn, and this
// script recomputes the id from whatever key it was handed and refuses to write
// an artifact unless it matches package.json's cairn.crxId. A wrong-key .crx is
// worse than no .crx, because it installs cleanly and only breaks updates.
//
// crx3 is a real devDependency rather than an `npx --yes` fetch so a release
// can be cut offline and pins the exact packer that produced earlier releases.

import { createHash, createPublicKey } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = require(join(root, 'package.json'));

const { crxId } = pkg.cairn ?? {};
if (!crxId) {
  throw new Error('package.json "cairn" must set crxId, the extension id this key is expected to yield');
}

const keyPath = join(root, 'keys', 'cairn.pem');
const unpacked = join(root, '.output', 'chrome-mv3');
const outDir = join(root, 'dist');
const outPath = join(outDir, `cairn-${pkg.version}.crx`);

// Chromium's id: SHA-256 of the SubjectPublicKeyInfo DER, first 16 bytes, hex,
// with each digit shifted from 0-f into a-p (ids predate base16 being legal in
// a hostname-like identifier).
const extensionId = (pem) => {
  const der = createPublicKey(pem).export({ type: 'spki', format: 'der' });
  return createHash('sha256')
    .update(der)
    .digest('hex')
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)));
};

if (!existsSync(keyPath)) {
  throw new Error(`No signing key at ${keyPath}. It is gitignored; restore it from wherever you keep it.`);
}

// Checked before packing: a mismatch must leave no artifact behind that someone
// could publish by accident.
const actualId = extensionId(readFileSync(keyPath));
if (actualId !== crxId) {
  console.error(`${keyPath} yields extension id ${actualId}, but Cairn is ${crxId}.`);
  console.error('This is the wrong signing key. Publishing under a different id forces a manual');
  console.error('reinstall for every existing user, and the old install would never update again.');
  process.exit(1);
}

const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status ?? result.signal}`);
  }
};

// Rebuilt when the directory is missing *or* holds another version: a leftover
// .output from before a version bump packs happily, and the resulting
// cairn-<new>.crx would ship the previous release's code under the new tag.
const builtVersion = () => {
  try {
    return JSON.parse(readFileSync(join(unpacked, 'manifest.json'), 'utf8')).version;
  } catch {
    return null;
  }
};

if (builtVersion() !== pkg.version) {
  console.log(`.output/chrome-mv3 is missing or not ${pkg.version}; building it first.`);
  run('npm', ['run', 'build']);
  if (builtVersion() !== pkg.version) {
    throw new Error(`the build produced ${builtVersion()}, not ${pkg.version}`);
  }
}

mkdirSync(outDir, { recursive: true });

// crx3's bin is invoked through node rather than the shim so this works the
// same on a machine where node_modules/.bin is not on PATH.
run(process.execPath, [require.resolve('crx3/bin/crx3.js'), '-p', keyPath, '-o', outPath, unpacked]);

console.log(`${outPath} — ${statSync(outPath).size} bytes, extension id ${actualId}`);
