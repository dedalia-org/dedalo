# Diffusion

> See also: [Diffusion (system overview)](../core/system/diffusion.md) · [Exporting data](../using/exporting_data.md) · [Glossary: diffusion](../understanding/glossary.md#diffusion)

**Diffusion** is how catalogued work becomes published data. Dédalo keeps two database systems — the private **work** system a cataloguer edits, and the **diffusion** system a website or an integration reads — and the diffusion engine is the ontology-driven pipeline that moves a selected subset from one to the other, transforming it on the way. Work data and public data therefore never share a store, and publishing is never a read of the editing back-end.

## The pages

- **[The diffusion engine](native_engine.md)** — the pipeline itself: how a publication is described in the diffusion ontology, what the engine produces (SQL tables, RDF / XML / Markdown / CSV / JSON files), and how `tool_diffusion` drives it. Start here.
- **[Diffusion data flow](diffusion_data_flow.md)** — the conceptual half: which data leaves the work system, what happens to it in transit, and why the two systems stay separate.
- **[Parser cookbook & reference](parsers.md)** — the transformation steps an institution writes per publishable field: every parser, what it takes and what it emits.
- **[Markdown diffusion](diffusion_markdown.md)** — the one-file-per-record Markdown output, written so that AI agents and humans can read a record comfortably.
- **[Publication API](publication_api/index.md)** — the read-only service that serves the published databases to websites, integrations and agents.

## Where the control surface is

Publication is operated, not scripted: `tool_diffusion` issues the runs and shows their progress, and the engine's own actions (`diffuse`, `validate`, `get_process_status`, `cancel_process`, the media-index rebuild) are the [`dd_diffusion_api`](../api/classes/dd_diffusion_api.md) class of the JSON API.
