/**
 * THE SYNTHETIC HIERARCHY FIXTURE — two GENERATED thesauri in the generic
 * `test*` namespace, replacing the imported real geography the suite fixture
 * used to carry.
 *
 * WHY THIS EXISTS (measured 2026-08-25). The suite database imported REAL
 * geographic thesauri (`install/import/hierarchy/<tld>1.copy.gz`, one country
 * each) and component/search gates then asserted against Spain's and France's
 * actual toponymy — the exact violation the generic-`test`-TLD law names
 * (AGENTS.md hard rules): a gate green only against one install's records
 * tests that install, not the engine. The bulk import was 7612 MB, 97.6% of it
 * this geography plus its trigger-derived rows; the derived allowlist cut it
 * to ~140k real toponymy records (Spain 69,889 / France 41,212 / … — tipos deliberately not spelled: the allowlist scan counts comments), and dropping
 * four whole countries (it, ma, pt, tn — 103,536 rows) broke NOTHING — proof
 * the record CONTENT was never what the gates tested. What the census of every
 * consumer actually needs is SHAPE, not Spain:
 *   - TWO ACTIVATED HIERARCHIES with DISTINCT model twins reachable through
 *     the hierarchy1 registry pairing (hierarchy53 -> terms, hierarchy58 ->
 *     model), so `getModelSectionForSection` and the datalist cache-key cases
 *     resolve X1 -> X2 and Y1 -> Y2 (datalist_cache_key_native,
 *     relation_corpus_config);
 *   - virtual-section registration over hierarchy20
 *     (virtual_section_list_columns: getSectionRealTipo === 'hierarchy20');
 *   - ROW VOLUME in ONE terms section: search_late_row_lookup pages at offset
 *     SEARCH_LATE_ROW_LOOKUP_OFFSET (default 1000) + 200 with limit 25 and
 *     asserts a non-empty page => >= 1,226 rows. The count here is DERIVED
 *     from the live config default at seed time (never a bare constant), so a
 *     raised default cannot silently starve the gate;
 *   - a TERM-TEXT DISTRIBUTION: >= 3 short names each with
 *     exact-unaccent-match count >= 1 AND contains-count strictly greater,
 *     contains corpus in the hundreds (search_string_equal_operator re-derives
 *     its ground truth in-test — the property is the distribution, not any
 *     country's toponymy);
 *   - record id 1 EXISTING in the terms section while user 0 holds no read
 *     grant on it (indexation_grid_tc_native's AUTHZ-05 premise) — the root
 *     term the activation itself mints;
 *   - 2–3 levels of depth for tree sanity (root -> probe branches -> leaves).
 *     NO consumer asserts ancestor chains against stored hierarchy rows, so
 *     depth is sanity, not load-bearing. No dates: the date gates ride the
 *     canonical matrix_test fixture. ONE data lang: no consumer asserts
 *     multilingual hierarchy terms (original_lang builds its own records).
 *
 * HOW IT IS BUILT — the engine's own doors, never a raw COPY:
 *   1. `activateHierarchy` (the installer's door) registers each TLD in the
 *      hierarchy1 registry, provisions the `<tld>0|1|2` ontology, registers
 *      the virtual sections over hierarchy20, flags them ACTIVE with FULL
 *      locators, and mints the root term (`<tld>1`/1) and model root
 *      (`<tld>2`/1) — the same convergence a real install runs.
 *   2. The term corpus goes through `insertMatrixRecordWithExplicitId`
 *      (matrix_write's explicit-id door: advisory-locked, counter-raising, the
 *      same door situations use), with the SAME column shapes the vendored
 *      imports carry — so the AFTER INSERT triggers derive
 *      matrix_relation_index / matrix_string_search rows exactly as for real
 *      data. Deterministic: names and parents are pure functions of the id (no
 *      Math.random — a non-deterministic fixture is not a fixture).
 *
 * ROW COUNTS (from the census, stated not guessed): hierarchy A
 * (`testgeoa1`) = max(1300, offset+300) rows — 1,300 at the shipped default,
 * >= 1,226 required by the paging arithmetic, margin on top; hierarchy B
 * (`testgeob1`) = 10 rows — existence and a distinct twin are all its
 * consumers need. Model twins hold ONLY the engine-minted model root at id 1;
 * ids 2..941000 stay free (the datalist gate seeds its own options at
 * 941001+). Grand total ~1,310 generated records where the imports carried
 * ~140,000.
 *
 * Idempotent (re-activation converges; the corpus is swept-above-root and
 * re-inserted) and tearable (`dropSyntheticHierarchies` mirrors the
 * install_hierarchy_activate_native sweep). Guarded: `assertTestDatabase`
 * before the first write, like every test-data writer.
 *
 * WHAT THIS DOES NOT PROVE. It cannot prove the migrated consumer gates hold
 * the same law they held against real data — each migration must re-derive its
 * ground truth against THIS corpus (the string-equality gate especially).
 * It does not exercise the `.copy.gz` IMPORT path (install_hierarchy_tools
 * owns that, against a vendored file in its own scratch database), and it does
 * not replace the LANGUAGES thesaurus: that one is engine-hardwired
 * (select_lang, pinned ids in import gates) and stays a REAL import.
 */

