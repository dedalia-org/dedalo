---
title: An image uploaded in a format the browser cannot show (TIFF, PSD, PNG…) keeps its full-resolution original AND regains the viewable copy, so the "original" quality is selectable again
type: fixed
audience: user
date: 2026-10-23
---
Dédalo stores an image in tiers, and the best one is the `original`. Uploading a
`.tif` (or `.psd`, or any format a browser cannot draw) left that tier holding
only the file you uploaded: the engine indexed it and let you download it, but
it had no picture to show. The image component's quality selector only lists
tiers that hold the type's standard format (`jpg`), so the `original` quality
disappeared from the selector altogether, and the media-versions panel's preview
cell for it stayed empty.

The original tier now also carries the standard-format copy beside your upload —
`rsc29_rsc170_1.tif` and `rsc29_rsc170_1.jpg` side by side, the pair Dédalo has
always stored. The copy is made when the file is uploaded into `original` or
`modified` (including a colleague's retouched master), and it is what every
reader resolves when it picks a tier's picture: the quality selector, the media
versions panel, list and mosaic views.

Your uploaded file is never modified or replaced, and the copy is only a viewable
companion: every derived size is still built from the original file itself. It
is encoded at maximum quality (not the lighter web compression), so a large scan
keeps its detail when you open the `original` tier.

Records uploaded before this fix heal with one **Regenerate files** click in the
media versions tool (or the next cache update sweep).

One visible consequence of restoring the established behaviour: a media export
or download that asks for the `original` quality of such a record now gives the
viewable `.jpg` copy (the standard format), not the raw `.tif`. The raw file
remains listed and downloadable as its own version in the media versions panel.
