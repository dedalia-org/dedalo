/**
 * HIERARCHY STATE — the single source of truth for "is this hierarchy usable?",
 * and the single writer that makes it so.
 *
 * WHY THIS EXISTS. The PHP-inherited design had THREE writers, each establishing a
 * DIFFERENT subset of the same invariant, and none of them checking the end state:
 *
 *   - tool_hierarchy "Generate" → provisioned the ontology and MINTED a new root term,
 *     skipping that step whenever the hierarchy45 locator was merely PRESENT;
 *   - the installer's activation → set the flags and LINKED a hard-coded `<tld>1`/1;
 *   - the ontology-main writer → its own literal locators.
 *
 * The seed ships a preset hierarchy45 locator on 158 of 269 hierarchy records, pointing
 * at `<tld>1`/1 — a record that does not exist until that tld's thesaurus is imported.
 * So "is the locator set?" answered YES while the target did not exist: the root term
 * was never created, the tree had nothing to hang children on, and the hierarchy could
 * not be activated at all (live: Albania, 2026-07-14). The same class of bug hid in the
 * model root, which PHP pinned to the literal `<tld>2`/2 — an id that exists in almost
 * no install.
 *
 * THE RULE THAT REPLACES ALL OF IT: never ask whether a locator is set; ask whether its
 * TARGET RECORD EXISTS. A dangling locator is treated as ABSENT, which repairs every one
 * of those 158 seed presets without touching the seed. And never hard-code a record id —
 * resolve the root, or create it.
 *
 * THE INVARIANT (what `inspect` checks and `ensure` converges to):
 *   registry      the hierarchy1 record exists
 *   tld           hierarchy6 is a safe tld
 *   typology      hierarchy9 names a typology (>= 1) — provisioning refuses without it
 *   source        hierarchy109 names a real section — the template the virtual sections
 *                 clone. DEFAULTED to hierarchy20 (thesaurus) when unset, never
 *                 OVERWRITTEN: it is the operator's "Real section tipo", and a hierarchy
 *                 built on another section is legitimate
 *   active        hierarchy4 → dd64/1, with a FULL locator (a bare one — no
 *                 from_component_tipo — is invisible to the jsonb @> containment behind
 *                 every portal's target_sections)
 *   thesaurus     hierarchy125 → dd64/1|2
 *   ontology      dd_ontology has `<tld>0|1|2`, and matrix_ontology has the two `<tld>0`
 *                 node records
 *   targets       hierarchy53 (terms section) and hierarchy58 (model section) each name a
 *                 real section — DEFAULTED to `<tld>1`/`<tld>2` when unset, never
 *                 OVERWRITTEN: like hierarchy109 they are operator data, and a hierarchy
 *                 may legitimately pair foreign sections (live: 'WW' pairs hierarchy53
 *                 `mht72` with hierarchy58 `ww2`)
 *   root_term     hierarchy45 → an EXISTING record in `<tld>1`
 *   root_model    hierarchy59 → an EXISTING record in `<tld>2` (a root-only
 *                 hierarchy with hierarchy58 unset has none: no model section)
 *
 * A root the engine creates is NAMED after the hierarchy (hierarchy5, all languages) —
 * it is the node the whole tree descends from, and an empty one at the top of the tree is
 * alarming and useless. The term component is resolved from the target section's
 * `section_map` (`hierarchy52`: `{thesaurus:{term:'hierarchy25', …}}`), never hard-coded:
 * a hierarchy on a non-hierarchy20 section names a different component. Fill-only — an
 * existing term (imported, or operator-edited) is never overwritten.
 *
 * `ensure` is idempotent: run it twice, get the same DB. `rebuild` = teardown + ensure,
 * and the teardown is ontology-only — the TERMS in `<tld>1` are never touched.
 *
 * THE TWO HIERARCHY KINDS (HIER-REBUILD, owner 2026-11-10;
 * WC-2026-11-10-hierarchy-rebuild-ownership). Case 1 PROVISIONED: the hierarchy
 * owns `<tld>0/1/2`, `<tld>1`/`<tld>2` virtuals of one real section outside the
 * tld (usually hierarchy20). Case 2 ROOT-ONLY: the hierarchy points at a defined
 * section (hierarchy53 outside its own `<tld>1`/`<tld>2`, or a stored `<tld>1`
 * that is not a provisioned virtual) and NEVER provisions `<tld>0/1/2`. ONE
 * classification, read from STORED structure (dd_ontology) — never from the
 * editable hierarchy109/hierarchy53 literals alone — decides both doors:
 * `ensure` provisions only case 1, and `rebuild` (force, FROM SCRATCH: every
 * node of the tld, every `<tld>0` record, the ontology35 row) runs only for an
 * OWNED case 1 hierarchy (classifyHierarchyRebuild), validated before the first
 * delete, teardown + provision in ONE transaction. A refusal is
 * `ontology.teardown_refused` with a `reason` (teardown_scope.ts).
 *
 * SINGLE WRITER: nothing outside this module may call generateVirtualSection or write a
 * root-term locator. Guarded by test/unit/hierarchy_single_writer_tripwire.test.ts.
 */

import { compareLocators } from '../concepts/locator.ts';
import { lockOntologyProjection } from '../db/dd_ontology.ts';
import { updateMatrixKeyData } from '../db/matrix_write.ts';
import { isInTransaction, sql, withTransaction } from '../db/postgres.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import type { ReconcileDefinition } from '../reconcile/registry.ts';
import { applyAddNewElement } from '../relations/save.ts';
import { type Principal, resolvePrincipal } from '../security/permissions.ts';
import { clearOntologyDerivedCaches } from './cache_invalidation.ts';
import { generateVirtualSection } from './hierarchy_provision.ts';
import { deleteOwnedHierarchyOntology } from './ontology_delete.ts';
import {
	HIERARCHY_ACTIVE,
	HIERARCHY_ACTIVE_IN_THESAURUS,
	HIERARCHY_GENERAL_TERM,
	HIERARCHY_GENERAL_TERM_MODEL,
	HIERARCHY_SOURCE_REAL_SECTION,
	HIERARCHY_TARGET_SECTION,
	HIERARCHY_TARGET_SECTION_MODEL,
	HIERARCHY_TERM,
	HIERARCHY_TLD,
	HIERARCHY_TYPOLOGY,
	ONTOLOGY_MAIN_SECTION,
	RELATION_TYPE_CHILDREN,
	RELATION_TYPE_LINK,
	SI_NO_NO,
	SI_NO_YES,
	THESAURUS_SECTION,
	YES_NO_SECTION,
} from './ontology_tipos.ts';
import { getOntologyMainFromTld } from './ontology_write.ts';
import {
	getColumnNameByModel,
	getMatrixTableFromTipo,
	getModelByTipo,
	getSectionRealTipo,
	runtimeModelOfStored,
} from './resolver.ts';
import { getSectionMapValue } from './section_map.ts';
import {
	anotherRegistryRowDeclaresTld,
	isProtectedTld,
	isTeardownRefusal,
	type TeardownRefusalReason,
	teardownRefused,
} from './teardown_scope.ts';
import { getTldFromTipo, safeTld } from './tld.ts';

/** The hierarchy registry section + its table. */
export const HIERARCHY_SECTION = 'hierarchy1';
const HIERARCHY_MAIN_TABLE = 'matrix_hierarchy_main';

export type HierarchyCheckId =
	| 'registry'
	| 'tld'
	| 'typology'
	| 'source'
	| 'active'
	| 'thesaurus'
	| 'ontology'
	| 'targets'
	| 'root_term'
	| 'root_model';

export interface HierarchyCheck {
	id: HierarchyCheckId;
	/** Short human label — the client renders these as the status checklist. */
	label: string;
	ok: boolean;
	/** What is actually there (or what is missing). Shown next to a failed check. */
	detail: string;
}

export interface HierarchyState {
	section_id: number;
	tld: string | null;
	typology: number | null;
	/** Every check passed → the hierarchy is browsable in the thesaurus. */
	usable: boolean;
	checks: HierarchyCheck[];
}

export interface EnsureOptions {
	/** Flag the hierarchy active (hierarchy4 → YES). Default true — that is the point. */
	activate?: boolean;
	/** hierarchy125. Default: keep the stored value, else true. */
	activeInThesaurus?: boolean;
}

export interface EnsureResult {
	/** Did the hierarchy end up usable? (An INTERNAL outcome, never a wire body.) */
	ok: boolean;
	msg: string;
	errors: string[];
	/** The state AFTER the writes — what the client re-renders its checklist from. */
	state: HierarchyState;
	/** What ensure actually had to change (empty on a no-op re-run). */
	applied: string[];
}

/* ------------------------------------------------------------------ reads */

export interface RegistryRow {
	relation: Record<string, Record<string, unknown>[]> | null;
	string: Record<string, { value?: unknown }[]> | null;
}

async function readRegistry(sectionId: number): Promise<RegistryRow | null> {
	const rows = (await sql.unsafe(
		`SELECT relation, string FROM "${HIERARCHY_MAIN_TABLE}"
		 WHERE section_tipo = $1 AND section_id = $2`,
		[HIERARCHY_SECTION, sectionId],
	)) as RegistryRow[];
	return rows[0] ?? null;
}

const literal = (row: RegistryRow | null, tipo: string): string =>
	String(row?.string?.[tipo]?.[0]?.value ?? '');

const locator = (row: RegistryRow | null, tipo: string): Record<string, unknown> | null =>
	row?.relation?.[tipo]?.[0] ?? null;

