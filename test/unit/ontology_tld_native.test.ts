/**
 * ONT-TLD — `ontology7` is DERIVED from the section, never typed. TS-native write-path contract.
 *
 * THE BUG THIS CLOSES. An administrator creating a record in an ontology section (`test0`,
 * `testmint0`, …) had to know, and retype, the section's own tld. `ontology7` is MANDATORY —
 * `parseSectionRecordToOntologyNode` returns null without it — so a record created without one
 * writes no `dd_ontology` row and never appears in the ontology tree. No error, no warning: the
 * record is simply lost. The mirror failure is a typo, which files the record under ANOTHER
 * tld's namespace (`ontology_state`'s `foreign` drift).
 *
 * Neither is information a human holds: a record of section `test0` parses into node tipo
 * `test<section_id>`, so `test` is the only tld it can ever carry. The invariant, and the one
 * place it is expressed, is `ontology/tld.ts requiredOntologyTld`.
 *
 * FOUR LAYERS, each pinned here, because no single one covers every door:
 *   1. BIRTH   — record_defaults seeds it at the create chokepoint (every engine door).
 *   2. SAVE    — save_component refuses a mismatching or cleared write (import, API, MCP).
 *   3. DISPLAY — permissions forces level 1, so the edit form renders it read-only.
 *   4. IMPORT  — data_io_import normalizes it post-COPY, the door the engine never sees, and
 *                the door a global tld rename (export-as-`objet` / import-as-`object`) uses.
 * Whatever still slips through is REPORTED as `ontology_state`'s `tldless` drift rather than
 * skipped in silence.
 *
 * Scratch: tld 'zztl' (section 'zztl0') and 'zztm'. Both swept; this file leaves zero residue.
 */
// Migrated to the generic `test` TLD 2026-08-20: the subject is the ONT-TLD
// grammar, so every example is an engine-shipped or `test`-TLD node — `test0`
// and `testmint0` for the governed `<tld>0` sections, `test6813`/`test6099` for
// the ungoverned data sections.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from '../../src/core/db/postgres.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import { normalizeOntologyTld } from '../../src/core/ontology/data_io_import.ts';
import { inspectOntology, rebuildOntology } from '../../src/core/ontology/ontology_state.ts';
import { requiredOntologyTld } from '../../src/core/ontology/tld.ts';
import { buildStructureContext } from '../../src/core/resolve/structure_context.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import {
	ontologyTldRefusal,
	saveComponentData,
} from '../../src/core/section/record/save_component.ts';

const TLD = 'zztl';
const OTHER_TLD = 'zztm';
const SECTION = `${TLD}0`;
const USER_ID = -1;
const TLD_COMPONENT = 'ontology7';

/** The exact stored shape every ontology7 item in the wild carries (4832/4832 in dedalo7_mht). */
const storedTldItem = (value: string) => ({ id: 1, lang: 'lg-nolan', value });

async function readString(sectionId: number): Promise<Record<string, unknown[]> | null> {
	const rows = (await sql.unsafe(
		'SELECT "string" FROM matrix_ontology WHERE section_tipo = $1 AND section_id = $2',
		[SECTION, sectionId],
	)) as { string: Record<string, unknown[]> | null }[];
	return rows[0]?.string ?? null;
}

/** Insert a raw matrix_ontology row, bypassing every engine door (the COPY-import shape). */
async function seedRaw(sectionId: number, stringColumn: unknown | null): Promise<void> {
	await sql.unsafe(
		`INSERT INTO matrix_ontology (section_id, section_tipo, "string")
		 VALUES ($1, $2, $3::text::jsonb)`,
		[sectionId, SECTION, stringColumn === null ? null : JSON.stringify(stringColumn)],
	);
	await clearOntologyDerivedCaches();
}

/** Pre-seed the `<tld>0` main node so inSync is about DRIFT, not the bootstrap. */
async function seedMainNode(): Promise<void> {
	await sql.unsafe(
		`INSERT INTO dd_ontology (tipo, tld, model, is_main, term)
		 VALUES ($1, $2, 'section', true, $3::text::jsonb)
		 ON CONFLICT (tipo) DO NOTHING`,
		[SECTION, TLD, JSON.stringify({ 'lg-eng': TLD })],
	);
	await clearOntologyDerivedCaches();
}

