# WC-2026-10-01-rdf-ontology-import — `get_rdf_data` imports through the external ontology and WRITES

- **Date:** 2026-10-01.
- **Decision:** the v6 behaviour of `tool_import_rdf` (map the remote graph through the
  External Ontology, write into the record and the records it links to) is ported on the
  engine's own doors, with v6's write defects fixed; decisions of 2026-10-01: write
  immediately, never overwrite, one bulk process per run; linked terms matched first,
  fetched only when new, within the IRI's 15 s budget. Code:
  `tools/tool_import_rdf/server/{index,rdf_import_run,rdf_import_plan,rdf_import_prune,rdf_import_execute}.ts`,
  `src/core/tools/rdf_graph.ts`; `findSectionIdByCode` (`src/core/tools/import_code_lookup.ts`)
  now matches `component_iri` items (exact `==` leaf + byte-exact read-back) — it used to
  read only `.value`, so an IRI identifier never matched. New codes (registry + labels):
  `tool.rdf_class_unmapped` (caller/400, public, `details: {type}`),
  `tool.rdf_graph_too_large` (caller/400, public, `details: {limit}`).
- **Shape before:** `data = {rdf: [{uri, subjects}], errors: [{uri, error}]}` — fetch +
  parse only, `subjects` optionally shaped by a client-sent `tool_config.config.main`
  predicate map; no database write. `locator` optional, `ontology_tipo` ignored.
