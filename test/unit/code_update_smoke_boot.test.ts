/**
 * core/update/smoke_boot.ts — the pre-swap boot check of a quarantine tree.
 * Driven against SYNTHETIC codeRoots (a tiny src/server.ts, not the engine):
 * one that binds the throwaway unix socket and answers /health (green +
 * clean SIGTERM exit), one that exits 1 immediately (typed update.refused,
 * child stderr on the LOG side only).
 *
 * HONEST LIMITS: the synthetic servers only echo/assert the env they receive,
 * so these tests prove the spawn PROTOCOL — including that the private-state
 * env keys are neutralised into the staging dir (FINDING 2, 2026-08-23
 * review) — NOT that the real src/server.ts writes nothing when it boots.
 * That guarantee is structural, not test-observed: the child cannot NAME live
 * state (DEDALO_PRIVATE_DIR / DEDALO_SESSION_DB_PATH / DEDALO_TS_STATE_PATH
 * all point under the staging dir), and the source-shape tripwire below pins
 * the neutralisation to the spawn site so it cannot be quietly removed.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { smokeBootQuarantine } from '../../src/core/update/smoke_boot.ts';
import { refusalOf } from '../helpers/refusal.ts';
import { removeScratchDir, scratchDir } from '../helpers/scratch_dir.ts';

/**
 * THE ROOT MUST KEEP THE SOCKET PATH UNDER 104 BYTES.
 *
 * The smoke boot binds a UNIX SOCKET inside the staging dir it is handed
 * (`<root>/<case>/staging/smoke_boot.sock`), and macOS caps a socket path at
 * 104 bytes. A stock macOS `TMPDIR` is a per-user `/var/folders/…/T/` — ~49 of
 * those bytes — so three of these tests died with ENAMETOOLONG on a plain
 * checkout and passed only under `TMPDIR=/tmp/dd`. A gate must not be red
 * because of the machine's temp-dir naming.
 *
 * `TMPDIR` is still HONOURED when it fits (it is how a machine redirects
 * scratch writes off `/tmp`); the fallback engages only when this root's own
 * longest socket path would not fit, which is a fact about the path, measured
 * rather than assumed.
 */
const SOCKET_PATH_MAX = 104;
/** The deepest path any case builds under the root, relative to it. */
const DEEPEST_CHILD = '/neutralised/staging/smoke_boot.sock';
const SCRATCH_LABEL = 'smoke_boot';

/** A PRIVATE scratch root (mkdtemp, 0700), under `$TMPDIR` unless its deepest socket would not fit. */
function scratchRoot(): string {
	const preferred = scratchDir(SCRATCH_LABEL);
	if (`${preferred}${DEEPEST_CHILD}`.length <= SOCKET_PATH_MAX) return preferred;
	removeScratchDir(preferred);
	return scratchDir(SCRATCH_LABEL, { parent: '/tmp' });
}

const ROOT = scratchRoot();

beforeAll(() => {
	mkdirSync(ROOT, { recursive: true });
});
afterAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

/** A synthetic quarantine: src/server.ts with the given source. */
function syntheticTree(name: string, serverSource: string): { codeRoot: string; staging: string } {
	const codeRoot = join(ROOT, name, 'dedalo_code');
	const staging = join(ROOT, name, 'staging');
	mkdirSync(join(codeRoot, 'src'), { recursive: true });
	mkdirSync(staging, { recursive: true });
	writeFileSync(join(codeRoot, 'src', 'server.ts'), serverSource);
	return { codeRoot, staging };
}

const HEALTHY_SERVER = `
// Honour the smoke contract: bind SERVER_UNIX_SOCKET, answer /health, exit 0 on SIGTERM.
const socket = process.env.SERVER_UNIX_SOCKET;
if (process.env.DEDALO_SMOKE_BOOT !== 'true') {
	console.error('expected DEDALO_SMOKE_BOOT=true');
	process.exit(2);
}
const server = Bun.serve({
	unix: socket,
	fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === '/health') return Response.json({ result: 'ok' });
		return new Response('not found', { status: 404 });
	},
});
process.on('SIGTERM', () => {
	server.stop(true);
	process.exit(0);
});
`;

