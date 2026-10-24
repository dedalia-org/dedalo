/**
 * MODEL FETCH — the decision half of src/core/ai/model_fetch.ts.
 *
 * Gates path confinement + URL policy (`resolveFetchTarget`), the curl transport
 * flags (`curlArgv`), cache freshness (`isUsableCachedFile`) and the
 * `downloadModel` orchestration through its injectable `fetchFile` seam.
 *
 * NEVER hits the network: every case here is pure, or uses a stub transport.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import {
	COMMON_FILES,
	curlArgv,
	DIARIZATION_COMMON_FILES,
	downloadModel,
	HUB_BASE,
	isUsableCachedFile,
	OPTIONAL_FILES,
	plainFetch,
	resolveFetchTarget,
} from '../../src/core/ai/model_fetch.ts';
import { expectedDigest, expectedSize } from '../../src/core/ai/model_manifest.ts';
import type { PinTable } from '../../src/core/ai/model_pins.ts';
import { scratchFile } from '../helpers/scratch_dir.ts';

let scratch = '';

/** A pinned revision for the fixture models (any 40-hex; the hub is never reached). */
const REVISION = 'a'.repeat(40);

const sha256 = (bytes: string): string => createHash('sha256').update(bytes).digest('hex');

/**
 * A pin table for one fixture model covering EVERY file the download may ask
 * for (P1-25: an unpinned model is refused before a byte, a required file with
 * no pin is refused too). The digest is that of `bytes` — the stubs below that
 * write a file write exactly that — so the orchestration's post-fetch verdict
 * stays green here, and its refusal is proved in
 * model_artifact_integrity_native.test.ts.
 */
function pinsFor(modelId: string, files: readonly string[], bytes = 'BYTES'): PinTable {
	const pin = { sha256: sha256(bytes), size: Buffer.byteLength(bytes) };
	return {
		models: {
			[modelId]: {
				revision: REVISION,
				pinned_at: '2026-09-04',
				reason: 'test fixture',
				files: Object.fromEntries(files.map((file) => [file, pin])),
			},
		},
		unpinned: {},
	};
}

/** Every file the default ASR plan can ask for, plus the quantised variants used below. */
const ASR_FILES = [
	...COMMON_FILES,
	'config.json',
	'onnx/encoder_model.onnx',
	'onnx/decoder_model_merged.onnx',
	'onnx/decoder_model_merged_quantized.onnx',
];
const DIARIZATION_FILES = [...DIARIZATION_COMMON_FILES, 'config.json', 'onnx/model.onnx'];

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), 'dd_model_fetch_'));
});

afterAll(() => {
	if (scratch !== '') rmSync(scratch, { recursive: true, force: true });
});

describe('resolveFetchTarget — refusals', () => {
	// Each refusal is asserted SEPARATELY: the charset guard is independently
	// gated, so a loosened regex cannot hide behind the later path-confinement
	// check (join() keeps '?', '#', '%2e%2e' and 'http://…' inside the store).
	const store = () => join(scratch, 'refusals');
	const at = { revision: REVISION };

	test('empty model id', () => {
		expect(resolveFetchTarget('', 'config.json', store(), at)).toBeNull();
	});

	test('space in model id', () => {
		expect(resolveFetchTarget('a b', 'config.json', store(), at)).toBeNull();
	});

	test('query string in model id', () => {
		expect(resolveFetchTarget('model?x=1', 'config.json', store(), at)).toBeNull();
	});

	test('fragment in model id', () => {
		expect(resolveFetchTarget('model#frag', 'config.json', store(), at)).toBeNull();
	});

	test('percent-encoded traversal in model id', () => {
		expect(resolveFetchTarget('model%2e%2e', 'config.json', store(), at)).toBeNull();
	});

	test('absolute URL as model id', () => {
		expect(resolveFetchTarget('http://evil.test/x', 'config.json', store(), at)).toBeNull();
	});

	test('literal .. segment in model id', () => {
		expect(resolveFetchTarget('a/../../etc', 'config.json', store(), at)).toBeNull();
	});

	test('the file segment is guarded by the same charset rule', () => {
		expect(resolveFetchTarget('org/model', '../escape.json', store(), at)).toBeNull();
		expect(resolveFetchTarget('org/model', 'a b.json', store(), at)).toBeNull();
		expect(resolveFetchTarget('org/model', '', store(), at)).toBeNull();
	});
});

