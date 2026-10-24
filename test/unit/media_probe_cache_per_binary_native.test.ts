/**
 * CAPABILITY PROBES ARE KEYED BY THE BINARY THEY PROBED.
 *
 * `getAudioCodec` (engine/ffmpeg.ts) and `canWriteImageFormat`
 * (engine/imagemagick.ts) memoize a fact about ONE executable. Until 2026-10 the
 * ffmpeg answer was a process-wide scalar: `media_encode_integrity_native` points
 * config at a fake ffmpeg claiming libfdk-aac, and every later REAL two-pass
 * encode in the same `bun test` process asked the real ffmpeg for `libfdk_aac` —
 * pass 2 exit 8, "Unknown encoder". The magick memo was keyed by extension only,
 * the same defect one level down. These cases rebuild that situation (fake
 * binary, then another binary, in one process) and require each binary's OWN
 * answer.
 *
 * OWN FILE ON PURPOSE: `mock.module` is process-global in bun and `mock.restore()`
 * does not revert it. The config module is mocked ONCE, with a `binaries` object
 * whose ffmpeg/magick are getters over two local variables — a case repoints the
 * binary by assigning a variable, never by re-mocking — and the real module is
 * re-installed from an import-time snapshot in `afterAll` (the
 * media_encode_integrity_native GATE-01 lesson).
 *
 * The real-binary cases need the real ffmpeg and ImageMagick the CI image ships;
 * without them they go RED, not skip — the leak they reproduce lives in real
 * encodes.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as REAL_CONFIG_MODULE from '../../src/config/config.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const ROOT = scratchDir('probe_cache');
const BIN = join(ROOT, 'bin');

const REAL_CONFIG = REAL_CONFIG_MODULE.config;
/** Plain import-time snapshot: the live namespace reads back the MOCK later. */
const REAL_CONFIG_EXPORTS = { ...REAL_CONFIG_MODULE, config: REAL_CONFIG };
const REAL_FFMPEG = REAL_CONFIG.media.binaries.ffmpeg;
const REAL_MAGICK = REAL_CONFIG.media.binaries.magick;

/** What the mocked config answers for `media.binaries.ffmpeg` / `.magick`. */
let currentFfmpeg = REAL_FFMPEG;
let currentMagick = REAL_MAGICK;

function writeScript(name: string, body: string): string {
	mkdirSync(BIN, { recursive: true });
	const path = join(BIN, name);
	writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	chmodSync(path, 0o755);
	return path;
}

/**
 * A fake ffmpeg that answers the capability probes only. Every invocation is
 * appended to `<name>.log`, so a case can count probes. `-encoders` prints the
 * given audio encoder names in ffmpeg's `<6 flags> <name> <description>` form,
 * preceded by the real legend lines (whose name token is `=`).
 */
function fakeFfmpeg(
	name: string,
	encoders: readonly string[],
	options: { buildconf?: string; exitCode?: number } = {},
): string {
	const log = join(BIN, `${name}.log`);
	const lines = encoders.map((encoder) => `echo " A..... ${encoder}   fake ${encoder}"`).join('\n');
	return writeScript(
		name,
		`printf '%s\\n' "$*" >> "${log}"
${options.exitCode === undefined ? '' : `exit ${String(options.exitCode)}`}
case " $* " in
  *" -encoders"*)
    echo "Encoders:"
    echo " V..... = Video"
    echo " A..... = Audio"
    echo " ------"
    ${lines === '' ? ':' : lines}
    exit 0
    ;;
  *" -buildconf"*)
    echo "configuration: ${options.buildconf ?? ''}"
    exit 0
    ;;
esac
echo "fake ffmpeg: not a probe" >&2
exit 1`,
	);
}

function probeCount(name: string): number {
	const log = join(BIN, `${name}.log`);
	return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0;
}

beforeAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
	mkdirSync(BIN, { recursive: true });
	const binaries = Object.defineProperties(
		{ ...REAL_CONFIG.media.binaries },
		{
			ffmpeg: { get: () => currentFfmpeg, enumerable: true },
			magick: { get: () => currentMagick, enumerable: true },
		},
	);
	mock.module('../../src/config/config.ts', () => ({
		...REAL_CONFIG_EXPORTS,
		config: { ...REAL_CONFIG, media: { ...REAL_CONFIG.media, binaries } },
	}));
});

afterAll(() => {
	mock.module('../../src/config/config.ts', () => REAL_CONFIG_EXPORTS);
	mock.restore();
	rmSync(ROOT, { recursive: true, force: true });
});

const ffmpegEngine = () => import('../../src/core/media/engine/ffmpeg.ts');
const magickEngine = () => import('../../src/core/media/engine/imagemagick.ts');

