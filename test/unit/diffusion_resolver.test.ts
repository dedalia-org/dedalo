/**
 * Resolver gates (DIFFUSION_PLAN D3-P1) against a BUILT GENERIC diffusion
 * domain and BUILT records (test/helpers/zzdif_diffusion_domain.ts — reserved
 * `zzdif` TLD, provisioned in beforeAll, dropped with residue asserted 0).
 *
 * WAS INSTALL-BOUND until 2026-08-20: element `numisdata29`, section
 * `numisdata6` (37 sections), with the publishable / unpublishable subjects
 * DISCOVERED by scanning live `component_publication` values in the ambient
 * `matrix`. That made the suite green on one machine and red everywhere else —
 * measured red on this checkout ("'numisdata29' is not a diffusion element of
 * domain 'mht'"). Nothing is discovered now: the section, its
 * component_publication, the portal that feeds the frontier and the four
 * records are all DECLARED by the fixture, so each assertion is exact.
 *
 * WHAT THE DISCOVERY BECAME. The scan was not install DATA worth keeping (no
 * fixture JSON): it was a search for a shape the fixture now states outright.
 * The one thing it did prove — that the section's ontology really carries a
 * component_publication the engine finds — is kept as an explicit assertion
 * over the BUILT section (see beforeAll), so the gate still refuses to run
 * against a section whose publication component the engine cannot resolve.
 *
 * WRITE SURFACE: the `zzdif` situation only (dd_ontology rows under a reserved
 * scratch TLD + matrix_test records) — the installation's `matrix` is never
 * touched.
 *
 * THE GUARANTEES under test:
 * - a record resolves END TO END: plan compile → selection → chain walk
 *   (portals, custom fns, rewriter steps) → transform → lang ladder →
 *   non-empty ProjectedRows carrying exactly the plan's column set;
 * - the publication gate is honored fail-closed: a dd64/no record yields
 *   status 'unpublish' + an unpublishIds entry and NO rows, while
 *   skipPublicationStateCheck (PHP skip_publication_state_check) publishes it;
 * - the breadth-first frontier respects the levels budget: maxLevels 0 →
 *   primaries only; maxLevels 1 → linked plan-section batches at level 0;
 *   per-run dedup — no (section_tipo, section_id) is ever emitted twice;
 * - determinism: two identical runs produce deep-equal rows/records
 *   (runStartedAt is an option, never Date.now() — resume equivalence);
 * - cursor semantics: primary batches carry their keyset checkpoint, frontier
 *   batches repeat the final primary cursor.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { getChildrenNodes } from '../../src/core/ontology/resolver.ts';
import { compileElementPlan } from '../../src/diffusion/plan/compile.ts';
import type { PublicationPlan } from '../../src/diffusion/plan/types.ts';
import type { VirtualDiffusionTree } from '../../src/diffusion/plan/virtual_tree.ts';
import { buildVirtualDiffusionTree } from '../../src/diffusion/plan/virtual_tree.ts';
import type { ResolvedBatch, ResolveOptions } from '../../src/diffusion/resolve/resolver.ts';
import { resolvePublication } from '../../src/diffusion/resolve/resolver.ts';
import {
	dropZzdifDomain,
	ensureZzdifDomain,
	ZZDIF_DOMAIN_NAME,
	ZZDIF_ELEMENT,
	ZZDIF_LINKED_IDS,
	ZZDIF_LINKED_SECTION,
	ZZDIF_PUBLISHABLE_ID,
	ZZDIF_SECTION,
	ZZDIF_UNPUBLISHABLE_ID,
} from '../helpers/zzdif_diffusion_domain.ts';

/** The known-good sql element of the built domain (diffusion_plan_compile gate). */
const ELEMENT_TIPO = ZZDIF_ELEMENT;
/** Primary section under test: a portal hop, a rewriter step, a number column. */
const SECTION_TIPO = ZZDIF_SECTION;
/** Deterministic run timestamp (epoch seconds) — REUSED across runs. */
const RUN_STARTED_AT = 1_751_700_000;

