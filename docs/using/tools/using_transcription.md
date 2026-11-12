# Transcription (`tool_transcription`)

> See also: [Tools user guide](index.md) · [Developer reference](../../development/tools/reference/tool_transcription.md)

Turns media into editable text: automatic speech-to-text on audio and video, text extraction from PDFs, and subtitle (VTT) generation — right beside the media, inside the record.

## What it's for

Oral-history and audiovisual archives fill up with hours of recorded interviews and stacks of scanned documents that stay invisible to search and publication until someone produces a text transcript. Re-keying an hour of audio by hand is slow and demoralizing. This tool produces that text directly in the record: it runs a speech recognizer over the audio, or pulls the text out of a PDF, and writes the result into the record's transcription field, complete with `[TC_..._TC]` timecode marks that keep the text lined up with the recording.

Concrete scenario: an oral-history project holds a 90-minute interview in an audiovisual component, with an empty transcription text field beside it. You open the transcription tool on the interview, pick a recognition quality, and start the automatic transcription. Minutes later the text field holds a timecoded first draft you can correct, and from it you generate a subtitle track for the published video.

## When to use it

- You have an audio or video recording and need a text transcription of it.
- You have a PDF and need its text pulled out for search and publication.
- You have a corrected transcription and want to generate a `.vtt` subtitle file synced to the recording.
- **Not** for hand-editing subtitles line by line — use [Subtitles](using_subtitles.md).
- **Not** for shifting all the timecodes by a fixed amount — use [Time codes](using_tc.md).
- **Not** for producing a printable transcript — use [Print transcription](using_tr_print.md).

## Where to find it

The **Transcription** button attaches to media components — audiovisual, image and PDF elements. Depending on the section it shows both in the inspector panel and inline on the component itself. It is most useful on an audiovisual component that has an adjacent transcription text field configured. The tool opens in its own window, with the editable text on one side and the media player on the other.

## Using it, step by step

1. Open the record and press **Transcription** on the media component. The tool opens in a new window: the transcription text area on the left, the media player on the right. When the record declares an **Original language** (interviews in one installation are recorded in different languages), the text area opens in that language — whatever the data-language menu is set to — and the recognizer uses it as its language hint. The tool's own language selector still lets you switch to work on a translation.
2. To transcribe speech automatically, use the **Automatic transcription** block: choose a recognition **engine**, a **quality** (the model) and, if you want, how much timecode detail the text should carry. Then start it. With the browser engine the model runs on your own machine — it uses your GPU when there is one and falls back to a slower compatible mode by itself. With a server engine the job runs on the institution's transcription server and the tool reports progress until it is done.
3. The panel under the button says what the tool is doing at each stage — preparing the audio file, loading the model, the percentage of speech transcribed, detecting speakers — and, when the run ends, says so in green. Progress is shown as a percentage of the speech in the recording. You can **Cancel** at any point: the tool keeps everything recognized so far instead of throwing it away. If the window is closed or reloaded mid-job, the browser asks you to confirm first, and everything recognized up to that point is kept (see *If you close the window mid-job* below).
4. When it completes, the recognized text lands in the text area as **paragraphs** — grouped at the speaker's pauses and sentence ends, not one paragraph per phrase — with `[TC_..._TC]` timecode marks. Correct the wording as needed.
5. Use **Insert tag** to add a timecode mark at the current playhead while you work.
6. To create subtitles, set the **characters per line** value and press **Build subtitles**. The tool writes a `.vtt` file synced to the recording's duration and returns its address.
7. For a PDF, open the tool on the PDF component to extract its text (see the note below).

!!! info "PDF text extraction route"
    On this engine, PDF text extraction is handled by the dedicated PDF extractor tool rather than inside the transcription tool. If the transcription tool does not extract a PDF's text, reach for the PDF extractor instead. See the [developer reference](../../development/tools/reference/tool_transcription.md) for the exact split.

## Options

| Option | What it does |
| --- | --- |
| Engine | Which recognizer runs the transcription. The shipped default runs in your own browser; an administrator can configure an on-premise server engine for institutions whose staff machines cannot run it. |
| Quality | Which model to use. Larger models are more accurate and much slower; the list shows how many languages each one covers and how large the download is. Models that need a GPU are greyed out when you pick the compatible device. |
| Device | Automatic (recommended), GPU, or the slower compatible mode. Automatic detects what your browser can do and falls back on its own. |
| Paragraphs | How much timecode detail the transcript carries. *Paragraphs with time marks* (default) reads as prose and keeps enough marks for accurate subtitles; *Paragraphs, one mark each* is the cleanest text; *One mark per phrase* is the old cue-list behaviour. |
| Rebuild paragraphs | Re-groups the transcription already in the text area under the current paragraph setting. Nothing is re-recognized and no word changes — useful for transcripts made before paragraphs existed. |
| Download model | Shown when the selected model is marked *not installed*. An administrator can press it to download that model into the installation's own store (it runs on the server and can take several minutes); everyone else sees who to ask. |
| Characters per line | The maximum line length used when building the `.vtt` subtitle file. |