describe('getAudioCodec: the answer belongs to the ffmpeg that gave it', () => {
	test('a fake binary claiming libfdk_aac does not answer for the next binary', async () => {
		const { getAudioCodec } = await ffmpegEngine();
		currentFfmpeg = fakeFfmpeg('ffmpeg_fdk', ['libfdk_aac', 'aac']);
		expect(await getAudioCodec()).toBe('libfdk_aac');
		currentFfmpeg = fakeFfmpeg('ffmpeg_plain', ['aac', 'opus']);
		expect(await getAudioCodec()).toBe('aac');
		// And each binary's answer IS memoized: back to the first, no re-probe.
		currentFfmpeg = join(BIN, 'ffmpeg_fdk');
		expect(await getAudioCodec()).toBe('libfdk_aac');
		expect(probeCount('ffmpeg_fdk')).toBe(1);
		expect(probeCount('ffmpeg_plain')).toBe(1);
	});

	test('the pick comes from the encoder REGISTRY, not the configure flags', async () => {
		// `--enable-libfdk-aac --disable-encoder=libfdk_aac`: the flag is in
		// -buildconf, the encoder is not in -encoders, and `-acodec libfdk_aac`
		// would fail. The registry is what -acodec resolves against.
		const { getAudioCodec } = await ffmpegEngine();
		currentFfmpeg = fakeFfmpeg('ffmpeg_flag_only', ['aac'], {
			buildconf: '--enable-libfdk-aac --disable-encoder=libfdk_aac',
		});
		expect(await getAudioCodec()).toBe('aac');
	});

	test('an inconclusive probe answers the fallback and is NOT memoized', async () => {
		const { getAudioCodec } = await ffmpegEngine();
		currentFfmpeg = fakeFfmpeg('ffmpeg_flaky', [], { exitCode: 1 });
		expect(await getAudioCodec()).toBe('aac');
		// Same PATH, now healthy: the transient failure must not have pinned it.
		fakeFfmpeg('ffmpeg_flaky', ['libfdk_aac', 'aac']);
		expect(await getAudioCodec()).toBe('libfdk_aac');
	});

	test('N concurrent first calls share ONE probe spawn', async () => {
		const { getAudioCodec } = await ffmpegEngine();
		currentFfmpeg = fakeFfmpeg('ffmpeg_concurrent', ['aac']);
		const answers = await Promise.all(Array.from({ length: 5 }, () => getAudioCodec()));
		expect(answers).toEqual(['aac', 'aac', 'aac', 'aac', 'aac']);
		expect(probeCount('ffmpeg_concurrent')).toBe(1);
	});

	test('fake libfdk_aac binary, then the REAL ffmpeg: a real two-pass encode succeeds', async () => {
		expect(existsSync(REAL_FFMPEG)).toBe(true);
		const { getAudioCodec, transcodeTwoPass } = await ffmpegEngine();
		currentFfmpeg = fakeFfmpeg('ffmpeg_fdk_prime', ['libfdk_aac']);
		expect(await getAudioCodec()).toBe('libfdk_aac');

		currentFfmpeg = REAL_FFMPEG;
		const realEncoders = Bun.spawnSync([
			REAL_FFMPEG,
			'-hide_banner',
			'-encoders',
		]).stdout.toString();
		const codec = await getAudioCodec();
		expect(realEncoders).toMatch(new RegExp(`^\\s*A[A-Z.]{5}\\s+${codec}\\s`, 'm'));

		const source = join(ROOT, 'src.mp4');
		const made = Bun.spawnSync([
			REAL_FFMPEG,
			'-loglevel',
			'error',
			'-f',
			'lavfi',
			'-i',
			'testsrc=duration=1:size=320x180:rate=25',
			'-f',
			'lavfi',
			'-i',
			'sine=duration=1',
			'-shortest',
			'-y',
			source,
		]);
		expect(made.exitCode).toBe(0);
		const target = join(ROOT, 'out.mp4.tmp');
		await transcodeTwoPass('240_pal_16x9', source, target);
		expect(existsSync(target)).toBe(true);
	}, 60_000);
});

describe('canWriteImageFormat: the answer belongs to the magick that gave it', () => {
	test('the REAL magick can write png; a broken magick asked next cannot', async () => {
		const { canWriteImageFormat } = await magickEngine();
		currentMagick = REAL_MAGICK;
		expect(await canWriteImageFormat('png')).toBe(true);
		// Keyed by extension alone, this answered the real binary's cached `true`.
		currentMagick = writeScript('magick', 'echo "fake magick: no delegates" >&2\nexit 1');
		expect(await canWriteImageFormat('png')).toBe(false);
	}, 30_000);
});
