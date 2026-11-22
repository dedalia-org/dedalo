/**
 * PublicationPlan compiler (DIFFUSION_SPEC §4.1 stage B, DIFFUSION_PLAN D3-P1).
 *
 * Turns one dd1190 diffusion element into an immutable, JSON-serializable
 * PublicationPlan: ALL ontology interpretation happens here, once per
 * (element, ontology revision) — the resolver and writers never touch
 * dd_ontology again. Oracle anchors:
 *
 * - element format/serviceName: properties->diffusion->{type, service_name}
 *   (dd_diffusion_api::diffuse :233-246, ::validate :482-510);
 * - target database: diffusion_utils::get_database_name_for_element (:1205);
 * - per-section table node: get_section_node_for_element (:1163) — real
 *   'table' preferred over 'table_alias';
 * - field chains: diffusion_utils::get_ddo_map (:1252) — explicit
 *   properties->process->ddo_map (with 'self' resolution) or auto-generated
 *   from the field node's relations, optional properties->process->fn;
 * - field context: dd_diffusion_api::build_datum_context (:1263) — term →
 *   column name, parser split, exclude_column, output_format (two-stage:
 *   explicit process value, else the component-class $diffusion_output_format
 *   fallback — 'json' for the relation family, see compileFieldPlan),
 *   varchar/length/index, empty_to_string, default_value;
 * - v6 side-channels promoted to plan concepts (spec §5): preserve_order
 *   (process_datum :1170-1182) → FieldPolicy; add_parents (chain_processor
 *   :305) → relation-hop flag; global_table_maps (v6 diffusion_sql::
 *   save_global_table_data :2477) → SectionPlan.globalTables (global_tables.ts).
 *
 * SECURITY: every database/table/column name that will reach a SQL target
 * goes through requireSqlIdentifier (spec §8.3) AT COMPILE TIME — a violation
 * is a loud PlanCompileError surfaced by `validate`, never a runtime
 * surprise. File-format (rdf/xml/markdown) labels are kept VERBATIM: names
 * like 'nmo:TypeSeriesItem' or 'skos:prefLabel' are XML/RDF identities, not
 * SQL identifiers, and never reach a SQL string.
 *
 * UNINSTALLED ONTOLOGY PACKAGES (spec §4.1): a ddo (or field) tipo whose TLD has
 * NO dd_ontology rows is skipped with a 'uninstalled-tld:<tld>@<field>' warning
 * — an optional package absent from THIS deployment must never fail a shared
 * element's compile. A tipo whose TLD IS installed but whose node is missing
 * stays a hard error: that is an authoring defect. See uninstalledTldOf.
 *
 * Parser split (spec §5): each properties->process->parser step is classified
 * via the parser registry — 'runtime' steps survive IN ORDER as
 * ParserStepConfig, 'rewriter' steps are ABSORBED (recorded as
 * 'rewriter:<fn>@<field>' warnings until the resolver phase lands their plan
 * rewrites), 'unknown' fns THROW naming the field (never a silent skip).
 *
 * FAILURE POLICY — what is fatal and what is skipped:
 * STRUCTURAL violations refuse the whole element, because publishing under a
 * wrong name or an unknown format is worse than not publishing: the format,
 * the target database/service_name, the section/table resolution, the SQL
 * identifier chokepoint and an unknown parser fn. A missing ontology node is
 * split by the rule above — absent PACKAGE (deployment fact) is skipped with a
 * warning, missing node in an INSTALLED package is an authoring defect and
 * stays fatal.
 *
 * SUPERSEDES the 2026-08-09 B3 "degrade in place" policy (a dangling ddo kept
 * its slot in the chain as a `degraded` step so the field's column topology
 * could not shift). That was reversed on 2026-08-11 in favour of the TLD split
 * above: a skipped ddo now leaves the chain entirely. The consequence is
 * deliberate and stated — on an install missing an optional package a
 * multi-ddo field publishes one FEWER joined slot than the PHP oracle, whose
 * `columns` come from the FULL ddo_map (build_datum_context :1288-1308):
 * 'Historia' where the oracle emits 'Historia, '.
 * Ledger: engineering/wire_contract/WC-2026-08-09-diffusion-degradation-and-loud-ddo-fns.md
 * Gate: test/unit/diffusion_plan_uninstalled_tld.test.ts
 *
 * The one thing that did NOT follow the reversal is the output_format
 * fallback: it reads ddo_map[0] directly, never sourceChain[0], so a skipped
 * FIRST ddo cannot promote the second one and invent a format. See its site.
 */

import { config } from '../../config/config.ts';
import { readEnv } from '../../config/env.ts';
import { getFlatValueFamily, storesRelationLocators } from '../../core/components/registry.ts';
import { getPopulatedTlds } from '../../core/db/dd_ontology.ts';
import { DedaloError } from '../../core/errors/dedalo_error.ts';
import { nameOrLabelOf } from '../../core/ontology/labels.ts';
import { getModelByTipo } from '../../core/ontology/resolver.ts';
import { getTldFromTipo } from '../../core/ontology/tld.ts';
import { RdfNamespaceTable } from '../resolve/rdf_graph_ir.ts';
import { tableRowSizeViolation } from '../targets/mariadb/sql_generator.ts';
import { currentOntologyRevision } from './cache.ts';
import { KNOWN_FORMATS, TABLE_FORMATS } from './formats.ts';
import {
	compileGlobalTables,
	type GlobalTableCarrier,
	globalTableElementErrors,
} from './global_tables.ts';
import { requireSqlIdentifier } from './identifier.ts';
import {
	compileRdfElement,
	compileRdfSection,
	type RdfCompileContext,
	rdfLinkErrors,
} from './rdf_compile.ts';
import type {
	ColumnDef,
	FieldPlan,
	FieldPolicy,
	ParserStepConfig,
	PlanDegradation,
	PublicationPlan,
	ResolveStep,
	SectionPlan,
	TargetAddress,
} from './types.ts';
import type { VirtualDiffusionTree, VirtualTreeNode } from './virtual_tree.ts';
import {
	buildVirtualDiffusionTree,
	getDatabaseNameForElement,
	getSectionNodeForElement,
	getSectionsForElement,
	getTargetSectionTableNames,
} from './virtual_tree.ts';

/**
 * The breadth-first recursion budget (DEDALO_DIFFUSION_RESOLVE_LEVELS, PHP
 * diffusion_utils::get_resolve_levels default 2). Exported so the enqueue path
 * can CLAMP a client-supplied `levels` to this server ceiling (DIFF-B) — a
 * caller must not be able to expand a one-record run into a transitive-closure
 * publication.
 */
export function diffusionResolveLevels(): number {
	const raw = readEnv('DEDALO_DIFFUSION_RESOLVE_LEVELS');
	return raw !== undefined && raw !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : 2;
}

