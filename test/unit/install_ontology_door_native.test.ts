/**
 * THE INSTALLER'S ONTOLOGY DOOR, driven for real on the suite database
 * (installer unification A4/A5/A6 — src/core/install/ontology_install.ts +
 * ontology_catalog.ts + ontology_archive.ts, over the update panel's shared
 * lower layer importStagedOntologyFiles).
 *
 * THE SITUATION IS BUILT, never read from the ambient DB: three scratch TLDs
 * packaged by src/core/test_data/ontology_package_fixture.ts —
 *   zzjb  a model provider (its node zzjb2 IS a model), declares core only;
 *   zzja  a domain whose nodes take their model from zzjb, declares [dd, zzjb];
 *         + one planted GRAFT (a parent in an absent TLD) and one planted
 *         DIFFUSION relation (from a node whose model descends from the
 *         diffusion grouper — picked from this database's model tree);
 *   zzjc  declares NOTHING (the older-server case) and takes its model from an
 *         absent TLD.
 * The remote source is a loopback Bun.serve STAND-IN answering the manifest
 * envelope and serving the files — never the official server.
 *
 * WHAT IS MEASURED (outcomes):
 *  (a) remote: the closure installs zzjb BEFORE zzja (zzja's model resolves
 *      only then), ACTIVE order, dd_ontology rows for both, ZERO dangling
 *      dependency references, the planted graft/diffusion classified soft;
 *  (b) undeclared: the warning names zzjc, only zzjc is installed, and the
 *      verification reports its unresolved model reference;
 *  (c) a local directory and a .tgz of it (system tar) install the same
 *      nodes; unsafe archive entries (`..`, absolute, symlink) are refused;
 *  (d) preflight: a stopped stand-in, a corrupt COPY arity and a version
 *      mismatch refuse BEFORE the database is touched;
 *  (e) a staged file changed after staging → install.state_conflict;
 *  (f) matrix_dd: the source's private lists (this database's own rows + one zz
 *      row) replace the table — count +1, every existing row intact;
 *  (g) the DECLARATION ROUND TRIP: after (a) this server's own export census
 *      (getActiveOntologies) answers the dependencies the stand-in declared
 *      (hierarchy60 written by the shared import layer — a LAN master that
 *      imports re-serves them), and after (b) the undeclared zzjc stays
 *      undeclared (nothing computed, nothing written).
 * Around EVERY case the non-zz ontology census (dd_ontology, matrix_ontology,
 * the registry, matrix_dd) is unchanged, and the zz rows are swept.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { encodeCopyField } from '../../src/core/db/copy_text.ts';
import {
	readDdOntologyModelParents,
	readDdOntologyReferenceRows,
	readDdOntologyRow,
} from '../../src/core/db/dd_ontology.ts';
import { MATRIX_COPY_COLUMNS } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { isDedaloError } from '../../src/core/errors/index.ts';
import { resolveOntologyCatalog } from '../../src/core/install/ontology_catalog.ts';
import {
	activeOntologyTldsOf,
	closeOntologyChoice,
	type OntologyCatalog,
	type OntologySource,
	ontologyInstallRequest,
} from '../../src/core/install/ontology_choice.ts';
import {
	installOntologies,
	stageOntologies,
	verifyInstalledOntologyReferences,
} from '../../src/core/install/ontology_install.ts';
import { connFromConfig, runPsql } from '../../src/core/install/pg_exec.ts';
import { CORE_ONTOLOGY_TLDS, isCoreOntologyTld } from '../../src/core/ontology/core_tlds.ts';
import { getActiveOntologies } from '../../src/core/ontology/data_io.ts';
import {
	classifyReference,
	diffusionModelSet,
	referencesOfRows,
} from '../../src/core/ontology/ontology_references.ts';
import {
	DIFFUSION_MODEL_ROOT,
	HIERARCHY_TLD,
	ONTOLOGY_MAIN_SECTION,
} from '../../src/core/ontology/ontology_tipos.ts';
import { getTldFromTipo } from '../../src/core/ontology/tld.ts';
import {
	buildOntologyPackage,
	type FixtureOntologyTld,
} from '../../src/core/test_data/ontology_package_fixture.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { DEDALO_VERSION_MAJOR_MINOR } from '../../src/core/update/version.ts';

const ZZ_LIKE = 'zzj%';
const ZZ_TLDS = ['zzja', 'zzjb', 'zzjc'];

let coreModel = '';
let diffusionModel = '';
const roots: string[] = [];
const servers: { stop: () => void }[] = [];

function scratchDir(name: string): string {
	const dir = mkdtempSync(join(tmpdir(), `zzj_${name}_`));
	roots.push(dir);
	// confinedPath rejects any resolved path carrying whitespace or quotes.
	expect(/[\s'"\\]/.test(dir)).toBe(false);
	return dir;
}

// ── the fixture ontologies ───────────────────────────────────────────────────

function zzjb(): FixtureOntologyTld {
	return {
		tld: 'zzjb',
		name: 'zz model provider',
		typologyId: 8,
		typologyName: 'Catalog',
		dependencies: [{ tld: 'dd', main: 'ontology35', mandatory: true }],
		nodes: [
			{ id: 1, parent: 'zzjb0', model: coreModel, term: 'zz models' },
			{ id: 2, parent: 'zzjb1', model: coreModel, term: 'zz_model_b', isModel: true },
		],
	};
}

function zzja(): FixtureOntologyTld {
	return {
		tld: 'zzja',
		name: 'zz domain',
		typologyId: 8,
		typologyName: 'Catalog',
		dependencies: [
			{ tld: 'dd', main: 'ontology35', mandatory: true },
			{ tld: 'zzjb', main: 'ontology35', mandatory: true },
		],
		nodes: [
			{ id: 1, parent: 'zzja0', model: 'zzjb2', term: 'zz domain root' },
			{ id: 2, parent: 'zzja1', model: 'zzjb2', term: 'zz domain node', relations: ['zzja1'] },
			// planted GRAFT: hung under a node of an absent TLD
			{ id: 8, parent: 'zzjz5', model: coreModel, term: 'zz graft' },
			// planted DIFFUSION relation: names something absent, from a diffusion-model node
			{ id: 9, parent: 'zzja1', model: diffusionModel, term: 'zz alias', relations: ['zzjz9'] },
		],
	};
}

function zzjc(): FixtureOntologyTld {
	return {
		tld: 'zzjc',
		name: 'zz undeclared',
		typologyId: 8,
		typologyName: 'Catalog',
		// dependencies OMITTED: the older-server case
		nodes: [{ id: 1, parent: 'zzjc0', model: 'zzjy3', term: 'zz orphan' }],
	};
}

function writePackage(dir: string, files: Map<string, Uint8Array>): string {
	mkdirSync(dir, { recursive: true });
	for (const [name, bytes] of files) writeFileSync(join(dir, name), bytes);
	return dir;
}

// ── the loopback stand-in master ─────────────────────────────────────────────

function standIn(files: Map<string, Uint8Array>): { source: OntologySource; stop: () => void } {
	let origin = '';
	const server = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		fetch(request) {
			const url = new URL(request.url);
			if (request.method === 'POST' && url.pathname === '/api/') {
				const info = JSON.parse(Buffer.from(files.get('ontology.json') as Uint8Array).toString());
				const list = [...files.keys()]
					.filter((name) => name.endsWith('.copy.gz'))
					.map((name) => {
						const tld = name.slice(0, -'.copy.gz'.length);
						return { tld, section_tipo: `${tld}0`, url: `${origin}/files/${name}` };
					});
				return Response.json({ ok: true, request_id: 'zzj', data: { info, files: list } });
			}
			const body = files.get(url.pathname.split('/').pop() ?? '');
			return body === undefined
				? new Response('nope', { status: 404 })
				: new Response(new Blob([Buffer.from(body)]));
		},
	});
	origin = `http://127.0.0.1:${server.port}`;
	const handle = { stop: () => server.stop(true) };
	servers.push(handle);
	return {
		source: {
			kind: 'server',
			server: { name: 'zzj stand-in', url: `${origin}/api/`, code: 'zzj' },
		},
		stop: handle.stop,
	};
}

async function serverCatalog(source: OntologySource): Promise<OntologyCatalog> {
	const url = source.kind === 'server' ? source.server.url : '';
	return (await resolveOntologyCatalog(source, { allowedServers: [{ url }] })).catalog;
}

// ── census + sweep ───────────────────────────────────────────────────────────

const one = async (query: Promise<unknown>): Promise<string> =>
	String((((await query) as { c: unknown }[])[0] as { c: unknown }).c);

/** Rows OUTSIDE the scratch surface — these must never move. */
async function nonScratchCensus(): Promise<Record<string, string>> {
	return {
		ddOntology: await one(
			sql`SELECT count(*)::int AS c FROM dd_ontology WHERE coalesce(tld, '') NOT LIKE ${ZZ_LIKE}`,
		),
		matrixOntology: await one(
			sql`SELECT count(*)::int AS c FROM matrix_ontology WHERE section_tipo NOT LIKE ${ZZ_LIKE}`,
		),
		registry: await one(
			sql`SELECT count(*)::int AS c FROM matrix_ontology_main
			     WHERE coalesce(string->${HIERARCHY_TLD}->0->>'value', '') NOT LIKE ${ZZ_LIKE}`,
		),
		matrixDd: await one(sql`SELECT md5(coalesce(string_agg(
				section_tipo || '/' || section_id || coalesce(data::text, '') || coalesce(relation::text, '') || coalesce(string::text, ''),
				'|' ORDER BY section_tipo, section_id), '')) AS c
			FROM matrix_dd WHERE section_tipo NOT LIKE ${ZZ_LIKE}`),
	};
}