describe('resolveFetchTarget — accepted', () => {
	test('a real catalog id resolves target + url at the IMMUTABLE revision, never a branch', () => {
		const store = join(scratch, 'ok');
		const got = resolveFetchTarget('onnx-community/whisper-tiny.en', 'config.json', store, {
			revision: REVISION,
		});
		expect(got).not.toBeNull();
		expect(got?.target).toBe(join(store, 'onnx-community/whisper-tiny.en', 'config.json'));
		expect(got?.url).toBe(
			`${HUB_BASE}/onnx-community/whisper-tiny.en/resolve/${REVISION}/config.json`,
		);
		expect(got?.url).not.toContain('/resolve/main/');
		expect(got?.url.startsWith('https://')).toBe(true);
	});

	test('a branch name is not a revision: `main` is refused (CARRY-06)', () => {
		const store = join(scratch, 'ok');
		expect(
			resolveFetchTarget('onnx-community/whisper-tiny.en', 'config.json', store, {
				revision: 'main',
			}),
		).toBeNull();
		expect(
			resolveFetchTarget('onnx-community/whisper-tiny.en', 'config.json', store, {
				revision: REVISION.slice(0, 39),
			}),
		).toBeNull();
	});

	test('a nested weights path stays under the store root', () => {
		const store = join(scratch, 'ok');
		const got = resolveFetchTarget(
			'onnx-community/whisper-tiny.en',
			'onnx/encoder_model.onnx',
			store,
			{ revision: REVISION },
		);
		expect(got?.target.startsWith(store + sep)).toBe(true);
	});
});

describe('curlArgv', () => {
	test('quiet mode keeps -fL, resume, retry and -sS', () => {
		const argv = curlArgv('/store/a/config.json', 'https://h/x', true);
		expect(argv[0]).toBe('curl');
		expect(argv).toContain('-fL');
		expect(argv.join(' ')).toContain('-C -');
		expect(argv.join(' ')).toContain('--retry 3');
		expect(argv).toContain('-sS');
		expect(argv).not.toContain('--progress-bar');
		// -o must immediately precede the target, and the url is last.
		expect(argv[argv.length - 3]).toBe('-o');
		expect(argv[argv.length - 2]).toBe('/store/a/config.json');
		expect(argv[argv.length - 1]).toBe('https://h/x');
	});

	test('non-quiet mode swaps -sS for the progress bar and nothing else', () => {
		const quiet = curlArgv('/t', 'https://h/x', true);
		const loud = curlArgv('/t', 'https://h/x', false);
		expect(loud).toContain('--progress-bar');
		expect(loud).not.toContain('-sS');
		expect(loud.length).toBe(quiet.length);
	});
});

describe('isUsableCachedFile', () => {
	test('missing file is not usable', () => {
		expect(isUsableCachedFile(join(scratch, 'nope', 'absent.json'))).toBe(false);
	});

	test('zero-byte file is not usable (curl leaves one behind on a 404)', () => {
		const dir = join(scratch, 'cache');
		mkdirSync(dir, { recursive: true });
		const empty = join(dir, 'empty.json');
		writeFileSync(empty, '');
		expect(isUsableCachedFile(empty)).toBe(false);
	});

	test('non-empty file is usable', () => {
		const dir = join(scratch, 'cache');
		mkdirSync(dir, { recursive: true });
		const full = join(dir, 'full.json');
		writeFileSync(full, '{}');
		expect(isUsableCachedFile(full)).toBe(true);
	});
});

