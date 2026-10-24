/**
 * ENCODE INTEGRITY — a derivative that was not produced CORRECTLY must never
 * reach the archive (audit 2026-08 B2 + the qt-faststart parity gate).
 *
 * Two measured defects this file pins:
 *
 *  1. **A timed-out ffmpeg pass was treated as SUCCESS.** `runBinary` kills the
 *     child at the cap and every ffmpeg runner asked `exitCode !== 0 && !timedOut`
 *     — i.e. the timeout was the EXCUSE that skipped the throw. The partial,
 *     moov-less, unplayable temp was then renamed over the destination and
 *     indexed `file_exist:true` while the job reported 'done'. That is silent
 *     corruption of a master derivative in a heritage archive: the previous good
 *     file is gone and nothing anywhere says so.
 *
 *  1b. **…and the fix for it must not become a different blocker.** Making the
 *     kill a hard failure while the cap stayed a 10-minute WALL-CLOCK budget
 *     would convert B2's silent corruption into a GUARANTEED failure for exactly
 *     the content it was measured on: this archive's masters are hour-long oral
 *     history interviews, and a two-pass x264 encode of one legitimately outruns
 *     any constant (PHP capped nothing — class.Ffmpeg.php:786-793 ran a detached
 *     `.sh`). So a producer is governed by an INACTIVITY cap and every ffmpeg run
 *     carries `-progress pipe:1`: the cap measures silence, not work. The cases
 *     below drive both halves — a chatty process outliving its cap several times
 *     over is NOT killed, a silent one is.
 *
 *  2. **No qt-faststart.** PHP ran it unconditionally after pass 2
 *     (class.Ffmpeg.php:782); TS renamed the two-pass temp straight into place,
 *     leaving the moov atom at the END of every generated web version, so it
 *     cannot progressively stream. `engineering/MEDIA_SPEC.md` names it a parity
 *     gate (§4.2, §7.C, §9) and no wire-contract entry excuses the omission.
 *
 * HOW THE FAILURE IS DRIVEN: through the SPAWN SEAM, never a real 10-minute
 * encode. `config.media.binaries.ffmpeg` / `.qtFaststart` are mocked to tiny sh
 * scripts that reproduce each outcome (hang → SIGKILL, non-zero exit, exit 0 with
 * an empty output, a cooperating encoder). The real binaries are never needed, so
 * this gate is green on a host with no ffmpeg at all.
 *
 * OWN FILE ON PURPOSE: `mock.module` is process-global in bun and `mock.restore()`
 * does NOT revert it — the real config module is re-installed in `afterAll`, and
 * this suite is kept away from the other media gates.
 */
// NO INSTALL TLD IS BOUND HERE (checked 2026-08-19). The census entry for this
// file is a FALSE POSITIVE: the only token it matches is `libx264`, the ffmpeg
// H.264 ENCODER name, which is `<letters><digits>`-shaped and so indistinguishable
// from a tipo to scripts/lib/tld_census.ts. `libx` is not an ontology TLD and
// should leave INSTALL_TLDS; until it does, the entry stays frozen.

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import * as REAL_CONFIG_MODULE from '../../src/config/config.ts';
import { mediaTypeOf } from '../../src/core/concepts/media.ts';
import type { MediaIdentity, MediaPathOptions } from '../../src/core/media/path.ts';
import { mustGet } from '../helpers/assert.ts';
import { markMediaRoot, markProcessesDir } from '../helpers/media_scratch_root.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const ROOT = scratchDir('encode_integrity');
const BIN = join(ROOT, 'bin');
const FASTSTART_LOG = join(BIN, 'faststart.log');
// The job-manager seam: without it the failing job below writes its pfile into
// the LIVE ../private/processes tree.
// Restored in afterAll: this dir is deleted there, and a key left pointing at
// it would aim the NEXT file's jobs at an unmarked directory (refused).
const previousProcessesDir = process.env.DEDALO_MEDIA_PROCESSES_DIR;
process.env.DEDALO_MEDIA_PROCESSES_DIR = markProcessesDir(join(ROOT, 'processes'));

