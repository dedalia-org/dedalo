/**
 * component_alias v7 contract gates (WC-020; src/core/ontology/alias.ts +
 * the resolver hop). Scratch-TLD ontology fixtures (zzalias*), purged before
 * and after — the hub-completion fixture pattern. TS-NATIVE feature: no PHP
 * oracle involvement by design.
 *
 * Covered here: target resolution + all four fail-loud contract violations,
 * the model/translatable hops, the top-level-key wholesale merge, and cache
 * identity across a hub fire. The wire identity (context) and the data/save
 * round-trip land with the read/save wiring (same file, later describes).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { deleteTldNodes, upsertDdOntologyNode } from '../../src/core/db/dd_ontology.ts';
import { sql } from '../../src/core/db/postgres.ts';
import {
	clearAliasCaches,
	getEffectivePropertiesByTipo,
	getTargetStoredModel,
	resolveAliasTargetTipo,
	resolveDataTipo,
} from '../../src/core/ontology/alias.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import { getModelByTipo, getTranslatableByTipo } from '../../src/core/ontology/resolver.ts';
import { buildStructureContext } from '../../src/core/resolve/structure_context.ts';
import { readComponentData, readSection } from '../../src/core/section/read.ts';
import { refusalOf } from '../helpers/refusal.ts';

const TLD = 'zzalias';
const SECTION = `${TLD}1`;
const TARGET = `${TLD}2`; // component_portal, own config limit 9, css A, view default
const ALIAS = `${TLD}3`; // alias → TARGET, css B, view mosaic, source limit 1
const ALIAS_OF_ALIAS = `${TLD}4`;
const NO_ALIAS_OF = `${TLD}5`;
const MISSING_TARGET = `${TLD}6`;
const RETIRED_KEYS = `${TLD}7`;
const BARE_ALIAS = `${TLD}8`; // alias → TARGET with NO local overrides
// T2-U04-a — the read guard's two verdicts, one alias per target model class.
const LITERAL_TARGET = `${TLD}9`; // component_input_text: the generic literal path — WIRED
const LITERAL_ALIAS = `${TLD}10`;
const SELECT_TARGET = `${TLD}11`; // a relation that is not the portal engine — refused
const SELECT_ALIAS = `${TLD}12`;
const SECTION_ID_TARGET = `${TLD}13`; // an emit hook that owns the emission — refused
const SECTION_ID_ALIAS = `${TLD}14`;
const IMAGE_TARGET = `${TLD}15`; // media: the other emission-owning hook — refused
const IMAGE_ALIAS = `${TLD}16`;
/** [target, its model, its alias] — provisioned in beforeAll, read in the U04-a describe. */
const GUARD_PAIRS = [
	[LITERAL_TARGET, 'component_input_text', LITERAL_ALIAS],
	[SELECT_TARGET, 'component_select', SELECT_ALIAS],
	[SECTION_ID_TARGET, 'component_section_id', SECTION_ID_ALIAS],
	[IMAGE_TARGET, 'component_image', IMAGE_ALIAS],
] as const;

const TARGET_PROPERTIES = {
	view: 'default',
	css: { '.wrapper_component': { style: { width: '10rem' } } },
	source: {
		mode: 'external',
		request_config: [
			{
				sqo: { section_tipo: [{ value: [SECTION], source: 'section' }] },
				show: { ddo_map: [], sqo_config: { limit: 9 } },
			},
		],
	},
};
const ALIAS_PROPERTIES = {
	alias_of: TARGET,
	view: 'mosaic',
	css: { '.mosaic_li': { style: { height: '400px' } } },
	source: {
		mode: 'external',
		request_config: [
			{
				sqo: { section_tipo: [{ value: [SECTION], source: 'section' }] },
				show: { ddo_map: [], sqo_config: { limit: 1 } },
			},
		],
	},
};

