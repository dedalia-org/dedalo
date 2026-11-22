---
title: An audio/video upload is refused while a version of the same file is still being built.
type: fixed
audience: user
date: 2026-11-22
wc: WC-2026-11-22-av-upload-build-running
---
Uploading a new audio or video file into a field whose previous file was still being converted
used to start a second conversion of the same field. Whichever finished last won, so the web
version could end up made from the OLD file, and the record's file information could disagree
with what was on disk.

Now one build runs per audio/video field at a time, as in v6. While any version of the field is
being built (the conversion after an earlier upload, or any quality rebuilt from Media versions),
a new upload is refused with the message *"A version build is already running for this file.
Wait until it finishes and try again"*. The file you sent is discarded and the stored file is
left exactly as it was. The same message refuses a second build in Media versions — of any
quality — while the field is busy. Wait for the job in the activity tray to finish, then try
again. Other fields of the same record are not affected. See [Upload](./using/tools/using_upload.md).

The rule holds across server instances: when several instances serve the same installation, they
must share one media processes directory (`DEDALO_MEDIA_PROCESSES_DIR`), where the per-field build
locks live. See [the configuration reference](./administration/configuration/config.md).

The other Media versions actions that rewrite an audio/video field's files — *Conform headers*,
deleting a quality or a version, *Regenerate*, rebuilding the thumbnail — and creating or
deleting the poster frame wait their turn the same way: while a build or an upload of the field is
running they are refused with the same message, and none of them can start a build behind its back.
The Update cache *Regenerate* pass reports such a field as busy and carries on with the rest.