const REAL_CONFIG = REAL_CONFIG_MODULE.config;
/**
 * A PLAIN SNAPSHOT of the real module's exports, taken at IMPORT time — before
 * `useFakeBinaries()` runs in `beforeAll`.
 *
 * `REAL_CONFIG_MODULE` is a LIVE module namespace: once `mock.module` has
 * replaced `src/config/config.ts`, that binding reads back the MOCK. Restoring
 * from it in `afterAll` therefore re-installed the fake binaries process-wide
 * instead of removing them, and every media file that ran afterwards found
 * `config.media.binaries.ffmpeg` pointing into this file's deleted scratch dir
 * and SKIPPED its cases — silently, because a skip is not a failure.
 * MEASURED before the fix: the media suite went from 7 skips to 24 when this
 * file ran first (audit 2026-08-26, GATE-01, S1).
 */
const REAL_CONFIG_EXPORTS = { ...REAL_CONFIG_MODULE, config: REAL_CONFIG };
const av = mustGet(mediaTypeOf('component_av'), 'component_av spec');
const pathOpts: MediaPathOptions = { initialMediaPath: '', maxItemsFolder: 1000, mediaRoot: ROOT };

/** The scratch identity every case encodes for (no DB row is ever created). */
const identity: MediaIdentity = {
	componentTipo: 'test94',
	sectionTipo: 'test3',
	sectionId: 999_999_001,
	lang: null,
};

/** A source profile that selects a real ladder profile ('240_pal_16x9'). */
const sourceProfile = {
	standard: 'pal' as const,
	aspect: '16x9' as const,
	hasAudio: true,
	hasVideo: true,
	// No duration: these gates drive the FAILURE paths with fake binaries, so no
	// percentage is computable and none should be invented.
	durationSeconds: null,
};

// ── the fake binaries ───────────────────────────────────────────────────────

/**
 * Write an executable sh script.
 *
 * ONE fake ffmpeg and ONE fake qt-faststart, both at a FIXED path, because the
 * config module is mocked exactly once: the behaviour of a case is chosen by an
 * environment variable (`runBinary` passes the parent env through to the child)
 * and, for "the binary is not installed", by deleting the script file. Re-mocking
 * config per case would rely on `mock.module` live-updating an already-bound
 * import in every media module — this way nothing depends on that.
 */
function writeScript(name: string, body: string): string {
	mkdirSync(BIN, { recursive: true });
	const path = join(BIN, name);
	writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	chmodSync(path, 0o755);
	return path;
}

/**
 * Pay macOS's FIRST-EXEC cost before a timed spawn. A freshly written
 * executable is scanned by the OS on its first exec — measured on a dev Mac at
 * ~520 ms for a 100-byte /bin/sh script, ~10 ms once warm — and the inactivity
 * cap is armed at spawn, so an UNWARMED script under a 400 ms cap measures
 * Gatekeeper and not the engine's silence policy (that is a test artefact, not
 * a product one: the shipped producer cap is PRODUCER_IDLE_TIMEOUT_MS, ten
 * minutes). Warming keeps the cap tight enough for the assertion to mean what
 * it says.
 */
async function warmExec(bin: string): Promise<void> {
	const child = Bun.spawn([bin], { stdout: 'pipe', stderr: 'ignore' });
	// Wait for the FIRST BYTE, not a fixed delay: the cost being paid is the
	// OS's exec-time scan, and a timed kill can land in the middle of it and
	// leave the next exec to pay it again. First output proves the scan is done
	// and the interpreter is running.
	const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
	await reader.read();
	await reader.cancel();
	child.kill(9);
	await child.exited;
}

const FAKE_FFMPEG = join(BIN, 'ffmpeg');
const FAKE_FASTSTART = join(BIN, 'qt-faststart');

/**
 * The fake encoder. Resolves the OUTPUT as the last argv token (true of ffmpeg
 * pass 1 → /dev/null, pass 2 → temp, and the movflags remux) and the INPUT as
 * the token after `-i`. `FAKE_FFMPEG_MODE` selects the outcome.
 */
