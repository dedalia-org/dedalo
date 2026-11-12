# Indexation (`tool_indexation`)

> See also: [Tools user guide](index.md) · [Developer reference](../../development/tools/reference/tool_indexation.md)

A side-by-side workspace for indexing a transcription against the thesaurus: select a fragment of text, link it to a thesaurus term (or a person or media descriptor), and the tool records the link as an inline tag plus a locator.

## What it's for

A long transcription is only searchable by the words it happens to contain — until you connect its passages to controlled vocabulary. Indexation builds those connections: it puts the transcript next to the thesaurus tree so you can select a phrase and attach it to the concept it is about. The result is a semantic index over the running text, so a researcher can find every passage about an event, place or person even when the transcript never uses those exact words.

Concrete scenario: an oral-history archive has the verbatim transcript of an interview. A documentalist opens the indexation tool on that transcript, selects the phrase "the bombing of the old market", expands the thesaurus to *Events → Civil war → Bombings*, and links the fragment to that term. The tool writes an inline index tag into the transcript (in every language copy) and a matching locator into the indexing portal. They switch the left pane to the *People* section to tag a speaker, mark each tag's review state, and attach a free-text note where a passage needs explanation.

## When to use it

- You need to index long-form text — transcriptions, interviews, document bodies — against the thesaurus by selecting fragments visually.
- You want to tag persons or media descriptors against passages of the same text.
- **Not** for generating the transcription — use [Transcription](using_transcription.md).
- **Not** for editing subtitles or shifting timecodes — use [Subtitles](using_subtitles.md) and [Time codes](using_tc.md).

## Where to find it

The **Indexing tool** button attaches to the transcription text component (restricted to that transcription tipo). It opens in its own window: a two-pane layout with the thesaurus tree, people or media viewer on the left and the transcription text on the right.

## Using it, step by step

1. Open the record and press **Indexing tool** on the transcription component. The tool opens in a new window.
2. Choose what the left pane shows with the **Viewer** selector: the thesaurus tree (to link to terms), the people section (to tag speakers), or the media viewer (to follow the audio while you read). Your choice is remembered.
3. In the right pane, select the fragment of text you want to index.
4. In the left pane, navigate to the target term (or person) and link the selected fragment to it. The tool writes an inline index tag into the transcript and a matching locator into the indexing portal.
5. Click a tag in the text to select it. Set its review **state** (for example Normal / Deleted / To review) and, if useful, attach an **info note** (a title and description) explaining the passage.
6. Use the **Approach** selector to choose which top section/record the current indexation hangs from.
7. Switch the text language with the language selector; the original language is labelled "Original".
8. Read what you have indexed in the **Indexation** panel: one row per linked term, with a numbered chip for every tag pointing at it. Click a chip to jump to that tag in the text; click the bin to remove links (see below).

## Options

| Option | What it does |
| --- | --- |
| Viewer | Whether the left pane shows the thesaurus tree, the people section, or the media viewer. |
| Approach | The top section/record the current indexation is anchored to. |
| Tag state | The review status of a selected tag (for example Normal / Deleted / To review). |
| Info note | A free-text title and description attached to a tag. |

## Tips and gotchas

!!! tip "Index the concept, not the wording"
    The point of indexation is to reach passages whose wording does not match the query. Link a fragment to the term that captures what it is *about*, even when the transcript never says the term.

!!! warning "Deleting a tag removes it everywhere"
    Deleting a tag asks you to confirm twice, then removes the inline tag from every language copy of the transcript **and** the matching locator in the indexing portal. There is no partial delete.

!!! warning "The bin in the Indexation panel removes links, not tags"
    A row in the **Indexation** panel is one *term*, and it carries a chip for every tag that points at it — so the bin does not act on one tag, it acts on the row. With no tag selected the row shows all of the term's chips and the bin removes **all** of its links at once; with a tag selected the list is filtered to that tag, the row shows that single chip, and the bin removes **only** that link. The confirmation dialog names the term and lists exactly the tags it is about to unlink, so read it before accepting.

    Either way the highlighted fragments stay in the text: this removes links only. To remove a tag from the transcript as well, delete the tag in the text instead.

!!! info "How the work is saved"
    This tool is a front-end over the record's own components — the transcription text and the indexing portal — and the thesaurus. It writes through those components rather than through a tool action of its own. See the [developer reference](../../development/tools/reference/tool_indexation.md) for the exact endpoints.

## Related

- **[Transcription](using_transcription.md)** — generate the transcription you index here.
- **[Subtitles](using_subtitles.md)** — subtitle production over the same transcription.
- **[Print transcription](using_tr_print.md)** — render the indexed transcript for print.
- **[Developer reference](../../development/tools/reference/tool_indexation.md)** — the components and endpoints behind the tool.
