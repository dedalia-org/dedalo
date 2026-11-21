/**
 * SURF-1 read (G1) — AN ALIAS TARGET IS AN IDENTIFIER, SO IT OBEYS THE TIPO GRAMMAR.
 *
 * WHAT WAS WRONG. `component_alias` (WC-020) re-keys every read, write and
 * search of the alias onto its TARGET: `resolveDataTipo(alias)` returns
 * `properties.alias_of`, and the search engine interpolates that value VERBATIM
 * into JSONB paths and SQL (`<alias>.string->'<target>'`, `'$.<target>[*]'`,
 * `<target>_order`). The §7.6 identifier gate validates the tipo the CALLER
 * names — the alias — never the value the ontology swaps in behind it. Two
 * readers (resolver.ts `aliasTargetTipoOf`, alias.ts `resolveAliasTargetTipo`)
 * checked only "non-empty string, target row exists, target not an alias":
 * a row planted under the tipo `zzsurf'||pg_sleep(0)||'1` exists, so the hostile
 * string came back as the alias's data tipo.
 *
 * THE CONTRACT THIS GATE PINS (CLOSURE_PLAN Step 4, SURF-1 read — R2/R3):
 * ONE reader, `aliasTargetTipoOf`, checks in order missing → grammar → absent
 * → chained, and every refusal is `ontology.invalid_node` with coordinates
 * `{tipo, alias_of: JSON.stringify(v).slice(0, 64), reason}`. The grammar
 * check runs BEFORE the row lookup, so a hostile value is refused whether or
 * not a row exists under it. alias.ts delegates to the same reader, so every
 * consumer — the data-tipo re-key, the model hop, the translatable hop and the
 * save-lang rule — refuses with `reason: 'grammar'`.
 *
 * THE SITUATION IS BUILT: scratch TLD `zzsurf`, a section, a real
 * input_text and a VALID alias of it, written through the engine's door
 * (`ensureSituation` → `upsertDdOntologyNode`). The hostile legs run INSIDE
 * one transaction that always ends in a sentinel throw: the dd_ontology CHECK
 * constraints (SURF-1 write) are dropped there first — a gate of the READ law
 * must not depend on the write law holding — the hostile rows are planted raw,
 * and everything rolls back.
 *
 * ANTI-VACUITY: the committed valid alias resolves to its target before the
 * legs run, and INSIDE the transaction a freshly planted valid alias to a
 * freshly planted target resolves too — so a refusal below is the grammar
 * check, not a reader that refuses everything.
 *
 * MUTATIONS (each must turn this gate red):
 *   M1 remove the `isValidTipo` line from `aliasTargetTipoOf` → the hostile
 *      legs return the planted value / refuse without `reason: 'grammar'`;
 *   M2 give alias.ts its own reader back (instead of delegating) → the
 *      `resolveDataTipo` / `resolveAliasTargetTipo` legs go red;
 *   M3 give the save-lang rule (resolver.ts `savesInRequestLang`, which reads
 *      the translatable AND the lang-versions flag through ONE alias hop,
 *      `dataNodeOf`) a raw `alias_of` read → the `effectiveSaveLang` legs go
 *      red. There is no separate lang-versions hop left to go unmeasured.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { gunzipSync } from 'node:zlib';
import { splitCopyRow } from '../../src/core/db/copy_text.ts';
import { readDdOntologyRow } from '../../src/core/db/dd_ontology.ts';
import { MATRIX_COPY_COLUMNS } from '../../src/core/db/matrix_write.ts';
import { sql, withTransaction } from '../../src/core/db/postgres.ts';
import { isDedaloError } from '../../src/core/errors/index.ts';
import { releaseDataFiles } from '../../src/core/install/release_files.ts';
import { ONTOLOGY_RELEASE_DIR } from '../../src/core/install/seed_sources.ts';
import {
	clearAliasCaches,
	isAliasWiredTargetModel,
	resolveAliasTargetTipo,
	resolveDataTipo,
} from '../../src/core/ontology/alias.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import { modelNameOf } from '../../src/core/ontology/machine_name.ts';
import {
	inspectOntology,
	type OntologyState,
	type OntologyWriteResult,
	rebuildOntology,
} from '../../src/core/ontology/ontology_state.ts';
import {
	ONTOLOGY_MODEL,
	ONTOLOGY_PROPERTIES,
	ONTOLOGY_TLD,
} from '../../src/core/ontology/ontology_tipos.ts';
import { getTermIdFromLocator } from '../../src/core/ontology/parser.ts';
import {
	effectiveSaveLang,
	getModelByTipo,
	getTranslatableByTipo,
	runtimeModelOfStored,
} from '../../src/core/ontology/resolver.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import {
	modelTipoNamed,
	seedMachineNameScratch,
	sweepMachineNameScratch,
} from '../helpers/machine_name_scratch.ts';

const TLD = 'zzsurf';
const SECTION = 'zzsurf1';
const TARGET = 'zzsurf2';
const ALIAS = 'zzsurf3';
/** Planted INSIDE the transaction only: a second valid pair (anti-vacuity control). */
const PLANTED_TARGET = 'zzsurf8';
const PLANTED_ALIAS = 'zzsurf9';

