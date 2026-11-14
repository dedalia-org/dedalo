# Time codes (`tool_tc`)

> See also: [Tools user guide](index.md) · [Developer reference](../../development/tools/reference/tool_tc.md)

Shifts every timecode mark in a transcription by a fixed number of seconds at once — forward or backward — so the text lines up with the recording again.

## What it's for

A transcription carries `[TC_..._TC]` timecode marks that keep each passage aligned with the audio or video. When the recording is re-cut or re-encoded and its timeline moves by a few seconds, every mark is off by the same amount. Re-timing them one by one is tedious. This tool applies a single offset to all of them in one pass.

Concrete scenario: an oral-history interview's audiovisual master is replaced with a re-encoded version whose timeline starts 12 seconds later. The transcript's timecodes now point 12 seconds too early. You open the time-codes tool on the transcription, enter `12`, and apply — every mark advances by 12 seconds and the text and recording match again.

## When to use it

- Every timecode in a transcription is off by the same, constant amount.
- **Not** for correcting individual timecodes or editing subtitles line by line — use [Subtitles](using_subtitles.md).
- **Not** for generating the transcription or its marks — use [Transcription](using_transcription.md).

## Where to find it

The **Time codes** button attaches to the transcription text component (restricted to that transcription tipo), and appears both in the inspector panel and inline on the component. It opens in the standard tool view showing a read-only preview of the transcription next to the offset controls.

## Using it, step by step

1. Open the record and press **Time codes** on the transcription component.
2. The tool shows a read-only preview of the transcription on the left and the controls on the right.
3. Pick the **language** whose timecodes you want to shift with the language selector — the preview reloads for that language.
4. Type the **offset in seconds** into the input: a positive number pushes the marks later, a negative number pulls them earlier.
5. Press **Apply**. Every timecode mark in that language's transcription is shifted, and the preview refreshes to show the new values.

## Options

| Option | What it does |
| --- | --- |
| Language | Which language's transcription is previewed and shifted. |
| Offset in seconds | The signed amount to add to every timecode. Positive shifts later, negative earlier. |

## Tips and gotchas

!!! warning "It rewrites the whole language slice"
    Applying an offset rewrites every timecode mark in the selected language's transcription. It applies to the language you have selected — switch the language selector and apply again for each language that needs it. The change goes through the normal save path, so earlier states remain in the [time machine](using_time_machine.md).

!!! tip "Negative offsets stop at zero"
    A negative offset can never push a mark below `00:00:00.000` — any mark that would go negative is clamped to the start. A zero or empty offset is rejected, since it would change nothing.

## Related

- **[Subtitles](using_subtitles.md)** — correct individual timecodes and produce subtitles.
- **[Transcription](using_transcription.md)** — generate the transcription and its timecode marks.
- **[Print transcription](using_tr_print.md)** — printable, formatted transcript.
- **[Developer reference](../../development/tools/reference/tool_tc.md)** — the `change_all_timecodes` action and the offset transform.