/**
 * THE SECTIONS THIS HIERARCHY DECLARES — hierarchy53 (terms) and hierarchy58
 * (model), with the `<tld>1`/`<tld>2` convention as the FALLBACK when unset.
 *
 * One resolver, because there used to be none: the `targets` check read the
 * registry (correctly — those are operator data), and then every OTHER consumer
 * re-derived `${tld}1`/`${tld}2` from the TLD name and ignored what the row
 * said. On a hierarchy that pairs foreign sections the two answers disagree,
 * and the tld-derived one is simply wrong: live, 'WW' declares hierarchy53
 * `mht72`, so its perfectly good root term reported `points at mht72/…` — the
 * check announcing the correct value as the defect — and `ensure` would then
 * mint a SECOND root inside `ww1`, a section the operator never pointed at.
 *
 * The fallback is the documented law, not a guess: unset MEANS the convention
 * (`ensureTargetSectionDefaults` writes exactly this pair, fill-only), so on the
 * overwhelming majority of hierarchies — every one that never repointed a
 * target — this returns precisely what the old derivation returned.
 */
function declaredTargets(row: RegistryRow | null, tld: string): { terms: string; model: string } {
	const terms = literal(row, HIERARCHY_TARGET_SECTION);
	const model = literal(row, HIERARCHY_TARGET_SECTION_MODEL);
	return {
		terms: terms === '' ? `${tld}1` : terms,
		model: model === '' ? `${tld}2` : model,
	};
}

/** Does a record exist? The question the old code never asked. */
async function recordExists(sectionTipo: string, sectionId: number): Promise<boolean> {
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) return false;
	const rows = (await sql.unsafe(
		`SELECT 1 FROM "${table}" WHERE section_tipo = $1 AND section_id = $2 LIMIT 1`,
		[sectionTipo, sectionId],
	)) as unknown[];
	return rows.length > 0;
}

/** The lowest-numbered record of a section — the root, by Dédalo's import convention. */
async function lowestRecordId(sectionTipo: string): Promise<number | null> {
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) return null;
	const rows = (await sql.unsafe(
		`SELECT min(section_id) AS id FROM "${table}" WHERE section_tipo = $1`,
		[sectionTipo],
	)) as { id: number | null }[];
	const id = rows[0]?.id;
	return id === null || id === undefined ? null : Number(id);
}

/**
 * The tld's ontology: the `<tld>0` container node plus its two node records, and
 * the two sections this hierarchy DECLARES.
 *
 * It used to assert the `<tld>0/1/2` triad literally, which asks the wrong
 * question twice over: a hierarchy pointing hierarchy53 at a foreign section
 * reported its ontology broken while nothing was, and a `<tld>1` that existed
 * but was not the declared target counted as proof. `<tld>0` stays tld-derived
 * because it IS the tld's container — provisioning creates it — while the term
 * and model sections are read from the row (see `declaredTargets`). When the
 * targets are unset this is byte-identical to the old check.
 */
async function ontologyPresent(
	tld: string,
	targets: { terms: string; model: string },
): Promise<{ ok: boolean; detail: string }> {
	const wanted = [...new Set([`${tld}0`, targets.terms, targets.model])];
	const nodes = (await sql.unsafe(
		"SELECT tipo FROM dd_ontology WHERE tipo = ANY(string_to_array($1, ',')) ORDER BY tipo",
		[wanted.join(',')],
	)) as { tipo: string }[];
	const records = (await sql.unsafe(
		'SELECT section_id FROM matrix_ontology WHERE section_tipo = $1 ORDER BY section_id',
		[`${tld}0`],
	)) as { section_id: number }[];
	const haveNodes = nodes.map((node) => node.tipo);
	const haveRecords = records.map((record) => Number(record.section_id));
	const ok =
		haveNodes.length === wanted.length && haveRecords.includes(1) && haveRecords.includes(2);
	return {
		ok,
		detail: ok
			? `${haveNodes.join(', ')} + ${haveRecords.length} node record(s)`
			: `nodes: [${haveNodes.join(', ') || 'none'}], ${tld}0 records: [${haveRecords.join(', ') || 'none'}]`,
	};
}

/** A root locator is OK only when its TARGET RECORD EXISTS (the whole bug, in one line). */
async function rootTermCheck(
	row: RegistryRow | null,
	componentTipo: string,
	targetSectionTipo: string,
): Promise<{ ok: boolean; detail: string }> {
	const current = locator(row, componentTipo);
	if (current === null) {
		return { ok: false, detail: 'not set' };
	}
	const targetTipo = String(current.section_tipo ?? '');
	const targetId = Number(current.section_id);
	if (targetTipo !== targetSectionTipo || !Number.isFinite(targetId)) {
		return { ok: false, detail: `points at ${targetTipo || '?'}/${current.section_id ?? '?'}` };
	}
	if (!(await recordExists(targetTipo, targetId))) {
		return { ok: false, detail: `DANGLING → ${targetTipo}/${targetId} does not exist` };
	}
	return { ok: true, detail: `${targetTipo}/${targetId}` };
}

/**
 * Does a si/no flag locator say YES? Through compareLocators — the locator law (S2-04):
 * section_id is LOOSE-numeric (a stored '05' must match 5), which an inline `===` gets
 * wrong. Matches on the (section_tipo, section_id) pair only; `type` and
 * `from_component_tipo` are shape, not identity, and are checked separately where they
 * matter.
 */
const siNoIsYes = (candidate: Record<string, unknown> | null, yes: boolean): boolean =>
	candidate !== null &&
	compareLocators(
		candidate as never,
		{ section_tipo: YES_NO_SECTION, section_id: yes ? SI_NO_YES : SI_NO_NO } as never,
		['section_tipo', 'section_id'],
	);

/** Is this locator the full, portal-visible shape (bare = invisible to the @> filter)? */
function activeCheck(row: RegistryRow | null): { ok: boolean; detail: string } {
	const current = locator(row, HIERARCHY_ACTIVE);
	if (current === null) return { ok: false, detail: 'not set' };
	if (!siNoIsYes(current, true)) return { ok: false, detail: 'No' };
	if (current.from_component_tipo === undefined) {
		return { ok: false, detail: 'Yes, but the locator is BARE (invisible to the portals)' };
	}
	return { ok: true, detail: 'Yes' };
}

/**
 * The two model checks (`targets` model half, `root_model`). A root-only
 * hierarchy with hierarchy58 UNSET has no model root — both pass with "none".
 */
async function modelChecks(
	row: RegistryRow | null,
	rootOnly: boolean,
	modelTarget: string,
	targetCheck: (value: string, fallback: string) => Promise<[boolean, string]>,
): Promise<{ target: [boolean, string]; root: { ok: boolean; detail: string } }> {
	if (!hasModelRoot(row, rootOnly)) {
		return { target: [true, NO_MODEL_ROOT], root: { ok: true, detail: NO_MODEL_ROOT } };
	}
	return {
		target: await targetCheck(literal(row, HIERARCHY_TARGET_SECTION_MODEL), modelTarget),
		root: await rootTermCheck(row, HIERARCHY_GENERAL_TERM_MODEL, modelTarget),
	};
}