/** A row that EXISTS under a tipo carrying SQL — the leg the old readers passed. */
const HOSTILE_PLANTED = "zzsurf'||pg_sleep(0)||'1";
/** Values with no row behind them: each is refused for GRAMMAR, before any lookup. */
const HOSTILE_UNPLANTED = ['ZZSURF2', 'zzsurf2 ', 'section_id', `${'x'.repeat(70)}1`];

const S = situation({
	name: 'SURF-1 alias target grammar',
	tld: TLD,
	nodes: [
		{ tipo: SECTION, model: 'section', term: { 'lg-eng': 'SURF-1 alias section' } },
		{ tipo: TARGET, parent: SECTION, model: 'component_input_text', is_translatable: true },
		{
			tipo: ALIAS,
			parent: SECTION,
			model: 'component_alias',
			properties: { alias_of: TARGET },
		},
	],
});

/** The five consumers of the alias reader — every one must refuse a bad target. */
const CONSUMERS: Record<string, (tipo: string) => Promise<unknown>> = {
	resolveDataTipo: (tipo) => resolveDataTipo(tipo),
	resolveAliasTargetTipo: (tipo) => resolveAliasTargetTipo(tipo),
	getModelByTipo: (tipo) => getModelByTipo(tipo),
	getTranslatableByTipo: (tipo) => getTranslatableByTipo(tipo),
	effectiveSaveLang: (tipo) => effectiveSaveLang(tipo, 'component_input_text', 'lg-eng'),
};

type Outcome =
	| { returned: unknown }
	| { code: string; reason: unknown; alias_of: unknown; tipo: unknown };

async function outcomeOf(run: Promise<unknown>): Promise<Outcome> {
	try {
		return { returned: await run };
	} catch (error) {
		if (!isDedaloError(error)) throw error;
		const coordinates = (error.coordinates ?? {}) as Record<string, unknown>;
		return {
			code: error.code,
			reason: coordinates.reason,
			alias_of: coordinates.alias_of,
			tipo: coordinates.tipo,
		};
	}
}

/** What every consumer must answer for an alias whose alias_of is `value`. */
function grammarRefusal(value: unknown): Outcome {
	return {
		code: 'ontology.invalid_node',
		reason: 'grammar',
		alias_of: JSON.stringify(value).slice(0, 64),
		tipo: ALIAS,
	};
}

async function clearCaches(): Promise<void> {
	clearAliasCaches();
	await clearOntologyDerivedCaches();
}

/** Drop every CHECK on dd_ontology — inside the caller's rolled-back transaction only. */
async function dropIdentifierChecks(): Promise<void> {
	const rows = (await sql.unsafe(
		`SELECT conname FROM pg_constraint WHERE conrelid = 'dd_ontology'::regclass AND contype = 'c'`,
	)) as { conname: string }[];
	for (const { conname } of rows) {
		if (!/^[a-z0-9_]+$/.test(conname)) throw new Error(`unexpected constraint name ${conname}`);
		await sql.unsafe(`ALTER TABLE dd_ontology DROP CONSTRAINT "${conname}"`);
	}
}

