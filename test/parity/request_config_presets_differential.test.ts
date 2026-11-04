/**
 * Request-config PRESETS gate (PHP core/common/class.request_config_presets.php +
 * common::resolve_preset_properties). An ACTIVE dd1244 layout preset for a
 * (tipo, section_tipo, mode) triple REPLACES the ontology-derived section
 * request_config, so the section renders the saved component layout instead of
 * the default edit-form tree.
 *
 * FIXTURE — BUILT, NOT BORROWED (2026-08-19). The gate used to read whatever
 * dd1244 record the ambient database happened to hold; on any database but the
 * one it was written against there is none, and the whole gate collapsed to
 * "undefined is not defined". It now WRITES its own preset record on a scratch
 * id (>= 900000, swept in afterAll): PUBLIC + ACTIVE, targeting section test3
 * in EDIT mode, showing a SINGLE component — `test100`, which is the component
 * the FROZEN oracle's own preset showed, so the two engines are still being
 * asked the same question.
 *
 * That the preset's ddo is authored here does NOT make the comparison vacuous:
 * the ontology-derived edit tree for test3 is 37 ddos, so an engine that
 * ignored the preset would emit 37 and red on the first assertion. What is
 * being pinned is the OVERRIDE, and the override is what collapses 37 to 1.
 * The corpus is not used for this record: its derived dd1244 row is a LIST
 * projection (four string components, no `dd1566` active flag and no `dd625`
 * payload), so it can never satisfy the active-preset query.
 *
 * Asserts:
 *  1. the TS reader hydrates the active preset for test3/edit;
 *  2. the TS section EDIT context collapses to exactly the preset's ddos;
 *  3. it equals live PHP EXACTLY (same tipos, same order);
 *  4. LIST mode does NOT inherit the edit-mode preset (mode-keyed match).
 *
 * @twinned-by   test/unit/request_config_presets.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { deleteMatrixRecord } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import {
	clearRequestConfigPresetsCache,
	getActiveRequestConfigPresets,
	type RequestConfigPreset,
} from '../../src/core/relations/request_config/presets.ts';
import {
	buildStructureContext,
	clearStructureContextCache,
} from '../../src/core/resolve/structure_context.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { hasPhpCredentials, PhpApiClient } from './php_client.ts';

/** A SEED-SHIPPED tipo, spelled out of the install-TLD census's token grammar. */
const seed = (tld: string, id: number): string => `${tld}${id}`;

const SECTION = 'test3';
/** The presets section — SEED-SHIPPED `dd` ontology, on every installation. */
const PRESETS_SECTION = seed('dd', 1244);
/** The scratch preset record this gate owns (reserved >= 900000 band). */
const PRESET_RECORD_ID = 931031;
const SCRATCH_ID_FLOOR = 900000;
/** The ONE component the preset shows — the frozen oracle's own preset ddo. */
const PRESET_DDO = 'test100';
/** dd1244's component tipos (presets.ts PRESET_TIPO) and the yes/no section. */
const PRESET_TIPO_COMPONENT = seed('dd', 1242);
const PRESET_SECTION_TIPO_COMPONENT = seed('dd', 642);
const PRESET_MODE_COMPONENT = seed('dd', 1246);
const PRESET_PUBLIC_COMPONENT = seed('dd', 640);
const PRESET_ACTIVE_COMPONENT = seed('dd', 1566);
const PRESET_CONFIG_COMPONENT = seed('dd', 625);
const YES_NO_SECTION = seed('dd', 64);
const YES = 1;

/** A yes/no flag locator, exactly as the real preset records carry it. */
function flagLocator(componentTipo: string) {
	return {
		id: 1,
		type: seed('dd', 151),
		section_id: YES,
		section_tipo: YES_NO_SECTION,
		from_component_tipo: componentTipo,
	};
}

/** The preset payload: ONE main request_config showing ONE ddo. */
const PRESET_PAYLOAD = [
	{
		api_engine: 'dedalo',
		type: 'main',
		sqo: { section_tipo: [SECTION], limit: 1 },
		show: {
			ddo_map: [
				{
					typo: 'ddo',
					tipo: PRESET_DDO,
					parent: SECTION,
					section_tipo: SECTION,
					mode: 'edit',
					model: 'component_geolocation',
				},
			],
			sqo_config: { full_count: false, limit: 1, offset: 0, mode: 'edit', operator: '$or' },
		},
	},
];

async function writePresetRecord(): Promise<void> {
	// This gate writes a dd1244 record — on an installation those are real saved
	// layouts. The database must say it is disposable first.
	await assertTestDatabase('request_config_presets_differential');
	if (PRESET_RECORD_ID < SCRATCH_ID_FLOOR) {
		throw new Error(
			`request_config_presets_differential: id ${PRESET_RECORD_ID} is below the scratch floor ${SCRATCH_ID_FLOOR}`,
		);
	}
	const table = await getMatrixTableFromTipo(PRESETS_SECTION);
	if (table === null) throw new Error(`no matrix table for ${PRESETS_SECTION}`);
	const columns: Record<string, unknown> = {
		string: {
			[PRESET_TIPO_COMPONENT]: [{ id: 1, lang: 'lg-nolan', value: SECTION }],
			[PRESET_SECTION_TIPO_COMPONENT]: [{ id: 1, lang: 'lg-nolan', value: SECTION }],
			[PRESET_MODE_COMPONENT]: [{ id: 1, lang: 'lg-nolan', value: 'edit' }],
		},
		relation: {
			[PRESET_PUBLIC_COMPONENT]: [flagLocator(PRESET_PUBLIC_COMPONENT)],
			[PRESET_ACTIVE_COMPONENT]: [flagLocator(PRESET_ACTIVE_COMPONENT)],
		},
		// dd625 is a component_json — its items live in the shared `misc` column.
		misc: { [PRESET_CONFIG_COMPONENT]: [{ id: 1, value: PRESET_PAYLOAD }] },
		data: { section_id: PRESET_RECORD_ID, section_tipo: PRESETS_SECTION },
	};
	const names = ['"section_tipo"', '"section_id"'];
	const placeholders = ['$1', '$2'];
	const params: (string | number)[] = [PRESETS_SECTION, PRESET_RECORD_ID];
	let index = 3;
	for (const [column, value] of Object.entries(columns)) {
		names.push(`"${column}"`);
		placeholders.push(`$${index}::text::jsonb`);
		params.push(encodeForJsonb(value));
		index++;
	}
	await sql.unsafe(
		`INSERT INTO "${table}" (${names.join(', ')}) VALUES (${placeholders.join(', ')})`,
		params,
	);
}

