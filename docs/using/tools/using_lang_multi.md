# Translate to many languages (`tool_lang_multi`)

> See also: [Tools user guide](index.md) · [Developer reference](../../development/tools/reference/tool_lang_multi.md)

Translate one text field into every configured project language at once, with all languages shown side by side and a single button to fill them all from your source.

## What it's for

Where [Translate a field](using_lang.md) works on one source-and-target pair, `tool_lang_multi` shows **every** project language of the same field together — one editable column per language — and lets you fan a written source out to all of them in one action. It is the tool for a multilingual catalogue that needs the same field populated across many languages from a single written version.

Concrete scenario: an archive publishes its *Objects* in eight languages. A cataloguer writes the *Description* in Spanish and needs English, Catalan, French, Italian, German, Greek and Portuguese versions. They open this tool on that field, see all eight columns at once with Spanish highlighted as the source, and press **Automatic translation** — every other language is filled from the Spanish, and they review each column in place.

## When to use it

- A field needs to be filled across several (or all) project languages from one source text.
- You want to see and edit every language of a field together, rather than one pair at a time.

Do not use it for a single source→target edit — [Translate a field](using_lang.md) is the focused two-pane tool for that. Like the single-field translator, it works only on text fields and one record at a time.

## Where to find it

The tool is attached to individual **text fields** and shows as a button inline on the field's button bar, next to the single-language translation button. It appears on the translatable text fields configured for it — the shipped configuration enables it on short-text, long-text and IRI-label fields. Opening it lays out one column per project language.

## Using it, step by step

1. Open the record and find the text field you want to translate across languages.
2. Click the field's multi-language translation button. The editor opens with one column per project language.
3. Type or edit your source text in its column, or edit the column whose language you want to translate *from* — the edited column becomes the **source** and is highlighted. If the source is empty, the first language with text is used.
4. Pick a **translation engine** from the selector at the top.
5. To translate every other language at once, press **Automatic translation** at the top. To translate just one language, use the translate button on that single column.
6. When a column already has content, you are asked whether to **overwrite** it or **skip** columns that are not empty. Choose one; holding **Alt** while pressing *Automatic translation* overwrites everything without asking.
7. Watch the columns fill (a progress banner reports how many completed), then review and correct each translation in place. A language the translation service does not support is left unchanged and reported as failed.

## Options

| Control | What it does |
| --- | --- |
| Source column | The last edited column; its value is the text every other language is translated from. |
| Engine selector | Chooses the translation engine — a **server** engine (Babel, Google) or a **browser** engine that runs in your browser. Shared with the single-field translator's configuration. |
| Configuration (gear) | For a browser engine, toggles a "more compatible, slower" device option (CPU instead of GPU). |
| Automatic translation (top) | Translates the source into every other language in one run. |
| Per-column translate | The translate button in a column's own button bar: translates the source into that one language only. |
| Overwrite / Skip non-empty | When targets already have content: overwrite them all, or only fill the empty ones. |

Which engines appear depends on how your installation is configured; the engine list is shared with the single-field translator.

## Tips and gotchas

!!! tip
    Edit the column you want as the source before translating — the highlighted column is always the source. This lets you translate *from* any language, not only your project default.

!!! tip
    Choose **Skip non-empty** to fill only the languages that are still blank, leaving your finished translations untouched.

!!! warning
    **Overwrite** (and Alt+click) replaces the current value in every target language with a fresh machine translation — hand-edited text in those columns is lost. Prefer *Skip non-empty* unless you truly want every language regenerated. A full run over many languages can take a while, especially with the in-browser engine, which translates one language at a time.

## Related

- **[Translate a field](using_lang.md)** — the focused single source→target editor; this tool reuses its engines and translation logic.
- **[Developer reference](../../development/tools/reference/tool_lang_multi.md)** — the translation action, engine resolution, and how it delegates to the single-field translator's core.