const ROLLBACK = new Error('alias_target_grammar: sentinel rollback');

/** Run `work` in ONE transaction that never commits (DDL + plants roll back). */
async function rolledBack(work: () => Promise<void>): Promise<void> {
	await assertTestDatabase('alias_target_grammar_native');
	// Cleared BEFORE the transaction opens: inside one the hub defers the drop to
	// the commit (S1-14), so a node cached by an earlier committed read would
	// shadow the rows planted below. In-transaction reads never seed the caches.
	await clearCaches();
	try {
		await withTransaction(async () => {
			await dropIdentifierChecks();
			await work();
			throw ROLLBACK;
		});
	} catch (error) {
		if (error !== ROLLBACK) throw error;
	} finally {
		await clearCaches();
	}
}

async function plantRow(tipo: string, model: string, properties: unknown = null): Promise<void> {
	await sql.unsafe(
		`INSERT INTO dd_ontology (tipo, parent, model, tld, term, properties, is_model, is_translatable, is_main)
		 VALUES ($1, $2, $3, $4, $5::text::jsonb, $6::text::jsonb, false, true, false)`,
		[
			tipo,
			SECTION,
			model,
			TLD,
			JSON.stringify({ 'lg-eng': 'planted' }),
			properties === null ? null : JSON.stringify(properties),
		],
	);
}

async function pointAliasAt(value: unknown): Promise<void> {
	await sql.unsafe(
		`UPDATE dd_ontology SET properties = jsonb_set(COALESCE(properties, '{}'::jsonb), '{alias_of}', $1::text::jsonb)
		 WHERE tipo = $2`,
		[JSON.stringify(value), ALIAS],
	);
	await clearCaches();
}

/** Every consumer's outcome for ALIAS, keyed by consumer name. */
async function consumerOutcomes(): Promise<Record<string, Outcome>> {
	const out: Record<string, Outcome> = {};
	for (const [name, consume] of Object.entries(CONSUMERS)) {
		await clearCaches();
		out[name] = await outcomeOf(consume(ALIAS));
	}
	return out;
}

function everyConsumer(outcome: Outcome): Record<string, Outcome> {
	return Object.fromEntries(Object.keys(CONSUMERS).map((name) => [name, outcome]));
}

describe.if(DB_READY)('SURF-1 read — an alias target obeys the tipo grammar (G1)', () => {
	beforeAll(async () => {
		await assertTestDatabase('alias_target_grammar_native');
		await dropSituation(S);
		await ensureSituation(S);
		await clearCaches();
	});
	afterAll(async () => {
		expect(await dropSituation(S)).toBe(0);
		await clearCaches();
	});

	test('control: the committed valid alias re-keys onto its target', async () => {
		expect(Object.keys(CONSUMERS).length).toBeGreaterThan(4);
		expect(await resolveDataTipo(ALIAS)).toBe(TARGET);
		expect(await resolveAliasTargetTipo(ALIAS)).toBe(TARGET);
		expect(await getModelByTipo(ALIAS)).toBe('component_input_text');
		expect(await getTranslatableByTipo(ALIAS)).toBe(true);
		expect(await effectiveSaveLang(ALIAS, 'component_input_text', 'lg-eng')).toBe('lg-eng');
	});

	test('a PLANTED row under a hostile tipo is refused for grammar — every consumer', async () => {
		let observed: Record<string, Outcome> = {};
		let control: unknown = null;
		await rolledBack(async () => {
			// Anti-vacuity, inside the same transaction: a valid planted pair resolves.
			await plantRow(PLANTED_TARGET, 'component_input_text');
			await plantRow(PLANTED_ALIAS, 'component_alias', { alias_of: PLANTED_TARGET });
			await clearCaches();
			control = await resolveDataTipo(PLANTED_ALIAS);

			await plantRow(HOSTILE_PLANTED, 'component_input_text');
			await pointAliasAt(HOSTILE_PLANTED);
			observed = await consumerOutcomes();
		});
		expect(control).toBe(PLANTED_TARGET);
		expect(observed).toEqual(everyConsumer(grammarRefusal(HOSTILE_PLANTED)));
	});

	test('an UNPLANTED non-grammar value is refused for GRAMMAR, not as "absent"', async () => {
		const observed: Record<string, Record<string, Outcome>> = {};
		const expected: Record<string, Record<string, Outcome>> = {};
		await rolledBack(async () => {
			for (const value of HOSTILE_UNPLANTED) {
				await pointAliasAt(value);
				observed[value] = await consumerOutcomes();
				expected[value] = everyConsumer(grammarRefusal(value));
			}
		});
		expect(Object.keys(observed).length).toBe(HOSTILE_UNPLANTED.length);
		expect(observed).toEqual(expected);
	});
});

