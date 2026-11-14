# Subtitles (`tool_subtitles`)

> See also: [Tools user guide](index.md) · [Developer reference](../../development/tools/reference/tool_subtitles.md)

A two-pane subtitle workbench: edit a recording's transcription line by line next to its media player, and turn the timecoded text into subtitle blocks ready to serve as VTT.

## What it's for

To publish accessible, captioned video you need subtitles that match the recording's timing. This tool gives you a dedicated surface for that: the transcript on the left as editable per-line blocks, the media player on the right with playback controls tuned for caption work — a play-speed slider, a key to pause-and-rewind, and a key to drop a timecode at the playhead. You listen, correct each line, mark where it belongs in time, and build the subtitle blocks.

Concrete scenario: an oral-history archive has digitized interviews, each with a verbatim transcription and `[TC_..._TC]` marks showing where each passage occurs. To caption an interview for the public site, an editor opens the transcription record, presses **Subtitles**, sets the pause key and the auto-rewind seconds to taste, plays the clip, corrects the wording line by line, sets *characters per line* to 42, and builds the subtitle blocks that become the video's VTT track.

## When to use it

- You are producing or correcting subtitles/captions from an existing timecoded transcription.
- You want keyboard-driven playback control while you type each line.
- **Not** for generating the raw transcription in the first place — use [Transcription](using_transcription.md).
- **Not** for shifting all timecodes at once — use [Time codes](using_tc.md).
- **Not** for a printable transcript — use [Print transcription](using_tr_print.md).

## Where to find it

The **Subtitles** button attaches inline to the transcription text component (the transcription field of an audiovisual record). It opens in its own window, wide enough for the two-pane editor and the player. As with any tool, you need to be authorized for it on your profile.

## Using it, step by step

1. Open the record and press **Subtitles** on the transcription component. The tool opens in a new window.
2. The left pane shows the transcript as per-line editors (each line is its own small rich-text box; timecode lines appear as editable timecode blocks). The right pane shows the media player.
3. Set your playback preferences: the **play/pause key**, the **auto-rewind seconds** (how far the player jumps back when you pause), and the **insert-tag key** (drops a timecode at the playhead). These are remembered for next time.
4. Play the clip, pausing with your chosen key to correct each line in place. Use the play-speed slider to slow difficult passages.
5. Set **characters per line** to the maximum length you want per subtitle.
6. Press **Build subtitles** to segment the text into the per-line, timecoded blocks.
7. Use the **language selector** in the header to work on another language's subtitles; the left pane reloads for that language.

## Options

| Option | What it does |
| --- | --- |
| Play/pause key | The keyboard key that pauses the player and rewinds it. |
| Auto-rewind seconds | How many seconds the player jumps back when you pause. |
| Insert-tag key | The keyboard key that inserts a timecode mark at the playhead. |
| Characters per line | The maximum length of each subtitle line when building. |
| Language selector | Which language's subtitles you are editing. |

## Tips and gotchas

!!! tip "Tune the rewind to your typing speed"
    A 3-second auto-rewind lets you catch the start of a phrase again without scrubbing. Adjust it and the play speed until you can keep your hands on the keyboard.

!!! tip "Revert from the header"
    If your profile allows it, a **Time Machine** button in the header lets you review and revert edits to the transcript. See [Time machine](using_time_machine.md).

!!! info "Where the work is saved"
    The tool arranges existing components side by side — the transcription text, the player, and a subtitle store — and saves through them. There is no separate subtitle export step here; it produces the timecoded blocks that a published interview serves as VTT.

## Related

- **[Transcription](using_transcription.md)** — generate the raw transcription (speech-to-text) this tool edits.
- **[Time codes](using_tc.md)** — offset every `[TC_..._TC]` mark by a fixed amount.
- **[Print transcription](using_tr_print.md)** — printable, formatted transcript rendering.
- **[Indexation](using_indexation.md)** — index the transcript against thesaurus terms.
- **[Developer reference](../../development/tools/reference/tool_subtitles.md)** — internals and the UI-only contract.