// KNOWN_FORMATS / TABLE_FORMATS moved to ./formats.ts (2026-07-29, WC-065):
// api/info.ts needs the SAME MariaDB-target answer for connection_status, and
// one list is the whole point.

/** How a parser fn participates in the new engine (parsers/registry.ts). */
export type ParserClassifier = (fn: string) => 'runtime' | 'rewriter' | 'unknown';

/** Ontology model lookup (injected so the compiler can be exercised hermetically). */
export type ModelResolver = (tipo: string) => Promise<string | null>;

/**
 * Compile failed — carries EVERY violation found (not just the first), each
 * naming its element/section/field, plus the warnings AND the field-local
 * degradations gathered before the failure, so `validate` reports all three.
 */
export class PlanCompileError extends DedaloError {
	readonly elementTipo: string;
	readonly compileErrors: string[];
	readonly compileWarnings: string[];
	readonly compileDegradations: PlanDegradation[];

	constructor(
		elementTipo: string,
		errors: string[],
		warnings: string[],
		degradations: PlanDegradation[] = [],
	) {
		// `diffusion.plan_compile_failed` is PUBLIC: the operator authored the
		// config, and the per-cause list (the `\n- ` grammar tool_diffusion's
		// report model splits on) IS the fix — it is the wire message.
		const message = `diffusion plan compile failed for element '${elementTipo}':\n- ${errors.join('\n- ')}`;
		super('diffusion.plan_compile_failed', {
			message,
			publicMessage: message,
			coordinates: { element: elementTipo },
		});
		this.name = 'PlanCompileError';
		this.elementTipo = elementTipo;
		this.compileErrors = errors;
		this.compileWarnings = warnings;
		this.compileDegradations = degradations;
	}
}

export interface CompileOptions {
	/**
	 * Parser fn classifier. Defaults to the parser registry's classifyParserFn
	 * (lazy import so this module never hard-fails while the registry module
	 * is being built/tested independently); tests inject their own.
	 */
	classifyParserFn?: ParserClassifier;
	/** Reuse an already-built virtual tree (validate-all, test suites). */
	tree?: VirtualDiffusionTree;
	/**
	 * Ontology model lookup for ddo tipos. Defaults to the cached
	 * `getModelByTipo`; injected by the degradation gate so the compiler's
	 * field-local failure policy can be pinned without a database.
	 */
	resolveModelByTipo?: ModelResolver;
}

/** Operator-facing lines for a plan's field-local degradations (run report). */
export function planDegradationReportLines(plan: PublicationPlan): string[] {
	return (plan.degradations ?? []).map((entry) => `plan degradation: ${entry.message}`);
}

/** Lazy default classifier — resolved once, then cached. */
let registryClassifier: ParserClassifier | null = null;
async function defaultClassifier(): Promise<ParserClassifier> {
	if (registryClassifier === null) {
		const registry = await import('../parsers/registry.ts');
		registryClassifier = registry.classifyParserFn;
	}
	return registryClassifier;
}

/** One raw ddo_map entry as stored in v7 properties (post 'self' resolution). */
interface DdoEntry {
	tipo: string;
	/** Undefined = DYNAMIC: the hop target section is only known at runtime. */
	sectionTipo: string | undefined;
	/** Chain parent: the SECTION tipo for root entries, else a ddo tipo. */
	parent: string;
	/** Leaf handle referenced by parser patterns (e.g. text_format '${a}'). */
	id?: string;
	/** Custom fn (ddo.fn or the node-level properties->process->fn). */
	fn?: string;
	/** ddo lang pin (component_common::get_diffusion_data $pin_lang). */
	lang?: string;
	/** relation_list section_filter (linked-section whitelist). */
	sectionFilter?: string[];
	/** relation_list component_filter (relation-origin whitelist). */
	componentFilter?: string[];
	/** ddo data_slice — array_slice(offset, length) over the hop's locators. */
	dataSlice?: { offset: number; length?: number };
	/** relation_list 'dato_full': publish each referencing section once. */
	dedupeSections?: boolean;
	/** ddo declared a `label` — its children are a LABEL expansion, not direct reads. */
	labelExpansion?: boolean;
	/** Verbatim ddo `options` bag (PHP $ddo->options — media quality/extension). */
	options?: Record<string, unknown>;
	/**
	 * Verbatim ddo `config` bag — a relation_list ddo's filters in the shape
	 * numisdata's rdf properties carry them (owner C14 2026-11-13,
	 * WC-2026-11-13-rdf-relation-list-config): `section_filter` /
	 * `component_filter`, judged in compileSourceChain once the model is known.
	 */
	config?: Record<string, unknown>;
}

/**
 * A ddo `data_slice` as {offset, length}. PHP array_slice semantics: a missing or
 * null length means "to the end". Anything unusable is ignored, never guessed.
 */
/** null → NaN so an explicit `"length": null` means 'to the end' (PHP array_slice), not 'take zero'. */
function nullToNaN(value: unknown): number {
	return value === null ? Number.NaN : Number(value);
}

function dataSliceOf(raw: unknown): { offset: number; length?: number } | undefined {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
	const source = raw as { offset?: unknown; length?: unknown };
	const offset = Number(source.offset);
	if (!Number.isInteger(offset)) return undefined;
	const length = nullToNaN(source.length);
	return Number.isInteger(length) ? { offset, length } : { offset };
}

/** Normalize an ontology string-array property ('a' | ['a','b'] | junk). */
function stringArrayOf(raw: unknown): string[] | undefined {
	const list = Array.isArray(raw) ? raw : typeof raw === 'string' && raw !== '' ? [raw] : [];
	const strings = list.filter(
		(entry): entry is string => typeof entry === 'string' && entry !== '',
	);
	return strings.length > 0 ? strings : undefined;
}

/**
 * PHP diffusion_utils::get_ddo_map (:1252): the flat resolution chain of one
 * diffusion field node. Explicit properties->process->ddo_map wins ('self'
 * section_tipo/parent resolved to the section); otherwise auto-generated from
 * the field node's related components (ALL relation tipos —
 * ontology_node::get_relation_nodes simple mode), carrying the optional
 * node-level process->fn.
 */
