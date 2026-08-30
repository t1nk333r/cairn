# Third-party notices

## Bookmarkora

hsync's product structure and architecture are informed by Bookmarkora:

- Project: https://github.com/gygy/Bookmarkora
- License: MIT
- Copyright: Bookmarkora contributors

No minified release code has been copied into hsync. If source code is directly
reused later, its copyright and complete MIT license notice must be retained in
the relevant source distribution.

## helium-sync-git / helium-sync

hsync's optional native-companion design is informed by helium-sync-git and its
upstream helium-sync project:

- Fork: https://github.com/mdeloughry/helium-sync-git
- Upstream: https://github.com/stonespren/helium-sync
- License: MIT
- Copyright: 2026 stonespren

No source from these projects has been copied into hsync at this stage. If a
specific implementation is reused, its MIT copyright and permission notice
must accompany the copied portion.

## hsyncd keyring dependencies

The optional companion links the following Go modules for operating-system
credential storage:

- `github.com/zalando/go-keyring` — MIT, copyright Zalando SE;
- `github.com/danieljoos/wincred` — MIT, copyright Daniel Joos;
- `github.com/godbus/dbus/v5` — BSD-2-Clause, copyright its contributors;
- `golang.org/x/sys` — BSD-3-Clause, copyright The Go Authors.

Exact versions and checksums are recorded in `native/hsyncd/go.mod` and
`native/hsyncd/go.sum`. Release packages must include the complete dependency
license texts.
