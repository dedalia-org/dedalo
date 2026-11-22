# Translate a field (`tool_lang`)

> See also: [Tools user guide](index.md) · [Developer reference](../../development/tools/reference/tool_lang.md)

Translate one text field of one record from a source language into a target language, with the source shown beside the target and one click to fill in an automatic translation.

## What it's for

Dédalo stores every textual value once per language on the same field — the English, Spanish and Catalan versions of a *Description* all live on the one component. Keeping those parallel values in step normally means switching the whole record's interface language back and forth. `tool_lang` turns it into a focused, comparison-driven task: it opens a two-pane editor on a single field, source on the left, target on the right, and offers to fill the target automatically.

Concrete scenario: a museum publishes its *Objects* catalogue trilingually. A curator has written a long *Description* in Spanish, but the English version is empty. They open the translator on that field, set the source to Spanish and the target to English, pick a translation engine and press *Automatic translation*; the English draft appears and is saved on the field. They then switch the target to Catalan and repeat, lightly editing each draft in place.

## When to use it

- A record's text field needs a translated value in another language, edited with the source visible beside it.
- You want a machine-translation first draft to correct, rather than typing from scratch.
- You want to copy a source value verbatim into another language (for non-translatable strings, or as a hand-translation starting point).

Do not use it to translate a field into *many* languages in one pass — use [Translate to many languages](using_lang_multi.md) for that. It only works on text fields, and it translates one record at a time (there is no bulk-across-records action here).

## Where to find it

The translator is attached to individual **text fields**, not to the section as a whole. On a field configured for it (long-text and short-text fields such as a *Description* or a title), a **Translation** button appears inline on the field's button bar. Click it to open the two-pane editor; the tool opens in its own window.

## Using it, step by step

1. Open the record and find the text field you want to translate.
2. Click the field's **Translation** button. The two-pane editor opens.
3. On the left, choose the **source language** — the value you are translating *from*. The source pane is read-only.
4. On the right, choose the **target language** — the value you are translating *into*. This pane is editable.
5. To fill the target automatically, pick a **translation engine** from the selector, then press **Automatic translation**. The engine produces the target value and it is saved on the field.
6. To copy the source across instead, press **Copy to target** — the source text is written onto the target verbatim and saved.
7. Review and correct the target text in place. Change the target language and repeat for each language you need.

## Options

| Control | What it does |
| --- | --- |
| Source language | The language you translate from; its value shows read-only on the left. |
| Target language | The language you translate into; editable on the right, and where the result is saved. |
| Engine selector | Chooses the translation engine — a **server** engine (Babel, Google) or a **browser** engine ("Local AI translator") that runs entirely in your browser. |
| Configuration (gear) | For a browser engine, toggles a device option — a "more compatible, slower" checkbox that uses the CPU instead of the GPU. |
| Automatic translation | Runs the selected engine and fills the target. |
| Copy to target | Copies the source value into the target verbatim (no translation). |

Which engines appear, and whether machine translation is available at all, depends on how your installation is configured. A server engine needs its service address and key set up by an administrator; the "Local AI translator" loads its model into your browser the first time you use it — from **your own installation's model store**, never from an internet service, so it works in an archive with no outside connection. An administrator seeds the store with the model (`onnx-community/translategemma-text-4b-it-ONNX`) the same way as the [transcription models](using_transcription.md): from a machine with internet with `scripts/fetch_ai_models.ts`, or by copying the model folder in. Until it is seeded the engine reports that the model is not installed.

## Tips and gotchas

!!! tip
    Use **Copy to target** for values that should be identical across languages (proper names, codes) or as a clean starting point before hand-translating.

!!! tip
    A machine translation is a *draft*. Always read it back in the target pane and correct it before moving on — cultural-heritage descriptions carry nuance an engine will miss.

!!! warning
    Running *Automatic translation* overwrites whatever is currently in the target field with the engine's result. If the target already holds a hand-written value you want to keep, copy it somewhere safe first. Machine translation of a long text can take a while; leave the window open until it finishes.

!!! note "Marks with the Local AI translator"
    Index marks, time codes and the other marks in a text are kept out of the model's reach and put back after the translation. If the model drops one, it is asked again; if it still does, the translator places the mark itself, as close as it can to where it stood in the source. When it does, or when it has to put an opening and closing mark back in order, the translation is saved with **Translation saved — check the marks** and a line saying what was moved: check those marks in the target pane. If a mark is still missing at the end, or the result holds a mark the source does not have, **nothing is saved**: the target keeps its previous text and the panel shows **Translation needs review before saving**. Try again, or use a server engine for that field.

## Related

- **[Translate to many languages](using_lang_multi.md)** — fill every project language from one source in a single pass.
- **[Transcription](using_transcription.md)** · **[Subtitles](using_subtitles.md)** — other tools that use external/AI engines on text and media.
- **[Developer reference](../../development/tools/reference/tool_lang.md)** — engines, the translation action, configuration and permissions.