/** Read the full state of ONE hierarchy. Pure — no writes, safe to call on every render. */
export async function inspectHierarchy(sectionId: number): Promise<HierarchyState> {
	const row = await readRegistry(sectionId);
	const checks: HierarchyCheck[] = [];
	const add = (id: HierarchyCheckId, label: string, ok: boolean, detail: string) =>
		checks.push({ id, label, ok, detail });

	if (row === null) {
		add('registry', 'Hierarchy record', false, `${HIERARCHY_SECTION}/${sectionId} not found`);
		return { section_id: sectionId, tld: null, typology: null, usable: false, checks };
	}
	add('registry', 'Hierarchy record', true, `${HIERARCHY_SECTION}/${sectionId}`);

	const rawTld = literal(row, HIERARCHY_TLD).trim().toLowerCase();
	const tld = safeTld(rawTld);
	add('tld', 'TLD', tld !== null, tld ?? `invalid or empty ('${rawTld}')`);

	const typologyLocator = locator(row, HIERARCHY_TYPOLOGY);
	const typology = typologyLocator ? Math.trunc(Number(typologyLocator.section_id)) : 0;
	add(
		'typology',
		'Typology',
		Number.isInteger(typology) && typology >= 1,
		typology >= 1 ? String(typology) : 'not set (provisioning refuses without it)',
	);

	// The source section is OPERATOR DATA, not a constant. hierarchy109 names the REAL
	// section the virtual ones are cloned from; the tool exposes it as an editable field
	// ("Real section tipo"), and a thesaurus hierarchy just happens to use hierarchy20.
	// So the check is "does it name a section that EXISTS", not "is it hierarchy20" —
	// asserting the constant would let `ensure` silently rewrite a hierarchy built on some
	// other section (live: hierarchy1/266 'Exposición' points at `actv1`, which is in no
	// ontology — that record needs an operator, not a rewrite).
	const source = literal(row, HIERARCHY_SOURCE_REAL_SECTION);
	const sourceModel = source === '' ? null : await getModelByTipo(source);
	add(
		'source',
		'Source section',
		sourceModel === 'section',
		source === ''
			? `not set (defaults to ${THESAURUS_SECTION})`
			: sourceModel === 'section'
				? source
				: `'${source}' is not a section (model: ${sourceModel ?? 'unknown tipo'})`,
	);

	const active = activeCheck(row);
	add('active', 'Active', active.ok, active.detail);

	const thesaurusLocator = locator(row, HIERARCHY_ACTIVE_IN_THESAURUS);
	add(
		'thesaurus',
		'Active in thesaurus',
		thesaurusLocator !== null,
		thesaurusLocator === null ? 'not set' : siNoIsYes(thesaurusLocator, true) ? 'Yes' : 'No',
	);

	if (tld === null) {
		// Every remaining check is tld-derived; report them as blocked, not as false negatives.
		for (const [id, label] of [
			['ontology', 'Ontology'],
			['targets', 'Target sections'],
			['root_term', 'General term'],
			['root_model', 'General term model'],
		] as [HierarchyCheckId, string][]) {
			add(id, label, false, 'blocked: no valid TLD');
		}
		return { section_id: sectionId, tld: null, typology, usable: false, checks };
	}

	// Resolved ONCE, and used by every check below it: the ontology question, the
	// target check's fallback message, and — the fix — the two root checks, which
	// used to re-derive `<tld>1`/`<tld>2` and contradict this very row.
	const targets = declaredTargets(row, tld);

	const ontology = await ontologyCheck(row, tld, targets);
	add('ontology', 'Ontology', ontology.ok, ontology.detail);

	// The target sections are OPERATOR DATA too, not tld-derived constants — the same rule
	// as `source` above. hierarchy53 names the TERMS section, hierarchy58 the MODEL section
	// the terms are typed by, and a hierarchy may legitimately pair foreign sections
	// (live: hierarchy1/250 'WW' points hierarchy53 at `mht72` — a real section with
	// records — and hierarchy58 at `ww2`). So the check is "does each name a section that
	// EXISTS", not "does each equal `<tld>1`/`<tld>2`" — asserting the constants let
	// `ensure` silently repoint that operator pairing at `ww1`, which the model-section
	// resolver (ontology/model_section.ts) now READS, so a rewrite is no longer harmless.
	// A set value that names a non-section is a data defect this check SURFACES — it is
	// never silently repaired (live: hierarchy1/253 hierarchy58 `mht2`, a diffusion_element;
	// hierarchy1/251 and /252 have no hierarchy58 at all).
	const targetCheck = async (value: string, fallback: string): Promise<[boolean, string]> => {
		if (value === '') return [false, `not set (defaults to ${fallback})`];
		const model = await getModelByTipo(value);
		return model === 'section'
			? [true, value]
			: [false, `'${value}' is not a section (model: ${model ?? 'unknown tipo'})`];
	};
	const [targetOk, targetDetail] = await targetCheck(
		literal(row, HIERARCHY_TARGET_SECTION),
		targets.terms,
	);
	// C1: a root-only hierarchy with hierarchy58 UNSET has no model root — not a
	// defect (a SET hierarchy58 naming a non-section still is).
	const model = await modelChecks(row, ontology.rootOnly, targets.model, targetCheck);
	const [targetModelOk, targetModelDetail] = model.target;
	add(
		'targets',
		'Target sections',
		targetOk && targetModelOk,
		`${targetDetail} / ${targetModelDetail}`,
	);

	const rootTerm = await rootTermCheck(row, HIERARCHY_GENERAL_TERM, targets.terms);
	add('root_term', 'General term', rootTerm.ok, rootTerm.detail);
	const rootModel = model.root;
	add('root_model', 'General term model', rootModel.ok, rootModel.detail);

	return {
		section_id: sectionId,
		tld,
		typology,
		usable: checks.every((check) => check.ok),
		checks,
	};
}

/* --------------------------------------------------------- classification */

/**
 * The STORED shape of a tld's `<tld>1`/`<tld>2` (dd_ontology — never the
 * registry literals; plan HIER-REBUILD §1a / F18):
 *   provisioned       each present one is a `section`, the VIRTUAL of exactly one
 *                     real section OUTSIDE the tld (es1 → hierarchy20). Extra
 *                     children of any model are ignored (no model allowlist).
 *   absent            neither exists and the tld holds nothing but `<tld>0`.
 *   root_only         a present one is a REAL section (tchi1): the definition IS
 *                     the hierarchy's section — case 2.
 *   ontology_package  anything else: not a section (numisdata1 = area), a virtual
 *                     of a section INSIDE the tld (tch1 → tch7), of several
 *                     sections, of a virtual; or a tld holding definitions with
 *                     no `<tld>1`/`<tld>2` at all — an installed package.
 */
type StoredShape = 'provisioned' | 'absent' | 'root_only' | 'ontology_package';

interface StoredNode {
	model: string | null;
	relatedTipos: string[];
}

/** The stored dd_ontology rows of `tipos` (runtime model + related tipos), read fresh. */
async function readStoredNodes(tipos: readonly string[]): Promise<Map<string, StoredNode>> {
	const found = new Map<string, StoredNode>();
	if (tipos.length === 0) return found;
	const rows = (await sql.unsafe(
		"SELECT tipo, model, relations FROM dd_ontology WHERE tipo = ANY(string_to_array($1, ','))",
		[tipos.join(',')],
	)) as { tipo: string; model: string | null; relations: unknown }[];
	for (const row of rows) {
		const relations = Array.isArray(row.relations) ? row.relations : [];
		found.set(row.tipo, {
			model: await runtimeModelOfStored(row.tipo, row.model),
			relatedTipos: relations
				.map((relation) => (relation as { tipo?: unknown } | null)?.tipo)
				.filter((tipo): tipo is string => typeof tipo === 'string' && tipo !== ''),
		});
	}
	return found;
}

/** The related tipos of a node whose runtime model is `section`. */
async function relatedSections(node: StoredNode): Promise<string[]> {
	const related = await readStoredNodes(node.relatedTipos);
	return node.relatedTipos.filter((tipo) => related.get(tipo)?.model === 'section');
}

/** One present `<tld>1`/`<tld>2`: null when it is the provisioned shape, else its verdict. */
async function sectionNodeShape(
	tipo: string,
	tld: string,
	node: StoredNode,
): Promise<{ shape: StoredShape; detail: string } | null> {
	if (node.model !== 'section') {
		return { shape: 'ontology_package', detail: `${tipo} is a ${node.model}, not a section` };
	}
	const sources = await relatedSections(node);
	if (sources.length === 0) {
		return { shape: 'root_only', detail: `${tipo} is a real section (a defined section)` };
	}
	return virtualSourceShape(tipo, tld, sources);
}

/** A virtual `<tld>1`/`<tld>2`: provisioned only as the virtual of ONE real section outside the tld. */
async function virtualSourceShape(
	tipo: string,
	tld: string,
	sources: readonly string[],
): Promise<{ shape: StoredShape; detail: string } | null> {
	const source = sources[0] as string;
	if (sources.length > 1 || getTldFromTipo(source) === tld) {
		return {
			shape: 'ontology_package',
			detail: `${tipo} is a virtual of ${sources.join(', ')} — not one real section outside the tld`,
		};
	}
	const sourceNode = (await readStoredNodes([source])).get(source);
	const sourceIsReal = sourceNode !== undefined && (await relatedSections(sourceNode)).length === 0;
	return sourceIsReal
		? null
		: { shape: 'ontology_package', detail: `${tipo}'s source ${source} is not a real section` };
}

/** Neither `<tld>1` nor `<tld>2` exists: absent, unless the tld holds other definitions (a package). */
async function shapeWithoutSections(tld: string): Promise<{ shape: StoredShape; detail: string }> {
	const others = (await sql.unsafe(
		'SELECT count(*)::int AS n FROM dd_ontology WHERE tld = $1 AND tipo <> $2',
		[tld, `${tld}0`],
	)) as { n: number }[];
	return (others[0]?.n ?? 0) > 0
		? { shape: 'ontology_package', detail: `'${tld}' holds definitions but no ${tld}1/${tld}2` }
		: { shape: 'absent', detail: `'${tld}' holds no ${tld}1/${tld}2` };
}

/** The tld's stored projection: every dd_ontology node (tipo → parent) and every `<tld>0` record id. */
interface StoredProjection {
	parents: Map<string, string | null>;
	recordIds: number[];
}

async function readStoredProjection(tld: string): Promise<StoredProjection> {
	const nodes = (await sql.unsafe('SELECT tipo, parent FROM dd_ontology WHERE tld = $1', [
		tld,
	])) as { tipo: string; parent: string | null }[];
	const records = (await sql.unsafe(
		'SELECT section_id FROM matrix_ontology WHERE section_tipo = $1 ORDER BY section_id',
		[`${tld}0`],
	)) as { section_id: number }[];
	return {
		parents: new Map(nodes.map((node) => [node.tipo, node.parent])),
		recordIds: records.map((record) => Number(record.section_id)),
	};
}

/**
 * TEARDOWN-ONLY (A1): the projection must be CONSISTENT — record `<tld>0`/N
 * projects node `<tld>N`, and every node but the `<tld>0` container has its
 * record. A half-projected tld (live: `mdcat` — 12 `<tld>0` records, one node)
 * is an installed package the engine did not build; a teardown would wipe it.
 */
function projectionInconsistency(tld: string, projection: StoredProjection): string | null {
	const unprojected = projection.recordIds.filter((id) => !projection.parents.has(`${tld}${id}`));
	if (unprojected.length > 0) {
		return `${tld}0 record(s) [${unprojected.join(', ')}] have no dd_ontology node`;
	}
	const recordTipos = new Set(projection.recordIds.map((id) => `${tld}${id}`));
	const sourceless = [...projection.parents.keys()].filter(
		(tipo) => tipo !== `${tld}0` && !recordTipos.has(tipo),
	);
	return sourceless.length > 0
		? `node(s) [${sourceless.sort().join(', ')}] have no ${tld}0 record`
		: null;
}

