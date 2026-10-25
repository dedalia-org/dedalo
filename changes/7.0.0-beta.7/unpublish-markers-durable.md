---
title: Unpublished media stays unpublished after a power cut — and is never reported withdrawn while it is still served
type: fixed
audience: admin
date: 2026-10-21
wc: WC-2026-10-21-unpublish-markers-durable
---
- **A power cut can no longer bring back the media of a withdrawn record.** When a record is
  deleted or unpublished, the markers that let the web server serve its media files
  anonymously are now forced to disk before the record is reported unpublished. Before, a
  power cut right after could restore them, and the next start-up re-derived public access
  from them — with nothing left to retry the withdrawal.
- **A withdrawal that could not remove the markers stays pending.** If the media markers of
  an unpublished record cannot be removed (a permission problem on the media store, a full
  disk), the unpublish is now kept *pending* and retried, instead of being recorded as
  *unpublished* over media that is still public.
