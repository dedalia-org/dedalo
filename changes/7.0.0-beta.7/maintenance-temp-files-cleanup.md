---
title: Interrupted exports and transcriptions no longer leave temporary files behind
type: fixed
audience: admin
date: 2026-10-21
breaking: false
---
A thesaurus export stopped mid-dump (the server killed or restarted) left a
`<tipo>.copy.gz.tmp-…` or `hierarchy.json.tmp-…` file in `install/import/hierarchy`
for good. The next export now removes such leftovers once they are more than six hours
old; a newer one, which may belong to an export still running, is kept. Building
`hierarchy.json` also checks each data file in one streamed pass instead of reading
whole dumps into memory. A background transcription that failed with an unexpected
error kept its temporary copy of the recording on disk; the copy is now removed however
the job ends.