function buildDdoMap(
	fieldProperties: Record<string, unknown> | null,
	relationTipos: string[],
	sectionTipo: string,
): DdoEntry[] {
	const process = fieldProperties?.process as Record<string, unknown> | undefined;
	const explicitMap = process?.ddo_map;

	if (Array.isArray(explicitMap)) {
		const entries: DdoEntry[] = [];
		for (const raw of explicitMap) {
			const ddo = raw as Record<string, unknown>;
			const tipo = typeof ddo.tipo === 'string' ? ddo.tipo : '';
			const declaredSection = typeof ddo.section_tipo === 'string' ? ddo.section_tipo : undefined;
			const declaredParent = typeof ddo.parent === 'string' ? ddo.parent : '';
			const rawOptions = ddo.options;
			const rawConfig = ddo.config;
			entries.push({
				tipo,
				sectionTipo: declaredSection === 'self' ? sectionTipo : declaredSection,
				parent: declaredParent === '' || declaredParent === 'self' ? sectionTipo : declaredParent,
				id: typeof ddo.id === 'string' ? ddo.id : undefined,
				fn: typeof ddo.fn === 'string' ? ddo.fn : undefined,
				lang: typeof ddo.lang === 'string' && ddo.lang !== '' ? ddo.lang : undefined,
				sectionFilter: stringArrayOf(ddo.section_filter),
				componentFilter: stringArrayOf(ddo.component_filter),
				dataSlice: dataSliceOf(ddo.data_slice),
				dedupeSections: ddo.dedupe_sections === true ? true : undefined,
				labelExpansion: ddo.label !== undefined && ddo.label !== '' ? true : undefined,
				options:
					rawOptions !== null && typeof rawOptions === 'object' && !Array.isArray(rawOptions)
						? (rawOptions as Record<string, unknown>)
						: undefined,
				config:
					rawConfig !== null && typeof rawConfig === 'object' && !Array.isArray(rawConfig)
						? (rawConfig as Record<string, unknown>)
						: rawConfig === undefined
							? undefined
							: { '(not an object)': rawConfig },
			});
		}
		return entries;
	}

	// Auto ddo_map from the node's related components, with the optional
	// node-level general fn (PHP :1286-1305).
	const nodeFn = typeof process?.fn === 'string' ? (process.fn as string) : undefined;
	return relationTipos.map((tipo) => ({
		tipo,
		sectionTipo,
		parent: sectionTipo,
		fn: nodeFn,
	}));
}

/**
 * The chain-tree key of one ddo: root entries (parent === the section) compile
 * with NO `parent`; deeper entries hang under their parent ddo's tipo.
 */
function parentOf(ddo: DdoEntry, sectionTipo: string): string | undefined {
	return ddo.parent !== '' && ddo.parent !== sectionTipo ? ddo.parent : undefined;
}

/** The config keys a relation_list ddo may carry (PHP class.relation_list.php :1278-1302 reads both). */
const RELATION_LIST_CONFIG_KEYS: ReadonlySet<string> = new Set([
	'section_filter',
	'component_filter',
]);

/**
 * A ddo `config` → the relation_list filters it declares (owner C14 2026-11-13,
 * WC-2026-11-13-rdf-relation-list-config). PHP's rdf builder honoured `config`
 * for a relation_list ddo ONLY (class.diffusion_rdf.php :1066-1082) and the
 * relation_list class read `section_filter` (the linked-section whitelist —
 * the inverse search's `section_tipo`, default 'all') and `component_filter`
 * (one `from_component_tipo` locator per tipo) — class.relation_list.php
 * :1278-1302. Those two keys are what compiles; everything else is REFUSED,
 * never ignored: a `config` on a non-relation_list ddo (PHP read none), a key
 * outside the pair (the PHP `resolve_configuration` dd1010 lookup +
 * `filter_locators` SQO are NOT ported), a value that is not a list of tipos.
 * Null = refused (recorded); `{}` = no config.
 */
function relationListConfigFilters(
	ddo: DdoEntry,
	model: string,
	fieldTipo: string,
	fieldLabel: string,
	diagnostics: CompileDiagnostics,
): { sectionFilter?: string[]; componentFilter?: string[] } | null {
	if (ddo.config === undefined) return {};
	const where = `field '${fieldTipo}' (${fieldLabel}): ddo '${ddo.tipo}'`;
	if (model !== 'relation_list') {
		diagnostics.errors.push(
			`${where} (${model}) declares a relation_list 'config' on a model that is not relation_list — PHP read it for relation_list only; remove it or publish the target through its own ddo chain`,
		);
		return null;
	}
	const unknown = Object.keys(ddo.config).filter((key) => !RELATION_LIST_CONFIG_KEYS.has(key));
	if (unknown.length > 0) {
		diagnostics.errors.push(
			`${where} declares a relation_list 'config' with unsupported key(s) ${unknown.map((key) => `'${key}'`).join(', ')} — supported: section_filter, component_filter (the PHP resolve_configuration dd1010 lookup + filter_locators query is not ported)`,
		);
		return null;
	}
	const filters: { sectionFilter?: string[]; componentFilter?: string[] } = {};
	for (const [key, slot] of [
		['section_filter', 'sectionFilter'],
		['component_filter', 'componentFilter'],
	] as const) {
		const raw = ddo.config[key];
		if (raw === undefined) continue;
		const list = stringArrayOf(raw);
		if (list === undefined) {
			diagnostics.errors.push(
				`${where} relation_list 'config.${key}' must be a non-empty list of tipos (got ${JSON.stringify(raw)})`,
			);
			return null;
		}
		filters[slot] = list;
	}
	return filters;
}

/** Accumulates errors/warnings/degradations during one element compile. */
interface CompileDiagnostics {
	errors: string[];
	warnings: string[];
	/** Field-local narrowings: the element still compiles (see PlanDegradation). */
	degradations: PlanDegradation[];
}

/**
 * Two different reasons a tipo has no ontology node, and only ONE of them is a
 * defect (the same split PHP draws with check_active_tld vs check_tipo_is_valid,
 * see relations/request_config/explicit.ts :188-217):
 *
 * - its whole TLD carries no ontology content → the optional PACKAGE is not
 *   installed on this deployment (e.g. a shared element referencing the `zenon`
 *   bibliographic nodes on an install that does not use Zenon). A deployment
 *   fact, never an authoring error: the element must still compile and publish.
 * - the package IS installed but this node is missing → a real authoring defect
 *   that must keep failing the compile loudly.
 *
 * getPopulatedTlds, NOT getActiveTlds: a declared-but-never-imported ontology
 * leaves its registry root `<tld>0` behind, which check_active_tld counts as
 * installed — the exact shape of the install that surfaced this (one `zenon0`
 * row, no zenon1…11).
 *
 * Returns the uninstalled TLD (for the message) or null when this is NOT the
 * package case — including a tipo with no TLD prefix at all, which is junk and
 * stays a hard error.
 */
async function uninstalledTldOf(tipo: string): Promise<string | null> {
	const tld = getTldFromTipo(tipo);
	if (tld === null) return null;
	return (await getPopulatedTlds()).includes(tld) ? null : tld;
}

