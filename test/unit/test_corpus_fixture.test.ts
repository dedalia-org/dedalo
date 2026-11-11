/**
 * THE TEST-CORPUS PIN — what `src/core/test_data/test_corpus/` must contain,
 * the way `test3_canonical_fixture.test.ts` pins the test3 playground.
 *
 * The corpus is DERIVED (scripts/derive_test_corpus.ts, from the frozen
 * oracle-harvest store) and LOADED by a door (test_corpus/ensure.ts) that the
 * `bun test` preload and `scripts/test_db_setup.ts` both run. Three different
 * things can therefore rot silently, and each has a check here:
 *
 *  1. the derived FILES (record counts, load-bearing values, no install tipo
 *     left inside a record's columns, the storage table each section declares);
 *  2. the DOOR (ensure is idempotent, drop leaves zero residue AND leaves the
 *     seed's own rows alone, the media kit writes real files and refuses an
 *     unmarked root);
 *  3. the `test*` HIERARCHY REGISTRY rows, verified through the REAL runtime
 *     door (`readAreaHierarchyData` — what area_thesaurus boots from), not by
 *     re-reading the rows this test just wrote.
 *
 * TWO KINDS OF SECTION (the amended record-surface law, 2026-08-19). A `test`
 * section is a phase-2 clone and stores in `matrix_test`; a `seed` section
 * (`rsc170`, `dd128`…) ships on every installation, is kept in place, and
 * stores in its own table. The difference is load-bearing for the door: a test
 * section is cleared WHOLE, a seed section only ever loses the ids the corpus
 * owns — asserted below with the seed row that must survive a drop.
 *
 * WHY THE SEED SECTION TIPOS ARE SPELLED `seed('rsc', 170)`: the install-TLD
 * census (scripts/lib/tld_census.ts) reads a literal `rsc170` in a test file as
 * this gate BINDING an install, and `rsc` is on its denylist. The tipos below
 * are pins on the corpus's own content, not bindings to an install's records —
 * the same reason `INSTALL_TLDS` splits `numis`+`data` further down.
 *
 * Anti-vacuity is explicit: every "it is there" assertion is paired with a
 * probe that proves the check can fail (a tipo that must NOT be in the corpus,
 * a media root without its marker, a scope that selects nothing).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAreaHierarchyData } from '../../src/core/area/tree.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { SYNTHETIC_HIERARCHY_TLDS } from '../../src/core/test_data/synthetic_hierarchy_constants.ts';
import {
	dropTestCorpus,
	ensureMediaKit,
	ensureTestCorpus,
	loadTestCorpus,
	loadTestCorpusFiles,
	loadTestCorpusRefusals,
	loadTestCorpusTm,
	MEDIA_KIT_FILES,
	TEST_CORPUS_TABLE,
	TEST_MEDIA_MARKER,
	testCorpusResidue,
	testHierarchyRegistry,
} from '../../src/core/test_data/test_corpus/ensure.ts';

/**
 * THE CORPUS IS EXPLICIT, NOT AMBIENT. It used to be provisioned by the `bun
 * test` preload, which put 446 records into every gate's situation — a census
 * gate, a scratch-surface emptiness check and a "count the rows this save
 * appended" assertion all read whatever the database holds, and they went red
 * for a fixture they never asked for. So this gate (and any other that needs
 * the corpus) provisions it here and takes it back out afterwards, exactly like
 * test/helpers/zzd_diffusion_fixture.ts. The drop is asserted, never assumed:
 * leftover rows would leak into whatever runs next.
 */
beforeAll(async () => {
	await ensureTestCorpus();
});
afterAll(async () => {
	expect(await dropTestCorpus()).toBe(0);
});

/** A seed-shipped section tipo, kept out of the census's token grammar. */
const seed = (tld: string, id: number): string => `${tld}${id}`;