import { config } from '../../config/config.ts';
import { deleteTldNodes } from '../db/dd_ontology.ts';
import { insertMatrixRecordWithExplicitId } from '../db/matrix_write.ts';
import { sql, withTransaction } from '../db/postgres.ts';
import { DedaloError } from '../errors/index.ts';
import { activateHierarchy } from '../install/hierarchy_activate.ts';
import { clearOntologyDerivedCaches } from '../ontology/cache_invalidation.ts';
import { deleteOntologyByTld } from '../ontology/ontology_delete.ts';
import { RELATION_TYPE_PARENT } from '../ontology/ontology_tipos.ts';
import { resolveRegistryLangId } from '../ontology/ontology_write.ts';
import { deleteSectionRecord } from '../section/record/delete_record.ts';
import { scratchHierarchyEntry } from './hierarchy_entry_fixture.ts';
import {
	SYNTHETIC_B_ROW_COUNT,
	SYNTHETIC_HIERARCHY_A_TLD,
	SYNTHETIC_HIERARCHY_B_TLD,
	SYNTHETIC_HIERARCHY_TLDS,
	SYNTHETIC_PROBE_TERMS,
	SYNTHETIC_VOLUME_FLOOR,
} from './synthetic_hierarchy_constants.ts';
import { assertTestDatabase } from './test_database_marker.ts';

const HIERARCHY_TABLE = 'matrix_hierarchy';
const HIERARCHY_MAIN_TABLE = 'matrix_hierarchy_main';
const HIERARCHY_REGISTRY_SECTION = 'hierarchy1';
/** hierarchy20's term component / parent component — what the imports carry. */
const TERM_COMPONENT = 'hierarchy25';
const PARENT_COMPONENT = 'hierarchy36';
/** The fixture writes as the system user, like the installer's activation. */
const USER_ID = -1;
/** Deterministic data stamp — a clock stamp would make two builds differ. */
const BUILD_DATE = '2026-08-25 00:00:00';

/** Typology 2 = toponymy — what the replaced geographic thesauri were, and the
 * typology the General Term roots are gated on (install_hierarchy_activate_native).
 * The manifest entries are built at run time (hierarchy_entry_fixture.ts): the
 * row's language is the installation's own lg-eng record, resolved — never an id. */
const HIERARCHY_NAMES = [
	{ tld: SYNTHETIC_HIERARCHY_A_TLD, name: 'Synthetic geography A' },
	{ tld: SYNTHETIC_HIERARCHY_B_TLD, name: 'Synthetic geography B' },
] as const;

function refuse(message: string, coordinates: Record<string, string | number> = {}): never {
	throw new DedaloError('internal.invariant', {
		message: `synthetic_hierarchy_fixture: ${message}`,
		coordinates,
	});
}