async function sweep(): Promise<void> {
	await sql.unsafe('DELETE FROM dd_ontology WHERE tld IN ($1, $2)', [TLD, OTHER_TLD]);
	await sql.unsafe('DELETE FROM matrix_ontology WHERE section_tipo IN ($1, $2)', [
		SECTION,
		`${OTHER_TLD}0`,
	]);
	await sql.unsafe('DELETE FROM matrix_counter WHERE tipo IN ($1, $2)', [SECTION, `${OTHER_TLD}0`]);
	for (const tld of [TLD, OTHER_TLD]) {
		await sql.unsafe(
			`DELETE FROM matrix_ontology_main WHERE section_tipo = 'ontology35' AND string @> $1::text::jsonb`,
			[JSON.stringify({ hierarchy6: [{ value: tld }] })],
		);
	}
	await clearOntologyDerivedCaches();
}

beforeEach(sweep);
afterAll(sweep);

// ---------------------------------------------------------------------------
// 1. The rule itself
// ---------------------------------------------------------------------------

describe('requiredOntologyTld — the one expression of ONT-TLD', () => {
	test('governs every `<tld>0` ontology node section', () => {
		expect(requiredOntologyTld('test0')).toBe('test');
		expect(requiredOntologyTld('dd0')).toBe('dd');
		expect(requiredOntologyTld('testmint0')).toBe('testmint');
		// The grouper sections are ordinary <tld>0 sections and already satisfy the rule.
		expect(requiredOntologyTld('ontologytype0')).toBe('ontologytype');
		expect(requiredOntologyTld('hierarchytype0')).toBe('hierarchytype');
		expect(requiredOntologyTld('hierarchymtype0')).toBe('hierarchymtype');
	});

	test('EXEMPTS localontology0 — its records declare a foreign tld ON PURPOSE', () => {
		// A localontology record OVERRIDES a canonical node (e.g. dd12), so its ontology7
		// names the OVERRIDDEN node's tld. Governing it would refuse the only value it may
		// legitimately hold.
		expect(requiredOntologyTld('localontology0')).toBeNull();
	});

	test('EXEMPTS the ontology registry — ontology35 holds its tld in hierarchy6, not ontology7', () => {
		expect(requiredOntologyTld('ontology35')).toBeNull();
		expect(requiredOntologyTld('hierarchy1')).toBeNull();
	});

	test('leaves DATA sections alone — only section_id 0 is an ontology node section', () => {
		expect(requiredOntologyTld('test6813')).toBeNull();
		expect(requiredOntologyTld('dd1201')).toBeNull();
		expect(requiredOntologyTld('test6099')).toBeNull();
	});

	test('matches the `<tld>0` shape EXACTLY — a prefix match would govern the wrong sections', () => {
		expect(requiredOntologyTld('dd0x')).toBeNull();
		expect(requiredOntologyTld('es01')).toBeNull();
		expect(requiredOntologyTld('')).toBeNull();
		expect(requiredOntologyTld('0')).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 2. Birth — the create chokepoint
// ---------------------------------------------------------------------------

describe('layer 1 — the birth stamp', () => {
	test('a record created in an ontology section carries its tld immediately', async () => {
		const sectionId = await createSectionRecord(SECTION, USER_ID);

		expect(await readString(sectionId)).toMatchObject({
			[TLD_COMPONENT]: [storedTldItem(TLD)],
		});
	});

	test('the stamped record PARSES — the whole point: it reaches the ontology tree', async () => {
		await createSectionRecord(SECTION, USER_ID);
		const state = await inspectOntology(TLD);

		// It is a real node of this tld, not a tld-less shell.
		expect(state.matrixNodes).toBe(1);
		expect(state.tldlessNodes).toBe(0);
	});

	test('leaves a NON-ontology section untouched (no stray ontology7 anywhere)', async () => {
		// test3 is the canonical unit-test playground section, not an ontology section.
		expect(requiredOntologyTld('test3')).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 3. Save — the refusal
// ---------------------------------------------------------------------------

describe('layer 2 — the save refusal', () => {
	const save = (changedData: { action: string; value: unknown }[], sectionId = 1) =>
		saveComponentData({
			componentTipo: TLD_COMPONENT,
			sectionTipo: SECTION,
			sectionId,
			lang: 'lg-nolan',
			changedData,
			userId: USER_ID,
		});

	test('refuses a DIFFERENT tld and names the value the record must carry', async () => {
		const outcome = await save([{ action: 'set_data', value: [storedTldItem(OTHER_TLD)] }]);

		expect(outcome.ok).toBe(false);
		expect(outcome.message).toContain(`"${TLD}"`); // the required value, so it is actionable
		expect(outcome.message).toContain(OTHER_TLD); // and what arrived
		expect(outcome.message).toContain('ONT-TLD');
	});

	test('refuses CLEARING it — an empty tld loses the record just as surely', async () => {
		const empty = await save([{ action: 'set_data', value: [storedTldItem('')] }]);
		expect(empty.ok).toBe(false);
		expect(empty.message).toContain('empty');

		const wiped = await save([{ action: 'set_data', value: [] }]);
		expect(wiped.ok).toBe(false);

		const removed = await save([{ action: 'remove', value: null }]);
		expect(removed.ok).toBe(false);
	});

	test('refuses BEFORE the transaction — nothing is written on the way to the refusal', async () => {
		const sectionId = await createSectionRecord(SECTION, USER_ID);
		await save([{ action: 'set_data', value: [storedTldItem(OTHER_TLD)] }], sectionId);

		// The birth stamp survives untouched.
		expect(await readString(sectionId)).toMatchObject({
			[TLD_COMPONENT]: [storedTldItem(TLD)],
		});
	});

	test('ALLOWS the correct tld — enforcement must not make the component unsavable', async () => {
		const sectionId = await createSectionRecord(SECTION, USER_ID);
		const outcome = await save([{ action: 'set_data', value: [storedTldItem(TLD)] }], sectionId);

		expect(outcome.ok).toBe(true);
	});

	// THE SHAPE MATRIX is asserted on the PURE predicate, not through the DB.
	//
	// The refusal's job is to agree with the write engine about what a change set
	// WILL store, and that is a pure question. Driving each shape through
	// saveComponentData would need a materialized record per case — which is how
	// the first version of this file came to save into `localontology0`, a REAL
	// production section, leaving its matrix_counter at 999999001 on every database
	// the suite touched. A pure predicate needs no record at all.
	describe('the shape matrix (pure)', () => {
		const req = (changedData: unknown[], sectionTipo = SECTION) =>
			({
				componentTipo: TLD_COMPONENT,
				sectionTipo,
				sectionId: 1,
				lang: 'lg-nolan',
				changedData,
				userId: USER_ID,
			}) as Parameters<typeof ontologyTldRefusal>[0];

		test('ALLOWS the canonical shape: set_data with an array of correct items', () => {
			expect(
				ontologyTldRefusal(req([{ action: 'set_data', value: [storedTldItem(TLD)] }])),
			).toBeNull();
		});

		test('REFUSES a non-array set_data — the engine stores that as an EMPTY component', () => {
			// The regression this exists for: a BARE OBJECT carrying the CORRECT tld.
			// The old guard wrapped it into [value], saw the right value, allowed it —
			// and applySaveComponentData then coerced the non-array to [] and cleared
			// the field, losing the record with ok:true.
			const bare = ontologyTldRefusal(req([{ action: 'set_data', value: storedTldItem(TLD) }]));
			expect(bare).not.toBeNull();
			expect(bare).toContain('non-array');

			expect(ontologyTldRefusal(req([{ action: 'set_data', value: TLD }]))).not.toBeNull();
			expect(ontologyTldRefusal(req([{ action: 'set_data', value: null }]))).not.toBeNull();
			expect(ontologyTldRefusal(req([{ action: 'set_data', value: undefined }]))).not.toBeNull();
		});

		test('REFUSES every non-set_data action — a delta cannot be checked against a derived value', () => {
			for (const action of ['update', 'insert', 'remove', 'set_data_lang', '']) {
				const refusal = ontologyTldRefusal(req([{ action, value: [storedTldItem(TLD)] }]));
				expect(refusal).not.toBeNull();
			}
		});

		test('REFUSES a wrong tld, an empty one, and a bare-scalar item', () => {
			expect(
				ontologyTldRefusal(req([{ action: 'set_data', value: [storedTldItem(OTHER_TLD)] }])),
			).toContain(`"${TLD}"`);
			expect(
				ontologyTldRefusal(req([{ action: 'set_data', value: [storedTldItem('')] }])),
			).toContain('empty');
			expect(ontologyTldRefusal(req([{ action: 'set_data', value: [] }]))).toContain('empty');
			expect(ontologyTldRefusal(req([{ action: 'set_data', value: [{ id: 1 }] }]))).toContain(
				'empty',
			);
			expect(ontologyTldRefusal(req([{ action: 'set_data', value: [TLD] }]))).toContain(
				'non-object',
			);
		});

		test('checks EVERY item, not just the first', () => {
			const mixed = [storedTldItem(TLD), storedTldItem(OTHER_TLD)];
			expect(ontologyTldRefusal(req([{ action: 'set_data', value: mixed }]))).not.toBeNull();
		});

		test('checks EVERY change, not just the first', () => {
			const changes = [
				{ action: 'set_data', value: [storedTldItem(TLD)] },
				{ action: 'set_data', value: [] },
			];
			expect(ontologyTldRefusal(req(changes))).not.toBeNull();
		});

		test('stays out of UNGOVERNED sections and other components entirely', () => {
			// localontology0 records declare a foreign tld ON PURPOSE — asserted here
			// without writing a single row into that real section.
			expect(
				ontologyTldRefusal(req([{ action: 'remove', value: null }], 'localontology0')),
			).toBeNull();
			expect(ontologyTldRefusal(req([{ action: 'remove', value: null }], 'ontology35'))).toBeNull();
			expect(ontologyTldRefusal(req([{ action: 'remove', value: null }], 'test6813'))).toBeNull();
			expect(
				ontologyTldRefusal({
					...req([{ action: 'set_data', value: [] }]),
					componentTipo: 'ontology5',
				}),
			).toBeNull();
		});
	});
});

// ---------------------------------------------------------------------------
// 4. Display — the read-only stamp
// ---------------------------------------------------------------------------

describe('layer 3 — the read-only display stamp', () => {
	const build = (tipo: string, sectionTipo: string) =>
		buildStructureContext({
			configFrom: { source: 'own', reason: 'unit-test' },
			tipo,
			sectionTipo,
			mode: 'edit',
			lang: 'lg-eng',
			permissions: 3, // an admin: the level the cap must actually bite on
			parent: sectionTipo,
			view: null,
		});

	test('caps ontology7 at read (1) on a real ontology node section', async () => {
		// EXACTLY 1 is the mechanism: component_input_text renders a static
		// div.content_value.read_only there, and an <input> at anything higher.
		expect((await build(TLD_COMPONENT, 'dd0'))?.permissions).toBe(1);
		expect((await build(TLD_COMPONENT, 'test0'))?.permissions).toBe(1);
	});

	test('leaves every OTHER component of the same section editable', async () => {
		// The cap is surgical — capping the section would break ontology editing.
		expect((await build('ontology5', 'dd0'))?.permissions).toBe(3);
		expect((await build('ontology41', 'dd0'))?.permissions).toBe(3);
	});

	test('leaves ontology7 editable where ONT-TLD does not govern', async () => {
		// localontology0 records declare a FOREIGN tld on purpose; capping the
		// field there would make the override section unusable.
		expect((await build(TLD_COMPONENT, 'localontology0'))?.permissions).toBe(3);
	});
});

// ---------------------------------------------------------------------------
// 5. Import — the post-COPY normalization (and the tld-rename path)
// ---------------------------------------------------------------------------

describe('layer 4 — normalizeOntologyTld after a COPY import', () => {
	test('rewrites rows that still declare the EXPORT’s tld — this IS the tld rename', async () => {
		// The shape a `<other>.copy.gz` imported as THIS tld lands in.
		await seedRaw(1, {
			ontology7: [storedTldItem(OTHER_TLD)],
			ontology5: [{ id: 1, lang: 'lg-eng', value: 'Renamed node' }],
		});

		expect(await normalizeOntologyTld(SECTION)).toBe(1);
		expect(await readString(1)).toMatchObject({ ontology7: [storedTldItem(TLD)] });
	});

	test('leaves already-correct rows alone and is idempotent', async () => {
		// Both must be REAL nodes (a term, not just a tld): a row carrying nothing but
		// its own ontology7 is a contentless shell, which the normalizer skips by design.
		await seedRaw(1, {
			ontology7: [storedTldItem(TLD)],
			ontology5: [{ id: 1, lang: 'lg-eng', value: 'Already correct' }],
		});
		await seedRaw(2, {
			ontology7: [storedTldItem(OTHER_TLD)],
			ontology5: [{ id: 1, lang: 'lg-eng', value: 'Still the export tld' }],
		});

		expect(await normalizeOntologyTld(SECTION)).toBe(1); // only the wrong one
		expect(await normalizeOntologyTld(SECTION)).toBe(0); // nothing left to do
	});

	test('does NOT stamp contentless shells — that would MATERIALIZE nameless tree nodes', async () => {
		await seedRaw(1, null); // no `string` column at all: no term, no properties

		expect(await normalizeOntologyTld(SECTION)).toBe(0);
		expect(await readString(1)).toBeNull();
	});

	test('is a no-op on a section ONT-TLD does not govern', async () => {
		expect(await normalizeOntologyTld('localontology0')).toBe(0);
		expect(await normalizeOntologyTld('matrix')).toBe(0); // whole-table manifest entry
	});
});

// ---------------------------------------------------------------------------
// 6. Detection — the tldless drift kind
// ---------------------------------------------------------------------------

describe('the `tldless` drift kind', () => {
	test('REPORTS a tld-less record instead of skipping it in silence', async () => {
		await seedRaw(1, { ontology5: [{ id: 1, lang: 'lg-eng', value: 'Invisible' }] });
		const state = await inspectOntology(TLD);

		// Its own channel, NOT drift: a record that parses to nothing is absent from
		// BOTH sides of the diff, so it disagrees with nothing. The SOURCE RECORD is
		// the operator's only handle on it (there is no tipo).
		expect(state.tldlessNodes).toBe(1);
		expect(state.tldlessRecords).toEqual([`${SECTION}/1`]);
		expect(state.drift.length).toBe(0);
	});

	test('does not turn the panel red: the PROJECTION is in sync, the section is not clean', async () => {
		// Reported loudly (tldlessNodes/tldlessRecords) but NOT as drift. Filing it as
		// drift flipped inSync false, which the client paints as a failed check — and
		// since no button may write those records, the panel could never go green
		// again while Regenerate reported success.
		await seedMainNode();
		await seedRaw(1, { ontology5: [{ id: 1, lang: 'lg-eng', value: 'Invisible' }] });
		const state = await inspectOntology(TLD);

		expect(state.tldlessNodes).toBe(1);
		expect(state.drift.length).toBe(0);
		expect(state.inSync).toBe(true);
	});

	test('does NOT block the rebuild — unlike `foreign`, it writes nowhere', async () => {
		// A tld-less record contributes nothing to the projection, so rebuilding the rest is
		// safe. Blocking would wedge every ontology in an install carrying legacy shells.
		await seedRaw(1, { ontology5: [{ id: 1, lang: 'lg-eng', value: 'Invisible' }] });
		await seedRaw(2, {
			ontology7: [storedTldItem(TLD)],
			ontology5: [{ id: 1, lang: 'lg-eng', value: 'Real node' }],
		});

		const outcome = await rebuildOntology(TLD, USER_ID);

		expect(outcome.ok).toBe(true); // converged as far as a writer can
		expect(outcome.applied).toContain('rebuilt 1 node(s)'); // the real node landed
		expect(outcome.msg).toContain(`${SECTION}/1`); // …and the invisible one is still named
	});
});

// ---------------------------------------------------------------------------
// 7. The RENAME itself — rows land in the TARGET section, whatever the file says
// ---------------------------------------------------------------------------

describe('importFromCopyFile lands rows in the target section (the tld rename)', () => {
	/**
	 * A `.copy.gz` carries the `section_tipo` it was EXPORTED with. A straight COPY
	 * honoured the FILE and ignored the caller's target: importing an `<other>0`
	 * export as THIS tld left the target section EMPTY and re-inserted the rows
	 * under the old name — so the normalizer that follows matched nothing and
	 * reported success. This is the gate for the projection that fixes it.
	 */
	const copyLine = (sectionId: number, sectionTipo: string, term: string): string => {
		const str = JSON.stringify({
			ontology7: [storedTldItem(OTHER_TLD)], // the EXPORT's tld, deliberately wrong here
			ontology5: [{ id: 1, lang: 'lg-eng', value: term }],
		});
		// MATRIX_COPY_COLUMNS order: section_id, section_tipo, data, relation, string, …
		const cols = [String(sectionId), sectionTipo, '\\N', '\\N', str];
		return `${cols.join('\t')}\t\\N\t\\N\t\\N\t\\N\t\\N\t\\N\t\\N\t\\N`;
	};

	test('a file exported under ANOTHER section_tipo still lands in the target', async () => {
		const { gzipSync } = await import('node:zlib');
		const { writeFileSync, rmSync, mkdtempSync } = await import('node:fs');
		const { join } = await import('node:path');
		const { tmpdir } = await import('node:os');
		const { importFromCopyFile } = await import('../../src/core/ontology/data_io_import.ts');

		const dir = mkdtempSync(join(tmpdir(), 'ontldimport'));
		const file = join(dir, `${TLD}.copy.gz`);
		const body = `${copyLine(11, `${OTHER_TLD}0`, 'Exported elsewhere')}\n`;
		writeFileSync(file, gzipSync(Buffer.from(body, 'utf8')));

		try {
			const imported = await importFromCopyFile({
				sectionTipo: SECTION,
				filePath: file,
				matrixTable: 'matrix_ontology',
			});
			expect(imported.ok).toBe(true);

			// The row is in THIS section, not the one the file named.
			const landed = (await sql.unsafe(
				'SELECT section_tipo FROM matrix_ontology WHERE section_id = $1 AND section_tipo = $2',
				[11, SECTION],
			)) as unknown[];
			expect(landed.length).toBe(1);
			const stale = (await sql.unsafe('SELECT 1 FROM matrix_ontology WHERE section_tipo = $1', [
				`${OTHER_TLD}0`,
			])) as unknown[];
			expect(stale.length).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			await clearOntologyDerivedCaches();
		}
	}, 60000);

	test('…and importOntologyFile then normalizes its tld, so the node is THIS tld', async () => {
		const { gzipSync } = await import('node:zlib');
		const { writeFileSync, rmSync, mkdtempSync } = await import('node:fs');
		const { join } = await import('node:path');
		const { tmpdir } = await import('node:os');
		const { importOntologyFile } = await import('../../src/core/ontology/data_io_import.ts');

		const dir = mkdtempSync(join(tmpdir(), 'ontldimport'));
		const file = join(dir, `${TLD}.copy.gz`);
		writeFileSync(
			file,
			gzipSync(Buffer.from(`${copyLine(12, `${OTHER_TLD}0`, 'Renamed node')}\n`, 'utf8')),
		);

		try {
			const imported = await importOntologyFile({ tld: TLD, filePath: file });
			expect(imported.ok).toBe(true);
			expect(imported.tld_normalized).toBe(1); // the export's tld was rewritten

			// The end-to-end promise: it parses as a node of THIS tld.
			const state = await inspectOntology(TLD);
			expect(state.matrixNodes).toBe(1);
			expect(state.tldlessNodes).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			await clearOntologyDerivedCaches();
		}
	}, 60000);
});