/**
 * Compile one ddo chain into ResolveStep[]. Each entry becomes a 'component'
 * step (plain value read), a 'relation-hop' step (the chain continues
 * through the component's locators) — depending on whether the component model
 * stores relation locators (storesRelationLocators: descriptor column ===
 * 'relation' MINUS component_external — the TS twin of the PHP relation
 * family get_components_with_relations, which does not list it: a Zenon value
 * is DERIVED, so it is a terminal (T1-42) — plus the pseudo-model
 * relation_list, which PHP special-cases into the relation branch:
 * chain_processor :161-162) — or a
 * 'degraded' step when the tipo is not in the ontology at all. EVERY entry
 * produces exactly one step: the chain is 1:1 with the ddo_map, which is what
 * keeps the field's leaf/column topology identical to the oracle's.
 * Chain topology: root entries have parent === sectionTipo (compiled with NO
 * `parent`); deeper entries hang under their parent ddo's tipo (compiled with
 * `parent` = that tipo), kept in ddo_map order — the resolver's recursive
 * walk (PHP resolve_chain) executes children against each linked record of
 * their parent hop.
 */
async function compileSourceChain(
	ddoMap: DdoEntry[],
	sectionTipo: string,
	fieldTipo: string,
	fieldLabel: string,
	resolveModel: ModelResolver,
	diagnostics: CompileDiagnostics,
): Promise<ResolveStep[]> {
	const chain: ResolveStep[] = [];
	for (const ddo of ddoMap) {
		if (ddo.tipo === '') {
			diagnostics.errors.push(`field '${fieldTipo}' (${fieldLabel}): ddo_map entry without tipo`);
			continue;
		}
		// Root entries carry parent === sectionTipo (buildDdoMap normalization);
		// only a ddo-tipo parent survives into the step (the resolver's tree key).
		const parent = parentOf(ddo, sectionTipo);
		// Through the INJECTED resolver, not getModelByTipo directly: the compile
		// gates drive this hermetically (no dev ontology, no DB).
		const model = await resolveModel(ddo.tipo);
		if (model === null) {
			const uninstalledTld = await uninstalledTldOf(ddo.tipo);
			if (uninstalledTld !== null) {
				// Optional package absent: drop this source, keep the field (its
				// column still exists, empty — the published schema must not shift
				// with which packages an install happens to have).
				console.warn(
					`[diffusion/compile] field '${fieldTipo}' (${fieldLabel}): skipped ddo tipo '${ddo.tipo}' — ontology '${uninstalledTld}' is not installed`,
				);
				diagnostics.warnings.push(`uninstalled-tld:${uninstalledTld}@${fieldTipo}`);
				continue;
			}
			diagnostics.errors.push(
				`field '${fieldTipo}' (${fieldLabel}): ddo tipo '${ddo.tipo}' not found in the ontology`,
			);
			continue;
		}
		// A ddo `config` is a relation_list's filters (owner C14): judged here,
		// where the model is known, and refused loudly anywhere else.
		const configFilters = relationListConfigFilters(ddo, model, fieldTipo, fieldLabel, diagnostics);
		if (configFilters === null) continue;
		const isRelationFamily = storesRelationLocators(model) || model === 'relation_list';
		if (isRelationFamily) {
			const hop: Extract<ResolveStep, { kind: 'relation-hop' }> = {
				kind: 'relation-hop',
				tipo: ddo.tipo,
				model,
				// '' = dynamic: resolved at runtime from the parent hop's targets
				// (the chain processor derives it from the traversed locators).
				sectionTipo: ddo.sectionTipo ?? '',
			};
			if (parent !== undefined) hop.parent = parent;
			if (ddo.id !== undefined) hop.ddoId = ddo.id;
			const sectionFilter = ddo.sectionFilter ?? configFilters.sectionFilter;
			const componentFilter = ddo.componentFilter ?? configFilters.componentFilter;
			if (sectionFilter !== undefined) hop.sectionFilter = sectionFilter;
			if (componentFilter !== undefined) hop.componentFilter = componentFilter;
			if (ddo.dataSlice !== undefined) hop.dataSlice = ddo.dataSlice;
			if (ddo.dedupeSections === true) hop.dedupeSections = true;
			if (ddo.labelExpansion === true) hop.labelExpansion = true;
			// add_parents (chain_processor :305): the hop emits each locator's own
			// ancestor chain — a compile-time flag, not a runtime fn.
			if (ddo.fn === 'add_parents') {
				hop.addParents = true;
			} else if (ddo.fn !== undefined) {
				// A custom fn on a relation hop is resolver-phase behavior we have
				// no slot for yet — surface it, never drop it silently.
				diagnostics.warnings.push(`relation-hop-fn:${ddo.fn}@${fieldTipo}`);
			}
			chain.push(hop);
		} else {
			const step: Extract<ResolveStep, { kind: 'component' }> = {
				kind: 'component',
				tipo: ddo.tipo,
				model,
				sectionTipo: ddo.sectionTipo ?? '',
			};
			if (parent !== undefined) step.parent = parent;
			if (ddo.fn !== undefined && getFlatValueFamily(model) === 'info') {
				// PHP component_info::get_diffusion_data OVERRIDES the common one, so
				// a ddo fn on an info component never runs: the live compute — its
				// PARSED face, owner D1 2026-11-13 — is the value
				// (resolve/info_value.ts). Kept out of the step, never silent.
				diagnostics.warnings.push(`info-fn-ignored:${ddo.fn}@${fieldTipo}`);
			} else if (ddo.fn !== undefined) {
				step.fn = ddo.fn;
			}
			if (ddo.id !== undefined) step.ddoId = ddo.id;
			if (ddo.lang !== undefined) step.pinLang = ddo.lang;
			// PHP $ddo->options (media quality/extension, fn arguments). Carried
			// VERBATIM: the resolver decides what it implements and refuses the
			// rest loudly — the compiler must not silently drop an option.
			if (ddo.options !== undefined) step.options = ddo.options;
			chain.push(step);
		}
	}
	return chain;
}

/**
 * The v6 spellings of the parser directive, and what each is now (P2-13 /
 * PUB-08).
 *
 * `properties.process.parser` naming an UNREGISTERED function is a hard compile
 * ERROR here, under a comment citing "nothing silent". But the v6 spelling of
 * the whole directive — `process_dato`, still carried by 18 ontology nodes —
 * simply misses the `process?.parser` read and yields an EMPTY transform with
 * zero errors, zero warnings and zero degradations. The louder the engine is
 * about a mistyped function name, the more misleading its silence is about a
 * directive it no longer reads at all: the field publishes with no transform and
 * nothing says the ontology asked for one.
 *
 * TWO SHAPES, both retired (P1-13 / PUB-04 un-masked the second, 2026-09-03).
 * The v5/v6 ontology wrote the directive as a STRING naming the PHP fn —
 * `"process_dato": "diffusion_sql::resolve_value"`, arguments beside it in
 * `process_dato_arguments` — and that is the shape every one of the 18 shipped
 * nodes (the dd1101/dd1192 tables of dd1099) actually carries. The first
 * version of this report looked only for `process_dato.parser`, an object
 * shape no shipped node has, so it stayed SILENT on the exact rows it was
 * written for; nobody saw it because those elements could not compile at all
 * (PUB-04) until the seed spoke `diffusion.type`. Any non-empty `process_dato`
 * is therefore the retired directive, whatever its shape.
 *
 * Reported the way the engine already reports a retired property
 * (relations/request_config/build.ts::reportRetiredTargetMode): ONE loud line
 * naming the node and the replacement, then resolve by the ordinary rule.
 */
