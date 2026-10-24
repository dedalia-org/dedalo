/**
 * EVERY ONTOLOGY TLD AN INSTALLATION HOLDS CAME FROM THE RELEASE'S ONTOLOGY FILES —
 * none was materialized by the engine from repository code (2026-10-12,
 * `engineering/wire_contract/WC-2026-10-12-ddengine-removed.md`; AGENTS.md
 * "Ontology definitions belong to the MASTER ontology").
 *
 * Until 2026-10-12 the engine owned a TLD (the AI spend ledger's) defined
 * in repo code and written by the installer's restore and again at every boot. The
 * owner removed it: the engine never owns or ships an ontology definition. A spelling
 * gate ("no file named like the old door") would pin one name; this gate measures the
 * OUTCOME on a real install, so ANY door that writes a definition of its own — under
 * whatever name, in the installer or at boot — is red:
 *
 *  A. THE INSTALL. The terminal installer's own CLI (scripts/install.ts: the seed
 *     restore + completeFreshInstall, the default domain ontology from its vendored
 *     file, the declared thesauri) installs a scratch database. Then:
 *      - dd_ontology's TLD set EQUALS core ∪ the ontology files the install imported
 *        ∪ what the thesaurus step provisions for the plan's own thesauri (their
 *        TLDs + the two typology groupers) — missing or extra are both red;
 *      - every source record in matrix_ontology belongs to a TLD with a release
 *        file, and each such TLD holds exactly that file's record count (the seed
 *        is compiled from the same files) — nothing in matrix_ontology without a
 *        file behind it;
 *      - under every imported TLD, dd_ontology holds EXACTLY the parse of those
 *        source records (tipo = <tld><section_id>) plus the TLD's main node <tld>0 —
 *        so a definition written under an EXISTING TLD is red too (mutation-checked:
 *        a `dd` node inserted by completeFreshInstall).
 *  B. THE BOOT. The real server (src/server.ts) boots on that install, answers
 *     /health 200 and drains on SIGTERM; dd_ontology and matrix_ontology are
 *     BYTE-IDENTICAL before and after (an md5 over every row): boot writes no
 *     ontology at all — it is not an update lane for definitions.
 *
 * `--hierarchies none` on purpose: the thesaurus import is install_e2e's subject;
 * this gate's is provenance. The release's DECLARED thesauri still follow the plan
 * (they are pre-ticked), so the provisioning allowance is exercised.
 *
 * Skips loudly (reason in the name) without an admin role that can CREATE DATABASE.
 * Crash teardown: `<prefix><pid>` scratch DB swept on entry (test/helpers/
 * scratch_database.ts), every DROP `WITH (FORCE)`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { config } from '../../src/config/config.ts';
import { DEFAULT_DOMAIN_ONTOLOGIES } from '../../src/core/install/ontology_choice.ts';
import { VENDORED_ONTOLOGY_DIR } from '../../src/core/install/paths.ts';
import type { DbConnDescriptor } from '../../src/core/install/pg_exec.ts';
import { runPsql } from '../../src/core/install/pg_exec.ts';
import { CORE_ONTOLOGY_TLDS } from '../../src/core/ontology/core_tlds.ts';
import {
	HIERARCHY_MODEL_TYPE_TLD,
	HIERARCHY_TYPE_TLD,
} from '../../src/core/ontology/ontology_tipos.ts';
import { devServeIsolationEnv, devServeSocketArgs } from '../helpers/dev_serve_isolation.ts';
import { freeTcpPort } from '../helpers/free_tcp_port.ts';
import { markExportArtifactsRoot, markMediaRoot } from '../helpers/media_scratch_root.ts';
import { sweepOrphanScratchDatabases } from '../helpers/scratch_database.ts';
import { scratchFile } from '../helpers/scratch_dir.ts';
import { markProcessesDir } from '../helpers/test_media_root.ts';

/** The developer listener's port for every run of this file (one value: a resume compares answers). */
const DEV_PORT = freeTcpPort();

