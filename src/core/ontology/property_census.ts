/**
 * ONTOLOGY PROPERTY CENSUS — the ONE home for "which `properties` keys does
 * this engine actually read?" (audit 2026-08-26, DEAD-08 / P2-27).
 *
 * THE DEFECT. `properties` is a free-form JSONB bag an ontology author edits by
 * hand. A key the engine no longer reads looks exactly like one it honours: the
 * node saves, the form renders, nothing complains. Measured over the two
 * artefacts every install ships (`install/db/dedalo_install.pgsql.gz` +
 * `src/core/test_data/test_tld_ontology.json`): 404 distinct top-level keys, of
 * which 35 are read by NOTHING in `src/`, `tools/`, `scripts/` or the browser
 * trees — on ~250 nodes. `portal_link_open` sits on 90 nodes, `hard_delete` on
 * 58, `multi_value` on 48. A cataloguer set them and got silence.
 *
 * THE ANSWER, in three parts:
 *   1. {@link RETIRED_PROPERTY_KEYS} — the ENUMERATED, shrink-only registry:
 *      every unread key with WHY it is inert and, where one exists, the exact
 *      v7 replacement. `test/unit/ontology_property_census_tripwire.test.ts`
 *      holds it EQUAL to the derived census, so a newly-dead key is RED and a
 *      key that becomes read again must leave the list.
 *   2. A loud runtime tripline at the one chokepoint every node passes —
 *      `getNode`'s cache miss (`resolver.ts`) — naming node, key and
 *      replacement, once per node per process (the node cache is the dedupe).
 *   3. `scripts/ontology_property_report.ts` — an install reads its OWN
 *      dd_ontology and gets node+key+replacement for every inert key, plus the
 *      keys this repo has never heard of.
 *
 * `reportedAtUse` marks the two keys whose CONSUMER already reports them with
 * context the chokepoint cannot have (the concrete replacement sqo in
 * `relations/request_config/build.ts`, the named v6 fn in
 * `diffusion/plan/compile.ts`). Those sites read the key, so the code scan sees
 * it and it is NOT part of the unread census — but an install must still be
 * told, so the report path covers it and the tripline stays quiet.
 *
 * NOT WIRED ON PURPOSE — `multi_value`. It looks like a value law, and it is
 * not this engine's: "may this component hold more than one value?" already has
 * ONE home (the `monovalue` descriptor facet + `show_interface.button_add`,
 * DATA-14, `test/unit/value_law_agreement_tripwire.test.ts`). Wiring
 * `multi_value` would create the second answer that gate exists to refuse — and
 * the key was already inert in the PHP oracle (no reader in the v6 tree either),
 * so there is no behaviour to restore. It is recorded here with its pointer.
 *
 * PURE: no imports, no I/O, no DB. The DB scan lives in `resolver.ts`
 * (`listNodesWithProperties`, the exempt canonical home for direct
 * dd_ontology queries); this module only classifies and formats.
 */

/** One retired key: why it is inert, and what says the same thing today. */
export interface RetiredPropertyKey {
	/** Why the key does nothing — v6 grammar, superseded spelling, dead marker. */
	readonly reason: string;
	/** The v7 spelling that carries the intent, or null when nothing replaces it. */
	readonly replacement: string | null;
	/**
	 * The engine NAMES this key only to report it at its own consumer, with
	 * context the generic tripline cannot have. Excluded from the unread census
	 * (the code scan sees the name) and skipped by the resolver tripline (its
	 * site reports better), but still reported to an install.
	 */
	readonly reportedAtUse?: true;
}

/**
 * THE RETIRED REGISTRY — shrink-only. An entry leaves when the key is wired or
 * swept from the shipped ontology; nothing is ever added to launder a new dead
 * key past the census gate (adding one that IS read fails the gate too).
 *
 * Node counts are the shipped-corpus measurement at the time each entry was
 * written; the gate re-derives membership on every run, never the counts.
 */
