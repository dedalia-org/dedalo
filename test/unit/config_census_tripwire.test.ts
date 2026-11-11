/**
 * CONFIG-CENSUS TRIPWIRE (DEC-12: every documented invariant has a mechanical gate).
 *
 * Three sets must agree, or the config story is a lie somewhere:
 *
 *   A. the env keys the engine ACTUALLY READS  (scanned from src/)
 *   B. the keys the v6→v7 migration knows about (`migration_map.ts`:
 *      the non-DROPPED targets of V6_MIGRATION, plus NEW_IN_V7)
 *   C. every constant a real v6 install can set  (the vendored fixture)
 *
 * A == B  ⇒ the migration can never promise a key the engine ignores, and a new
 *           key cannot be added to the engine without being classified (which is
 *           also the moment it gets documented).
 * C ⊆ map ⇒ no legacy constant is silently dropped on the floor: every one is
 *           classified, DROPPED entries carrying an explicit reason.
 *
 * The fixture is VENDORED (test/fixtures/v6_config/) rather than read from the
 * sibling v6 checkout: a gate that depends on a directory outside the repo is a
 * gate that passes vacuously in CI. It is a byte copy of v6's shipped
 * sample.config.php + siblings — i.e. exactly what `cp sample.config.php
 * config.php` gives a real install.
 *
 * NOTE `../private/sample.env` is the operator-facing census, but it lives
 * OUTSIDE the repo, so it cannot be gated here. `migration_map.ts` is therefore
 * the in-repo source of truth, and sample.env is documentation generated from the
 * same knowledge.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_CATALOG } from '../../src/config/catalog/index.ts';
import { NEW_IN_V7, V6_MIGRATION } from '../../src/config/migration_map.ts';
import { extractDefines } from '../../src/config/php_defines.ts';
import { envKeysReadInSrc } from '../helpers/env_key_scan.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const FIXTURE_DIR = join(REPO_ROOT, 'test', 'fixtures', 'v6_config');

// The scanner (regex + the named non-env literals) lives in test/helpers/env_key_scan.ts
// so this gate and config_docs_tripwire cannot disagree about what "the engine reads".

/** Every key the migration map believes the engine reads. */
function keysTheMapKnows(): Set<string> {
	const keys = new Set<string>(NEW_IN_V7);
	for (const rule of Object.values(V6_MIGRATION)) {
		if (rule.cls !== 'DROPPED' && rule.target !== undefined) keys.add(rule.target);
	}
	return keys;
}

