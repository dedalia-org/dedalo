/**
 * A `<tld>0` ROOT IS THE PROJECTION OF ITS REGISTRY ROW, and a grouper tld's registry row is
 * the MASTER'S definition — TS-native contract (ONT follow-up 2026-10-21, residuals c + d of
 * ONT-1/2/3, audit 2026-09-26).
 *
 * (c) inspectOntology compared the stored rows with the parse of the tld's records, and asked
 *     of the root only whether it EXISTED. But `<tld>0` is not parsed: it is derived from the
 *     registry row, hung under `ontologytype<hierarchy9>` (15 when the row states none). A root
 *     under another grouper — the class createParentGrouper produced when it re-hung
 *     `hierarchytype0` under `ontologytype14` while its row said 2 — read as IN SYNC, and every
 *     guard built on inspect (ontology_derive_packages_native G1h's beforeEach) was blind to it.
 *       C1 a root under the wrong grouper is `stale` `['parent']` drift, not in sync; the
 *          rebuild re-derives it under the registry typology and converges;
 *       C2 control: a root under its registry typology is in sync;
 *       C3 a tld with NO registry row is not compared (nothing derives its root);
 *       C4 a row stating no typology derives `ontologytype15` — same rule as the rebuild.
 * (d) The typology GROUPER tlds `hierarchytype` / `hierarchymtype` are not core and no ontology
 *     declares them, so a default ACTIVE_ONTOLOGY_TLDS never imports them: the engine REGISTERS
 *     them on demand (createParentGrouper, the first thesaurus provisioned). That registration
 *     invented Core 14 + generic labels where the master files both under typology 12, and no
 *     definition import ever corrected it. Now it takes the master's definition from the release
 *     this engine ships (release_definition.ts):
 *       D1 the real door, registering `hierarchymtype` afresh: registry typology + name = the
 *          release's, root under `ontologytype<that typology>`, the tld in sync (inspect agrees
 *          with C's rule);
 *       D2 a grouper tld the release does not define falls back to Core 14 + the generic labels;
 *       D3 PURE: the release parser reads what the vendored file states (read here
 *          independently), and grouperTldDefinition returns it for every grouper tld.
 *       D4 PURE: each half of the definition is the RELEASE'S when stated — the vendored grouper
 *          names equal the generic labels, so D1/D3 alone cannot tell a release name from the
 *          fallback: a synthetic release whose name differs can — and the fallback per half.
 *
 * Every DB leg runs inside ONE transaction that is ROLLED BACK (D1 deletes and re-mints the
 * suite's own `hierarchymtype` registration — never committed), so the scratch tld `zzorp` /
 * `zzorq` leave nothing behind by construction; zero residue is asserted after.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDdOntologyRow } from '../../src/core/db/dd_ontology.ts';
import { sql, withTransaction } from '../../src/core/db/postgres.ts';
import { VENDORED_ONTOLOGY_DIR } from '../../src/core/install/paths.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
// The registry names / root terms are LABELS: the label-fallback lang (the
// retired LABEL_LANG's label role, 2026-11-04).
import { ONTOLOGY_LABEL_FALLBACK_LANG as LABEL_LANG } from '../../src/core/ontology/labels.ts';
import {
	inspectOntology,
	type OntologyDriftItem,
	rebuildOntology,
} from '../../src/core/ontology/ontology_state.ts';
import {
	HIERARCHY_MODEL_TYPE_GROUP,
	HIERARCHY_MODEL_TYPE_TLD,
	HIERARCHY_TLD,
	HIERARCHY_TYPE_GROUP,
	HIERARCHY_TYPE_TLD,
	ONTOLOGY_MAIN_SECTION,
	ONTOLOGY_TYPE_TLD,
} from '../../src/core/ontology/ontology_tipos.ts';
import {
	createMainSection,
	createParentGrouper,
	getMainNameData,
	getMainTypologyId,
	grouperTldDefinition,
	grouperTldDefinitionFrom,
} from '../../src/core/ontology/ontology_write.ts';
import { releaseTldDefinitionFrom } from '../../src/core/ontology/release_definition.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';

const TLD = 'zzorp';
const ROOT = `${TLD}0`;
/** A grouper tld the release does not define (D2). */
const UNDEFINED_GROUPER = 'zzorq';
const USER_ID = -1;
/** Typology records these legs build UNDER a grouper — explicit, rolled back, never committed. */
const SCRATCH_TYPOLOGY = 942631;

const ROLLBACK = Symbol('rollback');

