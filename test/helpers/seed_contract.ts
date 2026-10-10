/**
 * THE INSTALL SEED CONTENT CONTRACT — what every install is born with, asserted
 * on a database a seed was restored into. ONE implementation, two subjects:
 *  - seed_build_native.test.ts — a seed the compiler just produced;
 *  - install_seed_contract_native.test.ts — the COMMITTED seed.
 * So the artefact in the tree is held to exactly what the compiler is held to.
 *
 * Every expected count is derived from the SOURCE files (packages, seed data
 * files, SEED_RECORDS), never typed in: a source edit moves the expectation
 * with it, and a seed that does not reflect its sources is red.
 */

import { expect } from 'bun:test';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { type DbConnDescriptor, runPsql } from '../../src/core/install/pg_exec.ts';
import {
	ACTIVE_REGISTRY_SQL,
	nonCoreRegistryRows,
	type RegistryProvisionInput,
	registryBlockers,
	SEED_EMPTY_STORES,
} from '../../src/core/install/seed_build.ts';
import {
	ONTOLOGY_RELEASE_DIR,
	SEED_BUILD_MARKER_TABLE,
	SEED_LANGS_PATH,
	SEED_MIGRATIONS_DIR,
	SEED_ONTOLOGY_TLDS,
	SEED_RECORDS,
	SEED_REGISTRY_PATH,
	SEED_SHIPPED_TABLES,
} from '../../src/core/install/seed_sources.ts';
import { REGISTRY_PROVISION_INPUTS_SQL } from '../../src/core/ontology/hierarchy_state.ts';
import { DEDALO_VERSION } from '../../src/core/update/version.ts';

/** One-column `-tA` rows (a failed query fails the gate with psql's sentence). */
export async function column(conn: DbConnDescriptor, query: string): Promise<string[]> {
	const run = await runPsql(conn, ['-X', '-v', 'ON_ERROR_STOP=1', '-tAc', query]);
	expect(run.exitCode, run.stderr).toBe(0);
	return run.stdout === '' ? [] : run.stdout.split('\n');
}

const count = async (conn: DbConnDescriptor, query: string) =>
	Number((await column(conn, query))[0]);

/** Lines of a gzipped COPY source = the rows it loads. */
function sourceRows(path: string): number {
	const text = gunzipSync(readFileSync(path)).toString('utf8');
	return text === '' ? 0 : text.split('\n').filter((line) => line !== '').length;
}

