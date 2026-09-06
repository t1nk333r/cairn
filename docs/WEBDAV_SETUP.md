# WebDAV setup

Cairn can store its extension inventory as a JSON file in a WebDAV collection.
It works with Nextcloud, ownCloud, an nginx or Apache WebDAV mount, or any
server that supports conditional requests.

## Required values

- **Folder URL:** the collection the file lives in, such as
  `https://cloud.example.com/remote.php/dav/files/alice/cairn/`. A trailing
  slash is added for you if you leave it off. This is a folder, not the file.
- **File name:** a plain file name such as `cairn.json`. It cannot contain
  `/` or `\`, and it cannot be `.` or `..` — put directories in the folder URL
  instead. Left blank, it defaults to `cairn.json`.
- **Username** and **password**: sent as HTTP Basic credentials. Where your
  server offers app passwords, use one rather than your account password; it
  can be revoked without changing your login.

Do not put credentials in the URL. `https://alice:secret@example.com/dav/` is
rejected — the credential fields exist so the password is stored separately
from the visible settings and is not carried in a URL that could be logged.

Use HTTPS for remote servers. Plain HTTP is accepted only for `localhost` and
`127.0.0.1`, so a local server can be tested without exposing Basic
credentials on the wire.

## Bookmarks

The bookmark backup is a sibling file in the same collection, derived from the
inventory name: `cairn.json` becomes `cairn-bookmarks.json`. One configured
connection covers both; there is no second set of settings.

## How synchronization is protected

Pull records the `ETag` the server returned. Upload sends it back as
`If-Match`, so if another device changed the file first the server rejects the
stale write and Cairn asks you to pull and compare instead of overwriting it.
A first upload uses `If-None-Match: *`, which fails if a file already exists
rather than clobbering something that was already there.

This makes an ETag mandatory. A server that answers `PUT` and `GET` without one
cannot be used safely, and Cairn reports that rather than syncing blind.

## What the server has to allow

- `HEAD` and `GET` on the file, for the connection test and for pulls. A `404`
  is fine — that is simply the not-yet-created state. If `HEAD` is blocked,
  Cairn falls back to a ranged `GET`.
- `PUT` with `If-Match` and `If-None-Match`.
- An `ETag` response header on `GET` and on `PUT`, or at least on a following
  `HEAD`.

Because the extension page is not on your server's origin, the server must
also allow cross-origin requests from the extension: permit the `Authorization`
header, allow the `PUT` and `HEAD` methods, answer the `OPTIONS` preflight, and
**expose the `ETag` header** with `Access-Control-Expose-Headers`. Without that
last one the browser hides the ETag from Cairn and every write looks unsafe.

## Credentials and permissions

The password is kept apart from the visible connection settings in
browser-local extension storage, and is sent only to the origin you
configured. Cairn asks for host access to that origin at the moment you save
the connection, not up front, and credentialed requests refuse redirects
outright so a `30x` can never replay your `Authorization` header to another
host.
