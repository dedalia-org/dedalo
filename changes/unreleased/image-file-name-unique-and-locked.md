---
title: An image's file name (the `image_id` field) must be unique in its section and cannot be changed while the image's files exist; a duplicate gets its own file name.
type: changed
audience: user
date: 2026-11-13
wc: WC-2026-11-12-image-id-media-file-stem
---
Some image fields name their files by another field of the record (the ontology's
`image_id`, e.g. **Filename** on Images). Before, two records could hold the same file name
and then address the SAME files: an upload to one replaced the other's image, deleting one
moved the other's files away, and every duplicate of such a record shared its original's files.
Changing the file name after an upload left the files behind under the old name.

Now saving a file name another record of the same section already uses is refused and the
message names that record; an upload under a file name another record holds is refused before
anything is written. A record whose image files exist cannot change (or clear) its file name:
the message lists the files and the remedy — delete the image's files first, then rename. A
duplicated record is created WITHOUT the original's file name, so its copied files are named by
its own identifier; give it a new file name of its own before uploading if you want one.

**Action needed:** none. Records that already share a file name (written before this release)
keep working for reading; the first upload to one of them is refused until one of the two gets
its own file name.
