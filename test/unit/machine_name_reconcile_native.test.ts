/**
 * THE MACHINE-NAME CONVERTER'S DOORS on the suite database (P3, plan §6,
 * WC-2026-11-04-ontology-machine-names; the hermetic kernel gate is
 * machine_name_convert.test.ts). On a `zzmr` scratch section holding one raw source
 * record of EVERY class the kernel judges, this gate drives:
 *  - THE CENSUS through the registry door (`runReconcile`, dry): the two definitions
 *    split the work exactly — `ontology_machine_names` counts class L only,
 *    `ontology_machine_names_strays` class S only; class C is listed in
 *    `detail.refused` by both and counted by neither; converted records are `none`
 *    (the stored ontology43/44 are read under their fixed columns even where the
 *    release does not define the tipos yet);
 *  - A DRY RUN WRITES NOTHING: the section's bytes are equal before and after;
 *  - NEVER AUTO-APPLIED ON AN ONTOLOGY SERVER: an unscoped apply is refused there; a
 *    TLD-scoped one passes; the package import rewrite is refused there outright;
 *  - THE ARMED APPLY (the vendored 7.0 release defines ontology43/44 since 2026-11-07):
 *    class L through the save door (a TM row per key), the TLD rebuilt so the projection
 *    carries the name + flag at once, S and C byte-equal, a second run at drift 0; class S
 *    moves the name and keeps the stray as the node's only label (D3); the package import
 *    rewrite converts L WITHOUT a TM row and names what it left, in one operator line;
 *  - the scope is TLDs: a non-tld entry is a typed `request.invalid`.
 * THE UNARMED branch (`armingRefusal` answering the missing tipo) is no longer reachable on
 * the suite database — its release defines both tipos — so it is not driven here; it is
 * the one getModelByTipo null check in machine_name_reconcile.ts (WC addendum 2026-11-07).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../../src/core/db/postgres.ts';
import {
	applyRefusal,
	censusMachineNames,
	convertImportedMachineNames,
	importedMachineNameMessages,
	ONTOLOGY_MACHINE_NAMES,
	ONTOLOGY_MACHINE_NAMES_STRAYS,
} from '../../src/core/ontology/machine_name_reconcile.ts';
import { getModelByTipo } from '../../src/core/ontology/resolver.ts';
import { registerAllReconciles } from '../../src/core/reconcile/catalog.ts';
import { runReconcile } from '../../src/core/reconcile/registry.ts';
import {
	modelTipoNamed,
	type ScratchRecord,
	scratchBytes,
	scratchRecordBytes,
	scratchTimeMachineRows,
	seedMachineNameScratch,
	sweepMachineNameScratch,
} from '../helpers/machine_name_scratch.ts';

const TLD = 'zzmr';
const SECTION = `${TLD}0`;

const item = (id: number, lang: string, value: string) => ({ id, lang, value });

/** One record per class/kind; the expected kind per section_id. */
async function records(): Promise<{ records: ScratchRecord[]; kinds: Record<number, string> }> {
	const matrixTable = await modelTipoNamed('matrix_table');
	const table = await modelTipoNamed('table');
	return {
		records: [
			{ sectionId: 1, modelTipo: matrixTable, term: [item(1, 'lg-spa', 'zzmr_matrix')] },
			{ sectionId: 2, modelTipo: table, term: [item(1, 'lg-eng', 'zzmr_local')] },
			{ sectionId: 3, term: [item(1, 'lg-eng', 'A label')] },
			{
				sectionId: 4,
				modelTipo: table,
				term: [item(1, 'lg-eus', 'Berria'), item(2, 'lg-spa', 'zzmr_body')],
			},
			{
				sectionId: 5,
				modelTipo: table,
				term: [item(1, 'lg-spa', 'zzmr_a'), item(2, 'lg-spa', 'zzmr_b')],
			},
			{
				sectionId: 6,
				modelTipo: table,
				term: [item(1, 'lg-spa', 'zzmr_x')],
				machineName: 'zzmr_y',
				flag: true,
			},
			{
				sectionId: 7,
				modelTipo: table,
				term: [item(1, 'lg-eng', 'Table')],
				machineName: 'zzmr_done',
				flag: true,
			},
			{ sectionId: 8, term: [item(1, 'lg-eng', 'Done label')], flag: false },
			{ sectionId: 9, modelTipo: table, term: [item(1, 'lg-spa', 'zzmr_t')], flag: false },
		],
		kinds: {
			1: 'move',
			2: 'move_single',
			3: 'flag_no',
			4: 'strays',
			5: 'ambiguous_legacy',
			6: 'name_differs',
			7: 'converted',
			8: 'converted',
			9: 'flag_no_on_name_model',
		},
	};
}

let expectedKinds: Record<number, string> = {};

beforeAll(async () => {
	await registerAllReconciles();
	await sweepMachineNameScratch(TLD);
	const built = await records();
	expectedKinds = built.kinds;
	await seedMachineNameScratch(TLD, built.records);
}, 60000);