async function scratchTipos(): Promise<string[]> {
	const rows =
		(await sql`SELECT tipo FROM dd_ontology WHERE tld LIKE ${ZZ_LIKE} ORDER BY tipo`) as {
			tipo: string;
		}[];
	return rows.map((row) => row.tipo);
}

/** Remove every scratch row the door can mint (registry TM rows included). */
async function sweep(): Promise<void> {
	const registry = (await sql`SELECT section_id FROM matrix_ontology_main
		WHERE section_tipo = ${ONTOLOGY_MAIN_SECTION}
		  AND coalesce(string->${HIERARCHY_TLD}->0->>'value', '') LIKE ${ZZ_LIKE}`) as {
		section_id: number;
	}[];
	const ids = registry.map((row) => String(row.section_id)).join(',');
	if (ids !== '') {
		await sql`DELETE FROM matrix_time_machine WHERE section_tipo = ${ONTOLOGY_MAIN_SECTION}
			AND section_id = ANY(string_to_array(${ids}, ',')::int[])`;
		await sql`DELETE FROM matrix_ontology_main WHERE section_tipo = ${ONTOLOGY_MAIN_SECTION}
			AND section_id = ANY(string_to_array(${ids}, ',')::int[])`;
	}
	await sql`DELETE FROM matrix_ontology WHERE section_tipo LIKE ${ZZ_LIKE}`;
	await sql`DELETE FROM dd_ontology WHERE tld LIKE ${ZZ_LIKE}`;
	await sql`DELETE FROM matrix_dd WHERE section_tipo LIKE ${ZZ_LIKE}`;
	await sql`DELETE FROM matrix_time_machine WHERE section_tipo LIKE ${ZZ_LIKE}`;
	const { clearOntologyDerivedCaches } = await import(
		'../../src/core/ontology/cache_invalidation.ts'
	);
	await clearOntologyDerivedCaches();
}

