/**
 * ONE-TIME BOOTSTRAP (2026-10-09): extract the install seed's repo-owned sources
 * from the seed that was vendored before the compiler existed.
 *
 *   bun run scripts/seed_bootstrap_extract.ts [<git rev>]   (default HEAD)
 *
 * Kept as PROVENANCE, never run again: from then on the sources ARE the record
 * (src/core/install/seed_sources.ts) and the seed is compiled from them
 * (`bun run seed:build`). It reads the seed FROM GIT (`<rev>:install/db/
 * dedalo_install.pgsql.gz` — the trusted, committed seed that passes
 * install_e2e), never the working-tree file: that file may already be one a
 * build wrote from an installation's database (measured 2026-10-09 — the first
 * run read exactly such a file).
 *
 * What it writes (install/db/seed/):
 *  - schema.sql — that seed's schema WITH every current migration applied, the
 *    TS-owned `dedalo_*` tables and the v6 orphan sequences (owned by no table,
 *    used by no column default) left out; pg_dump's per-run noise stripped;
 *  - matrix_langs.copy.gz — the Languages terms (MATRIX_COPY_COLUMNS, id order);
 *  - dd_ontology_scaffold.copy.gz — the parser scaffold (seed_sources.ts
 *    SEED_SCAFFOLD_PATH): the ontology TLD's nodes + the model nodes;
 *  - matrix_hierarchy_main.copy.gz — the hierarchy registry cut to the CORE
 *    hierarchies (hierarchy_meta.ts CORE_HIERARCHIES: `lg`), every record set
 *    INACTIVE (hierarchy4/hierarchy125 → dd64/2, minted INT), and refused if any
 *    record fails the activation rule (provisionBlocker). Until 2026-10-10 the
 *    cut was the 150 TLDs of a retired hand-written list; since
 *    then an optional thesaurus's registry row is written at activation from
 *    its install/import/hierarchy/hierarchy.json entry
 *    (WC-2026-10-10-hierarchy-json-manifest), so the seed ships the core only.
 * The work happens in a scratch database it creates and marks
 * (`dedalo_seed_extract_<pid>`), dropped at the end; no installation's
 * database is read.
 */

import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { projectRoot } from '../src/config/env.ts';
import { ddOntologyScaffoldQuery } from '../src/core/db/dd_ontology.ts';
import { MATRIX_COPY_COLUMNS } from '../src/core/db/matrix_write.ts';
import { CORE_HIERARCHIES } from '../src/core/install/hierarchy_meta.ts';
import { resolvePgBinary } from '../src/core/install/pg_bin.ts';
import { connArgs, connFromConfig, pgClientEnv, runPsql } from '../src/core/install/pg_exec.ts';
import {
	applyMigrationFiles,
	createScratch,
	dropScratch,
	type RegistryProvisionInput,
	registryBlockers,
} from '../src/core/install/seed_build.ts';
import {
	DD_ONTOLOGY_SCAFFOLD_COLUMNS,
	SEED_LANGS_PATH,
	SEED_ONTOLOGY_TLDS,
	SEED_REGISTRY_PATH,
	SEED_SCAFFOLD_PATH,
	SEED_SCHEMA_PATH,
} from '../src/core/install/seed_sources.ts';
import { REGISTRY_PROVISION_INPUTS_SQL } from '../src/core/ontology/hierarchy_state.ts';
import { gzipStreamToFile } from '../src/core/ontology/recovery_file.ts';

const conn = connFromConfig();

async function psql(database: string, args: string[], stdin?: string): Promise<string> {
	const run = await runPsql(conn, ['-X', '-q', '-v', 'ON_ERROR_STOP=1', ...args], {
		database,
		...(stdin === undefined ? {} : { stdin }),
	});
	if (run.exitCode !== 0) throw new Error(run.stderr || `psql exit ${run.exitCode}`);
	return run.stdout;
}

/** Sequences no table owns and no column default uses (v6 leftovers). */
const ORPHAN_SEQUENCES_SQL = `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
	WHERE n.nspname = 'public' AND c.relkind = 'S'
	  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
	                  AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a','i'))
	  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_attrdef'::regclass AND d.refobjid = c.oid)
	ORDER BY 1`;

/** pg_dump's per-run noise (the random \\restrict key, dated header lines). */
const DUMP_NOISE =
	/^(?:\\restrict .*|\\unrestrict .*|-- Dumped from database version .*|-- Dumped by pg_dump version .*|-- Started on .*|-- Completed on .*)$/;

async function dumpSchema(database: string): Promise<string> {
	const dump = Bun.spawn(
		[
			resolvePgBinary('pg_dump'),
			`--dbname=${database}`,
			...connArgs(conn),
			'--schema-only',
			'--no-owner',
			'--no-privileges',
			'--exclude-table=public.dedalo_*',
		],
		{ stdout: 'pipe', stderr: 'pipe', env: pgClientEnv(conn) },
	);
	const [code, out, err] = await Promise.all([
		dump.exited,
		new Response(dump.stdout).text(),
		new Response(dump.stderr).text(),
	]);
	if (code !== 0) throw new Error(`pg_dump --schema-only: ${err}`);
	return out
		.split('\n')
		.filter((line) => !DUMP_NOISE.test(line))
		.join('\n');
}

