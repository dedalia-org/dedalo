/**
 * STAGE 1 of the request_config build — the CLIENT-SHAPED config (PHP
 * common::build_request_config_from_rqo, frozen class.common.php:3056-3131,
 * with validate_requested_ddo :3325-3369 and consolidate_requested_ddo
 * :3380-3404).
 *
 * WHEN IT APPLIES. Only when the rqo TARGETS this element — `source.tipo` is
 * the element, or the element is one of `sqo.section_tipo` — AND the rqo
 * carries a `show` OBJECT. Otherwise `null`: the caller falls through to the
 * element's own (ontology) build. Example — paging tch197's nested rsc1400
 * column, the client sends
 *
 *   { source: {tipo: rsc1400, section_tipo: rsc1389, mode: 'list'},
 *     show:   {ddo_map: [{tipo: rsc86, parent: 'self', section_tipo: rsc197},
 *                        {tipo: rsc85, parent: 'self', section_tipo: rsc197}]} }
 *
 * and stage 1 answers ONE item, built only from what survived validation:
 *
 *   [{ api_engine: 'dedalo', type: 'main',
 *      show: {ddo_map: [rsc86 (label, mode filled), rsc85 (…)]} }]
 *
 * AN EMPTY SHOW IS STILL A SHOW (PHP-exact). PHP gates on
 * `empty($requested_show)`, and `$rqo->show` is a decoded stdClass — `empty()`
 * of an object is always false. So only an ABSENT (or non-object) show returns
 * null; `show:{ddo_map:[]}` and `show:{sqo_config:{…}}` build the item with an
 * empty show map, and the client sqo governs the read:
 *
 *   {source:{tipo:test3}, show:{ddo_map:[]}, sqo:{section_tipo:['test3'], limit:5}}
 *     → [{dedalo, main, show:{ddo_map:[]}, sqo:{section_tipo:[test3 ddo], limit:5, …}}]
 *     (zero columns, the client's page) — NOT the element's own columns.
 *
 * WHAT IS COPIED. Only `ddo_map` from `show` and `search` — never the
 * client's `sqo_config` (its `limit` would escape CLIENT_MAX_LIMIT, since
 * nothing downstream re-clamps a config value) and never `choose`/`hide`
 * (PHP reads neither). The rqo `sqo`, when present, goes through THE client
 * SQO gate, `sanitizeClientSqo` (recursive case-insensitive server-only key
 * strip, depth/node ceilings, locator-pin cap, `parsed=false`, limit/offset
 * clamps) — this item can become an element's paging config, so it gets the
 * same scrub as every other client sqo, never a weaker copy (stricter than PHP,
 * which copied the sqo verbatim). Its `section_tipo` is validated and enriched
 * (PHP build_sqo_section_tipo_ddo); a `limit`/`offset` the client did not send
 * stays absent (PHP), the clamps only bound what was sent.
 *
 * VALIDATION, per ddo (PHP validate_requested_ddo + validate_ddo_tipo):
 *  - an object with a non-empty string `tipo`;
 *  - the tipo resolves to an ontology model (check_tipo_is_valid);
 *  - the tipo's TLD is installed (check_active_tld — isActiveTldTipo, the
 *    one implementation the sqo resolver uses too).
 * Dropped ddos are reported in ONE bounded log line per map (at most
 * SCALAR_BOUNDS.ddoMapWarnings tipos, JSON-escaped): the map is client input,
 * and one line per bad entry would be an amplifier the client controls.
 *
 * READ GRANT — exact PHP + owner decision (d) (plan §9d, 2026-11-03):
 *  - SECTION element: the strict drop (PHP STEP 11 / `get_called_class() ===
 *    'section'`). Stricter than PHP in ONE respect only: EVERY section the ddo
 *    names is judged, not just the first (PHP `reset()`). A declared list is
 *    NARROWED to the sections the actor may read and the ddo dropped when none
 *    is left — `{tipo:C, section_tipo:['A','B']}` with read on (A,C) only
 *    comes out as `section_tipo:['A']`, never as a column B the actor cannot
 *    read.
 *  - COMPONENT element: the inherited read of decision (d) (children of a
 *    component caller are raised to read at emission, capped by the caller's
 *    level — inheritSubdatumPermission) belongs ONLY to children the SERVER
 *    can derive: the element's EFFECTIVE config — its own config ddos plus the
 *    ones its ontology caller injects (caller_injection.ts
 *    collectCallerChildren) — which the caller hands in as
 *    `RqoElement.inheritedDdos`. A client ddo matching one of them (same tipo,
 *    same parent, its sections inside the server ddo's) inherits: page 2 of
 *    tch197's rsc1400 column sends [rsc86, rsc85] at rsc197; a profile with no
 *    rsc197 grant saw them read-only on page 1, so page 2 keeps them. ANY OTHER
 *    client ddo is judged like a section element's (ddoIsAuthorized on every
 *    section it names, narrowed, dropped when none is readable). Without that
 *    split the raise would apply to whatever chain the client invents:
 *
 *      element tch197 (read on tch1/tch197, NO grant on dd128), client sends
 *        {tipo: dd200, parent: self, section_tipo: self}         created-by user → dd128
 *        {tipo: <a dd128 field>, parent: dd200, section_tipo: dd128}
 *      → neither is in tch197's effective config → both judged → the dd128
 *        field is DROPPED (raised to read, it would have served user-record
 *        fields to a profile with no dd128 grant).
 *
 *    THE CALLER (W4, 2026-11-03): a targeted element is resolved UNDER its
 *    caller only when the request names its caller instances in
 *    `source.callers` and the server VERIFIES every link
 *    (relations/caller_chain.ts — the outermost element read by grant, every
 *    further link a declared data child of the one above). Then
 *    `inheritedDdos` is the element's own config PLUS the children its caller
 *    injects, so page 2 of tch197's rsc1400 keeps the read-only columns page 1
 *    showed a restricted profile. Without a chain (or with a refused one) the
 *    element is a top-level read and `inheritedDdos` is its own config: a child
 *    that ONLY the caller's map named is judged by ddoIsAuthorized — never
 *    raised on a client-asserted map.
 *    The client sends the chain for every nested component's own reads
 *    (common.js create_callers, from build_rqo_show / build_rqo_search), so
 *    this is the shipped path; a request WITHOUT it (a hand-built rqo, an
 *    instance whose chain the client cannot name — a tm/search-mode root, a
 *    tool between the cell and its section) keeps the stricter-than-PHP
 *    judgement. PHP never judges a COMPONENT element's client ddos at all
 *    (class.common.php:3346-3360, `get_called_class() === 'section'`): it
 *    would raise ANY client-asserted child to read — the dd128 example above —
 *    so the remaining divergence is a deliberate security floor, ledgered for
 *    WC-2026-11-04-stage1-authorized-sqo-scrub.

 *    A grandchild that is not inherited and declares no section cannot be
 *    judged (undeclared = every locator of its parent, wherever they point):
 *    dropped for a restricted principal.
 *
 * DIRECT CHILDREN OF A COMPONENT are bound to its targets: a direct child's
 * declared sections — every spelling, a source array resolved first through
 * the one resolver — are INTERSECTED with the component's targets, and a ddo
 * left with none is dropped (reported): a section the component cannot point
 * at holds none of its locators. For a component targeting rsc197:
 *
 *   section_tipo ['rsc197', 'dd128']                    → ['rsc197']
 *   section_tipo ['dd128']                              → dropped
 *   section_tipo [{source:'section', value:['dd128']}]  → dropped
 *   section_tipo 'self' / ['self'] / [{source:'self'}]  → ['rsc197']
 *   no section_tipo                                     → kept as declared (PHP;
 *                                                         undeclared = the
 *                                                         component's own locators)
 *
 * DATAFRAMES are the one exception: a component_dataframe direct child is
 * bound to the OWNER section (frames live on the caller's record — explicit.ts
 * resolveDdoSectionTipo, PHP resolve_ddo_self_references :250-255), and its
 * section_tipo is the SCALAR owner section. For numisdata30 (a portal in
 * numisdata3 → rsc197) and its dataframe numisdata1448:
 *
 *   section_tipo 'numisdata3' / 'self' / [{source:'self'}] → 'numisdata3'
 *   section_tipo 'rsc197'                                 → dropped
 *
 * so page 2 (which resends page 1's PROCESSED show, owner section included)
 * resolves the frames exactly as page 1 did.
 *
 * CONSOLIDATION, per surviving ddo (PHP consolidate_requested_ddo), on a
 * CLONE (the rqo is never mutated):
 *  - a SOURCE-ARRAY section_tipo must use the CLIENT grammar — plain strings,
 *    {source:'self'}, {source:'section', value:[…]}, at most
 *    CLIENT_SOURCE_ARRAY_MAX entries + values (explicit.ts
 *    clientSectionTipoRefusal). hierarchy_types / field_value / unknown
 *    sources are ontology-only (they fill a cross-request cache, scan records,
 *    log per entry): the ddo is dropped and folded into the map's one line;
 *      [{source:'hierarchy_types', value:[5]}] → dropped
 *  - a SOURCE-ARRAY section_tipo is resolved first, through the one resolver
 *    (explicit.ts resolveSectionTipoDeclaration): its self-free part becomes
 *    plain tipos, and any 'self' spelling in it (self_depth.ts — all four)
 *    becomes the plain string 'self' in the list, so the grant judges REAL
 *    sections and the depth rule downstream still sees the sentinel:
 *      [{source:'self'}, {source:'section', value:['test38']}] → ['self', 'test38']
 *    (before, the object entry was judged as "no section" and silently lost —
 *    even for root);
 *  - 'self' resolves ONLY for a DIRECT child — parent 'self' or the
 *    requested source tipo — and only when its section_tipo names 'self' (any
 *    spelling) or the element's sections: parent → the element tipo,
 *    section_tipo → the element's sections. 'self', ['self'] and
 *    [{source:'self'}] consolidate IDENTICALLY (PHP saw only the literal; the
 *    engine gives every spelling one meaning — explicit.ts
 *    resolveDdoSectionTipo). A grandchild keeps what it declared (source
 *    arrays resolved as above);
 *  - `label` (application lang) and `mode` (the element's mode) are filled
 *    when absent OR null (PHP `!isset()` is true for null too);
 *  - server-computed keys are the server's: `model` is overwritten with the
 *    resolved model, `permissions` is dropped, and a present `limit` passes
 *    THE client clamp — the governing ddo's limit becomes a page size, and
 *    `limit: 1e9` (or 0 = "all") must never reach it raw. QUIETLY
 *    (clampClientLimitQuietly): every clamped tipo is folded into the map's
 *    ONE bounded report line, like the drops — 2048 ddos with `limit: 1e9`
 *    make one line, not 2048.
 *
 * WHAT 'self' NAMES. For a SECTION element PHP resolves it to the section
 * tipo itself — exact port. For a COMPONENT element PHP would write the
 * COMPONENT tipo into section_tipo (`$new_ddo->section_tipo = $this->tipo`),
 * a value no locator can carry; here it is the component's TARGET sections,
 * which is what a direct child's 'self' means everywhere else in the engine
 * (explicit.ts resolveDdoSectionTipo). The caller states which one it is
 * (`RqoElement.kind`), so this never guesses.
 */