const ROOT = resolve(import.meta.dir, '../..');
const CLI = join(ROOT, 'scripts/install.ts');
const SCRATCH_PREFIX = 'dedalo_install_tldprov_';
const SCRATCH_DB = `${SCRATCH_PREFIX}${process.pid}`;
const scratchDir = mkdtempSync(join(tmpdir(), 'dedalo_tldprov_'));
// Short: macOS caps a unix socket path at 104 bytes.
const SOCKET = scratchFile('zztldprov', 'zztldprov.sock');
/** A marked media root (+ its export store sibling) under scratchDir, swept with it. */
function scratchMediaRoot(): string {
	const root = markMediaRoot(join(scratchDir, 'media'));
	markExportArtifactsRoot(`${root}.export_artifacts`);
	return root;
}

const admin: DbConnDescriptor = {
	database: 'postgres',
	host: config.db.host,
	port: config.db.port,
	user: config.db.user,
	password: config.db.password,
	socket: config.db.socket,
};
const scratchConn = (): DbConnDescriptor => ({ ...admin, database: SCRATCH_DB });

/** Decided at module top level: `test.if` reads it at collection (install_e2e header). */
async function adminCanCreateDatabase(): Promise<boolean> {
	const probe = await runPsql(admin, [
		'-tAc',
		'SELECT rolcreatedb OR rolsuper FROM pg_roles WHERE rolname = current_user',
	]);
	return probe.exitCode === 0 && probe.stdout.trim() === 't';
}
const available = await adminCanCreateDatabase();
const WHY_SKIPPED =
	'SKIPPED: no admin Postgres connection (DB_ADMIN_* unset, or the role lacks CREATEDB)';
const named = (what: string): string => (available ? what : `${what} — ${WHY_SKIPPED}`);

beforeAll(async () => {
	if (!available) return;
	await sweepOrphanScratchDatabases(admin, SCRATCH_PREFIX);
	await runPsql(admin, ['-c', `DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`]);
	const created = await runPsql(admin, ['-c', `CREATE DATABASE "${SCRATCH_DB}"`]);
	expect(created.exitCode, `CREATE DATABASE ${SCRATCH_DB}: ${created.stderr}`).toBe(0);
});

afterAll(async () => {
	if (available)
		await runPsql(admin, ['-c', `DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`]);
	rmSync(scratchDir, { recursive: true, force: true });
	rmSync(SOCKET, { force: true });
});

/** The installer's answers (no secret on argv) and its redirected writes. */
function cliArgs(): string[] {
	return [
		'--hierarchies',
		'none',
		'--db-name',
		SCRATCH_DB,
		'--db-user',
		config.db.user,
		'--db-host',
		config.db.host,
		'--db-port',
		String(config.db.port),
		...(config.db.socket === '' ? [] : ['--db-socket', config.db.socket]),
		'--entity',
		'zztldprov',
		'--skip-tools',
		// A free development port: 3500 may be a running `bun run dev` here (D3 refuses it).
		'--dev-port',
		String(DEV_PORT),
		// Its own socket: the written .env's SERVER_UNIX_SOCKET is what the serve check boots on.
		...devServeSocketArgs(),
	];
}
const installEnv = (): Record<string, string | undefined> => ({
	...process.env,
	DEDALO_INSTALL_ROOT_PASSWORD: 'Mosaic-Kestrel-Harbor-47',
	...(config.db.password ? { DEDALO_INSTALL_DB_PASSWORD: config.db.password } : {}),
	DEDALO_INSTALL_PRIVATE_DIR: scratchDir,
	DEDALO_TS_STATE_PATH: join(scratchDir, 'ts_state.json'),
	DEDALO_SESSION_DB_PATH: join(scratchDir, 'sessions.sqlite'),
	// The serve check boots this install's server (verify_dev_server): its own socket,
	// media root and processes dir — never the suite's (dev_serve_isolation.ts).
	...devServeIsolationEnv(),
});

async function scratchScalar(query: string): Promise<string> {
	const res = await runPsql(scratchConn(), ['-tAc', query]);
	expect(res.exitCode, res.stderr).toBe(0);
	return res.stdout.trim();
}

/** Records in a release ontology file (one per non-empty COPY line). */
function releaseRecordCount(tld: string): number {
	return gunzipSync(readFileSync(join(VENDORED_ONTOLOGY_DIR, `${tld}.copy.gz`)))
		.toString('utf8')
		.split('\n')
		.filter((line) => line !== '').length;
}
const hasReleaseFile = (tld: string): boolean =>
	Bun.file(join(VENDORED_ONTOLOGY_DIR, `${tld}.copy.gz`)).size > 0;

