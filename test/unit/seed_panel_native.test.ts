/**
 * The install-seed PANEL's choices (src/core/install/seed_panel.ts) and the release copy it
 * makes from this server's own export (ontology_release_pull.ts copyLocalRelease):
 *  - source / output options parse, and unknown ones refuse;
 *  - a release dir summarizes its ontology.json (version, date, host, packages, digests);
 *  - the preflight names every failed check WITH its fix (CREATEDB, a running build, a
 *    master that answers without digests, low disk), and passes when all hold;
 *  - a local export is mirrored only when every file is the bytes its ontology.json names;
 *  - the manifest keys a copied release by its SHIPPED path (seedSourceDigests releaseDir).
 * The compile itself is seed_build_native. No database is written; the psql seam answers.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { projectRoot } from '../../src/config/env.ts';
import { copyLocalRelease } from '../../src/core/install/ontology_release_pull.ts';
import { resolvePgBinary } from '../../src/core/install/pg_bin.ts';
import { connArgs, connFromConfig, pgClientEnv } from '../../src/core/install/pg_exec.ts';
import { buildInstallVersion, SEED_BUILD_LOCK_KEY } from '../../src/core/install/seed_build.ts';
import { seedSourceDigests } from '../../src/core/install/seed_manifest.ts';
import {
	type PreflightDeps,
	parseSeedSource,
	parseSeedTarget,
	pruneOlderBuilds,
	seedPreflight,
	stagedRelease,
	summarizeRelease,
} from '../../src/core/install/seed_panel.ts';
import { ONTOLOGY_RELEASE_DIR } from '../../src/core/install/seed_sources.ts';
import type { ManifestResult } from '../../src/core/ontology/ontology_manifest.ts';
import { DEDALO_DATA_VERSION, formatVersion } from '../../src/core/update/version.ts';

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
	const root = mkdtempSync(join(tmpdir(), 'seed_panel_'));
	roots.push(root);
	return root;
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** An export dir in the master's layout: packages + ontology.json naming their digests. */
function exportDir(
	files: Record<string, string>,
	digestOverride: Record<string, string> = {},
): string {
	const dir = join(scratch(), '7.0');
	mkdirSync(dir);
	const digests: Record<string, string> = {};
	for (const [name, body] of Object.entries(files)) {
		writeFileSync(join(dir, name), body);
		digests[name] = digestOverride[name] ?? sha(body);
	}
	writeFileSync(
		join(dir, 'ontology.json'),
		JSON.stringify({
			version: formatVersion(DEDALO_DATA_VERSION),
			date: '2026-11-25T19:36:25+01:00',
			host: 'master.test',
			entity_label: 'Test entity',
			active_ontologies: [],
			files_sha256: digests,
		}),
	);
	return dir;
}

describe('options', () => {
	test('sources and targets parse; unknown ones refuse', () => {
		expect(parseSeedSource(undefined)).toEqual({ kind: 'shipped' });
		expect(parseSeedSource('local_export')).toEqual({ kind: 'local_export' });
		expect(parseSeedSource('master:beta')).toEqual({ kind: 'master', name: 'beta' });
		expect(() => parseSeedSource('master:')).toThrow();
		expect(() => parseSeedSource('elsewhere')).toThrow();
		expect(parseSeedTarget(undefined)).toBe('private');
		expect(parseSeedTarget('checkout')).toBe('checkout');
		expect(() => parseSeedTarget('/etc')).toThrow();
	});
});

describe('summarizeRelease', () => {
	test('reads ontology.json and counts packages + digests', async () => {
		const dir = exportDir({ 'zzpanel.copy.gz': 'a', 'matrix_dd.copy.gz': 'b' });
		expect(await summarizeRelease(dir)).toEqual({
			version: formatVersion(DEDALO_DATA_VERSION),
			date: '2026-11-25T19:36:25+01:00',
			host: 'master.test',
			entity: 'Test entity',
			packages: 2,
			digests: true,
		});
		writeFileSync(join(dir, 'unlisted.copy.gz'), 'c');
		expect((await summarizeRelease(dir))?.digests).toBe(false);
		expect(await summarizeRelease(scratch())).toBeNull();
	});
});