// ---------------------------------------------------------------------------
// T2-U04-b — AN ALIAS TARGET IS ALSO A MODEL THE ALIAS CAN BE: the wiring law.
//
// `isAliasWiredTargetModel` (ontology/alias.ts) is the ONE predicate behind the
// read guard (component_alias.test.ts pins its two verdicts at the door). An
// alias of an unwired model is not a defect the engine can serve around — every
// read of it refuses — so it must be caught where it is AUTHORED:
//   - the RELEASE gate: no component_alias of the vendored ontology
//     (install/import/ontology/<major.minor>/) points at an unwired model;
//   - the HEALTH report: inspectOntology / rebuildOntology name such an alias
//     of an installation's own ontology by source record.
// ---------------------------------------------------------------------------

const ALIAS_MODEL = 'component_alias';
const COPY_INDEX = new Map(MATRIX_COPY_COLUMNS.map((column, index) => [column, index]));

/** One node of a release package, as far as the wiring law reads it. */
interface ReleaseNode {
	modelTipo: string | null;
	aliasOf: unknown;
}

function copyJson(fields: (string | null)[], column: string): Record<string, unknown[]> | null {
	const raw = fields[COPY_INDEX.get(column) as number] ?? null;
	return raw === null ? null : (JSON.parse(raw) as Record<string, unknown[]>);
}

/** Every node record of the vendored release: tipo → its model tipo and its alias_of. */
async function releaseNodes(): Promise<{ files: number; nodes: Map<string, ReleaseNode> }> {
	const nodes = new Map<string, ReleaseNode>();
	let files = 0;
	for (const file of releaseDataFiles(ONTOLOGY_RELEASE_DIR)) {
		if (file === 'matrix_dd.copy.gz') continue; // private-list records, not nodes
		files++;
		const bytes = new Uint8Array(await Bun.file(`${ONTOLOGY_RELEASE_DIR}/${file}`).arrayBuffer());
		for (const line of gunzipSync(bytes).toString('utf8').split('\n')) {
			if (line === '') continue;
			const fields = splitCopyRow(line);
			const tld = (
				copyJson(fields, 'string')?.[ONTOLOGY_TLD]?.[0] as { value?: unknown } | undefined
			)?.value;
			if (typeof tld !== 'string' || tld === '') continue;
			const modelLocator = copyJson(fields, 'relation')?.[ONTOLOGY_MODEL]?.[0];
			const properties = (
				copyJson(fields, 'misc')?.[ONTOLOGY_PROPERTIES]?.[0] as { value?: unknown } | undefined
			)?.value as { alias_of?: unknown } | null | undefined;
			nodes.set(`${tld}${fields[COPY_INDEX.get('section_id') as number]}`, {
				modelTipo:
					modelLocator === undefined
						? null
						: await getTermIdFromLocator(
								modelLocator as Parameters<typeof getTermIdFromLocator>[0],
							),
				aliasOf: properties?.alias_of,
			});
		}
	}
	return { files, nodes };
}

/**
 * A node map's verdict: every alias; the ones the WIRING LAW refuses (`unwired`); and the
 * ones it cannot judge because the alias has no usable target in the map — no `alias_of`,
 * an absent target, a target that is itself an alias (`untargeted`: the alias reader's own
 * refusals, resolver.ts aliasTargetTipoOf).
 */