/** Run one case with the non-zz census held and the zz rows swept after. */
async function guarded(work: () => Promise<void>): Promise<void> {
	const before = await nonScratchCensus();
	try {
		await work();
	} finally {
		await sweep();
		expect(await nonScratchCensus()).toEqual(before);
		expect(await scratchTipos()).toEqual([]);
	}
}

async function refusalOf(work: () => Promise<unknown>): Promise<{ code: string; message: string }> {
	try {
		await work();
	} catch (error) {
		if (isDedaloError(error)) return { code: error.code, message: error.message };
		throw error;
	}
	throw new Error('expected a refusal');
}

/** Stage + install `chosen` from `catalog` (the CLI's order of calls). */
async function installChosen(chosen: string[], catalog: OntologyCatalog) {
	const closure = closeOntologyChoice(chosen, catalog);
	expect(closure.errors).toEqual([]);
	const request = ontologyInstallRequest(closure.order, catalog);
	const stagingDir = scratchDir('staging');
	const staged = await stageOntologies(request, { stagingDir });
	const installed = await installOntologies({ stagingDir, userId: -1 });
	return { closure, request, staged, installed, stagingDir };
}

/**
 * The scratch TLDs' declared dependencies as THIS server's export census reads
 * them back (getActiveOntologies — what ontology.json serves); null = no key.
 */