export const RETIRED_PROPERTY_KEYS: Readonly<Record<string, RetiredPropertyKey>> = {
	portal_link_open: {
		reason:
			"v6 portal link-target hint (90 nodes). No reader in this engine and none in the PHP oracle either — how a portal opens a linked record is the client renderer's decision.",
		replacement: null,
	},
	image_tag: {
		reason:
			'v6 rich-text image-tag hint (48 nodes). The image-tag plugin ships inside the vendored CKEditor build and takes no ontology configuration.',
		replacement: null,
	},
	multi_value: {
		reason:
			'v6 "this component may hold several records" flag (48 nodes), already inert in the PHP oracle. Deliberately NOT wired: single-vs-multi value has ONE home (DATA-14) and a second one is what value_law_agreement_tripwire refuses.',
		replacement:
			"the component model's single-value facet in its descriptor (components/registry.ts) + properties.show_interface.button_add",
	},
	hard_delete: {
		reason:
			'v6 dataframe-slot "delete the frame target record" opt-in (~58 nodes), DELIBERATELY retired in v6 — "REMOVED because time machine needs to show the previous state, so, never deletes it". The slot unlinks and the target survives (WC-2026-09-29-dataframe-hard-delete-retired). (`dataframe.delete_policy: "delete_target"` is a different opt-in, for frame-PRIVATE targets only: it empties the target, and past states then render it empty.)',
		replacement: null,
	},
	data_to_be_used: {
		reason:
			'v6 component_portal/autocomplete value selector ("dato" vs "valor", 15 nodes). The v7 read path resolves the published value from the component descriptor, not from a per-node switch.',
		replacement: null,
	},
	process_dato_arguments: {
		reason:
			'Arguments of the retired v6 `process_dato` diffusion directive (14 nodes). Its owner is reported at use in diffusion/plan/compile.ts; the arguments travel inside the new directive.',
		replacement: 'the entries of properties.process.parser',
	},
	edit_view_options: {
		reason:
			"v6 per-view option bag (13 nodes), read by nothing in either engine. View options are the descriptor's and the `view` key's business.",
		replacement: null,
	},
	v6_update_dataframe: {
		reason:
			'One-off v6→v7 portal dataframe migration marker (13 nodes). The migration it drove is done; the key is data residue.',
		replacement: null,
	},
	filtered_by: {
		reason:
			'v6 datalist narrowing (11 nodes), sibling of the unported filtered_by_search branch ledgered in relations/datalist.ts.',
		replacement: null,
	},
	show_in_modes: {
		reason:
			'v6 per-mode visibility list (9 nodes) — taught by shipped authoring samples and read by nothing in either engine.',
		replacement: null,
	},
	portal_list: {
		reason: 'v6 common-layer portal list hint (8 nodes); no v7 reader.',
		replacement: null,
	},
	section_config: {
		reason:
			'v6 section configuration bag (5 nodes). Section behaviour is read from named keys (section_map, tool_config, widgets), never from this envelope.',
		replacement: null,
	},
	stats_look_at: {
		reason:
			'v6 component_relation_common statistics target (5 nodes). No statistics path in this engine reads it.',
		replacement: null,
	},
	is_publicable: {
		reason:
			'v6 portal/diffusion publish flag (4 nodes). Publication is decided by the diffusion plan and the media publication markers.',
		replacement: null,
	},
	elements_list_mode: {
		reason: 'v6 elements list-mode hint (4 nodes); no reader in either engine.',
		replacement: null,
	},
	show_parent_name: {
		reason: 'v6 label composition hint (3 nodes); no reader in either engine.',
		replacement: null,
	},
	filtered_by_search: {
		reason:
			'The unported PHP datalist narrowing branch (3 nodes) — ledgered where the port stops, src/core/relations/datalist.ts.',
		replacement: null,
	},
	valor_arguments: {
		reason:
			'v6 component_relation_common value-formatting arguments (2 nodes), paired with stats_look_at; no v7 reader.',
		replacement: null,
	},
	inverse_show: {
		reason:
			'v6 component_inverse display switch (2 nodes). The v7 inverse resolver emits one shape.',
		replacement: null,
	},
	dragable_connectWith: {
		reason:
			'v6 jQuery-UI drag-and-drop pairing (2 nodes, misspelled in the ontology). The v7 client states drag targets in properties.draggable_to.',
		replacement: 'properties.draggable_to',
	},
	SQL_logical_operators: {
		reason: 'v6 hand-written SQL fragment grammar (2 nodes). No v7 answer: search is SQO-driven.',
		replacement: null,
	},
	SQL_comparison_operators: {
		reason: 'v6 hand-written SQL fragment grammar (2 nodes). No v7 answer: search is SQO-driven.',
		replacement: null,
	},
	delete_action_pre: {
		reason: 'v6 pre-delete hook name; no hook registry in this engine reads it.',
		replacement: null,
	},
	copy_value: {
		reason: 'An install-specific v6 tool flag (tool_numisdata_order_coins); no engine reader.',
		replacement: null,
	},
	multiple_value: {
		reason: 'A one-node misspelling of the retired multi_value flag; inert twice over.',
		replacement:
			"the component model's single-value facet in its descriptor (components/registry.ts) + properties.show_interface.button_add",
	},
	source_for_component: {
		reason: 'v6 dataframe source hint on one node; no reader in either engine.',
		replacement: null,
	},
	check_publication_value: {
		reason:
			'v6 diffusion_sql per-table publication check. The v7 diffusion plan decides publication per element.',
		replacement: null,
	},
	text_editor_options: {
		reason:
			'v6 rich-text editor option bag on one node; the vendored editor build owns its configuration.',
		replacement: null,
	},
	formula: {
		reason: 'v6 calculation formula on one node; the calculation widget reads its own descriptor.',
		replacement: null,
	},
	statusbar: {
		reason: 'v6 editor status-bar switch on one node; no reader in either engine.',
		replacement: null,
	},
	search_list_add: {
		reason: 'v6 autocomplete "add from search" switch on one node; no v7 reader.',
		replacement: null,
	},
	context_name: {
		reason: 'v6 tool context label on one node; tool context is named by the tool register.',
		replacement: null,
	},
	tool_import_kml: {
		reason: 'v5→v6 security upgrade residue on one node; no tool of that name exists.',
		replacement: null,
	},
	target_mode: {
		reason:
			'v6 component_relation_model "free" mode — a second grammar for what the sqo already states.',
		replacement: 'an explicit sqo section_tipo entry {"source":"section","value":[…]}',
		reportedAtUse: true,
	},
	target_values: {
		reason: 'The value list of the retired target_mode grammar.',
		replacement: 'an explicit sqo section_tipo entry {"source":"section","value":[…]}',
		reportedAtUse: true,
	},
	process_dato: {
		reason:
			'The v6 spelling of the diffusion parser directive (18 nodes). Reported at use, with the named v6 fn, by diffusion/plan/compile.ts.',
		replacement: 'properties.process.parser',
		reportedAtUse: true,
	},
};