/**
 * Run `work` in a transaction that is always rolled back; caches cleared on both sides.
 * Returns what `work` measured inside it.
 */
async function rolledBack<T>(work: () => Promise<T>): Promise<T> {
	await assertTestDatabase('ontology_root_registry_native');
	await clearOntologyDerivedCaches();
	let measured: { value: T } | null = null;
	try {
		await withTransaction(async () => {
			measured = { value: await work() };
			throw ROLLBACK;
		});
	} catch (error) {
		if (error !== ROLLBACK) throw error;
	} finally {
		await clearOntologyDerivedCaches();
	}
	if (measured === null) throw new Error('rolledBack: the work did not complete');
	return (measured as { value: T }).value;
}

/** Plant `<tld>0` (the bootstrap shape) hung under `parent`. */
async function plantRoot(tld: string, parent: string): Promise<void> {
	await sql.unsafe(
		`INSERT INTO dd_ontology (tipo, parent, tld, model, model_tipo, is_main, relations, term)
		 VALUES ($1, $2, $3, 'section', 'dd6', true, $4::text::jsonb, $5::text::jsonb)`,
		[
			`${tld}0`,
			parent,
			tld,
			JSON.stringify([{ tipo: 'ontology1' }, { tipo: 'dd1201' }]),
			JSON.stringify({ [LABEL_LANG]: tld }),
		],
	);
	await clearOntologyDerivedCaches();
}

/** A registry row for `tld` (typology `typologyId`, or none stated when null). */
async function register(tld: string, typologyId: number | null): Promise<void> {
	await createMainSection(
		{
			tld,
			typology_id: typologyId,
			name_data: [{ lang: LABEL_LANG, value: `${tld} name` }],
		},
		USER_ID,
	);
	await clearOntologyDerivedCaches();
}

/** Registry rows naming `tld`. */
async function registryIds(tld: string): Promise<number[]> {
	const rows = (await sql.unsafe(
		`SELECT section_id FROM matrix_ontology_main
		  WHERE section_tipo = $1 AND string->$2 @> $3::text::jsonb`,
		[ONTOLOGY_MAIN_SECTION, HIERARCHY_TLD, JSON.stringify([{ value: tld }])],
	)) as { section_id: number }[];
	return rows.map((row) => Number(row.section_id));
}

/** The vendored release's own `active_ontologies` entry for `tld`, read independently. */
function vendoredEntry(tld: string): Record<string, unknown> | undefined {
	const parsed = JSON.parse(readFileSync(join(VENDORED_ONTOLOGY_DIR, 'ontology.json'), 'utf8')) as {
		active_ontologies: Record<string, unknown>[];
	};
	return parsed.active_ontologies.find((entry) => entry.tld === tld);
}

