---
title: Media URLs honor `DEDALO_MEDIA_WEB_BASE`
type: changed
audience: admin
date: 2026-07-23
breaking: true
wc: WC-042
---
Every client media
URL is now built on a configurable base (`config.media.webBase`), so an
install serving media from a different origin than the app can emit correct
absolute URLs; unset means the previous same-origin relative default.
Distinct from `DEDALO_MEDIA_EXPORT_BASE`, which continues to root export cells
only (unset means unresolved, never guessed). That key is the **rename** of
`DEDALO_MEDIA_BASE_URL`: the two names were indistinguishable while the values
differ only in audience, so the pair now says who each one serves — the old
spelling is retired and refuses the boot until the line is renamed. Its value
is normalized like `webBase` (trailing slash stripped), and it takes the media
directory too (`https://host/dedalo/media`), because both bases are prefixed
to the same media-root relative path. See
[config reference](./administration/configuration/config.md).