import type { Ddo } from '../../concepts/ddo.ts';
import { SCALAR_BOUNDS } from '../../concepts/scalar_bounds.ts';
import {
	CLIENT_MAX_LIMIT,
	clampClientLimitQuietly,
	sanitizeClientSqo,
} from '../../concepts/sqo.ts';
import { getModelByTipo } from '../../ontology/resolver.ts';
import { contextLabelOf } from '../../resolve/structure_context.ts';
import { ddoIsAuthorized, type Principal } from '../../security/permissions.ts';
import {
	buildSqoSectionTipoDdos,
	clientSectionTipoRefusal,
	isActiveTldTipo,
	isSourceArraySectionTipo,
	type RequestConfigContext,
	resolveSectionTipoDeclaration,
	type SqoSectionTipoDdo,
} from './explicit.ts';
import { isSelfSectionTipoEntry, sectionTipoNamesSelf } from './self_depth.ts';

/**
 * A ddo of the element's EFFECTIVE (server-derived) config, as far as the
 * inherited-read match cares — its own config ddos (processed) plus the ones
 * its ontology caller injects (caller_injection.ts collectCallerChildren),
 * every slot. `parent` 'self' and the element tipo are the same parent;
 * `section_tipo` undefined or 'self' (any spelling) is match-all.
 */