const RETIRED_PARSER_SPELLINGS: Record<string, string> = {
	process_dato: 'process',
};

/** The v6 fn a string-shaped `process_dato` names, for the report ('' when none). */
function retiredDirectiveFn(block: unknown): string {
	if (typeof block === 'string') return block;
	if (block !== null && typeof block === 'object') {
		const parser = (block as Record<string, unknown>).parser;
		if (typeof parser === 'string') return parser;
		if (Array.isArray(parser)) {
			const first = parser[0] as Record<string, unknown> | undefined;
			return typeof first?.fn === 'string' ? (first.fn as string) : '';
		}
		if (parser !== null && typeof parser === 'object') {
			const fn = (parser as Record<string, unknown>).fn;
			return typeof fn === 'string' ? fn : '';
		}
	}
	return '';
}

function reportRetiredParserSpelling(
	fieldProperties: Record<string, unknown> | null,
	fieldTipo: string,
	fieldLabel: string,
	diagnostics: CompileDiagnostics,
): void {
	if (fieldProperties === null) return;
	for (const [retired, replacement] of Object.entries(RETIRED_PARSER_SPELLINGS)) {
		const block = fieldProperties[retired];
		if (block === undefined || block === null || block === '') continue;
		// An empty object carries no directive; anything else — the shipped
		// string fn, or an object with a parser — asked for a transform.
		if (typeof block === 'object' && !Array.isArray(block) && Object.keys(block).length === 0) {
			continue;
		}
		const fn = retiredDirectiveFn(block);
		// A DEGRADATION, not an error: the run proceeds (the field publishes
		// untransformed, which is what already happens today) but it is now visible
		// in the run report instead of being indistinguishable from "no parser
		// configured".
		diagnostics.degradations.push({
			fieldId: fieldTipo,
			columnName: fieldLabel,
			reason: 'retired_parser_spelling',
			ddoTipo: '',
			disabledDdoTipos: [],
			message:
				`field '${fieldTipo}' (${fieldLabel}) carries RETIRED properties.${retired}` +
				`${fn !== '' ? ` ('${fn}')` : ''} — ` +
				'no longer read, so the field publishes with NO transform. Port the directive to ' +
				`'${replacement}' (ddo_map + parser) in the ontology.`,
		});
	}
}

/**
 * Split the field's parser array (spec §5): runtime steps survive in order,
 * rewriters are absorbed (warning until the resolver lands their rewrites),
 * unknown fns are compile ERRORS naming the field.
 */
function compileTransform(
	fieldProperties: Record<string, unknown> | null,
	classify: ParserClassifier,
	fieldTipo: string,
	fieldLabel: string,
	diagnostics: CompileDiagnostics,
): ParserStepConfig[] {
	const process = fieldProperties?.process as Record<string, unknown> | undefined;
	const rawParser = process?.parser;
	if (rawParser === undefined || rawParser === null) {
		reportRetiredParserSpelling(fieldProperties, fieldTipo, fieldLabel, diagnostics);
		return [];
	}
	// PHP validate normalizes a single parser object to a one-item array (:531).
	const parserSteps = Array.isArray(rawParser) ? rawParser : [rawParser];

	const transform: ParserStepConfig[] = [];
	for (const raw of parserSteps) {
		const step = raw as Record<string, unknown>;
		const fn = typeof step?.fn === 'string' ? (step.fn as string) : '';
		if (fn === '') {
			diagnostics.errors.push(
				`field '${fieldTipo}' (${fieldLabel}): parser step without a 'class::method' fn`,
			);
			continue;
		}
		switch (classify(fn)) {
			case 'runtime':
				transform.push({
					fn,
					id: typeof step.id === 'string' ? (step.id as string) : undefined,
					options: (step.options as Record<string, unknown> | undefined) ?? {},
				});
				break;
			case 'rewriter':
				// Absorbed into plan structure by the resolver phase; until then the
				// absorption itself must stay visible (spec §5 — nothing silent).
				diagnostics.warnings.push(`rewriter:${fn}@${fieldTipo}`);
				break;
			default:
				diagnostics.errors.push(
					`field '${fieldTipo}' (${fieldLabel}): unknown parser fn '${fn}' — not in the parser registry (fix the ontology or register the parser)`,
				);
		}
	}
	return transform;
}

/**
 * Compile one field node of a table (build_datum_context :1263 re-expressed
 * as a plan concept). Returns null only on hard failures already recorded in
 * diagnostics.
 */