describe('downloadModel — orchestration through the injected fetchFile', () => {
	/** A transport stub: succeeds for every file EXCEPT those named. */
	function stub(missing: readonly string[], seen: string[]) {
		return async (_modelId: string, file: string): Promise<boolean> => {
			seen.push(file);
			return !missing.includes(file);
		};
	}

	test('an optional-file miss is skipped, not an error', async () => {
		const seen: string[] = [];
		const report = await downloadModel('org/model', undefined, {
			store: join(scratch, 'dl1'),
			pins: pinsFor('org/model', ASR_FILES),
			fetchFile: stub(['generation_config.json'], seen),
		});
		expect(report.skipped).toEqual(['generation_config.json']);
		expect(report.errors).toEqual([]);
		expect(report.ok).toBe(true);
		expect(report.files).toContain('config.json');
		expect(report.files).toContain('onnx/encoder_model.onnx');
		expect(report.files).toContain('onnx/decoder_model_merged.onnx');
		// The default lists are the ASR ones.
		expect(seen).toContain('tokenizer.json');
		expect(OPTIONAL_FILES).toContain('generation_config.json');
	});

	test('a JSON-only result is a FAILED seed: no ONNX weights', async () => {
		const seen: string[] = [];
		const report = await downloadModel('org/model', undefined, {
			store: join(scratch, 'dl2'),
			pins: pinsFor('org/model', ASR_FILES),
			fetchFile: stub(['onnx/encoder_model.onnx', 'onnx/decoder_model_merged.onnx'], seen),
		});
		expect(report.ok).toBe(false);
		expect(report.errors.some((e) => /no ONNX weights/.test(e))).toBe(true);
		expect(report.files.every((f) => !f.endsWith('.onnx'))).toBe(true);
	});

	test('quantised weights follow the catalog dtype', async () => {
		const seen: string[] = [];
		const report = await downloadModel(
			'org/model',
			{ encoder_model: 'fp32', decoder_model_merged: 'q8' },
			{
				store: join(scratch, 'dl3'),
				pins: pinsFor('org/model', ASR_FILES),
				fetchFile: stub([], seen),
			},
		);
		expect(seen).toContain('onnx/decoder_model_merged_quantized.onnx');
		expect(report.ok).toBe(true);
	});

	test('the diarization set drops tokenizer.json and REQUIRES preprocessor_config.json', async () => {
		const seen: string[] = [];
		const report = await downloadModel('org/segmentation', undefined, {
			store: join(scratch, 'dl4'),
			pins: pinsFor('org/segmentation', DIARIZATION_FILES),
			commonFiles: DIARIZATION_COMMON_FILES,
			optionalFiles: [],
			fetchFile: stub(['preprocessor_config.json'], seen),
		});
		expect(seen).not.toContain('tokenizer.json');
		expect(seen).not.toContain('tokenizer_config.json');
		expect(seen).toContain('preprocessor_config.json');
		expect(report.skipped).toEqual([]);
		expect(report.ok).toBe(false);
		expect(report.errors.some((e) => /preprocessor_config\.json: download failed/.test(e))).toBe(
			true,
		);
		expect(COMMON_FILES).toContain('tokenizer.json');
	});

	test('onFile is called once per wanted file, in request order', async () => {
		const seen: string[] = [];
		const announced: string[] = [];
		await downloadModel('org/model', undefined, {
			store: join(scratch, 'dl5'),
			pins: pinsFor('org/model', ASR_FILES),
			onFile: (f) => announced.push(f),
			fetchFile: stub([], seen),
		});
		expect(announced).toEqual(seen);
	});

	test('the store root is created even when every file fails', async () => {
		const store = join(scratch, 'dl6');
		const seen: string[] = [];
		const report = await downloadModel('org/model', undefined, {
			store,
			pins: pinsFor('org/model', ASR_FILES),
			fetchFile: stub(
				[
					...COMMON_FILES,
					'config.json',
					'onnx/encoder_model.onnx',
					'onnx/decoder_model_merged.onnx',
				],
				seen,
			),
		});
		expect(existsSync(store)).toBe(true);
		expect(report.ok).toBe(false);
	});
});

