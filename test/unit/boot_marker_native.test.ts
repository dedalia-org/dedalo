/**
 * THE ENGINE WRITES THE BOOT MARKER ITS WATCHDOG READS (T1-26 / S15; finding F3,
 * campaign 2 L7). deploy/dedalo-ts-watchdog.sh extends its boot grace while
 * `$(dirname <socket>)/booting` names a live pid; until T1-26 nothing wrote it (the
 * consumer gate, install_restart_supervisor_tripwire GRACE_CASES, plants it).
 *
 *  B1 the module (src/core/update/boot_marker.ts): supervised + private dir → the
 *     marker holds `<pid>\n`; unsupervised, a world-writable dir, a missing dir → no
 *     marker; a LIVE foreign pid's marker is never overwritten; a write's `clear`
 *     removes that file only (a marker replaced since is left alone).
 *  B2 the REAL server (spawned, supervised, a 0700 scratch socket dir): the marker
 *     appears holding the child's pid BEFORE the socket binds, is gone once /health
 *     answers, and nothing of it is left after SIGTERM.
 *  B3 a boot refused because the socket is held LIVE exits 1 and leaves no marker
 *     (the exit hook).
 *
 * Isolation as dev_listener_tls_native: an ephemeral socket in a scratch dir, the
 * diffusion scheduler off, a marked scratch processes dir, the preload's suite
 * database and session store inherited.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
	BOOT_MARKER_NAME,
	bootMarkerPath,
	writeBootMarker,
} from '../../src/core/update/boot_marker.ts';
import { markProcessesDir } from '../helpers/test_media_root.ts';

const ROOT = resolve(import.meta.dir, '../..');
// Short: macOS caps a unix socket path at 104 bytes.
const scratch = mkdtempSync(join(tmpdir(), 'zzbm_'));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let dirCount = 0;
function socketDir(mode: number): string {
	dirCount += 1;
	const dir = join(scratch, `d${dirCount}`);
	mkdirSync(dir);
	chmodSync(dir, mode);
	return dir;
}

/** A pid that is certainly alive and not ours: a sleeping child. */
function foreignLivePid(): { pid: number; kill: () => void } {
	const child = Bun.spawn(['sleep', '30']);
	return { pid: child.pid, kill: () => child.kill('SIGKILL') };
}

describe('B1 the boot marker module', () => {
	test('the name the watchdog derives: <socket dir>/booting', () => {
		expect(BOOT_MARKER_NAME).toBe('booting');
		expect(bootMarkerPath('/run/dedalo-x/dedalo_ts.sock')).toBe('/run/dedalo-x/booting');
	});

	test('supervised, private dir: written, holding our pid; its clear removes it', async () => {
		const socket = join(socketDir(0o750), 'dedalo_ts.sock');
		const write = await writeBootMarker(socket, { supervised: true });
		expect(write.outcome).toBe('written');
		expect(readFileSync(bootMarkerPath(socket), 'utf8')).toBe(`${process.pid}\n`);
		if (write.outcome === 'written') write.clear();
		expect(existsSync(bootMarkerPath(socket))).toBe(false);
	});

	test('unsupervised, world-writable dir, missing dir: nothing written', async () => {
		const privateSocket = join(socketDir(0o700), 's.sock');
		expect((await writeBootMarker(privateSocket, { supervised: false })).outcome).toBe(
			'skipped:unsupervised',
		);
		expect(existsSync(bootMarkerPath(privateSocket))).toBe(false);
		const shared = join(socketDir(0o1777), 's.sock');
		expect((await writeBootMarker(shared, { supervised: true })).outcome).toBe(
			'skipped:world_writable_dir',
		);
		expect(existsSync(bootMarkerPath(shared))).toBe(false);
		const missing = join(scratch, 'absent', 's.sock');
		expect((await writeBootMarker(missing, { supervised: true })).outcome).toBe(
			'skipped:no_socket_dir',
		);
	});

	test('a LIVE foreign marker is never overwritten; a dead one is replaced', async () => {
		const socket = join(socketDir(0o700), 's.sock');
		const foreign = foreignLivePid();
		try {
			writeFileSync(bootMarkerPath(socket), `${foreign.pid}\n`);
			expect((await writeBootMarker(socket, { supervised: true })).outcome).toBe(
				'skipped:foreign_live_marker',
			);
			expect(readFileSync(bootMarkerPath(socket), 'utf8')).toBe(`${foreign.pid}\n`);
		} finally {
			foreign.kill();
		}
		// a pid that cannot be alive (beyond any pid_max) is a dead marker
		writeFileSync(bootMarkerPath(socket), '99999999\n');
		const write = await writeBootMarker(socket, { supervised: true });
		expect(write.outcome).toBe('written');
		expect(readFileSync(bootMarkerPath(socket), 'utf8')).toBe(`${process.pid}\n`);
		if (write.outcome === 'written') write.clear();
	});

	test('clear removes only the file it wrote: a marker replaced since is left alone', async () => {
		const socket = join(socketDir(0o700), 's.sock');
		const write = await writeBootMarker(socket, { supervised: true });
		expect(write.outcome).toBe('written');
		rmSync(bootMarkerPath(socket));
		writeFileSync(bootMarkerPath(socket), '4242\n');
		if (write.outcome === 'written') write.clear();
		expect(readFileSync(bootMarkerPath(socket), 'utf8')).toBe('4242\n');
	});

	// The inode is no identity on its own: Linux hands a freed inode to the next
	// file (the case above went red in the CI image). Rewriting IN PLACE keeps the
	// inode on every filesystem, so this case is deterministic — only the content
	// (our pid) tells our marker from a foreign one.
	test('clear leaves a marker that kept our inode but holds another pid', async () => {
		const socket = join(socketDir(0o700), 's.sock');
		const write = await writeBootMarker(socket, { supervised: true });
		expect(write.outcome).toBe('written');
		const before = statSync(bootMarkerPath(socket)).ino;
		writeFileSync(bootMarkerPath(socket), '4242\n');
		expect(statSync(bootMarkerPath(socket)).ino).toBe(before);
		if (write.outcome === 'written') write.clear();
		expect(readFileSync(bootMarkerPath(socket), 'utf8')).toBe('4242\n');
	});
});

