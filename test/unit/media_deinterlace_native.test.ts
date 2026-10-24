/**
 * DEINTERLACE IS ACTUALLY APPLIED — measured on a real encode's OUTPUT.
 *
 * PHP's recipe (ported verbatim until 2026-10-02) passed the deinterlace filter
 * and the gamma filter as TWO `-vf` options. ffmpeg honours only the last `-vf`
 * of an output stream and says so ("Multiple -filter/-af/-vf options specified
 * for stream 0, only the last option … will be used") — so `yadif` was silently
 * dropped in both passes and every interlaced source reached the archive combed.
 * The argv shape is pinned in media_engine.test.ts; this file proves the outcome:
 *
 *  1. both passes of a real two-pass encode emit NO "Multiple -filter" warning;
 *  2. an interlaced source (lavfi, flagged TFF) comes out PROGRESSIVE by ffmpeg's
 *     own `idet` detector — the old recipe leaves it TFF on every frame;
 *  3. the deinterlace spec leaves a PROGRESSIVE source bit-identical
 *     (`deint=interlaced` touches only frames flagged interlaced), so fixing (2)
 *     does not soften the progressive majority of an archive.
 *
 * Profile `576_pal_4x3` because its output is 720x576 = the source size: a
 * rescale blends the two fields and would hide the combing from `idet`, making
 * (2) pass with or without the fix.
 *
 * Real ffmpeg (the CI image ships it); without it these cases go RED, not skip —
 * the defect lives in real encodes. Scratch files only under tmpdir; no media
 * root, no database.
 */
// NO INSTALL TLD IS BOUND HERE: `libx264` is the ffmpeg H.264 encoder name.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../src/config/config.ts';
import {
	buildTranscodePass1Argv,
	buildTranscodePass2Argv,
} from '../../src/core/media/engine/ffmpeg.ts';
import { getFfmpegProfile } from '../../src/core/media/engine/ffmpeg_profiles.ts';
import { runBinary } from '../../src/core/media/engine/spawn.ts';
import { mustGet } from '../helpers/assert.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const ROOT = scratchDir('deinterlace');
const FFMPEG = config.media.binaries.ffmpeg;
const PROFILE = mustGet(getFfmpegProfile('576_pal_4x3'), '576_pal_4x3 profile');
const MULTIPLE_FILTER = /Multiple -filter/i;

/** Run ffmpeg; fail loudly with its stderr on a non-zero exit. */
async function ffmpeg(argv: readonly string[]): Promise<string> {
	const result = await runBinary(argv, { nice: false });
	if (result.exitCode !== 0) {
		throw new Error(`ffmpeg exit ${result.exitCode}: ${argv.join(' ')}\n${result.stderr}`);
	}
	return result.stderr;
}

/**
 * The pass argv with its `-loglevel error` raised to `warning` — the ONLY
 * change: the dropped-filter notice is a warning, and the production level
 * hides it (which is how the defect stayed silent).
 */
function atWarning(argv: string[]): string[] {
	const at = argv.indexOf('-loglevel');
	expect(argv[at + 1]).toBe('error');
	return argv.map((token, i) => (i === at + 1 ? 'warning' : token));
}

/** ffmpeg's `idet` multi-frame verdict for a file: counts of TFF/BFF/progressive frames. */
async function detectFields(file: string): Promise<{ interlaced: number; progressive: number }> {
	const stderr = await ffmpeg([
		FFMPEG,
		'-hide_banner',
		'-i',
		file,
		'-vf',
		'idet',
		'-f',
		'null',
		'-',
	]);
	const line = stderr
		.split('\n')
		.filter((l) => l.includes('Multi frame detection'))
		.at(-1);
	const match = line?.match(/TFF:\s*(\d+)\s+BFF:\s*(\d+)\s+Progressive:\s*(\d+)/);
	if (!match) throw new Error(`idet printed no verdict for ${file}:\n${stderr}`);
	return {
		interlaced: Number(match[1]) + Number(match[2]),
		progressive: Number(match[3]),
	};
}

/** Per-frame md5s of a decode, optionally through a filter. */
async function frameDigests(file: string, filter: string | null): Promise<string[]> {
	const argv = [FFMPEG, '-loglevel', 'error', '-i', file];
	if (filter !== null) argv.push('-vf', filter);
	argv.push('-f', 'framemd5', '-');
	const result = await runBinary(argv, { nice: false });
	if (result.exitCode !== 0) throw new Error(`framemd5 failed: ${result.stderr}`);
	return result.stdout.split('\n').filter((l) => l !== '' && !l.startsWith('#'));
}

const INTERLACED_SOURCE = join(ROOT, 'interlaced.mp4');
const PROGRESSIVE_SOURCE = join(ROOT, 'progressive.mp4');

beforeAll(async () => {
	rmSync(ROOT, { recursive: true, force: true });
	mkdirSync(ROOT, { recursive: true });
	// 50 progressive frames/s woven into 25 interlaced frames/s, top field first,
	// encoded as interlaced (+ilme+ildct) so the frames carry the flag.
	await ffmpeg([
		FFMPEG,
		'-loglevel',
		'error',
		'-y',
		'-f',
		'lavfi',
		'-i',
		'testsrc2=duration=2:size=720x576:rate=50',
		'-vf',
		'tinterlace=interleave_top,setfield=tff',
		'-c:v',
		'libx264',
		'-flags',
		'+ilme+ildct',
		'-pix_fmt',
		'yuv420p',
		INTERLACED_SOURCE,
	]);
	await ffmpeg([
		FFMPEG,
		'-loglevel',
		'error',
		'-y',
		'-f',
		'lavfi',
		'-i',
		'testsrc2=duration=1:size=720x576:rate=25',
		'-c:v',
		'libx264',
		'-pix_fmt',
		'yuv420p',
		PROGRESSIVE_SOURCE,
	]);
});

afterAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

describe('two-pass encode deinterlaces (one chained -vf)', () => {
	test('the scratch source really is interlaced (control: idet sees combing)', async () => {
		const source = await detectFields(INTERLACED_SOURCE);
		expect(source.interlaced).toBeGreaterThanOrEqual(40);
		expect(source.progressive).toBe(0);
	});

	test('both passes: no "Multiple -filter" warning; the output is progressive', async () => {
		const passLog = join(ROOT, 'out.passlog');
		const output = join(ROOT, 'out.mp4');
		const pass1 = await ffmpeg(
			atWarning(buildTranscodePass1Argv(PROFILE, INTERLACED_SOURCE, passLog)),
		);
		expect(pass1).not.toMatch(MULTIPLE_FILTER);
		const pass2 = await ffmpeg(
			atWarning(buildTranscodePass2Argv(PROFILE, INTERLACED_SOURCE, passLog, output, 'aac')),
		);
		expect(pass2).not.toMatch(MULTIPLE_FILTER);

		// Measured 2026-10-02 (ffmpeg 8.1): fixed recipe → 46 progressive / 4 TFF;
		// the two-`-vf` recipe → 0 progressive / 50 TFF.
		const out = await detectFields(output);
		expect(out.progressive).toBeGreaterThan(out.interlaced * 4);
	});

	test('the deinterlace spec leaves a progressive source bit-identical', async () => {
		const deinterlace = mustGet(PROFILE.videoFilters[0], 'deinterlace filter');
		expect(deinterlace).toStartWith('yadif');
		const plain = await frameDigests(PROGRESSIVE_SOURCE, null);
		expect(plain.length).toBe(25);
		expect(await frameDigests(PROGRESSIVE_SOURCE, deinterlace)).toEqual(plain);
	});
});
