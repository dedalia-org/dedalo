# tool_import_rdf

Imports an external Linked-Open-Data resource into a record: it fetches the RDF/XML graph an IRI names, maps it through an *External Ontology* described in the Dédalo ontology, and writes the values into the record and into the records it links to, finding or creating those as it walks the graph.

## What it does / why & when to use it

`tool_import_rdf` turns an **external RDF resource**, identified by an IRI already stored in a record, into data in that record. The mapping is driven by the **ontology**: an *External Ontology* node (model `external_ontology`, under the dd1270 term) describes one vocabulary — its namespace prefixes, the RDF classes it imports (`owl:Class` children) and, under each class, the RDF properties that map onto Dédalo components (`owl:ObjectProperty` children). The tool fetches the graph, reads the resource's `rdf:type`, picks the class that maps it, and walks its properties.

Concrete heritage scenario: a numismatist is cataloguing a Roman coin type and has pasted the [Nomisma](http://nomisma.org)/OCRE IRI `http://numismatics.org/ocre/id/ric.1(2).aug.1A` into the record's IRI component (`numisdata310`). They open **Import RDF** on that component, pick the IRI and run it. The tool asks the IRI for RDF/XML, finds it is an `nmo:TypeSeriesItem`, which the External Ontology `numisdata1129` maps to the Types section (`numisdata3`), and fills the record: the title in every language the graph gives, the definition, the date range, the reference number. The coin's mint, denomination and material are linked as records: when a record with that authority IRI already exists it is linked; otherwise the tool fetches the authority's own RDF to read its labels, creates the record, and links it.

Use it when a section uses an external LOD vocabulary (Nomisma, GeoNames, Dublin Core…) that an administrator has described as an External Ontology, and you want a resource's data in the record. Do **not** use it for bulk file imports (use the CSV / MARC21 / Zotero import tools): this tool imports a few IRIs per call (one from its UI, at most three) from a live remote graph.

## How it works (server + client)

**Server** (`tools/tool_import_rdf/server/`): the action is in `index.ts`; the import is four modules, each with its own gate.

1. **Fetch** (`index.ts`, `fetchRdfDocument`). Each IRI is fetched through the harvesting door, `harvestFetch` (`src/core/harvest/harvest.ts`; [Fetching from other sites](../server_contract.md#fetching-from-other-sites-srccoreharvestharvestts)). First by **content negotiation**: the IRI itself, with `Accept: application/rdf+xml` (one type: some servers match the header literally and answer a weighted list with 406), and only an RDF/XML or XML answer accepted. Linked-data servers answer an IRI with a `303 See Other` to the document, or a `301` to https; the door follows them and checks every hop again: a public address, the connection pinned to it, and the site's robots.txt. Requests to one site are paced (at least 3 s apart, longer when the site's robots.txt sets a `Crawl-delay`), and each hop is bounded to 15 s and 20 MiB.
    - **The `.rdf` fallback.** When the negotiated answer says the document is not there (a 4xx other than 408 and 429), or is a 2xx of another type such as an HTML page, the tool tries once more at the IRI's `.rdf` file form (`<iri>.rdf`, fragment and trailing slashes dropped; only for an http(s) IRI with a path; never when it already ends in `.rdf`, in any case). For that form, `application/octet-stream` and `text/plain` are accepted too. A refusal is never retried: a refused address, a robots.txt that disallows, a timeout, a body over the ceiling, and a 5xx, 408 or 429.
    - **The deadline.** Each IRI has `RDF_IRI_DEADLINE_MS` (15 s) for everything — robots.txt, the site's pace, every redirect, the `.rdf` retry, and the linked terms it fetches (step 3). It is a job signal (`runWithJobSignal`, `src/core/media/job_scope.ts`): the door ends every wait and request of that IRI when it fires.
2. **Graph and plan** (`src/core/tools/rdf_graph.ts`, `rdf_import_plan.ts`). The document is read into triples by a from-scratch RDF/XML reader (scoped namespaces, `xml:base`, nested and blank nodes, `xml:lang`, `rdf:datatype`, `parseType`), bounded in depth and size (`tool.rdf_graph_too_large`). The subject is the IRI as sent — or its `.rdf`-less form, or the same address under the other http scheme, the first the graph types. The plan reads the External Ontology subtree once and turns the graph into an ordered list of operations, with no database access:
    - the subject's `rdf:type` selects the `owl:Class` whose term names it (e.g. `numisdata1130`, term `nmo:TypeSeriesItem`, `relations` → section `numisdata3`, `properties.match` → `numisdata310`). A type that no class maps **into the caller record's section** (the same section, or one with the same real section — a virtual one and its real one, or two virtuals of it) is a per-URI **`tool.rdf_class_unmapped`** error, and nothing of that IRI is written.
    - each `owl:ObjectProperty` child names a predicate (term, e.g. `numisdata1131` `skos:prefLabel` → `numisdata81`). Its first relation is the target component; a second relation names the `owl:Class` of the object (e.g. `numisdata1137` `nmo:hasMaterial` → `numisdata32`, class `numisdata1167` `nmo:Material` → section `material1`, matched by `hierarchy89`). An ObjectProperty with ObjectProperty children is a path into a sub-resource (an obverse, a reverse). `properties.process` transforms the value (`data_map`, `split`, `date`, `geo_tag`, `geo_map`); `properties.ddo_map` routes it through an **intermediate** record (creators → person → URI).
    - literals are written per installed data language (an untagged literal in the current data language; a non-translatable component gets one value); a predicate whose literals are ALL in languages the install lacks is a skip `language_not_installed`; text written into an HTML component is escaped and wrapped in one paragraph (`textAsParagraph`, `src/core/tools/import_code_lookup.ts`); text written into a number component (its column is `number`) is cast to the number it spells (decimal, optional sign, fraction and exponent; surrounding blanks ignored), and text that spells none is a skip `number_unparsed` — the save door refuses a string there. An object resource becomes a **find-or-create** of the record its class maps, keyed by its identifier, plus a **link** to it.
    - only **web IRIs** (`http`/`https`) are stored or linked: the remote document chooses its IRIs, and a `javascript:` or `data:` one in a `component_iri` would be served as a live link. Any other resource is a skip `unsupported_iri_scheme` (a blank node stays `blank_node`).
    - every mapped predicate that cannot be written (a blank node, an unparsed date, a `data_map` without a match…) becomes a reported **skip**, never a silent drop.
3. **Linked terms** (`rdf_import_run.ts`). **Match first:** a linked term whose identifier some record already carries is linked as it is and never fetched. Only an unknown term is dereferenced, through the same fetch, within what is left of the IRI's deadline, and its own plan is appended to the operation list (after every record the main plan names, so a term may link one of them). **Equivalents:** once fetched, a term no record holds by its own IRI is looked up again by the identifiers its own plan writes into the class's match component (on the Nomisma mapping, its `skos:exactMatch` IRIs; every distinct one, in every project). Exactly one record holding any of them **is** the term: it is linked, nothing is created, the fetched plan is not applied, and only the term's own IRI is appended to that record's match component (in the run's bulk process, so a revert takes it back), so the next run finds it directly without a fetch. The append is an ordinary write into an existing record: it passes the importer's record scope (outside their projects: linked, `not writable by the importer`) and the fill-only law (a component_iri always takes it; a literal match component only into an empty `match_lang` slice, else `not empty in <lang> — never overwritten`, and the term is matched by its equivalent again next run). Several different records holding them name none: nothing is linked or created, and the skip names the candidates. Every equivalent is searched, however many, `RDF_EQUIVALENTS_PER_SEARCH` (32) per search (`findSectionIdsByCodes`), until two records are found; each is compared byte for byte, and also under its other http scheme (`http://` ↔ `https://`, as is the term's own IRI) — a trailing slash or any other spelling is another identifier. The lookup is the importer's: a match component they may not read matches nothing. None: the term is created as usual. A term matched by an equivalent only at execute time (an earlier IRI of the call, or an earlier term of the same document, created the record) keeps the same rule: every write of its fetched plan into that record is skipped (`matched by an equivalent identifier — only its own identifier is added, not the fetched fields`); and a term created earlier in the same IRI is matched by the identifiers it was created for even before they are written, so two linked terms of one document that share an equivalent become one record. The run and the executor share this one rule (`matchTerm`, `rdf_import_execute.ts`). A term that does not fit the budget (less than `RDF_LINKED_MIN_MS`, 1 s, left; or past `RDF_MAX_LINKED_FETCHES`, 32), or whose site is out of service, is **not linked** and is reported `not fetched — run again`: the next run finds nothing, fetches it and completes it. An **intermediate** whose resource is such a term is dropped with it (created empty, it could never be found again, and every run would add another). A term whose document is permanently unreadable (a 404, a web page, too large) is created and linked by its IRI alone, and reported so. At most `RDF_MAX_LINKED_LOOKUPS` (128) linked terms are looked up per IRI; past that, a term is reported `not linked — more linked terms than one import resolves`. Dropped terms are pruned from the operation list in one pass at the end.
4. **Execute** (`rdf_import_execute.ts`). One `dd800` bulk process per call (the revert handle, `bulk_process_id`), created by the call's **first** write or create — a call that changes nothing (a re-run) leaves none, and `bulk_process_id` is `null`. **One transaction per IRI, one savepoint per operation.** Before anything is looked up, fetched or created, every link is held to **the target check** (`rdf_import_prune.ts`, with the relation insert door's own resolution): a link into a section its field does not target — an External Ontology node that maps the wrong section — is skipped with the reason `ontology <class or property tipo> maps <section>, but <field> targets <sections> — fix the ontology node`, and the related record only that link reached is not looked up, fetched nor created. Every write is asked of the write door as the importing user: the caller record and every found record through `authorizeRecordAccess` (its record scope included), a create through `authorizeSectionTarget` at the section and at its match component. The rules:
    - **never overwrite**: a literal is written only into an empty language slice; an IRI is appended unless already stored (and only an `http`/`https` one: the executor checks again); a link is appended through the relation insert law (no duplicate); a single-choice field (a select) is set only when empty. Every save is an `appendImport` save, so a value written meanwhile is kept, never replaced — except the plan's own geo tag (exactly `[geo-n-1-1-data::data]`, from a `geo_tag` process), which the append merge refuses: it is saved plainly into its empty slice. Any OTHER text carrying Dédalo tag syntax is remote text (a label or definition from the source) and is never written — a bracket tag in it would be stored as a real index or reference tag naming whatever locator the document chose.
    - **find before create**: a linked record is looked up by its identifier (`findSectionIdByCode`, an IRI matched exactly; an identifier in an HTML component — a legend, a design — searched as the paragraph it is stored as and compared on its text); one identifier shared by two records is refused, never guessed. The lookup spans **every project** (as in Dédalo 6, `skip_projects_filter`): an authority another project holds is the same authority, so it is linked, never created again — a copy would also make every later lookup of it ambiguous. Writes into a found record still pass the importer's record scope. A resource with no identifier, or with a non-web IRI as identifier, is never created.
    - **intermediates**: an intermediate record is found among the records the target already links to, by walking its `ddo_map` path down to the resource's identifier. A new one is created only when the target's link is writable AND its own section's create door admits it — and only by the operation that **completes its path** (the link to the resource's record, or the identifier itself); operations on it that come earlier wait and are applied right after it exists. One whose path is never completed (the resource's record ambiguous, refused or not fetched) is not created: an empty one could never be found again, and every run would add another. A found one is an existing record (the record scope applies to every write into it).
    - **a partial failure is partial**: an operation the engine refuses — any error of the registry's caller, permission or conflict category (`relation.insert_refused`, `perm.denied`, `request.invalid_data`, `resource.conflict` …) — is rolled back to its savepoint and reported as a skip carrying its `code` (`refused: <message> (<details>)`); every operation on a record whose operation was refused is skipped as `depends on <key>, which failed`. What must stay together is one operation: a related record and the identifier it is found by; an intermediate and the operation that completes its path. A record that would be created but cannot hold the identifier that finds it again (the field is not writable by the importer, the text carries tag syntax, the language is not installed) is refused the same way, with `code: tool.rdf_identifier_unwritable` (`details: {reason}`): created without it, every run would add another. A related record created by its own operation stays when the separate link to it is refused (the field's selection limit, a term that is not selectable, the read grant on its section): it is a complete record, found again by the next run, and reverted with the run's bulk process. An engine **fault** (an `internal.*` error, a database error that is no refusal, a save answered `ok:false`) still rolls the whole IRI back and is a per-URI error.

**Client** (`tools/tool_import_rdf/js/`): `tool_import_rdf.js` is the instance; `render_tool_import_rdf.js` builds the edit UI — a radio button per IRI value found on the source `component_iri`, a default-language selector (for literals that arrive without a language tag), and an **OK** button. The tool reads its `external_ontology` tipo from the source element's `properties.ar_tools_name.tool_import_rdf.external_ontology`, calls `get_rdf_data(ontology_tipo, ar_values)`, and on success `render_rdf_payload` fills the result pane: per IRI, the records it **created**, the fields it **wrote** (component name, language, value), what it **skipped** and why (a skip the engine refused — it carries a `code` — is marked `refused`; it is never shown as an IRI failure), and the parsed subjects in a collapsed *RDF* section; then one line per failed IRI (`<uri>: <message>`, in the user's language); then the bulk process id. Every value is written as text. It then refreshes the parent section. Client test: `client/dedalo/test/client/js/test_tool_import_rdf.js`.

## Actions & options

`apiActions = { get_rdf_data: { permission: 'section_list', minLevel: 2, sectionTipos: rdfSectionTipos, handler: getRdfData } }` — gated write/2 on the locator's section, the record the values are written into. Every single write is then authorized again by the executor (above).

| Action | Permission gate | Background | Reads from `options` |
| --- | --- | --- | --- |
| `get_rdf_data` | declarative `permission: 'section_list', minLevel: 2` on `locator.section_tipo` | no | see below |

Key options read by `get_rdf_data`, validated in this order:

| Option | Type | Meaning |
| --- | --- | --- |
| `ar_values` | array of strings (req.) | The IRIs to import, e.g. `["http://numismatics.org/ocre/id/ric.1(2).aug.1A"]`. At most 3 (`tool.too_many_items`, `details: {count, limit}`); anything that is not an array of strings is `request.invalid_options`. |
| `locator` | object (req.) | `{section_tipo, section_id}` of the record to import into. `section_id` is a positive integer (a numeric string is accepted). Missing or invalid: `request.invalid_options`. |
| `ontology_tipo` | string | The **External Ontology** node to map through (e.g. `numisdata1129`). Must be a node of model `external_ontology`; anything else is refused with `request.invalid_options`. |
| `main_component_tipo` | string | The fallback when `ontology_tipo` is absent: the `ar_tools_name.tool_import_rdf.external_ontology` of this component's properties (e.g. `numisdata310`). No ontology either way: `request.invalid_options`. |

Response data:

```js
{
    report : [ {                     // one per IRI that reached the executor
        uri,                         // the IRI as sent
        created : [ {section_tipo, section_id, label, section_label} ],
        written : [ {section_tipo, section_id, component_tipo, lang, value_summary, component_label} ],
        skipped : [ {component_tipo, reason, component_label, code?, section_tipo?, section_id?, iri?} ]
    } ],
    errors : [ {uri, error} ],       // per-URI failures (fetch, read, unmapped type, rolled back)
    rdf    : [ {uri, subjects} ],    // the parsed subjects of each loaded IRI (kept for compatibility)
    bulk_process_id                  // the run's dd800 record, null when nothing was written or created
}
```

`error` is the error system's wire body (`code`, `message`, `retryable`, …), the same one a failed call carries; a refused address never reaches the page. The per-URI codes: `security.ssrf_blocked`, `harvest.robots_disallowed`, `harvest.unexpected_type`, `harvest.refused`, `harvest.too_large`, `security.outbound_failed` (a 4xx on both forms, any other transport failure), **`tool.source_unavailable`** (public, `details: {site}`: the site did not answer in time, failed, answered 5xx/408/429, or could not deliver its robots.txt), `tool.rdf_graph_too_large` (`details: {limit}`), **`tool.rdf_class_unmapped`** (`details: {type}`), and the code of a save that rolled an IRI back. When both fetch forms fail, the IRI's own answer is reported, except when it only answered an error status and the `.rdf` form answered a file of the wrong type.

The skip `reason`s, as the report gives them: `not empty in <lang> — never overwritten`, `already present`, `already set (single choice) — never overwritten`, `not writable by the importer (<code>)`, `not created: refused (<code>)`, `language <lang> is not installed`, `unknown component`, `no identifier — not matched, not created`, `record '<key>' not resolved`, `intermediate not created — no record of <iri> was linked`, `record '<key>' not created` (an operation that waited for that intermediate), `remote text carries Dédalo tag syntax — not written`, `not fetched — run again`, `not fetched (<code>) — linked by its IRI only`, `refused: <message> (<details>)` and `depends on <key>, which failed` (with `code`), `ontology <tipo> maps <section>, but <field> targets <sections> — fix the ontology node` (with `code: relation.insert_refused`), `not linked — more linked terms than one import resolves`, `unsupported IRI scheme (http/https only) — not written`, the ambiguity sentence of an identifier two records share, the conflict sentence of a term whose equivalents are held by several records (`… its equivalent identifiers are held by <n> different records (<ids>) …`), `matched by an equivalent identifier — only its own identifier is added, not the fetched fields`, and the plan's own `<reason> (<predicate>)` (`blank_node`, `unsupported_iri_scheme`, `language_not_installed`, `date_unparsed`, `number_unparsed`, `data_map_no_match`, `no_class_for_resource`, …).

Tests: `test/unit/tool_import_rdf.test.ts` (the action, the fetch through the door's `hop` seam, and the whole import on the suite database under a scratch External Ontology), `test/unit/rdf_graph.test.ts`, `test/unit/rdf_import_plan.test.ts`, `test/unit/rdf_import_execute_native.test.ts`.

## How it is registered & surfaced

`tools/tool_import_rdf/register.json` is a **column-keyed dump** (`string`/`relation`/`misc`/… keyed by component tipo — a seeded matrix-row snapshot, not a hand-authored file); `importTools()` passes it through as-is (see [register.json reference](../register_json.md)). The essentials it carries:

- `dd1326` name = `tool_import_rdf`; `dd1327` version (`1.0.2`); `dd1328` minimum Dédalo version (`6.0.0`); `dd1644` developer (*Dédalo team*).
- `dd1350` affected_tipos = `["numisdata310"]` — the tool attaches to a specific **`component_iri`** tipo (the IRI field that holds the external resource link). It is not surfaced on whole sections by model.
- `dd1335` properties = `{ "component_config": [ { "tipo": "numisdata310", "external_ontology": "numisdata1129" } ] }` — pairs each IRI component tipo with the External Ontology node that describes its vocabulary.
- `dd1331` show_in_inspector = `false`, `dd1332` show_in_component = `true` → the **Import RDF** button renders **inline on the IRI component**, in edit mode, on records whose tipo matches `affected_tipos`.
- `dd1372`/`dd1353` carry the localized label (*Import RDF* / *Importar RDF* / …) across project languages.

Surfacing (in `getElementTools`, `src/core/tools/registry.ts`): because surfacing is `affected_tipos`-restricted and `show_in_component` is set, the button appears next to the configured `component_iri` field — it is a component-level tool, not a section-toolbar or inspector tool. The RDF mapping itself is authored in the ontology under the *External Ontologies* term (dd1270).

## Examples

Client-side `tool_request` (built by `tool_import_rdf.js::get_rdf_data`, sent through `dd_tools_api`):

```js
const rqo = {
    dd_api : 'dd_tools_api',
    action : 'tool_request',
    source : create_source(self, 'get_rdf_data'),
    options : {
        ontology_tipo       : 'numisdata1129', // the External Ontology node (Nomisma import)
        main_component_tipo : 'numisdata310',  // fallback source of the ontology tipo
        ar_values           : ['http://numismatics.org/ocre/id/ric.1(2).aug.1A'],
        locator             : {
            section_tipo : self.caller.section_tipo, // the record being enriched
            section_id   : self.caller.section_id
        }
    }
}
const response = await data_manager.request({ body: rqo, timeout: 60000 })
// response.data = { report: [...], errors: [...], rdf: [...], bulk_process_id }
```

The class and two properties of the live `numisdata1129` External Ontology, as the plan reads them:

```text
numisdata1130  owl:Class           term nmo:TypeSeriesItem  relations [numisdata3]   properties {match: numisdata310}
  numisdata1131  owl:ObjectProperty  term skos:prefLabel      relations [numisdata81]
  numisdata1137  owl:ObjectProperty  term nmo:hasMaterial     relations [numisdata32, numisdata1167]
numisdata1167  owl:Class           term nmo:Material        relations [material1]    properties {match: hierarchy89}
```

## Related

- [tool_import_dedalo_csv](tool_import_dedalo_csv.md) · [tool_import_marc21](tool_import_marc21.md) · [tool_import_zotero](tool_import_zotero.md) — the other import tools (file-based, where this one is IRI/graph-based).
- [Importing data](../../../core/importing_data.md) — the import model, per-component conform contract and language handling these writes go through.
- [tool_export](tool_export.md) and [Exporting data](../../../core/exporting_data.md) — the export counterpart.
- [Creating new tools](../creating_tools.md) · [Server contract](../server_contract.md) — the tool model, `apiActions`, gates and lifecycle this page builds on.
- Source: `tools/tool_import_rdf/server/` (`index.ts`, `rdf_import_run.ts`, `rdf_import_plan.ts`, `rdf_import_prune.ts`, `rdf_import_execute.ts`); RDF graph reader: `src/core/tools/rdf_graph.ts` (from-scratch, no 3rd-party library).