/**
 * THE HONOURED SET — every key the shipped ontology carries that first-party
 * code also names. Held EQUAL to the derived census by the tripwire, so it is a
 * measurement, not a wish list.
 *
 * HONEST LIMIT: "named in code" is a word scan over comment-stripped sources.
 * It OVER-approximates readership — a key spelled like an ordinary identifier
 * (`name`, `type`, `row`, `key`, `date`) counts as read wherever that word
 * occurs. So the unread census is a LOWER bound: everything it names is truly
 * dead, and a few honoured entries may be dead too.
 */
export const HONOURED_PROPERTY_KEYS: readonly string[] = [
	'a',
	'active_ontologies',
	'additional_path',
	'alias_of',
	'api_config',
	'ar_tools_name',
	'auto_init_editor',
	'children_view',
	'class_list',
	'color',
	'config',
	'config_relation',
	'context',
	'css',
	'data_limit',
	'dataframe',
	'date',
	'date_mode',
	'dato_default',
	'ddo_map',
	'default',
	'diffusion',
	'disable',
	'draggable_to',
	'edit_view',
	'entity',
	'entity_id',
	'entity_label',
	'enum',
	'exclude_column',
	'export',
	'external_source',
	'fields_map',
	'fields_separator',
	'global_table_maps',
	'head',
	'host',
	'identifying_image',
	'image_id',
	'info',
	'into',
	'inverse_relations',
	'is_publishable',
	'js',
	'key',
	'label',
	'layout',
	'length',
	'limit',
	'list_show_key',
	'main_tld',
	'mandatory',
	'match',
	'max_items_folder',
	'max_records',
	'mode',
	'name',
	'observe',
	'observers',
	'precision',
	'process',
	'read_only',
	'row',
	'sample_data',
	'search_engine',
	'section_tipo',
	'service_autocomplete',
	'show',
	'show_interface',
	'sort',
	'sort_by',
	'source',
	'state',
	'state_of_component',
	'tags_draw',
	'tags_index',
	'tags_notes',
	'tags_persons',
	'tags_reference',
	'target_duration',
	'target_filename',
	'target_geolocation_tipo',
	'test',
	'thesaurus',
	'tm',
	'tool_config',
	'tool_name',
	'type',
	'unique',
	'use_active_check',
	'use_title',
	'validation',
	'value_with_parents',
	'varchar',
	'version',
	'view',
	'widgets',
	'with_lang_versions',
	'x',
	'xmlns',
	'y',
];

/**
 * THE AUTHOR DEACTIVATION CONVENTIONS. Cataloguers park a key instead of
 * deleting it: `DES_`/`_DES` (desactivado), `DESACTIVO`/`DESACTIVE`, a `99`…
 * numeric suffix, the `______TEST_` prefix, and `_info` for a free note. Such a
 * key is INTENDED to be inert — it is not a defect and never a census offender.
 */
const DEACTIVATED_KEY_PATTERN = /(^|_|\s)DES(_|\s|$)|_DES$|^DES_|DESACTIV|^______TEST_|9{2,}$/;

/** `_info` — the author's own annotation slot, inert by design. */
const ANNOTATION_KEYS: ReadonlySet<string> = new Set(['_info']);

/**
 * A KEYED MAP, not a property name: `properties` sometimes IS a map keyed by
 * tipo (`hierarchy46`, `testterr1024` — one entry per child) or by index
 * (`lg9`'s language order). Every shape-matching key in the shipped corpus was
 * verified to be a real node tipo. LIMIT: an invented key that happens to read
 * `word + digits` classifies here too.
 */
