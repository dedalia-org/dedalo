# The Dédalo archive format

**What this is.** The definition of the ONE complete, self-describing extraction of a Dédalo
section set — the artifact `src/core/archive/extract.ts` writes, `src/core/archive/restore.ts`
reconstructs, and `scripts/archive.ts` drives (`extract` / `verify` / `restore`). Built for the
preservation question the 2026-08-26 audit asked (P1-10; DATA-10, DATA-11, DATA-13): from this
artifact alone, a section's records, structure and media can be rebuilt in a database that never
held them, and read by a person with no copy of this codebase. Gates:
`test/unit/raw_roundtrip_native.test.ts` (the reconstruction test, byte-equal over every registry
model) and `test/unit/conform_locator_existence_native.test.ts` (every stored address accounted
for; a restore refuses what does not resolve).

**What it is not.** Not an interchange standard (no LIDO/METS/CIDOC/OAI serializer — a deliberate
scoping, see the audit row), not `tool_export`'s `dedalo_raw` CSV (a human-input door that conforms
cells on the way back and carries no bytes), not a `pg_dump` (complete, but a Postgres container).

## Layout

An archive is a **directory**. Transport is the operator's (`tar`); a container would be one
more thing a reader has to open.

```
<archive>/
  manifest.json              identity + census + digests (written LAST)
  ontology.json              { subtree: DdOntologyRow[], referenced: DdOntologyRow[] }
  records/<section_tipo>.ndjson   one JSON object per line, one line per record
  media/<root-relative path>      byte copies of the media files the records own
```

## manifest.json

| key | meaning |
|---|---|
| `format` / `format_version` | `dedalo-archive` / `1`. A reader refuses any other. |
| `created_at`, `engine_version` | ISO instant; the `DEDALO_VERSION` that wrote it. |
| `ontology.file`, `.sha256` | the ontology file and the digest of its bytes. |
| `ontology.digest` | sha256 over the **canonical JSON** (keys sorted at every depth, no whitespace) of the `subtree` rows sorted by `tipo` — the identity of the structure, independent of serializer. |
| `ontology.subtree_count`, `.referenced_count` | row counts. |
| `sections[]` | `{section_tipo, real_section_tipo, matrix_table, record_count, file, sha256}` per archived section. `matrix_table` is the SOURCE's; a restore resolves the destination's own. `real_section_tipo` is the REAL section of a VIRTUAL one (a thesaurus hierarchy, an alias — the section whose `relations` name a node of model `section`), `null` for a real section: the records' column keys are the real section's component tipos. |
| `media.file_count`, `media.files[]` | `{path, sha256, bytes, section_tipo, section_id}`; `path` is media-root-relative with a leading slash (the `files_info.file_path` shape). |
| `references.internal` | how many stored locators point at an archived record. |
| `references.external[]` | `{section_tipo, section_id, exists_in_source, holders}` — every distinct address stored by an archived record whose target is NOT in the set. |
| `not_archived[]` | what the format deliberately leaves out (below). |

## ontology.json

`subtree`: the `dd_ontology` rows of every archived section and its recursive children (the
resolver's DEFINITIONS walk, `getSectionDefinitionTipos` — it does not cross into a nested section,
and, NOT being a section walk, it keeps a `box elements` container, a `component_semantic_node` or an
area with its subtree: a value stored under such a key stays in the record and is archived raw, so
its definition must travel too — WC-2026-11-22-section-containment-law) — and, for a
VIRTUAL section, the rows of its REAL section and ITS recursive children as well (`getSectionRealTipo`,
the one law every child-by-model lookup follows): a virtual section's own children are list and
exclusion decorations, its records store under the real section's component tipos, so without the
real subtree not one column key of its records would be defined in the artifact. Every column: `tipo`,
`parent`, `term`, `model`, `order_number`, `relations`, `tld`, `properties`, `model_tipo`,
`is_model`, `is_translatable`, `is_main`, `propiedades`. These are RESTORED.

Honest limit, stated: ontology rows travel PARSED (nested JSON, not the jsonb canonical text the
records files use) and are re-bound through `upsertDdOntologyNode`'s serializer, so their identity
is STRUCTURAL — the digest and the conflict check are over canonical JSON (keys sorted, no
whitespace) — not byte identity. A numeric literal such as `1.10` inside `properties` or `term`
would come back as `1.1`. Definitions are structural data; the byte-lossless guarantee is made for
the record columns, where it matters, and is what the reconstruction gate asserts.

`referenced`: rows the subtree names but does not contain — the model node (`model_tipo`) of every
archived node, the relation targets of every section node (its `matrix_table` node among them),
and the section node of every external locator target. Context for the reader; NOT restored.

## records/<section_tipo>.ndjson

