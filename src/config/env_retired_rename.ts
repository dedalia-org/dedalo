/**
 * THE RETIRED-KEY RENAME DOOR (2026-11-23). A key renamed in `RETIRED_ENV_KEYS`
 * (env.ts) used to REFUSE the boot, naming the first line to edit — so every
 * existing install whose `../private/.env` the earlier installer had written
 * (APPLICATION_LANG, DATA_LANG, PROJECTS_DEFAULT_LANGS) failed its next code
 * update at the pre-swap smoke boot, one key per failed attempt. Owner ruling:
 * the update renames them itself.
 *
 * ONE door, three callers:
 *  - the updater, PRE-SWAP, through the NEW tree's own entry
 *    (`scripts/ops/rename_retired_env_keys.ts`, spawned by code_update.ts) —
 *    the running updater is the old code and cannot know what the new release
 *    retired;
 *  - the real boot (config.ts → `settleRetiredEnvKeys`), so a release installed
 *    by an updater that predates the entry heals itself;
 *  - the smoke child, which cannot write (its private dir is a throwaway) and
 *    instead gives the verdict the real boot WILL reach.
 *
 * APPEND-ONLY by project law: `<replacement>=<the retired line's raw value>` is
 * appended; the old line is never edited or removed (it configures nothing, and
 * it keeps a restore to an older tree working). What cannot be renamed — a key
 * set in the PROCESS environment (systemd unit, container env), or an
 * unwritable `.env` — still refuses the boot, every such key in one message.
 * Gate: test/unit/env_retired_rename_native.test.ts.
 */

import {
	accessSync,
	appendFileSync,
	constants,
	existsSync,
	readFileSync,
	statSync,
	truncateSync,
} from 'node:fs';
import { join } from 'node:path';
import {
	adoptRenamedEnvValue,
	parseEnvFile,
	privateDir,
	processEnvValue,
	RETIRED_ENV_KEYS,
	readEnv,
} from './env.ts';

export interface RetiredKeyRename {
	readonly retired: string;
	readonly replacement: string;
	/** The effective value the appended line carries (as the loader parses it). */
	readonly value: string;
}

export type RetiredKeyBlocker = 'process_env' | 'unwritable' | 'readback';

export interface RetiredKeyProblem {
	readonly retired: string;
	readonly replacement: string;
	readonly blocker: RetiredKeyBlocker;
}

export interface RetiredRenameReport {
	readonly appended: readonly RetiredKeyRename[];
	readonly refused: readonly RetiredKeyProblem[];
}

/**
 * The raw value text of the LAST line parseEnvFile reads as `key` (it is
 * last-wins), byte-for-byte after the first `=` (a CRLF's `\r` aside). Same
 * line grammar as parseEnvFile: trimmed line, `#` comment, first `=`, trimmed
 * key — so `export KEY=…` is not `KEY`, for the loader and for us alike.
 */
function rawValueOf(content: string, key: string): string | undefined {
	let raw: string | undefined;
	for (const rawLine of content.split('\n')) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith('#')) continue;
		const separator = line.indexOf('=');
		if (separator <= 0 || line.slice(0, separator).trim() !== key) continue;
		raw = rawLine.slice(rawLine.indexOf('=') + 1).replace(/\r$/, '');
	}
	return raw;
}

/**
 * For every retired key SET IN `envPath` whose replacement is set nowhere (not
 * in the file, not in this process's environment): append
 * `<replacement>=<raw value>`. Never rewrites the file. Idempotent: a second
 * run finds the replacement set and appends nothing. A retired key the process
 * environment also sets is NOT renamed (the process value wins at boot, so
 * copying the file's value would silently change the configuration) — it is
 * reported, as is every key when the append itself fails.
 *
 * ALL OR NOTHING: an append that fails (ENOSPC after a short write) or does not
 * read back as the retired value is ROLLED BACK — the file is truncated to its
 * pre-append size, so only our own bytes go and the file is byte-identical to
 * before. A partial replacement line left in place would be trusted by every
 * later run (the replacement is "set") and silently change the value.
 * shortcut: no fsync — a power loss mid-append can still persist a partial
 * line; fsync + a later-run check if that is ever seen.
 * `append` is a test seam (the gate's short-write simulation).
 */
export function renameRetiredEnvKeys(
	envPath: string,
	append: (path: string, data: string) => void = appendFileSync,
): RetiredRenameReport {
	if (!existsSync(envPath)) return { appended: [], refused: [] };
	const before = readFileSync(envPath, 'utf8');
	const values = parseEnvFile(before);
	const lines: string[] = [];
	const pending: { retired: string; replacement: string }[] = [];
	const refused: RetiredKeyProblem[] = [];
	for (const [retired, replacement] of Object.entries(RETIRED_ENV_KEYS)) {
		if (values[retired] === undefined) continue;
		if (values[replacement] !== undefined || processEnvValue(replacement) !== undefined) continue;
		if (processEnvValue(retired) !== undefined) {
			refused.push({ retired, replacement, blocker: 'process_env' });
			continue;
		}
		lines.push(`${replacement}=${rawValueOf(before, retired) as string}`);
		pending.push({ retired, replacement });
	}
	if (lines.length === 0) return { appended: [], refused };
	const sizeBefore = statSync(envPath).size;
	const rollBack = (blocker: RetiredKeyBlocker): RetiredRenameReport => {
		try {
			if (statSync(envPath).size > sizeBefore) truncateSync(envPath, sizeBefore);
		} catch {
			// the refusal below still names the key; the operator checks the file
		}
		return { appended: [], refused: [...refused, ...pending.map((key) => ({ ...key, blocker }))] };
	};
	const separator = before.length > 0 && !before.endsWith('\n') ? '\n' : '';
	try {
		append(envPath, `${separator}${lines.join('\n')}\n`);
	} catch {
		return rollBack('unwritable');
	}
	// The appended line must read back as the value the loader saw — a grammar
	// drift between rawValueOf and parseEnvFile is a refusal, never a silent
	// configuration change.
	const after = parseEnvFile(readFileSync(envPath, 'utf8'));
	if (pending.some(({ retired, replacement }) => after[replacement] !== values[retired])) {
		return rollBack('readback');
	}
	return {
		appended: pending.map(({ retired, replacement }) => ({
			retired,
			replacement,
			value: after[replacement] as string,
		})),
		refused,
	};
}