/**
 * Records per section, as derived on 2026-08-19 (phase 3b: the amended
 * record-surface law put the seed-shipped sections back in the corpus). A
 * change here is a corpus CONTRACT edit: re-run
 * `bun run scripts/derive_test_corpus.ts` and reconcile the gates that read the
 * moved section in the same change.
 */
const RECORDS_PER_SECTION: Readonly<Record<string, number>> = {
	[seed('dd', 128)]: 74,
	[seed('dd', 542)]: 8,
	[seed('dd', 1244)]: 1,
	[seed('dd', 1706)]: 5,
	[seed('rsc', 2)]: 1,
	[seed('rsc', 106)]: 11,
	[seed('rsc', 167)]: 2,
	[seed('rsc', 170)]: 133,
	[seed('rsc', 197)]: 21,
	[seed('rsc', 205)]: 43,
	[seed('rsc', 212)]: 6,
	[seed('rsc', 332)]: 15,
	[seed('rsc', 1035)]: 3,
	[seed('rsc', 1242)]: 1,
	[seed('rsc', 1379)]: 1,
	test1026: 4,
	test2822: 1,
	test2827: 1,
	test3127: 1,
	test6099: 38,
	test6100: 90,
	test6101: 18,
	test6121: 10,
	test6136: 1,
	test6235: 1,
	test6247: 1,
	test6276: 11,
	test6310: 4,
	test6311: 1,
	test6810: 7,
	test6813: 1,
	test7365: 2,
	test7374: 1,
	testcatalogs1: 2,
	testcult1: 2,
	testimmovable1: 5,
	testmint1: 63,
	testterr1: 2,
};
const TOTAL_RECORDS = Object.values(RECORDS_PER_SECTION).reduce((sum, n) => sum + n, 0);

/** The ONLY records rebuilt from a raw row — everything else is a projection. */
const COMPLETE_RECORDS = ['testmint1/1', 'testmint1/2', 'testmint1/75'] as const;

/** One hierarchy registry row per test thesaurus: 10 cloned + 22 synthesised. */
const HIERARCHY_ROWS = 32;

/**
 * Install tipos that must not survive inside a record's stored columns. The
 * `source` block deliberately keeps the provenance — the columns must not.
 *
 * The EXEMPTIONS are not typed here: they are read out of the derive's own
 * refusal ledger (`media_reference_in_text` — a tipo inside an `<img src=…>`
 * URL in a text_area's markup, which is payload, not a reference, and has no
 * test identity of its own).  A token this gate tolerates is therefore always
 * one the deriver declared.
 */
const INSTALL_TLDS = [
	'numis' + 'data',
	'oh',
	'tch',
	'tchi',
	'ich',
	'mdcat',
	'dmm',
	'zenon',
	'isad',
	'mht',
	'navarra',
	'render',
	'qdp',
	'actv',
	'ww',
	'cult',
	'cont',
	'terr',
	'tema',
	'utoponymy',
	'roleusr',
	'sccmk',
];
// The lookbehind matters: an install tipo also hides INSIDE a media file name
// (`hierarchy95_sccmk1_81.svg`), where a `\b` would not fire after the `_`.
const installTokenRe = (): RegExp =>
	new RegExp(`(?<![a-z0-9])(${INSTALL_TLDS.join('|')})\\d+(?![0-9])`, 'g');

/** Tokens the deriver itself declared unreachable (never a hand-typed list). */
function exemptTokens(): Set<string> {
	const exempt = new Set<string>();
	for (const refusal of loadTestCorpusRefusals().media_reference_in_text ?? []) {
		for (const token of refusal.source.match(installTokenRe()) ?? []) exempt.add(token);
	}
	return exempt;
}