const KEYED_MAP_PATTERN = /^(?:[a-z]+[0-9]+|[0-9]+)$/;

/** What the census says about one key. */
export type PropertyKeyVerdict = 'honoured' | 'retired' | 'deactivated' | 'keyed_map' | 'unknown';

const HONOURED_SET: ReadonlySet<string> = new Set(HONOURED_PROPERTY_KEYS);

/**
 * Classify one top-level `properties` key. Order matters: an author's parked
 * spelling of a live key (`view_DES`) is deactivated, not unknown.
 */
export function classifyPropertyKey(key: string): PropertyKeyVerdict {
	if (ANNOTATION_KEYS.has(key) || DEACTIVATED_KEY_PATTERN.test(key)) return 'deactivated';
	if (KEYED_MAP_PATTERN.test(key)) return 'keyed_map';
	if (RETIRED_PROPERTY_KEYS[key] !== undefined) return 'retired';
	if (HONOURED_SET.has(key)) return 'honoured';
	return 'unknown';
}

/**
 * The retired keys carried by one node's properties, in registry order.
 * `skipReportedAtUse` drops the keys whose own consumer reports them, so the
 * generic tripline never doubles a better-informed line.
 */
export function retiredKeysOf(
	properties: unknown,
	options: { skipReportedAtUse?: boolean } = {},
): string[] {
	if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) return [];
	const present = new Set(Object.keys(properties as Record<string, unknown>));
	return Object.keys(RETIRED_PROPERTY_KEYS).filter(
		(key) =>
			present.has(key) &&
			!(options.skipReportedAtUse === true && RETIRED_PROPERTY_KEYS[key]?.reportedAtUse === true),
	);
}

/** The ONE wording of the retired-property line (tripline and report share it). */
export function formatRetiredPropertyLine(tipo: string, key: string): string {
	const entry = RETIRED_PROPERTY_KEYS[key];
	if (entry === undefined) return `node '${tipo}' carries property '${key}'`;
	const replacement =
		entry.replacement === null
			? 'There is no v7 replacement: remove it.'
			: `Replace it with ${entry.replacement}.`;
	return `node '${tipo}' carries RETIRED properties.${key} — read by nothing. ${entry.reason} ${replacement}`;
}

/** One line of the install report. */
export interface PropertyCensusEntry {
	readonly tipo: string;
	readonly key: string;
	readonly verdict: PropertyKeyVerdict;
	/** Registry reason for a retired key; '' otherwise. */
	readonly reason: string;
	/** Registry replacement for a retired key; null otherwise. */
	readonly replacement: string | null;
}

/**
 * The property bag of a node, or null when the node carries none. A `properties`
 * value that is not a plain object (null, a scalar, an array) is not a bag: an
 * install may hold any of the three and none of them names property keys.
 */
function propertyBagOf(properties: unknown): Record<string, unknown> | null {
	if (properties === null || typeof properties !== 'object' || Array.isArray(properties))
		return null;
	return properties as Record<string, unknown>;
}

/**
 * One report line for one (node, key), or null when the key is working
 * configuration, a deliberate park, or not a property name at all.
 */
function censusEntryFor(tipo: string, key: string): PropertyCensusEntry | null {
	const verdict = classifyPropertyKey(key);
	if (verdict !== 'retired' && verdict !== 'unknown') return null;
	const entry = RETIRED_PROPERTY_KEYS[key];
	return {
		tipo,
		key,
		verdict,
		reason: entry?.reason ?? '',
		replacement: entry?.replacement ?? null,
	};
}

/** Report order: verdict, then node tipo, then key. */
function comparePropertyCensusEntries(a: PropertyCensusEntry, b: PropertyCensusEntry): number {
	return (
		a.verdict.localeCompare(b.verdict) || a.tipo.localeCompare(b.tipo) || a.key.localeCompare(b.key)
	);
}

/**
 * Build the install report: every RETIRED or UNKNOWN key an install's nodes
 * carry, one line per (node, key), sorted by verdict then tipo then key.
 * Honoured, deactivated and keyed-map entries are not reported — they are
 * working configuration, a deliberate park, or not property names at all.
 */
export function buildPropertyCensusReport(
	nodes: Iterable<{ tipo: string; properties: unknown }>,
): PropertyCensusEntry[] {
	const out: PropertyCensusEntry[] = [];
	for (const node of nodes) {
		const bag = propertyBagOf(node.properties);
		if (bag === null) continue;
		for (const key of Object.keys(bag)) {
			const entry = censusEntryFor(node.tipo, key);
			if (entry !== null) out.push(entry);
		}
	}
	return out.sort(comparePropertyCensusEntries);
}