/**
 * TEARDOWN-ONLY (A2): every node but `<tld>0/1/2` must descend from `<tld>1`
 * or `<tld>2` — the legacy extras a provisioned thesaurus carries. A node hung
 * anywhere else (a sibling section under `<tld>0`) is package structure. No
 * model allowlist: WHERE a node hangs decides, not what it is.
 */
function strayNode(tld: string, projection: StoredProjection): string | null {
	const anchors = new Set([`${tld}1`, `${tld}2`]);
	for (const tipo of projection.parents.keys()) {
		if (tipo === `${tld}0` || anchors.has(tipo)) continue;
		if (!descendsFrom(tipo, anchors, projection.parents)) {
			return `${tipo} does not descend from ${tld}1/${tld}2`;
		}
	}
	return null;
}

/** Does `tipo`'s parent chain reach one of `anchors`? (Hop-bounded: a parent cycle ends it.) */
function descendsFrom(
	tipo: string,
	anchors: ReadonlySet<string>,
	parents: ReadonlyMap<string, string | null>,
): boolean {
	let current = parents.get(tipo);
	for (let hops = 0; typeof current === 'string' && hops <= parents.size; hops++) {
		if (anchors.has(current)) return true;
		current = parents.get(current);
	}
	return false;
}

/**
 * TEARDOWN-ONLY (A1): an ABSENT shape (no `<tld>1`/`<tld>2`) holding `<tld>0`
 * records or an ontology35 row is not "nothing to lose" — it is an installed
 * (or inactive) package with no projected sections. Provisioning writes the
 * three together, so an owned hierarchy is never in this state.
 */
async function absentButHolding(tld: string, projection: StoredProjection): Promise<string | null> {
	if (projection.recordIds.length > 0) {
		return `'${tld}' has no ${tld}1/${tld}2 but holds ${projection.recordIds.length} ${tld}0 record(s)`;
	}
	return (await getOntologyMainFromTld(tld)) !== null
		? `'${tld}' has no ${tld}1/${tld}2 but has an ontology35 registry row`
		: null;
}

/** The repair of an installed package / orphan tld: not this hierarchy's to rebuild. */
const UPDATE_ADVICE = 'repair it with an ontology update';

/** The teardown-only package probes (A1/A2), after the stored shape said provisioned or absent. */
async function packageStructure(tld: string, shape: StoredShape): Promise<string | null> {
	const projection = await readStoredProjection(tld);
	if (shape === 'absent') {
		const holding = await absentButHolding(tld, projection);
		if (holding !== null) return `${holding} — ${UPDATE_ADVICE}`;
	}
	const drift = projectionInconsistency(tld, projection);
	if (drift !== null) return `${drift} — ${driftAdvice(tld, shape)}`;
	const stray = strayNode(tld, projection);
	return stray === null ? null : `${stray} — ${UPDATE_ADVICE}`;
}

/**
 * The repair of an inconsistent projection. Under a PROVISIONED shape it is the
 * hierarchy's OWN ontology that drifted (a node lost while its record stays):
 * Force must not run on it, but the hierarchy needs no ontology update — the
 * tld is re-projected from its own records (Ontology parser), then the tool
 * runs without Force. Any other shape keeps the package advice.
 */
function driftAdvice(tld: string, shape: StoredShape): string {
	return shape === 'provisioned'
		? `this hierarchy's own ontology has drifted: re-project '${tld}' from its records (Ontology parser), then run the tool without "Force to create"`
		: UPDATE_ADVICE;
}

async function storedShape(tld: string): Promise<{ shape: StoredShape; detail: string }> {
	const tipos = [`${tld}1`, `${tld}2`];
	const nodes = await readStoredNodes(tipos);
	if (nodes.size === 0) return shapeWithoutSections(tld);
	for (const [tipo, node] of nodes) {
		const verdict = await sectionNodeShape(tipo, tld, node);
		if (verdict !== null) return verdict;
	}
	return { shape: 'provisioned', detail: `${tld}1/${tld}2 are provisioned virtual sections` };
}

/** hierarchy53 names a section OTHER than the hierarchy's own `<tld>1`/`<tld>2` (case 2 by declaration). */
function declaredElsewhere(row: RegistryRow | null, tld: string): boolean {
	const terms = literal(row, HIERARCHY_TARGET_SECTION).trim();
	return terms !== '' && terms !== `${tld}1` && terms !== `${tld}2`;
}

/**
 * CASE 2 (root-only): rooted at a section the hierarchy does not provision —
 * by declaration (hierarchy53) or by stored shape. ensure never provisions
 * `<tld>0/1/2` for it, and its `ontology` check is "the declared sections exist
 * as sections" (plan HIER-REBUILD §3.5, owner decision D7).
 */
async function isRootOnlyHierarchy(row: RegistryRow | null, tld: string): Promise<boolean> {
	if (declaredElsewhere(row, tld)) return true;
	const { shape } = await storedShape(tld);
	return shape === 'root_only' || shape === 'ontology_package';
}

/** The detail of the model checks of a root-only hierarchy that declares no model section. */
const NO_MODEL_ROOT = 'none (root-only, hierarchy58 unset: no model section)';

/**
 * Does this hierarchy HAVE a model root? Always for case 1 (it provisions
 * `<tld>2`). For a root-only (case 2) hierarchy only when hierarchy58 is SET:
 * unset means "no model section" — there is no `<tld>2` it would ever create,
 * so the convention fallback would name a section nothing makes (C1, owner
 * decision 2026-11-10).
 */
function hasModelRoot(row: RegistryRow | null, rootOnly: boolean): boolean {
	return !rootOnly || literal(row, HIERARCHY_TARGET_SECTION_MODEL).trim() !== '';
}

/** The `ontology` check of a root-only hierarchy: its declared sections are sections. */
async function declaredSectionsPresent(
	declared: readonly string[],
): Promise<{ ok: boolean; detail: string }> {
	const missing: string[] = [];
	for (const tipo of new Set(declared)) {
		const model = await getModelByTipo(tipo);
		if (model !== 'section') missing.push(`${tipo} (${model ?? 'unknown tipo'})`);
	}
	return missing.length === 0
		? { ok: true, detail: `root-only: ${declared.join(' / ')} (defined sections)` }
		: { ok: false, detail: `root-only: not a section: ${missing.join(', ')}` };
}

/** The `ontology` check, by kind: case 1 = the provisioned triad; case 2 = the declared sections. */
async function ontologyCheck(
	row: RegistryRow | null,
	tld: string,
	targets: { terms: string; model: string },
): Promise<{ ok: boolean; detail: string; rootOnly: boolean }> {
	const rootOnly = await isRootOnlyHierarchy(row, tld);
	const check = rootOnly
		? await declaredSectionsPresent(
				hasModelRoot(row, true) ? [targets.terms, targets.model] : [targets.terms],
			)
		: await ontologyPresent(tld, targets);
	return { ...check, rootOnly };
}

/** Can "Force to create" run on this hierarchy, and if not, WHY (the client panel reads it). */
export interface RebuildVerdict {
	allowed: boolean;
	reason: TeardownRefusalReason | null;
	tld: string | null;
	detail: string;
}

type RefusalProbe = (
	row: RegistryRow,
	tld: string,
	sectionId: number,
) => Promise<{ reason: TeardownRefusalReason; detail: string } | null>;

/**
 * The refusal probes, IN ORDER — the first that answers decides the reason
 * (core before duplicates: `lg` is both core and declared by a registry row).
 */
const REBUILD_REFUSAL_PROBES: readonly RefusalProbe[] = [
	async (_row, tld) =>
		isProtectedTld(tld)
			? { reason: 'core', detail: `'${tld}' is a core TLD — repair it with an ontology update` }
			: null,
	async (_row, tld, sectionId) =>
		(await anotherRegistryRowDeclaresTld(HIERARCHY_SECTION, sectionId, tld))
			? { reason: 'not_sole_declarer', detail: `another hierarchy record declares '${tld}'` }
			: null,
	async (row, tld) =>
		declaredElsewhere(row, tld)
			? {
					reason: 'root_only',
					detail: `the hierarchy is rooted at '${literal(row, HIERARCHY_TARGET_SECTION)}', a section it does not provision`,
				}
			: null,
	async (_row, tld) => {
		const { shape, detail } = await storedShape(tld);
		if (shape === 'root_only') return { reason: 'root_only', detail };
		const packaged =
			shape === 'ontology_package'
				? `${detail} — ${UPDATE_ADVICE}`
				: await packageStructure(tld, shape);
		return packaged === null ? null : { reason: 'ontology_package', detail: packaged };
	},
	async (row) => {
		const source = literal(row, HIERARCHY_SOURCE_REAL_SECTION);
		const blocker = provisionBlocker(row, source === '' ? null : await getModelByTipo(source));
		return blocker === null ? null : { reason: 'invalid_source', detail: blocker };
	},
];

/**
 * MAY "Force to create" tear this hierarchy down and rebuild it from scratch?
 * Read-only. Allowed only for an OWNED case 1 hierarchy: not a protected TLD
 * (core / `test`), the SOLE hierarchy1 record declaring its TLD, rooted at its
 * own `<tld>1` (hierarchy53 unset or `<tld>1`/`<tld>2`), a stored shape that is
 * provisioned or absent, and every provisioning precondition valid (a row whose
 * hierarchy109 names no section — the 110 `hiearachy20` master rows — is
 * `invalid_source`, never a torn-down hierarchy). rebuildHierarchy re-runs it
 * inside its transaction, under the tld's projection lock.
 */