describe('seedPreflight', () => {
	const conn = { database: 'x', host: 'h', port: 5432, user: 'dedalo', password: '' };
	function deps(answers: { role: string; lock: string }, free = 10 * 1024 ** 3): PreflightDeps {
		return {
			conn,
			psql: async (sql) => ({
				ok: true,
				out: sql.includes('pg_roles') ? answers.role : answers.lock,
				err: '',
			}),
			freeBytes: () => free,
		};
	}

	test('a user without CREATEDB fails with the exact grant; a held lock fails', async () => {
		const report = await seedPreflight(
			{ kind: 'shipped' },
			'private',
			deps({ role: 'f', lock: 'f' }),
		);
		expect(report.ok).toBe(false);
		const role = report.checks.find((check) => check.id === 'database_role');
		expect(role?.ok).toBe(false);
		expect(role?.fix).toBe('a PostgreSQL superuser runs: ALTER ROLE "dedalo" CREATEDB;');
		expect(report.checks.find((check) => check.id === 'build_lock')?.ok).toBe(false);
	});

	test('low disk fails', async () => {
		const report = await seedPreflight(
			{ kind: 'shipped' },
			'private',
			deps({ role: 't', lock: 't' }, 1),
		);
		expect(report.checks.find((check) => check.id === 'disk')?.ok).toBe(false);
	});

	test('the shipped release with role, lock and disk in order: source/role/lock/disk pass', async () => {
		const report = await seedPreflight(
			{ kind: 'shipped' },
			'private',
			deps({ role: 't', lock: 't' }),
		);
		for (const id of ['database_role', 'build_lock', 'source', 'disk'] as const) {
			expect(report.checks.find((check) => check.id === id)?.ok).toBe(true);
		}
	});

	test('an unconfigured master names the missing ONTOLOGY_SERVERS entry', async () => {
		const report = await seedPreflight(
			{ kind: 'master', name: 'zz_unconfigured' },
			'private',
			deps({ role: 't', lock: 't' }),
		);
		const source = report.checks.find((check) => check.id === 'source');
		expect(source?.ok).toBe(false);
		expect(source?.detail).toContain('zz_unconfigured');
	});

	test('psql that cannot connect fails the role check without throwing', async () => {
		const report = await seedPreflight({ kind: 'shipped' }, 'private', {
			conn,
			psql: async () => ({ ok: false, out: '', err: 'connection refused' }),
			freeBytes: () => 10 * 1024 ** 3,
			fetchManifest: async (): Promise<ManifestResult> => ({ ok: false, reason: 'unused' }),
		});
		expect(report.checks.find((check) => check.id === 'database_role')?.detail).toContain(
			'connection refused',
		);
	});
});

describe('copyLocalRelease', () => {
	test('mirrors a verified export: packages + ontology.json in, unlisted packages out, other files kept', async () => {
		const source = exportDir({ 'zzpanel.copy.gz': 'new', 'matrix_dd.copy.gz': 'lists' });
		const target = join(scratch(), '7.0');
		mkdirSync(target);
		writeFileSync(join(target, 'gone.copy.gz'), 'old');
		writeFileSync(join(target, 'ontology_llm_map.json'), 'keep');
		const result = await copyLocalRelease(source, target);
		expect(result.removed).toEqual(['gone.copy.gz']);
		expect(readdirSync(target).sort()).toEqual([
			'matrix_dd.copy.gz',
			'ontology.json',
			'ontology_llm_map.json',
			'zzpanel.copy.gz',
		]);
		expect(readFileSync(join(target, 'zzpanel.copy.gz'), 'utf8')).toBe('new');
	});

	test('a file that is not the bytes ontology.json names writes nothing', async () => {
		const source = exportDir(
			{ 'zzpanel.copy.gz': 'tampered' },
			{ 'zzpanel.copy.gz': sha('original') },
		);
		const target = join(scratch(), '7.0');
		mkdirSync(target);
		writeFileSync(join(target, 'zzpanel.copy.gz'), 'old');
		let message = '';
		try {
			await copyLocalRelease(source, target);
		} catch (error) {
			message = String((error as { publicMessage?: string }).publicMessage);
		}
		expect(message).toContain('zzpanel.copy.gz');
		expect(readFileSync(join(target, 'zzpanel.copy.gz'), 'utf8')).toBe('old');
	});
});

describe('seedSourceDigests(releaseDir)', () => {
	test('a copied release is read from its dir but keyed by the shipped path', async () => {
		const dir = exportDir({ 'matrix_dd.copy.gz': 'copied lists' });
		const digests = await seedSourceDigests(dir);
		const key = `${relative(projectRoot, ONTOLOGY_RELEASE_DIR)}/matrix_dd.copy.gz`;
		expect(digests[key]).toBe(sha('copied lists'));
		expect(Object.keys(digests).some((file) => file.includes(dir))).toBe(false);
	});
});

