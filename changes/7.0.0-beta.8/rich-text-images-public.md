---
title: Images inserted into rich text are visible on published pages.
type: fixed
audience: admin
date: 2026-10-26
wc: WC-2026-10-26-rich-text-image-record-keyed
---
An image inserted into a rich-text field from the editor toolbar was visible only to logged-in
users: a visitor of the published page saw a broken image. New images are now named after the
record they are inserted into and follow its publication — public while the record is published,
hidden again when it is withdrawn — and they are copied to a separate publication server like any
other published media. Images inserted before this update keep their old names and stay visible to
logged-in users only. Only users who may edit the text can insert an image into it. As with any
other media of a published record, an image is visible from the moment it is inserted, and stays
visible after it is removed from the text while the record remains published.

For administrators: on nginx, reload it once after updating so the regenerated media rules take
effect (Apache needs nothing). If you set `DEDALO_MEDIA_PUBLIC_QUALITIES` yourself, add
`image/web` to it, or these images stay private.
