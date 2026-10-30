# tool_ontology_parser

Keeps the runtime ontology (`dd_ontology`) consistent with its editable source (`matrix_ontology`): it inspects the drift per TLD, rebuilds a TLD from its source, and exports the ontology definition files for dissemination between installations.

## What it does / why & when to use it

`dd_ontology` is a **derived runtime projection** of the editable `matrix_ontology` records — one node per record, produced by the parser. Normal edits keep the two in sync per-save, but bulk imports, restores, failed partial writes and direct DB edits can leave them out of step. `tool_ontology_parser` is the developer's instrument for seeing and fixing that drift.

Use it when you have edited ontology records in bulk, imported an ontology from another Dédalo installation, or suspect the runtime tree does not match the source — and when you want to publish the ontology as files.

!!! tip "Inspect first, then rebuild"
    **Refresh status** is a pure read: it tells you which nodes are off, and by how much. **Rebuild** is the only write onto the projection — it is transactional, so readers keep seeing the current ontology until it commits, and a failure rolls the whole TLD back.

!!! note "There is no longer an incremental *Reconcile*"
    The tool used to offer a second, non-destructive write that applied only the delta. It was removed on 2026-08-11: its only advantage over a rebuild was avoiding a momentarily-empty ontology, and that stopped being true once the rebuild became transactional. What remained was a strictly weaker writer offered beside the stronger one — a choice with no criterion to make it by. One writer now.

## The invariant it maintains

The runtime ontology of a TLD must equal the parse of its source:

> `dd_ontology(tld)`  **==**  `parse(matrix_ontology(tld))`   (plus the bootstrap `<tld>0` main node)

The server owns one answer to *"is a TLD in sync?"* — `inspectOntology` in `src/core/ontology/ontology_state.ts` — expressed as a **drift** of three kinds:

| Drift | Meaning |
| --- | --- |
| **missing** | a matrix record exists, but its `dd_ontology` node does not |
| **stale** | both exist, but the node's content differs from the parsed source (which columns is reported) |
| **orphaned** | a `dd_ontology` node has no backing matrix record (its source was deleted) |

The comparison is by **meaning, not bytes**: jsonb key order is normalized, `{}`/`[]`/null all read as "absent", and `propiedades` (TEXT-holding-JSON) is compared parsed, not as whitespace — so a minified-vs-pretty difference is not false drift. Across a real install this leaves only genuine differences (e.g. the environment-specific ontology-info node).

## How it works (server + client)

**Server** (`tools/tool_ontology_parser/server/{index,tool_ontology_parser}.ts`). Developer-only. The dd_ontology write is OWNED by `ontology_state.ts` (the single rebuild authority, guarded by `test/unit/ontology_single_writer_tripwire.test.ts`); this tool only gates and surfaces it. Five actions:

| Action | Kind | Core |
| --- | --- | --- |
| `get_ontologies` | read (census) | every ontology's UI metadata (tld, name, typology) — feeds the checkbox tree |
| `inspect_ontologies` | **read (drift)** | `inspectOntology` per selected TLD — the status panel |
| `repair_tlds` | **write, SOURCE** | `normalizeOntologyTld` — rewrites a misfiled `ontology7` back to its section's tld |
| `regenerate_ontologies` | **write, the one projection write** | `rebuildOntology` — **transactional** wipe-and-rebuild |
| `export_ontologies` | write (files) | the ordered export pipeline (info → `ontology.json` → per-TLD COPY dumps → private lists → LLM map); the per-TLD dumps run **bounded-parallel** (≤ `EXPORT_CONCURRENCY`), the surrounding steps stay sequential |

The rebuild wraps the delete + reinsert in **one transaction per TLD**, so a failure rolls back with no empty window and no leftover backup table — replacing the retired `regenerateRecordsInDdOntology`, whose `dd_ontology_bk` table was its only, untested, rollback.

!!! note "A rebuild does not refresh the export files (WC-2026-08-11-regenerate-drops-llm-map-post-step)"
    A rebuild used to run `exportLlmMap` as a post-step and merge its errors into the
    response. It no longer does. `ontology_llm_map.json` is a **distribution**
    artifact — served beside `ontology.json` and the per-TLD dumps, read by nothing in the
    engine — and a rebuild refreshes none of its companions, so the map alone being current
    made the served set no more coherent. `export_ontologies` (step 5) rebuilds it, along
    with everything else it publishes.

    The removed step also dominated the tool's cost: it walks the **whole install** whatever
    TLD was selected, building a full `request_config` per link field. Measured on a
    752-section install, rebuilding one 178-record TLD — 76 ms for the parse and diff,
    21.2 s for the map. It is likewise where the `[request_config/explicit] dropped sqo
    target …` warnings on a regenerate came from: the map walk over *other* TLDs'
    components, never the rebuild.

**Client** (`tools/tool_ontology_parser/js/`). A checkbox tree of ontologies grouped by typology; a **status panel** (`paint_status`, fed by `inspect_ontologies`) showing each selected TLD as ✓ in-sync or ✗ with its drift counts; and four buttons — **Repair TLDs**, **Regenerate** (rebuild), **Export**, **Refresh status**. One `run_action` path drives every button (confirm → run → render messages → repaint the panel → always clear the spinner), so each action carries its **own** confirmation, and no response can leave the tool hanging.

