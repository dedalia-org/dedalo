---
title: Four tools that failed to open, or did more than asked, are fixed.
type: fixed
audience: user
date: 2026-10-28
wc: WC-2026-10-28-tool-open-defects
---
- The Transcription tool is offered only on media fields set up for transcription. On other images, audio and PDFs (such as a user's picture) it used to appear and fail to open.
- The Upload tool works again on JSON fields: uploading a `.json` file replaces the field's value. A file that is not valid JSON is refused and nothing changes.
- The Time Machine tool opens from inverse-relation fields; it failed with an error before.
- Opening the Diffusion tool no longer retries pending deletions behind the scenes. It only counts them for the "Pending deletions" badge; the retry runs when you press Retry.
