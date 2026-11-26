---
title: The transcription print feed now checks the section, the transcription field and every note it shows.
type: security
audience: user
date: 2026-11-10
wc: WC-2026-11-10-tags-info-read-door
---
The request that resolves a transcription's tags for the print tool (index terms, notes and
persons) used to check only that the record was in the user's projects. It now asks what the
record page asks: read access to the section, read access to the transcription field itself, and
the record in the user's scope. The records the tags point at are checked too: a note is shown
only when the user may read the note's section, its fields and the note record itself, otherwise
it is left out of the print and its id is listed as withheld; the index terms are shown only when
the user may read the field that holds them; and the persons list only includes records in the
user's projects, and only from the field holding the persons when the user may read that field. Index term labels are shown as the record displays them. Users who already see
everything see no change.