export interface InheritedDdo {
	readonly tipo: string;
	readonly parent?: unknown;
	readonly section_tipo?: unknown;
}

/** The element the rqo is being matched against. */
export type RqoElement =
	| {
			/** A SECTION read: 'self' is the section itself. */
			readonly kind: 'section';
			readonly tipo: string;
			/** The element's render mode — filled into a ddo that declares none. */
			readonly mode: string;
	  }
	| {
			/** A COMPONENT (portal, autocomplete, …): 'self' is its target sections. */
			readonly kind: 'component';
			readonly tipo: string;
			readonly mode: string;
			/** The section the component lives in (the source-array resolver's owner section). */
			readonly sectionTipo: string;
			/** The component's resolved target sections (its own config's sqo). */
			readonly targetSectionTipos: readonly string[];
			/**
			 * The element's EFFECTIVE config ddos — the only client ddos that inherit
			 * the caller's read (module header, READ GRANT). `[]` = none inherit:
			 * every client ddo is judged on its own sections.
			 */
			readonly inheritedDdos: readonly InheritedDdo[];
	  };

/** A client ddo after validation + consolidation. */
export type ConsolidatedDdo = Omit<Ddo, 'label' | 'mode' | 'section_tipo'> & {
	section_tipo?: string | string[];
	label: string | null;
	mode: string;
};

/** The one item stage 1 builds (PHP request_config_object, the keys it sets). */
export interface RqoRequestConfigItem {
	api_engine: 'dedalo';
	type: 'main';
	show: { ddo_map: ConsolidatedDdo[] };
	search?: { ddo_map: ConsolidatedDdo[] };
	sqo?: Record<string, unknown> & { section_tipo: SqoSectionTipoDdo[] };
}

