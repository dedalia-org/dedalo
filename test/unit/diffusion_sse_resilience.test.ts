/**
 * S1-15 gate (derived from probes/D4/sse_poll_crash.ts): Bun exits with code 1
 * on the first floating promise rejection — even with a live Bun.serve — so a
 * single DB error inside the SSE poll loop used to kill the whole multi-user
 * server.
 *
 * Two layers, both asserted here:
 * 1. In-process: buildJobFollowStream catches a rejecting resolveJob and
 *    TERMINATES the stream with a terminal error chunk (never swallow-only —
 *    the client stream must not hang on a dead poll loop).
 * 2. Subprocess: with installUnhandledRejectionGuard() installed and a live
 *    Bun.serve, a REAL rejected getJobById (malformed uuid → Postgres error,
 *    the probe's stand-in for any transient DB failure) plus a bare floating
 *    rejection leave the process ALIVE (exit 0), with the SSE stream closed
 *    by the error chunk.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { buildJobFollowStream } from '../../src/diffusion/api/actions.ts';
import type { ProgressData } from '../../src/diffusion/jobs/sse.ts';
import { scratchFile } from '../helpers/scratch_dir.ts';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const PROBE_SCRIPT = scratchFile('ts_s1_15_probe', 'ts_s1_15_probe.ts');

afterAll(() => {
	rmSync(PROBE_SCRIPT, { force: true });
});

/** Parse every data frame of a fully-read SSE body. */
function parseSseFrames(text: string): ProgressData[] {
	return text
		.split('\n\n')
		.filter((frame) => frame.startsWith('data:\n'))
		.map((frame) => JSON.parse(frame.slice('data:\n'.length).trimEnd()) as ProgressData);
}

describe('diffusion SSE resilience (S1-15)', () => {
	test('a rejecting resolveJob terminates the stream with the error chunk', async () => {
		const stream = buildJobFollowStream(
			() => Promise.reject(new Error('stub: db connection reset')),
			's1_15_inproc_probe',
			50,
			{ commentHeartbeat: false },
		);
		// text() resolves ONLY when the stream closes — a swallowed error with no
		// finish() would hang here (caught by the test timeout).
		const text = await new Response(stream).text();
		const chunks = parseSseFrames(text);
		expect(chunks.length).toBe(1); // exactly the terminal error chunk
		expect(chunks[0]?.process_id).toBe('s1_15_inproc_probe');
		expect(chunks[0]?.is_running).toBe(false);
		expect(chunks[0]?.errors).toEqual(['process status read failed']);
	}, 10000);

	test('guarded process survives a real rejected getJobById under a live Bun.serve', async () => {
		const script = `
import { installUnhandledRejectionGuard } from ${JSON.stringify(`${REPO_ROOT}src/server.ts`)};
import { buildJobFollowStream } from ${JSON.stringify(`${REPO_ROOT}src/diffusion/api/actions.ts`)};
import { getJobById } from ${JSON.stringify(`${REPO_ROOT}src/diffusion/jobs/queue.ts`)};

installUnhandledRejectionGuard();

// The stand-in interactive server (the process the guard must keep alive).
const server = Bun.serve({
	port: 0,
	fetch: () =>
		new Response(
			// The REAL queue read, rejecting: malformed uuid -> Postgres error.
			buildJobFollowStream(() => getJobById('s1-15-not-a-uuid'), 's1_15_probe', 50, {
				commentHeartbeat: false,
			}),
			{ headers: { 'Content-Type': 'text/event-stream' } },
		),
});

// The stream must CLOSE with the terminal error chunk (text() resolves only
// on close; a dead poll loop would hang until the outer test times out).
const response = await fetch('http://localhost:' + server.port + '/');
const text = await response.text();
const hasErrorChunk =
	text.includes('"process_id":"s1_15_probe"') &&
	text.includes('"is_running":false') &&
	text.includes('"errors":["process status read failed"]');
console.log(hasErrorChunk ? 'ERROR_CHUNK_OK' : 'ERROR_CHUNK_BAD ' + JSON.stringify(text.slice(0, 500)));

// A bare floating rejection — the exact class of bug the guard is the last
// line of defense for. Unguarded Bun dies here with exit code 1.
void Promise.reject(new Error('probe: floating rejection'));
setTimeout(() => {
	console.log('SURVIVED');
	process.exit(0);
}, 500);
`;
		await Bun.write(PROBE_SCRIPT, script);
		const child = Bun.spawn([process.execPath, 'run', PROBE_SCRIPT], {
			cwd: REPO_ROOT,
			stdout: 'pipe',
			stderr: 'pipe',
			env: { ...process.env },
		});
		const exitCode = await child.exited;
		const stdout = await new Response(child.stdout).text();
		const stderr = await new Response(child.stderr).text();

		// Process alive to its own clean exit — not killed by either rejection.
		expect(exitCode).toBe(0);
		expect(stdout).toContain('ERROR_CHUNK_OK');
		expect(stdout).toContain('SURVIVED');
		// The guard is LOUD: the floating rejection is logged, never swallowed.
		expect(stderr).toContain('[FATAL-AVERTED] unhandledRejection');
	}, 30000);
});
