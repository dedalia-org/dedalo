# Use cases

> Part of the [AI Assistant](index.md) section · Previous: [Privacy & security](privacy_and_security.md) · Next: [Cookbook](cookbook.md)

The assistant earns its place when a question is easier to *say* than to *build* — when the structured search ([SQO](../../../api/sqo.md)) could answer it, but only after you know which section, which field, and how they relate. This page is a tour of what it is good for, in the language of the people who use Dédalo. Each scenario names the collection type it fits, so you can recognise your own work.

---

## Find by meaning, across the vocabulary problem

**For:** oral history, ethnology, any archive where people describe the same thing in many words.

An oral-history archive holds ten thousand interviews. A researcher wants every testimony that touches on **displacement caused by building a reservoir**. Keyword search finds only the interviews where someone said the word *reservoir* — and misses *the dam*, *when the water came*, *they flooded our houses*, *el pantano*, *quan ens van fer marxar*.

She opens the assistant and asks in plain language. It runs a **semantic search** — matching *meaning*, not letters — and returns the testimonies that are *about* that idea, each cited by record so she can open it. For claims that need evidence, it follows up with **passage retrieval**: the exact chunks behind each match (with their page or timecode), quoted and cited as `section_tipo-section_id`. She refines conversationally: *"only the ones from the upper valley"*, *"only the transcriptions"* (an embed-group facet), *"which of these mention the church"*. Behind the scenes it is calling the same [RAG semantic layer](../rag.md) (`dedalo_semantic_search`, `dedalo_retrieve_passages`) and structured search a developer would, but she never leaves the sentence.

## Understand a record you are looking at

**For:** everyone, every collection.

A cataloguer is on a dense numismatics record — a coin with a dozen linked types, mints, and bibliographic references. From the record's assistant panel they ask *"summarise this record"* or *"what mint is this coin from and what else do we hold from it?"*. Because the panel sends the **current record as context**, the assistant resolves "this record" and "this mint" without the person spelling out any `tipo`, reads the linked records (subject to their permissions), and answers with the labels and locators so every claim is one click from its source.

## Cross-collection questions

**For:** research collections where the same entity appears in many places.

A person named in an interview, an object in a catalogue, a photograph, a thesis chapter, and a place in a gazetteer may all speak about the same thing — in different sections, never linked. Asked *"what do we hold about Anna Pujol?"*, the assistant resolves the name, searches the relevant sections, and gathers the hits into one answer. It does not merge records or invent connections; it reports what it found and where, so a researcher can see the shape of the archive's knowledge about a subject in one place.

## Guided cataloguing with a human in control

**For:** any collection, once write mode is enabled.

A field worker returns with a new testimony. Instead of clicking through the create-record flow, the cataloguer describes the work: *"create a person record for Anna Pujol, born 1931 in Súria, and link her as the informant of this interview."*

The assistant does **not** create anything. It resolves the People section and its fields, checks whether an Anna Pujol already exists (so it never makes a duplicate), and proposes a **change plan**: create the person, set the birth fields, link the portal. The cataloguer sees each operation with its real arguments and clicks Apply — or edits the request and asks again. Only on confirmation does anything get written, as ordinary audited edits. See [write mode](privacy_and_security.md#write-mode-propose--confirm--apply).

The value is not that the AI catalogues for you; it is that it turns a multi-step, tipo-aware operation into a sentence, and keeps the human as the one who commits.

## Private "Memory" projects — a local model that never phones home

**For:** collections under confidentiality, embargo, or data-protection constraints.

An institution holds oral-memory testimonies given under promises that the recordings and transcripts will never leave the building. They still want the assistant's help searching and understanding them. They connect a **local model** (Ollama or vLLM on their own server), marked `egress: local`, and the researcher picks it for this work. Nothing about those testimonies is sent to any outside service — the model runs on their infrastructure.

If someone forgets and picks the cloud model for a protected record, the [egress gate](privacy_and_security.md#the-egress-gate) refuses that record and tells them to switch to the local model. The safe outcome does not depend on remembering.

## Reading images: objects and documents

**For:** numismatics, ceramics, art, and any collection with document scans, using a vision-capable model.

On a coin or ceramic record, a cataloguer attaches the object photograph and asks *"describe the visible legend"* or *"what iconography is on the reverse?"*. On a document collection, they attach a scan and ask for a transcription of the visible text. The image goes to the vision model with the question; the answer comes back as a starting point the cataloguer verifies and edits — never an unattended transcription.

## Onboarding and ontology questions

**For:** new staff, complex installations.

A new cataloguer doesn't yet know the section and field names. They ask *"what sections can I edit?"*, *"what fields does the People section have?"*, *"how are interviews linked to people?"*. The assistant answers from the live ontology (the discovery tools), so the answer reflects *this* installation, not a generic manual. This works even on an external model with the default privacy posture, because ontology **structure** is not record content.

---

## When *not* to reach for it

- **Exact, repeatable reports.** If you know precisely which columns you want as a spreadsheet, [tool_export](../../../development/tools/reference/tool_export.md) is the right, deterministic tool.
- **Bulk edits.** The assistant proposes one plan at a time for human review; large mechanical changes belong in the import tools or a dedicated maintenance action.
- **Anything you would not let that user do by hand.** The assistant has exactly the user's permissions — no more — so it is not a way to grant a capability, only a new way to exercise one.

Ready to try these? The [Cookbook](cookbook.md) has concrete prompt patterns and, for developers, the HTTP recipes to drive the assistant from your own code.