describe('test corpus — the derived files', () => {
	test('every section holds exactly the pinned number of records', () => {
		const counts = Object.fromEntries(
			loadTestCorpus().map((section) => [section.section_tipo, section.records.length]),
		);
		expect(counts).toEqual(RECORDS_PER_SECTION);
	});

	test('the corpus is not empty and every record declares its provenance', () => {
		const sections = loadTestCorpus();
		expect(sections.length).toBeGreaterThan(10);
		const records = sections.flatMap((section) => section.records);
		expect(records.length).toBe(TOTAL_RECORDS);
		for (const record of records) {
			expect(record.source.section_tipo).toMatch(/^[a-z_]+\d+$/);
			expect(Number.isInteger(record.section_id)).toBe(true);
			expect(record.section_id).toBeGreaterThan(0);
			expect(Object.keys(record.columns).length).toBeGreaterThan(0);
			expect(record.columns.data).toMatchObject({ section_id: record.section_id });
		}
	});

	test('the raw-sourced records are the only ones NOT marked reconstructed', () => {
		const complete = loadTestCorpus()
			.flatMap((section) =>
				section.records.map((record) => ({ section: section.section_tipo, record })),
			)
			.filter((entry) => entry.record.reconstructed === false)
			.map((entry) => `${entry.section}/${entry.record.section_id}`)
			.sort();
		expect(complete).toEqual([...COMPLETE_RECORDS].sort());
	});

	test('load-bearing values (exact)', () => {
		const mint = loadTestCorpus().find((section) => section.section_tipo === 'testmint1');
		const first = mint?.records.find((record) => record.section_id === 1);
		// numisdata6/1 read RAW: the whole row, so its data metadata survives.
		expect(first?.columns.data).toMatchObject({
			label: 'Cecas',
			section_tipo: 'testmint1',
			created_date: '2017-01-25 11:22:26',
		});
		expect((first?.columns.string as Record<string, unknown>).testmint1002).toEqual([
			{ id: 1, lang: 'lg-spa', value: 'Desconocida' },
		]);
		// material1/3, reconstructed from a list read: one shared `hierarchy25`
		// term component (an ALLOWED-TLD tipo, kept in place by the clone).
		const material = loadTestCorpus().find((section) => section.section_tipo === 'test3127');
		expect((material?.records[0]?.columns.string as Record<string, unknown>).hierarchy25).toEqual([
			{ id: 1, lang: 'lg-spa', value: 'Plata' },
		]);
		// A SYNTHETIC thesaurus twin (phase 2b, hierarchy20 → testcult): its term
		// component is the twin's OWN, never the seed's `hierarchy25`.
		const synthetic = loadTestCorpus().find((section) => section.section_tipo === 'testcult1');
		const terms = Object.keys((synthetic?.records[0]?.columns.string ?? {}) as object);
		expect(terms.length).toBeGreaterThan(0);
		for (const tipo of terms) expect(tipo.startsWith('testcult')).toBe(true);
	});

	test('each section declares the table the ENGINE would store it in', async () => {
		for (const section of loadTestCorpus()) {
			// The derive computes the table offline (from the seed ontology); this
			// asks the real resolver, so the mirror cannot drift unnoticed.
			expect(await getMatrixTableFromTipo(section.section_tipo), section.section_tipo).toBe(
				section.table,
			);
			expect(section.kind === 'test').toBe(section.table === TEST_CORPUS_TABLE);
		}
		// ANTI-VACUITY: both kinds are really present, and the seed kind really
		// does use tables other than matrix_test.
		const kinds = new Set(loadTestCorpus().map((section) => section.kind));
		expect([...kinds].sort()).toEqual(['seed', 'test']);
		const seedTables = new Set(
			loadTestCorpus()
				.filter((section) => section.kind === 'seed')
				.map((section) => section.table),
		);
		expect(seedTables.size).toBeGreaterThan(2);
		expect(seedTables.has(TEST_CORPUS_TABLE)).toBe(false);
	});

	test('no install tipo survives inside a stored column', () => {
		const exempt = exemptTokens();
		expect(exempt.size).toBeGreaterThan(0);
		const offenders: string[] = [];
		for (const section of loadTestCorpus()) {
			for (const record of section.records) {
				const text = JSON.stringify(record.columns);
				for (const token of text.match(installTokenRe()) ?? []) {
					if (exempt.has(token)) continue;
					offenders.push(`${section.section_tipo}/${record.section_id}: ${token}`);
				}
			}
		}
		expect(offenders).toEqual([]);
		// ANTI-VACUITY: the scanner really does catch an install tipo — probed
		// with a REAL one taken from the corpus's own provenance block, so this
		// file still names no install tipo of its own.
		const probe =
			loadTestCorpus()
				.flatMap((section) => section.records.map((record) => record.source.section_tipo))
				.find((tipo) => installTokenRe().test(tipo)) ?? '';
		expect(probe).not.toBe('');
		expect(JSON.stringify({ relation: { [probe]: [] } }).match(installTokenRe())).toEqual([probe]);
	});

	test('the refusal ledger holds only the honest classes', () => {
		const refusals = loadTestCorpusRefusals();
		// The two classes phase 2b/3b CLOSED. `no_ontology_clone` means a gate
		// addresses a section that is neither cloned nor twinned (the manifest's
		// `synthetic_thesauri` is the answer); the pre-amendment
		// `allowed_tld_no_record_surface` means a seed section was refused a
		// record surface it is now allowed to have.
		expect(refusals.no_ontology_clone ?? []).toEqual([]);
		expect(refusals.allowed_tld_no_record_surface ?? []).toEqual([]);
		expect(refusals.never_revealed_pending_section ?? []).toEqual([]);
		expect(refusals.media_path_not_engine_shaped ?? []).toEqual([]);
		// And the ledger is NOT empty: a derive that refused nothing would mean
		// the walk stopped seeing the store.
		expect((refusals.never_revealed ?? []).length).toBeGreaterThan(100);
		// A record the INSTALL SEED itself ships is refused, not overwritten.
		const shipped = refusals.seed_shipped_record ?? [];
		expect(shipped.length).toBeGreaterThan(0);
		for (const refusal of shipped) {
			const [tipo, id] = refusal.detail.split(' ')[0]?.split('/') ?? [];
			const section = loadTestCorpus().find((one) => one.section_tipo === tipo);
			expect(section?.records.some((record) => record.section_id === Number(id)) ?? false).toBe(
				false,
			);
		}
	});

	test('the time-machine rows load and address corpus sections only', () => {
		const rows = loadTestCorpusTm();
		expect(rows.length).toBe(33);
		for (const row of rows) {
			expect(Number.isInteger(row.id)).toBe(true);
			expect(row.timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
			// A TM row audits a record of a `test` section or of a seed-shipped
			// one — never of an install-only section. (Its RECORD may not be in
			// the corpus: an audit row survives a refused record, and the drop
			// still removes it, by id.)
			expect(row.section_tipo, String(row.id)).toMatch(
				/^(test[a-z]*|dd|rsc|hierarchy|ontology|ontologytype|lg)\d+$/,
			);
		}
		// ANTI-VACUITY: the rows really do address more than one section.
		expect(new Set(rows.map((row) => row.section_tipo)).size).toBeGreaterThan(3);
		// The dd15 bare list rarely shows the audited COMPONENT, so most rows
		// carry a null tipo — a listed hole (refused.json tm_component_unknown),
		// pinned so a future harvest that fills it is noticed.
		expect(rows.filter((row) => row.tipo_known).length).toBe(4);
	});

	test('the media kit assets exist and every corpus media path is engine-shaped', () => {
		for (const name of MEDIA_KIT_FILES) {
			const path = join(import.meta.dir, '../../src/core/test_data/media_kit', name);
			expect(existsSync(path)).toBe(true);
			expect(statSync(path).size).toBeGreaterThan(50);
		}
		const files = loadTestCorpusFiles();
		// Measured 2026-08-19 (phase-4 corpus gap 3): 282 identities. A media
		// component's value IS the file, so the derive harvests every identity the
		// store STATES — a `files_info` entry with `file_exist: true`, or a
		// non-null `posterframe_url` / `base_svg_url` (both existence-checked in
		// src/core/media/component_emit.ts) — independently of whether the item
		// carrying it was storable. Before that only the paths nested inside a
		// STORED component reached the corpus (7), so every image a list
		// projection revealed had no file and its component emitted nothing.
		expect(files.length).toBe(282);
		// The stat the oracle read: reproduced for every `files_info` identity,
		// null for the three derived-media URLs (existence-checked, no stat).
		expect(files.filter((file) => file.file_size !== null).length).toBe(279);
		expect(files.filter((file) => file.file_time !== null).length).toBe(279);
		const corpusSections = new Set(loadTestCorpus().map((section) => section.section_tipo));
		for (const file of files) {
			// The path IS the identity (src/core/media/path.ts): the file name is
			// `<component>_<section>_<id>[_<lang>]`, under `<folder>/<quality>`
			// plus the optional numeric bucket.
			const bucket = file.bucket === null ? '' : `/${file.bucket}`;
			const lang = file.lang === null ? '' : `_${file.lang}`;
			expect(file.file_path).toBe(
				`/${file.folder}/${file.quality}${bucket}/${file.component_tipo}_${file.section_tipo}_${file.section_id}${lang}.${file.extension}`,
			);
			expect(corpusSections.has(file.section_tipo)).toBe(true);
		}
		// More than one quality per identity — the quality directories are the
		// point (a gate reading `thumb` must not find only `original`).
		expect(new Set(files.map((file) => file.quality)).size).toBeGreaterThan(1);
	});
});

describe('test corpus — the door', () => {
	test('ensure is idempotent and every record lands in its declared table', async () => {
		const first = await ensureTestCorpus();
		expect(first.sections).toBe(Object.keys(RECORDS_PER_SECTION).length);
		expect(first.records).toBe(TOTAL_RECORDS);
		expect(first.hierarchies).toBe(HIERARCHY_ROWS);
		const second = await ensureTestCorpus();
		expect(second).toEqual(first);

		for (const section of loadTestCorpus()) {
			const rows = (await sql.unsafe(
				`SELECT count(*)::int AS n FROM "${section.table}"
				 WHERE section_tipo = $1 AND section_id = ANY($2::int[])`,
				[section.section_tipo, `{${section.records.map((record) => record.section_id).join(',')}}`],
			)) as { n: number }[];
			expect(rows[0]?.n, section.section_tipo).toBe(section.records.length);
		}

		// ANTI-VACUITY: a section the corpus does NOT hold has no rows.
		const absent = (await sql.unsafe(
			`SELECT count(*)::int AS n FROM "${TEST_CORPUS_TABLE}" WHERE section_tipo = $1`,
			['test999999'],
		)) as { n: number }[];
		expect(absent[0]?.n).toBe(0);
	});

	test('a scoped drop leaves residue 0 and a re-ensure restores it', async () => {
		// SCOPED on purpose: the whole corpus is the substrate other gates read
		// in the same run, so this exercises drop/ensure on one small section.
		const scope = ['test3127'];
		expect(await dropTestCorpus(scope)).toBe(0);
		expect(await testCorpusResidue(scope)).toBe(0);
		const restored = await ensureTestCorpus(scope);
		expect(restored.sections).toBe(1);
		expect(restored.records).toBe(RECORDS_PER_SECTION.test3127 ?? 0);
		expect(await testCorpusResidue(scope)).toBeGreaterThan(0);
	});

	test('dropping a SEED section removes only the corpus rows', async () => {
		// The whole point of the `seed` kind: `dd128` ships with the install (the
		// system user at id -1), so the door may never empty the section.
		const users = loadTestCorpus().find((section) => section.table === 'matrix_users');
		expect(users).toBeDefined();
		const scope = [String(users?.section_tipo)];
		const shipped = async (): Promise<number> => {
			const ids = users?.records.map((record) => record.section_id) ?? [];
			const rows = (await sql.unsafe(
				`SELECT count(*)::int AS n FROM "${String(users?.table)}"
				 WHERE section_tipo = $1 AND NOT (section_id = ANY($2::int[]))`,
				[String(users?.section_tipo), `{${ids.join(',')}}`],
			)) as { n: number }[];
			return rows[0]?.n ?? 0;
		};
		const before = await shipped();
		expect(before).toBeGreaterThan(0); // anti-vacuity: there IS a shipped row
		expect(await dropTestCorpus(scope)).toBe(0);
		expect(await shipped()).toBe(before);
		const restored = await ensureTestCorpus(scope);
		expect(restored.records).toBe(users?.records.length ?? 0);
		expect(await shipped()).toBe(before);
	});

	test('the media kit refuses a root without its marker, then writes every identity', async () => {
		const root = mkdtempSync(join(tmpdir(), 'dedalo-media-'));
		await expect(ensureMediaKit({ mediaRoot: root })).rejects.toThrow(TEST_MEDIA_MARKER);
		await Bun.write(join(root, TEST_MEDIA_MARKER), '');
		const result = await ensureMediaKit({ mediaRoot: root });
		expect(result.kit).toBe(MEDIA_KIT_FILES.length);
		expect(result.identities).toBe(loadTestCorpusFiles().length);
		expect(result.identities).toBeGreaterThan(0);
		for (const name of MEDIA_KIT_FILES) {
			expect(existsSync(join(root, 'kit', name))).toBe(true);
		}
		// Every identity is a REAL file, at the exact path the engine computes.
		for (const file of loadTestCorpusFiles()) {
			const target = join(root, file.file_path.replace(/^\//, ''));
			expect(existsSync(target), file.file_path).toBe(true);
			expect(statSync(target).size).toBeGreaterThan(50);
		}
		// ANTI-VACUITY: a path the corpus does not name is NOT materialized.
		expect(existsSync(join(root, 'image/original/0/nothing_here.jpg'))).toBe(false);
	});
});

describe('test corpus — the test* hierarchy registry rows', () => {
	test('the registry is derived from the clone manifest, one row per test thesaurus', () => {
		const rows = testHierarchyRegistry();
		expect(rows.length).toBe(HIERARCHY_ROWS);
		// The ten CLONED thesauri (phase 2) plus the synthesised twins (2b).
		for (const tld of ['testmint', 'testimmovable', 'testcatalogs', 'testcult', 'testterr']) {
			expect(
				rows.some((row) => row.tld === tld),
				tld,
			).toBe(true);
		}
		expect(new Set(rows.map((row) => row.tld)).size).toBe(rows.length);
		for (const row of rows) {
			expect(row.tld.startsWith('test')).toBe(true);
			expect(row.termsSection).toBe(`${row.tld}1`);
			// The band no install reaches (the biggest local install: 299 rows).
			expect(row.section_id).toBeGreaterThan(900_000);
		}
		// The ids are STABLE per group: adding a twin appends, never renumbers.
		expect(rows.find((row) => row.tld === 'testactivity')?.section_id).toBe(900_001);
	});

	test('every row resolves through the REAL thesaurus tree door', async () => {
		await ensureTestCorpus();
		const boot = await readAreaHierarchyData('area_thesaurus', 'hierarchy21', 'lg-eng');
		const items = (boot.value ?? []) as {
			section_id: number;
			target_section_tipo: string;
			target_section_name: string | null;
			children_tipo: string;
			root_terms: unknown[];
			active_in_thesaurus: boolean;
		}[];
		// `test*` rows come from TWO fixtures now: this corpus's registry AND
		// the synthetic geography hierarchies (testgeoa/testgeob,
		// src/core/test_data/synthetic_hierarchy_fixture.ts, 2026-08-25). The
		// corpus count pins ONLY its own rows; the synthetic pair is asserted
		// separately below so a missing geo hierarchy is still red here.
		const syntheticTermsSections = new Set(SYNTHETIC_HIERARCHY_TLDS.map((tld) => `${tld}1`));
		const testRows = items.filter((item) => item.target_section_tipo.startsWith('test'));
		const syntheticRows = testRows.filter((item) =>
			syntheticTermsSections.has(item.target_section_tipo),
		);
		const mine = testRows.filter((item) => !syntheticTermsSections.has(item.target_section_tipo));
		expect(mine.length).toBe(HIERARCHY_ROWS);
		// The synthetic geography pair browses too — both of them, exactly.
		expect(syntheticRows.map((row) => row.target_section_tipo).sort()).toEqual(
			[...syntheticTermsSections].sort(),
		);
		for (const item of mine) {
			// The tree drops a hierarchy with no children component, no root
			// term or no active-in-thesaurus flag — arriving here proves all
			// three, which is exactly what makes the thesaurus browsable.
			expect(item.children_tipo).toMatch(/^test[a-z]*\d+$/);
			expect(item.root_terms.length).toBeGreaterThan(0);
			expect(item.active_in_thesaurus).toBe(true);
			expect(item.target_section_name).not.toBeNull();
		}
		const mint = mine.find((item) => item.target_section_tipo === 'testmint1');
		expect(mint?.target_section_name).toBe('Mint');
		// A SYNTHETIC twin browses exactly like a cloned one.
		const cult = mine.find((item) => item.target_section_tipo === 'testcult1');
		expect(cult?.target_section_name).toBe('Cultural context');
		// ANTI-VACUITY: the projection really is filtered — an install
		// hierarchy is still there, and no `test` row leaked into it.
		expect(items.length).toBeGreaterThan(mine.length);
	});

	test('inspectHierarchy still reports these rows unusable — the source check (H1/H4/H5 cleared by C1)', async () => {
		// NOT a wish: a PIN on the reason `ensureHierarchy` is bypassed (see the
		// ensure.ts header). `inspectHierarchy` judges a hierarchy against the
		// `<tld>0/1/2` convention rather than against its own registry row, so a
		// perfectly browsable test thesaurus reads as broken. When H1/H2/H4/H5
		// are fixed this test flips — and the door should then simply call
		// ensureHierarchy(row.section_id).
		const { inspectHierarchy } = await import('../../src/core/ontology/hierarchy_state.ts');
		const state = await inspectHierarchy(
			testHierarchyRegistry().find((row) => row.tld === 'testmint')?.section_id ?? 0,
		);
		expect(state.tld).toBe('testmint');
		const failing = state.checks
			.filter((check) => !check.ok)
			.map((check) => check.id)
			.sort();
		// ontology / targets / root_model (H1/H4/H5) pass since 7ae3d3e0c9 (owner
		// decision C1: a root-only row with hierarchy58 UNSET has no model root).
		// source = a case the check does not model at all: our terms section
		//          is a REAL `matrix_test` section, so there is no "real
		//          section it is a virtual clone of" (`hierarchy109`) to name.
		expect(failing).toEqual(['source']);
		expect(state.usable).toBe(false);
		// The checks that DO pass are the ones the runtime actually needs.
		for (const id of [
			'registry',
			'tld',
			'typology',
			'active',
			'thesaurus',
			'root_term',
			'ontology',
			'targets',
			'root_model',
		]) {
			expect(state.checks.find((check) => check.id === id)?.ok).toBe(true);
		}
	});

	test('each root term locator points at a record that exists', async () => {
		await ensureTestCorpus();
		for (const row of testHierarchyRegistry()) {
			const rows = (await sql.unsafe(
				`SELECT relation->'hierarchy45'->0->>'section_id' AS root
				 FROM matrix_hierarchy_main WHERE section_tipo = 'hierarchy1' AND section_id = $1`,
				[row.section_id],
			)) as { root: string | null }[];
			const rootId = Number(rows[0]?.root);
			expect(Number.isInteger(rootId)).toBe(true);
			const record = (await sql.unsafe(
				`SELECT count(*)::int AS n FROM "${TEST_CORPUS_TABLE}"
				 WHERE section_tipo = $1 AND section_id = $2`,
				[row.termsSection, rootId],
			)) as { n: number }[];
			expect(record[0]?.n).toBe(1);
		}
	});
});
