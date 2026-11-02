/**
 * SURF-1 read (G2) — NO VALUE AN ALIAS SWAPS IN CAN REACH SEARCH SQL.
 *
 * WHAT WAS WRONG. The search engine validates the tipo the CALLER names (§7.6,
 * `assertValidTipo` / `assertValidTipoOrColumn`) and then, for a
 * component_alias (WC-020), re-keys onto `resolveDataTipo(tipo)` — the alias's
 * `properties.alias_of` — and interpolates THAT into the SQL of every builder
 * family (`<alias>.string->'<target>'`, `'$.<target>[*]'`, `relation-><target>`,
 * `<target>_order`). Three sinks took the swapped value unchecked: the filter
 * LEAF (`BuilderContext.tipo`, conform.ts), the join-path HOP (conform.ts
 * `hopDataTipo`) and the ORDER key (sql_assembler.ts `orderDataTipo`). A
 * hostile `alias_of` planted in any installed ontology package became SQL.
 *
 * THE CONTRACT (CLOSURE_PLAN Step 4, SURF-1 read — R2 + R4). Two independent
 * locks, and this gate proves EACH holds on its own:
 *  1. the ONE alias reader refuses a non-grammar target (G1's law) — so a
 *     hostile alias never resolves (the HOSTILE leg, in this process);
 *  2. the three sinks take their data tipo only from
 *     `identifier_gate.ts resolveSqlDataTipo(tipo, where)` → a branded
 *     `SqlTipo`: a value that came THROUGH an alias must pass `assertValidTipo`
 *     (never the bare-column allowance), refused `request.invalid_tipo` at
 *     `where` = `filter alias target` / `join path alias target` /
 *     `order alias target`. Proved in a CHILD process whose alias module is
 *     mocked to hand back a hostile value for a VALID alias (the SINK leg) — the
 *     reader lock is bypassed there on purpose, and `mock.module` never leaks
 *     into this suite (the backup S1–S5 child pattern).
 *
 * AND THE OTHER DIRECTION (controls): filter, order and hop through valid
 * aliases of every builder family still build and key on the TARGET; the
 * pseudo-tipo `section_id` — which `resolveDataTipo` returns unchanged, and
 * which the rsc80 fixed_filter uses — still filters and orders. A sink that
 * refused `section_id` would break that live filter (the D1 regression).
 *
 * THE SITUATION IS BUILT: scratch tld `zzsink`, one section on matrix_test,
 * one real component + one alias per builder family (string, number, date,
 * iri, json, portal), through the engine door. The hostile leg runs in one
 * transaction ending in a sentinel throw (CHECKs dropped, rows planted raw).
 *
 * MUTATIONS: removing any one of the three `resolveSqlDataTipo` uses turns
 * that child leg red; admitting the alias-swapped value through the
 * tipo-OR-column gate (instead of the tipo gate) turns the `column_*` child legs
 * red; weakening the leaf to an unconditional `assertValidTipo`
 * turns the `section_id` control red; removing the reader's grammar check
 * turns the hostile leg red.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizeClientSqo } from '../../src/core/concepts/sqo.ts';
import { sql, withTransaction } from '../../src/core/db/postgres.ts';
import { isDedaloError } from '../../src/core/errors/index.ts';
import { clearAliasCaches } from '../../src/core/ontology/alias.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import { buildSearchSql } from '../helpers/search_sql.ts';

const TLD = 'zzsink';
const SECTION = 'zzsink1';

interface Family {
	family: string;
	model: string;
	target: string;
	alias: string;
}
const FAMILIES: Family[] = [
	{ family: 'string', model: 'component_input_text', target: 'zzsink2', alias: 'zzsink12' },
	{ family: 'number', model: 'component_number', target: 'zzsink3', alias: 'zzsink13' },
	{ family: 'date', model: 'component_date', target: 'zzsink4', alias: 'zzsink14' },
	{ family: 'iri', model: 'component_iri', target: 'zzsink5', alias: 'zzsink15' },
	{ family: 'json', model: 'component_json', target: 'zzsink6', alias: 'zzsink16' },
	{ family: 'portal', model: 'component_portal', target: 'zzsink7', alias: 'zzsink17' },
];
const STRING = FAMILIES[0] as Family;
const PORTAL = FAMILIES[5] as Family;

const S = situation({
	name: 'SURF-1 search alias sinks',
	tld: TLD,
	nodes: [
		{ tipo: SECTION, model: 'section', term: { 'lg-eng': 'SURF-1 sink section' } },
		...FAMILIES.flatMap((f) => [
			{
				tipo: f.target,
				parent: SECTION,
				model: f.model,
				is_translatable: f.family === 'string',
				...(f.family === 'portal'
					? {
							properties: {
								source: {
									request_config: [
										{ sqo: { section_tipo: [{ value: [SECTION], source: 'section' }] } },
									],
								},
							},
						}
					: {}),
			},
			{
				tipo: f.alias,
				parent: SECTION,
				model: 'component_alias',
				properties: { alias_of: f.target },
			},
		]),
	],
});

// ── SQO shapes ─────────────────────────────────────────────────────────────

type Step = { section_tipo: string; component_tipo: string };
const step = (component: string): Step => ({ section_tipo: SECTION, component_tipo: component });

function leafSqo(path: Step[]): Record<string, unknown> {
	return {
		section_tipo: [SECTION],
		limit: 10,
		offset: 0,
		filter: { $and: [{ q: '', q_operator: '*', path }] },
	};
}
function sectionIdLeafSqo(): Record<string, unknown> {
	return {
		section_tipo: [SECTION],
		limit: 10,
		offset: 0,
		filter: { $and: [{ q: '1', path: [step('section_id')] }] },
	};
}
function orderSqo(path: Step[]): Record<string, unknown> {
	return { section_tipo: [SECTION], limit: 10, offset: 0, order: [{ direction: 'ASC', path }] };
}

/**
 * The built query as ONE text: SQL + bound params. Several builders bind the
 * data tipo inside a jsonpath PARAMETER (`$.<tipo>[*]…`) rather than the SQL
 * text — a hostile tipo there rewrites the jsonpath, so it is a sink too.
 */
