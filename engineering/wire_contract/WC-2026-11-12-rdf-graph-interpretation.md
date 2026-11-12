# WC-2026-11-12-rdf-graph-interpretation — an rdf element publishes the record's RDF graph

- **Date:** 2026-11-12.
- **Decision:** RC-closure T1-4 / audit O09 (owner authorised Tier 1
  implementation 2026-11-12). DEC-12 gates:
  `test/unit/diffusion_rdf_graph_native.test.ts` (compile + resolve + writer +
  `runJob`, on a built `zzdif` situation and a swept dd1010 record) and
  `test/unit/rdf_xml_serialiser.test.ts` (hermetic: EasyRdf 1.19 byte pins).
- Code: `src/diffusion/plan/rdf_compile.ts` (compile half),
  `src/diffusion/resolve/rdf_graph.ts` (graph builder),
  `src/diffusion/resolve/rdf_graph_ir.ts` (graph IR, EasyRdf namespace table,
  typed literals), `src/diffusion/writers/rdf_xml_serialiser.ts` (EasyRdf
  RdfXml serialiser port), `src/diffusion/writers/rdf.ts` (writer:
  `writeGraphs`; `writeRows` refuses).

## Shape before (TS)

The rdf element compiled like a column format: one plain literal per plan
column, subject `urn:dedalo:record:<section_tipo>:<section_id>` (or a column
literally named `rdf:about`), namespaces guessed from a built-in prefix table
with a `urn:dedalo:xmlns:<prefix>#` fallback, xml:lang from a writer-local
alpha2 map. No base IRI, no resource object, no datatype, no nested node, no
linked record — not Linked Data. The merged document took the first part's
namespace declarations only.

## Shape after (TS) = PHP class.diffusion_rdf build_rdf_node

Each owl:Class publishes one graph per record, rule for rule (frozen v7
`class.diffusion_rdf.php` :537-995; v6 where frozen v7 lost behaviour):

- subject = dd1010 publication-services base IRI (record of
  (DEDALO_ENTITY_ID, element `service_type`), dd1014 item titled
  `base_uri_entity.title`, `self` = the class name) + `var_uri` component value
  (or the section_id) + `#fragment`; typed with the class IRI;
- properties by `process.type`: default literal, `get_data_uri`,
  `get_data_date`, `get_data_number`, `get_section_id`, `get_resource_link`,
  `get_portal` (nested resource), `entity_publication_uri` (standalone typed
  resource), model `rdf` (linked records' class subjects, same document);
- serialisation byte-equal to EasyRdf 1.19 RdfXml (declaration with a space
  before `?>`, only used prefixes declared, a node referenced once nests as
  `rdf:Description`, initial namespace table order — `dcterms` IRIs publish as
  `dc:`).

## Divergences from PHP, stated (each loud, never a guessed document)

1. **Namespaces from `properties.diffusion.xmlns`.** The v6→v7 migration moved
   `xmlns` under `diffusion`; frozen PHP still read the top level (never saw
   them). A top-level `xmlns` is a compile error. The table is per plan (PHP's
   static `RdfNamespace::set` leaked across elements).
2. **`process.var_uri` for classes** (frozen PHP read a top-level `var_uri`, a
   spelling no ontology carries; top-level is a compile error). `#` fragment
   appended LAST and at most ONE component: jsonb keeps no key order, so a
   multi-component concatenation order is unrecoverable (refused).
3. **Literals per published lang** (v6 `get_dato_full` shape, ~10 xml:lang
   literals per predicate in real v5/v6 files; frozen v7 published
   DEDALO_DATA_LANG only). Langs = plan main lang + every other plan lang the
   values carry, in plan order; a lang outside the plan is dropped; alpha2 from
   the core lang map (a plan lang without one is an error). A missing end-ddo
   slot takes the main-lang value of the same tipo AND id (PHP matched id only),
   else `''`.
4. **php_formula `{type:'empty', sentence}`** split on the template before
   substitution (no eval); the v6 bare-string spelling is refused.
5. **Base IRI title** = the dd1014 item's label frame (v7 iri contract) else its
   legacy inline `title`. A base that does not resolve REFUSES the subject: the
   record is not written and the run report names element, class, title (PHP
   built the relative IRI `'' . id`). Only dd1010 bases (PHP's non-dd1010
   branch is dead — called without the section_id it needs).
6. **`get_portal` returns linked** when a child produced a triple (PHP returned
   false); an empty portal publishes nothing.
7. **`rdf` links** skip non-locators, other sections, missing and
   unpublishable records (each extends the cap — PHP :612-650); the cap is
   DEDALO_DIFFUSION_RESOLVE_LEVELS (ported; see open decision below); a
   class|record already built is not rebuilt (cycle guard). Values come from the
   resolver's ONE walker (spec §6), so its publishability semantics apply
   (stricter than PHP `get_ddo_value`). An rdf run queues no frontier: linked
   records are inlined, never published as their own files.
8. **`value_fn` on an rdf ddo** is subsumed by the walker (warning
   `rdf-value-fn:<fn>@<tipo>`); a relation_list `config` ddo
   (`resolve_configuration` → `filter_locators`) is NOT PORTED — compile error.
9. **Compile refusals** (PlanCompileError, all at once): unknown process type,
   QName prefix in neither table, class without `entity_publication_uri`,
   missing `service_type`, malformed `format` / `get_date`, `rdf` link without
   component or class, link to a class the element does not publish.
10. **No wall-clock names**: `diffusion_rdf_merged.rdf` / `diffusion_rdf.zip`
    (old engine `_<date>` tags dropped; who/when live in dd1758).
11. **Merged document declares the UNION** of the parts' xmlns (EasyRdf
    declares only used prefixes, so the first envelope alone left later
    prefixes undeclared); a prefix bound to two URIs in one run is refused. Equal
    to the frozen merge oracle whenever no later part adds a prefix.
12. **XSD lexical forms kept PHP's**: gYear `-25` (not canonical `-0025`),
    decimal `1.0` canonical, double `sprintf('%F')` trimmed. Owner decision
    open (canonical forms).

## Reason

The consumers of an rdf element are Linked-Data aggregators (Nomisma and the
like): they read subjects, typed resources and links, never a flat column
document. The urn shape was not a divergence a consumer could adapt to — it was
the absence of the format.

## Gate reconciliation

- Frozen store: no fixture edited (no rdf interaction was harvested).
- `diffusion_rdfxml_writers`: the urn-subject, `rdf:about`-column,
  unknown-prefix-fallback and writer-lang-map cases are REPLACED by graph cases
  + `writeRows` refusal + the union merge (streamed merge == oracle kept for
  same-prefix parts). `diffusion_file_writers`, `diffusion_consolidated_withdrawn_native`,
  `diffusion_artifact_rss_native`, `diffusion_scope_tripwire` write graphs.
  `diffusion_plan_uninstalled_tld` / `diffusion_global_table_native` (non-sql
  hermetic legs) use `xml`, the remaining column file format;
  `machine_name_outcome_native`'s rdf element is a compilable one.
- Data already written wrongly: TS-era rdf files exist only on beta installs;
  deterministic names mean the next publish overwrites them. No repair step.
