/**
 * THE HOST RUN KEEPS A TRANSCRIPT (install campaign C4, DEB13 F4): a docker
 * run's output lived only in the TUI's `l` view, and docker.md promised
 * Docker's error "in the install log of the run". Now every log and warning
 * line goes to `install.log` beside the install record — held until that
 * directory exists, redacted against the run's secrets, 0600, and stopped by
 * a completed --abort (which removes it with the record).
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTranscript } from '../../src/core/install/host/host_executor.ts';
import type { RunIo } from '../../src/core/install/run_events.ts';
import { LOG_FILE } from '../../src/core/install/run_files_core.ts';

const scratch = mkdtempSync(join(tmpdir(), 'dedalo_transcript_'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('install.log', () => {
	test('held until the run dir exists, then appended; the screen still gets every line', () => {
		const dir = join(scratch, 'run');
		const file = join(dir, LOG_FILE);
		const shown: string[] = [];
		const io = runTranscript(file, dir, () => ['s3cr3t']).tee({
			log: (line) => shown.push(line),
			warn: (line) => shown.push(`warn ${line}`),
		} as RunIo);
		io.log('→ [stack_preflight] docker 29.0');
		mkdirSync(dir);
		io.warn('pull failed: token s3cr3t refused');
		const text = readFileSync(file, 'utf8');
		expect(text).toMatch(/^--- install run \d{4}-/);
		expect(text).toContain('→ [stack_preflight] docker 29.0');
		expect(text).toContain('pull failed: token [redacted] refused');
		expect(text).not.toContain('s3cr3t');
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(shown).toEqual([
			'→ [stack_preflight] docker 29.0',
			'warn pull failed: token s3cr3t refused',
		]);
	});

	test('the one-time display is not teed; close() stops the file', () => {
		const dir = join(scratch, 'run2');
		mkdirSync(dir);
		const file = join(dir, LOG_FILE);
		const transcript = runTranscript(file, dir, () => []);
		const io = transcript.tee({
			log: () => undefined,
			warn: () => undefined,
			showOnce: () => true,
		} as RunIo);
		io.showOnce?.(['generated DEDALO_SALT_STRING = abc']);
		io.log('done');
		// The failure block the front end draws itself reaches the file through note().
		transcript.note(['✖ install failed at step [stack_image]: pull refused']);
		transcript.close();
		io.log('after abort');
		const text = readFileSync(file, 'utf8');
		expect(text).toContain('done');
		expect(text).toContain('✖ install failed at step [stack_image]: pull refused');
		expect(text).not.toContain('DEDALO_SALT_STRING');
		expect(text).not.toContain('after abort');
	});
});