/** `\copy (<query>) TO` a gzip file; a bare table name = its MATRIX_COPY_COLUMNS in id order. */
async function copyOut(database: string, table: string, target: string): Promise<void> {
	const columns = MATRIX_COPY_COLUMNS.join(', ');
	const query = table.startsWith('(') ? table : `(SELECT ${columns} FROM ${table} ORDER BY id)`;
	const child = Bun.spawn(
		[
			resolvePgBinary('psql'),
			`--dbname=${database}`,
			...connArgs(conn),
			'-X',
			'-v',
			'ON_ERROR_STOP=1',
			'-c',
			`\\copy ${query.replace(/\s+/g, ' ')} TO pstdout`,
		],
		{ stdout: 'pipe', stderr: 'pipe', env: pgClientEnv(conn) },
	);
	const [, code, err] = await Promise.all([
		gzipStreamToFile(child.stdout, target),
		child.exited,
		new Response(child.stderr).text(),
	]);
	if (code !== 0) throw new Error(`copy out ${table}: ${err}`);
}

const rev = process.argv[2] ?? 'HEAD';
const seedInGit = `${rev}:install/db/dedalo_install.pgsql.gz`;
const shown = Bun.spawnSync(['git', 'show', seedInGit], {
	cwd: projectRoot,
	stdout: 'pipe',
	stderr: 'pipe',
});
if (shown.exitCode !== 0) throw new Error(`git show ${seedInGit}: ${shown.stderr.toString()}`);
const commit = Bun.spawnSync(['git', 'rev-parse', rev], { cwd: projectRoot, stdout: 'pipe' })
	.stdout.toString()
	.trim();
console.log(`source: ${seedInGit} (${commit})`);

const scratch = await createScratch(conn, `dedalo_seed_extract_${process.pid}`, 'extract');
const restoreFile = join(tmpdir(), `dedalo_seed_extract_${process.pid}.sql`);
try {
	writeFileSync(restoreFile, gunzipSync(shown.stdout));
	await psql(scratch.name, ['-f', restoreFile]);
	const migrations = await applyMigrationFiles(conn, scratch.name);
	console.log(`restored the vendored seed + ${migrations} migrations into ${scratch.name}`);

	const orphans = (await psql(scratch.name, ['-tAc', ORPHAN_SEQUENCES_SQL]))
		.split('\n')
		.filter(Boolean);
	if (orphans.length > 0) {
		await psql(scratch.name, ['-c', orphans.map((name) => `DROP SEQUENCE "${name}";`).join(' ')]);
	}
	console.log(`dropped ${orphans.length} orphan sequence(s): ${orphans.join(', ')}`);

	const allowed = CORE_HIERARCHIES.map((meta) => meta.tld.toLowerCase());
	if (allowed.length === 0 || allowed.some((tld) => !/^[a-z]+$/.test(tld))) {
		throw new Error('CORE_HIERARCHIES is empty or not bare TLDs');
	}
	await psql(scratch.name, [
		'-1',
		'-c',
		`DELETE FROM matrix_hierarchy_main WHERE lower(COALESCE(string->'hierarchy6'->0->>'value', '')) NOT IN (${allowed.map((tld) => `'${tld}'`).join(',')});
		 UPDATE matrix_hierarchy_main SET relation = COALESCE(relation, '{}'::jsonb) || jsonb_build_object(
			'hierarchy4', jsonb_build_array(jsonb_build_object('id', 1, 'type', 'dd151', 'section_id', 2, 'section_tipo', 'dd64', 'from_component_tipo', 'hierarchy4')),
			'hierarchy125', jsonb_build_array(jsonb_build_object('id', 1, 'type', 'dd151', 'section_id', 2, 'section_tipo', 'dd64', 'from_component_tipo', 'hierarchy125')));`,
	]);
	const blocked = registryBlockers(
		JSON.parse(
			(await psql(scratch.name, ['-tAc', REGISTRY_PROVISION_INPUTS_SQL])) || '[]',
		) as RegistryProvisionInput[],
	);
	if (blocked.length > 0)
		throw new Error(`registry records activation would refuse: ${blocked.join('; ')}`);

	// The parser scaffold: the ontology TLD's nodes + the model nodes, shipped TLDs only.
	await copyOut(
		scratch.name,
		ddOntologyScaffoldQuery(DD_ONTOLOGY_SCAFFOLD_COLUMNS, SEED_ONTOLOGY_TLDS),
		SEED_SCAFFOLD_PATH,
	);
	writeFileSync(SEED_SCHEMA_PATH, await dumpSchema(scratch.name));
	await copyOut(scratch.name, 'matrix_langs', SEED_LANGS_PATH);
	await copyOut(scratch.name, 'matrix_hierarchy_main', SEED_REGISTRY_PATH);
	console.log(`wrote ${SEED_SCHEMA_PATH}, ${SEED_LANGS_PATH}, ${SEED_REGISTRY_PATH}`);
} finally {
	rmSync(restoreFile, { force: true });
	await dropScratch(conn, scratch);
}
process.exit(0);