async function dropPresetRecord(strict: boolean): Promise<void> {
	const table = await getMatrixTableFromTipo(PRESETS_SECTION);
	if (table === null) return;
	const removed = await deleteMatrixRecord(table, PRESETS_SECTION, PRESET_RECORD_ID);
	if (strict && removed === 0) {
		throw new Error(
			'request_config_presets_differential sweep removed 0 rows — the scratch filter is wrong',
		);
	}
}

type Ddoish = { tipo: string };

function ddoTiposFromEntry(entry: unknown): string[] {
	const config = (entry as { request_config?: { show?: { ddo_map?: Ddoish[] } }[] } | null)
		?.request_config;
	return (config?.[0]?.show?.ddo_map ?? []).map((ddo) => ddo.tipo);
}

async function phpSectionDdoTipos(client: PhpApiClient, mode: string): Promise<string[]> {
	const { body } = await client.call({
		action: 'get_element_context',
		dd_api: 'dd_core_api',
		source: { model: 'section', tipo: SECTION, section_tipo: SECTION, mode, lang: 'lg-spa' },
	} as unknown as Record<string, unknown>);
	return ddoTiposFromEntry((body.result as unknown[])[0]);
}

async function tsSectionDdoTipos(mode: string): Promise<string[]> {
	const entry = await buildStructureContext({
		configFrom: { source: 'own', reason: 'unit-test' },
		tipo: SECTION,
		sectionTipo: SECTION,
		mode,
		lang: 'lg-spa',
		permissions: 3,
	});
	return ddoTiposFromEntry(entry);
}

describe.if(hasPhpCredentials())(
	'request_config presets differential (dd1244 layout override)',
	() => {
		let editPreset: RequestConfigPreset | undefined;
		let presetTipos: string[];
		let phpEditTipos: string[];
		let tsEditTipos: string[];
		let phpListTipos: string[];
		let tsListTipos: string[];
		/** The ontology-derived edit tree, read with NO preset installed. */
		let tsEditTiposWithoutPreset: string[];

		beforeAll(async () => {
			await dropPresetRecord(false); // a crashed previous run leaves a row
			// THE ANTI-VACUITY BASELINE, measured before the preset exists: the
			// ontology-derived edit tree. If the override did nothing, the "after"
			// reading would simply equal this one — and the assertion below refuses
			// exactly that.
			clearRequestConfigPresetsCache();
			clearStructureContextCache();
			tsEditTiposWithoutPreset = await tsSectionDdoTipos('edit');
			await writePresetRecord();
			// The preset store and the structure context are both cached by
			// construction; the direct write above happened outside their
			// invalidation events, so drop them explicitly.
			clearRequestConfigPresetsCache();
			clearStructureContextCache();
			const client = new PhpApiClient();
			await client.login(
				config.phpReference.username as string,
				config.phpReference.password as string,
			);

			const presets = await getActiveRequestConfigPresets();
			editPreset = presets.find(
				(preset) =>
					preset.tipo === SECTION && preset.sectionTipo === SECTION && preset.mode === 'edit',
			);
			presetTipos = (
				(editPreset?.data?.[0] as { show?: { ddo_map?: Ddoish[] } } | undefined)?.show?.ddo_map ??
				[]
			).map((ddo) => ddo.tipo);

			phpEditTipos = await phpSectionDdoTipos(client, 'edit');
			tsEditTipos = await tsSectionDdoTipos('edit');
			phpListTipos = await phpSectionDdoTipos(client, 'list');
			tsListTipos = await tsSectionDdoTipos('list');
		});

		afterAll(async () => {
			await dropPresetRecord(true);
			clearRequestConfigPresetsCache();
			clearStructureContextCache();
		});

		test('the TS reader hydrates the active edit preset for test3 (fixture present)', () => {
			expect(editPreset).toBeDefined();
			expect(editPreset?.public).toBe(true);
			expect(presetTipos).toEqual([PRESET_DDO]);
		});

		test('the TS edit context collapses to exactly the preset ddos, and equals PHP', () => {
			// The preset overrides the full edit-form tree down to its own ddo list.
			// The tree it replaced was MUCH bigger: an engine that ignored the
			// preset would answer that tree, and reds here rather than passing a
			// comparison between two things the gate itself authored.
			expect(tsEditTiposWithoutPreset.length).toBeGreaterThan(presetTipos.length);
			expect(tsEditTiposWithoutPreset).not.toEqual(presetTipos);
			expect(tsEditTipos).toEqual(presetTipos);
			expect(tsEditTipos).toEqual(phpEditTipos);
		});

		test('LIST mode does not inherit the edit-mode preset (mode-keyed match)', () => {
			// The edit preset must not leak into list; both engines keep the default
			// section_list columns, which are more than the single edit-preset ddo.
			expect(tsListTipos).toEqual(phpListTipos);
			expect(tsListTipos).not.toEqual(presetTipos);
		});
	},
);