afterAll(async () => {
	await sweepMachineNameScratch(TLD);
}, 60000);

describe('the census (dry, through the registry door)', () => {
	test('every record gets its class; the two definitions split L and S; C is listed, never counted', async () => {
		const census = await censusMachineNames([TLD]);
		const bySource = new Map(census.units.map((unit) => [unit.source, unit.conversion.kind]));
		for (const [id, kind] of Object.entries(expectedKinds)) {
			// `none` records carry no finding here, so they are not listed — only counted.
			if (kind === 'converted') expect(bySource.has(`${SECTION}/${id}`)).toBe(false);
			else expect(bySource.get(`${SECTION}/${id}`) as string | undefined).toBe(kind);
		}
		expect(census.scanned).toBe(9);
		expect(census.classes).toEqual({ none: 2, L: 3, S: 1, C: 3 });

		const lossless = (await runReconcile(ONTOLOGY_MACHINE_NAMES, { apply: false, scope: [TLD] }))
			.report;
		expect(lossless.drift).toBe(3);
		expect(lossless.applied).toBe(0);
		const strays = (
			await runReconcile(ONTOLOGY_MACHINE_NAMES_STRAYS, { apply: false, scope: [TLD] })
		).report;
		expect(strays.drift).toBe(1);
		const listedStray = (strays.detail.units as { source: string; values: string[] }[])[0];
		expect(listedStray).toMatchObject({ source: `${SECTION}/4`, values: ['Berria'] });
		const refused = (lossless.detail.refused as { source: string; kind: string }[]).map(
			(unit) => unit.kind,
		);
		expect(refused.sort()).toEqual(['ambiguous_legacy', 'flag_no_on_name_model', 'name_differs']);
	});

	test('a dry run writes nothing (bytes equal), and a second dry run reports the same', async () => {
		const before = await scratchBytes(TLD);
		const first = await runReconcile(ONTOLOGY_MACHINE_NAMES, { apply: false, scope: [TLD] });
		const second = await runReconcile(ONTOLOGY_MACHINE_NAMES, { apply: false, scope: [TLD] });
		expect(await scratchBytes(TLD)).toBe(before);
		expect(JSON.stringify(second.report)).toBe(JSON.stringify(first.report));
	});

	test('the scope is a list of TLDs: a non-tld entry is a typed refusal', async () => {
		await expect(censusMachineNames(['zzmr1'])).rejects.toMatchObject({ code: 'request.invalid' });
	});
});

describe('the ontology-server rule', () => {
	test('on an ontology server an UNSCOPED apply is refused (master is converted by a human); a scoped one passes', async () => {
		expect(await applyRefusal(undefined, true)).toContain('ontology server');
		expect(await applyRefusal([], true)).toContain('ontology server');
		// Scoped, the rule is met — and so is the arming rule (the suite release defines
		// ontology43/44), so nothing refuses at all; off a server, unscoped passes too.
		expect(await applyRefusal([TLD], true)).toBeNull();
		expect(await applyRefusal(undefined, false)).toBeNull();
	});

	test('the package import rewrite on an ontology server: refused outright, nothing written', async () => {
		const before = await scratchBytes(TLD);
		const outcome = await convertImportedMachineNames(SECTION, true);
		expect(outcome.converted).toBe(0);
		expect(outcome.skipped).toContain('ontology server');
		expect(await scratchBytes(TLD)).toBe(before);
	});
});

/** Each class-C record's bytes (never written by any door). */
async function refusedBytes(): Promise<string[]> {
	return Promise.all(REFUSED_IDS.map((id) => scratchRecordBytes(TLD, id)));
}

const LOSSLESS_IDS = [1, 2, 3] as const;
const STRAY_IDS = [4] as const;
const REFUSED_IDS = [5, 6, 9] as const;