export async function classifyHierarchyRebuild(
	sectionId: number,
	lockedRow?: RegistryRow | null,
): Promise<RebuildVerdict> {
	// The rebuild hands in the row it read FOR UPDATE, so the tld classified is
	// the tld torn down (A3); every other caller reads it fresh.
	const row = lockedRow === undefined ? await readRegistry(sectionId) : lockedRow;
	const tld = registryTld(row);
	if (row === null || tld === null) {
		return {
			allowed: false,
			reason: 'invalid_source',
			tld,
			detail: 'the hierarchy record is missing or has no valid TLD (hierarchy6)',
		};
	}
	for (const probe of REBUILD_REFUSAL_PROBES) {
		const refusal = await probe(row, tld, sectionId);
		if (refusal !== null) return { allowed: false, tld, ...refusal };
	}
	return { allowed: true, reason: null, tld, detail: `'${tld}' is this hierarchy's own` };
}

/* ----------------------------------------------------------------- writes */

const write = (
	sectionId: number,
	column: 'relation' | 'string',
	tipo: string,
	value: unknown,
): Promise<void> =>
	updateMatrixKeyData(HIERARCHY_MAIN_TABLE, HIERARCHY_SECTION, sectionId, column, tipo, value);

// section_id is the INT constant itself (WC-2026-08-10-section-id-int-canonical
// repeals the String() minting); the readers above compare loose-numerically
// through compareLocators, so legacy '1'/'2' rows still match.
const siNoLocator = (componentTipo: string, yes: boolean) => [
	{
		id: 1,
		type: RELATION_TYPE_LINK,
		section_id: yes ? SI_NO_YES : SI_NO_NO,
		section_tipo: YES_NO_SECTION,
		from_component_tipo: componentTipo,
	},
];

/** The canonical root-term locator ITEM (the component's stored value is [this]). */
const rootLocatorItem = (componentTipo: string, targetSectionTipo: string, targetId: number) => ({
	id: 1,
	// dd48 (Child): the general term is the ROOT CHILD of the hierarchy. Nothing
	// resolves ON the type (area/tree.ts keys on section_tipo+section_id only), but
	// PHP's activation and ontology_write both stamp Child — so we stamp Child.
	type: RELATION_TYPE_CHILDREN,
	// canonical INT address (WC-2026-08-10-section-id-int-canonical)
	section_id: targetId,
	section_tipo: targetSectionTipo,
	from_component_tipo: componentTipo,
});

/**
 * Give a root term the hierarchy's own NAME (hierarchy5 → e.g. "Albania").
 *
 * A root term is the node every other term in the hierarchy descends from, so an unnamed
 * one shows up as an empty row at the top of the tree — alarming and useless.
 *
 * The term component is NOT hard-coded to hierarchy25: a section declares which of its
 * components carries the term in its `section_map` (`hierarchy52` = the thesaurus map,
 * `{thesaurus: {term: 'hierarchy25', model: 'hierarchy27', …}}`), and a hierarchy built on
 * a real section other than hierarchy20 will name a different one. `getSectionMapValue`
 * already resolves the map through a VIRTUAL section to its real one and applies the scope
 * fallback, so `<tld>1` and `<tld>2` both answer correctly.
 *
 * FILL-ONLY, NEVER OVERWRITE. A root that already carries a term is left exactly as it is —
 * it may be an imported root, or one an operator renamed, and neither is ours to clobber.
 * That is also what makes this safe to run on every ensure (it backfills the roots created
 * before this existed) instead of only at creation.
 *
 * The name is copied VERBATIM from hierarchy5 — every language item it holds — so the root
 * reads "Albania" in English and "Albània" in Catalan, exactly like the hierarchy.
 * Non-fatal by contract: an unnamed root is ugly, not broken.
 */
async function nameRootTerm(
	targetSectionTipo: string,
	rootSectionId: number,
	row: RegistryRow | null,
): Promise<{ named: boolean; error: string | null }> {
	const nameItems = row?.string?.[HIERARCHY_TERM];
	if (!Array.isArray(nameItems) || nameItems.length === 0) {
		return { named: false, error: `the hierarchy has no name (${HIERARCHY_TERM})` };
	}
	const termTipo = await getSectionMapValue(targetSectionTipo, 'thesaurus', 'term');
	if (typeof termTipo !== 'string' || termTipo === '') {
		return {
			named: false,
			error: `no term component in the section_map of '${targetSectionTipo}'`,
		};
	}
	const termModel = await getModelByTipo(termTipo);
	const column = termModel === null ? null : getColumnNameByModel(termModel);
	if (column === null) {
		return {
			named: false,
			error: `no matrix column for the term component '${termTipo}' (${termModel})`,
		};
	}
	const table = await getMatrixTableFromTipo(targetSectionTipo);
	if (table === null) {
		return { named: false, error: `no matrix table for '${targetSectionTipo}'` };
	}

	// Already named? Leave it alone.
	const rows = (await sql.unsafe(
		`SELECT "${column}"->$3 AS term FROM "${table}" WHERE section_tipo = $1 AND section_id = $2`,
		[targetSectionTipo, rootSectionId, termTipo],
	)) as { term: { value?: unknown }[] | null }[];
	const current = rows[0]?.term;
	const hasTerm =
		Array.isArray(current) && current.some((item) => String(item?.value ?? '').trim() !== '');
	if (hasTerm) return { named: false, error: null };

	await updateMatrixKeyData(
		table,
		targetSectionTipo,
		rootSectionId,
		column,
		termTipo,
		structuredClone(nameItems),
	);
	return { named: true, error: null };
}

/**
 * Clause 1 of isOwnProvisionedSection: the target is one of the two addresses
 * provisioning mints for a TLD — `<tld>1` (the terms) or `<tld>2` (the models).
 * Any other section is never "the hierarchy's own".
 */
function isProvisionedAddress(targetSectionTipo: string, tld: string): boolean {
	return targetSectionTipo === `${tld}1` || targetSectionTipo === `${tld}2`;
}

/**
 * Clauses 2+3 of isOwnProvisionedSection: the target is a SECTION, and a
 * VIRTUAL one whose real section is the source the registry row declares
 * (hierarchy109; unset ⇒ the default thesaurus section). A real section (its
 * own real tipo) or a virtual of some other source is not a provisioned one.
 */
async function isVirtualOfDeclaredSource(
	targetSectionTipo: string,
	row: RegistryRow | null,
): Promise<boolean> {
	if ((await getModelByTipo(targetSectionTipo)) !== 'section') return false;
	const declaredSource = literal(row, HIERARCHY_SOURCE_REAL_SECTION);
	const source = declaredSource === '' ? THESAURUS_SECTION : declaredSource;
	const realTipo = await getSectionRealTipo(targetSectionTipo);
	return realTipo !== targetSectionTipo && realTipo === source;
}

/**
 * IS `targetSectionTipo` A SECTION THIS HIERARCHY'S OWN PROVISIONING CREATED?
 * The shape hierarchy_provision.ts generateVirtualSection writes, checked
 * exactly as follows (and nothing more):
 *   1. the tipo is `<tld>1` or `<tld>2` of the row's own TLD (hierarchy6);
 *   2. its dd_ontology node is a `section`;
 *   3. it is a VIRTUAL section — `getSectionRealTipo(target) !== target` — whose
 *      real section is the row's declared source (hierarchy109, unset =
 *      hierarchy20). A REAL section named `<X>1`/`<X>2` with hierarchy109 set to
 *      itself is NOT a provisioned virtual and fails here;
 *   4. the TLD is THIS row's: no OTHER hierarchy1 record declares the same
 *      hierarchy6 (trim + lower-case, the `findHierarchyByTld` spelling).
 *
 * WHY (T0-2 review finding F2): hierarchy53 / hierarchy58 are operator data on
 * the registry row, so an editor can steer them at ANY empty section; minting
 * the root there in `system` mode created a record in a section no create rule
 * was ever asked about. A foreign pairing is legitimate (live: WW → mht72), so
 * "the target belongs to the TLD" is NOT a universal invariant — only the
 * hierarchy's OWN provisioned sections are structurally its own. Those keep the
 * system mint (a brand-new `<tld>1` carries no profile grants yet, so asking
 * them would block every non-root activation); any other declared target is a
 * user's choice and is minted under the ACTING principal's New-button
 * predicate ({@link mintDeclaredRootTerm}).
 *
 * WHY 4 IS A UNIQUENESS SCAN (final review S1): hierarchy6 is itself an
 * editor-writable literal — an editor setting it to ANOTHER installed
 * hierarchy's TLD made that hierarchy's `<tld>1` look like this row's own.
 * Provisioning records no row-level ownership fact the editor cannot also
 * write: the only tie from a `<tld>0`/`<tld>1` node back to its registry record
 * is the hierarchy53/58 write-back ON that record (editable), and the `<tld>0`
 * node's grouper parent is not uniform across installs. So the row owns its TLD
 * only when it is the sole record declaring it; a duplicate declaration (the
 * hijack, or a genuinely doubled registry) falls back to the acting principal's
 * create rule. Residual (documented, not checked): a TLD that has NO hierarchy1
 * row at all (an ontology-only TLD whose `<tld>1` is a virtual section) is
 * "owned" by whichever row declares it first.
 */