async function compileFieldPlan(
	tree: VirtualDiffusionTree,
	fieldTipo: string,
	sectionTipo: string,
	sqlTarget: boolean,
	classify: ParserClassifier,
	resolveModel: ModelResolver,
	diagnostics: CompileDiagnostics,
): Promise<FieldPlan | null> {
	const node = await tree.index.nodeOf(fieldTipo);
	if (node === null) {
		// Same split as compileSourceChain: a field belonging to an ontology
		// package this install does not have is dropped, not a compile failure.
		const uninstalledTld = await uninstalledTldOf(fieldTipo);
		if (uninstalledTld !== null) {
			console.warn(
				`[diffusion/compile] skipped field '${fieldTipo}' — ontology '${uninstalledTld}' is not installed`,
			);
			diagnostics.warnings.push(`uninstalled-tld:${uninstalledTld}@${fieldTipo}`);
			return null;
		}
		diagnostics.errors.push(`field '${fieldTipo}': node not found in the ontology`);
		return null;
	}
	// The column name: a field_* node's MACHINE NAME (labels.ts nameOrLabelOf).
	const label = nameOrLabelOf(node) ?? '';
	const properties = node.properties;
	const process = properties?.process as Record<string, unknown> | undefined;

	// exclude_column (:1275): participates in resolution/publication logic but
	// emits NO output column — so its name is exempt from the SQL chokepoint.
	const excludeColumn = Boolean(properties?.exclude_column);

	// Column name = the field node's machine name (PHP :1288 read its structure-lang term). SQL targets
	// go through the identifier chokepoint; file targets keep the verbatim
	// label (XML/RDF names like 'skos:prefLabel' are not SQL identifiers).
	let columnName = label;
	if (sqlTarget && !excludeColumn) {
		try {
			columnName = requireSqlIdentifier(label, 'column');
		} catch (error) {
			diagnostics.errors.push(`field '${fieldTipo}': ${(error as Error).message}`);
			return null;
		}
	}

	const ddoMap = buildDdoMap(properties, await tree.index.relationTipos(fieldTipo), sectionTipo);
	const sourceChain = await compileSourceChain(
		ddoMap,
		sectionTipo,
		fieldTipo,
		label,
		resolveModel,
		diagnostics,
	);
	const transform = compileTransform(properties, classify, fieldTipo, label, diagnostics);

	// Emit policies (build_datum_context :1354-1364 + process_datum :1170).
	const policy: FieldPolicy = {};
	if (process?.empty_to_string !== undefined)
		policy.emptyToString = Boolean(process.empty_to_string);
	if (process?.default_value !== undefined) policy.defaultValue = String(process.default_value);
	if (process?.empty_value !== undefined) policy.emptyValue = String(process.empty_value);
	if (process?.preserve_order === true) policy.preserveOrder = true;
	// FIELD-level is_publishable (v6 is_publicable) — an override of the per-locator
	// publication check for this column, NOT the table-node publishability override.
	if (properties?.is_publishable === true) policy.publishableOverride = true;
	if (process?.filter_unpublishable === true) policy.filterUnpublishable = true;

	// SQL schema hints (:1342-1352). Two SEPARATE keys, as the old
	// sql_generator read them: `varchar` sizes VARCHAR(n), `length` sizes
	// INT(n). Never conflate — a field_int carrying `varchar: 1024` became
	// INT(1024) and MariaDB refused the CREATE (errno 1439, max 255).
	const column: ColumnDef = { fieldModel: node.model };
	if (typeof properties?.varchar === 'number') column.varcharLength = properties.varchar;
	if (typeof properties?.length === 'number') column.intLength = properties.length;
	if (properties?.index !== undefined) column.index = properties.index;

	// output_format two-stage resolution (build_datum_context :1311-1338).
	// Stage 1: explicit properties->process->output_format. Stage 2: the
	// component class's $diffusion_output_format static map keyed by the FIRST
	// ddo's model — component_relation_common subclasses declare 'json'
	// (component_relation_common.php :146, descriptor column === 'relation');
	// everything else inherits component_common's 'string' (:255), which is
	// the resolver's default stringification, so only 'json' is materialized.
	// (relation_list extends `common`, which carries no map — no fallback.)
	let outputFormat: string | undefined;
	if (typeof process?.output_format === 'string') {
		outputFormat = process.output_format;
	} else {
		// PHP: `$first_ddo = $ddo_map[0]; get_model_by_tipo($first_ddo->tipo)`.
		// Keyed off ddo_map[0], NOT off sourceChain[0]: a skipped first ddo
		// (uninstalled package) has no model and so yields no fallback format —
		// the oracle's own lookup returns null there too. Taking sourceChain[0]
		// blindly would promote the SECOND ddo into first place and could stamp a
		// 'json' format the oracle never picks.
		//
		// The compiled step is reused only when it IS that entry (same tipo), so
		// the common path costs no extra ontology lookup — this runs for every
		// field of every element, and re-resolving here measurably slowed the
		// scheduler drain.
		const firstDdoTipo = ddoMap[0]?.tipo;
		const firstStep = sourceChain[0];
		const firstModel =
			firstDdoTipo !== undefined &&
			firstDdoTipo !== '' &&
			firstStep !== undefined &&
			firstStep.kind !== 'system' &&
			firstStep.kind !== 'degraded' &&
			firstStep.tipo === firstDdoTipo
				? firstStep.model
				: null;
		// storesRelationLocators: PHP component_external extends component_common
		// (string), not component_relation_common (json) — T1-42.
		if (firstModel !== null && storesRelationLocators(firstModel)) {
			outputFormat = 'json';
		}
	}

	const fieldPlan: FieldPlan = {
		id: fieldTipo,
		columnName,
		sourceChain,
		transform,
		column,
		policy,
	};
	if (outputFormat !== undefined) fieldPlan.outputFormat = outputFormat;
	if (excludeColumn) fieldPlan.excludeColumn = true;
	return fieldPlan;
}

/**
 * The CARRIERS of a table node's `global_table_maps` (owner C11, 2026-11-13;
 * plan/global_tables.ts header): the node itself first, with the columns it
 * just compiled, then — through the domain tree, whatever element they sit
 * under — the real table it aliases (or that it is) and every OTHER
 * `table_alias` of that real table that SHARES the maps (an alias declaring
 * its own `global_table_maps` has its own, key-level fallback law of
 * globalTableMapsOfNode), each with the columns ITS direct children emit. The
 * owner's D2 note: numisdata701's `coins`/`types` sources are columns of its
 * alias numisdata845 — legal, filled by the alias's rows.
 */
async function globalTableCarriersOf(
	tree: VirtualDiffusionTree,
	tableNode: VirtualTreeNode,
	ownColumns: readonly string[],
): Promise<GlobalTableCarrier[]> {
	const carriers: GlobalTableCarrier[] = [{ tipo: tableNode.tipo, columns: ownColumns }];
	const realTipo = tableNode.isAlias ? tableNode.realTipo : tableNode.tipo;
	if (realTipo === null) return carriers;
	for (const node of tree.nodes) {
		if (node.tipo === tableNode.tipo || carriers.some((carrier) => carrier.tipo === node.tipo)) {
			continue;
		}
		const isReal = !node.isAlias && node.model === 'table' && node.tipo === realTipo;
		const isSiblingAlias =
			node.isAlias && node.model === 'table_alias' && node.realTipo === realTipo;
		if (!isReal && !isSiblingAlias) continue;
		if (node.isAlias) {
			// An alias with its OWN maps does not share the real's (key-level law).
			const own = (await tree.index.nodeOf(node.tipo))?.properties ?? null;
			if (own?.global_table_maps !== undefined) continue;
		}
		carriers.push({ tipo: node.tipo, columns: await carrierColumnsOf(tree, node) });
	}
	return carriers;
}

/** The emitted column names of a carrier's direct children (excluded fields and unusable labels aside). */
async function carrierColumnsOf(
	tree: VirtualDiffusionTree,
	node: VirtualTreeNode,
): Promise<string[]> {
	const columns: string[] = [];
	for (const childTipo of node.directChildrenTipos) {
		const child = await tree.index.nodeOf(childTipo);
		if (child === null || child.properties?.exclude_column) continue;
		try {
			columns.push(requireSqlIdentifier(nameOrLabelOf(child) ?? '', 'column'));
		} catch {
			// an unusable label fails that carrier's own compile, loudly, there
		}
	}
	return columns;
}

