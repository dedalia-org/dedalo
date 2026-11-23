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
| Configuration (gear) | For a browser engine: the **Model** to translate with, and a "more compatible, slower" checkbox that uses the CPU instead of the GPU (greyed out for a model that needs the GPU). |
| Automatic translation | Runs the selected engine and fills the target. |
| Copy to target | Copies the source value into the target verbatim (no translation). |

Which engines appear, and whether machine translation is available at all, depends on how your installation is configured. A server engine needs its service address and key set up by an administrator; the "Local AI translator" loads its model into your browser the first time you use it — from **your own installation's model store**, never from an internet service, so it works in an archive with no outside connection. The *Model* list shows the models your installation offers (Qwen 3 by default, TranslateGemma, MADLAD-400, and the small one-pair OPUS models); an administrator seeds each one in the store the same way as the [transcription models](using_transcription.md): from a machine with internet with `scripts/fetch_ai_models.ts`, or by copying the model folder in. Until a model is seeded the translator reports that the model *is not installed in this installation's model store* and saves nothing. The large models need a browser with WebGPU; without it the translator says so, suggests a smaller model your installation offers, and saves nothing. A language without a language code the models understand (for example *no language*) cannot be translated with this engine: the translator says so before it starts. NLLB is listed but not offered unless an administrator enables it: its licence allows non-commercial use only.

## Tips and gotchas

!!! tip
    Use **Copy to target** for values that should be identical across languages (proper names, codes) or as a clean starting point before hand-translating.

!!! tip
    A machine translation is a *draft*. Always read it back in the target pane and correct it before moving on — cultural-heritage descriptions carry nuance an engine will miss.

!!! warning
    Running *Automatic translation* overwrites whatever is currently in the target field with the engine's result. If the target already holds a hand-written value you want to keep, copy it somewhere safe first. Machine translation of a long text can take a while; leave the window open until it finishes.

!!! note "Marks with the Local AI translator"
    Index marks, time codes, drawing-layer marks, links, superscripts and other formatting the model could damage are kept out of its reach and put back after the translation. Headings, lists, quotes and rules keep the structure of the source; a translated paragraph that happens to start with a year (`1984.`), a dash or `#` stays an ordinary paragraph. Long texts are translated a few sentences at a time, and each list item, table cell or paragraph on its own; the formatting is kept exactly as it was: bold stays bold in the same tag, spacing and indentation, empty spacer paragraphs, non-breaking spaces, comments and the formatting attributes of a paragraph come back as they were. Characters such as `*`, `_`, `` ` `` and `\` in the text (`2*3`, `` l`Hospitalet ``, `<strong>Roma</strong>*`) are kept out of the model's reach like the marks and always saved as written, in their place; bold or italic the model adds where the source had none is removed, and the translation is saved with a warning when the translator had to remove any. When the model writes more bold, italic or code than the text has, which one is the original would be a guess, so that part is refused. Line breaks that the field's style shows are kept. If the model drops a mark, the translator places it itself, as close as it can to where it stood in the source; if it reverses an opening and closing mark, it puts them back in order. Either way the translation is saved with **Translation saved — check the marks** and a line saying what was moved: check those marks in the target pane. **Nothing is saved** — the target keeps its previous text and the panel shows **Translation needs review before saving** — when a mark is still missing, appears twice, or is not in the source, when paragraphs, list items or table cells came back in a different order, when formatting came back wrongly nested (a tag closed inside another), when the model wrote a mark of its own (a time code, an index mark), when the model returned no text for a passage, or wrote HTML of its own into the translation, when part of the text could not be translated, when the model stopped at its length limit (the translation would be cut short), or when the model repeated itself instead of translating. A passage that came back two or more sentences shorter than the source is saved, with a line saying how many: check that its translation is complete. So is a passage where the model put bold, italic or code on other words than the source: check its formatting. Try again, try another model, or use a server engine for that field. A text that itself contains sequences like `[[[3]]]` cannot be translated with this engine.

!!! note "Stopping a translation"
    Pressing stop while the last part is being translated still stops it: nothing is saved and the target keeps its previous text.

## Related

- **[Translate to many languages](using_lang_multi.md)** — fill every project language from one source in a single pass.
- **[Transcription](using_transcription.md)** · **[Subtitles](using_subtitles.md)** — other tools that use external/AI engines on text and media.
- **[Developer reference](../../development/tools/reference/tool_lang.md)** — engines, the translation action, configuration and permissions.
