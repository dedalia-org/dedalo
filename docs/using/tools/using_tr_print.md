# Print transcription (`tool_tr_print`)

> See also: [Tools user guide](index.md) · [Developer reference](../../development/tools/reference/tool_tr_print.md)

Produces a clean, print-ready rendering of an interview transcription, and lets you choose which annotations — timecodes, speakers, indexations, notes, languages — appear in the printout.

## What it's for

A stored transcription is a stream of running text mixed with markup: timecode marks, speaker tags, indexation anchors, notes and language markers. That is right for editing but wrong for reading or handing to a researcher. This tool turns the transcript into a formatted layout you can print or export from the browser, with a metadata header and per-annotation visibility switches so the printout shows exactly what you want.

Concrete scenario: an oral-history archive needs a paper transcript of an interview for a reading-room dossier. The editor opens the transcription record, presses **Print transcription**, switches to the structured layout so each timecoded passage becomes a row with its index terms alongside, hides the raw timecodes and language markers but keeps speaker names and notes, turns on dividing lines between passages, and prints. A header listing the interview session, interviewees and camera operators sits above the text.

## When to use it

- You have a finished transcription and want a readable or printable version of it.
- You want to control which annotations appear (timecodes, persons, indexations, notes, languages, lines).
- **Not** for editing the transcript or subtitles — use [Subtitles](using_subtitles.md).
- **Not** for generating the transcription — use [Transcription](using_transcription.md).

## Where to find it

The **Print transcription** button attaches inline to the transcription text component. It opens in its own window: a two-column layout with the display controls on the left and the formatted transcript on the right, a metadata header above the text.

## Using it, step by step

1. Open the record and press **Print transcription** on the transcription component. The tool opens in a new window.
2. Choose a **view mode** from the selector:
   - **Original** (the default) shows the transcript with its inline tag markup rendered.
   - **Default** shows a structured layout where each timecoded passage is a row, with indexation terms in a sidebar and speaker names and notes resolved into readable labels.
   - **Source** shows the raw transcript text as plain text.
3. Use the left-panel checkboxes to show or hide each annotation class: **Header**, **Time Codes**, **Persons**, **Indexations**, **Indexations info**, **Annotations**, **Languages**, and **Lines** (dividers between passages). Changes apply immediately.
4. Switch the **language** with the language selector to render the transcript in another language.
5. Print or export from your browser once the layout looks right.

## Options

| Option | What it does |
| --- | --- |
| View mode | Original / Default / Source rendering of the transcript. |
| Header | Show or hide the metadata header block. |
| Time Codes | Show or hide the timecode marks. |
| Persons | Show or hide speaker (person) tags. |
| Indexations | Show or hide indexation anchors in the text. |
| Indexations info | Show or hide the sidebar of resolved index terms. |
| Annotations | Show or hide notes. |
| Languages | Show or hide language-change markers. |
| Lines | Draw dividing lines between timecoded passages. |
| Language | Which language of the transcript is rendered. |

## Tips and gotchas

!!! tip "Print from the browser"
    The tool builds the on-screen layout; use your browser's print or save-as-PDF to produce the document. Set the visibility switches first so the printout matches what you see.

!!! info "Structured view depends on resolved tags"
    The **Default** view and the metadata header resolve indexation and note tags to readable labels. On this engine that resolution routes through a component endpoint that is not currently available, so those labels may not appear; the **Original** and **Source** views do not depend on it. See the [developer reference](../../development/tools/reference/tool_tr_print.md) for the exact status.

## Related

- **[Transcription](using_transcription.md)** — generate the transcription this tool renders.
- **[Subtitles](using_subtitles.md)** — edit the transcription for subtitle production.
- **[Time codes](using_tc.md)** — shift all timecode marks by a fixed offset.
- **[Indexation](using_indexation.md)** — index the transcript against thesaurus terms.
- **[Developer reference](../../development/tools/reference/tool_tr_print.md)** — the view modes and the UI-only contract.