**Finding a TLD.** The census runs to ~200 ontologies, most of them two-letter country codes, so the tree is headed by a search bar (`build_filter_bar`, matching in `js/ontologies_filter.js`). It matches case- and diacritic-insensitively on the **tld**, the **full name** (including the `|` segments the row does not display) and the **typology name** — so `espana` finds *España*, and typing a group name reveals that whole group. Whitespace-separated tokens are ANDed and order-independent. Alongside it: a `N selected` readout, a **Show selected only** toggle (composes with the query) and **Clear selection** — the selection is restored from `localStorage` and would otherwise be invisible across collapsed groups.

Filtering **hides** rows, it never re-renders them: every checkbox keeps its state and its handler, so a search can never alter `selected_ontologies`. Two consequences are load-bearing — a typology checkbox cascades to **visible children only** (otherwise it would silently check rows the operator cannot see, and the buttons below rebuild `dd_ontology` for exactly those TLDs), and a group the user collapsed is force-opened for the duration of a filter through a CSS `filtering` class, leaving the persisted collapse state unwritten.

## Actions & options

| Action | Permission | Reads from `options` | Returns |
| --- | --- | --- | --- |
| `get_ontologies` | `developer` | — | `{ result: ontologies[], errors }` |
| `inspect_ontologies` | `developer` | `selected_ontologies` | `{ result, states: [{tld, drift, inSync, mainNodeOk, matrixNodes, storedNodes, foreignNodes, tldlessNodes, tldlessRecords}] }` |
| `repair_tlds` | `developer` | `selected_ontologies` | `{ result, msg, errors, ar_msg }` |
| `regenerate_ontologies` | `developer` | `selected_ontologies` | `{ result, msg, errors, ar_msg }` |
| `export_ontologies` | `developer` | `selected_ontologies` | `{ result, msg, errors, ar_msg }` |

### Why `repair_tlds` exists, and why it is separate

A node's tld is DERIVED from the section it sits in (`actv0` can only hold `actv`, because the
node tipo is `<tld><section_id>`), so `ontology7` is emitted read-only in the edit form. That
removed the only place an operator could correct a record whose tld is wrong — while
`inspect_ontologies` still reports exactly those records. `repair_tlds` is that door.

It is deliberately NOT folded into the rebuild: the rebuild writes the **projection**, this
writes the **source**, and an operator is entitled to choose the second explicitly. It also
cannot ride inside the rebuild's transaction, because `normalizeOntologyTld` runs through `psql` on its own
connection and would block on the rows that transaction holds.

Its scope is narrow by construction: rows whose `string` is a JSON object carrying at least one
component besides `ontology7` itself, and whose declared tld differs from the section's.
Contentless rows — the `tldlessRecords` population — are untouched, because stamping a tld on
one would MATERIALIZE a nameless node in the tree.

!!! info "`tldlessRecords` is a warning channel, not drift"
    `drift` means "dd_ontology disagrees with what the source parses to". A record with no tld
    parses to nothing, so it is absent from *both* sides and disagrees with nothing — it does
    not flip `inSync`. It was briefly modelled as a drift kind, which painted the panel red on
    any install carrying legacy shells while Regenerate reported success, with no action able
    to clear it.

!!! warning "Rebuild wipes the runtime nodes, not the source"
    A rebuild deletes the TLD's `dd_ontology` nodes and re-derives them from `matrix_ontology`. The editable **source records are never touched** — the projection is regenerated from them. It runs in one transaction, so a mid-run failure rolls the whole TLD back.

## How it is registered & surfaced

`tools/tool_ontology_parser/register.json` restricts the tool (via `affected_tipos`) to the **Ontology section** (`dd5`), where it appears as the *Ontology parser* action. The action labels for the buttons resolve from the descriptor's label map and fall back to English, so the tool works before the labels are translated: `regenerate`, `repair_tlds`, `export`, `refresh_status`, the filter bar's `filter_placeholder` / `filter_no_matches` / `selected_count` / `show_selected_only` / `clear_selection`, and the `confirm_*` / `status_*` strings.

That English fallback is also what makes a missing translation invisible, so it is gated: `test/unit/tool_ontology_parser.test.ts` extracts every `get_tool_label('x')` key from the tool's own JS and fails if one is absent from the seed, is missing a language the seed already speaks, or is defined twice for the same language. Add a label and its ten translations in the same commit, or the gate says so.

!!! note "Editing `register.json` does not change a running install"
    The file is a **seed**; the runtime reads `matrix_tools`. The Register tools maintenance widget (and a code update) rewrites the `string` / `relation` / `misc` columns of *every* registered tool. To land one tool's edit, do a scoped merge instead: read that row's own column, merge only what changed, and `updateMatrixRecord('matrix_tools', 'dd1324', <section_id>, { misc })` — it writes only the columns you pass. Follow it with `invalidateAllToolCaches()` (or a dev-server restart), since `matrix_tools` is cached. Labels live in `misc.dd1372[0].value` as `{lang, name, value}` entries, and `buildToolElementContext` serves only the current application lang.

## Related

- [ontology (build layer)](../../../core/ontology/ontology_write.md) — the write drivers this tool gates, and `ontology_state.ts` seen from the ontology side.
- [tool_ontology](tool_ontology.md) — the per-record parse/sync used from single-edit and batch modes (the incremental path the normal edit flow takes).
- [Creating new tools](../creating_tools.md) · [Server contract](../server_contract.md).
- Source: `tools/tool_ontology_parser/server/{index,tool_ontology_parser}.ts`, `tools/tool_ontology_parser/js/{tool_ontology_parser,render_tool_ontology_parser}.js`; core: `src/core/ontology/ontology_state.ts` (`inspectOntology`, `rebuildOntology`), `src/core/ontology/data_io.ts` (the export pipeline).