## Tips and gotchas

!!! tip "Correct before you build subtitles"
    Generate the transcription, correct the text, and only then press **Build subtitles** — the subtitle file is cut from the current text and its timecodes.

!!! tip "Browser transcription runs in your tab"
    When the browser engine is used, the recognizer runs inside your browser tab, and the recording never leaves your machine. Keep the window open while it works. A GPU-capable browser is much faster. With a **server** engine the opposite is true: the job runs on the institution's machine, so closing or reloading the window costs nothing — reopening the tool picks the progress back up.

!!! warning "If you close the window mid-job"
    A browser transcription lives in your tab, so closing or reloading it stops the recognizer. Two things protect the work:

    - the browser asks you to confirm before the page goes away, so it cannot happen by accident;
    - everything transcribed up to the last completed stretch is kept anyway.

    When you open the tool again, the panel says so — *Interrupted transcription — Small: 00:42:15 already transcribed* — with a **Resume the transcription** button that carries on from that point instead of re-doing the interview. Speaker detection is the exception: it runs after the recognition finishes, so if the window closes during that stage the transcript survives but the speaker pass starts over.

!!! warning "The saved progress belongs to the model that made it"
    Interrupted work is kept **per model**: a run under *Small* and a run under *Medium* are two different drafts and neither overwrites the other. So if you change the quality after an interruption, the panel warns you — *Interrupted transcription — Small: 00:42:15 transcribed with another model — running now starts from the beginning* — and offers **Go back to that model**. Starting anyway is a valid choice (a better model from scratch may be what you want); it just is not one the tool will make for you silently.

!!! info "Nothing is uploaded, and nothing is downloaded from outside"
    The browser engine keeps the audio on your machine, and the models themselves come from your own installation rather than from an internet service — so it works in an archive with no outside connection, and no third party learns which recordings you are working on. Models marked *not installed* can be added by an administrator with the **Download model** button (or from the server with `scripts/fetch_ai_models.ts`; an air-gapped archive copies the model folder in instead). Every downloaded model is checked against a digest the software ships with — a file that does not match is set aside and never used, and **Check the model files** tells an administrator so, with *Repair* as the remedy.

!!! tip "Repeated words"
    Recognizers sometimes get stuck and repeat a word or phrase, especially over silence, background noise or unclear speech. The tool now cuts the audio at real pauses, decodes with anti-repetition settings and cleans up whatever still slips through, so this should be rare. If you still see it, try a different model — *Parakeet* cannot produce that kind of loop at all — or improve the source audio.

!!! warning "Automatic text is a draft, and it overwrites"
    Automatic transcription writes its result into the text field. Review it — recognizers make mistakes with names, places and overlapping speech. Because the write goes through the normal save path, earlier states remain in the [time machine](using_time_machine.md) if you need to revert.

!!! tip "Automatic speaker tags"
    With **Detect speakers** on, the tool detects when the voice changes and saves the transcription immediately with a *placeholder* tag (P1, P2…) opening every speaker turn — no questions asked first. Review the draft: the placeholder tags are normal content, so you can move one the detector misplaced, delete a false one, or copy one where a change was missed. Then press **Assign speakers** (it is also offered right after the run): each detected voice appears with ▶ buttons that jump the player there, you pick who P1 and P2 really are from the record's people, and every tag is replaced in one step — whenever you want, even days later, and re-assignable if you got it wrong (the time machine keeps every version). Detection runs entirely in your browser with a small model (~6 MB) from your own installation; if it is marked *not installed*, an administrator can add it with **Download speaker model**. Who each voice belongs to is always your decision — the tool never guesses identities.

!!! tip "Speaker, language and note tags"
    The text editor's toolbar carries the interview helpers: the **person** button lists the people talking — the informants of the related oral-history record and the recording crew of the audiovisual record itself — and inserts a speaker tag at the cursor (`Ctrl+1…9` inserts them by number). The **language** button drops an in-text language mark, and the **note** button creates a linked note record and its tag. Which components supply the speakers is declared in the ontology (the transcription field's `tags_persons` property), so an installation can point them at its own people fields.

## Related

- **[Subtitles](using_subtitles.md)** — hand-edit subtitles from the transcription in a rich editor.
- **[Time codes](using_tc.md)** — shift every timecode mark by a fixed offset.
- **[Print transcription](using_tr_print.md)** — produce a printable, formatted transcript.
- **[Indexation](using_indexation.md)** — link fragments of the transcript to thesaurus terms.
- **[Developer reference](../../development/tools/reference/tool_transcription.md)** — actions, options and internals.