function installFakeFfmpeg(): void {
	writeScript(
		'ffmpeg',
		`
# 'real' delegates EVERYTHING (encode and movflags remux) to the genuine binary.
if [ "$FAKE_FFMPEG_MODE" = "real" ]; then exec "${REAL_FFMPEG}" "$@"; fi
out=""
prev=""
input=""
for a in "$@"; do
  if [ "$prev" = "-i" ]; then input="$a"; fi
  prev="$a"
  out="$a"
done
case " $* " in
  # getAudioCodec's capability probe. It must NOT fall through to the writer
  # below: the last argv token is the FLAG, so the fake would create a file
  # literally named '-encoders' in the repo root — and runBinary's
  # argument-as-flag guard then refuses every later spawn whose argv holds it.
  *" -encoders"*)
    echo " A..... libfdk_aac           Fraunhofer FDK AAC (codec aac)"
    exit 0
    ;;
  *" -movflags "*)
    if [ -n "$FAKE_MOVFLAGS_FAILS" ]; then echo "fake ffmpeg: movflags refused" >&2; exit 1; fi
    cat "$input" > "$out" 2>/dev/null || : > "$out"
    printf 'MOVFLAGS' >> "$out"
    exit 0
    ;;
esac
case "$FAKE_FFMPEG_MODE" in
  hang)     printf 'PARTIAL' > "$out"; exec sleep 60 ;;
  fail)     printf 'PARTIAL' > "$out"; echo "fake ffmpeg: encode failed" >&2; exit 1 ;;
  selfkill) printf 'PARTIAL' > "$out"; kill -9 $$ ;;
  empty)    : > "$out"; exit 0 ;;
  # A LONG BUT LIVE encode: it talks the whole time (as ffmpeg does under
  # -progress) and takes far longer than the inactivity window it runs under.
  # This is the hour-long interview, in miniature.
  chatty)
    i=0
    while [ $i -lt 15 ]; do
      printf 'frame=%s\\nprogress=continue\\n' "$i"
      i=$((i + 1))
      sleep 0.1
    done
    printf 'ENCODED' > "$out"
    exit 0 ;;
  *)        printf 'ENCODED' > "$out"; exit 0 ;;
esac`,
	);
}

/** The fake moov relocator: logs its (src,dst) pair, appends a FASTSTART marker. */
function installFakeFaststart(): void {
	writeScript(
		'qt-faststart',
		`printf '%s|%s\\n' "$1" "$2" >> "${FASTSTART_LOG}"
cat "$1" > "$2" || exit 1
printf 'FASTSTART' >> "$2"
exit 0`,
	);
}

/** Choose the encoder's behaviour for the next spawn. */
function ffmpegMode(mode: 'ok' | 'hang' | 'fail' | 'selfkill' | 'empty' | 'chatty' | 'real'): void {
	process.env.FAKE_FFMPEG_MODE = mode;
}

/** The genuine encoder, for the one case that must exercise a real container. */
const REAL_FFMPEG = REAL_CONFIG.media.binaries.ffmpeg;
const HAVE_FFMPEG = existsSync(REAL_FFMPEG);
if (!HAVE_FFMPEG) {
	console.warn('[media_encode_integrity] no ffmpeg — the real-container case is SKIPPED');
}
process.env.REAL_FFMPEG = REAL_FFMPEG;

/** Byte offsets of the two atoms that decide progressive playback. */
function atomOrder(file: string): { moov: number; mdat: number } {
	const bytes = readFileSync(file).toString('latin1');
	return { moov: bytes.indexOf('moov'), mdat: bytes.indexOf('mdat') };
}

/** Install a config whose media binaries are the fakes above. */
function useFakeBinaries(): void {
	mock.module('../../src/config/config.ts', () => ({
		...REAL_CONFIG_MODULE,
		config: {
			...REAL_CONFIG,
			media: {
				...REAL_CONFIG.media,
				binaries: {
					...REAL_CONFIG.media.binaries,
					ffmpeg: FAKE_FFMPEG,
					qtFaststart: FAKE_FASTSTART,
				},
			},
		},
	}));
}

/** Absolute path of a quality tier under the scratch root. */
async function qualityPath(quality: string): Promise<string> {
	const { buildMediaLocation } = await import('../../src/core/media/path.ts');
	return buildMediaLocation(av, identity, quality, av.defaultExtension, pathOpts).absolutePath;
}