async function isOwnProvisionedSection(
	targetSectionTipo: string,
	tld: string,
	row: RegistryRow | null,
	sectionId: number,
): Promise<boolean> {
	if (!isProvisionedAddress(targetSectionTipo, tld)) return false;
	if (!(await isVirtualOfDeclaredSource(targetSectionTipo, row))) return false;
	// The sole-declarer scan — ONE function, shared with the rebuild
	// classification and the registry-delete cascade (teardown_scope.ts).
	return !(await anotherRegistryRowDeclaresTld(HIERARCHY_SECTION, sectionId, tld));
}

/**
 * Mint the root in the hierarchy's OWN provisioned section (isOwnProvisionedSection
 * holds): a structural record no user chose — `system` access.
 */
async function mintProvisionedRootTerm(
	sectionId: number,
	componentTipo: string,
	targetSectionTipo: string,
): Promise<{ items: unknown[]; sectionId: number } | null> {
	return applyAddNewElement([], targetSectionTipo, componentTipo, HIERARCHY_SECTION, sectionId, {
		access: {
			mode: 'system',
			reason:
				'the hierarchy invariant mints the root term its tree hangs on, in the hierarchy’s OWN provisioned section (isOwnProvisionedSection: <tld>1/<tld>2, a virtual of its declared source, the TLD declared by no other registry row) — a structural record no user chose (hierarchy_state is the single writer)',
		},
	});
}

/**
 * Mint the root in an operator-DECLARED section that is not the hierarchy's own
 * (F2): the ACTING principal's New-button predicate on the target
 * (applyAddNewElement `create` access; the declared pairing is the structural
 * membership). The installer acts as the superuser, the tool as its caller.
 */
async function mintDeclaredRootTerm(
	sectionId: number,
	componentTipo: string,
	targetSectionTipo: string,
	principal: Principal,
): Promise<{ items: unknown[]; sectionId: number } | null> {
	return applyAddNewElement([], targetSectionTipo, componentTipo, HIERARCHY_SECTION, sectionId, {
		access: { mode: 'create', principal, membership: 'structural' },
	});
}

/**
 * Make `componentTipo` point at a REAL, NAMED root record in `targetSectionTipo`:
 *   - the stored target exists → keep it (re-stamped to the canonical locator shape);
 *   - the section has records  → link its lowest id (the imported root);
 *   - the section is empty     → CREATE the root.
 * Then NAME the root after the hierarchy, if it has no term yet.
 * Never trusts the stored locator, and never hard-codes an id.
 */
async function ensureRootTerm(
	sectionId: number,
	componentTipo: string,
	targetSectionTipo: string,
	row: RegistryRow | null,
	actor: { tld: string; userId: number },
): Promise<{ changed: string[]; error: string | null }> {
	const changed: string[] = [];

	// --- 1. resolve the root record ----------------------------------------
	let rootId: number | null = null;
	const current = locator(row, componentTipo);
	const currentId = Number(current?.section_id);
	if (
		current !== null &&
		String(current.section_tipo) === targetSectionTipo &&
		Number.isFinite(currentId) &&
		(await recordExists(targetSectionTipo, currentId))
	) {
		rootId = currentId;
		// Re-stamp the locator: the seed's are dd151 and some are bare. Equality through
		// compareLocators (S2-04 locator law — loose-numeric section_id), over the FULL quad:
		// a locator naming the right record with the wrong type / no from_component_tipo is
		// still the wrong SHAPE.
		const wanted = rootLocatorItem(componentTipo, targetSectionTipo, rootId);
		const same = compareLocators(current as never, wanted as never, [
			'section_tipo',
			'section_id',
			'type',
			'from_component_tipo',
		]);
		if (!same) {
			await write(sectionId, 'relation', componentTipo, [wanted]);
			changed.push(`${componentTipo}: locator normalized`);
		}
	} else {
		const existingRoot = await lowestRecordId(targetSectionTipo);
		if (existingRoot !== null) {
			rootId = existingRoot;
			await write(sectionId, 'relation', componentTipo, [
				rootLocatorItem(componentTipo, targetSectionTipo, rootId),
			]);
			changed.push(`${componentTipo}: linked the existing root ${targetSectionTipo}/${rootId}`);
		} else {
			// The section is empty — mint the root the tree hangs its children on:
			// as the system in the hierarchy's OWN provisioned section, else under
			// the acting principal's create rule (F2 — a steered target).
			let outcome: { items: unknown[]; sectionId: number } | null;
			if (await isOwnProvisionedSection(targetSectionTipo, actor.tld, row, sectionId)) {
				outcome = await mintProvisionedRootTerm(sectionId, componentTipo, targetSectionTipo);
			} else {
				try {
					outcome = await mintDeclaredRootTerm(
						sectionId,
						componentTipo,
						targetSectionTipo,
						await resolvePrincipal(actor.userId),
					);
				} catch (error) {
					if (!(error instanceof DedaloError) || !error.code.startsWith('perm.')) throw error;
					// The refusal's CODE on the payload (SEC-18: never raw exception text).
					return {
						changed,
						error: `${componentTipo}: may not create a root in ${targetSectionTipo} — it is not this hierarchy’s own section and the acting user may not create there (${error.code})`,
					};
				}
			}
			if (outcome === null) {
				return {
					changed,
					error: `${componentTipo}: could not create a root in ${targetSectionTipo}`,
				};
			}
			rootId = outcome.sectionId;
			await write(sectionId, 'relation', componentTipo, [
				rootLocatorItem(componentTipo, targetSectionTipo, rootId),
			]);
			changed.push(`${componentTipo}: created the root ${targetSectionTipo}/${rootId}`);
		}
	}

	// --- 2. name it ---------------------------------------------------------
	// Runs on EVERY branch, not just creation: the roots minted before this existed are
	// unnamed, and backfilling them is exactly what an idempotent converge is for. Existing
	// names are never touched (nameRootTerm is fill-only).
	const named = await nameRootTerm(targetSectionTipo, rootId, row);
	if (named.error !== null) {
		// Non-fatal: the root EXISTS and the hierarchy is usable; it is just unnamed.
		changed.push(`${componentTipo}: root left unnamed (${named.error})`);
	} else if (named.named) {
		changed.push(
			`${componentTipo}: named the root ${targetSectionTipo}/${rootId} after the hierarchy`,
		);
	}
	return { changed, error: null };
}

/**
 * Step 4 of ensureHierarchy — the target sections. generateVirtualSection
 * writes them; when it was skipped (ontology already present) they may still be
 * missing on an older record. DEFAULT them when unset — never OVERWRITE them
 * (the same law as the source section, step 1). hierarchy53/hierarchy58 are the
 * operator's pairing of terms section and model section, and a pairing that
 * names foreign sections is legitimate (live: hierarchy1/250 'WW' →
 * `mht72`/`ww2`) — rewriting it to the tld constants would quietly repoint the
 * hierarchy, and the model-section resolver reads this pairing. A set value
 * that does not name a section is a data defect the `targets` check surfaces —
 * repairing it here would destroy the evidence the operator needs.
 *
 * A ROOT-ONLY (case 2) hierarchy provisions no `<tld>1`/`<tld>2`, so the
 * convention is defaulted there only when that section EXISTS (a stored real
 * `<tld>1`, tchi-style) — never a pointer at a section nothing will create.
 *
 * Re-reads the registry row itself (the steps before it write to the row) and
 * answers the `applied` lines it produced.
 */
async function ensureTargetSectionDefaults(
	sectionId: number,
	tld: string,
	rootOnly: boolean,
): Promise<string[]> {
	const applied: string[] = [];
	const row = await readRegistry(sectionId);
	for (const [componentTipo, fallback, what] of [
		[HIERARCHY_TARGET_SECTION, `${tld}1`, 'target section'],
		[HIERARCHY_TARGET_SECTION_MODEL, `${tld}2`, 'target model section'],
	] as const) {
		if (literal(row, componentTipo) !== '') continue;
		if (rootOnly && (await getModelByTipo(fallback)) !== 'section') continue;
		await write(sectionId, 'string', componentTipo, [{ id: 1, lang: 'lg-nolan', value: fallback }]);
		applied.push(`${what} set to ${fallback}`);
	}
	return applied;
}

/**
 * Step 5 for ONE root. A root-only hierarchy whose declared (or defaulted)
 * section is not a section gets the reason, not a mint attempt: it provisions
 * no section of its own, so the operator must declare one (hierarchy53/58).
 */
async function ensureDeclaredRoot(
	sectionId: number,
	componentTipo: string,
	targetSectionTipo: string,
	row: RegistryRow | null,
	actor: { tld: string; userId: number; rootOnly: boolean },
): Promise<{ changed: string[]; error: string | null }> {
	if (actor.rootOnly && (await getModelByTipo(targetSectionTipo)) !== 'section') {
		return {
			changed: [],
			error: `${componentTipo}: '${targetSectionTipo}' is not a section — a root-only hierarchy provisions none; declare its section (hierarchy53/hierarchy58)`,
		};
	}
	return ensureRootTerm(sectionId, componentTipo, targetSectionTipo, row, actor);
}

/**
 * The roots ensure converges — [component, declared section] — read from the
 * row AFTER step 4. No model root for a root-only row with hierarchy58 unset (C1).
 */