describe('the ARMED apply (the suite release defines ontology43/44)', () => {
	test('precondition: both components resolve under their fixed columns — the doors are armed', async () => {
		expect(await getModelByTipo('ontology43')).toBe('component_input_text');
		expect(await getModelByTipo('ontology44')).toBe('component_radio_button');
	});

	test('class L: the saves (a TM row each), the rebuild, S and C untouched, then a second run at 0', async () => {
		const strayBefore = await scratchRecordBytes(TLD, STRAY_IDS[0]);
		const refusedBefore = await refusedBytes();
		const tmBefore = await scratchTimeMachineRows(TLD);

		const { report } = await runReconcile(ONTOLOGY_MACHINE_NAMES, { apply: true, scope: [TLD] });
		expect(report.refused).toBeUndefined();
		expect(report.drift).toBe(3);
		expect(report.applied).toBe(3);
		expect(report.detail?.failed_count).toBe(0);
		expect(report.detail?.skipped).toBe(0);
		// The touched TLD is rebuilt (exactly it). Its `ok` is false only for `mainNodeOk`: a
		// scratch TLD has no hierarchy registry row for its main node. What the rebuild is
		// FOR — the derived rows — is asserted on the projection below.
		expect(Object.keys(report.detail?.rebuilt as object)).toEqual([TLD]);
		// The save door, not a raw write: a Time Machine row per saved key.
		expect(await scratchTimeMachineRows(TLD)).toBeGreaterThanOrEqual(
			tmBefore + LOSSLESS_IDS.length,
		);

		// The projection follows at once (the rebuild): the name in machine_name, the flag stated.
		const rows = await projection();
		expect(rows.zzmr1).toMatchObject({ machine_name: 'zzmr_matrix', use_machine_name: true });
		expect(rows.zzmr2).toMatchObject({ machine_name: 'zzmr_local', use_machine_name: true });
		expect(rows.zzmr3).toMatchObject({ machine_name: null, use_machine_name: false });

		// L's records are converted now; S and C are byte-equal (never written by this door).
		const census = await censusMachineNames([TLD]);
		const listed = new Set(census.units.map((unit) => unit.source));
		for (const id of LOSSLESS_IDS) expect(listed.has(`${SECTION}/${id}`)).toBe(false);
		expect(census.classes).toEqual({ none: 5, L: 0, S: 1, C: 3 });
		expect(await scratchRecordBytes(TLD, STRAY_IDS[0])).toBe(strayBefore);
		expect(await refusedBytes()).toEqual(refusedBefore);

		// Idempotent: a second run finds nothing and writes nothing.
		const bytes = await scratchBytes(TLD);
		const second = (await runReconcile(ONTOLOGY_MACHINE_NAMES, { apply: true, scope: [TLD] }))
			.report;
		expect(second.drift).toBe(0);
		expect(second.applied).toBe(0);
		expect(await scratchBytes(TLD)).toBe(bytes);
	});

	test('class S: the name moves, the stray stays the node’s label (D3), C untouched, then a second run at 0', async () => {
		const refusedBefore = await refusedBytes();
		const { report } = await runReconcile(ONTOLOGY_MACHINE_NAMES_STRAYS, {
			apply: true,
			scope: [TLD],
		});
		expect(report.refused).toBeUndefined();
		expect(report.drift).toBe(1);
		expect(report.applied).toBe(1);
		expect(report.detail?.failed_count).toBe(0);

		const row = (await projection()).zzmr4;
		expect(row).toMatchObject({ machine_name: 'zzmr_body', use_machine_name: true });
		// D3: the differing translation is kept — it is now the node's only label.
		expect(row?.term).toEqual({ 'lg-eus': 'Berria' });

		const census = await censusMachineNames([TLD]);
		expect(census.classes).toEqual({ none: 6, L: 0, S: 0, C: 3 });
		expect(await refusedBytes()).toEqual(refusedBefore);

		const second = (
			await runReconcile(ONTOLOGY_MACHINE_NAMES_STRAYS, { apply: true, scope: [TLD] })
		).report;
		expect(second.drift).toBe(0);
		expect(second.applied).toBe(0);
	});

	test('the package import rewrite, armed: L converted WITHOUT a TM row, S/C left and counted, one operator line', async () => {
		// A fresh import: the legacy records again, no history.
		await sweepMachineNameScratch(TLD);
		await seedMachineNameScratch(TLD, (await records()).records);
		const strayBefore = await scratchRecordBytes(TLD, STRAY_IDS[0]);
		const refusedBefore = await refusedBytes();

		const messages = await importedMachineNameMessages(SECTION);
		expect(messages).toEqual([
			`${SECTION}: machine names converted on 3 record(s); 1 strays / 3 refused left for reconcile ${ONTOLOGY_MACHINE_NAMES_STRAYS} / ${ONTOLOGY_MACHINE_NAMES}`,
		]);
		// The package is the history: the chokepoint writes no Time Machine row.
		expect(await scratchTimeMachineRows(TLD)).toBe(0);
		expect((await censusMachineNames([TLD])).classes).toEqual({ none: 5, L: 0, S: 1, C: 3 });
		expect(await scratchRecordBytes(TLD, STRAY_IDS[0])).toBe(strayBefore);
		expect(await refusedBytes()).toEqual(refusedBefore);

		// Idempotent, and out of its reach entirely: a section that is not `<tld>0`.
		expect((await convertImportedMachineNames(SECTION)).converted).toBe(0);
		expect((await convertImportedMachineNames('localontology0')).skipped).toBeNull();
	});
});

interface ProjectedRow {
	machine_name: string | null;
	use_machine_name: boolean | null;
	term: Record<string, string> | null;
}

/** The dd_ontology rows the rebuild derived from the scratch records, by tipo. */
async function projection(): Promise<Record<string, ProjectedRow>> {
	const rows = (await sql.unsafe(
		'SELECT tipo, machine_name, use_machine_name, term FROM dd_ontology WHERE tld = $1',
		[TLD],
	)) as ({ tipo: string } & ProjectedRow)[];
	return Object.fromEntries(rows.map(({ tipo, ...row }) => [tipo, row]));
}