beforeAll(async () => {
	await deleteTldNodes(TLD);
	await upsertDdOntologyNode({
		tipo: SECTION,
		model: 'section',
		tld: TLD,
		term: { 'lg-eng': 'Alias gate section' },
		// The `test24` matrix_table relation, so this scratch section stores in
		// `matrix_test`. Without it `getMatrixTableFromTipo` falls back to the PHP
		// default — `matrix`, the INSTALLATION's own table — and because this file
		// both writes and reads with raw SQL, it stayed self-consistent and GREEN
		// while putting scratch rows there (found 2026-08-21 sweeping for exactly
		// this). `situation()` grants the relation automatically; this file
		// provisions by hand, so it has to say it.
		relations: [{ tipo: 'test24' }],
	});
	await upsertDdOntologyNode({
		tipo: TARGET,
		model: 'component_portal',
		parent: SECTION,
		tld: TLD,
		is_translatable: false,
		term: { 'lg-eng': 'Target portal' },
		properties: TARGET_PROPERTIES,
	});
	await upsertDdOntologyNode({
		tipo: ALIAS,
		model: 'component_alias',
		parent: SECTION,
		tld: TLD,
		term: { 'lg-eng': 'Alias face' },
		properties: ALIAS_PROPERTIES,
	});
	await upsertDdOntologyNode({
		tipo: ALIAS_OF_ALIAS,
		model: 'component_alias',
		parent: SECTION,
		tld: TLD,
		properties: { alias_of: ALIAS },
	});
	await upsertDdOntologyNode({
		tipo: NO_ALIAS_OF,
		model: 'component_alias',
		parent: SECTION,
		tld: TLD,
		properties: { view: 'line' },
	});
	await upsertDdOntologyNode({
		tipo: MISSING_TARGET,
		model: 'component_alias',
		parent: SECTION,
		tld: TLD,
		properties: { alias_of: `${TLD}999` },
	});
	await upsertDdOntologyNode({
		tipo: RETIRED_KEYS,
		model: 'component_alias',
		parent: SECTION,
		tld: TLD,
		properties: { alias_of: TARGET, max_records: 1 },
	});
	await upsertDdOntologyNode({
		tipo: BARE_ALIAS,
		model: 'component_alias',
		parent: SECTION,
		tld: TLD,
		properties: { alias_of: TARGET },
	});
	for (const [target, model, alias] of GUARD_PAIRS) {
		await upsertDdOntologyNode({
			tipo: target,
			model,
			parent: SECTION,
			tld: TLD,
			is_translatable: false,
			term: { 'lg-eng': `Guard target ${model}` },
		});
		await upsertDdOntologyNode({
			tipo: alias,
			model: 'component_alias',
			parent: SECTION,
			tld: TLD,
			term: { 'lg-eng': `Guard alias of ${model}` },
			properties: { alias_of: target },
		});
	}
});
afterAll(async () => {
	await deleteTldNodes(TLD); // fires the hub — leaves no scratch cache state
});

describe('component_alias resolution (WC-020)', () => {
	test('resolves the target; non-aliases resolve null/self', async () => {
		expect(await resolveAliasTargetTipo(ALIAS)).toBe(TARGET);
		expect(await resolveAliasTargetTipo(TARGET)).toBeNull();
		expect(await resolveDataTipo(ALIAS)).toBe(TARGET);
		expect(await resolveDataTipo(TARGET)).toBe(TARGET);
	});

	test('model + translatable hop to the target (resolver)', async () => {
		expect(await getModelByTipo(ALIAS)).toBe('component_portal');
		expect(await getModelByTipo(BARE_ALIAS)).toBe('component_portal');
		expect(await getTranslatableByTipo(ALIAS)).toBe(false);
		expect(await getTargetStoredModel(ALIAS)).toBe('component_portal');
		expect(await getTargetStoredModel(TARGET)).toBe('component_portal');
	});

	test('fail-loud contract: alias-of-alias / no alias_of / missing target / retired v5 keys', async () => {
		expect(resolveAliasTargetTipo(ALIAS_OF_ALIAS)).rejects.toThrow(/alias-of-alias refused/);
		expect(getModelByTipo(ALIAS_OF_ALIAS)).rejects.toThrow(/alias-of-alias refused/);
		expect(resolveAliasTargetTipo(NO_ALIAS_OF)).rejects.toThrow(/alias_of is required/);
		expect(getModelByTipo(NO_ALIAS_OF)).rejects.toThrow(/alias_of is required/);
		expect(resolveAliasTargetTipo(MISSING_TARGET)).rejects.toThrow(/does not exist/);
		// The retired-key throw is alias.ts's (data/config paths) — the resolver
		// hop deliberately skips it so ontology-tree walks over UNMIGRATED v5
		// nodes keep working until the migration runs.
		expect(resolveAliasTargetTipo(RETIRED_KEYS)).rejects.toThrow(/retired v5 key 'max_records'/);
		// Every WC-020 contract refusal is the TYPED ontology.invalid_node
		// (ERRORS_SPEC §7): a bad DEFINITION, never an unexpected error.
		expect((await refusalOf(resolveAliasTargetTipo(ALIAS_OF_ALIAS))).code).toBe(
			'ontology.invalid_node',
		);
		expect((await refusalOf(getModelByTipo(NO_ALIAS_OF))).code).toBe('ontology.invalid_node');
		expect(await getModelByTipo(RETIRED_KEYS)).toBe('component_portal');
	});
});