/** Seed an existing derivative the encode must not be allowed to destroy. */
async function seedExistingDerivative(quality: string, bytes: string): Promise<string> {
	const target = await qualityPath(quality);
	mkdirSync(target.slice(0, target.lastIndexOf('/')), { recursive: true });
	writeFileSync(target, bytes);
	return target;
}

/** Every stray file left beside a tier (temps, passlogs) — must be empty. */
function leftoversBeside(target: string): string[] {
	const dir = target.slice(0, target.lastIndexOf('/'));
	const base = target.slice(target.lastIndexOf('/') + 1);
	return readdirSync(dir).filter((entry) => entry !== base);
}

beforeAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
	// DECLARE the scratch root (the media doors refuse an unmarked one under the
	// test-media seam — src/core/media/test_media_root.ts).
	markMediaRoot(ROOT);
	markProcessesDir(join(ROOT, 'processes')); // the job-registry scratch dir (same rmSync, same law)
	mkdirSync(BIN, { recursive: true });
	installFakeFfmpeg();
	installFakeFaststart();
	useFakeBinaries();
});
afterEach(() => {
	rmSync(FASTSTART_LOG, { force: true });
	delete process.env.FAKE_FFMPEG_MODE;
	delete process.env.FAKE_MOVFLAGS_FAILS;
	installFakeFaststart(); // a case may have removed it ("not installed")
});
afterAll(() => {
	if (previousProcessesDir === undefined)
		Reflect.deleteProperty(process.env, 'DEDALO_MEDIA_PROCESSES_DIR');
	else process.env.DEDALO_MEDIA_PROCESSES_DIR = previousProcessesDir;
	// Put the REAL config module back: mock.module leaks across files. Restore
	// from the import-time SNAPSHOT, never from the live namespace — see
	// REAL_CONFIG_EXPORTS.
	mock.module('../../src/config/config.ts', () => REAL_CONFIG_EXPORTS);
	rmSync(ROOT, { recursive: true, force: true });
});

// ── 1. the spawn wrapper never calls a killed process a success ─────────────