/**
 * Hierarchy A's total term rows, DERIVED from the live config default: the
 * paging gate reads offset `config.ops.searchLateRowLookupOffset` + 200 with
 * limit 25, so the corpus carries offset + 300 (>= the 1300 floor). A disabled
 * offset (-1) falls back to the floor — nothing pages then.
 */
export function syntheticHierarchyARowCount(): number {
	const offset = config.ops.searchLateRowLookupOffset;
	return Math.max(SYNTHETIC_VOLUME_FLOOR, (offset > 0 ? offset : 0) + 300);
}

/** One generated term row — a PURE function of section + id (determinism). */
interface GeneratedTerm {
	sectionId: number;
	name: string;
	parentId: number;
}

/**
 * Hierarchy A's corpus: id 1 is the activation-minted root; ids 2..4 are the
 * probe branches named EXACTLY the probe terms; ids 5..N are leaves under the
 * branch of their probe, each name CONTAINING its probe — which yields, per
 * probe, exact-match count 1 and a contains count in the hundreds
 * ((N-4)/3 + 1), the distribution search_string_equal_operator asserts on.
 */
function generatedTermA(sectionId: number): GeneratedTerm {
	const probeCount = SYNTHETIC_PROBE_TERMS.length; // 3
	if (sectionId >= 2 && sectionId < 2 + probeCount) {
		const probe = SYNTHETIC_PROBE_TERMS[sectionId - 2] as string;
		return { sectionId, name: probe, parentId: 1 };
	}
	const slot = (sectionId - 2 - probeCount) % probeCount;
	const probe = SYNTHETIC_PROBE_TERMS[slot] as string;
	// 'ville' shares no letter-pair with any probe, so a leaf contains exactly
	// its own probe and cross-contamination cannot skew a re-derived count.
	return { sectionId, name: `${probe}ville ${sectionId}`, parentId: 2 + slot };
}

/** Hierarchy B's corpus: 9 flat leaves under the root — existence only. */
function generatedTermB(sectionId: number): GeneratedTerm {
	// 'Flatland' contains none of the probe terms; B never joins a text census.
	return { sectionId, name: `Flatland ${sectionId}`, parentId: 1 };
}

/** Sweep every row above the root and re-insert the generated corpus. */
async function seedTermRows(
	sectionTipo: string,
	total: number,
	generate: (sectionId: number) => GeneratedTerm,
): Promise<void> {
	const dataLang = config.menu.dataLang;
	await withTransaction(async () => {
		// Above-root only: id 1 is the engine-minted root the registry's
		// hierarchy45 locator points at — deleting it would dangle the hierarchy.
		await sql.unsafe(
			`DELETE FROM "${HIERARCHY_TABLE}" WHERE section_tipo = $1 AND section_id > 1`,
			[sectionTipo],
		);
		for (let sectionId = 2; sectionId <= total; sectionId++) {
			const term = generate(sectionId);
			await insertMatrixRecordWithExplicitId(HIERARCHY_TABLE, sectionTipo, sectionId, {
				data: {
					section_id: sectionId,
					section_tipo: sectionTipo,
					created_date: BUILD_DATE,
					modified_date: BUILD_DATE,
					created_by_user_id: USER_ID,
				},
				string: {
					[TERM_COMPONENT]: [{ id: 1, lang: dataLang, value: term.name }],
				},
				relation: {
					[PARENT_COMPONENT]: [
						{
							id: 1,
							type: RELATION_TYPE_PARENT,
							// int-canonical (WC-2026-08-10-section-id-int-canonical)
							section_id: term.parentId,
							section_tipo: sectionTipo,
							from_component_tipo: PARENT_COMPONENT,
						},
					],
				},
			});
		}
	});
}

export interface SyntheticHierarchySummary {
	/** tld -> total rows now in its terms section (root included). */
	termRows: Record<string, number>;
	/** The data lang every generated term was written in. */
	dataLang: string;
}

/**
 * Build (or converge) both synthetic hierarchies. Idempotent: activation
 * converges, the corpus is swept-above-root and re-inserted at the same ids.
 */