function spawnServer(socket: string, tag: string): ReturnType<typeof Bun.spawn> {
	return Bun.spawn([process.execPath, 'run', 'src/server.ts'], {
		cwd: ROOT,
		env: {
			...(process.env as Record<string, string>),
			SERVER_UNIX_SOCKET: socket,
			SERVER_TCP_PORT: '',
			SERVER_TCP_TLS_CERT_FILE: '',
			SERVER_TCP_TLS_KEY_FILE: '',
			DEDALO_SUPERVISED: 'true',
			DEDALO_DIFFUSION_SCHEDULER_ENABLED: 'false',
			DEDALO_MEDIA_PROCESSES_DIR: markProcessesDir(join(scratch, `processes_${tag}`)),
		},
		stdout: 'pipe',
		stderr: 'pipe',
	});
}

async function healthy(socket: string): Promise<boolean> {
	try {
		return (await fetch('http://localhost/health', { unix: socket })).status === 200;
	} catch {
		return false;
	}
}

describe('B2/B3 the real server', () => {
	test('B2: the marker exists, holding the server pid, BEFORE the socket binds; gone once /health answers and after SIGTERM', async () => {
		const dir = socketDir(0o700);
		const socket = join(dir, 's.sock');
		const marker = bootMarkerPath(socket);
		const server = spawnServer(socket, 'b2');
		let seenBeforeSocket: string | null = null;
		try {
			const deadline = Date.now() + 60_000;
			while (Date.now() < deadline && !existsSync(socket)) {
				if (server.exitCode !== null) throw new Error(`server exited ${server.exitCode}`);
				if (seenBeforeSocket === null && existsSync(marker)) {
					try {
						seenBeforeSocket = readFileSync(marker, 'utf8');
					} catch {
						/* cleared between the two calls */
					}
				}
				await Bun.sleep(10);
			}
			expect(seenBeforeSocket).toBe(`${server.pid}\n`);
			while (Date.now() < deadline && !(await healthy(socket))) await Bun.sleep(100);
			expect(await healthy(socket)).toBe(true);
			expect(existsSync(marker)).toBe(false);
		} finally {
			server.kill('SIGTERM');
			await server.exited;
		}
		expect(existsSync(marker)).toBe(false);
	}, 90_000);

	test('B3: a boot refused over a LIVE socket exits 1 and leaves no marker', async () => {
		const dir = socketDir(0o700);
		const socket = join(dir, 's.sock');
		const holder = Bun.listen({ unix: socket, socket: { data: () => {} } });
		try {
			const server = spawnServer(socket, 'b3');
			const killer = setTimeout(() => server.kill('SIGKILL'), 60_000);
			const code = await server.exited;
			clearTimeout(killer);
			const stderr = await new Response(server.stderr as ReadableStream).text();
			expect(code).toBe(1);
			expect(stderr).toContain('another server instance is already listening');
			expect(existsSync(bootMarkerPath(socket))).toBe(false);
		} finally {
			holder.stop(true);
		}
	}, 90_000);
});