describe('spawn integrity', () => {
	test('a process killed by the timeout is never reported ok', async () => {
		const { runBinary } = await import('../../src/core/media/engine/spawn.ts');
		const result = await runBinary(['/bin/sleep', '30'], { nice: false, timeoutMs: 200 });
		expect(result.ok).toBe(false);
		expect(result.timedOut).toBe(true);
		expect(result.signal).toBe('SIGKILL');
		// The documented contract: null exit code when a signal killed the child
		// (bun's `await child.exited` resolves 128+n, which reads as "exit 137").
		expect(result.exitCode).toBeNull();
	});

	test('a non-zero exit is never reported ok', async () => {
		const { runBinary } = await import('../../src/core/media/engine/spawn.ts');
		const bin = writeScript('exit3', 'exit 3');
		const result = await runBinary([bin], { nice: false });
		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(3);
		expect(result.signal).toBeNull();
		expect(result.timedOut).toBe(false);
	});

	test('a process that kills itself is never reported ok', async () => {
		const { runBinary } = await import('../../src/core/media/engine/spawn.ts');
		const bin = writeScript('selfkill', 'kill -9 $$');
		const result = await runBinary([bin], { nice: false });
		expect(result.ok).toBe(false);
		expect(result.signal).toBe('SIGKILL');
		expect(result.timedOut).toBe(false); // died by its own hand, not by the cap
	});

	test('a clean run is ok', async () => {
		const { runBinary } = await import('../../src/core/media/engine/spawn.ts');
		const bin = writeScript('hello', 'printf hello');
		const result = await runBinary([bin], { nice: false });
		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.signal).toBeNull();
		expect(result.stdout).toBe('hello');
	});

	test('a total budget kills a process that is still working', async () => {
		const { runBinary } = await import('../../src/core/media/engine/spawn.ts');
		const bin = writeScript(
			'chatter',
			'i=0; while [ $i -lt 40 ]; do printf "tick\\n"; i=$((i+1)); sleep 0.1; done',
		);
		const result = await runBinary([bin], { nice: false, timeoutMs: 300 });
		expect(result.ok).toBe(false);
		expect(result.timedOut).toBe(true);
		expect(result.timeoutKind).toBe('total');
	}, 20_000);

	test('an INACTIVITY cap does not kill a process that keeps talking', async () => {
		// THE POINT OF THE WHOLE POLICY. This process runs ~1.5 s under a 400 ms cap
		// — a wall-clock budget would have killed it three times over. An hour-long
		// interview's transcode is this case, scaled up; if this test ever has to be
		// weakened, the encode path is capped on duration again and B2's remediation
		// has become B2's replacement.
		const { runBinary } = await import('../../src/core/media/engine/spawn.ts');
		const bin = writeScript(
			'talker',
			'i=0; while [ $i -lt 15 ]; do printf "tick\\n"; i=$((i+1)); sleep 0.1; done; printf done',
		);
		await warmExec(bin);
		const result = await runBinary([bin], { nice: false, idleTimeoutMs: 400 });
		expect(result.ok).toBe(true);
		expect(result.timedOut).toBe(false);
		expect(result.timeoutKind).toBeNull();
		expect(result.stdout).toContain('done');
	}, 20_000);

	test('an INACTIVITY cap kills a process that has gone silent', async () => {
		const { runBinary } = await import('../../src/core/media/engine/spawn.ts');
		const bin = writeScript('mute', 'printf hello; exec sleep 60');
		await warmExec(bin);
		const result = await runBinary([bin], { nice: false, idleTimeoutMs: 300 });
		expect(result.ok).toBe(false);
		expect(result.timedOut).toBe(true);
		expect(result.timeoutKind).toBe('idle');
		expect(result.signal).toBe('SIGKILL');
		// It SPOKE, then went silent: without this the case would also pass on a
		// process killed before it ever ran, which is the opposite of the rule.
		expect(result.stdout).toContain('hello');
	}, 20_000);

	test('the two caps are mutually exclusive — a spawn is governed by ONE policy', async () => {
		const { runBinary } = await import('../../src/core/media/engine/spawn.ts');
		await expect(
			runBinary(['/bin/echo', 'x'], { nice: false, timeoutMs: 100, idleTimeoutMs: 100 }),
		).rejects.toThrow(/mutually exclusive/i);
	});

	test('a producer defaults to the inactivity policy, never a wall-clock budget', async () => {
		const { PRODUCER_IDLE_TIMEOUT_MS, producerSpawnOptions } = await import(
			'../../src/core/media/engine/ffmpeg.ts'
		);
		// Nothing in src/ passes spawnOptions to an encode, so the DEFAULT is the
		// policy the archive actually runs under: it must carry no total budget.
		expect(producerSpawnOptions()).toEqual({ idleTimeoutMs: PRODUCER_IDLE_TIMEOUT_MS });
		expect(producerSpawnOptions().timeoutMs).toBeUndefined();
		// A caller that states its own policy replaces the default (it cannot ADD to
		// it — runBinary refuses both caps).
		expect(producerSpawnOptions({ timeoutMs: 5 })).toEqual({ timeoutMs: 5 });
		expect(producerSpawnOptions({ idleTimeoutMs: 5 })).toEqual({ idleTimeoutMs: 5 });
	});

	test('no media runner may AND-away a timeout to claim success', () => {
		// The B2 shape verbatim: `exitCode !== 0 && !result.timedOut`. A timeout is
		// the WORST outcome, never the excuse that skips the failure branch.
		const offenders: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (entry.name.endsWith('.ts')) {
					const src = readFileSync(full, 'utf8');
					if (/&&\s*!\s*[A-Za-z_$][\w$]*\.timedOut/.test(src)) offenders.push(full);
				}
			}
		};
		walk(join(import.meta.dir, '../../src/core/media'));
		expect(offenders).toEqual([]);
	});
});

// ── 2. the ffmpeg runners turn a bad pass into a hard failure ───────────────