- **Shape after:**
  - `data = {report, errors, rdf, bulk_process_id}`.
    `report: [{uri, written: [{section_tipo, section_id, component_tipo, lang,
    value_summary, component_label}], created: [{section_tipo, section_id, label,
    section_label}], skipped: [{component_tipo, reason, component_label, section_tipo?,
    section_id?, iri?, code?}]}]` — one per IRI that reached the executor; a rolled-back IRI has
    empty lists and its cause in `errors`. `rdf` keeps the raw parsed subjects
    (compatibility); the `tool_config` predicate map is no longer read.
    `bulk_process_id`: the run's dd800 record (revert handle), null when nothing applied.
  - `locator` REQUIRED (`{section_tipo, section_id}`, positive integer id, a numeric
    string accepted): missing/invalid → 400 `request.invalid_options`, before any fetch.
  - `ontology_tipo` must be a node of model `external_ontology`; absent, the action reads
    `ar_tools_name.tool_import_rdf.external_ontology` of the new option
    `main_component_tipo` (sent by the client). Neither → 400 `request.invalid_options`.
  - New per-URI `errors[].error.code`s: `tool.rdf_class_unmapped` (no `owl:Class` maps
    the subject's type into the caller's section — its real one for a virtual section),
    `tool.rdf_graph_too_large`, and the code of a save that rolled the IRI back.
  - Linked terms that did not fit the budget (or whose site is out of service) are not
    linked: `skipped[].reason = 'not fetched — run again'` with `iri`; a permanently
    unreadable one is created + linked by IRI, reason
    `not fetched (<code>) — linked by its IRI only`. An intermediate pinned to a dropped
    term is dropped with it (no empty orphan). Past 128 lookups per IRI
    (`RDF_MAX_LINKED_LOOKUPS`): `reason = 'not linked — more linked terms than one
    import resolves'` with `iri`.
  - Only `http`/`https` IRIs are written or linked (stored-XSS guard: the remote document
    picks its IRIs; the client renders them as links). Plan skip
    `'unsupported_iri_scheme (<predicate>)'`; executor skip
    `'unsupported IRI scheme (http/https only) — not written'` (an IRI component's items,
    or a find-or-create keyed on a non-web IRI — no record is created).
  - `findSectionIdByCode` searches an HTML (`render: 'html'`, component_text_area)
    identifier as the paragraph it is stored as (`==`, `textAsParagraph`) and compares
    the stored value on its text (`paragraphAsText`): a Legend/Design record is found
    again on a rerun (it was duplicated every run). The MARC21 door shares the lookup.
  - Fix round 1 (2026-10-01, before release): a geo-tag text (`[geo-n-1-1-data::data]`)
    is saved without `appendImport` into its empty slice (the text-paragraph merge
    refuses tags and rolled the whole IRI back); `importsInto` compares REAL sections on
    both sides (a class relating a virtual section imports into that section).
  - Fix round 2 (2026-10-01, before release):
    - An INTERMEDIATE (ddo_map) is created only by the op that COMPLETES its path (the
      link to a record whose path holds the resource, or the identifier itself in a
      leaf); ops on it before that wait and are applied right after it exists. One no op
      completes is never created: skips `'intermediate not created — no record of <iri>
      was linked'` and `"record '<key>' not created"` per waiting op. (It used to be
      created first and committed EMPTY when the resource's record was not bound —
      ambiguous, refused — so every rerun added another.) A ddo_map resource that is no
      web IRI is a plan skip `unsupported_iri_scheme`, never an intermediate.
    - Linked terms are matched ACROSS PROJECTS (deliberate v6 parity:
      `get_resource_match` used `skip_projects_filter`): a term another project holds is
      LINKED, never created again (a copy also made every later admin lookup ambiguous →
      `resource.conflict`). Writes into it still pass the record scope
      (`perm.out_of_scope` skip). `findSectionIdByCode` gained a server-only
      `{skipProjectsFilter}` option; MARC keeps the default (it writes INTO what it finds).
    - A text carrying Dédalo tag syntax other than the plan's own geo tag (exactly
      `[geo-n-1-1-data::data]`, bare or as one paragraph) is never written: skip
      `'remote text carries Dédalo tag syntax — not written'` (a remote label could plant
      an index/reference tag naming any locator). The append-merge bypass is the geo tag's
      only.
    - Literals of a mapped predicate ALL in languages the install lacks: plan skip
      `'language_not_installed (<predicate>)'` (was dropped silently; literal, class-
      literal and split-driver predicates).
  - Fix round 3 (2026-10-01, before release — a partial failure is partial; measured
    live: one refused link rolled back a whole OCRE IRI, title/dates/legends/mint lost):
    - ONE SAVEPOINT PER OP inside the IRI's transaction (`withSavepoint`,
      `src/core/db/postgres.ts`). An op refused by an error of the registry's
      CALLER/PERMISSION/CONFLICT category (`relation.insert_refused`, `perm.denied`,
      `request.invalid`, `request.invalid_data`, `resource.conflict` …) rolls back alone and
      is a skip `{component_tipo, reason: 'refused: <registry message> (<public details>)',
      code}`; an op naming a record whose op was refused is skipped
      `'depends on <key>, which failed'` with the same `code`. Atomic groups are one op (a
      find_or_create + its identifier write; an intermediate + the op completing its path).
      A BORN record whose identifier write is SKIPPED, not thrown (a component grant,
      remote text carrying tag syntax, an undeclared language), is refused the same way:
      new code `tool.rdf_identifier_unwritable` (caller, 400, `details: {reason}` = the
      skip sentence) — the op's savepoint takes the record, its link and the ops that
      waited for it back (born without its identifier, every run would add another).
      A term created by its own op STAYS when the separate link to it is refused at the
      insert door for any reason but off_target (`selection_limit`,
      `term_not_selectable`, the read grant → `perm.denied`): it is a complete authority
      record (identifier + fields, the run's birth marker — reverted with the run), found
      again by the next run, never duplicated; the refused link is the skip.
      An internal fault (internal.*, a db error that is no refusal, a save answered
      `ok:false` → `record.save_failed`) still rolls the whole IRI back (`errors[]`, empty
      lists). `skipped[]` gains the optional `code`.
    - THE TARGET CHECK before any lookup, fetch or create (`rdf_import_prune.ts`, the insert
      door's own resolution — `resolveCallerTargets` + `isTargetAllowed`,
      `src/core/relations/picker_constraint.ts`): a link/intermediate into section S
      through component C, S not among C's targets → skip
      `'ontology <class or property tipo> maps <S>, but <C> targets <list> — fix the
      ontology node'`, `code: 'relation.insert_refused'`; the term only that link reached
      is not looked up, fetched or created, and the ops on it are skipped as depending on it.
    - LAZY dd800: minted by the run's first write or create (inside that op's savepoint;
      registered live at once — `withLazyLiveBulkRun`, `src/core/tools/bulk_run_registry.ts`).
      A run that writes nothing (a re-run) leaves no dd800 and no TM row:
      `bulk_process_id: null`. A locator already linked is skipped `'already present'`
      before the save (no save, no mint).
    - Client: a skipped line carrying a `code` is marked `refused` (still in the skipped
      list, beside what the IRI wrote and created — never an IRI failure).
  - Fix round 4 (2026-10-01, before release — review of round 3):
    - A NESTED intermediate whose create is refused only when the completing op realizes
      the chain (its target was still pending, so nothing asked earlier) refuses that op
      as `tool.rdf_identifier_unwritable`, `details.reason` = the create refusal
      (`'not created: refused (<code>)'`): the op's savepoint takes back the outer
      intermediates realized for it and their link from the caller. Skips: `{<completing
      component>, 'refused: Not created: the record could not hold the identifier that
      finds it again (not created: refused (<code>))', code}` and, for each outer one,
      `'intermediate not created — no record of <iri> was linked'`. (It was a plain
      `'not created: refused …'` + `"record '<key>' not resolved"` pair while the outer
      intermediate COMMITTED, empty and linked — one more per rerun.)
    - Engine, no wire change: a record the save materializes under an op's savepoint (a
      caller deleted while the tool was open) keeps its dd800 birth marker, NEW activity
      row and epoch — `createSectionRecord` decides a birth by its insert statement
      (`ON CONFLICT DO NOTHING … RETURNING`), never by the row's xmin (a subtransaction's
      id under a savepoint).
  - Decision 2026-10-02 (before release — measured live: Nomisma `id/ar` created a
    duplicate of material1/3, which held the term's getty/wikidata exactMatch IRIs but
    not the nomisma one): a FETCHED linked term no record holds by its own IRI is looked
    up by its EQUIVALENTS — every value its fetched plan writes into the class's match
    component (`skos:exactMatch` → `hierarchy89` on the live mapping; the ontology
    decides, no predicate spelling in code), EVERY distinct one (trimmed; blanks and its
    own IRI not counted) plus the http↔https TWIN of each and of its own IRI (otherwise
    byte for byte: a trailing slash is another identifier), searched
    `RDF_EQUIVALENTS_PER_SEARCH` (32) per search — one `$or` code lookup
    (`findSectionIdsByCodes`, byte-exact second read, a full candidate window refused) —
    ALL of them, stopping once two records are found; principal-scoped (the importer's
    read grant on the match component decides) and across projects like the own-IRI
    lookup. When no record answers, the terms THIS IRI already created are matched by the
    identifiers they were created for (own + equivalents), before the ops that write them
    run — two linked terms of one document sharing an equivalent are ONE record. ONE lookup rule for the
    run and the executor (`matchTerm` / `findTermRecord`, `rdf_import_execute.ts`; the op
    carries them as the new optional `match_equivalents`):
    - exactly ONE record holds one → it is linked, nothing is created, and the term's OWN
      IRI is appended to its match component (append-only, deduped; a `written` line on
      that record, in the run's bulk process — its revert takes it back) — the term's other
      equivalents and fields are NOT written (minimal: the next run matches it directly,
      with no fetch). The append passes the importer's record scope (a record outside their
      projects: linked, skip `not writable by the importer (<code>)`) and the fill-only law:
      into a component_iri it always appends; into a LITERAL match component it lands only
      in an empty `match_lang` slice, else skip `not empty in <lang> — never overwritten`
      (the link stands; the term is fetched and matched by its equivalent again next run).
      This holds however the match was reached: a term unknown when the run looked it up
      (its fetched plan kept) but matched by an equivalent at EXECUTE time (an earlier IRI
      or op of the run created the record) has every op writing INTO that record withheld,
      one skip each `{<component>, 'matched by an equivalent identifier — only its own
      identifier is added, not the fetched fields', section_tipo, section_id}`; links TO
      it stand;
    - MORE than one distinct record → nothing linked, created or appended: skip
      `{component_tipo: <match component>, reason: "The linked term '<iri>' is held by no
      record of section <s>, but its equivalent identifiers are held by <n> different
      records (<ids>), so it names none of them. Not linked, not created — merge the
      duplicate records in <match component> first."}` + `"record '<key>' not resolved"`
      per link to it (also when ONE equivalent is itself shared by two records; a full
      candidate window is the code lookup's own `matched the search cap` sentence);
    - none → created as before (it then holds its own IRI and its equivalents), however
      many equivalents it names (an earlier draft refused a term naming more than 32 —
      never released).
- **Reason:** the TS port fetched and displayed the graph but wrote nothing, which is
  not what the tool exists for (v6 parity). The report replaces the subject dump as what
  the cataloguer reads.
- **Gate reconciliation:** no parity fixture covers `get_rdf_data`; no re-harvest. Gates:
  `test/unit/tool_import_rdf.test.ts` (action validation, the door seam, the whole import
  on the suite DB under a scratch `zzrdfwire` External Ontology, budget/linked-term rules),
  `test/unit/rdf_graph.test.ts`, `test/unit/rdf_import_plan.test.ts`,
  `test/unit/rdf_import_execute_native.test.ts`, `test/unit/action_scope_binding_tripwire.test.ts`
  (the READ exemption became a per-write re-authorization exemption: `ddo_map` is ontology,
  not client), client `test_tool_import_rdf.js`.

## Addendum 2026-11-10 — a missing caller is no longer re-created

WC-2026-11-10-save-never-creates: a save never creates a record. The "record the save
materializes under an op's savepoint (a caller deleted while the tool was open)" above
no longer happens: the caller's write is refused `resource.not_found` (category
`not_found`, which `isOpRefusal` does not count as an op refusal), so the whole IRI rolls
back and reports `error: 'save: record <S>/<N> does not exist — …'` (or `… was deleted —
restore it from Time Machine`) with nothing written, created, born or logged. Gate:
`rdf_import_execute_native` ("a caller record that is MISSING is never re-created").