describe('isUsableCachedFile — a truncated file is not a cache hit', () => {
	const store = () => join(scratch, 'truncation');

	test('no expected size: any non-empty file is accepted (legacy store)', () => {
		const target = join(store(), 'legacy.onnx');
		mkdirSync(store(), { recursive: true });
		writeFileSync(target, 'ONNX-BYTES');
		expect(isUsableCachedFile(target)).toBe(true);
		expect(isUsableCachedFile(target, null)).toBe(true);
	});

	test('the expected size matches: a cache hit', () => {
		const target = join(store(), 'complete.onnx');
		writeFileSync(target, 'ONNX-BYTES'); // 10 bytes
		expect(isUsableCachedFile(target, 10)).toBe(true);
	});

	test('the file is SHORTER than expected: NOT a cache hit — this is the bug', () => {
		const target = join(store(), 'partial.onnx');
		writeFileSync(target, 'ONNX'); // 4 of 10 bytes
		expect(isUsableCachedFile(target, 10)).toBe(false);
	});

	test('the file is longer than expected: not a cache hit either', () => {
		const target = join(store(), 'overlong.onnx');
		writeFileSync(target, 'ONNX-BYTES-AND-MORE');
		expect(isUsableCachedFile(target, 10)).toBe(false);
	});

	test('an absent file is never a cache hit', () => {
		expect(isUsableCachedFile(join(store(), 'nothing.onnx'), 10)).toBe(false);
	});
});

describe('downloadModel records completion in the manifest', () => {
	test('every fetched file lands in the manifest at its on-disk size', async () => {
		const store = join(scratch, 'manifest_seed');
		const model = 'onnx-community/whisper-tiny-TEST';
		const report = await downloadModel(
			model,
			{ encoder_model: 'fp32' },
			{
				store,
				pins: pinsFor(model, ASR_FILES),
				fetchFile: async (modelId, file, target) => {
					const path = join(target, modelId, file);
					mkdirSync(dirname(path), { recursive: true });
					writeFileSync(path, 'BYTES');
					return true;
				},
			},
		);
		expect(report.ok).toBe(true);
		expect(expectedSize(store, model, 'config.json')).toBe(5);
		// …and, since the bytes matched the pin, the DIGEST and REVISION too.
		expect(expectedDigest(store, model, 'config.json')).toBe(sha256('BYTES'));
		expect(
			JSON.parse(readFileSync(join(store, model, '.dedalo_model.json'), 'utf8')).files[
				'config.json'
			].revision,
		).toBe(REVISION);
	});
});

describe('the inline duplicates are GONE from the production file', () => {
	test('fetchOneFile no longer builds the url, the argv or the cache check itself', async () => {
		const source = await Bun.file(
			new URL('../../src/core/ai/model_fetch.ts', import.meta.url),
		).text();
		// URL policy: the template literal now lives only in resolveFetchTarget —
		// and it names the pinned REVISION; `/resolve/main/` appears only in the
		// prose that explains why it was retired.
		expect(source.split('/resolve/${source.revision}/').length - 1).toBe(1);
		expect(source.split('/resolve/main/').length - 1).toBe(1);
		// The argv array literal was replaced by the curlArgv call.
		expect(source).not.toContain('const argv = [');
		expect(source).not.toContain("'--progress-bar',\n\t\t\t'-o',");
		// The inline confinement + cache checks are gone.
		expect(source).not.toContain(
			'if (!isSafeModelSegment(modelId) || !isSafeModelSegment(file)) return false;',
		);
		expect(source).not.toContain(
			'if (existsSync(target) && statSync(target).size > 0) return true;',
		);
		// The orchestration goes through the seam.
		expect(source).toContain('options.fetchFile ?? fetchOneFile');
	});
});

