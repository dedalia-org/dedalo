---
title: "`page_globals` now says what kind of build is running (`release_kind`), and the harvesting user agent names the release."
type: changed
audience: developer
date: 2026-10-18
wc: WC-2026-10-15-release-identity-from-tag
---
`page_globals` has a new key, `release_kind`: `stable`, `prerelease` or `dev`, the same
values as `/health`. Like `dedalo_version`, it is `null` for a visitor who is not
logged in. The version badge in the menu's debug bar uses it. It shows `beta` for a
prerelease and `dev` for an untagged build. Before, the badge said `beta` for every
`7.0` version, including the stable release.

The `User-Agent` header sent by the harvesting tools now carries the release name,
for example `dedalo/7.0.0-beta.7 (+https://dedalo.dev; heritage cataloguing)`. Before,
it carried the bare data version (`dedalo/7.0.0`). The `dedalo` token that a
`robots.txt` group addresses is unchanged.