describe('stagedRelease — nothing reaches the checkout before promotion', () => {
	test('shipped: compiled in place, no hooks', () => {
		const staged = stagedRelease({ kind: 'shipped' }, { promote: true });
		expect(staged.releaseDir).toBe(ONTOLOGY_RELEASE_DIR);
		expect(staged.prepareRelease).toBeUndefined();
		expect(staged.promoteRelease).toBeUndefined();
	});

	test('a master: a scratch dir outside the checkout; promote only when asked; dispose removes it', () => {
		const trial = stagedRelease({ kind: 'master', name: 'zz_master' }, { promote: false });
		const vendored = stagedRelease({ kind: 'master', name: 'zz_master' }, { promote: true });
		for (const staged of [trial, vendored]) {
			expect(relative(projectRoot, staged.releaseDir).startsWith('..')).toBe(true);
			expect(typeof staged.prepareRelease).toBe('function');
			expect(staged.pulled()).toBeNull(); // nothing fetched at construction
		}
		expect(trial.promoteRelease).toBeUndefined();
		expect(typeof vendored.promoteRelease).toBe('function');
		for (const staged of [trial, vendored]) {
			staged.dispose();
			expect(() => readdirSync(staged.releaseDir)).toThrow();
		}
	});
});

describe('pruneOlderBuilds', () => {
	test('removes only OLDER build stamps; a newer build and any other entry stay', () => {
		const dir = scratch();
		const names = [
			'2026-01-01T00-00-00-000Z',
			'2026-02-01T00-00-00-000Z',
			'2026-03-01T00-00-00-000Z',
			'notes',
			'.release_pull_x',
		];
		for (const name of names) mkdirSync(join(dir, name));
		pruneOlderBuilds(join(dir, '2026-02-01T00-00-00-000Z'), dir);
		expect(readdirSync(dir).sort()).toEqual(
			['.release_pull_x', '2026-02-01T00-00-00-000Z', '2026-03-01T00-00-00-000Z', 'notes'].sort(),
		);
	});
});

describe('buildInstallVersion — the release is prepared only under the cluster lock', () => {
	test('lock held elsewhere → refused before prepareRelease runs; nothing written', async () => {
		const conn = connFromConfig();
		const holder = Bun.spawn(
			[resolvePgBinary('psql'), '--dbname=postgres', ...connArgs(conn), '-X', '-w', '-q', '-tA'],
			{ stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: pgClientEnv(conn) },
		);
		holder.stdin.write(`SELECT pg_advisory_lock(hashtext('${SEED_BUILD_LOCK_KEY}'));\n`);
		await holder.stdin.flush();
		const reader = holder.stdout.getReader();
		await reader.read(); // the lock is held once psql answers
		reader.releaseLock();
		const out = join(scratch(), 'seed.pgsql.gz');
		let prepared = 0;
		let promoted = 0;
		try {
			await expect(
				buildInstallVersion({
					outFile: out,
					prepareRelease: async () => {
						prepared++;
						return null;
					},
					promoteRelease: async () => {
						promoted++;
					},
				}),
			).rejects.toMatchObject({ publicMessage: expect.stringContaining('advisory lock held') });
			expect(prepared).toBe(0);
			expect(promoted).toBe(0);
			expect(() => readFileSync(out)).toThrow();
		} finally {
			holder.stdin.end();
			await holder.exited;
		}
	});
});

describe('the stop signal and the lock probe, on the real cluster', () => {
	/** A psql session holding the seed build lock until `release()`. */
	async function holdLock(): Promise<() => Promise<void>> {
		const conn = connFromConfig();
		const holder = Bun.spawn(
			[resolvePgBinary('psql'), '--dbname=postgres', ...connArgs(conn), '-X', '-w', '-q', '-tA'],
			{ stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: pgClientEnv(conn) },
		);
		holder.stdin.write(`SELECT pg_advisory_lock(hashtext('${SEED_BUILD_LOCK_KEY}'));\n`);
		await holder.stdin.flush();
		const reader = holder.stdout.getReader();
		await reader.read();
		reader.releaseLock();
		return async () => {
			holder.stdin.end();
			await holder.exited;
		};
	}

	const lockRow = async () =>
		(await seedPreflight({ kind: 'shipped' }, 'private')).checks.find((c) => c.id === 'build_lock');

	test('the preflight sees a held lock, and a free one', async () => {
		const release = await holdLock();
		try {
			expect((await lockRow())?.ok).toBe(false);
		} finally {
			await release();
		}
		expect((await lockRow())?.ok).toBe(true);
	});

	test('a stopped job (aborted signal) writes nothing: refused before prepareRelease', async () => {
		const out = join(scratch(), 'seed.pgsql.gz');
		let prepared = 0;
		const stop = new AbortController();
		stop.abort();
		await expect(
			buildInstallVersion({
				outFile: out,
				signal: stop.signal,
				prepareRelease: async () => {
					prepared++;
					return null;
				},
			}),
		).rejects.toThrow();
		expect(prepared).toBe(0);
		expect(() => readFileSync(out)).toThrow();
		expect((await lockRow())?.ok).toBe(true); // the lock was released
	});
});