async function censusDependencies(): Promise<Record<string, unknown[] | null>> {
	const census = await getActiveOntologies();
	const found: Record<string, unknown[] | null> = {};
	for (const entry of census.ontologies.filter((item) => ZZ_TLDS.includes(item.tld))) {
		found[entry.tld] = Object.hasOwn(entry, 'dependencies') ? (entry.dependencies ?? null) : null;
	}
	expect(census.errors.filter((line) => line.includes('zzj'))).toEqual([]);
	return found;
}

/** What landed: every zz node's structural projection. */
async function landed(): Promise<unknown[]> {
	return (await readDdOntologyReferenceRows(ZZ_TLDS)).sort((a, b) => a.tipo.localeCompare(b.tipo));
}

beforeAll(async () => {
	await assertTestDatabase('install_ontology_door_native');
	await sweep();
	const models = await readDdOntologyModelParents();
	const diffusion = diffusionModelSet(models);
	const fits = (tipo: string) => tipo.length <= 8 && isCoreOntologyTld(getTldFromTipo(tipo) ?? '');
	diffusionModel = [...diffusion].find((tipo) => tipo !== DIFFUSION_MODEL_ROOT && fits(tipo)) ?? '';
	coreModel =
		models.map((row) => row.tipo).find((tipo) => fits(tipo) && !diffusion.has(tipo)) ?? '';
	expect(diffusionModel).not.toBe('');
	expect(coreModel).not.toBe('');
});

