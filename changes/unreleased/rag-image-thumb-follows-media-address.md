---
title: "Thumbnails in similar-object, identification and characterisation results follow the media web address."
type: fixed
audience: admin
date: 2026-11-22
---
The image search index stored each thumbnail as a complete web address, built on the media
web address (`DEDALO_MEDIA_WEB_BASE`) of the day the image was indexed. After that address
changed — media moved to another host, or served from a separate web server — every
similar-objects, identify-by-image and characterise result kept pointing at the old address.
The index now stores where the thumbnail sits inside the media folder, and the address is built
when a result is read, on the current media web address. A thumbnail generated after the image
was indexed now also reaches the index on the next indexing pass.

**Action needed:** backfill the image search index (see *Operations* in the RAG administration
guide). Image vectors indexed before this version show no thumbnail until their record is indexed
again, and that indexing computes each image vector once more.