```json
{"section_id": 1, "columns": {"data": "{\"section_id\": 1, …}", "relation": "{…}", "string": null, …}}
```

Every line carries **all eleven** jsonb columns of the matrix row — `data`, `relation`, `string`,
`date`, `iri`, `geo`, `number`, `media`, `misc`, `relation_search`, `meta` — each as the **Postgres
canonical text** of the jsonb value (a JSON document in a string), or `null` for SQL NULL.

Why text and not nested JSON: the canonical text is the one lossless representation the engine has
of a stored column. It keeps `1.10` a numeric (a parse/stringify hop makes it `1.1`), keeps
canonical key order and spacing, and re-binds byte-identical through `$n::text::jsonb`. A reader
without this codebase parses each string once. The gate plants a `1.10` and asserts it survives.

Lines are sorted by `section_id`. Nothing is conformed, unwrapped, renumbered or re-shaped: the
`id` of every item, every `files_info` manifest, every locator travels as stored.

## media/

For each archived record with a `media` column, every file the record OWNS as the engine's own path
grammar resolves it — every quality × managed extension of each media component plus the AV
posterframe — copied to `media/<root-relative path>`. `files_info` is NOT consulted (it is a cache;
an archive built from a stale cache would have holes). Each file's sha256 and size are in the
manifest.

## Not archived (stated in the manifest)

- `matrix_time_machine` history — state is archived, history is not.
- media `deleted/` versions — the same rule.
- `component_av` subtitles files — not a quality slot of any media type.
- per-installation counters — a restore raises them from the ids it writes.

## Restore semantics

Everything checkable is checked BEFORE a write, and a refusal names what it found:

1. **Identity**: manifest shape and version; sha256 of every named file; the ontology digest;
   **self-description** — every archived section's node, and its `real_section_tipo` node when it
   is virtual, is a row of `ontology.subtree` (an artifact that cannot be read without a copy of the
   source ontology is refused as invalid, by `verify` too, before anything is written).
2. **Ontology**: a subtree node absent here is inserted; present and equal (canonical JSON) is
   left alone; present and DIFFERENT is refused unless `--on-ontology-conflict overwrite`.
3. **Records**: a `(section_tipo, section_id)` the destination already holds is refused unless
   `--on-existing-record overwrite` (its columns are replaced; the row keeps its history).
4. **Locators** (DATA-11): every address stored by an archived record must resolve — to an archived
   record, or to a record the destination holds NOW. Neither → refused, unless
   `--allow-external`, in which case the dangling addresses are written AS STORED and reported.
   Honest limit: for an address outside the set the restore proves EXISTENCE, not identity —
   `section_id` is a per-installation counter, so `x/7` here may be a different record than `x/7`
   was in the source. Archive the target sections together and the question does not arise.
5. **Media**: a target file that exists with the same bytes is skipped; with different bytes it is
   refused unless `--on-existing-media overwrite`.

Then: the ontology subtree is written (one transaction, under the projection lock of every tld it
writes — ordered against rebuild, teardown and the per-record and lifecycle doors). Under that lock,
before its first write, it REFUSES (`archive.refused`, nothing written) a write into a tld whose
nodes this installation derives from source records (`<tld>0` holds records here): the archive
carries rows, not their sources, so such a row would be an orphan or a clobbered node the tld's next
rebuild removes or reverts. Remedy: install or update that ontology so it defines the nodes, then
restore (they are found unchanged, or named as a conflict). A tld with no source records here
restores as before (gate: `archive_restore_projection_native`). Then the rows are written (one transaction —
`insertMatrixRecordWithExplicitId`, which raises the section counter, then the eleven columns bound
verbatim through `updateMatrixRecord{rawTextPassthrough}`), one whole-record Time Machine row per
record is stamped (`tipo = section_tipo`, `lg-nolan`, the delete door's shape — the restore is
visible in history without pretending to be a per-component save), and the media files are copied
through the media-root chokepoint (so the test-media guard and the traversal gate apply). Ontology
before rows is load-bearing: resolver caches serve committed state, so a section node written in
the same transaction as its rows would resolve to no table. The ontology commit is re-runnable.

Every restored row DECLARES the engine's post-write obligations through `afterRecordWrite` (the
same hook the create and duplicate doors end in): the save event that drops data-derived caches,
the security reaction (a restored users/profiles row is judged like a save), and the RAG index
event — so a restored record reaches the vector store like any other. Pinned by
`write_obligations_tripwire` (the restore is a raw `matrix_write` caller that reaches the hook).

The reader side is confined too: every path a manifest names (`ontology.file`, `sections[].file`,
`media[].path`) is resolved and refused if it escapes the archive directory BEFORE it is read — a
manifest is untrusted input, and `verify` must not be usable to hash arbitrary host files.