function declaredRoots(
	row: RegistryRow | null,
	tld: string,
	rootOnly: boolean,
): [string, string][] {
	const targets = declaredTargets(row, tld);
	const roots: [string, string][] = [[HIERARCHY_GENERAL_TERM, targets.terms]];
	if (hasModelRoot(row, rootOnly)) roots.push([HIERARCHY_GENERAL_TERM_MODEL, targets.model]);
	return roots;
}

/** A typology locator (hierarchy9) naming a positive integer record. */
function hasTypology(row: RegistryRow): boolean {
	const typologyLocator = locator(row, HIERARCHY_TYPOLOGY);
	const typology = typologyLocator ? Math.trunc(Number(typologyLocator.section_id)) : 0;
	return Number.isInteger(typology) && typology >= 1;
}

/**
 * WHY ensureHierarchy REFUSES a registry record — null when it can provision it.
 * Pure, and the ONE statement of the rule: ensureHierarchy decides with it, and
 * so does the install seed builder (install/seed_build.ts) over the registry it
 * is about to ship, so a seed whose records cannot be activated is refused at
 * BUILD time, not at the first install (measured 2026-10-09: 110 records with
 * hierarchy109 'hiearachy20' — lg among them — made every fresh install fail).
 *
 * hierarchy109 is the operator's choice of real section ("Real section tipo" in
 * the tool form); a thesaurus hierarchy uses hierarchy20, but a hierarchy built
 * on another section is legitimate, and rewriting it to the thesaurus template
 * would quietly change what the hierarchy IS. Unset is defaulted by the caller;
 * a value naming no section is an operator error we REFUSE to paper over.
 *
 * `sourceModel`: the model of the tipo hierarchy109 names (null when unset or
 * unknown) — resolved by the caller against ITS database.
 */
export function provisionBlocker(row: RegistryRow, sourceModel: string | null): string | null {
	if (safeTld(literal(row, HIERARCHY_TLD).trim().toLowerCase()) === null) {
		return 'the hierarchy has no valid TLD (hierarchy6) — cannot provision';
	}
	if (!hasTypology(row)) return 'the hierarchy has no typology (hierarchy9) — cannot provision';
	const source = literal(row, HIERARCHY_SOURCE_REAL_SECTION);
	if (source !== '' && sourceModel !== 'section') {
		return `the source section '${source}' (hierarchy109) is not a section — fix "Real section tipo" first`;
	}
	return null;
}

/**
 * The inputs provisionBlocker reads, for EVERY registry record, from a database
 * the engine pool is NOT bound to (the seed builder's scratch, over psql): one
 * json array of {section_id, string, relation, source_model}.
 */
export const REGISTRY_PROVISION_INPUTS_SQL = `SELECT COALESCE(json_agg(json_build_object(
	'section_id', h.section_id, 'string', h.string, 'relation', h.relation,
	'source_model', (SELECT o.model FROM dd_ontology o WHERE o.tipo = h.string->'${HIERARCHY_SOURCE_REAL_SECTION}'->0->>'value' LIMIT 1)
) ORDER BY h.section_id), '[]'::json) FROM "${HIERARCHY_MAIN_TABLE}" h WHERE h.section_tipo = '${HIERARCHY_SECTION}'`;

/**
 * Why provisioning did not happen, as the operator should read it. "already
 * generated" is the precondition firing on a PARTIAL ontology (the node records
 * exist but a dd_ontology node was purged): Rebuild is the honest fix — but only
 * named when "Force to create" may actually run here; otherwise the refusal's
 * reason is named instead of steering the operator at a door that refuses.
 */
async function provisionFailureMessage(
	sectionId: number,
	tld: string,
	detail: string,
	provision: { msg: string; errors: string[] },
): Promise<string> {
	if (!provision.msg.includes('already generated')) {
		return `provisioning failed: ${provision.errors.join('; ')}`;
	}
	const verdict = await classifyHierarchyRebuild(sectionId);
	return verdict.allowed
		? `the ontology of '${tld}' is INCOMPLETE (${detail}) — use Rebuild`
		: `the ontology of '${tld}' is INCOMPLETE (${detail}) — Rebuild is not available here (${verdict.reason}: ${verdict.detail})`;
}

/**
 * Converge ONE hierarchy to the invariant. THE only writer. Idempotent: the second run
 * reports `applied: []`. Safe on a live hierarchy — it never deletes anything.
 */
export async function ensureHierarchy(
	sectionId: number,
	userId: number,
	options: EnsureOptions = {},
): Promise<EnsureResult> {
	const applied: string[] = [];
	const errors: string[] = [];
	const fail = async (msg: string): Promise<EnsureResult> => ({
		ok: false,
		msg,
		errors: [...errors, msg],
		state: await inspectHierarchy(sectionId),
		applied,
	});

	let row = await readRegistry(sectionId);
	if (row === null) return fail(`hierarchy record ${HIERARCHY_SECTION}/${sectionId} not found`);

	const currentSource = literal(row, HIERARCHY_SOURCE_REAL_SECTION);
	const blocker = provisionBlocker(
		row,
		currentSource === '' ? null : await getModelByTipo(currentSource),
	);
	if (blocker !== null) return fail(blocker);
	const tld = safeTld(literal(row, HIERARCHY_TLD).trim().toLowerCase()) as string;

	// 1. the template the virtual sections clone. MUST precede provisioning.
	// DEFAULT it when unset — never OVERWRITE it (provisionBlocker refuses a set
	// value that names no section).
	if (currentSource === '') {
		await write(sectionId, 'string', HIERARCHY_SOURCE_REAL_SECTION, [
			{ id: 1, lang: 'lg-nolan', value: THESAURUS_SECTION },
		]);
		applied.push(`source section set to ${THESAURUS_SECTION}`);
	}

	// 2. the flags. A FULL active locator, or the portals cannot see the hierarchy.
	const active = activeCheck(row);
	if (options.activate !== false && !active.ok) {
		await write(sectionId, 'relation', HIERARCHY_ACTIVE, siNoLocator(HIERARCHY_ACTIVE, true));
		applied.push('flagged active');
	}
	const thesaurusLocator = locator(row, HIERARCHY_ACTIVE_IN_THESAURUS);
	const wantThesaurus =
		options.activeInThesaurus ??
		(thesaurusLocator === null ? true : siNoIsYes(thesaurusLocator, true));
	if (
		thesaurusLocator === null ||
		!siNoIsYes(thesaurusLocator, wantThesaurus) ||
		thesaurusLocator.from_component_tipo === undefined
	) {
		await write(
			sectionId,
			'relation',
			HIERARCHY_ACTIVE_IN_THESAURUS,
			siNoLocator(HIERARCHY_ACTIVE_IN_THESAURUS, wantThesaurus),
		);
		applied.push(`active in thesaurus: ${wantThesaurus ? 'Yes' : 'No'}`);
	}

	// 3. the ontology. generateVirtualSection re-reads the record, so the flags above
	// must already be committed — they are (updateMatrixKeyData writes immediately).
	// Asked about the sections the row DECLARES (unset → the `<tld>1`/`<tld>2`
	// convention, which is what provisioning is about to create anyway). A ROOT-ONLY
	// (case 2) hierarchy is NEVER provisioned: it has no `<tld>0/1/2` of its own, its
	// sections follow their ontology definition (HIER-REBUILD, owner decision D7).
	const ontology = await ontologyCheck(row, tld, declaredTargets(row, tld));
	if (!ontology.ok && !ontology.rootOnly) {
		const provision = await generateVirtualSection({
			section_tipo: HIERARCHY_SECTION,
			section_id: sectionId,
			userId,
		});
		if (!provision.ok) {
			return fail(await provisionFailureMessage(sectionId, tld, ontology.detail, provision));
		}
		applied.push(`provisioned the ontology (${tld}0, ${tld}1, ${tld}2)`);
	}

	// 4. the target sections — defaulted when unset, never overwritten (see
	// ensureTargetSectionDefaults for the law).
	applied.push(...(await ensureTargetSectionDefaults(sectionId, tld, ontology.rootOnly)));

	// 5. the roots — resolve-or-create, never trust the stored locator.
	row = await readRegistry(sectionId);
	// Re-read AFTER step 4, so a target just defaulted is seen: the roots go into
	// the sections the row DECLARES, never into `<tld>1`/`<tld>2` derived behind
	// its back (that minted a second root in a section the operator never
	// pointed at, and left the declared one empty).
	for (const [componentTipo, targetSectionTipo] of declaredRoots(row, tld, ontology.rootOnly)) {
		const outcome = await ensureDeclaredRoot(sectionId, componentTipo, targetSectionTipo, row, {
			tld,
			userId,
			rootOnly: ontology.rootOnly,
		});
		if (outcome.error !== null) errors.push(outcome.error);
		applied.push(...outcome.changed);
	}

	// ANNOUNCE THE REGISTRY WRITE (2026-08-14). Everything above goes to the
	// registry through updateMatrixKeyData, which writes the row but fires NO
	// save event — this module is not the ordinary record-save path. That was
	// invisible until the hierarchy53/hierarchy58 pairing became READ DATA
	// (ontology/model_section.ts): defaulting an absent hierarchy53 here, or
	// provisioning a hierarchy, changes what a component_relation_model targets,
	// and without the event the pairing map (and every option list derived from
	// it) keeps the pre-write answer until an unrelated invalidation. Fired ONCE
	// per ensure, after the last write, and only when something actually
	// changed — no new writer, so the single-writer tripwire is unaffected.
	if (applied.length > 0) {
		const { fireSaveEvent } = await import('../section_record/save_event.ts');
		await fireSaveEvent(HIERARCHY_SECTION);
	}

	const state = await inspectHierarchy(sectionId);
	return {
		ok: state.usable && errors.length === 0,
		msg: state.usable
			? applied.length === 0
				? 'Already consistent — nothing to do'
				: `Hierarchy '${tld}' is ready`
			: `Hierarchy '${tld}' is still incomplete`,
		errors,
		state,
		applied,
	};
}