describe('effective properties merge (top-level-key wholesale)', () => {
	test('alias keys replace target keys WHOLE; untouched target keys pass through', async () => {
		const merged = (await getEffectivePropertiesByTipo(ALIAS)) as Record<string, unknown>;
		expect(merged.alias_of).toBeUndefined(); // stripped
		expect(merged.view).toBe('mosaic'); // alias wins
		expect(JSON.stringify(merged.css)).toBe(JSON.stringify(ALIAS_PROPERTIES.css)); // wholesale
		const limit = (
			merged.source as { request_config: { show: { sqo_config: { limit: number } } }[] }
		).request_config[0]?.show.sqo_config.limit;
		expect(limit).toBe(1); // the alias's WHOLE source replaced the target's
	});

	test('a bare alias (no overrides) inherits the target properties verbatim', async () => {
		const merged = (await getEffectivePropertiesByTipo(BARE_ALIAS)) as Record<string, unknown>;
		expect(merged.alias_of).toBeUndefined();
		// toEqual, not stringify — Postgres jsonb normalizes key order.
		expect(merged).toEqual(TARGET_PROPERTIES);
	});

	test('non-alias tipos pass their own properties through unchanged', async () => {
		const own = await getEffectivePropertiesByTipo(TARGET);
		expect(own).toEqual(TARGET_PROPERTIES);
	});

	test('cached by reference; a hub fire rebuilds fresh (S1-09 discipline)', async () => {
		clearAliasCaches();
		const first = await getEffectivePropertiesByTipo(ALIAS);
		expect(await getEffectivePropertiesByTipo(ALIAS)).toBe(first as object); // hit
		await clearOntologyDerivedCaches();
		const rebuilt = await getEffectivePropertiesByTipo(ALIAS);
		expect(rebuilt).not.toBe(first as object);
		expect(rebuilt).toEqual(first);
	});
});

describe('wire identity — structure context (WC-020)', () => {
	test('context: tipo=alias, model/legacy_model=target, label=alias term, config merged', async () => {
		const entry = await buildStructureContext({
			configFrom: { source: 'own', reason: 'unit-test' },
			tipo: ALIAS,
			sectionTipo: SECTION,
			mode: 'edit',
			lang: 'lg-eng',
			permissions: 3,
		});
		expect(entry).not.toBeNull();
		expect(entry?.tipo).toBe(ALIAS);
		expect(entry?.model).toBe('component_portal'); // client instantiates the target class
		expect(entry?.legacy_model).toBe('component_portal'); // NEVER 'component_alias'
		expect(entry?.type).toBe('component');
		expect(entry?.label).toBe('Alias face'); // the alias's OWN term
		expect(entry?.translatable).toBe(false); // the target's flag
		expect(entry?.view).toBe('mosaic'); // the alias override
		expect(JSON.stringify(entry?.css)).toBe(JSON.stringify(ALIAS_PROPERTIES.css));
		// properties echo: merged, css stripped (Site A), alias_of stripped.
		const props = entry?.properties as Record<string, unknown>;
		expect(props.alias_of).toBeUndefined();
		expect(props.css).toBeUndefined();
		expect(props.view).toBe('mosaic');
		// request_config from the MERGED source: the alias's limit 1.
		const rc = (entry?.request_config as { show?: { sqo_config?: { limit?: number } } }[])?.[0];
		expect(rc?.show?.sqo_config?.limit).toBe(1);
	});
});

