# Cairn

Cairn records a browser's installed extensions and its bookmarks into storage the user controls, so a browser setup can be rebuilt on another profile or device.

## Language

### Restore

**Guided restore**:
The user-driven process of bringing a profile's extensions in line with a remote inventory: the user installs each missing extension from its store page, and Cairn only records what it observes.
_Avoid_: Extension restore, reinstall, sync install

**Bookmark restore**:
Recreating a bookmark backup inside a new dated folder, without moving, renaming, or deleting anything that already exists.
_Avoid_: Bookmark sync, bookmark import

**Restore source**:
The one device a guided restore copies from, chosen by the user from the devices in the pulled inventory or an imported inventory file; it may be this device itself, as of its last upload.
_Avoid_: Baseline, remote, source device

**Restore set**:
The extensions the restore source has installed (enabled or disabled, not removed) that this profile does not already have.
_Avoid_: Missing list, diff, baseline

**Restore queue**:
The saved, per-profile list of a guided restore's items and where each stands, kept in step with the browser until the user finishes the restore.
_Avoid_: Wizard, checklist, restore session

**Pulled inventory**:
The local copy of the remote inventory as of the last Pull; Compare and guided restore both read from it.
_Avoid_: Baseline, comparison baseline, remote

**Cross-family link**:
A user-confirmed statement that a Chromium extension and a Firefox extension are the same extension, held as one record carrying both IDs.
_Avoid_: Alias confirmation, merge, match

**Match proposal**:
A cross-family link Cairn suggests from a signal such as a shared developer homepage or name; it never takes effect without the user.
_Avoid_: Possible match, suggestion, auto-match

**Enabled-state reconciliation**:
Bringing an installed extension's enabled or disabled state in line with the restore source's, through a user action whose result Cairn observes; it exists only during a guided restore.
_Avoid_: State sync, apply state, enforce

**Store page**:
An extension's listing on the Chrome Web Store or addons.mozilla.org, from which the user installs it.
_Avoid_: Source, source URL

**Developer site**:
The extension's own homepage as declared by its developer; never treated as a store page.
_Avoid_: Homepage, project page

**Store-less extension**:
An extension Cairn cannot point at a store page, carrying the reason why: bundled with the browser, unpacked, self-hosted, installed by policy, or not listed.
_Avoid_: Sideloaded, unknown source, orphan

**Observed install**:
An extension counts as installed only when the browser's extension-management API reports it under a matching ID or alias; opening its store page proves nothing.
_Avoid_: Assumed install, marked installed