export async function ensureSyntheticHierarchies(): Promise<SyntheticHierarchySummary> {
	// Before ANY write: the database itself must declare it is the suite's.
	await assertTestDatabase('ensureSyntheticHierarchies');

	const langSectionId = await resolveRegistryLangId('lg-eng');
	const metas = HIERARCHY_NAMES.map((item) =>
		scratchHierarchyEntry({ tld: item.tld, name: item.name, langSectionId }),
	);
	for (const meta of metas) {
		const outcome = await activateHierarchy(meta, USER_ID);
		if (!outcome.ok) {
			refuse(`activateHierarchy('${meta.tld}') did not converge: ${outcome.errors.join('; ')}`, {
				tld: meta.tld,
			});
		}
		// The AUTHZ-05 premise and the corpus anchor: the root term EXISTS at id 1.
		const root = (await sql.unsafe(
			`SELECT 1 FROM "${HIERARCHY_TABLE}" WHERE section_tipo = $1 AND section_id = 1`,
			[`${meta.tld}1`],
		)) as unknown[];
		if (root.length === 0) {
			refuse(`activation left no root term at ${meta.tld}1/1 — the corpus has no anchor`, {
				tld: meta.tld,
			});
		}
	}

	const aTotal = syntheticHierarchyARowCount();
	await seedTermRows(`${SYNTHETIC_HIERARCHY_A_TLD}1`, aTotal, generatedTermA);
	await seedTermRows(`${SYNTHETIC_HIERARCHY_B_TLD}1`, SYNTHETIC_B_ROW_COUNT, generatedTermB);

	return {
		termRows: {
			[SYNTHETIC_HIERARCHY_A_TLD]: aTotal,
			[SYNTHETIC_HIERARCHY_B_TLD]: SYNTHETIC_B_ROW_COUNT,
		},
		dataLang: config.menu.dataLang,
	};
}

/**
 * Tear both hierarchies down completely — ontology, node records, registry
 * rows, term corpus, audit tail, counters (the install_hierarchy_activate
 * sweep, per TLD). Safe on a database where they were never built.
 */
export async function dropSyntheticHierarchies(): Promise<void> {
	await assertTestDatabase('dropSyntheticHierarchies');
	for (const tld of SYNTHETIC_HIERARCHY_TLDS) {
		// Ontology + the matrix_ontology node records, through the delete driver;
		// then the TLD-scoped dd_ontology door (the T3 ratchet forbids a direct
		// dd_ontology DELETE here — deleteTldNodes is the one sanctioned sweep).
		await deleteOntologyByTld(tld, (st, sid) => deleteSectionRecord(st, sid, USER_ID));
		await deleteTldNodes(tld);
		// The hierarchy1 registry row(s) for this tld, remembering their ids for
		// the audit sweep below.
		const registry = (await sql.unsafe(
			`SELECT section_id FROM "${HIERARCHY_MAIN_TABLE}" WHERE section_tipo = $1
			   AND lower(string->'hierarchy6'->0->>'value') = $2`,
			[HIERARCHY_REGISTRY_SECTION, tld],
		)) as { section_id: number }[];
		await sql.unsafe(
			`DELETE FROM "${HIERARCHY_MAIN_TABLE}" WHERE section_tipo = $1
			   AND lower(string->'hierarchy6'->0->>'value') = $2`,
			[HIERARCHY_REGISTRY_SECTION, tld],
		);
		// The corpus + the twins' rows, the audit tail, the counters.
		await sql.unsafe(`DELETE FROM "${HIERARCHY_TABLE}" WHERE section_tipo IN ($1, $2)`, [
			`${tld}1`,
			`${tld}2`,
		]);
		await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo IN ($1, $2, $3)', [
			`${tld}0`,
			`${tld}1`,
			`${tld}2`,
		]);
		for (const row of registry) {
			await sql.unsafe(
				'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
				[HIERARCHY_REGISTRY_SECTION, Number(row.section_id)],
			);
		}
		await sql.unsafe('DELETE FROM matrix_counter WHERE tipo IN ($1, $2)', [`${tld}1`, `${tld}2`]);
	}
	await clearOntologyDerivedCaches();
}