/** A rebuild whose re-provisioning did not end usable: thrown to roll the teardown back. */
class RebuildRolledBack extends Error {
	constructor(readonly outcome: EnsureResult) {
		super(`hierarchy rebuild rolled back: ${outcome.msg}`);
	}
}

/** The safe tld a registry row declares (hierarchy6), or null. */
function registryTld(row: RegistryRow | null): string | null {
	return row === null ? null : safeTld(literal(row, HIERARCHY_TLD).trim().toLowerCase());
}

/** The registry row, read FOR UPDATE (rebuild only: hierarchy6 cannot move under the teardown). */
async function lockRegistryRow(sectionId: number): Promise<RegistryRow | null> {
	const rows = (await sql.unsafe(
		`SELECT relation, string FROM "${HIERARCHY_MAIN_TABLE}"
		 WHERE section_tipo = $1 AND section_id = $2 FOR NO KEY UPDATE`,
		[HIERARCHY_SECTION, sectionId],
	)) as RegistryRow[];
	return rows[0] ?? null;
}

/**
 * The ROW locks of everything the teardown deletes — every `<tld>0` record
 * (section_id order) and the tld's ontology35 row — taken BEFORE the
 * projection lock. The ordinary record delete takes its row lock first and the
 * projection lock second (delete_record → projectOntologyRecordLifecycle), so
 * the rebuild must take them in the same order or the two deadlock (B1).
 */
async function lockTeardownRows(tld: string): Promise<void> {
	// A protected tld is refused before any teardown: nothing to row-lock.
	if (isProtectedTld(tld)) return;
	await sql.unsafe(
		'SELECT section_id FROM matrix_ontology WHERE section_tipo = $1 ORDER BY section_id FOR UPDATE',
		[`${tld}0`],
	);
	await sql.unsafe(
		`SELECT section_id FROM "matrix_ontology_main"
		 WHERE section_tipo = $1 AND string @> $2::text::jsonb ORDER BY section_id FOR UPDATE`,
		[ONTOLOGY_MAIN_SECTION, JSON.stringify({ [HIERARCHY_TLD]: [{ value: tld }] })],
	);
}

/**
 * Inside the rebuild's transaction, in the one lock order (B1): the registry
 * row FOR UPDATE (A3 — read ONCE, its tld is the tld classified and torn
 * down), the tld's teardown rows, THEN the tld's projection lock; classify
 * under all of them and throw the refusal — with the checklist `state` —
 * unless owned. Answers the owned tld.
 */
async function lockAndAdmitRebuild(sectionId: number): Promise<string> {
	const row = await lockRegistryRow(sectionId);
	const declared = registryTld(row);
	if (declared !== null) {
		await lockTeardownRows(declared);
		await lockOntologyProjection([declared]);
	}
	const verdict = await classifyHierarchyRebuild(sectionId, row);
	if (verdict.allowed && verdict.tld !== null) return verdict.tld;
	throw teardownRefused(verdict.tld ?? '', verdict.reason ?? 'invalid_source', {
		detail: verdict.detail,
		coordinates: { section_tipo: HIERARCHY_SECTION, section_id: sectionId },
		state: await inspectHierarchy(sectionId),
	});
}

/**
 * "Force to create": delete the hierarchy's ontology FROM SCRATCH and provision it
 * again (owner decision D10) — every dd_ontology node of the tld, every `<tld>0`
 * record (legacy/install extras included), the tld's ontology35 row; then
 * `ensure`. The `<tld>1` TERMS are never touched, so ensure relinks the root.
 *
 * Only for an OWNED case 1 hierarchy (classifyHierarchyRebuild); otherwise
 * `ontology.teardown_refused` + `reason`, before any write. ONE transaction,
 * ONE lock order (lockAndAdmitRebuild): the registry row FOR UPDATE, the
 * teardown rows, the tld's projection lock; the classification read under
 * them, then the teardown and the re-provisioning. ANY failure after
 * admission — a provisioning that does not end usable, a SQL error anywhere in
 * the teardown or the provisioning — rolls the whole transaction back and
 * answers `ok:false` with the state re-inspected AFTER the rollback (nothing
 * changed). Joined to a caller's transaction, the rollback is the caller's:
 * the failure is re-thrown.
 *
 * RESIDUAL (B3, not this module's to fix): the per-record delete pipeline
 * (delete_record.ts steps 6-7) moves a record's media to `deleted/` and
 * settles its unpublish intent AFTER its own withTransaction returns — which,
 * joined to this one, is before the rebuild commits, and neither is undone by
 * a rollback. A `<tld>0` node record carrying media files or a diffusion
 * target would keep those side effects after a rolled-back rebuild. Ontology
 * node records carry neither today; deferring them to commit
 * (registerCommitAction) is a delete_record change, ledgered, not made here.
 */
export async function rebuildHierarchy(
	sectionId: number,
	userId: number,
	deleteRecord: (sectionTipo: string, sectionId: number) => Promise<unknown>,
	options: EnsureOptions = {},
): Promise<EnsureResult> {
	const ambient = isInTransaction();
	try {
		return await withTransaction(async () => {
			const tld = await lockAndAdmitRebuild(sectionId);
			await deleteOwnedHierarchyOntology({ owned: true, tld }, deleteRecord);
			const ensured = await ensureHierarchy(sectionId, userId, options);
			if (!ensured.ok) throw new RebuildRolledBack(ensured);
			if (ensured.state.tld !== tld) {
				throw new DedaloError('internal.invariant', {
					message: `rebuild of '${tld}' converged a hierarchy declaring '${ensured.state.tld}'`,
					coordinates: { section_tipo: HIERARCHY_SECTION, section_id: sectionId },
				});
			}
			return {
				...ensured,
				applied: [`tore down the ontology of '${tld}' (from scratch)`, ...ensured.applied],
			};
		});
	} catch (error) {
		// Reads inside the rolled-back transaction may have cached its state.
		await clearOntologyDerivedCaches();
		if (ambient || isTeardownRefusal(error)) throw error;
		return rolledBackOutcome(error, sectionId);
	}
}

/** The `ok:false` answer of a rolled-back rebuild — the state read AFTER the rollback. */
async function rolledBackOutcome(error: unknown, sectionId: number): Promise<EnsureResult> {
	const outcome = error instanceof RebuildRolledBack ? error.outcome : null;
	const cause = outcome === null ? String((error as Error)?.message ?? error) : outcome.msg;
	return {
		ok: false,
		msg: `rebuild failed and was rolled back — nothing changed (${cause})`,
		errors: outcome === null ? [cause] : outcome.errors,
		state: await inspectHierarchy(sectionId),
		applied: [],
	};
}

/** Every hierarchy1 record's state — the maintenance overview. */
export async function inspectAllHierarchies(): Promise<HierarchyState[]> {
	const rows = (await sql.unsafe(
		`SELECT section_id FROM "${HIERARCHY_MAIN_TABLE}" WHERE section_tipo = $1 ORDER BY section_id`,
		[HIERARCHY_SECTION],
	)) as { section_id: number }[];
	const states: HierarchyState[] = [];
	for (const row of rows) {
		states.push(await inspectHierarchy(Number(row.section_id)));
	}
	return states;
}

/* --------------------------------------------------------------- registry */

/**
 * Drift of ONE hierarchy under the invariant this module owns: an ACTIVE
 * hierarchy must be usable. An inactive registry row (a shipped country
 * nobody activated) is not drift — its provisioning is deliberately absent.
 */
export function hierarchyIsDrifted(state: HierarchyState): boolean {
	const active = state.checks.find((check) => check.id === 'active')?.ok === true;
	return active && !state.usable;
}

/**
 * The registry shape (core/reconcile/registry.ts, S-10): the hierarchy1
 * registry versus the provisioning it promises (ontology, root term, targets).
 * Apply = `ensureHierarchy` on each drifted row (the single writer, idempotent
 * — but it WRITES registry defaults and roots, so never automatically).
 * `scope` = hierarchy1 section ids.
 */
export const HIERARCHY_RECONCILE: ReconcileDefinition = {
	name: 'hierarchy',
	stores: [
		'hierarchy1 registry (active rows)',
		'hierarchy provisioning (ontology, root term, targets)',
	],
	description:
		'Check that every ACTIVE hierarchy is provisioned and browsable; apply runs ensure on each broken one (creates the missing root/targets, relinks a dangling root).',
	scopeLabel: 'hierarchy1 section id',
	schedule: 'operator',
	sources: ['src/core/ontology/hierarchy_state.ts'],
	async run({ apply, scope }) {
		const states =
			scope === undefined
				? await inspectAllHierarchies()
				: await Promise.all(scope.map((id) => inspectHierarchy(Number(id))));
		const drifted = states.filter(hierarchyIsDrifted);
		const ensured: Record<number, EnsureResult> = {};
		let applied = 0;
		if (apply) {
			for (const state of drifted) {
				const outcome = await ensureHierarchy(state.section_id, -1);
				ensured[state.section_id] = outcome;
				if (outcome.ok) applied++;
			}
		}
		return {
			drift: drifted.length,
			applied,
			detail: { inspected: states.length, drifted, ensured },
		};
	},
};