/**
 * The repair path's contract with the downloader: fetch EXACTLY these files.
 * Without it a dtype-less repair deleted the q4 weights it found on disk and
 * downloaded the fp32 set — a working 400 MB install replaced by ~3 GB the
 * browser never asks for.
 */
describe('downloadModel — an explicit file list is the whole plan', () => {
	test('only the named files are fetched, and a weightless list is not a failure', async () => {
		const store = join(scratch, 'explicit_files');
		const asked: string[] = [];
		const report = await downloadModel('acme/model', undefined, {
			store,
			files: ['tokenizer.json'],
			pins: pinsFor('acme/model', ['tokenizer.json'], '{}'),
			fetchFile: async (_modelId, file, target) => {
				asked.push(file);
				mkdirSync(dirname(join(target, 'acme/model', file)), { recursive: true });
				writeFileSync(join(target, 'acme/model', file), '{}');
				return true;
			},
		});
		expect(asked).toEqual(['tokenizer.json']);
		// No .onnx was ASKED for, so "no ONNX weights were obtained" would be a
		// false failure on a repair that only had to replace a corrupt tokenizer.
		expect(report.errors).toEqual([]);
		expect(report.ok).toBe(true);
	});
});

/**
 * THE FALLBACK TRANSPORT, DRIVEN — not read (P1-26 / CARRY-14).
 *
 * The invariant is behavioural: a hub that accepts the connection and then goes
 * quiet must stop holding one of the engine's three background lanes, and must
 * leave nothing on disk that a later run would mistake for a complete download.
 *
 * It was first asserted by reading the source, and that was measured to be
 * theatre: replacing the reader loop with `const sink = target; await
 * Bun.write(sink, new Response(response.body))` — the EXACT defect, the one that
 * hung >8s after a 400ms abort on Bun 1.4.0 — left the gate green, because the
 * assertion pinned the spellings `target` and `response`. A gate measures the
 * outcome or it measures nothing.
 *
 * Hermetic: the peer is a loopback server this test starts and stops. The
 * COVERAGE-EXEMPT reasoning around model downloads is about the third-party HUB,
 * which a gate may never depend on — not about a socket on this machine.
 */
