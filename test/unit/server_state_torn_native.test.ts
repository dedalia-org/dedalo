/**
 * A TORN ts_state.json FAILS CLOSED, AND THE WRITER CANNOT TEAR IT (T2 B1 review, S3-6).
 *
 * Maintenance mode gates the dispatcher (Gate 2b) and every non-dispatch route
 * (security/session_gate.ts liveSessionFromCookie → refusedUnderMaintenance), and
 * it is read from <private>/ts_state.json per request. Until 2026-11-19 the writer
 * was a plain writeFileSync (truncate, then write) and the reader answered the
 * DEFAULTS on any parse error — so a crash in the middle of the write that turns
 * maintenance ON (an update run, a restore) left an empty file that read as
 * "maintenance off": the window re-opened to every session, nothing logged.
 *
 * Pinned, by outcome:
 *  T1 a file that exists and is not a state object (empty, truncated, `null`, an
 *     array) → maintenance ON for a non-root session, root still passes, said in
 *     the log once per damage — never once per request.
 *  T2 no file at all is the legitimate first state: the defaults, silent.
 *  T3 root saving the state over a torn file rewrites it clean.
 *  T4 the writer replaces the file by rename: a hard link taken before the write
 *     keeps the OLD bytes (an in-place truncate would change them), no temp
 *     sibling is left, and the file's mode survives.
 *
 * The file is the per-run scratch state the preload points the process at
 * (DEDALO_TS_STATE_PATH) — never the installation's; restored after.
 */

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import {
	chmodSync,
	existsSync,
	linkSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { basename, dirname } from 'node:path';
import { readEnv } from '../../src/config/env.ts';
import { getServerState, setServerState } from '../../src/core/resolve/server_state.ts';
import { SUPERUSER_ID } from '../../src/core/security/permissions.ts';
import { refusedUnderMaintenance } from '../../src/core/security/session_gate.ts';

const STATE_PATH = readEnv('DEDALO_TS_STATE_PATH');
if (STATE_PATH === undefined) {
	throw new Error(
		'server_state_torn_native: DEDALO_TS_STATE_PATH is not set — refusing to run against the live server state file (S1-18)',
	);
}
const ORIGINAL = existsSync(STATE_PATH) ? readFileSync(STATE_PATH, 'utf8') : null;
const LINK = `${STATE_PATH}.zztorn_link`;

function restore(): void {
	rmSync(LINK, { force: true });
	rmSync(STATE_PATH as string, { force: true });
	if (ORIGINAL !== null) writeFileSync(STATE_PATH as string, ORIGINAL);
	// a readable (or absent) file ends the damage: the next one is said again
	getServerState();
}

function capturedErrors<T>(run: () => T): { result: T; lines: string[] } {
	const lines: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
	try {
		return { result: run(), lines };
	} finally {
		console.error = original;
	}
}

afterEach(restore);
afterAll(restore);

const NON_ROOT = 7;

/** What a crash mid-write, or a careless edit, leaves behind. */
const TORN: Record<string, string> = {
	'empty (truncated before the first byte)': '',
	'truncated JSON': '{\n\t"maintenance_mode": tr',
	'the JSON null': 'null',
	'an array': '[]',
	'not JSON at all': 'maintenance_mode = true',
};

describe('T1 a torn state file fails CLOSED', () => {
	for (const [name, content] of Object.entries(TORN)) {
		test(`${name}: maintenance is ON for a non-root session, root passes, said once`, () => {
			writeFileSync(STATE_PATH, content);
			const { result, lines } = capturedErrors(() => [
				getServerState().maintenance_mode,
				refusedUnderMaintenance(NON_ROOT),
				refusedUnderMaintenance(SUPERUSER_ID),
				// the read is per request: a second and a third must not log again
				getServerState().maintenance_mode,
			]);
			expect(result).toEqual([true, true, false, true]);
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain(STATE_PATH);
			expect(lines[0]).toContain('FAILING CLOSED');
		});
	}

	test('control: a well-formed file with maintenance off is OPEN, and silent', () => {
		writeFileSync(STATE_PATH, '{"maintenance_mode": false}\n');
		const { result, lines } = capturedErrors(() => refusedUnderMaintenance(NON_ROOT));
		expect(result).toBe(false);
		expect(lines).toEqual([]);
	});
});

describe('T2 no file is the first state, not damage', () => {
	test('the defaults, maintenance off, nothing logged', () => {
		rmSync(STATE_PATH, { force: true });
		const { result, lines } = capturedErrors(() => getServerState());
		expect(result.maintenance_mode).toBe(false);
		expect(result.install_status).toBeUndefined();
		expect(lines).toEqual([]);
	});
});

describe('T3 the way out', () => {
	test('saving the state over a torn file rewrites it clean, with the saved value', () => {
		writeFileSync(STATE_PATH, '{"maintenance_mode": tr');
		capturedErrors(() => setServerState({ maintenance_mode: false, notification: 'back' }));
		const onDisk = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as Record<string, unknown>;
		expect(onDisk.maintenance_mode).toBe(false);
		expect(onDisk.notification).toBe('back');
		const { result, lines } = capturedErrors(() => refusedUnderMaintenance(NON_ROOT));
		expect(result).toBe(false);
		expect(lines).toEqual([]);
	});
});

describe('T4 the writer cannot tear the file', () => {
	test('replaced by rename: a hard link taken before keeps the old bytes; no temp left; mode kept', () => {
		const before = '{"maintenance_mode": false, "notification": "old"}\n';
		writeFileSync(STATE_PATH, before);
		chmodSync(STATE_PATH, 0o640);
		linkSync(STATE_PATH, LINK);
		setServerState({ maintenance_mode: true });
		// An in-place write (truncate + write) goes through the shared inode and
		// changes what the link reads; a rename leaves the old inode untouched.
		expect(readFileSync(LINK, 'utf8')).toBe(before);
		const after = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as Record<string, unknown>;
		expect(after.maintenance_mode).toBe(true);
		expect(after.notification).toBe('old');
		expect(statSync(STATE_PATH).mode & 0o777).toBe(0o640);
		const siblings = readdirSync(dirname(STATE_PATH)).filter(
			(name) => name.startsWith(basename(STATE_PATH)) && name !== basename(STATE_PATH),
		);
		expect(siblings).toEqual([basename(LINK)]);
	});
});
