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

Now the upload is refused while the field's web or audio version is being built (after an
earlier upload, or from Media versions), with the message *"A version build is already running
for this file. Wait until it finishes and try again"*. The file you sent is discarded and the
stored file is left exactly as it was. Wait for the job in the activity tray to finish, then
upload again. See [Upload](./using/tools/using_upload.md).