async function judgeAliases(
	nodes: ReadonlyMap<string, ReleaseNode>,
	modelNameOfTipo: (modelTipo: string) => Promise<string | null>,
): Promise<{ aliases: string[]; unwired: string[]; untargeted: string[] }> {
	const aliases: string[] = [];
	const unwired: string[] = [];
	const untargeted: string[] = [];
	for (const [tipo, node] of nodes) {
		if (node.modelTipo === null || (await modelNameOfTipo(node.modelTipo)) !== ALIAS_MODEL) {
			continue;
		}
		aliases.push(tipo);
		const target = typeof node.aliasOf === 'string' ? nodes.get(node.aliasOf) : undefined;
		const stored =
			target === undefined || target.modelTipo === null
				? null
				: await modelNameOfTipo(target.modelTipo);
		if (stored === null || stored === ALIAS_MODEL) {
			untargeted.push(tipo);
			continue;
		}
		const runtime = (await runtimeModelOfStored(node.aliasOf as string, stored)) ?? stored;
		if (!(await isAliasWiredTargetModel(runtime))) {
			unwired.push(`${tipo} → ${node.aliasOf as string}: model '${runtime}' is not alias-wired`);
		}
	}
	return { aliases, unwired, untargeted };
}

/**
 * Release aliases the wiring law CANNOT judge, each with its reason — named, exact, and
 * shrink-only (the test compares the set: a new one is red, and so is one the master
 * ontology fixed until its line is deleted here). Reported to the owner 2026-11-21.
 */
const RELEASE_UNTARGETED_ALIASES: Readonly<Record<string, string>> = {
	numisdata573:
		'unmigrated v5 alias: alias_of (numisdata560) survives only in the legacy ontology19 propiedades; its v7 properties (ontology18) state none',
	numisdata627:
		'unmigrated v5 alias: alias_of (numisdata560) survives only in the legacy ontology19 propiedades; its v7 properties (ontology18) state none',
};

describe('T2-U04-b — the alias-wiring law, one predicate', () => {
	test('the law by model class: the portal engine and the literal path are wired; nothing else', async () => {
		const verdicts: Record<string, boolean> = {};
		for (const model of [
			'component_portal',
			'component_input_text',
			'component_text_area',
			'component_date',
			'component_select',
			'component_relation_children',
			'component_filter',
			'component_dataframe',
			'component_image',
			'component_section_id',
		]) {
			verdicts[model] = await isAliasWiredTargetModel(model);
		}
		expect(verdicts).toEqual({
			component_portal: true,
			component_input_text: true,
			component_text_area: true,
			component_date: true,
			component_select: false,
			component_relation_children: false,
			component_filter: false,
			component_dataframe: false,
			component_image: false,
			component_section_id: false,
		});
	});

	test('RELEASE GATE: every component_alias of the vendored ontology targets a wired model', async () => {
		const names = new Map<string, string | null>();
		const modelNameOfTipo = async (modelTipo: string): Promise<string | null> => {
			if (!names.has(modelTipo)) {
				names.set(modelTipo, modelNameOf(await readDdOntologyRow(modelTipo)).model);
			}
			return names.get(modelTipo) ?? null;
		};
		const release = await releaseNodes();
		// Floors (measured 2026-11-21 on 7.0: 199 packages, 16k nodes, 10 aliases):
		// a scan that read nothing, or lost the alias nodes, must not pass.
		expect(release.files).toBeGreaterThanOrEqual(150);
		expect(release.nodes.size).toBeGreaterThanOrEqual(10_000);
		const verdict = await judgeAliases(release.nodes, modelNameOfTipo);
		expect(verdict.aliases.length).toBeGreaterThanOrEqual(5);
		// Floor of the JUDGED set: an alias scan that judged nothing proves nothing.
		expect(verdict.aliases.length - verdict.untargeted.length).toBeGreaterThanOrEqual(5);
		expect(verdict.unwired).toEqual([]);
		expect(verdict.untargeted.sort()).toEqual(Object.keys(RELEASE_UNTARGETED_ALIASES).sort());

		// PLANTED control through the same judge: an alias of a select, of an
		// absent target and of another alias are named; a portal alias is not.
		const alias = await modelTipoNamed(ALIAS_MODEL);
		const planted = new Map<string, ReleaseNode>([
			['zzp1', { modelTipo: await modelTipoNamed('component_select'), aliasOf: undefined }],
			['zzp2', { modelTipo: alias, aliasOf: 'zzp1' }],
			['zzp3', { modelTipo: await modelTipoNamed('component_portal'), aliasOf: undefined }],
			['zzp4', { modelTipo: alias, aliasOf: 'zzp3' }],
			['zzp5', { modelTipo: alias, aliasOf: 'zzp99' }],
			['zzp6', { modelTipo: alias, aliasOf: 'zzp4' }],
		]);
		const control = await judgeAliases(planted, modelNameOfTipo);
		expect(control.aliases).toEqual(['zzp2', 'zzp4', 'zzp5', 'zzp6']);
		expect(control.unwired).toEqual(["zzp2 → zzp1: model 'component_select' is not alias-wired"]);
		expect(control.untargeted).toEqual(['zzp5', 'zzp6']);
	}, 120_000);
});

