---
title: Images named by their "Filename" field open, upload and regenerate under that name again.
type: fixed
audience: user
date: 2026-11-12
wc: WC-2026-11-12-image-id-media-file-stem
---
An image component can take its file name from another field of the record (in the core
Images section, the **Filename** field). Before, only the indexation grid used that name:
the edit view showed a placeholder instead of the image's drawing layer, a new upload or a
regeneration wrote a second set of files under the standard name, rebuilding the files index
found nothing, and deleting the record left the named files in place.

Now every part of Dédalo uses the name in the **Filename** field: upload, regeneration, the
media tools, rebuilding the files index, the edit view, record delete and restore.

**Action needed:** none. A **Filename** value that is not a plain file name (it contains
`/`, `\`, `"`, `<`, `>`, or is `.`/`..`) or that is another record's standard file name is
now refused, and the upload stops before anything is written. Duplicating a record whose
images are named this way does not copy those images — both records would point to the
same files — and the duplicate reports them as not copied.