describe('the fallback transport is bounded by silence, not by hope', () => {
	const IDLE_MS = 400;

	/** A peer whose body behaviour the test chooses. */
	function peer(mode: 'stall_after_chunk' | 'stall_before_body' | 'complete' | 'missing') {
		return Bun.serve({
			port: 0,
			fetch() {
				if (mode === 'missing') return new Response('nope', { status: 404 });
				if (mode === 'complete') return new Response('WEIGHTS');
				return new Response(
					new ReadableStream({
						start(controller) {
							// one chunk, then silence forever — or no bytes at all
							if (mode === 'stall_after_chunk') controller.enqueue(new Uint8Array([1, 2, 3]));
						},
					}),
				);
			},
		});
	}

	async function download(mode: Parameters<typeof peer>[0]): Promise<{
		ok: boolean;
		ms: number;
		left: boolean;
	}> {
		const server = peer(mode);
		const target = scratchFile(`plainfetch_${mode}`, 'weights.bin');
		if (existsSync(target)) rmSync(target);
		const started = Date.now();
		try {
			const ok = await plainFetch(target, `http://localhost:${server.port}/w`, IDLE_MS);
			return { ok, ms: Date.now() - started, left: existsSync(target) };
		} finally {
			server.stop(true);
			if (existsSync(target)) rmSync(target);
		}
	}

	test('a peer that stalls MID-BODY is abandoned, and leaves no partial file', async () => {
		const result = await download('stall_after_chunk');
		expect(result.ok).toBe(false);
		// The lane is released on the idle bound, not held indefinitely. Generous
		// upper bound so a loaded CI box does not flake; the defect hung forever.
		expect(result.ms, `held the lane for ${result.ms}ms against a ${IDLE_MS}ms bound`).toBeLessThan(
			IDLE_MS * 10,
		);
		// An abandoned partial whose expected size was never learnt would sit there
		// looking complete, and the next run would accept it.
		expect(result.left, 'a partial download survived').toBe(false);
	});

	test('a peer that never sends a body byte is abandoned too', async () => {
		// Measured: Bun resolves `fetch` on the FIRST BODY BYTE, not on the headers,
		// so this stall lands on the `await fetch` itself — outside any reader loop.
		// It is the commonest shape of the very failure this bound exists for, and
		// it was the one branch that threw instead of returning false.
		const result = await download('stall_before_body');
		expect(result.ok).toBe(false);
		expect(result.ms).toBeLessThan(IDLE_MS * 10);
		expect(result.left).toBe(false);
	});

	test('an unreachable peer returns false rather than throwing', async () => {
		// FetchFile's contract is `false = not obtained`, never a throw: a refused
		// connection is the ordinary air-gapped case, and it must cost one file,
		// not the whole seed.
		const target = scratchFile('plainfetch_refused', 'weights.bin');
		// port 1 is reserved and nothing listens on it
		expect(await plainFetch(target, 'http://127.0.0.1:1/w', IDLE_MS)).toBe(false);
		expect(existsSync(target)).toBe(false);
	});

	test('a 404 returns false and writes nothing', async () => {
		const result = await download('missing');
		expect(result.ok).toBe(false);
		expect(result.left).toBe(false);
	});

	test('a healthy peer still downloads the bytes', async () => {
		// The converse: a bound that also breaks the working case is not a fix.
		const server = peer('complete');
		const target = scratchFile('plainfetch_ok', 'weights.bin');
		try {
			expect(await plainFetch(target, `http://localhost:${server.port}/w`, IDLE_MS)).toBe(true);
			expect(readFileSync(target, 'utf8')).toBe('WEIGHTS');
		} finally {
			server.stop(true);
			if (existsSync(target)) rmSync(target);
		}
	});
});

/**
 * THE FALLBACK MUST BE REACHABLE (P1-26). `haveCurl()` decides which transport
 * runs, and `Bun.spawnSync(['curl','--version'])` does NOT return
 * `{success:false}` for a missing binary — it THROWS
 * `Executable not found in $PATH: "curl"`. Unguarded, that escaped `transport`
 * → `fetchOneFile` → `downloadModel`, so on a curl-less host — the ONLY host
 * the fallback exists to serve — the whole model seed died before a byte. The
 * bounded fallback was correct and unreachable.
 *
 * A SUBPROCESS, because the probe is memoized for the life of the process: the
 * answer cannot be re-asked in-process, so the environment has to be chosen
 * before the module loads. No network: the URL is a closed port.
 */
describe('the transport door survives a host without curl', () => {
	test('a curl-less PATH falls back instead of throwing', async () => {
		const probe = `
			const { transport } = await import(${JSON.stringify(join(import.meta.dir, '..', '..', 'src/core/ai/model_fetch.ts'))});
			// THE DOOR ITSELF — transport() is where haveCurl() decides, and a closed
			// port answers instantly, so this needs no network and no clock.
			const ok = await transport('/dev/null', 'http://127.0.0.1:1/w', true);
			console.log(JSON.stringify({ ok }));
		`;
		// The interpreter is addressed absolutely, so PATH can be emptied of
		// everything — including curl — without also hiding bun from ourselves.
		const child = Bun.spawn([process.execPath, '-e', probe], {
			env: { PATH: '/nonexistent', HOME: process.env.HOME ?? '/tmp' },
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const [out, err, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(code, `the curl probe killed the process:\n${err}`).toBe(0);
		expect(err).not.toContain('Executable not found');
		expect(JSON.parse(out.trim())).toEqual({ ok: false });
	}, 30_000);
});
