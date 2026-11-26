/**
 * Resolve a PostgreSQL client binary (psql/pg_dump/...) matching the server
 * version — the install twin of backup.ts resolvePgDump (PHP
 * system::get_pg_bin_path): explicit config first, then version-suffixed
 * Homebrew installs newest-first, then PATH. A client older than the server
 * refuses to connect, so newest-first matters on multi-version dev machines.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../config/config.ts';
import { liveProcessEnv } from '../../config/env.ts';

/** Homebrew postgresql@<n> formulas probed, NEWEST FIRST (an older client refuses a newer server). */
const HOMEBREW_PG_VERSIONS: readonly number[] = [18, 17, 16, 15];

/**
 * The ordered candidate paths for a pg client binary — configured dir FIRST,
 * then the version-suffixed Homebrew installs newest-first. Pure over its
 * inputs (the caller probes existence in order and falls back to the bare name
 * for PATH resolution), so the ORDER law is gateable without a filesystem.
 */
export function pgBinaryCandidates(name: string, declaredDir: string | undefined): string[] {
	const candidates: string[] = [];
	if (typeof declaredDir === 'string' && declaredDir !== '') {
		candidates.push(join(declaredDir, name));
	}
	for (const version of HOMEBREW_PG_VERSIONS) {
		candidates.push(`/opt/homebrew/opt/postgresql@${version}/bin/${name}`);
	}
	return candidates;
}

/** Absolute path (or bare name for PATH resolution) of a pg client binary. */
export function resolvePgBinary(
	name: 'psql' | 'pg_dump' | 'pg_restore' | 'gzip' | 'gunzip',
): string {
	if (name === 'gzip' || name === 'gunzip') return name; // system PATH
	for (const candidate of pgBinaryCandidates(name, config.ops.pgBinPath)) {
		if (existsSync(candidate)) return candidate;
	}
	return name;
}

/**
 * What probing for a psql client answered — a TYPED answer, never a throw.
 * `Bun.spawnSync` THROWS when the binary cannot be started (ENOENT: not on
 * PATH; EACCES: present, not executable); a fresh host has no psql at all, so
 * a throw here once crashed the installer's whole System check (campaign 3,
 * 2026-10-13).
 *  - `found`: it ran and answered `--version` (`version`: its first line);
 *  - `missing`: no such binary (ENOENT) — the normal state of a fresh host;
 *  - `unusable`: a binary is there but did not run or answered non-zero
 *    (`reason`: the errno code, or `exit <n>`).
 */
export type PsqlProbe =
	| { state: 'found'; path: string; version: string }
	| { state: 'missing'; path: string }
	| { state: 'unusable'; path: string; reason: string };

/** The errno code of a spawn failure ('' when it carries none). */
function spawnErrorCode(error: unknown): string {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === 'string' ? code : '';
}

/**
 * Probe `psql --version` at the first candidate that exists, else the bare
 * name on `env.PATH` (Bun resolves a bare argv[0] against the PATH of the
 * env it is given). Never throws. Exported with its inputs so a gate drives
 * it over a PATH that holds no psql — the fresh host — on any machine.
 */
export function probePsqlAt(
	candidates: readonly string[],
	env: Record<string, string>,
	name: 'psql' | 'pg_dump' = 'psql',
): PsqlProbe {
	const path = candidates.find((candidate) => existsSync(candidate)) ?? name;
	try {
		return ranAnswer(
			path,
			Bun.spawnSync([path, '--version'], { stdout: 'pipe', stderr: 'pipe', env }),
		);
	} catch (error) {
		return spawnFailure(path, error);
	}
}

/** A psql that ran: found (its first line) when it answered 0, else unusable. */
function ranAnswer(path: string, run: { exitCode: number; stdout: Buffer }): PsqlProbe {
	if (run.exitCode !== 0) return { state: 'unusable', path, reason: `exit ${run.exitCode}` };
	return { state: 'found', path, version: run.stdout.toString().split('\n')[0]?.trim() ?? '' };
}

/** A psql that could not be started: ENOENT is missing; anything else unusable, named by its errno. */
function spawnFailure(path: string, error: unknown): PsqlProbe {
	const code = spawnErrorCode(error);
	if (code === 'ENOENT') return { state: 'missing', path };
	return { state: 'unusable', path, reason: code === '' ? 'it could not be started' : code };
}

/**
 * THIS machine's psql (config dir, Homebrew newest-first, then PATH).
 *
 * COVERAGE-EXEMPT for execution (plan §4.1.9 → §5.1): it is a probe of THIS
 * machine, so an assertion on it answers differently on a clone or in CI. The
 * decidable parts are gated over their inputs: the candidate ORDER
 * (`pgBinaryCandidates`, test/unit/tier1_install_native.test.ts) and the
 * never-throws answer over a PATH without psql (`probePsqlAt`,
 * test/unit/install_system_check_native.test.ts).
 */
export function probePsql(): PsqlProbe {
	// Explicit env: Bun's default spawn env is the ORIGINAL environ (config/env.ts liveProcessEnv).
	return probePsqlAt(pgBinaryCandidates('psql', config.ops.pgBinPath), liveProcessEnv());
}

/** THIS machine's pg_dump, resolved like psql (the seed compiler dumps with it). */
export function probePgDump(): PsqlProbe {
	return probePsqlAt(
		pgBinaryCandidates('pg_dump', config.ops.pgBinPath),
		liveProcessEnv(),
		'pg_dump',
	);
}

/** True when a psql client can be resolved AND runs (never throws — see PsqlProbe). */
export function psqlResolvable(): boolean {
	return probePsql().state === 'found';
}