/** One clause per key the boot cannot settle. */
function problemText(problem: RetiredKeyProblem, envPath: string): string {
	const { retired, replacement } = problem;
	if (problem.blocker === 'process_env') {
		return `'${retired}' is RETIRED and set in the process environment (systemd unit, container env): rename it to '${replacement}' there`;
	}
	return problem.blocker === 'readback'
		? `'${retired}' is RETIRED and an appended '${replacement}' line did not read back as its value (rolled back): add that line to ${envPath} by hand`
		: `'${retired}' is RETIRED and ${envPath} is not writable: add a '${replacement}' line with its value to that file`;
}

/**
 * Settle every retired key before the config is built (config.ts). A retired
 * key whose replacement is set configures nothing and is left alone. Each other
 * one is renamed (real boot), tolerated (smoke boot, when the real boot will
 * rename it) or refused. Returns the refusal (ALL refused keys in one
 * message) or null; config.ts throws it — the boot's one refusal site.
 */
export function settleRetiredEnvKeys(): string | null {
	const pending = Object.entries(RETIRED_ENV_KEYS).filter(
		([retired, replacement]) =>
			readEnv(replacement) === undefined && readEnv(retired) !== undefined,
	);
	if (pending.length === 0) return null;
	const problems =
		readEnv('DEDALO_SMOKE_BOOT') === 'true' ? smokeVerdict(pending) : renameAtBoot(pending);
	return problems.length === 0
		? null
		: `Config keys RETIRED and not renamed: ${problems.join('; ')}. See private/sample.env.`;
}

function renameAtBoot(pending: readonly [string, string][]): string[] {
	const envPath = join(privateDir, '.env');
	const report = renameRetiredEnvKeys(envPath);
	for (const rename of report.appended) {
		adoptRenamedEnvValue(rename.replacement, rename.value);
		console.warn(
			`[config] RETIRED key renamed: appended '${rename.replacement}' to ${envPath} with the value of '${rename.retired}' (that line is kept and configures nothing; delete it once no older code tree needs it)`,
		);
	}
	const renamed = new Set(report.appended.map((rename) => rename.retired));
	const blockers = new Map(report.refused.map((problem) => [problem.retired, problem.blocker]));
	return pending
		.filter(([retired]) => !renamed.has(retired))
		.map(([retired, replacement]) =>
			problemText(
				{
					retired,
					replacement,
					blocker:
						blockers.get(retired) ??
						(processEnvValue(retired) !== undefined ? 'process_env' : 'unwritable'),
				},
				envPath,
			),
		);
}

/**
 * The smoke child's verdict. Its private dir is a throwaway and the live
 * `.env` values arrive as process env (smoke_boot.ts spreads envSnapshot), so
 * it cannot rename; the updater names the LIVE file (`DEDALO_SMOKE_ENV_FILE`,
 * read only) and the child judges what the real boot will do. An updater older
 * than that key names none: tolerated, said, nothing judged (the real boot
 * still judges).
 */
function smokeVerdict(pending: readonly [string, string][]): string[] {
	const live = readEnv('DEDALO_SMOKE_ENV_FILE');
	if (live === undefined || live === '') {
		for (const [retired, replacement] of pending) {
			adoptRenamedEnvValue(replacement, readEnv(retired) as string);
		}
		console.warn(
			`[smoke boot] RETIRED keys set (${pending.map(([retired]) => retired).join(', ')}) and the updater named no DEDALO_SMOKE_ENV_FILE — tolerated, NOT judged before the swap (the real boot renames them or refuses)`,
		);
		return [];
	}
	const liveValues = existsSync(live) ? parseEnvFile(readFileSync(live, 'utf8')) : {};
	let writable = true;
	try {
		accessSync(live, constants.W_OK);
	} catch {
		writable = false;
	}
	const problems: string[] = [];
	for (const [retired, replacement] of pending) {
		const seen = readEnv(retired) as string;
		const renamedLive = liveValues[replacement];
		if (renamedLive !== undefined) {
			// already appended (pre-swap); the updater's snapshot predates it
			adoptRenamedEnvValue(replacement, renamedLive);
		} else if (liveValues[retired] === seen && writable) {
			// shortcut: a value set in BOTH the live process env and the file, equal,
			// reads as file-only here; the new updater's pre-swap rename refuses it first.
			adoptRenamedEnvValue(replacement, seen);
			console.warn(
				`[smoke boot] RETIRED key '${retired}' tolerated: the real boot appends '${replacement}' to ${live}`,
			);
		} else {
			problems.push(
				problemText(
					{
						retired,
						replacement,
						blocker: liveValues[retired] === seen ? 'unwritable' : 'process_env',
					},
					live,
				),
			);
		}
	}
	return problems;
}
