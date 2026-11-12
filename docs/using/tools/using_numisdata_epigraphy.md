# Epigraphic descriptions (`tool_numisdata_epigraphy`)

> See also: [Tools user guide](index.md) · [Developer reference](../../development/tools/reference/tool_numisdata_epigraphy.md)

A specialist workbench for transcribing the epigraphy of coins and other numismatic objects — legends, designs, symbols, marks and edge inscriptions — using an epigraphy thesaurus as a glyph picker.

## What it's for

Coin inscriptions are hard to transcribe. Legends run along the rim in ancient or non-Latin scripts, and the exact glyphs — ligatures, retrograde letters, monograms, control marks — rarely exist on a keyboard. This tool lays out every epigraphic facet of a coin record side by side with an epigraphy thesaurus that supplies the glyphs, so you build the transcription by picking characters rather than fighting an input method.

Concrete scenario: cataloguing a Roman provincial bronze, a numismatist opens the tool on the coin record. The left column is the epigraphy thesaurus glyph picker; the right column exposes the coin's facets — obverse and reverse legends, designs, symbols and marks, plus the edge design and edge legend — each with a read-only text read-out mirroring its saved value and a "Used in" badge showing how many records reference it. They select the obverse legend, pick glyphs from the thesaurus into its Unicode text, then move on to the countermark.

## When to use it

- You are transcribing the epigraphy of a coin or similar numismatic object with specialist glyphs.
- You need the obverse/reverse legends, designs, symbols, marks and edge inscriptions in one place, fed from an epigraphy thesaurus.
- **Not** for arranging coins into collections or lots — use the coin-ordering tool (`tool_numisdata_order_coins`).
- **Not** for plain audiovisual or document transcription — use [Transcription](using_transcription.md).

## Where to find it

This tool does not attach by component model or tipo. It surfaces only on records whose configuration explicitly enables it and supplies the coin-facet mapping — that is, sections set up for numismatic epigraphy. When enabled it opens in its own window with the two-column glyph-picker layout. As with any tool, you must be authorized for it on your profile.

## Using it, step by step

1. Open a coin record configured for the tool and launch **Epigraphic descriptions**. The tool opens in a new window.
2. The left column shows the epigraphy thesaurus — the glyph picker. The right column shows the coin's epigraphic facets, each with a live text read-out.
3. Select the coin you are working on if the tool exposes a coin picker; the facet fields load for that record.
4. For each facet — obverse/reverse **legend**, **design**, **symbol**, **mark**, and the **edge** design and legend — select the field and pick glyphs from the thesaurus into its Unicode text.
5. As you save a facet, its read-out updates and its **Used in** badge reflects how many records reference it.

## Tips and gotchas

!!! tip "Pick glyphs from the thesaurus, don't type them"
    The whole point of the tool is the epigraphy thesaurus on the left: it holds the specialist glyphs that a keyboard cannot produce, and inserts them into the facet's Unicode text. Reach for it rather than approximating with plain letters.

!!! info "Configuration-driven"
    Because the tool is enabled per section through its configuration rather than by matching a component type, it only appears where an administrator has set up the coin-facet mapping. If you expect it on a numismatic section and do not see it, the section's tool configuration likely needs it added. See the [developer reference](../../development/tools/reference/tool_numisdata_epigraphy.md).

## Related

- **Coin ordering** (`tool_numisdata_order_coins`) — group and sort coins into collections and lots.
- **[Transcription](using_transcription.md)** — general audiovisual and document transcription.
- **[Developer reference](../../development/tools/reference/tool_numisdata_epigraphy.md)** — the facet roles and the UI-only contract.
