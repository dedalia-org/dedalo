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
 *  - UNARMED APPLY WRITES NOTHING: on an ontology without ontology43/44 (the vendored
 *    7.0 today) an apply reports `detail.apply_refused` naming the missing tipo,
 *    applied 0, bytes unchanged — never a name moved into a component the parser cannot
 *    read;
 *  - NEVER AUTO-APPLIED ON AN ONTOLOGY SERVER: an unscoped apply is refused there; a
 *    TLD-scoped one passes that rule (and meets the arming rule next);
 *  - THE PACKAGE IMPORT REWRITE, unarmed: writes nothing, says why, no operator line;
 *  - the scope is TLDs: a non-tld entry is a typed `request.invalid`.
 * The ARMED apply (the saves, the rebuild, a second run at 0) needs a release that
 * defines ontology43/44 — the same blocker as G2; ledgered in the WC entry.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
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

describe('apply refusals write nothing', () => {
	test('unarmed (no ontology43/44 in this ontology): applied 0, the missing tipo named, bytes unchanged', async () => {
		const armed =
			(await getModelByTipo('ontology43')) !== null &&
			(await getModelByTipo('ontology44')) !== null;
		// This leg measures the UNARMED branch; on a suite whose release defines both, the
		// armed apply legs (ledgered with G2) take over and this one has nothing to measure.
		expect(armed, 'the suite release now defines ontology43/44: write the armed apply legs').toBe(
			false,
		);
		const before = await scratchBytes(TLD);
		for (const name of [ONTOLOGY_MACHINE_NAMES, ONTOLOGY_MACHINE_NAMES_STRAYS]) {
			const { report } = await runReconcile(name, { apply: true, scope: [TLD] });
			expect(report.applied).toBe(0);
			expect(report.drift).toBeGreaterThan(0);
			expect(String(report.detail.apply_refused)).toContain('ontology43');
		}
		expect(await scratchBytes(TLD)).toBe(before);
	});

	test('on an ontology server an UNSCOPED apply is refused (master is converted by a human); a scoped one passes that rule', async () => {
		expect(await applyRefusal(undefined, true)).toContain('ontology server');
		expect(await applyRefusal([], true)).toContain('ontology server');
		const scoped = await applyRefusal([TLD], true);
		expect(scoped ?? '').not.toContain('ontology server');
		// …and the arming rule still holds after it (this suite is unarmed).
		expect(scoped).toContain('ontology43');
	});

	test('the package import rewrite, unarmed: nothing written, the reason stated, no operator line', async () => {
		const before = await scratchBytes(TLD);
		const outcome = await convertImportedMachineNames(SECTION);
		expect(outcome.converted).toBe(0);
		expect(outcome.skipped).toContain('ontology43');
		expect(await importedMachineNameMessages(SECTION)).toEqual([]);
		// Out of its reach entirely: a section that is not `<tld>0`.
		expect((await convertImportedMachineNames('localontology0')).skipped).toBeNull();
		expect(await scratchBytes(TLD)).toBe(before);
	});

	test('the package import rewrite on an ontology server: refused outright, nothing written', async () => {
		const before = await scratchBytes(TLD);
		const outcome = await convertImportedMachineNames(SECTION, true);
		expect(outcome.converted).toBe(0);
		expect(outcome.skipped).toContain('ontology server');
		expect(await scratchBytes(TLD)).toBe(before);
	});
});