/** The rqo fields stage 1 reads. Typed loosely: this is client input. */
interface RqoShape {
	source?: { tipo?: unknown } | null;
	sqo?: unknown;
	show?: unknown;
	search?: unknown;
}

/** `(array) $value` over strings — the PHP in_array haystack. */
function asTipoList(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	return value === undefined || value === null ? [] : [value];
}

/** The sections 'self' names for this element. */
function selfSectionTiposOf(element: RqoElement): string[] {
	return element.kind === 'section' ? [element.tipo] : [...element.targetSectionTipos];
}

/** The resolver context of the element (its owner section). */
function resolverContextOf(element: RqoElement): RequestConfigContext {
	return {
		ownerTipo: element.tipo,
		ownerSectionTipo: element.kind === 'section' ? element.tipo : element.sectionTipo,
		mode: element.mode,
		ownerIsSection: element.kind === 'section',
	};
}

/** A ddo whose parent is the element: 'self', the requested source tipo or the element tipo. */
function isDirectChildParent(
	parent: unknown,
	requestedSourceTipo: unknown,
	element: RqoElement,
): boolean {
	return (
		typeof parent === 'string' &&
		(parent === 'self' || parent === requestedSourceTipo || parent === element.tipo)
	);
}

/** A non-null object (arrays included) — a JSON value that can carry keys. */
function isObjectLike(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object';
}

/** A value the client actually sent (PHP `isset`: neither absent nor null). */
function isPresent(value: unknown): boolean {
	return value !== undefined && value !== null;
}

/**
 * The gate (PHP :3061-3066): the rqo must target THIS element, by its source
 * tipo or by naming it in sqo.section_tipo.
 */
function rqoTargetsElement(rqo: RqoShape, elementTipo: string): boolean {
	const source = rqo.source;
	if (!isObjectLike(source)) return false;
	if (source.tipo === elementTipo) return true;
	const sqo = rqo.sqo;
	if (!isObjectLike(sqo)) return false;
	return asTipoList(sqo.section_tipo).includes(elementTipo);
}

/** A JSON object block (not null, not an array) — PHP's decoded stdClass. */
function isObjectBlock(block: unknown): block is Record<string, unknown> {
	return isObjectLike(block) && !Array.isArray(block);
}

/** An object block's ddo_map; `[]` when it names none (PHP: a foreach over nothing). */
function blockDdoMap(block: Record<string, unknown>): unknown[] {
	const map = block.ddo_map;
	return Array.isArray(map) ? map : [];
}

/** One client ddo the build refused (or clamped), and why. */
interface ReportedDdo {
	readonly tipo: unknown;
	readonly why: string;
}

/** Whatever `tipo` a client entry carries (for the report — any type). */
function rawTipoOf(candidate: unknown): unknown {
	return isObjectLike(candidate) ? candidate.tipo : undefined;
}

/** A client value, printable on ONE log line: JSON-escaped and length-capped. */
function printableClientTipo(tipo: unknown): string {
	return typeof tipo === 'string' ? JSON.stringify(tipo.slice(0, 64)) : typeof tipo;
}

/** At most SCALAR_BOUNDS.ddoMapWarnings entries named, the rest counted. */
function boundedList(entries: readonly ReportedDdo[], withWhy: boolean): string {
	const shown = entries
		.slice(0, SCALAR_BOUNDS.ddoMapWarnings)
		.map((entry) =>
			withWhy
				? `${printableClientTipo(entry.tipo)} (${entry.why})`
				: printableClientTipo(entry.tipo),
		);
	const hidden = entries.length - shown.length;
	return `${shown.join(', ')}${hidden > 0 ? ` (+${hidden} more)` : ''}`;
}

/**
 * ONE log line per map for everything it dropped AND every limit it clamped
 * (PHP add_request_config_warning, bounded): each list names at most
 * SCALAR_BOUNDS.ddoMapWarnings tipos and counts the rest — the same posture as
 * concepts/ddo.ts keepUsableDdoEntries. A map of 2048 ddos with `limit: 1e9`
 * is one line, never 2048.
 */
function reportMapIssues(
	elementTipo: string,
	mapType: 'show' | 'search',
	dropped: readonly ReportedDdo[],
	clamped: readonly ReportedDdo[],
): void {
	const parts: string[] = [];
	if (dropped.length > 0) {
		parts.push(`removed ${dropped.length} client ${mapType} ddo(s): ${boundedList(dropped, true)}`);
	}
	if (clamped.length > 0) {
		parts.push(
			`clamped ${clamped.length} client ${mapType} ddo limit(s) to CLIENT_MAX_LIMIT=${CLIENT_MAX_LIMIT} (DEC-07, response may be truncated): ${boundedList(clamped, false)}`,
		);
	}
	if (parts.length === 0) return;
	console.warn(`[request_config/from_rqo] ${elementTipo}: ${parts.join('; ')}`);
}