/** md5 over every row of both ontology tables, in a stable order. */
async function ontologyFingerprint(): Promise<string> {
	return scratchScalar(
		`SELECT md5(
		   (SELECT coalesce(string_agg(t::text, E'\\n' ORDER BY t.tipo), '') FROM dd_ontology t)
		   || '|' ||
		   (SELECT coalesce(string_agg(m::text, E'\\n' ORDER BY m.section_tipo, m.section_id), '') FROM matrix_ontology m))`,
	);
}

/** The plan's thesauri (what the installer itself announces it will provision). */
let planHierarchies: string[] = [];

describe('install TLD provenance', () => {
	test.if(available)(
		named('A. the installer leaves only TLDs from the release files'),
		async () => {
			const install = Bun.spawnSync([process.execPath, 'run', CLI, ...cliArgs()], {
				env: installEnv(),
				stdout: 'pipe',
				stderr: 'pipe',
			});
			const out = install.stdout.toString() + install.stderr.toString();
			expect(install.exitCode, out.slice(-3000)).toBe(0);
			expect(out).toContain('root login verified');

			const planned = Bun.spawnSync([process.execPath, 'run', CLI, ...cliArgs(), '--plan'], {
				env: installEnv(),
				stdout: 'pipe',
				stderr: 'pipe',
			});
			expect(planned.exitCode, planned.stderr.toString()).toBe(0);
			planHierarchies = (
				JSON.parse(planned.stdout.toString().trim()) as { hierarchies: string[] }
			).hierarchies.filter((tld) => tld !== '(none)');

			const imported = [...CORE_ONTOLOGY_TLDS, ...DEFAULT_DOMAIN_ONTOLOGIES];
			for (const tld of imported) expect(hasReleaseFile(tld), `${tld}.copy.gz`).toBe(true);
			const provisioned =
				planHierarchies.length > 0
					? [...planHierarchies, HIERARCHY_TYPE_TLD, HIERARCHY_MODEL_TYPE_TLD]
					: [];
			const installed = (
				await scratchScalar("SELECT string_agg(DISTINCT tld, ',' ORDER BY tld) FROM dd_ontology")
			).split(',');
			expect(installed.length).toBeGreaterThanOrEqual(imported.length);
			expect(installed).toEqual([...new Set([...imported, ...provisioned])].sort());

			// matrix_ontology: every source record sits under a TLD with a release file,
			// each TLD with exactly that file's records.
			const counts = (
				await scratchScalar(
					`SELECT string_agg(section_tipo || '=' || n, ',' ORDER BY section_tipo)
					   FROM (SELECT section_tipo, count(*) AS n FROM matrix_ontology GROUP BY section_tipo) c`,
				)
			)
				.split(',')
				.map((pair) => pair.split('=') as [string, string]);
			expect(counts.length).toBeGreaterThanOrEqual(imported.length);
			// A provisioned thesaurus's records come from the release's hierarchy.json
			// manifest (hierarchy_provision.ts); every other TLD needs its ontology file.
			const withoutSource = counts
				.map(([sectionTipo]) => sectionTipo.replace(/0$/, ''))
				.filter((tld) => !imported.includes(tld) && !provisioned.includes(tld));
			expect(withoutSource, 'matrix_ontology records with no release source behind them').toEqual(
				[],
			);
			for (const [sectionTipo, count] of counts) {
				const tld = sectionTipo.replace(/0$/, '');
				if (!imported.includes(tld)) continue;
				expect(Number(count), `${sectionTipo} records = ${tld}.copy.gz`).toBe(
					releaseRecordCount(tld),
				);
			}
			// Every imported TLD's records are there (a floor on the count walk).
			const counted = new Set(counts.map(([sectionTipo]) => sectionTipo.replace(/0$/, '')));
			expect(imported.filter((tld) => !counted.has(tld))).toEqual([]);

			// dd_ontology, ROW BY ROW, under every imported TLD: each node is the parse of
			// one matrix_ontology source record (tipo = <tld><section_id>) plus the TLD's
			// main node <tld>0 — so a definition written under an EXISTING TLD (a node
			// with no source record, or a source record never parsed) is red too, not
			// only a new TLD.
			const tldList = imported.map((tld) => `'${tld.replace(/[^a-z]/g, '')}'`).join(',');
			const drift = await scratchScalar(
				`WITH src AS (
				   SELECT regexp_replace(section_tipo, '0$', '') || section_id AS tipo
				     FROM matrix_ontology
				    WHERE regexp_replace(section_tipo, '0$', '') IN (${tldList})
				   UNION SELECT tld || '0' FROM unnest(ARRAY[${tldList}]) AS t(tld)),
				 node AS (SELECT tipo FROM dd_ontology WHERE tld IN (${tldList}))
				 SELECT coalesce(string_agg(kind || ':' || tipo, ',' ORDER BY tipo), '') FROM (
				   SELECT 'no_source' AS kind, tipo FROM node EXCEPT SELECT 'no_source', tipo FROM src
				   UNION ALL
				   (SELECT 'not_parsed', tipo FROM src EXCEPT SELECT 'not_parsed', tipo FROM node)) d`,
			);
			expect(drift, 'dd_ontology nodes vs their matrix_ontology source records').toBe('');
			// A floor: the row walk really covered the imported TLDs.
			expect(
				Number(await scratchScalar(`SELECT count(*) FROM dd_ontology WHERE tld IN (${tldList})`)),
			).toBeGreaterThan(imported.length);
		},
		600000,
	);

	test.if(available)(
		named('B. booting the real server on the install writes no ontology'),
		async () => {
			const before = await ontologyFingerprint();
			rmSync(SOCKET, { force: true });
			// The entity must come from the scratch install's own .env (the identity the
			// stdout check below proves): an inherited ENTITY (CI's hosted_env.sh exports
			// `ci_hosted`) or its legacy alias would win over the file.
			const { ENTITY: _entity, DEDALO_ENTITY: _legacyEntity, ...inherited } = process.env;
			const server = Bun.spawn([process.execPath, 'run', 'src/server.ts'], {
				cwd: ROOT,
				env: {
					...inherited,
					DEDALO_PRIVATE_DIR: scratchDir,
					DEDALO_TS_STATE_PATH: join(scratchDir, 'ts_state.json'),
					DEDALO_SESSION_DB_PATH: join(scratchDir, 'sessions.sqlite'),
					DB_NAME: SCRATCH_DB,
					// The scratch .env names this scratch install as THE application database,
					// so the suite guard (src/config/suite_database.ts rule 2) would refuse it;
					// the explicit opt-out is for exactly this disposable `<prefix><pid>` DB.
					DEDALO_TEST_DB_DISABLE: 'true',
					SERVER_UNIX_SOCKET: SOCKET,
					SERVER_TCP_PORT: '',
					DEDALO_DIFFUSION_SCHEDULER_ENABLED: 'false',
					DEDALO_MEDIA_PROCESSES_DIR: markProcessesDir(join(scratchDir, 'processes')),
					// Its OWN marked media root: an inherited DEDALO_TEST_MEDIA_ROOT is the SUITE's,
					// and this server (another database) would claim the suite's export store at
					// its boot sweep (`<root>.export_artifacts` owner marker names THIS install) —
					// every later export gate is then refused as a foreign install.
					DEDALO_TEST_MEDIA_ROOT: scratchMediaRoot(),
				},
				stdout: 'pipe',
				stderr: 'pipe',
			});
			try {
				const deadline = Date.now() + 120000;
				let status = 0;
				while (Date.now() < deadline && status !== 200) {
					try {
						status = (await fetch('http://localhost/health', { unix: SOCKET })).status;
					} catch {
						/* not listening yet */
					}
					if (server.exitCode !== null) break;
					if (status !== 200) await Bun.sleep(200);
				}
				if (status !== 200) {
					server.kill('SIGKILL');
					await server.exited;
					const stderr = await new Response(server.stderr).text();
					expect(status, `server exited ${server.exitCode}: ${stderr.slice(-3000)}`).toBe(200);
				}
				server.kill('SIGTERM');
				expect(await server.exited).toBe(0);
				const stdout = await new Response(server.stdout).text();
				expect(stdout).toContain(`(entity: zztldprov)`);
			} finally {
				if (server.exitCode === null) server.kill('SIGKILL');
			}
			expect(await ontologyFingerprint(), 'boot changed dd_ontology / matrix_ontology').toBe(
				before,
			);
		},
		180000,
	);
});
