/**
 * system_info widget — TS-NATIVE host/runtime snapshot; replaces the PHP Linfo
 * panel. Produces the EXACT shape the client renderer (render_system_info.js)
 * consumes: { requeriments_list:[{name,value,info}], system_list:[{name,value}],
 * errors:[] }. The client's health_list sub-panel is fired browser-side (no
 * server data). Fails soft: a probe failure becomes a requirement row / error
 * string, never a throw.
 */

import { sql } from '../../db/postgres.ts';
import type { WidgetModule, WidgetResponse } from './support.ts';

/** Human GB from a byte count (2 decimals), matching the PHP panel style. */
function bytesToGb(bytes: number): string {
	return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * Semver-ish compare (major.minor.patch); returns -1 | 0 | 1.
 *
 * UNPARSABLE INPUT IS FAIL-CLOSED, AND THAT IS THE CONTRACT. `Number('x')` is
 * NaN, `NaN !== 0` is TRUE, so the loop RETURNS on the first segment, and
 * `NaN > 0` is false ⇒ -1: an unparsable runtime version reports as BELOW the
 * floor. (This CORRECTS the coverage plan's §4.4 D6, which claimed the NaN
 * arithmetic fell through to 0 = EQUAL = SUPPORTED. Measured 2026-08-11:
 * `compareSemver('x.y.z','1.3.9') === -1`. D6 is struck; there is no defect.)
 *
 * RESIDUAL, LEDGERED — the function is NOT ANTISYMMETRIC across an unparsable
 * operand: both `compareSemver('x.y.z','1.3.9')` and `compareSemver('1.3.9','x.y.z')`
 * return -1. Harmless for the sole caller below, which only asks `>= 0` against
 * a literal MIN_BUN floor; a trap for any SECOND caller that assumes
 * `cmp(a,b) === -cmp(b,a)` (a sort comparator would be the first one to break).
 * GATED: test/unit/system_info_semver_native.test.ts pins both directions.
 */
export function compareSemver(a: string, b: string): number {
	const pa = a.split('.').map(Number);
	const pb = b.split('.').map(Number);
	for (let i = 0; i < 3; i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return diff > 0 ? 1 : -1;
	}
	return 0;
}

/**
 * COVERAGE-EXEMPT (coverage plan §5.1; reason registered in
 * engineering/crap_coverage_exempt.json): an os/probe projection whose every
 * branch is a fail-soft try/catch around ONE syscall — the assertion would read
 * the same host the code reads. Its one real DECISION, the Bun version-floor
 * comparison, is extracted to `compareSemver` above and gated by
 * test/unit/system_info_semver_native.test.ts.
 */
async function systemInfoGetValue(): Promise<WidgetResponse> {
	const os = await import('node:os');
	const errors: string[] = [];

	// --- system_list: OS / hardware overview (labels mirror the PHP Linfo panel) ---
	const system_list: { name: string; value: unknown }[] = [];
	system_list.push({ name: 'os', value: `${os.type()} ${os.release()} (${os.arch()})` });
	system_list.push({ name: 'hostname', value: os.hostname() });
	const cpus = os.cpus();
	system_list.push({
		name: 'cpu',
		value: cpus.length > 0 ? `${(cpus[0]?.model ?? '').trim()} × ${cpus.length}` : null,
	});
	system_list.push({
		name: 'ram',
		value: `${bytesToGb(os.totalmem() - os.freemem())} used / ${bytesToGb(os.totalmem())} total`,
	});
	// disk free on the server working directory (best-effort; statfs may be absent)
	try {
		const { statfsSync } = await import('node:fs');
		const stat = statfsSync(process.cwd());
		const total = Number(stat.blocks) * Number(stat.bsize);
		const free = Number(stat.bfree) * Number(stat.bsize);
		system_list.push({ name: 'hd', value: `${bytesToGb(free)} free / ${bytesToGb(total)} total` });
	} catch {
		system_list.push({ name: 'hd', value: null });
	}
	system_list.push({ name: 'uptime', value: `${Math.round(os.uptime() / 3600)} h` });
	system_list.push({
		name: 'load',
		value: os
			.loadavg()
			.map((n) => n.toFixed(2))
			.join(' '),
	});
	system_list.push({ name: 'engine', value: `bun ${Bun.version}` });

	// --- requeriments_list: Bun-native prerequisite checks ---
	const requeriments_list: { name: string; value: boolean | string | null; info: string }[] = [];

	// The actually-verified runtime floor (audit S2-36): postgres.ts, the Bun.sql
	// mariadb adapter and the jsonb param conventions are verified against 1.4.4
	// (re-probed 2026-08-25 on the 1.3.9 -> 1.4.0 bump, and 2026-09-23 on
	// 1.4.0 -> 1.4.2: the jsonb double-encode trap is UNCHANGED, the mariadb
	// adapter decodes DATETIME as UTC and JSON columns as objects; and 2026-10-14 on
	// 1.4.2 -> 1.4.3, same answers — the move is for the spawnSync fix, bun#34069;
	// and 2026-11-02 on 1.4.3 -> 1.4.4, same answers — a latest-stable move).
	// Keep in lockstep with .bun-version + package.json engines.bun.
	const MIN_BUN = '1.4.4';
	requeriments_list.push({
		name: 'Bun supported version',
		value: compareSemver(Bun.version, MIN_BUN) >= 0,
		info: `Version: ${Bun.version} - minimum: ${MIN_BUN}`,
	});

	let dbOk = false;
	try {
		await sql.unsafe('SELECT 1', []);
		dbOk = true;
	} catch (error) {
		errors.push(`Database connection failed: ${(error as Error).message}`);
	}
	requeriments_list.push({
		name: 'Database reachable',
		value: dbOk,
		info: dbOk ? 'PostgreSQL responded to SELECT 1' : 'PostgreSQL did not respond',
	});

	try {
		const { getBackupDir } = await import('../backup.ts');
		const { accessSync, constants } = await import('node:fs');
		const dir = getBackupDir();
		accessSync(dir, constants.W_OK);
		requeriments_list.push({ name: 'Backup directory writable', value: true, info: dir });
	} catch (error) {
		requeriments_list.push({
			name: 'Backup directory writable',
			value: false,
			info: (error as Error).message,
		});
	}

	return { data: { requeriments_list, system_list, errors } };
}

export const widget: WidgetModule = {
	spec: {
		id: 'system_info',
		category: 'system',
		class: 'width_100',
		background: true,
		label: { kind: 'literal', text: 'System info' },
	},
	getValue: systemInfoGetValue,
};