/** A client entry's tipo when it is an object carrying a non-empty string one; else null. */
function requestedTipoOf(candidate: unknown): string | null {
	if (!isObjectBlock(candidate)) return null;
	const tipo = candidate.tipo;
	return typeof tipo === 'string' && tipo !== '' ? tipo : null;
}

/**
 * PHP validate_requested_ddo — shape, model, installed TLD. Answers the
 * resolved model (consolidation stamps it) or why the ddo is dropped. The
 * read grant is judged AFTER consolidation (it needs the resolved section).
 */
async function validateRequestedDdo(
	candidate: unknown,
): Promise<{ readonly model: string } | { readonly why: string }> {
	const tipo = requestedTipoOf(candidate);
	if (tipo === null) return { why: 'missing or invalid tipo' };
	const model = await getModelByTipo(tipo);
	if (model === null) return { why: 'invalid tipo (unresolvable model)' };
	if (!(await isActiveTldTipo(tipo))) return { why: 'tld not installed' };
	return { model };
}

/**
 * A source-array `section_tipo` resolved through THE resolver
 * (explicit.ts resolveSectionTipoDeclaration) to plain tipos, its 'self' (any
 * of the four spellings) kept as the plain string 'self' (module header,
 * CONSOLIDATION). Anything that is not a source array is returned as declared.
 *
 *   [{source:'self'}, {source:'section', value:['test38']}] → ['self', 'test38']
 *   [{source:'section', value:['self']}]                   → ['self']
 *   ([{value:[1], source:'hierarchy_types'}] never gets here: refused upstream,
 *   clientSectionTipoRefusal)
 */
async function resolveDeclaredSourceArray(
	declared: unknown,
	element: RqoElement,
): Promise<unknown> {
	if (!isSourceArraySectionTipo(declared)) return declared;
	const declaration = await resolveSectionTipoDeclaration(declared, resolverContextOf(element));
	if (declaration === null) return declared;
	return [...new Set([...(declaration.namesSelf ? ['self'] : []), ...declaration.sections])];
}

/** Every plain section a declaration names, 'self' (any spelling) standing for `selfSections`. */
function namedSectionsOf(declared: unknown, selfSections: readonly string[]): Set<string> {
	const named = new Set<string>(sectionTipoNamesSelf(declared) ? selfSections : []);
	for (const entry of asTipoList(declared)) {
		if (typeof entry === 'string' && entry !== 'self') named.add(entry);
	}
	return named;
}

/**
 * A COMPONENT element's direct child, bound to its targets (module header,
 * DIRECT CHILDREN OF A COMPONENT): the declared sections — 'self' (any
 * spelling) meaning the targets — intersected with the targets. `null` when
 * nothing is left (the ddo is dropped).
 */
function componentDirectChildSections(
	declared: unknown,
	targets: readonly string[],
): string[] | null {
	const named = namedSectionsOf(declared, targets);
	const kept = targets.filter((target) => named.has(target));
	return kept.length > 0 ? kept : null;
}

/** A clone of the client ddo with the server's own keys (module header, CONSOLIDATION). */
function withServerKeys(
	candidate: Record<string, unknown>,
	model: string,
): { readonly ddo: Record<string, unknown>; readonly limitClamped: boolean } {
	// a client `permissions` never survives the clone
	const { permissions: _clientPermissions, ...ddo } = structuredClone(candidate);
	ddo.model = model;
	if (!isPresent(ddo.limit)) return { ddo, limitClamped: false };
	const clamp = clampClientLimitQuietly(ddo.limit);
	ddo.limit = clamp.limit;
	return { ddo, limitClamped: clamp.clamped };
}

/**
 * A ddo the rqo names as a DIRECT child of the element (PHP: parent 'self' or
 * the requested source tipo). A parent-less ddo is not one: without the typeof
 * guard an absent parent would equal an absent source.tipo (undefined ===
 * undefined) on an rqo that reached the element through sqo.section_tipo alone.
 */
function isRequestedDirectChild(parent: unknown, requestedSourceTipo: unknown): boolean {
	return typeof parent === 'string' && (parent === requestedSourceTipo || parent === 'self');
}

/**
 * A SECTION element's direct child: PHP consolidates only 'self' (every
 * spelling) or the section itself. A MULTI-TARGET ddo that merely includes the
 * section (`[A, B]` on a read of A and B) is not that: it keeps its whole list,
 * or every row of B loses its context (section/read.ts
 * resolveDdoContextSections — one entry per answering section).
 */
function consolidateSectionDirectChild(
	ddo: Record<string, unknown>,
	element: RqoElement & { kind: 'section' },
): void {
	const named = namedSectionsOf(ddo.section_tipo, [element.tipo]);
	if (named.size !== 1 || !named.has(element.tipo)) return;
	ddo.parent = element.tipo;
	ddo.section_tipo = element.tipo;
}