describe('ffmpeg runners fail hard', () => {
	test('a timed-out transcode pass rejects', async () => {
		ffmpegMode('hang');
		const { transcodeTwoPass } = await import('../../src/core/media/engine/ffmpeg.ts');
		const temp = join(ROOT, 'pass.tmp');
		await expect(
			transcodeTwoPass('240_pal_16x9', join(ROOT, 'src.mp4'), temp, { timeoutMs: 300 }),
		).rejects.toThrow(/timed out|timeout/i);
	}, 20_000);

	test('a transcode that goes SILENT is killed by the inactivity cap', async () => {
		ffmpegMode('hang');
		const { transcodeTwoPass } = await import('../../src/core/media/engine/ffmpeg.ts');
		await expect(
			transcodeTwoPass('240_pal_16x9', join(ROOT, 'src.mp4'), join(ROOT, 'pass.tmp'), {
				idleTimeoutMs: 300,
			}),
		).rejects.toThrow(/no output for the whole inactivity window/i);
	}, 20_000);

	test('a LONG but live transcode is not killed — the cap measures silence, not work', async () => {
		// The B2-remediation regression: this encode takes ~1.5 s under a 300 ms cap.
		// Under the pre-remediation wall-clock cap it would fail; that is the
		// hour-long interview, and the whole reason the policy is an idle one.
		ffmpegMode('chatty');
		const { transcodeTwoPass } = await import('../../src/core/media/engine/ffmpeg.ts');
		const temp = join(ROOT, 'live.mp4');
		rmSync(temp, { force: true });
		await transcodeTwoPass('240_pal_16x9', join(ROOT, 'src.mp4'), temp, { idleTimeoutMs: 300 });
		expect(readFileSync(temp, 'utf8')).toBe('ENCODED');
		// The two-pass statistics scratch is the runner's own and is always removed.
		expect(existsSync(`${temp}.passlog-0.log`)).toBe(false);
		rmSync(temp, { force: true });
	}, 30_000);

	test('every ffmpeg producer carries the -progress liveness channel', async () => {
		// The idle policy is only sound because a working ffmpeg is never silent.
		// `-progress pipe:1` emits regardless of -loglevel, which is what makes pass
		// 1 (`-loglevel error`, otherwise mute for hours) observable at all.
		ffmpegMode('ok');
		const argvLog = join(BIN, 'argv.log');
		rmSync(argvLog, { force: true });
		writeScript(
			'ffmpeg',
			`case " $* " in *" -encoders"*) echo " A..... libfdk_aac  Fraunhofer FDK AAC"; exit 0 ;; esac
printf '%s\\n' "$*" >> "${argvLog}"
out=""
for a in "$@"; do out="$a"; done
printf 'ENCODED' > "$out"
exit 0`,
		);
		try {
			const { transcodeTwoPass } = await import('../../src/core/media/engine/ffmpeg.ts');
			const temp = join(ROOT, 'progress.mp4');
			await transcodeTwoPass('240_pal_16x9', join(ROOT, 'src.mp4'), temp, { idleTimeoutMs: 5000 });
			const lines = readFileSync(argvLog, 'utf8').trim().split('\n');
			expect(lines.length).toBeGreaterThanOrEqual(2); // both passes
			for (const line of lines) expect(line).toContain('-progress pipe:1');
			rmSync(temp, { force: true });
		} finally {
			installFakeFfmpeg();
			rmSync(argvLog, { force: true });
		}
	}, 20_000);

	test('a timed-out audio extraction rejects', async () => {
		ffmpegMode('hang');
		const { extractAudio } = await import('../../src/core/media/engine/ffmpeg.ts');
		await expect(
			extractAudio(join(ROOT, 'src.mp4'), join(ROOT, 'out.mp4'), 'audio', { timeoutMs: 300 }),
		).rejects.toThrow(/timed out|timeout/i);
	}, 20_000);

	test('a killed audio extraction leaves NOTHING at the served path', async () => {
		// tools/transcription.ts hands extractAudio the SERVED path and early-returns
		// on existsSync for the next call: a truncated WAV left there is cached
		// permanently and fed to the recogniser as the whole interview.
		ffmpegMode('hang');
		const { extractAudio } = await import('../../src/core/media/engine/ffmpeg.ts');
		const dir = join(ROOT, 'served');
		mkdirSync(dir, { recursive: true });
		const served = join(dir, 'interview.wav');
		await expect(
			extractAudio(join(ROOT, 'src.mp4'), served, 'audio_tr', { timeoutMs: 300 }),
		).rejects.toThrow();
		expect(existsSync(served)).toBe(false);
		expect(readdirSync(dir)).toEqual([]);
	}, 20_000);
});

// ── 3. the destination is never replaced by a bad encode ────────────────────