/** Compile one publishable section (a table / owl:Class virtual node). */
async function compileSectionPlan(
	tree: VirtualDiffusionTree,
	tableNode: VirtualTreeNode,
	sectionTipo: string,
	sqlTarget: boolean,
	classify: ParserClassifier,
	resolveModel: ModelResolver,
	diagnostics: CompileDiagnostics,
): Promise<SectionPlan | null> {
	const label = tableNode.label ?? '';
	let tableName = label;
	if (sqlTarget) {
		try {
			tableName = requireSqlIdentifier(label, 'table');
		} catch (error) {
			diagnostics.errors.push(
				`section '${sectionTipo}' (table node '${tableNode.tipo}'): ${(error as Error).message}`,
			);
			return null;
		}
	} else if (label === '') {
		diagnostics.errors.push(
			`section '${sectionTipo}' (table node '${tableNode.tipo}'): empty table label`,
		);
		return null;
	}

	// TABLE-level is_publishable (T2-DIF-1): a plan fact, never a run-time tree
	// read — the run builds no tree unless a rewriter needs recovering, so a
	// tree read silently dropped the flag. Boolean or a loud refusal.
	const tablePublishable = tableNode.properties?.is_publishable;
	if (tablePublishable !== undefined && typeof tablePublishable !== 'boolean') {
		diagnostics.errors.push(
			`section '${sectionTipo}' (table node '${tableNode.tipo}'): properties.is_publishable ` +
				`must be a boolean, got ${JSON.stringify(tablePublishable)}`,
		);
		return null;
	}

	// Columns come from the table node's DIRECT children (oracle
	// dd_diffusion_api::process_datum :996 — get_ar_children is first-level
	// only). childrenTipos is the RECURSIVE UI list: using it makes a nested
	// table node's fields columns of its PARENT table, which collides whenever
	// both declare the same field label ('Duplicate column name').
	const fields: FieldPlan[] = [];
	for (const fieldTipo of tableNode.directChildrenTipos) {
		const fieldPlan = await compileFieldPlan(
			tree,
			fieldTipo,
			sectionTipo,
			sqlTarget,
			classify,
			resolveModel,
			diagnostics,
		);
		if (fieldPlan !== null) fields.push(fieldPlan);
	}

	const sectionPlan: SectionPlan = {
		sectionTipo,
		tableName,
		tableTipo: tableNode.tipo,
		...(tablePublishable === undefined ? {} : { publishable: tablePublishable }),
		fields,
	};
	// v6 global_table_maps: the section's rows ALSO land in aggregate tables
	// (plan/global_tables.ts — compiled here, written by the sql writer).
	const ownColumns = fields
		.filter((field) => field.excludeColumn !== true)
		.map((field) => field.columnName);
	const globalTables = await compileGlobalTables(
		{
			index: tree.index,
			tableNode,
			sectionTipo,
			carriers: await globalTableCarriersOf(tree, tableNode, ownColumns),
			sqlTarget,
			uninstalledTldOf,
		},
		diagnostics,
	);
	if (globalTables.length > 0) sectionPlan.globalTables = globalTables;
	return sectionPlan;
}

/**
 * The publication-blocking faults of the configured language set, as compile
 * errors. PURE and exported so the gate can state each fault without booting a
 * config: `config.diffusion` is frozen at boot, and an invariant that can only
 * be observed by mutating the environment is an invariant nobody tests.
 *
 * Neither set can be honored by ANY plan. A code that is not `lg-xxx` names no
 * rendition at all — it is usually the debris of a JSON-array value split on
 * commas — and a code outside the project languages names a rendition the
 * installation does not edit. Both used to be published without a word: a
 * phantom column of empty values in the published table.
 *
 * STRICTER THAN BEFORE for the out-of-project case, deliberately: it used to be
 * honored silently. Refusing here, where a publication is actually being built,
 * is the loud stop the boot-time console line cannot be — src/config/config.ts
 * is imported at module scope by the whole engine, so throwing there would stop
 * a server whose editors are working perfectly well.
 */
export function langPolicyErrors(diffusionConfig: {
	readonly langsMalformed: readonly string[];
	readonly langsOutsideProject: readonly string[];
}): string[] {
	const errors: string[] = [];
	if (diffusionConfig.langsMalformed.length > 0) {
		errors.push(
			`DEDALO_DIFFUSION_LANGS contains entries that are not 'lg-xxx' language codes: ` +
				`${diffusionConfig.langsMalformed.join(', ')}`,
		);
	}
	if (diffusionConfig.langsOutsideProject.length > 0) {
		errors.push(
			`DEDALO_DIFFUSION_LANGS names languages outside DEDALO_PROJECTS_DEFAULT_LANGS: ` +
				`${diffusionConfig.langsOutsideProject.join(', ')}`,
		);
	}
	return errors;
}

/**
 * Language policy of a plan. The derivation (why the project langs stand in
 * when nothing is configured, why the order is a contract) lives with the ONE
 * resolution, in `resolveDiffusionLangs` / `config.diffusion` (src/config/config.ts).
 */
function buildLangPolicy(): { langs: string[]; mainLang: string | null } {
	const langs = [...config.diffusion.langs];
	return { langs, mainLang: langs[0] ?? null };
}

/**
 * Compile the PublicationPlan of one diffusion element. Throws
 * PlanCompileError carrying EVERY violation (unknown format, unresolvable
 * database, invalid identifiers, unknown parser fns, broken ddo tipos...) —
 * spec §5: loud, never silent. Use validateElementPlan for the non-throwing
 * report shape.
 */