/**
 * A COMPONENT element's direct child: bound to its targets, 'self' (every
 * spelling) = the targets (not PHP's component tipo — module header). An
 * undeclared section stays as declared (PHP). Answers why it is dropped, or null.
 * A component_dataframe direct child is bound to the OWNER section instead
 * (consolidateDataframeDirectChild).
 */
function consolidateComponentDirectChild(
	ddo: Record<string, unknown>,
	element: RqoElement & { kind: 'component' },
): string | null {
	if (!isPresent(ddo.section_tipo)) return null;
	if (ddo.model === 'component_dataframe') return consolidateDataframeDirectChild(ddo, element);
	const sections = componentDirectChildSections(ddo.section_tipo, element.targetSectionTipos);
	if (sections === null) return 'section_tipo outside the component targets';
	ddo.parent = element.tipo;
	ddo.section_tipo = sections;
	return null;
}

/**
 * A COMPONENT element's component_dataframe direct child (module header,
 * DATAFRAMES): frames live on the OWNER record, so the dataframe is bound to
 * the owner section — 'self' (every spelling) and the owner section itself
 * both become the SCALAR owner section, exactly what explicit.ts
 * resolveDdoSectionTipo answers for a dataframe (PHP resolve_ddo_self_references
 * :250-255, `$context->section_tipo`). Intersecting it with the TARGETS (the
 * normal direct-child rule) would drop it, or point it at a section that holds
 * none of its frames. Any other section holds none of the owner's frames:
 * dropped. Answers why it is dropped, or null.
 *
 *   numisdata30 (in numisdata3 → rsc197), child numisdata1448 (dataframe):
 *     section_tipo 'numisdata3'           → 'numisdata3'
 *     section_tipo 'self' / [{source:'self'}] → 'numisdata3'   (NOT ['rsc197'])
 *     section_tipo 'rsc197'               → dropped
 */
function consolidateDataframeDirectChild(
	ddo: Record<string, unknown>,
	element: RqoElement & { kind: 'component' },
): string | null {
	const owner = element.sectionTipo;
	if (!namedSectionsOf(ddo.section_tipo, [owner]).has(owner)) {
		return 'dataframe section_tipo outside the owner section';
	}
	ddo.parent = element.tipo;
	ddo.section_tipo = owner;
	return null;
}

/** PHP `!isset()`: an absent OR null label / mode is filled. */
async function fillLabelAndMode(ddo: Record<string, unknown>, element: RqoElement): Promise<void> {
	if (!isPresent(ddo.label)) ddo.label = await contextLabelOf(ddo.tipo as string);
	if (!isPresent(ddo.mode)) ddo.mode = element.mode;
}

/** PHP consolidate_requested_ddo, on a clone (see the module header). */
async function consolidateRequestedDdo(
	candidate: Record<string, unknown>,
	model: string,
	requestedSourceTipo: unknown,
	element: RqoElement,
): Promise<
	{ readonly ddo: ConsolidatedDdo; readonly limitClamped: boolean } | { readonly why: string }
> {
	const { ddo, limitClamped } = withServerKeys(candidate, model);
	// client input: only the 'self'/'section' source grammar reaches the
	// resolver (explicit.ts clientSectionTipoRefusal) — never hierarchy_types,
	// field_value or an unknown source; the refusal joins the ONE map line
	const refusal = clientSectionTipoRefusal(ddo.section_tipo);
	if (refusal !== null) return { why: refusal };
	ddo.section_tipo = await resolveDeclaredSourceArray(ddo.section_tipo, element);
	if (isRequestedDirectChild(ddo.parent, requestedSourceTipo)) {
		if (element.kind === 'section') {
			consolidateSectionDirectChild(ddo, element);
		} else {
			const why = consolidateComponentDirectChild(ddo, element);
			if (why !== null) return { why };
		}
	}
	await fillLabelAndMode(ddo, element);
	return { ddo: ddo as ConsolidatedDdo, limitClamped };
}

/**
 * Whether a server ddo's sections admit a client ddo's (isInheritedDdo): a
 * server ddo with no section, or 'self' in any spelling, admits any; otherwise
 * the client must declare sections, every one of them among the server's.
 */
function serverSectionsAdmit(serverSections: unknown, clientSections: unknown): boolean {
	if (!isPresent(serverSections) || sectionTipoNamesSelf(serverSections)) return true;
	if (clientSections === undefined) return false;
	const allowed = asTipoList(serverSections);
	return asTipoList(clientSections).every(
		(tipo) => typeof tipo === 'string' && allowed.includes(tipo),
	);
}

/**
 * Whether a consolidated client ddo is one the SERVER derives for a component
 * element (module header, READ GRANT): same tipo, same parent ('self', the
 * requested source tipo and the element tipo are one parent), and every
 * section it names inside the server ddo's sections (serverSectionsAdmit). A
 * client ddo with no section matches only a server ddo with no section —
 * undeclared is broader than any declared list.
 */