describe('a bad encode never reaches the archive', () => {
	test('a timed-out encode leaves the previous derivative byte-identical', async () => {
		ffmpegMode('hang');
		const { encodeAvQuality } = await import('../../src/core/media/av_versions.ts');
		const target = await seedExistingDerivative('240', 'THE GOOD DERIVATIVE');

		await expect(
			encodeAvQuality(av, identity, pathOpts, '240', join(ROOT, 'src.mp4'), sourceProfile, {
				timeoutMs: 300,
			}),
		).rejects.toThrow();

		expect(readFileSync(target, 'utf8')).toBe('THE GOOD DERIVATIVE');
		expect(leftoversBeside(target)).toEqual([]);
	}, 20_000);

	test('an encode that exits 0 with an empty output never replaces the derivative', async () => {
		ffmpegMode('empty');
		const { encodeAvQuality } = await import('../../src/core/media/av_versions.ts');
		const target = await seedExistingDerivative('240', 'THE GOOD DERIVATIVE');

		await expect(
			encodeAvQuality(av, identity, pathOpts, '240', join(ROOT, 'src.mp4'), sourceProfile),
		).rejects.toThrow(/empty|no output|produced/i);

		expect(readFileSync(target, 'utf8')).toBe('THE GOOD DERIVATIVE');
		expect(leftoversBeside(target)).toEqual([]);
	}, 20_000);

	test('a signal-killed encode job FAILS and leaves the previous derivative alone', async () => {
		ffmpegMode('selfkill');
		const { submitAvVersionBuild } = await import('../../src/core/media/av_versions.ts');
		const { mediaJobs } = await import('../../src/core/media/jobs.ts');
		// The build source (never read by the fake) + the tier it must not destroy.
		const original = await qualityPath(av.originalQuality);
		mkdirSync(original.slice(0, original.lastIndexOf('/')), { recursive: true });
		writeFileSync(original, 'THE ORIGINAL');
		const target = await seedExistingDerivative('240', 'THE GOOD DERIVATIVE');

		const jobId = await submitAvVersionBuild(av, identity, pathOpts, '240', 'mp4');
		for (let i = 0; i < 200; i++) {
			const status = mediaJobs.status(jobId)?.status;
			if (status !== 'queued' && status !== 'running') break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		const job = mediaJobs.status(jobId);
		expect(job?.status).toBe('error');
		expect(job?.errors.join(' ')).toMatch(/SIGKILL|signal|pass 2|pass 1/i);
		expect(readFileSync(target, 'utf8')).toBe('THE GOOD DERIVATIVE');
		expect(leftoversBeside(target)).toEqual([]);
	}, 30_000);
});

// ── 4. qt-faststart is part of AV derivative generation ────────────────────

describe('qt-faststart runs on every generated AV version', () => {
	test('the file that lands is the qt-faststart output, renamed atomically', async () => {
		ffmpegMode('ok');
		const { encodeAvQuality } = await import('../../src/core/media/av_versions.ts');
		const target = await qualityPath('240');
		rmSync(target, { force: true });

		const outcome = await encodeAvQuality(
			av,
			identity,
			pathOpts,
			'240',
			join(ROOT, 'src.mp4'),
			sourceProfile,
		);

		expect(outcome).toHaveProperty('built', target);
		expect(
			(outcome as { faststart: { applied: boolean; via: string | null; error: string | null } })
				.faststart,
		).toEqual({ applied: true, via: 'qt-faststart', error: null });
		// The moov relocation really produced the bytes on disk…
		expect(readFileSync(target, 'utf8')).toBe('ENCODEDFASTSTART');
		// …and it wrote to a SCRATCH file, never straight onto the served path
		// (a reader must never see a half-written derivative).
		const log = readFileSync(FASTSTART_LOG, 'utf8').trim().split('|');
		expect(log[1]).not.toBe(target);
		expect(leftoversBeside(target)).toEqual([]);
	}, 20_000);

	test('no qt-faststart binary ⇒ the ffmpeg movflags route, still moov-first', async () => {
		ffmpegMode('ok');
		rmSync(FAKE_FASTSTART, { force: true }); // the binary is not installed here
		const { encodeAvQuality } = await import('../../src/core/media/av_versions.ts');
		const target = await qualityPath('240');
		rmSync(target, { force: true });

		const outcome = await encodeAvQuality(
			av,
			identity,
			pathOpts,
			'240',
			join(ROOT, 'src.mp4'),
			sourceProfile,
		);

		expect(
			(outcome as { faststart: { applied: boolean; via: string | null } }).faststart.applied,
		).toBe(true);
		expect((outcome as { faststart: { via: string | null } }).faststart.via).toBe(
			'ffmpeg-movflags',
		);
		expect(readFileSync(target, 'utf8')).toBe('ENCODEDMOVFLAGS');
	}, 20_000);

	test('a real container with no qt-faststart is conformed moov-first anyway', async () => {
		if (!HAVE_FFMPEG) return;
		ffmpegMode('real');
		rmSync(FAKE_FASTSTART, { force: true });
		const { conformHeader } = await import('../../src/core/media/engine/ffmpeg.ts');
		const { runBinary } = await import('../../src/core/media/engine/spawn.ts');
		const dir = join(ROOT, 'conform');
		mkdirSync(dir, { recursive: true });
		const source = join(dir, 'clip.mp4');
		// A plain ffmpeg mp4: moov is written AFTER mdat, which is the very thing
		// conform_headers exists to fix.
		await runBinary(
			[
				REAL_FFMPEG,
				'-y',
				'-f',
				'lavfi',
				'-i',
				'testsrc=duration=1:size=160x90:rate=25',
				'-t',
				'1',
				'-c:v',
				'libx264',
				'-pix_fmt',
				'yuv420p',
				'-loglevel',
				'error',
				source,
			],
			{ nice: false },
		);
		const before = atomOrder(source);
		expect(before.moov).toBeGreaterThan(before.mdat);

		await conformHeader(source);

		const after = atomOrder(source);
		expect(after.moov).toBeLessThan(after.mdat);
		expect(existsSync(join(dir, 'clip_untouched.mp4'))).toBe(true);
		expect(existsSync(join(dir, 'clip_temp.mp4'))).toBe(false);
	}, 60_000);

	test('a failing conform_header never empties the source path', async () => {
		// PHP (and this port until 2026-08) moved the source to *_untouched BEFORE
		// the faststart, so a failing step left NOTHING where every record points.
		ffmpegMode('fail');
		const { conformHeader } = await import('../../src/core/media/engine/ffmpeg.ts');
		const dir = join(ROOT, 'conform_fail');
		mkdirSync(dir, { recursive: true });
		const source = join(dir, 'clip.mp4');
		writeFileSync(source, 'THE ONLY COPY');

		await expect(conformHeader(source)).rejects.toThrow();

		expect(readFileSync(source, 'utf8')).toBe('THE ONLY COPY');
		expect(readdirSync(dir)).toEqual(['clip.mp4']);
	}, 20_000);

	test('both faststart routes unavailable ⇒ the derivative still lands, LOUDLY degraded', async () => {
		ffmpegMode('ok');
		rmSync(FAKE_FASTSTART, { force: true });
		process.env.FAKE_MOVFLAGS_FAILS = '1';
		const errors: string[] = [];
		const realError = console.error;
		console.error = (...args: unknown[]) => {
			errors.push(args.map(String).join(' '));
		};
		try {
			const { encodeAvQuality } = await import('../../src/core/media/av_versions.ts');
			const target = await qualityPath('240');
			rmSync(target, { force: true });

			const outcome = await encodeAvQuality(
				av,
				identity,
				pathOpts,
				'240',
				join(ROOT, 'src.mp4'),
				sourceProfile,
			);

			const faststart = (
				outcome as { faststart: { applied: boolean; via: string | null; error: string | null } }
			).faststart;
			expect(faststart.applied).toBe(false);
			// Never a silent skip: the reason is surfaced on the outcome AND logged.
			expect(faststart.error).toMatch(/faststart/i);
			expect(errors.join(' ')).toMatch(/faststart/i);
			// Degraded, NOT lost: a moov-at-end file beats no file at all.
			expect(readFileSync(target, 'utf8')).toBe('ENCODED');
			expect(statSync(target).size).toBeGreaterThan(0);
		} finally {
			console.error = realError;
		}
	}, 20_000);
});
