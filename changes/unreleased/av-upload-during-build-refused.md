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
locks live; on a network share, mount it so that a server that stops answering cannot freeze the
instances, and without caching (NFS: `lookupcache=none,actimeo=0`, never `nocto`) — on Linux a
server whose processes directory is on NFS mounted otherwise refuses to start and says which
option is missing, and a code update onto such a server is refused before anything is replaced.
**Before updating to this version**, remount an NFS processes directory with
`lookupcache=none,actimeo=0`: the version you update from may not run that check before the
update, and the updated server would then refuse to start. A lock an instance cannot read (wrong permissions, a failing share) counts as busy and is
never taken over — the log names the file and the error, so every instance must run as a user that
can read and write that directory. See [the configuration reference](./administration/configuration/config.md).

The other Media versions actions that rewrite an audio/video field's files — *Conform headers*,
deleting a quality or a version, *Regenerate*, rebuilding the thumbnail — and creating or
deleting the poster frame wait their turn the same way: while a build or an upload of the field is
running they are refused with the same message, and none of them can start a build behind its back.
The Update cache *Regenerate* pass reports such a field as busy and carries on with the rest.

Deleting a record, emptying its data, and restoring a deleted record from the
[time machine](./using/tools/using_time_machine.md) wait the same way: while one of the record's
audio/video fields is being built or uploaded, they are refused with the same message and nothing
is deleted, emptied or restored. Try again when the job has finished. While such a delete or restore
is moving the record's files, no build or upload of its audio/video fields can start, in any
language. Reverting a batch run waits the same way: a record the revert would bring back while one of
its audio/video fields is being built is listed as failed and stays deleted until you revert again
after the job; and a record that comes back without all of its media files is now listed as not
exact (*media_not_restored*) instead of only being noted in the server log.

Media versions now shows this before you click: while one quality of an audio/video field is being
built, the rebuild buttons of its other qualities are greyed out, and hovering one says why. They
grey out as soon as you start a build yourself, and come back if that build fails. For a field kept
per language, only the buttons of the language being built are greyed. The buttons can also be
reached and pressed from the keyboard (Enter or Space), and a screen reader announces why a greyed
one is unavailable. Holding a key down or clicking twice starts one build, not several.
