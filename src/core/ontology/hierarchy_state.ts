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
 *   root_model    hierarchy59 → an EXISTING record in `<tld>2`
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
 * SINGLE WRITER: nothing outside this module may call generateVirtualSection or write a
 * root-term locator. Guarded by test/unit/hierarchy_single_writer_tripwire.test.ts.
 */

import { compareLocators } from '../concepts/locator.ts';
import { updateMatrixKeyData } from '../db/matrix_write.ts';
import { sql } from '../db/postgres.ts';
import type { ReconcileDefinition } from '../reconcile/registry.ts';
import { applyAddNewElement } from '../relations/save.ts';
import { generateVirtualSection } from './hierarchy_provision.ts';
import { deleteOntologyByTld } from './ontology_delete.ts';
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
	RELATION_TYPE_CHILDREN,
	RELATION_TYPE_LINK,
	SI_NO_NO,
	SI_NO_YES,
	THESAURUS_SECTION,
	YES_NO_SECTION,
} from './ontology_tipos.ts';
import { getColumnNameByModel, getMatrixTableFromTipo, getModelByTipo } from './resolver.ts';
import { getSectionMapValue } from './section_map.ts';
import { safeTld } from './tld.ts';

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

	const ontology = await ontologyPresent(tld, targets);
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
	const [targetModelOk, targetModelDetail] = await targetCheck(
		literal(row, HIERARCHY_TARGET_SECTION_MODEL),
		targets.model,
	);
	add(
		'targets',
		'Target sections',
		targetOk && targetModelOk,
		`${targetDetail} / ${targetModelDetail}`,
	);

	const rootTerm = await rootTermCheck(row, HIERARCHY_GENERAL_TERM, targets.terms);
	add('root_term', 'General term', rootTerm.ok, rootTerm.detail);
	const rootModel = await rootTermCheck(row, HIERARCHY_GENERAL_TERM_MODEL, targets.model);
	add('root_model', 'General term model', rootModel.ok, rootModel.detail);

	return {
		section_id: sectionId,
		tld,
		typology,
		usable: checks.every((check) => check.ok),
		checks,
	};
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
			// The section is empty — mint the root the tree hangs its children on.
			const outcome = await applyAddNewElement(
				[],
				targetSectionTipo,
				componentTipo,
				HIERARCHY_SECTION,
				sectionId,
			);
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
 * Re-reads the registry row itself (the steps before it write to the row) and
 * answers the `applied` lines it produced.
 */
async function ensureTargetSectionDefaults(sectionId: number, tld: string): Promise<string[]> {
	const applied: string[] = [];
	const row = await readRegistry(sectionId);
	if (literal(row, HIERARCHY_TARGET_SECTION) === '') {
		await write(sectionId, 'string', HIERARCHY_TARGET_SECTION, [
			{ id: 1, lang: 'lg-nolan', value: `${tld}1` },
		]);
		applied.push(`target section set to ${tld}1`);
	}
	if (literal(row, HIERARCHY_TARGET_SECTION_MODEL) === '') {
		await write(sectionId, 'string', HIERARCHY_TARGET_SECTION_MODEL, [
			{ id: 1, lang: 'lg-nolan', value: `${tld}2` },
		]);
		applied.push(`target model section set to ${tld}2`);
	}
	return applied;
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
	// convention, which is what provisioning is about to create anyway).
	const ontology = await ontologyPresent(tld, declaredTargets(row, tld));
	if (!ontology.ok) {
		const provision = await generateVirtualSection({
			section_tipo: HIERARCHY_SECTION,
			section_id: sectionId,
			userId,
		});
		// "already generated" is the precondition firing on a PARTIAL ontology (e.g. the
		// node records exist but a dd_ontology node was purged). Surface it — a rebuild
		// is the honest fix, and silently proceeding would leave a half-built hierarchy.
		if (!provision.ok) {
			return fail(
				provision.msg.includes('already generated')
					? `the ontology of '${tld}' is INCOMPLETE (${ontology.detail}) — use Rebuild`
					: `provisioning failed: ${provision.errors.join('; ')}`,
			);
		}
		applied.push(`provisioned the ontology (${tld}0, ${tld}1, ${tld}2)`);
	}

	// 4. the target sections — defaulted when unset, never overwritten (see
	// ensureTargetSectionDefaults for the law).
	applied.push(...(await ensureTargetSectionDefaults(sectionId, tld)));

	// 5. the roots — resolve-or-create, never trust the stored locator.
	row = await readRegistry(sectionId);
	// Re-read AFTER step 4, so a target just defaulted is seen: the roots go into
	// the sections the row DECLARES, never into `<tld>1`/`<tld>2` derived behind
	// its back (that minted a second root in a section the operator never
	// pointed at, and left the declared one empty).
	const ensureTargets = declaredTargets(row, tld);
	for (const [componentTipo, targetSectionTipo] of [
		[HIERARCHY_GENERAL_TERM, ensureTargets.terms],
		[HIERARCHY_GENERAL_TERM_MODEL, ensureTargets.model],
	] as [string, string][]) {
		const outcome = await ensureRootTerm(sectionId, componentTipo, targetSectionTipo, row);
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

/**
 * Tear the tld's ONTOLOGY down and rebuild it. The `<tld>1` TERMS are NOT touched —
 * deleteOntologyByTld only removes the dd_ontology nodes, the ontology_main row and the
 * `<tld>0` node records — so `ensure` relinks the surviving root afterwards.
 */
export async function rebuildHierarchy(
	sectionId: number,
	userId: number,
	deleteRecord: (sectionTipo: string, sectionId: number) => Promise<unknown>,
	options: EnsureOptions = {},
): Promise<EnsureResult> {
	const row = await readRegistry(sectionId);
	const tld = safeTld(literal(row, HIERARCHY_TLD).trim().toLowerCase());
	if (row === null || tld === null) {
		return {
			ok: false,
			msg: 'cannot rebuild: the hierarchy record has no valid TLD',
			errors: ['invalid tld'],
			state: await inspectHierarchy(sectionId),
			applied: [],
		};
	}
	const teardown = await deleteOntologyByTld(tld, deleteRecord);
	if (!teardown.ok) {
		return {
			ok: false,
			msg: `teardown of '${tld}' failed — nothing was rebuilt`,
			errors: teardown.errors,
			state: await inspectHierarchy(sectionId),
			applied: [],
		};
	}
	const ensured = await ensureHierarchy(sectionId, userId, options);
	return {
		...ensured,
		applied: [`tore down the ontology of '${tld}'`, ...ensured.applied],
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