function isInheritedDdo(
	ddo: ConsolidatedDdo,
	element: RqoElement & { kind: 'component' },
	requestedSourceTipo: unknown,
): boolean {
	const parentOf = (parent: unknown): unknown =>
		isDirectChildParent(parent, requestedSourceTipo, element) ? element.tipo : parent;
	const clientParent = parentOf(ddo.parent);
	return element.inheritedDdos.some(
		(server) =>
			server.tipo === ddo.tipo &&
			parentOf(server.parent) === clientParent &&
			serverSectionsAdmit(server.section_tipo, ddo.section_tipo),
	);
}

/**
 * Undeclared is the section itself for a section element, a component's targets
 * for its direct child — and unjudgeable (null) for a component's grandchild
 * (every locator of its parent, wherever they point).
 */
function undeclaredSectionsOf(
	element: RqoElement,
	isDirectChild: boolean,
): readonly string[] | null {
	if (element.kind === 'section') return [element.tipo];
	return isDirectChild ? element.targetSectionTipos : null;
}

/** The sections ONE section_tipo entry names for the grant; null = cannot be judged. */
function judgedSectionsOf(
	entry: unknown,
	element: RqoElement,
	isDirectChild: boolean,
): readonly string[] | null {
	if (entry === undefined) return undeclaredSectionsOf(element, isDirectChild);
	// 'self' (any spelling) is what 'self' means for the element
	if (isSelfSectionTipoEntry(entry)) return selfSectionTiposOf(element);
	return typeof entry === 'string' ? [entry] : null;
}

/** Every section readable for `componentTipo` (an empty / unjudgeable list is not). */
async function allReadable(
	principal: Principal,
	sections: readonly string[] | null,
	componentTipo: string,
): Promise<boolean> {
	if (sections === null || sections.length === 0) return false;
	for (const section of sections) {
		if (!(await ddoIsAuthorized(principal, section, componentTipo))) return false;
	}
	return true;
}

/**
 * The strict read drop, judged on EVERY section the ddo names (module header,
 * READ GRANT) — a SECTION element's every ddo, a COMPONENT element's
 * non-inherited ones. Returns the ddo's section_tipo narrowed to the readable
 * sections, or `null` when none is readable (or none can be judged).
 */
async function readableSectionTipoOf(
	ddo: ConsolidatedDdo,
	element: RqoElement,
	isDirectChild: boolean,
	principal: Principal,
): Promise<{ readonly sectionTipo: ConsolidatedDdo['section_tipo'] } | null> {
	const declared = ddo.section_tipo;
	const readableEntry = (entry: unknown): Promise<boolean> =>
		allReadable(principal, judgedSectionsOf(entry, element, isDirectChild), ddo.tipo);
	if (!Array.isArray(declared)) {
		return (await readableEntry(declared)) ? { sectionTipo: declared } : null;
	}
	const readable: string[] = [];
	for (const entry of declared) {
		if (await readableEntry(entry)) readable.push(entry);
	}
	return readable.length > 0 ? { sectionTipo: readable } : null;
}

/**
 * Whether the strict drop judges this ddo: every ddo of a SECTION element (PHP
 * STEP 11); a COMPONENT element's only when the server does not derive it — the
 * inherited read of decision (d) is the server-derived children's alone.
 */
function isGrantJudged(
	ddo: ConsolidatedDdo,
	element: RqoElement,
	requestedSourceTipo: unknown,
): boolean {
	return element.kind === 'section' || !isInheritedDdo(ddo, element, requestedSourceTipo);
}

/** Validate + consolidate + authorize ONE client ddo; the built ddo, or why it is dropped. */
async function buildRequestedDdo(
	candidate: unknown,
	requestedSourceTipo: unknown,
	element: RqoElement,
	principal: Principal | undefined,
): Promise<
	{ readonly ddo: ConsolidatedDdo; readonly limitClamped: boolean } | { readonly why: string }
> {
	const verdict = await validateRequestedDdo(candidate);
	if ('why' in verdict) return verdict;
	const consolidated = await consolidateRequestedDdo(
		candidate as Record<string, unknown>,
		verdict.model,
		requestedSourceTipo,
		element,
	);
	if ('why' in consolidated) return consolidated;
	const { ddo } = consolidated;
	if (principal === undefined || !isGrantJudged(ddo, element, requestedSourceTipo)) {
		return consolidated;
	}
	const isDirectChild = isDirectChildParent(ddo.parent, requestedSourceTipo, element);
	const readable = await readableSectionTipoOf(ddo, element, isDirectChild, principal);
	if (readable === null) return { why: 'no read grant' };
	ddo.section_tipo = readable.sectionTipo;
	return consolidated;
}