describe.if(DB_READY)('T2-U04-b — the ontology health report names an unwired alias', () => {
	const HTLD = 'zzatw';
	const HSECTION = `${HTLD}0`;
	let state: OntologyState;
	let outcome: OntologyWriteResult;

	async function sweep(): Promise<void> {
		await assertTestDatabase('alias_target_grammar_native health sweep');
		await sweepMachineNameScratch(HTLD);
		await clearCaches();
	}

	beforeAll(async () => {
		await sweep();
		const alias = await modelTipoNamed(ALIAS_MODEL);
		const term = (value: string) => [{ id: 1, lang: 'lg-eng', value }];
		await seedMachineNameScratch(HTLD, [
			{ sectionId: 1, term: term('select'), modelTipo: await modelTipoNamed('component_select') },
			{ sectionId: 2, term: term('alias of the select'), modelTipo: alias },
			{
				sectionId: 3,
				term: term('text'),
				modelTipo: await modelTipoNamed('component_input_text'),
				translatable: false,
			},
			{ sectionId: 4, term: term('alias of the text'), modelTipo: alias },
			{ sectionId: 5, term: term('alias of nothing'), modelTipo: alias },
		]);
		// properties.alias_of lives in the record's ontology18 (component_json → misc).
		for (const [sectionId, aliasOf] of [
			[2, `${HTLD}1`],
			[4, `${HTLD}3`],
			[5, `${HTLD}99`],
		] as const) {
			await sql.unsafe(
				`UPDATE matrix_ontology SET misc = jsonb_build_object($3::text, $4::text::jsonb)
				  WHERE section_tipo = $1 AND section_id = $2`,
				[
					HSECTION,
					sectionId,
					ONTOLOGY_PROPERTIES,
					JSON.stringify([{ id: 1, value: { alias_of: aliasOf } }]),
				],
			);
		}
		await clearCaches();
		outcome = await rebuildOntology(HTLD, -1);
		state = await inspectOntology(HTLD);
	}, 60_000);

	afterAll(async () => {
		await sweep();
		const residue = (await sql.unsafe(
			`SELECT (SELECT count(*)::int FROM matrix_ontology WHERE section_tipo = $1)
			      + (SELECT count(*)::int FROM dd_ontology WHERE tld = $2) AS n`,
			[HSECTION, HTLD],
		)) as { n: number }[];
		expect(residue[0]?.n).toBe(0);
	});

	test('the alias of the select is named by source record — and only it', () => {
		expect(state.matrixNodes).toBe(5); // floor: the situation parsed
		expect(state.aliasTargetDefects).toEqual([
			{
				source: `${HSECTION}/2`,
				tipo: `${HTLD}2`,
				alias_of: `${HTLD}1`,
				targetModel: 'component_select',
			},
		]);
		expect(state.aliasTargetDefectNodes).toBe(1);
	});

	test('a WARNING channel, never drift: the tld is in sync and the rebuild message says where the fix belongs', () => {
		expect(state.drift).toEqual([]);
		expect(state.inSync).toBe(true);
		expect(outcome.ok).toBe(true);
		expect(outcome.msg).toContain(`${HSECTION}/2 ${HTLD}2 → ${HTLD}1 (component_select)`);
		expect(outcome.msg).toContain('master ontology');
		expect(outcome.msg).not.toContain(`${HTLD}4`);
	});
});