/** Restore a seed into an EMPTY database exactly as written (no migrations, no engine). */
export async function restoreSeedRaw(conn: DbConnDescriptor, seedPath: string): Promise<void> {
	const plain = join(tmpdir(), `dedalo_seed_contract_${process.pid}_${Date.now()}.sql`);
	writeFileSync(plain, gunzipSync(readFileSync(seedPath)));
	try {
		const run = await runPsql(conn, ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', plain]);
		expect(run.exitCode, run.stderr).toBe(0);
	} finally {
		rmSync(plain, { force: true });
	}
}

/** Assert the whole contract on a database a seed was restored into. */
export async function assertSeedContract(conn: DbConnDescriptor): Promise<void> {
	// Ontology: exactly the shipped TLDs, every package row, nothing of the test TLD.
	expect(await column(conn, 'SELECT DISTINCT tld FROM dd_ontology ORDER BY 1')).toEqual(
		[...SEED_ONTOLOGY_TLDS].sort(),
	);
	const packageRows = SEED_ONTOLOGY_TLDS.reduce(
		(sum, tld) => sum + sourceRows(join(ONTOLOGY_RELEASE_DIR, `${tld}.copy.gz`)),
		0,
	);
	expect(packageRows).toBeGreaterThan(3000);
	expect(await count(conn, 'SELECT count(*) FROM matrix_ontology')).toBe(packageRows);
	expect(
		await column(conn, 'SELECT DISTINCT section_tipo FROM matrix_ontology ORDER BY 1'),
	).toEqual(SEED_ONTOLOGY_TLDS.map((tld) => `${tld}0`).sort());
	// One dd_ontology node per package row + one root node per TLD.
	expect(await count(conn, 'SELECT count(*) FROM dd_ontology')).toBe(
		packageRows + SEED_ONTOLOGY_TLDS.length,
	);
	expect(await count(conn, 'SELECT count(*) FROM matrix_dd')).toBe(
		sourceRows(join(ONTOLOGY_RELEASE_DIR, 'matrix_dd.copy.gz')),
	);
	// The registry of ontologies: every shipped TLD, once — no test, no domain TLD.
	expect(
		await column(
			conn,
			`SELECT string->'hierarchy6'->0->>'value' FROM matrix_ontology_main ORDER BY 1`,
		),
	).toEqual([...SEED_ONTOLOGY_TLDS].sort());

	// Languages + hierarchy registry: every source row, the CORE rows only (lg —
	// optional thesauri are activated from hierarchy.json), each activatable and inactive.
	expect(await count(conn, 'SELECT count(*) FROM matrix_langs')).toBe(sourceRows(SEED_LANGS_PATH));
	expect(await count(conn, 'SELECT count(*) FROM matrix_hierarchy_main')).toBe(
		sourceRows(SEED_REGISTRY_PATH),
	);
	const [registry = '[]'] = await column(conn, REGISTRY_PROVISION_INPUTS_SQL);
	const registryInputs = JSON.parse(registry) as RegistryProvisionInput[];
	expect(registryInputs.length, 'the core registry rows ship').toBeGreaterThan(0);
	expect(nonCoreRegistryRows(registryInputs)).toEqual([]);
	expect(registryBlockers(registryInputs)).toEqual([]);
	expect(await column(conn, ACTIVE_REGISTRY_SQL)).toEqual([]);

	// The canonical records, column for column, and nothing else in their tables.
	for (const table of new Set(SEED_RECORDS.map((record) => record.table))) {
		const expected = SEED_RECORDS.filter((record) => record.table === table);
		const rows = await column(
			conn,
			`SELECT json_build_object('section_id', section_id, 'section_tipo', section_tipo, 'data', data,
			        'relation', relation, 'string', string, 'date', date, 'meta', meta)::text
			 FROM "${table}" ORDER BY section_id`,
		);
		expect(rows.length, table).toBe(expected.length);
		const sorted = [...expected].sort((a, b) => a.section_id - b.section_id);
		rows.forEach((row, at) => {
			const record = sorted[at];
			const stored = JSON.parse(row) as Record<string, unknown>;
			for (const key of ['data', 'relation', 'string', 'date', 'meta'] as const) {
				expect(
					stored[key],
					`${table} ${record?.section_tipo}/${record?.section_id} ${key}`,
				).toEqual(record?.[key] ?? null);
			}
		});
	}
	// Root is born WITHOUT a password — the installer sets it.
	expect(
		await column(conn, `SELECT string->'dd133' FROM matrix_users WHERE section_id = -1`),
	).toEqual(['[]']);
	// The data version: one row, this engine's.
	expect(await column(conn, `SELECT data->>'dedalo_version' FROM matrix_updates`)).toEqual([
		DEDALO_VERSION,
	]);

	// Everything that does not ship is empty.
	const tables = await column(conn, `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
	const empty = tables.filter((table) => !(table in SEED_SHIPPED_TABLES));
	expect(empty.length).toBeGreaterThan(15);
	for (const table of empty)
		expect(await count(conn, `SELECT count(*) FROM "${table}"`), table).toBe(0);

	// The search stores ship EMPTY (they fill at the install's first boot, in its
	// locale) — already covered above, asserted by name so a store that moved
	// into SEED_SHIPPED_TABLES cannot slip past.
	for (const store of SEED_EMPTY_STORES) {
		expect(await count(conn, `SELECT count(*) FROM "${store}"`), store).toBe(0);
	}

	// Only a shipped table's own id sequence has been called; every other starts at 1.
	const called = await column(
		conn,
		`SELECT sequencename FROM pg_sequences WHERE schemaname = 'public' AND last_value IS NOT NULL ORDER BY 1`,
	);
	expect(called.length).toBeGreaterThan(5);
	expect(
		called.filter(
			(name) => !Object.keys(SEED_SHIPPED_TABLES).some((table) => name === `${table}_id_seq`),
		),
	).toEqual([]);

	// The NOT VALID constraints are EXACTLY the ones the migrations add NOT VALID:
	// the seed's schema is schema.sql + the migrations (the boot self-heals reproduce
	// that shape), never a stricter or a looser one.
	const migrationNotValid = readdirSync(SEED_MIGRATIONS_DIR)
		.filter((name) => name.endsWith('.sql'))
		.flatMap((name) => [
			...readFileSync(join(SEED_MIGRATIONS_DIR, name), 'utf8').matchAll(
				/ADD\s+CONSTRAINT\s+([a-z_][a-z0-9_]*)[^;]*?\bNOT\s+VALID\s*;/gi,
			),
		])
		.map((match) => match[1] as string)
		.sort();
	expect(migrationNotValid.length).toBeGreaterThan(0);
	expect(
		await column(
			conn,
			`SELECT conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
			 WHERE n.nspname = 'public' AND NOT convalidated ORDER BY 1`,
		),
	).toEqual(migrationNotValid);

	// None of the compiler's, the suite's or the engine's own machinery; declared extensions only.
	expect(tables.filter((table) => table.startsWith('dedalo_'))).toEqual([]);
	expect(tables).not.toContain(SEED_BUILD_MARKER_TABLE);
	const sequences = await column(
		conn,
		`SELECT sequencename FROM pg_sequences WHERE schemaname = 'public'`,
	);
	expect(sequences.length).toBeGreaterThan(10);
	expect(sequences.filter((name) => name.startsWith('dedalo_'))).toEqual([]);
	expect(await column(conn, 'SELECT extname FROM pg_extension ORDER BY 1')).toEqual([
		'btree_gin',
		'pg_trgm',
		'plpgsql',
		'unaccent',
	]);
}