/** Validate + consolidate + authorize one client map. */
async function buildRequestedMap(
	rawMap: readonly unknown[],
	mapType: 'show' | 'search',
	requestedSourceTipo: unknown,
	element: RqoElement,
	principal: Principal | undefined,
): Promise<ConsolidatedDdo[]> {
	const built: ConsolidatedDdo[] = [];
	const dropped: ReportedDdo[] = [];
	const clamped: ReportedDdo[] = [];
	for (const candidate of rawMap) {
		const outcome = await buildRequestedDdo(candidate, requestedSourceTipo, element, principal);
		if ('why' in outcome) {
			dropped.push({ tipo: rawTipoOf(candidate), why: outcome.why });
			continue;
		}
		if (outcome.limitClamped) clamped.push({ tipo: outcome.ddo.tipo, why: 'limit clamped' });
		built.push(outcome.ddo);
	}
	reportMapIssues(element.tipo, mapType, dropped, clamped);
	return built;
}

/**
 * The rqo sqo section_tipo entries that are strings with a resolvable model
 * (PHP :3115-3122); the rest reported in ONE bounded line.
 */
async function validSqoSectionTipos(
	rawSectionTipo: unknown,
	elementTipo: string,
): Promise<string[]> {
	const valid: string[] = [];
	const invalid: ReportedDdo[] = [];
	for (const sectionTipo of asTipoList(rawSectionTipo)) {
		if (typeof sectionTipo === 'string' && (await getModelByTipo(sectionTipo)) !== null) {
			valid.push(sectionTipo);
		} else {
			invalid.push({ tipo: sectionTipo, why: 'invalid tipo' });
		}
	}
	if (invalid.length > 0) {
		console.warn(
			`[request_config/from_rqo] ${elementTipo}: removed ${invalid.length} client sqo section_tipo(s): ${boundedList(invalid, false)}`,
		);
	}
	return valid;
}

/**
 * The rqo sqo for the item: section_tipo validated (validSqoSectionTipos),
 * the rest scrubbed by THE client gate (sanitizeClientSqo), then section_tipo
 * enriched (PHP build_sqo_section_tipo_ddo). A limit/offset the client did not
 * send is removed again after the gate (PHP left it absent; the element's own
 * page size governs then).
 */
async function buildRequestedSqo(
	rawSqo: Record<string, unknown>,
	elementTipo: string,
): Promise<Record<string, unknown> & { section_tipo: SqoSectionTipoDdo[] }> {
	const validSections = await validSqoSectionTipos(rawSqo.section_tipo, elementTipo);
	const sanitized = sanitizeClientSqo({
		...structuredClone(rawSqo),
		section_tipo: validSections,
	}) as Record<string, unknown>;
	const { limit, offset, ...rest } = sanitized;
	return {
		...rest,
		...(isPresent(rawSqo.limit) ? { limit } : {}),
		...(isPresent(rawSqo.offset) ? { offset } : {}),
		section_tipo: await buildSqoSectionTipoDdos(validSections),
	};
}

/**
 * Stage 1: the client-shaped request_config for `element`, or `null` when the
 * rqo does not target it or carries no show object (the caller then builds the
 * element's own config). See the module header for every rule.
 *
 * @param rqo       the client request (typed loosely: everything is re-checked here)
 * @param element   which element, and what its 'self' means
 * @param principal the actor whose read grant filters the map (a SECTION
 *                  element's every ddo, a COMPONENT element's non-inherited
 *                  ones); undefined = internal resolution, no filter —
 *                  ddoIsAuthorized's posture
 */
export async function buildRequestConfigFromRqo(
	rqo: unknown,
	element: RqoElement,
	principal: Principal | undefined,
): Promise<RqoRequestConfigItem[] | null> {
	if (!isObjectLike(rqo)) return null;
	const request = rqo as RqoShape;
	// PHP `empty($requested_show)` on a decoded OBJECT: only an absent show is
	// "empty" — an object with an empty (or no) ddo_map still builds the item.
	if (!rqoTargetsElement(request, element.tipo) || !isObjectBlock(request.show)) return null;

	// the gate passed, so source is an object
	const requestedSourceTipo = (request.source as { tipo?: unknown }).tipo;
	const mapOf = (block: Record<string, unknown>, mapType: 'show' | 'search') =>
		buildRequestedMap(blockDdoMap(block), mapType, requestedSourceTipo, element, principal);
	const item: RqoRequestConfigItem = {
		api_engine: 'dedalo',
		type: 'main',
		show: { ddo_map: await mapOf(request.show, 'show') },
	};
	// search: present block → its validated map (possibly empty, as PHP).
	if (isObjectBlock(request.search))
		item.search = { ddo_map: await mapOf(request.search, 'search') };
	if (isObjectBlock(request.sqo)) item.sqo = await buildRequestedSqo(request.sqo, element.tipo);
	return [item];
}
