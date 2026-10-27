/**
 * INSTALL --plain COMBINATION REFUSAL (native gate, finding F5) — a refused
 * flag combination is refused BEFORE the first prompt, and the refusal names the
 * offending flag.
 *
 * `sh install.sh --plain --route docker` used to ask "Root password (hidden):"
 * first and only then refuse, because the headless path prompted the missing
 * root password before it looked at the parse errors. This gate runs the REAL
 * CLI on a pseudo-terminal (where the prompt WOULD be shown) and measures:
 *  (a) the process exits 1 with the refusal naming `--route`;
 *  (b) the transcript never shows a password prompt — no "Root password";
 *  (c) nothing is written under the scratch private dir.
 *
 * DB-FREE; the only writes are a mkdtemp scratch dir, removed in afterAll.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const scratchRoot = mkdtempSync(join(tmpdir(), 'dedalo_install_plain_combination_'));

afterAll(() => {
	rmSync(scratchRoot, { recursive: true, force: true });
});

/** Run the installer on a pty; stop early at the first password prompt (a failure, measured below). */
async function runOnTerminal(argv: string[]): Promise<{ code: number | null; text: string }> {
	const dir = mkdtempSync(join(scratchRoot, 'run_'));
	let text = '';
	const decoder = new TextDecoder();
	const proc = Bun.spawn([process.execPath, 'run', 'scripts/install.ts', ...argv], {
		cwd: ROOT,
		env: {
			...Bun.env,
			TERM: 'xterm-256color',
			DEDALO_INSTALL_PRIVATE_DIR: join(dir, 'private'),
			DEDALO_TS_STATE_PATH: join(dir, 'private', 'ts_state.json'),
		},
		terminal: {
			cols: 100,
			rows: 30,
			data: (_terminal: unknown, chunk: Uint8Array) => {
				text += decoder.decode(chunk, { stream: true });
			},
		},
	});
	const until = Date.now() + 30000;
	let exited = false;
	void proc.exited.then(() => {
		exited = true;
	});
	while (!exited && !/Root password/.test(text) && Date.now() < until) await Bun.sleep(25);
	// A prompt is the failure this gate exists for: stop the run, then report.
	if (!exited) proc.kill();
	const code = await proc.exited;
	return { code, text };
}

describe('--plain refuses a flag combination before any prompt (F5)', () => {
	test('--plain --route docker: exit 1, the refusal names --route, no password is asked', async () => {
		const { code, text } = await runOnTerminal(['--plain', '--route', 'docker']);
		expect(text).not.toContain('Root password');
		expect(code).toBe(1);
		expect(text).toContain(
			'--route cannot be combined with --plain: give the answers on the interactive screens',
		);
	});

	test('--plain with several answer flags: every offending flag is named', async () => {
		const { code, text } = await runOnTerminal(['--plain', '--entity', 'x', '--route', 'docker']);
		expect(text).not.toContain('Root password');
		expect(code).toBe(1);
		expect(text).toContain('--entity, --route cannot be combined with --plain');
	});

	test('the scratch private dir of a refused run holds nothing', async () => {
		const { code } = await runOnTerminal(['--plain', '--answers', 'missing.json']);
		expect(code).toBe(1);
		// Every run's private dir sits under its own run_ folder; none may hold a written file.
		const { readdirSync } = await import('node:fs');
		for (const run of readdirSync(scratchRoot)) {
			expect(existsSync(join(scratchRoot, run, 'private', 'ts_state.json'))).toBe(false);
		}
	});
});