let tree: VirtualDiffusionTree;
let plan: PublicationPlan;
let publishableId: number;
let unpublishableId: number;

/** Collect every batch of one resolution run. */
async function runResolution(overrides: Partial<ResolveOptions>): Promise<ResolvedBatch[]> {
	const batches: ResolvedBatch[] = [];
	const generator = resolvePublication(plan, {
		sectionTipo: SECTION_TIPO,
		runStartedAt: RUN_STARTED_AT,
		tree,
		...overrides,
	});
	for await (const batch of generator) batches.push(batch);
	return batches;
}

/** Options that resolve exactly ONE primary record. */
function singleRecordOptions(sectionId: number, maxLevels: number): Partial<ResolveOptions> {
	return {
		sqo: {
			section_tipo: SECTION_TIPO,
			filter_by_locators: [{ section_tipo: SECTION_TIPO, section_id: String(sectionId) }],
		},
		maxLevels,
	};
}

beforeAll(async () => {
	await ensureZzdifDomain();
	const built = await buildVirtualDiffusionTree(ZZDIF_DOMAIN_NAME);
	if (built === null) {
		throw new Error(
			`the zzdif situation was ensured but no dd1190 domain node is named '${ZZDIF_DOMAIN_NAME}'`,
		);
	}
	tree = built;
	plan = await compileElementPlan(ELEMENT_TIPO, { tree });

	// The gate refuses to run against a section whose component_publication the
	// ONTOLOGY does not carry — the one thing the old live-matrix scan proved,
	// kept as an assertion over the BUILT ontology instead of a search. (The
	// engine's own lookup, resolver.ts publicationTipoOf, is module-private; it
	// is exercised for real by the publication-gate describe below, which can
	// only produce 'unpublish' if the engine found this component.)
	const publicationTipo =
		(await getChildrenNodes(SECTION_TIPO)).find((child) => child.model === 'component_publication')
			?.tipo ?? null;
	if (publicationTipo === null) {
		throw new Error(`section ${SECTION_TIPO} has no component_publication in the built ontology`);
	}
	// DECLARED, not discovered: the fixture writes dd64/yes on one record and
	// dd64/no on the other.
	publishableId = ZZDIF_PUBLISHABLE_ID;
	unpublishableId = ZZDIF_UNPUBLISHABLE_ID;
});

afterAll(async () => {
	// Hermeticity is ASSERTED, not trusted: dropSituation returns the residue.
	expect(await dropZzdifDomain()).toBe(0);
});