async function build(sqo: Record<string, unknown>): Promise<string> {
	const built = await buildSearchSql(sanitizeClientSqo(sqo));
	return `${built.sql}\n${JSON.stringify(built.params)}`;
}

/**
 * A leg's verdict: built (+ whether the marker reached the SQL), or WHICH lock
 * refused it — `<code>:<reason ?? where>`. The reader lock answers
 * `ontology.invalid_node:grammar`; the sink lock `request.invalid_tipo:<where>`.
 * A bare "refused" could not tell them apart, so a leg meant to prove the
 * reader would stay green on the sink alone.
 */
async function verdict(sqo: Record<string, unknown>, marker: string): Promise<string> {
	try {
		const text = await build(sqo);
		return `built (marker ${text.includes(marker) ? 'IN' : 'not in'} SQL)`;
	} catch (error) {
		if (!isDedaloError(error)) return `untyped: ${(error as Error).message}`;
		const coordinates = (error.coordinates ?? {}) as { reason?: unknown; where?: unknown };
		return `${error.code}:${String(coordinates.reason ?? coordinates.where)}`;
	}
}

async function clearCaches(): Promise<void> {
	clearAliasCaches();
	await clearOntologyDerivedCaches();
}

const ROLLBACK = new Error('search_alias_sink: sentinel rollback');

async function rolledBack(work: () => Promise<void>): Promise<void> {
	await assertTestDatabase('search_alias_sink_native');
	await clearCaches(); // outside the tx: inside one the hub defers the drop (S1-14)
	try {
		await withTransaction(async () => {
			const rows = (await sql.unsafe(
				`SELECT conname FROM pg_constraint WHERE conrelid = 'dd_ontology'::regclass AND contype = 'c'`,
			)) as { conname: string }[];
			for (const { conname } of rows) {
				if (!/^[a-z0-9_]+$/.test(conname)) throw new Error(`unexpected constraint ${conname}`);
				await sql.unsafe(`ALTER TABLE dd_ontology DROP CONSTRAINT "${conname}"`);
			}
			await work();
			throw ROLLBACK;
		});
	} catch (error) {
		if (error !== ROLLBACK) throw error;
	} finally {
		await clearCaches();
	}
}

// ── the child (sink leg) ───────────────────────────────────────────────────

const REPO_ROOT = join(import.meta.dir, '../..');
const SINK_MARKER = 'SINKMARK';
/** An alias whose swapped value is a BARE COLUMN name: admitted by the
 * tipo-or-column gate the caller's own tipo passes, refused by the tipo gate
 * an alias-swapped value must pass (identifier_gate.ts resolveSqlDataTipo). */