describe('data identity — read round-trip on a scratch record (WC-020)', () => {
	const RECORD_ID = 9990001;
	const LOCATORS = [
		{ type: 'dd151', section_id: '11', section_tipo: SECTION, from_component_tipo: TARGET },
		{ type: 'dd151', section_id: '12', section_tipo: SECTION, from_component_tipo: TARGET },
	];

	beforeAll(async () => {
		// ::text::jsonb — the Bun.sql jsonb string-param trap (rewrite/COEXISTENCE.md):
		// a bare ::jsonb binds the string as a jsonb STRING scalar and the
		// relation_search trigger's jsonb_each explodes.
		await sql.unsafe(
			'INSERT INTO matrix_test (section_id, section_tipo, relation) VALUES ($1, $2, $3::text::jsonb)',
			[RECORD_ID, SECTION, JSON.stringify({ [TARGET]: LOCATORS })],
		);
	});
	afterAll(async () => {
		await sql.unsafe('DELETE FROM matrix_test WHERE section_tipo = $1', [SECTION]);
		await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo = $1', [SECTION]);
	});

	test("read via the ALIAS serves the TARGET's stored locators, paged by the alias limit", async () => {
		const items = await readComponentData({
			action: 'read',
			source: {
				tipo: ALIAS,
				section_tipo: SECTION,
				section_id: String(RECORD_ID),
				mode: 'edit',
				lang: 'lg-nolan',
			},
		} as Rqo);
		const own = items.find((item) => item.tipo === ALIAS);
		expect(own).toBeDefined(); // emitted under the ALIAS identity
		expect((own?.entries as unknown[]).length).toBe(1); // alias sqo_config.limit 1
		expect(own?.pagination).toEqual({ total: 2, limit: 1, offset: 0 });
		// NOT flipped by WC-2026-08-10-section-id-int-canonical: the seed above is
		// LEGACY string-stored data and the entries array is emitted as the stored
		// bytes verbatim (only the injected search chips and the expanded child
		// items canonicalize). A pre-sweep row must still read back byte-exact.
		expect((own?.entries as { section_id?: string | number }[])[0]?.section_id).toBe('11');
	});

	test('read via the TARGET sees the same stored data (alias↔target unity)', async () => {
		const items = await readComponentData({
			action: 'read',
			source: {
				tipo: TARGET,
				section_tipo: SECTION,
				section_id: String(RECORD_ID),
				mode: 'edit',
				lang: 'lg-nolan',
			},
		} as Rqo);
		const own = items.find((item) => item.tipo === TARGET);
		expect(own?.pagination).toEqual({ total: 2, limit: 9, offset: 0 }); // the TARGET's own limit
	});

	test("save via the ALIAS lands in the TARGET's slot — counters/TM/stored bytes under the target", async () => {
		const { saveComponentData } = await import('../../src/core/section/record/save_component.ts');
		const newLocator = {
			type: 'dd151',
			section_id: '13',
			section_tipo: SECTION,
			from_component_tipo: TARGET,
		};
		const outcome = await saveComponentData({
			componentTipo: ALIAS,
			sectionTipo: SECTION,
			sectionId: RECORD_ID,
			lang: 'lg-nolan',
			changedData: [{ action: 'set_data', id: null, value: [...LOCATORS, newLocator] }],
			userId: -1,
		});
		expect(outcome.ok).toBe(true);

		// Stored bytes: the relation column keys the TARGET; the ALIAS key must
		// NOT exist (stored data never contains the alias tipo — WC-020).
		const rows = (await sql.unsafe(
			`SELECT relation->'${TARGET}' AS target_items, relation ? '${ALIAS}' AS alias_key
			 FROM matrix_test WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, RECORD_ID],
		)) as { target_items: unknown[]; alias_key: boolean }[];
		expect(rows[0]?.alias_key).toBe(false);
		expect((rows[0]?.target_items as unknown[]).length).toBe(3);

		// TM audit rows carry the TARGET tipo (one data history for both doors).
		const tmRows = (await sql.unsafe(
			`SELECT tipo FROM matrix_time_machine
			 WHERE section_tipo = $1 AND section_id = $2 ORDER BY id DESC LIMIT 1`,
			[SECTION, RECORD_ID],
		)) as { tipo: string }[];
		expect(tmRows[0]?.tipo).toBe(TARGET);

		// A direct read via the TARGET sees the alias-written item (total 3).
		const items = await readComponentData({
			action: 'read',
			source: {
				tipo: TARGET,
				section_tipo: SECTION,
				section_id: String(RECORD_ID),
				mode: 'edit',
				lang: 'lg-nolan',
			},
		} as Rqo);
		const own = items.find((item) => item.tipo === TARGET);
		expect((own?.pagination as { total: number }).total).toBe(3);
	});
});

describe('the read guard: an alias reads as its target ONLY where the emission is alias-wired (T2-U04-a)', () => {
	const RECORD_ID = 9990002;
	const readVia = (tipo: string) =>
		readComponentData({
			action: 'read',
			source: {
				tipo,
				section_tipo: SECTION,
				section_id: String(RECORD_ID),
				mode: 'edit',
				lang: 'lg-nolan',
			},
		} as Rqo);

	beforeAll(async () => {
		await sql.unsafe(
			`INSERT INTO matrix_test (section_id, section_tipo, string, relation)
			 VALUES ($1, $2, $3::text::jsonb, $4::text::jsonb)`,
			[
				RECORD_ID,
				SECTION,
				JSON.stringify({
					[LITERAL_TARGET]: [{ id: 1, lang: 'lg-nolan', value: 'held by the target' }],
				}),
				JSON.stringify({
					[TARGET]: [
						{ type: 'dd151', section_id: 11, section_tipo: SECTION, from_component_tipo: TARGET },
					],
					[SELECT_TARGET]: [
						{
							type: 'dd151',
							section_id: 11,
							section_tipo: SECTION,
							from_component_tipo: SELECT_TARGET,
						},
					],
				}),
			],
		);
	});
	afterAll(async () => {
		await sql.unsafe('DELETE FROM matrix_test WHERE section_tipo = $1 AND section_id = $2', [
			SECTION,
			RECORD_ID,
		]);
	});

	test("RESOLVED — a LITERAL target: the alias serves the target's stored value under its own tipo", async () => {
		const own = (await readVia(LITERAL_ALIAS)).find((item) => item.tipo === LITERAL_ALIAS);
		expect(own?.entries).toEqual([{ id: 1, lang: 'lg-nolan', value: 'held by the target' }]);
	});

	test('RESOLVED — the PORTAL target through a SECTION read (the guarded emission door itself)', async () => {
		const { data } = await readSection({
			action: 'read',
			source: { tipo: SECTION, section_tipo: SECTION, mode: 'edit', lang: 'lg-nolan' },
			sqo: {
				section_tipo: [SECTION],
				filter_by_locators: [{ section_tipo: SECTION, section_id: String(RECORD_ID) }],
				limit: 1,
				offset: 0,
			},
			show: { ddo_map: [{ tipo: ALIAS, section_tipo: SECTION, parent: SECTION, mode: 'edit' }] },
		} as never);
		const own = (data as { tipo?: string; entries?: { section_id?: unknown }[] }[]).find(
			(item) => item.tipo === ALIAS,
		);
		expect(own?.entries?.map((entry) => Number(entry.section_id))).toEqual([11]);
	});

	test('REFUSED — a non-portal relation, and both emission-owning hooks: loud, typed, naming the alias', async () => {
		// Each of these would otherwise read the ALIAS's own (empty) slot and
		// answer a plausible empty component while the target holds the data.
		for (const [, model, alias] of GUARD_PAIRS.slice(1)) {
			const refusal = await refusalOf(readVia(alias));
			expect([alias, refusal.code]).toEqual([alias, 'engine.uncovered_scope']);
			expect(refusal.coordinates).toEqual({ tipo: alias, model });
		}
	});

	test('the targets themselves read normally (the refusal is the alias face, not the model)', async () => {
		const select = (await readVia(SELECT_TARGET)).find((item) => item.tipo === SELECT_TARGET);
		expect((select?.entries as unknown[] | undefined)?.length).toBe(1);
		const sectionId = (await readVia(SECTION_ID_TARGET)).find(
			(item) => item.tipo === SECTION_ID_TARGET,
		);
		expect(sectionId).toBeDefined();
	});
});
