# Building tools

> See also: [Development](../index.md) · [Using the tools](../../tools/index.md) · [Extending Dédalo](../extending/add_a_component.md)

A **tool** is an isolated block of code that extends a component, a section or an area with its own interface: transcription, export, import, the time machine, the ontology editor. A tool ships a server module, its own client JS/CSS, and a `register.json` that declares what it attaches to. Nothing about a tool is discovered by reflection — the framework scans an allowlisted directory once and dispatches through a fail-closed gate chain.

This directory is the **developer** documentation. For the curator-facing guides to each shipped tool, see [Using the tools](../../tools/index.md).

## Build one

- **[Creating new tools](creating_tools.md)** — the end-to-end tutorial: scaffold, register, authorize. Start here.
- **[register.json reference](register_json.md)** — every field of the registration file, and the JSON Schema your editor can validate against.

## The contracts the framework enforces

- **[Tools server contract](server_contract.md)** — what a tool's server module must export, how actions are keyed, and the ordered gate chain a request passes through.
- **[Tools JS lifecycle](js_lifecycle.md)** — the client-side contract: the files, the constructor/prototype shape, and the lifecycle hooks.
- **[Tools security model](security.md)** — what the framework guarantees for you, and what stays the tool author's responsibility.
- **[Tools on a phone](phone_layout.md)** — the 360px contract every tool meets, the shared phone rules and touch gestures, and how `bun run test:tools:phone` checks it.

## Per-tool reference

- **[Tools catalog](reference/index.md)** — every tool shipped with Dédalo, grouped by purpose, each linking to its own reference page.