afterAll(async () => {
	for (const server of servers) server.stop();
	await sweep();
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('the installer ontology door (suite DB, zz TLDs)', () => {
	test('(a) remote stand-in: declared closure, deps first, zero dangling, soft refs soft', async () => {
		await guarded(async () => {
			const stand = standIn(buildOntologyPackage([zzja(), zzjb(), zzjc()]));
			const catalog = await serverCatalog(stand.source);
			const { closure, request, staged, installed, stagingDir } = await installChosen(
				['zzja'],
				catalog,
			);
			expect(closure.order).toEqual(['zzjb', 'zzja']);
			expect(closure.notes).toEqual(['zzja also installs: zzjb']);
			expect(activeOntologyTldsOf(closure.order)).toEqual([...CORE_ONTOLOGY_TLDS, 'zzjb', 'zzja']);
			expect(request.items.map((item) => [item.tld, item.origin])).toEqual([
				['zzjb', 'server'],
				['zzja', 'server'],
			]);
			expect(staged.staged.map((item) => item.tld)).toEqual(['zzjb', 'zzja']);
			expect(installed.warnings).toEqual([]);
			expect(existsSync(stagingDir)).toBe(false);
			// both landed (each with its root node), nothing of zzjc
			const tipos = await scratchTipos();
			expect(tipos.filter((tipo) => tipo.startsWith('zzjc'))).toEqual([]);
			for (const tipo of ['zzja1', 'zzja2', 'zzja8', 'zzja9', 'zzjb1', 'zzjb2']) {
				expect(tipos).toContain(tipo);
			}
			expect(installed.installed.map((item) => item.tld)).toEqual(['zzjb', 'zzja']);
			for (const item of installed.installed) expect(item.records).toBeGreaterThan(2);
			// deps first made zzja's model resolvable at its derive
			expect((await readDdOntologyRow('zzja2'))?.model).toBe('zz_model_b');
			// the planted references are SOFT, by rule — and nothing else dangles
			const refs = referencesOfRows(await readDdOntologyReferenceRows(['zzja', 'zzjb']));
			const diffusion = diffusionModelSet(await readDdOntologyModelParents());
			const own = new Set(['zzja', 'zzjb']);
			const graft = refs.find((ref) => ref.from === 'zzja8' && ref.field === 'parent');
			const alias = refs.find((ref) => ref.from === 'zzja9' && ref.field === 'relations');
			expect(graft && classifyReference(graft, own, diffusion)).toBe('graft');
			expect(alias && classifyReference(alias, own, diffusion)).toBe('diffusion');
			expect(await verifyInstalledOntologyReferences(['zzjb', 'zzja'])).toEqual([]);
			// the DECLARATION survives the import: the census (what this server's
			// next export serves) answers exactly what the stand-in declared
			expect(await censusDependencies()).toEqual({
				zzja: [
					{ tld: 'dd', main: 'ontology35', mandatory: true },
					{ tld: 'zzjb', main: 'ontology35', mandatory: true },
				],
				zzjb: [{ tld: 'dd', main: 'ontology35', mandatory: true }],
			});
			stand.stop();
		});
	});

	test('(b) undeclared dependencies: warned, installed alone, its dangling model reported', async () => {
		await guarded(async () => {
			const stand = standIn(buildOntologyPackage([zzja(), zzjb(), zzjc()]));
			const catalog = await serverCatalog(stand.source);
			const undeclared =
				"the ontology source declares no dependencies for 'zzjc' (an older ontology server) — 'zzjc' is installed alone; anything it references in other ontologies stays unresolved";
			const { closure, installed } = await installChosen(['zzjc'], catalog);
			expect(closure.order).toEqual(['zzjc']);
			expect(closure.warnings).toEqual([undeclared]);
			expect(installed.warnings).toContain(undeclared);
			expect(installed.warnings).toContain(
				"'zzjc' references 1 node(s) of 'zzjy' that is not installed (model: e.g. zzjc1→zzjy3) — install 'zzjy' too (--ontologies zzjc,zzjy) or ask the ontology server to declare it",
			);
			const tipos = await scratchTipos();
			expect(tipos).toContain('zzjc1');
			expect(tipos.filter((tipo) => !tipo.startsWith('zzjc'))).toEqual([]);
			// not declared upstream → nothing recorded → still not declared here
			expect(await censusDependencies()).toEqual({ zzjc: null });
			stand.stop();
		});
	});

	test('(c) a local directory and a .tgz of it install the same nodes', async () => {
		const dir = writePackage(
			join(scratchDir('local'), 'ontology'),
			buildOntologyPackage([zzja(), zzjb()]),
		);
		let fromDir: unknown[] = [];
		await guarded(async () => {
			const resolved = await resolveOntologyCatalog(
				{ kind: 'local', path: dir },
				{ allowedServers: [] },
			);
			const { request } = await installChosen(['zzja'], resolved.catalog);
			expect(request.items.map((item) => [item.tld, item.origin])).toEqual([
				['zzjb', 'local'],
				['zzja', 'local'],
			]);
			fromDir = await landed();
			resolved.cleanup();
		});
		expect(fromDir.length).toBeGreaterThan(5);
		const archive = join(scratchDir('archive'), 'ontology.tgz');
		const tar = spawnSync('tar', ['-czf', archive, '-C', join(dir, '..'), 'ontology']);
		expect(tar.status, String(tar.stderr)).toBe(0);
		await guarded(async () => {
			const resolved = await resolveOntologyCatalog(
				{ kind: 'local', path: archive },
				{ allowedServers: [] },
			);
			await installChosen(['zzja'], resolved.catalog);
			expect(await landed()).toEqual(fromDir);
			resolved.cleanup();
		});
	});

	test('(c) unsafe archive entries are refused before anything is read', async () => {
		const cases: [string, Uint8Array, string][] = [
			['dotdot', ustar([['../zzja.copy.gz', '0', 'x']]), "'..' in path"],
			['absolute', ustar([['/zzja.copy.gz', '0', 'x']]), 'absolute path'],
			['symlink', ustar([['ontology/zzja.copy.gz', '2', '']]), 'is a link or device'],
		];
		for (const [name, bytes, expected] of cases) {
			const path = join(scratchDir(`unsafe_${name}`), `${name}.tar`);
			writeFileSync(path, bytes);
			const refusal = await refusalOf(() =>
				resolveOntologyCatalog({ kind: 'local', path }, { allowedServers: [] }),
			);
			expect(refusal.code, name).toBe('install.invalid_input');
			expect(refusal.message, name).toContain(expected);
		}
	});

	test('(d) preflight refusals leave the database untouched', async () => {
		await guarded(async () => {
			// a stand-in that stops answering between the catalog and the staging
			const stand = standIn(buildOntologyPackage([zzja(), zzjb()]));
			const catalog = await serverCatalog(stand.source);
			stand.stop();
			const request = ontologyInstallRequest(closeOntologyChoice(['zzja'], catalog).order, catalog);
			const stopped = await refusalOf(() =>
				stageOntologies(request, { stagingDir: scratchDir('stopped') }),
			);
			expect(stopped.code).toBe('install.step_failed');
			expect(stopped.message).toContain('nothing was installed');

			// a corrupt COPY arity
			const files = buildOntologyPackage([zzja(), zzjb()]);
			files.set('zzja.copy.gz', gzipSync(Buffer.from('a\tb\tc\nd\te\tf\n')));
			const corrupt = writePackage(join(scratchDir('corrupt'), 'ontology'), files);
			const local = await resolveOntologyCatalog(
				{ kind: 'local', path: corrupt },
				{ allowedServers: [] },
			);
			const arity = await refusalOf(() =>
				stageOntologies(
					ontologyInstallRequest(closeOntologyChoice(['zzja'], local.catalog).order, local.catalog),
					{ stagingDir: scratchDir('arity') },
				),
			);
			expect(arity.code).toBe('install.step_failed');
			expect(arity.message).toContain('line arity mismatch');

			// a package exported for another version
			const older = writePackage(
				join(scratchDir('older'), 'ontology'),
				buildOntologyPackage([zzja(), zzjb()], { version: '6.9.0' }),
			);
			const version = await refusalOf(() =>
				resolveOntologyCatalog({ kind: 'local', path: older }, { allowedServers: [] }),
			);
			expect(version.code).toBe('install.invalid_input');
			expect(version.message).toContain(
				`is for Dédalo 6.9.0 — this engine is ${DEDALO_VERSION_MAJOR_MINOR}`,
			);
			expect(await scratchTipos()).toEqual([]);
		});
	});

	test('(e) a staged file changed after staging is refused', async () => {
		await guarded(async () => {
			const dir = writePackage(
				join(scratchDir('tamper'), 'ontology'),
				buildOntologyPackage([zzjb()]),
			);
			const { catalog } = await resolveOntologyCatalog(
				{ kind: 'local', path: dir },
				{ allowedServers: [] },
			);
			const stagingDir = scratchDir('tamper_staging');
			await stageOntologies(ontologyInstallRequest(['zzjb'], catalog), { stagingDir });
			writeFileSync(join(stagingDir, DEDALO_VERSION_MAJOR_MINOR, 'zzjb.copy.gz'), gzipSync('x\n'));
			const tampered = await refusalOf(() => installOntologies({ stagingDir, userId: -1 }));
			expect(tampered.code).toBe('install.state_conflict');
			expect(tampered.message).toContain('changed since it was verified');
			expect(await scratchTipos()).toEqual([]);
		});
	});

	test('(f) matrix_dd: the source lists replace the table — +1 row, every existing row intact', async () => {
		await guarded(async () => {
			const dump = join(scratchDir('matrix_dd'), 'matrix_dd.copy');
			const columns = MATRIX_COPY_COLUMNS.map((column) => `"${column}"`).join(',');
			const copied = await runPsql(connFromConfig(), [
				'-v',
				'ON_ERROR_STOP=1',
				'-c',
				`\\copy (SELECT ${columns} FROM matrix_dd ORDER BY section_tipo, section_id) TO '${dump}'`,
			]);
			expect(copied.exitCode, copied.stderr).toBe(0);
			const existing = readFileSync(dump, 'utf8')
				.split('\n')
				.filter((line) => line !== '');
			expect(existing.length).toBeGreaterThan(0);
			const zzRow: Record<string, string> = {
				section_id: '1',
				section_tipo: 'zzjd1',
				data: JSON.stringify({ section_id: 1, section_tipo: 'zzjd1' }),
			};
			const zzLine = MATRIX_COPY_COLUMNS.map((column) =>
				encodeCopyField(zzRow[column] ?? null),
			).join('\t');
			const before = await nonScratchCensus();
			const dir = writePackage(
				join(scratchDir('lists'), 'ontology'),
				buildOntologyPackage([zzjb()], { matrixDdLines: [...existing, zzLine] }),
			);
			const { catalog } = await resolveOntologyCatalog(
				{ kind: 'local', path: dir },
				{ allowedServers: [] },
			);
			const request = ontologyInstallRequest(['zzjb'], catalog);
			expect(request.matrixDd?.origin).toBe('local');
			const { installed } = await installChosen(['zzjb'], catalog);
			expect(installed.installed.map((item) => item.tld)).toEqual(['zzjb']);
			expect(await one(sql`SELECT count(*)::int AS c FROM matrix_dd`)).toBe(
				String(existing.length + 1),
			);
			expect((await nonScratchCensus()).matrixDd).toBe(before.matrixDd);
		});
	});
});

// ── a hand-built tar (the unsafe entries a system tar would not write) ──────

function ustar(entries: [name: string, type: string, body: string][]): Uint8Array {
	const blocks: Buffer[] = [];
	for (const [name, type, body] of entries) {
		const header = Buffer.alloc(512);
		header.write(name, 0, 100, 'utf8');
		header.write('0000644\0', 100);
		header.write('0000000\0', 108);
		header.write('0000000\0', 116);
		header.write(`${Buffer.byteLength(body).toString(8).padStart(11, '0')}\0`, 124);
		header.write('00000000000\0', 136);
		header.write(type, 156);
		if (type === '2') header.write('/etc/hosts', 157);
		header.write('ustar\0', 257);
		header.write('00', 263);
		header.fill(' ', 148, 156);
		let sum = 0;
		for (const byte of header) sum += byte;
		header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
		blocks.push(header);
		const data = Buffer.alloc(Math.ceil(Buffer.byteLength(body) / 512) * 512);
		data.write(body);
		blocks.push(data);
	}
	blocks.push(Buffer.alloc(1024));
	return Buffer.concat(blocks);
}
