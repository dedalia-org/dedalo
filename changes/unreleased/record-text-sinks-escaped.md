---
title: Record text shown by widgets and tools is always displayed as text; markup stored in a record no longer runs there.
type: security
audience: user
date: 2026-11-13
---
Every place outside the record editor that shows a value typed into a record now shows it as text: the state, archive-states, archive-weights, sum-dates, media-icons, tags and user-activity widgets; the typology names in the thesaurus, graph and search panels; and the tools that print or edit record text — transcription print, subtitles, print layouts (including the free text of a layout, which is now kept as plain text), propagate component data, indexation, translation (the live preview of the Local AI translator) and the CSV import mapper.

Before, a value containing `<…>` or `&` could be interpreted as markup in those places. Rich text (transcriptions, text areas) keeps its formatting: it is displayed exactly as the record editor does, by the kind of field it belongs to. A free-text box in a print layout saved before this change is read back as the text it showed.