describe('end-to-end resolution of one real record', () => {
	let batches: ResolvedBatch[];

	beforeAll(async () => {
		batches = await runResolution(singleRecordOptions(publishableId, 1));
	});

	test('the primary batch resolves to non-empty ProjectedRows', () => {
		const [primary] = batches;
		if (primary === undefined) throw new Error('no batch yielded');
		expect(primary.section.sectionTipo).toBe(SECTION_TIPO);
		expect(primary.records).toHaveLength(1);
		expect(primary.records[0]?.status).toBe('publish');
		expect(primary.unpublishIds).toEqual([]);
		// one row per configured lang
		expect(primary.rows.length).toBe(plan.langPolicy.langs.length);
		expect(primary.rows[0]?.lang).toBe(plan.langPolicy.langs[0] as string);
		expect(primary.rows[0]?.sectionId).toBe(publishableId);
	}, 120_000);

	test('rows carry EXACTLY the plan column set, with real values resolved', () => {
		const sectionPlan = plan.sections.find((section) => section.sectionTipo === SECTION_TIPO);
		if (sectionPlan === undefined) throw new Error('no primary SectionPlan');
		const expectedColumns = sectionPlan.fields
			.filter((field) => field.excludeColumn !== true)
			.map((field) => field.columnName)
			.sort();
		const row = batches[0]?.rows[0];
		if (row === undefined) throw new Error('no primary row');
		expect(Object.keys(row.columns).sort()).toEqual(expectedColumns);
		const nonNull = Object.values(row.columns).filter((value) => value !== null);
		expect(nonNull.length).toBeGreaterThanOrEqual(5);
	});

	test('the RecordIR keeps typed per-field values (stage D output)', () => {
		const record = batches[0]?.records[0];
		if (record === undefined) throw new Error('no RecordIR');
		expect(record.sectionTipo).toBe(SECTION_TIPO);
		expect(record.fields.size).toBeGreaterThan(0);
		let resolvedValues = 0;
		for (const field of record.fields.values()) resolvedValues += field.values.length;
		expect(resolvedValues).toBeGreaterThan(0);
	});

	test('field errors are COLLECTED, never silent wrong values', () => {
		// Any remaining unported ddo fn must surface as a named per-field
		// error, and the affected column stays empty. (get_geojson_data,
		// get_geolocation_data, map_target_section_tipo, parse_tag_to_html and
		// get_diffusion_iconography are PORTED — they no longer ledger.)
		// This shape loop is vacuous when the live plan carries no unported fn
		// (batch.errors is empty) — the NON-vacuous fail-loud coverage is the
		// unknown-fn injection test below.
		for (const batch of batches) {
			for (const error of batch.errors) {
				expect(error.fieldId.length).toBeGreaterThan(0);
				expect(error.message).toContain('ledgered');
			}
		}
	});

	test('an UNKNOWN parser fn fails LOUD: named batch error + empty column, never silent green', async () => {
		// The fn-registry contract (dd1190 v7 properties are evolvable): an
		// unknown FUTURE fn lands via the parser registry, and until it does the
		// resolve path must surface a NAMED per-field error while leaving the
		// column empty — never a silently-skipped step with a green run.
		const sectionPlan = plan.sections.find((section) => section.sectionTipo === SECTION_TIPO);
		if (sectionPlan === undefined) throw new Error('no primary SectionPlan');
		const baselineRow = batches[0]?.rows[0];
		if (baselineRow === undefined) throw new Error('no baseline primary row');
		// Victim: a column that RESOLVES a real value for this record (so the
		// transform actually runs) and whose field carries no compile warnings
		// (prepareFields recovers warned fields' steps from the ontology, which
		// would override the injection).
		const victim = sectionPlan.fields.find(
			(field) =>
				field.excludeColumn !== true &&
				baselineRow.columns[field.columnName] != null &&
				!plan.warnings.some((warning) => warning.endsWith(`@${field.id}`)),
		);
		if (victim === undefined) throw new Error('no resolvable warning-free field to inject into');

		const evilPlan = structuredClone(plan);
		const evilField = evilPlan.sections
			.find((section) => section.sectionTipo === SECTION_TIPO)
			?.fields.find((field) => field.id === victim.id);
		if (evilField === undefined) throw new Error('victim field lost in clone');
		evilField.transform = [{ fn: 'parser_future::thing', options: {} }];

		const evilBatches: ResolvedBatch[] = [];
		const generator = resolvePublication(evilPlan, {
			sectionTipo: SECTION_TIPO,
			runStartedAt: RUN_STARTED_AT,
			tree,
			...singleRecordOptions(publishableId, 0),
		});
		for await (const batch of generator) evilBatches.push(batch);

		const [primary] = evilBatches;
		if (primary === undefined) throw new Error('no batch yielded');
		// PINNED contract: the error is COLLECTED on the batch (the run itself
		// does not abort — other columns of the record still publish)…
		const named = primary.errors.filter((error) => error.fieldId === victim.id);
		expect(named.length).toBe(1);
		// …it NAMES the missing fn and the affected column…
		expect(named[0]?.message).toContain('parser_future::thing');
		expect(named[0]?.columnName).toBe(victim.columnName);
		// …and the column lands EMPTY — a value here would be a silent wrong value.
		expect(primary.rows[0]?.columns[victim.columnName] ?? null).toBeNull();
		// The record still resolved (fail-loud is per-field, not run-fatal).
		expect(primary.records[0]?.status).toBe('publish');
	}, 120_000);
});