describe('config census: the engine, the migration map, and v6 agree', () => {
	test('every key the engine READS is classified in migration_map.ts', () => {
		const read = envKeysReadInSrc();
		const known = keysTheMapKnows();
		const unclassified = [...read].filter((k) => !known.has(k)).sort();

		// A key the engine reads but the map has never heard of: the migration would
		// silently fail to carry it, and the docs would never mention it.
		expect(unclassified).toEqual([]);
	});

	test('migration_map.ts never targets a key the engine does NOT read', () => {
		const read = envKeysReadInSrc();
		const known = keysTheMapKnows();
		const phantom = [...known]
			.filter((k) => !read.has(k))
			// ...unless the catalog SAYS who reads it. Same named-exemption mechanism
			// config_docs_tripwire already honours, and for the same reason: a key can
			// be read dynamically (the external transport fetches its credential BY
			// NAME through `credentialCatalogKey`, so `readOptionalString(key)` is
			// invisible to a static scan), or kept only for backward compatibility.
			// A `consumer` string is a declaration with a reason, never a silent pass.
			.filter((k) => CONFIG_CATALOG[k]?.consumer === undefined)
			.sort();

		// A target nothing reads = the migration writes a dead line and the docs
		// promise a setting that does nothing (this is how DEDALO_DIFFUSION_DB_NAME
		// was caught).
		expect(phantom).toEqual([]);
	});

	test('every declared consumer names something, and the key is really unscanned', () => {
		// The exemption must not become a way to silence the rule: a `consumer` on a
		// key the scanner CAN see is either a stale note or a lie about where the
		// value is read.
		const read = envKeysReadInSrc();
		const problems: string[] = [];
		for (const [key, entry] of Object.entries(CONFIG_CATALOG)) {
			if (entry.consumer === undefined) continue;
			if (entry.consumer.trim().length < 20) problems.push(`${key}: consumer says too little`);
			if (read.has(key)) problems.push(`${key}: declares a consumer but src/ DOES read it`);
		}
		expect(problems, problems.join('\n  ')).toEqual([]);
	});

	test('every constant a real v6 install can set is CLASSIFIED', () => {
		const files = ['config.php', 'config_db.php', 'config_areas.php', 'config_core.php'].map(
			(name) => ({ path: name, content: readFileSync(join(FIXTURE_DIR, name), 'utf8') }),
		);
		const extracted = extractDefines(files);
		expect(extracted.records.size).toBeGreaterThan(150); // the fixture really parsed

		const unknown = [...extracted.records.keys()].filter((n) => !(n in V6_MIGRATION)).sort();
		expect(unknown).toEqual([]);

		// A commented-out define is still a setting the operator may enable — it must
		// be classified too, or enabling it silently loses the value on migration.
		const unknownCommented = extracted.commentedOut.filter((n) => !(n in V6_MIGRATION)).sort();
		expect(unknownCommented).toEqual([]);
	});

	test('every DROPPED constant says WHY (the report prints the reason verbatim)', () => {
		const reasonless = Object.entries(V6_MIGRATION)
			.filter(([, rule]) => rule.cls === 'DROPPED' && (rule.reason ?? '').trim() === '')
			.map(([name]) => name)
			.sort();
		expect(reasonless).toEqual([]);
	});

	test('a RENAMED source is never also emitted — that would refuse the boot', () => {
		// RETIRED_ENV_KEYS makes config.ts throw when the old spelling is present and
		// the new one is not. The map must therefore never TARGET a retired name.
		const targets = keysTheMapKnows();
		const retiredTargets = Object.entries(V6_MIGRATION)
			.filter(([name, rule]) => rule.cls === 'RENAMED' && targets.has(name))
			.map(([name]) => name);
		expect(retiredTargets).toEqual([]);
	});
});

/**
 * PERF-11 (G5): the maintenance pool exists and the generated config docs are
 * current. The database ceilings' ON-BY-DEFAULT flip (DB_STATEMENT_TIMEOUT_MS,
 * DB_POOL_ACQUIRE_TIMEOUT_MS, DEDALO_SLOW_QUERY_MS > 0) is NOT pinned here yet:
 * it ships only together with the unbounded-scope wraps of the long statements
 * that still run on the request pool (the boot search-store builds, the
 * observer reconcile, the retention prune — engineering/PRODUCTION.md §4
 * census). Its leg lands with that flip.
 */
describe('PERF-11: the maintenance pool is configured, the config docs are current', () => {
	test('the maintenance pool has at least one connection by default', () => {
		const defaultOf = (key: string): unknown => CONFIG_CATALOG[key]?.default;
		expect(
			CONFIG_CATALOG.DB_MAINTENANCE_POOL_MAX,
			'DB_MAINTENANCE_POOL_MAX is not in the catalog',
		).toBeDefined();
		expect(typeof defaultOf('DB_MAINTENANCE_POOL_MAX')).toBe('number');
		expect(defaultOf('DB_MAINTENANCE_POOL_MAX') as number).toBeGreaterThanOrEqual(1);
	});

	test('the generated config docs render clean (bun run config:check)', async () => {
		const child = Bun.spawn([process.execPath, 'run', 'scripts/gen_config_docs.ts', '--check'], {
			cwd: join(import.meta.dir, '..', '..'),
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exitCode, `config:check is stale:\n${stdout}\n${stderr}`).toBe(0);
	}, 60000);
});