const COLUMN_ALIAS = (FAMILIES[3] as Family).alias;
const CHILD_HOSTILE: Record<string, string> = {
	[STRING.alias]: `zzsink'${SINK_MARKER}1`,
	[PORTAL.alias]: `zzsink'${SINK_MARKER}2`,
	[COLUMN_ALIAS]: 'section_id',
};
const CHILD_LEGS: Record<string, Record<string, unknown>> = {
	control_leaf: leafSqo([step(FAMILIES[1]?.alias as string)]),
	leaf: leafSqo([step(STRING.alias)]),
	order: orderSqo([step(STRING.alias)]),
	hop: leafSqo([step(PORTAL.alias), step(STRING.target)]),
	column_leaf: leafSqo([step(COLUMN_ALIAS)]),
	column_order: orderSqo([step(COLUMN_ALIAS)]),
};

const CHILD_SOURCE = `import { mock } from 'bun:test';
const [aliasModule, registryModule, assemblerModule, sqoModule, legsJson, hostileJson, marker] = Bun.argv.slice(2);
// Snapshot BEFORE mocking: mock.module rewrites the live bindings of the real
// namespace too, so reading real.resolveDataTipo afterwards would recurse.
const real = { ...(await import(aliasModule)) };
const realResolveDataTipo = real.resolveDataTipo;
const hostile = JSON.parse(hostileJson);
// The reader lock bypassed ON PURPOSE: a VALID alias resolves to a hostile data tipo.
mock.module(aliasModule, () => ({
	...real,
	resolveDataTipo: async (tipo) => hostile[tipo] ?? realResolveDataTipo(tipo),
}));
await import(registryModule);
const { buildSearchSql } = await import(assemblerModule);
// The statement is opaque (search_statement.ts): read through the inspection door.
const { searchStatementText } = await import(assemblerModule.replace('sql_assembler.ts', 'search_statement.ts'));
const { sanitizeClientSqo } = await import(sqoModule);
const out = {};
for (const [name, sqo] of Object.entries(JSON.parse(legsJson))) {
	try {
		const built = searchStatementText(await buildSearchSql(sanitizeClientSqo(sqo)));
		out[name] = { built: true, marker: (built.sql + JSON.stringify(built.params)).includes(marker) };
	} catch (error) {
		out[name] = { code: error?.code ?? 'untyped', where: error?.coordinates?.where ?? null, message: String(error?.message ?? error).slice(0, 240) };
	}
}
// This child is its own process, so the stub dies with it; restored anyway, so
// the mock_isolation_tripwire's restore rule holds here as everywhere.
mock.restore();
process.stdout.write('@@SINK@@' + JSON.stringify(out) + '\\n');
process.exit(0);
`;