describe('publication gate (fail-closed, PHP is_publishable semantics)', () => {
	test('a dd64/no record resolves to unpublish with NO rows', async () => {
		const batches = await runResolution(singleRecordOptions(unpublishableId, 0));
		const [primary] = batches;
		if (primary === undefined) throw new Error('no batch yielded');
		expect(primary.records[0]?.status).toBe('unpublish');
		expect(primary.unpublishIds).toEqual([unpublishableId]);
		expect(primary.rows).toEqual([]);
	}, 120_000);

	test('skipPublicationStateCheck bypasses the gate (PHP option twin)', async () => {
		const batches = await runResolution({
			...singleRecordOptions(unpublishableId, 0),
			skipPublicationStateCheck: true,
		});
		const [primary] = batches;
		expect(primary?.records[0]?.status).toBe('publish');
		expect(primary?.unpublishIds).toEqual([]);
		expect(primary?.rows.length).toBeGreaterThan(0);
	}, 120_000);
});

describe('frontier: levels budget + per-run dedup', () => {
	test('maxLevels 0 → primaries only; maxLevels 1 → linked plan sections', async () => {
		const level0 = await runResolution(singleRecordOptions(publishableId, 0));
		expect(level0).toHaveLength(1);
		expect(level0[0]?.section.sectionTipo).toBe(SECTION_TIPO);
		expect(level0[0]?.primary).toBe(true);

		const level1 = await runResolution(singleRecordOptions(publishableId, 1));
		const linkedSections = new Set(level1.slice(1).map((batch) => batch.section.sectionTipo));
		expect(linkedSections.size).toBeGreaterThan(0);
		// the portal hop's target section is what the frontier queued
		expect(linkedSections.has(ZZDIF_LINKED_SECTION)).toBe(true);
		for (const batch of level1.slice(1)) {
			// every frontier batch belongs to a plan section, one level down
			expect(plan.sections.some((s) => s.sectionTipo === batch.section.sectionTipo)).toBe(true);
			expect(batch.level).toBe(0);
			// the runner's progress counter keys on this, never on the section
			// tipo: a self-linked section drains frontier batches of its own tipo
			expect(batch.primary).toBe(false);
		}
		expect(level1[0]?.primary).toBe(true);
	}, 240_000);

	test('no (section_tipo, section_id) is emitted twice in one run', async () => {
		const batches = await runResolution(singleRecordOptions(publishableId, 1));
		const seen = new Set<string>();
		for (const batch of batches) {
			for (const record of batch.records) {
				const key = `${record.sectionTipo}:${record.sectionId}`;
				expect(seen.has(key)).toBe(false);
				seen.add(key);
			}
		}
		expect(seen.size).toBeGreaterThan(1);
		// non-vacuity: the primary AND both linked records were emitted, once each
		expect(seen).toEqual(
			new Set([
				`${SECTION_TIPO}:${publishableId}`,
				...ZZDIF_LINKED_IDS.map((id) => `${ZZDIF_LINKED_SECTION}:${id}`),
			]),
		);
	}, 240_000);

	test('cursor semantics: primary checkpoint, repeated by frontier batches', async () => {
		const batches = await runResolution(singleRecordOptions(publishableId, 1));
		expect(batches[0]?.cursor).toBe(publishableId);
		for (const batch of batches.slice(1)) {
			expect(batch.cursor).toBe(publishableId);
		}
	}, 240_000);
});

describe('determinism (parity + resume both depend on it)', () => {
	test('two identical runs produce deep-equal outputs', async () => {
		const serialize = (batches: ResolvedBatch[]): unknown =>
			JSON.parse(
				JSON.stringify(
					batches.map((batch) => ({
						section: batch.section.sectionTipo,
						level: batch.level,
						cursor: batch.cursor,
						rows: batch.rows,
						unpublishIds: batch.unpublishIds,
						records: batch.records.map((record) => ({
							sectionTipo: record.sectionTipo,
							sectionId: record.sectionId,
							status: record.status,
							fields: [...record.fields.entries()],
						})),
						errors: batch.errors,
					})),
				),
			);

		const first = serialize(await runResolution(singleRecordOptions(publishableId, 1)));
		const second = serialize(await runResolution(singleRecordOptions(publishableId, 1)));
		expect(second).toEqual(first);
	}, 480_000);
});
