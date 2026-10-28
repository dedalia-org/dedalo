/**
 * ONE SUITE RUN AT A TIME per suite database.
 *
 * `bun test` (preload canonical_test3.ts), `bun run test:client` and
 * `bun run test:crawl` all reseed or fixture the same database: test3 is
 * restored wholesale, the crawl's persona records live in it. Two of them at
 * once wiped each other's fixtures and failed with misleading reds (a crawl
 * sweep "removed 0 rows", client suites reading a reseeded test3). Each takes
 * this lock first and refuses loudly while another live process holds it.
 *
 * The lock is a file named after the suite database (shards and lanes hold
 * different databases, so they never contend). A lock whose holder process is
 * dead is stale and reclaimed. A child process of the holder (a gate that
 * spawns `bun test`, a runner's own server) inherits the holder's token through
 * the environment and passes without taking the lock again.
 */

import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOKEN_ENV = 'DEDALO_SUITE_RUN_LOCK';

interface LockBody {
	pid: number;
	holder: string;
	started: string;
}

export function suiteRunLockPath(
	suiteDb: string,
	dir = join(tmpdir(), 'dedalo_suite_run_locks'),
): string {
	return join(dir, `${suiteDb.replace(/[^A-Za-z0-9_.-]/g, '_')}.lock`);
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/**
 * Take the run lock for `suiteDb`, or throw naming the live holder. Released on
 * process exit; the returned function releases it earlier.
 */
export function acquireSuiteRunLock(
	suiteDb: string,
	holder: string,
	options: { dir?: string } = {},
): () => void {
	const path = suiteRunLockPath(suiteDb, options.dir);
	mkdirSync(join(path, '..'), { recursive: true });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(path, 'wx');
			const body: LockBody = { pid: process.pid, holder, started: new Date().toISOString() };
			writeSync(fd, JSON.stringify(body));
			closeSync(fd);
			process.env[TOKEN_ENV] = `${path}#${process.pid}`;
			let released = false;
			const release = () => {
				if (released) return;
				released = true;
				try {
					const current = JSON.parse(readFileSync(path, 'utf8')) as LockBody;
					if (current.pid === process.pid) rmSync(path, { force: true });
				} catch {
					/* already gone */
				}
			};
			process.once('exit', release);
			return release;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		}
		let current: LockBody | null = null;
		try {
			current = JSON.parse(readFileSync(path, 'utf8')) as LockBody;
		} catch {
			current = null; // unreadable (a half-written file): treat as stale
		}
		if (current !== null && alive(current.pid)) {
			// a descendant of the holder runs inside the holder's run
			if (process.env[TOKEN_ENV] === `${path}#${current.pid}`) return () => {};
			throw new Error(
				`REFUSED: suite database '${suiteDb}' is in use by ${current.holder} (pid ${current.pid}, since ${current.started}). One suite run at a time — bun test, test:client and test:crawl reseed the same fixtures. Wait for it, or stop it; a dead holder's lock is reclaimed automatically (${path}).`,
			);
		}
		rmSync(path, { force: true }); // stale: the holder is gone
	}
	throw new Error(`could not take the suite run lock ${path}`);
}