describe('smokeBootQuarantine', () => {
	test('a tree that binds and answers /health passes (SIGTERM, clean exit)', async () => {
		const { codeRoot, staging } = syntheticTree('healthy', HEALTHY_SERVER);
		// resolves without throwing — the whole contract
		await smokeBootQuarantine(codeRoot, staging);
	}, 60000);

	test('a tree that exits 1 refuses with update.refused and log-side stderr', async () => {
		const { codeRoot, staging } = syntheticTree(
			'dead',
			`console.error('BOOT FATAL: synthetic failure'); process.exit(1);`,
		);
		const refusal = await refusalOf(smokeBootQuarantine(codeRoot, staging));
		expect(refusal.code).toBe('update.refused');
		// the operator sentence says nothing was swapped…
		expect(refusal.publicMessage).toContain('nothing was swapped');
		// …and the child's stderr rides only the LOG side (the cause chain).
		expect(String((refusal.cause as Error | undefined)?.message ?? '')).toContain(
			'BOOT FATAL: synthetic failure',
		);
		expect(refusal.publicMessage ?? '').not.toContain('BOOT FATAL');
	}, 60000);

	test('a tree that binds but exits DIRTY on SIGTERM refuses', async () => {
		const { codeRoot, staging } = syntheticTree(
			'dirty_exit',
			HEALTHY_SERVER.replace('process.exit(0);', 'process.exit(3);'),
		);
		const refusal = await refusalOf(smokeBootQuarantine(codeRoot, staging));
		expect(refusal.code).toBe('update.refused');
		expect(String((refusal.cause as Error | undefined)?.message ?? '')).toContain('exited 3');
	}, 60000);

	test('the child env is NEUTRALISED: every private-state key points under the staging dir', async () => {
		// A synthetic server that refuses to answer /health unless the whole
		// private-state surface was repointed away from live state. If the spawn
		// site ever stops neutralising, this goes red end-to-end.
		const { codeRoot, staging } = syntheticTree(
			'neutralised',
			`
const socket = process.env.SERVER_UNIX_SOCKET;
const inStaging = (value) => typeof value === 'string' && value.startsWith(${JSON.stringify(join(ROOT, 'neutralised', 'staging'))});
const bad = ['DEDALO_PRIVATE_DIR', 'DEDALO_SESSION_DB_PATH', 'DEDALO_TS_STATE_PATH'].filter(
	(key) => !inStaging(process.env[key]),
);
if (bad.length > 0) {
	console.error('NOT NEUTRALISED: ' + bad.join(','));
	process.exit(2);
}
// The throwaway ts_state.json must already exist and be sealed, so the child
// boots as a configured instance, never the install wizard.
const state = JSON.parse(require('node:fs').readFileSync(process.env.DEDALO_TS_STATE_PATH, 'utf8'));
if (state.install_status !== 'sealed') {
	console.error('UNSEALED SMOKE STATE');
	process.exit(2);
}
const server = Bun.serve({
	unix: socket,
	fetch() { return Response.json({ result: 'ok' }); },
});
process.on('SIGTERM', () => { server.stop(true); process.exit(0); });
`,
		);
		// Poison the parent env exactly like a production install: an explicit
		// live session-db path that MUST NOT reach the child unrewritten.
		const previous = process.env.DEDALO_SESSION_DB_PATH;
		try {
			process.env.DEDALO_SESSION_DB_PATH = '/definitely/live/sessions.sqlite';
			await smokeBootQuarantine(codeRoot, staging);
		} finally {
			if (previous === undefined) delete process.env.DEDALO_SESSION_DB_PATH;
			else process.env.DEDALO_SESSION_DB_PATH = previous;
		}
	}, 60000);
});

/**
 * SOURCE-SHAPE TRIPWIRE (install_restart_supervisor_tripwire style) — FINDING
 * 2's structural half: the neutralisation lives at the ONE spawn site, and the
 * server's skippable boot blocks stay smoke-guarded. Shape, not behaviour: it
 * pins the mechanism so it cannot be quietly removed by a future edit.
 */
describe('smoke boot read-only-by-structure tripwire', () => {
	test('smoke_boot.ts neutralises the private-state env keys at the spawn site', async () => {
		const src = await Bun.file(
			new URL('../../src/core/update/smoke_boot.ts', import.meta.url),
		).text();
		// The throwaway private dir is derived from the staging dir…
		expect(src).toContain("join(stagingDir, 'smoke_private')");
		// …and each key that can name live state is pinned to it in the child env.
		expect(src).toContain('DEDALO_PRIVATE_DIR: smokePrivateDir');
		expect(src).toContain(
			"DEDALO_SESSION_DB_PATH: join(smokePrivateDir, 'dedalo_ts_sessions.sqlite')",
		);
		expect(src).toContain("DEDALO_TS_STATE_PATH: join(smokePrivateDir, 'ts_state.json')");
		// The throwaway state is sealed so the child never boots the installer.
		expect(src).toContain("install_status: 'sealed'");
	});

	test('server.ts keeps its smoke-boot skip guards on the boot writers', async () => {
		const src = await Bun.file(new URL('../../src/server.ts', import.meta.url)).text();
		// The flag is read once…
		expect(src).toContain("readEnv('DEDALO_SMOKE_BOOT') === 'true'");
		// …and the skippable boot blocks (migrations/schedulers/diffusion/
		// watchers/media provisioning) are guarded. These conditionals are the
		// CONVENTION layer; the env neutralisation above is the guarantee — but
		// losing the skips would make the smoke child slow and noisy against the
		// shared DB, so their presence is pinned too.
		const guards = src.match(/!smokeBoot\b/g) ?? [];
		expect(guards.length).toBeGreaterThanOrEqual(4);
	});
});