async function runSinkChild(): Promise<Record<string, Record<string, unknown>>> {
	const dir = mkdtempSync(join(tmpdir(), 'dedalo_surf1_sink_'));
	try {
		const childPath = join(dir, 'sink_child.ts');
		writeFileSync(childPath, CHILD_SOURCE);
		// Same environment as this process — the preloads already repointed it at
		// THIS lane's suite database; the child only reads.
		const child = Bun.spawn(
			[
				process.execPath,
				childPath,
				join(REPO_ROOT, 'src/core/ontology/alias.ts'),
				join(REPO_ROOT, 'test/preload/component_registry.ts'),
				join(REPO_ROOT, 'src/core/search/sql_assembler.ts'),
				join(REPO_ROOT, 'src/core/concepts/sqo.ts'),
				JSON.stringify(CHILD_LEGS),
				JSON.stringify(CHILD_HOSTILE),
				SINK_MARKER,
			],
			{
				cwd: REPO_ROOT,
				stdout: 'pipe',
				stderr: 'pipe',
				env: { ...(process.env as Record<string, string>) },
			},
		);
		const [exitCode, out, err] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		const line = out.split('\n').find((candidate) => candidate.startsWith('@@SINK@@'));
		if (exitCode !== 0 || line === undefined) {
			throw new Error(`sink child failed (exit ${exitCode}): ${err.slice(-2000)}`);
		}
		return JSON.parse(line.slice('@@SINK@@'.length));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe.if(DB_READY)('SURF-1 read — no alias-swapped value reaches search SQL (G2)', () => {
	beforeAll(async () => {
		await assertTestDatabase('search_alias_sink_native');
		await dropSituation(S);
		await ensureSituation(S);
		await clearCaches();
	});
	afterAll(async () => {
		expect(await dropSituation(S)).toBe(0);
		await clearCaches();
	});

	test('controls: filter + order through a valid alias of EVERY family key on the target', async () => {
		expect(FAMILIES.length).toBeGreaterThan(5);
		const observed: Record<string, string> = {};
		const expected: Record<string, string> = {};
		for (const f of FAMILIES) {
			for (const [leg, sqo, needle] of [
				['filter', leafSqo([step(f.alias)]), new RegExp(`\\b${f.target}\\b`)],
				['order', orderSqo([step(f.alias)]), new RegExp(`\\b${f.target}_order\\b`)],
			] as const) {
				const key = `${f.family} ${leg}`;
				expected[key] = 'keys on target';
				try {
					const text = await build(sqo);
					observed[key] =
						needle.test(text) && !new RegExp(`\\b${f.alias}\\b`).test(text)
							? 'keys on target'
							: `built without ${needle} (or naming the alias): ${text.slice(0, 400)}`;
				} catch (error) {
					observed[key] = `threw: ${(error as Error).message}`;
				}
			}
		}
		expect(observed).toEqual(expected);
	});

	test('controls: a portal ALIAS as a join hop builds and unnests the target key', async () => {
		const text = await build(leafSqo([step(PORTAL.alias), step(STRING.target)]));
		expect(text).toMatch(new RegExp(`\\b${PORTAL.target}\\b`));
		expect(text).not.toMatch(new RegExp(`\\b${PORTAL.alias}\\b`));
	});

	test('controls: the section_id pseudo-tipo still filters and orders (the D1 regression)', async () => {
		expect(await build(sectionIdLeafSqo())).toContain('section_id');
		expect(await build(orderSqo([step('section_id')]))).toContain('section_id');
	});

	test('HOSTILE: an alias planted onto a hostile target cannot build ANY family leaf, order or hop', async () => {
		const marker = 'SURFMARK';
		const observed: Record<string, string> = {};
		const expected: Record<string, string> = {};
		await rolledBack(async () => {
			for (const [index, f] of FAMILIES.entries()) {
				const hostile = `zzsink' OR '${marker}${index}`;
				await sql.unsafe(
					`INSERT INTO dd_ontology (tipo, parent, model, tld, term, is_model, is_translatable, is_main)
					 VALUES ($1, $2, $3, $4, $5::text::jsonb, false, false, false)`,
					[hostile, SECTION, f.model, TLD, JSON.stringify({ 'lg-eng': 'hostile' })],
				);
				await sql.unsafe(
					`UPDATE dd_ontology SET properties = jsonb_set(properties, '{alias_of}', $1::text::jsonb) WHERE tipo = $2`,
					[JSON.stringify(hostile), f.alias],
				);
			}
			for (const f of FAMILIES) {
				for (const [leg, sqo] of [
					['filter', leafSqo([step(f.alias)])],
					['order', orderSqo([step(f.alias)])],
					...(f.family === 'portal'
						? ([['hop', leafSqo([step(f.alias), step(STRING.target)])]] as const)
						: []),
				] as const) {
					const key = `${f.family} ${leg}`;
					// The READER lock, by itself: the grammar refusal of the one alias
					// reader — never the sink's request.invalid_tipo behind it.
					expected[key] = 'ontology.invalid_node:grammar';
					observed[key] = await verdict(sqo, marker);
				}
			}
		});
		expect(Object.keys(observed).length).toBeGreaterThan(12);
		expect(observed).toEqual(expected);
	});

	test('SINK (child, reader bypassed): each of the three sinks refuses the swapped value by itself', async () => {
		const results = await runSinkChild();
		const shape = (result: Record<string, unknown> | undefined) =>
			result === undefined
				? 'missing'
				: result.built === true
					? { built: true, marker: result.marker }
					: { code: result.code, where: result.where };
		expect({
			control_leaf: shape(results.control_leaf),
			leaf: shape(results.leaf),
			hop: shape(results.hop),
			order: shape(results.order),
			column_leaf: shape(results.column_leaf),
			column_order: shape(results.column_order),
		}).toEqual({
			control_leaf: { built: true, marker: false },
			leaf: { code: 'request.invalid_tipo', where: 'filter alias target' },
			hop: { code: 'request.invalid_tipo', where: 'join path alias target' },
			order: { code: 'request.invalid_tipo', where: 'order alias target' },
			column_leaf: { code: 'request.invalid_tipo', where: 'filter alias target' },
			column_order: { code: 'request.invalid_tipo', where: 'order alias target' },
		});
	}, 60_000);
});
