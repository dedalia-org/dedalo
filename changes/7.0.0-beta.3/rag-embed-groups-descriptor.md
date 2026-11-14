---
title: RAG embed-groups descriptor
type: added
audience: admin
date: 2026-07-22
---
What a section vectorizes is now AUTHORED
in its `section_map` node: `properties.rag.embed` is an array of named
groups, each an exact request_config `ddo_map`. A group is one vector
document per (record, data language) — the facet unit (a person's
`profession` vs `filiation`; a transcription with its own chunking) — stored
under `rag:<group>`. Resolution reuses the section-read machinery
(`emitDdoData`), so DEEP relation resolution works: a coin type's card can
embed its mint's *name*, resolved through the relation. Virtual sections
select their own maps (the section_map read is virtual-aware) — the earlier
per-component boolean opt-in, which could not differentiate virtual siblings
and indexed no text at all for virtual sections, is retired. Documentation:
[RAG & semantic search](./administration/ai/rag.md) ·
[cookbook R1](./administration/ai/rag_cookbook.md).