async function residue(): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT (SELECT count(*) FROM dd_ontology WHERE tld IN ($1, $2))
		      + (SELECT count(*) FROM matrix_ontology WHERE section_tipo IN ($3, $4)
		            OR (section_tipo IN ($5, $6) AND section_id = $7)) AS n`,
		[
			TLD,
			UNDEFINED_GROUPER,
			`${TLD}0`,
			`${UNDEFINED_GROUPER}0`,
			`${HIERARCHY_TYPE_TLD}0`,
			`${HIERARCHY_MODEL_TYPE_TLD}0`,
			SCRATCH_TYPOLOGY,
		],
	)) as { n: number | string }[];
	return Number(rows[0]?.n ?? -1);
}

afterAll(async () => {
	expect(await residue()).toBe(0);
	expect(await registryIds(TLD)).toEqual([]);
	expect(await registryIds(UNDEFINED_GROUPER)).toEqual([]);
	// The suite's own registration survived D1's rolled-back re-mint.
	expect((await registryIds(HIERARCHY_MODEL_TYPE_TLD)).length).toBe(1);
});

describe('(c) inspect compares the root with what its registry row derives', () => {
	const STALE_ROOT: OntologyDriftItem[] = [{ tipo: ROOT, kind: 'stale', diffColumns: ['parent'] }];

	test('C1 a root under the wrong grouper is stale parent drift; the rebuild re-hangs it and converges', async () => {
		const seen = await rolledBack(async () => {
			await register(TLD, 8);
			await plantRoot(TLD, `${ONTOLOGY_TYPE_TLD}14`);
			const before = await inspectOntology(TLD);
			const rebuilt = await rebuildOntology(TLD, USER_ID, { mainNode: 'existing' });
			const after = await inspectOntology(TLD);
			return {
				before: { mainNodeOk: before.mainNodeOk, drift: before.drift, inSync: before.inSync },
				rebuildErrors: rebuilt.errors,
				after: { drift: after.drift, inSync: after.inSync },
				parentAfter: (await readDdOntologyRow(ROOT))?.parent ?? null,
			};
		});
		expect(seen).toEqual({
			before: { mainNodeOk: true, drift: STALE_ROOT, inSync: false },
			rebuildErrors: [],
			after: { drift: [], inSync: true },
			parentAfter: `${ONTOLOGY_TYPE_TLD}8`,
		});
	});

	test('C2 control: a root under its registry typology is in sync', async () => {
		const state = await rolledBack(async () => {
			await register(TLD, 8);
			await plantRoot(TLD, `${ONTOLOGY_TYPE_TLD}8`);
			return inspectOntology(TLD);
		});
		expect({ drift: state.drift, inSync: state.inSync }).toEqual({ drift: [], inSync: true });
	});

	test('C3 a tld with no registry row: its root is not compared (nothing derives it)', async () => {
		const state = await rolledBack(async () => {
			expect(await registryIds(TLD)).toEqual([]);
			await plantRoot(TLD, `${ONTOLOGY_TYPE_TLD}14`);
			return inspectOntology(TLD);
		});
		expect({ drift: state.drift, inSync: state.inSync }).toEqual({ drift: [], inSync: true });
	});

	test('C4 a row stating no typology derives ontologytype15 (the rebuild rule)', async () => {
		const seen = await rolledBack(async () => {
			await register(TLD, null);
			const typology = await getMainTypologyId(TLD);
			await plantRoot(TLD, `${ONTOLOGY_TYPE_TLD}14`);
			const wrong = await inspectOntology(TLD);
			await sql.unsafe('UPDATE dd_ontology SET parent = $1 WHERE tipo = $2', [
				`${ONTOLOGY_TYPE_TLD}15`,
				ROOT,
			]);
			await clearOntologyDerivedCaches();
			const right = await inspectOntology(TLD);
			return { typology, wrong: wrong.drift, right: right.inSync };
		});
		expect(seen).toEqual({ typology: 15, wrong: STALE_ROOT, right: true });
	});
});

describe('(d) a grouper tld is registered with the master definition the release ships', () => {
	test('D3 the release parser reads what the vendored file states, for every grouper tld', async () => {
		for (const tld of [HIERARCHY_TYPE_TLD, HIERARCHY_MODEL_TYPE_TLD, ONTOLOGY_TYPE_TLD]) {
			const entry = vendoredEntry(tld);
			// Floor: the release really defines the grouper tld (else this proves nothing).
			expect(entry, tld).toBeDefined();
			const typologyId = Number((entry as Record<string, unknown>).typology_id);
			expect(typologyId).toBeGreaterThan(0);
			const parsed = releaseTldDefinitionFrom({ active_ontologies: [entry] }, tld);
			expect(parsed?.typologyId).toBe(typologyId);
			const definition = await grouperTldDefinition(tld);
			expect(definition.typology_id).toBe(typologyId);
			const spa = (entry as { name_data: { lang: string; value: string }[] }).name_data.find(
				(item) => item.lang === LABEL_LANG,
			);
			expect(definition.name_data?.find((item) => item.lang === LABEL_LANG)?.value).toBe(
				spa?.value,
			);
		}
		// Absent / malformed: no definition, never a guessed one.
		expect(releaseTldDefinitionFrom({ active_ontologies: [] }, HIERARCHY_TYPE_TLD)).toBeNull();
		expect(releaseTldDefinitionFrom(null, HIERARCHY_TYPE_TLD)).toBeNull();
		expect(
			releaseTldDefinitionFrom(
				{ active_ontologies: [{ tld: 'x', typology_id: 'nope', name_data: 'nope' }] },
				'x',
			),
		).toEqual({ typologyId: null, nameData: null });
	});

	test('D4 each half of a grouper definition is the release’s when it states it, the fallback only when it does not', () => {
		const releaseName = [{ lang: LABEL_LANG, value: 'zz release name | hierarchymtype' }];
		// Floor: the synthetic name is NOT the generic label (else this proves nothing).
		const fallback = grouperTldDefinitionFrom(HIERARCHY_MODEL_TYPE_TLD, null);
		expect(fallback.name_data).not.toEqual(releaseName);
		expect(fallback.typology_id).toBe(14);
		expect(
			grouperTldDefinitionFrom(HIERARCHY_MODEL_TYPE_TLD, { typologyId: 77, nameData: releaseName }),
		).toEqual({ tld: HIERARCHY_MODEL_TYPE_TLD, typology_id: 77, name_data: releaseName });
		// One half stated, the other not: each falls back on its own.
		expect(
			grouperTldDefinitionFrom(HIERARCHY_MODEL_TYPE_TLD, {
				typologyId: null,
				nameData: releaseName,
			}),
		).toEqual({ tld: HIERARCHY_MODEL_TYPE_TLD, typology_id: 14, name_data: releaseName });
		expect(
			grouperTldDefinitionFrom(HIERARCHY_MODEL_TYPE_TLD, { typologyId: 77, nameData: null }),
		).toEqual({ tld: HIERARCHY_MODEL_TYPE_TLD, typology_id: 77, name_data: fallback.name_data });
	});

	test('D1 registering hierarchymtype afresh files it where the master does: row typology + name, root parent, in sync', async () => {
		const entry = vendoredEntry(HIERARCHY_MODEL_TYPE_TLD) as Record<string, unknown>;
		const releaseTypology = Number(entry.typology_id);
		const releaseName = (entry.name_data as { lang: string; value: string }[]).find(
			(item) => item.lang === LABEL_LANG,
		)?.value;
		const seen: Record<string, unknown> = {};
		await rolledBack(async () => {
			// The situation: an installation that never registered the grouper tld.
			const ids = await registryIds(HIERARCHY_MODEL_TYPE_TLD);
			expect(ids.length).toBe(1);
			await sql.unsafe(
				'DELETE FROM matrix_ontology_main WHERE section_tipo = $1 AND section_id = $2',
				[ONTOLOGY_MAIN_SECTION, ids[0]],
			);
			await sql.unsafe('DELETE FROM dd_ontology WHERE tipo = $1', [`${HIERARCHY_MODEL_TYPE_TLD}0`]);
			await clearOntologyDerivedCaches();

			// What hierarchy provisioning calls (register: true by default).
			await createParentGrouper(
				HIERARCHY_MODEL_TYPE_GROUP,
				HIERARCHY_MODEL_TYPE_TLD,
				SCRATCH_TYPOLOGY,
				USER_ID,
			);
			await clearOntologyDerivedCaches();
			seen.registryTypology = await getMainTypologyId(HIERARCHY_MODEL_TYPE_TLD);
			seen.registryName = (await getMainNameData(HIERARCHY_MODEL_TYPE_TLD))?.find(
				(item) => item.lang === LABEL_LANG,
			)?.value;
			const root = await readDdOntologyRow(`${HIERARCHY_MODEL_TYPE_TLD}0`);
			seen.rootParent = root?.parent ?? null;
			seen.rootTerm = (root?.term as Record<string, unknown> | null)?.[LABEL_LANG] ?? null;
			const state = await inspectOntology(HIERARCHY_MODEL_TYPE_TLD);
			seen.rootDrift = state.drift.filter((item) => item.tipo === `${HIERARCHY_MODEL_TYPE_TLD}0`);
		});
		expect(seen).toEqual({
			registryTypology: releaseTypology,
			registryName: releaseName,
			rootParent: `${ONTOLOGY_TYPE_TLD}${releaseTypology}`,
			rootTerm: releaseName,
			rootDrift: [],
		});
	});

	test('D2 a grouper tld the release does not define falls back to Core 14 and the generic labels', async () => {
		expect(vendoredEntry(UNDEFINED_GROUPER)).toBeUndefined();
		const seen: Record<string, unknown> = {};
		await rolledBack(async () => {
			await createParentGrouper(HIERARCHY_TYPE_GROUP, UNDEFINED_GROUPER, SCRATCH_TYPOLOGY, USER_ID);
			await clearOntologyDerivedCaches();
			seen.registryTypology = await getMainTypologyId(UNDEFINED_GROUPER);
			const root = await readDdOntologyRow(`${UNDEFINED_GROUPER}0`);
			seen.rootParent = root?.parent ?? null;
			seen.rootTerm = (root?.term as Record<string, unknown> | null)?.[LABEL_LANG] ?? null;
		});
		expect(seen).toEqual({
			registryTypology: 14,
			rootParent: `${ONTOLOGY_TYPE_TLD}14`,
			rootTerm: `Tipologías de jerarquía | ${UNDEFINED_GROUPER}`,
		});
	});
});