export async function compileElementPlan(
	elementTipo: string,
	options: CompileOptions = {},
): Promise<PublicationPlan & { degradations: PlanDegradation[] }> {
	const classify = options.classifyParserFn ?? (await defaultClassifier());
	const resolveModel = options.resolveModelByTipo ?? getModelByTipo;
	const tree = options.tree ?? (await buildVirtualDiffusionTree());
	if (tree === null) {
		throw new PlanCompileError(
			elementTipo,
			[
				'no diffusion domain available — DEDALO_DIFFUSION_DOMAIN is unset or matches no dd1190 domain node',
			],
			[],
		);
	}

	const diagnostics: CompileDiagnostics = { errors: [], warnings: [], degradations: [] };
	// No plan may be built on a broken language set (see langPolicyErrors).
	diagnostics.errors.push(...langPolicyErrors(config.diffusion));

	// The element as it appears VIRTUALLY (alias tipo kept, alias contract on
	// properties applied by the tree walk).
	const elementNode = tree.nodes.find((node) => node.tipo === elementTipo) ?? null;
	if (elementNode === null || !elementNode.model.startsWith('diffusion_element')) {
		throw new PlanCompileError(
			elementTipo,
			[
				`'${elementTipo}' is not a diffusion element of domain '${tree.domainName}' ` +
					`(model: ${elementNode?.model ?? 'not in the virtual tree'})`,
			],
			[],
		);
	}

	// Format + service name from properties->diffusion (validate :482-510).
	const diffusionProperties = elementNode.properties?.diffusion as
		| { type?: string; service_name?: string }
		| undefined;
	const format = diffusionProperties?.type ?? '';
	if (!KNOWN_FORMATS.has(format)) {
		diagnostics.errors.push(
			`missing or unknown properties->diffusion->type '${format}' ` +
				`(expected one of: ${[...KNOWN_FORMATS].join(', ')})`,
		);
	}
	const serviceName = diffusionProperties?.service_name ?? null;
	const sqlTarget = TABLE_FORMATS.has(format);

	// Target address: MariaDB database for sql/socrata (identifier chokepoint),
	// service-named file area for rdf/xml/markdown.
	let target: TargetAddress | null = null;
	if (sqlTarget) {
		const databaseLabel = getDatabaseNameForElement(tree, elementTipo);
		if (databaseLabel === null || databaseLabel === '') {
			diagnostics.errors.push(
				'unable to resolve database name (define a database or database_alias child)',
			);
		} else {
			try {
				target = { kind: 'table', database: requireSqlIdentifier(databaseLabel, 'database') };
			} catch (error) {
				diagnostics.errors.push((error as Error).message);
			}
		}
	} else if (KNOWN_FORMATS.has(format)) {
		if (serviceName === null || serviceName === '') {
			diagnostics.errors.push(
				`missing properties->diffusion->service_name (required for ${format} file paths)`,
			);
		} else if (!/^[A-Za-z0-9_-]{1,64}$/.test(serviceName)) {
			// DIFF-D (2026-07-28 audit): serviceName becomes a filesystem DIRECTORY
			// segment (writers/files.ts formatTargetDir), so a `../../..`-style label
			// would escape the diffusion files root on write/unlink. The 'sql' branch
			// already ran requireSqlIdentifier; the file branch had only an
			// empty-check. Reject at compile/validate time (loud, before any run).
			diagnostics.errors.push(
				`invalid properties->diffusion->service_name ${JSON.stringify(serviceName)} — must match ^[A-Za-z0-9_-]{1,64}$`,
			);
		} else {
			target = { kind: 'files', serviceName };
		}
	}

	// Every section reachable under the element → SectionPlan.
	const sectionTipos = getSectionsForElement(tree, elementTipo);
	if (sectionTipos.length === 0) {
		diagnostics.errors.push(
			'no sections targeted by this element (check table/owl:Class section relations)',
		);
	}
	// rdf publishes GRAPHS, not columns (plan/rdf_compile.ts, T1-4): its
	// element contract (namespaces, service_type) and one class graph per
	// section, the data-reading properties compiled by the SAME chain compiler.
	const rdfElement =
		format === 'rdf' ? compileRdfElement(elementNode.properties, diagnostics.errors) : null;
	const rdf = rdfElement?.element ?? null;
	const rdfContext: RdfCompileContext | null =
		format === 'rdf'
			? {
					index: tree.index,
					namespaces: new RdfNamespaceTable(rdfElement?.namespaces ?? []),
					resolveModel,
					compileChain: async (nodeTipo, properties, sectionTipo, label) =>
						compileSourceChain(
							buildDdoMap(properties, await tree.index.relationTipos(nodeTipo), sectionTipo),
							sectionTipo,
							nodeTipo,
							label,
							resolveModel,
							diagnostics,
						),
					errors: diagnostics.errors,
					warnings: diagnostics.warnings,
				}
			: null;
	const sections: SectionPlan[] = [];
	for (const sectionTipo of sectionTipos) {
		const tableNode = getSectionNodeForElement(tree, elementTipo, sectionTipo);
		if (tableNode === null) {
			diagnostics.errors.push(`section '${sectionTipo}': no table node under the element`);
			continue;
		}
		const sectionPlan =
			rdfContext !== null
				? await compileRdfSection(rdfContext, tableNode, sectionTipo)
				: await compileSectionPlan(
						tree,
						tableNode,
						sectionTipo,
						sqlTarget,
						classify,
						resolveModel,
						diagnostics,
					);
		if (sectionPlan !== null) sections.push(sectionPlan);
	}
	if (rdfContext !== null) diagnostics.errors.push(...rdfLinkErrors(sections));

	// A MariaDB table wider than the server's row ceiling cannot be created;
	// left to the run, errno 1118 surfaced as an untyped `diffusion.run_failed`
	// AND blocked every other table of the element (ensureSchema covers all).
	// Refused here, named, before any DDL — the fix is the ontology's.
	if (sqlTarget) {
		for (const sectionPlan of sections) {
			const violation = tableRowSizeViolation(sectionPlan);
			if (violation !== null) diagnostics.errors.push(violation);
		}
		diagnostics.errors.push(...globalTableElementErrors(sections));
	}

	if (diagnostics.errors.length > 0 || target === null) {
		if (target === null && diagnostics.errors.length === 0) {
			diagnostics.errors.push('unable to resolve a publication target');
		}
		throw new PlanCompileError(
			elementTipo,
			diagnostics.errors,
			diagnostics.warnings,
			diagnostics.degradations,
		);
	}

	const maxLevels = diffusionResolveLevels();

	return {
		planId: `${elementTipo}:r${currentOntologyRevision()}`,
		elementTipo,
		format,
		serviceName,
		target,
		sections,
		recursion: { maxLevels },
		langPolicy: buildLangPolicy(),
		...(rdf !== null ? { rdf } : {}),
		...(usesFn(sections, MAP_TARGET_SECTION_TIPO_FN)
			? { targetSectionTables: getTargetSectionTableNames(tree, elementTipo) }
			: {}),
		warnings: diagnostics.warnings,
		degradations: diagnostics.degradations,
	};
}

/** The ddo fn whose argument is compiled into the plan (PublicationPlan.targetSectionTables). */
const MAP_TARGET_SECTION_TIPO_FN = 'map_target_section_tipo';

/** Does any component step of any field of these sections declare `fn`? */
function usesFn(sections: SectionPlan[], fn: string): boolean {
	return sections.some((section) =>
		section.fields.some((field) =>
			field.sourceChain.some((step) => step.kind === 'component' && step.fn === fn),
		),
	);
}

/** Non-throwing validate-shape result (dispatch `validate` action input). */
export interface PlanValidationResult {
	result: PublicationPlan | null;
	errors: string[];
	warnings: string[];
	/**
	 * Field-local degradations (PlanDegradation): the element publishes, but
	 * these columns resolve less than the ontology asks for. Reported in BOTH
	 * outcomes — a compile that fails on an unrelated structural violation must
	 * still tell the operator what was already found degraded.
	 */
	degradations: PlanDegradation[];
}

/**
 * Compile wrapped for the `validate` action: violations come back as data
 * instead of an exception; warnings and degradations are reported in both
 * outcomes.
 */
export async function validateElementPlan(
	elementTipo: string,
	options: CompileOptions = {},
): Promise<PlanValidationResult> {
	try {
		const plan = await compileElementPlan(elementTipo, options);
		return {
			result: plan,
			errors: [],
			warnings: plan.warnings,
			degradations: plan.degradations,
		};
	} catch (error) {
		if (error instanceof PlanCompileError) {
			return {
				result: null,
				errors: error.compileErrors,
				warnings: error.compileWarnings,
				degradations: error.compileDegradations,
			};
		}
		return { result: null, errors: [String(error)], warnings: [], degradations: [] };
	}
}
