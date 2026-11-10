/**
 * THE INIT DRILL NEVER CALLS AN UNMEASURED PROPERTY GREEN (closure review
 * cross-diffusion:r3, two S3 findings on scripts/publication_host_init_drill.ts).
 *
 * 1. THE EL systemd-analyze LEG. Each directive the rendered units carry is
 *    probed alone; a probe was "accepted" whenever its output lacked the refusal
 *    wording — so a probe that could not RUN (systemd-analyze missing, the
 *    scratch unwritable, a crash) counted as accepted, its exit status was thrown
 *    away by the trailing `rm`, and nothing proved the probe could refuse at all.
 *    Now the status rides a last `rc=N` line, a probe is accepted only at status
 *    0 without a refusal, anything else that is not a refusal is `unrun` (the leg
 *    fails), and the leg proves the probe first: a bogus directive must be
 *    refused, the bare scaffold must verify clean.
 * 2. --skip. Skipping a REQUIRED leg still printed "OK" and exited 0, and a
 *    --skip naming no leg (a typo) was silently ignored. Now a skipped required
 *    leg is INCOMPLETE (exit 3), and an unknown name is refused (exit 2) before
 *    anything runs.
 * 3. T0-6's REAL-HOST LEG (copy-media-web-user): the only gate where the agent's
 *    real unit (UMask=0027) and a web server running as another user meet. It
 *    runs in every world and is required — so the EL record cannot be green
 *    without it — and its mode verdict never calls an unstat-ed path right.
 *
 * HERMETIC: the probe script runs through `sh` on THIS host — where no
 * systemd-analyze exists (macOS, the CI image), which is exactly the "probe
 * could not run" case; the verdicts are pure; main() is driven only to its
 * argument refusal / --plan, which touch nothing.
 */

import { describe, expect, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import {
	BOGUS_DIRECTIVE,
	COPY_MEDIA_KEY,
	COPY_MEDIA_PATH,
	directiveProbeOutput,
	directiveProbeScript,
	directiveProbeUnit,
	directiveProbeVerdict,
	drillVerdict,
	legsFor,
	main,
	modeMismatches,
	parseDrillArgs,
	SCAFFOLD_DIRECTIVE,
	unknownSkips,
} from '../../scripts/publication_host_init_drill.ts';
import {
	getDefaultPublicQualities,
	MEDIA_FILENAME_GRAMMAR,
} from '../../src/core/media/protection.ts';
import { removeScratchDir, scratchFile } from '../helpers/scratch_dir.ts';

describe('the directive probe: accepted only when it ran clean', () => {
	test('a refusal is refused, whatever the status', () => {
		expect(
			directiveProbeVerdict(
				"/run/systemd/system/dd-floor-probe.service:4: Unknown key name 'DdNoSuchKey' in section 'Service', ignoring.\nrc=0\n",
			),
		).toBe('refused');
	});

	test('status 0 and no refusal is accepted; its output is what systemd printed', () => {
		expect(directiveProbeVerdict('rc=0\n')).toBe('accepted');
		expect(directiveProbeOutput('rc=0\n')).toBe('');
		expect(directiveProbeOutput('a warning\nrc=0\n')).toBe('a warning');
	});

	test('a probe that could not run is UNRUN, never accepted', () => {
		expect(directiveProbeVerdict('sh: systemd-analyze: command not found\nrc=127\n')).toBe('unrun');
		expect(directiveProbeVerdict('')).toBe('unrun'); // no status line at all
		expect(directiveProbeVerdict('Failed to open /run/x: Permission denied\nrc=1\n')).toBe('unrun');
		expect(directiveProbeVerdict('rc=1\n')).toBe('unrun');
	});

	test('measured: the real probe script, on a host without systemd-analyze, is unrun', () => {
		const scratch = scratchFile('probe_verdict', 'probe_verdict.service');
		const done = Bun.spawnSync(['sh', '-c', directiveProbeScript(scratch)], {
			stdout: 'pipe',
			stderr: 'pipe',
		});
		removeScratchDir(dirname(scratch));
		const out = done.stdout.toString();
		expect(out).toMatch(/^rc=\d+$/m); // the status survives the trailing rm
		if (Bun.which('systemd-analyze') === null) expect(directiveProbeVerdict(out)).toBe('unrun');
	});

	test('the controls: the bogus directive is in its own unit, the scaffold is the bare oneshot', () => {
		expect(directiveProbeUnit(BOGUS_DIRECTIVE)).toContain('\nDdNoSuchKey=1\n');
		expect(directiveProbeUnit(SCAFFOLD_DIRECTIVE)).toBe(
			'[Unit]\nDescription=dd floor probe\n[Service]\nExecStart=/bin/true\nType=oneshot\n',
		);
	});
});

describe('--skip never turns into OK', () => {
	const LEGS = [
		{ name: 'kit', required: true },
		{ name: 'network-media', required: false },
	];

	test('a skipped REQUIRED leg is INCOMPLETE (exit 3), a skipped optional one is OK', () => {
		expect(drillVerdict({ failed: [], skipped: ['kit'], legs: LEGS })).toEqual({
			code: 3,
			word: 'INCOMPLETE (required leg(s) skipped: kit)',
		});
		expect(drillVerdict({ failed: [], skipped: ['network-media'], legs: LEGS })).toEqual({
			code: 0,
			word: 'OK',
		});
		expect(drillVerdict({ failed: ['kit'], skipped: [], legs: LEGS }).code).toBe(1);
	});

	test('a --skip naming no leg of the run is found', () => {
		expect(unknownSkips(['kti', 'kit'], LEGS)).toEqual(['kti']);
		// every known name (required and optional) is dropped, every unknown one kept
		expect(unknownSkips(['network-media', 'kti', 'kit', 'nope'], LEGS)).toEqual(['kti', 'nope']);
	});

	test('main refuses an unknown --skip (exit 2) before it touches anything', async () => {
		const error = spyOn(console, 'error').mockImplementation(() => {});
		try {
			expect(await main(['--plan', '--skip', 'no-such-leg'])).toBe(2);
			expect(String(error.mock.calls[0]?.[0])).toContain('no-such-leg');
		} finally {
			error.mockRestore();
		}
	});

	test('control: a --skip naming a real leg passes the refusal (--plan touches nothing)', async () => {
		const log = spyOn(console, 'log').mockImplementation(() => {});
		try {
			const first = String(
				(await import('../../scripts/publication_host_init_drill.ts')).legsFor({
					family: 'debian',
					inPlace: false,
					record: false,
					capture: null,
					mediaNfs: null,
					skip: [],
					keep: false,
					plan: true,
				})[0]?.name,
			);
			expect(await main(['--plan', '--skip', first])).toBe(0);
		} finally {
			log.mockRestore();
		}
	});
});

describe('copy-media-web-user (T0-6 on a real host)', () => {
	const legs = (argv: string[]) => {
		const args = parseDrillArgs(argv);
		if ('error' in args) throw new Error(args.error);
		return legsFor(args);
	};

	test('runs in every world, required, after the root grant (its configtest door is proven first)', () => {
		for (const argv of [
			['--family', 'debian'],
			['--family', 'debian', '--in-place'],
			['--family', 'el', '--in-place'],
		]) {
			const all = legs(argv);
			const leg = all.find((l) => l.name === 'copy-media-web-user');
			expect(leg?.required, argv.join(' ')).toBe(true);
			expect(leg?.family).toBe('both');
			expect(leg?.inPlaceOnly).toBeUndefined();
			expect(all.findIndex((l) => l.name === 'copy-media-web-user')).toBeGreaterThan(
				all.findIndex((l) => l.name === 'agent-root-grant'),
			);
		}
	});

	test('its media path is a public quality on the generic test TLD, and its key is what Rule B stats', () => {
		// The quality segment (type/quality, as the public-quality list names it) is an ENGINE public quality.
		const quality = COPY_MEDIA_PATH.split('/').slice(0, 2).join('/');
		expect(getDefaultPublicQualities()).toContain(quality);
		// The key, through the ENGINE's own filename grammar (the one Rule B's include is built from).
		const match = COPY_MEDIA_PATH.match(new RegExp(MEDIA_FILENAME_GRAMMAR));
		expect(match).not.toBeNull();
		expect(`${match?.[1]}_${match?.[2]}`).toBe(COPY_MEDIA_KEY);
		expect(COPY_MEDIA_KEY.startsWith('test')).toBe(true);
	});

	test('modeMismatches: right modes pass; a 0750 level, a 0640 marker and an unstat-ed path are each named', () => {
		const want = { '/m': '755', '/m/.publication': '755', '/m/.publication/pub/test3_1': '644' };
		expect(
			modeMismatches('755 /m\n755 /m/.publication\n644 /m/.publication/pub/test3_1\n', want),
		).toEqual([]);
		expect(
			modeMismatches('755 /m\n750 /m/.publication\n640 /m/.publication/pub/test3_1\n', want),
		).toEqual([
			'/m/.publication is 750, expected 755',
			'/m/.publication/pub/test3_1 is 640, expected 644',
		]);
		const absent = modeMismatches(
			"755 /m\n755 /m/.publication\nstat: cannot statx '/m/.publication/pub/test3_1': No such file or directory\n",
			want,
		);
		expect(absent).toHaveLength(1);
		expect(absent[0]).toStartWith('/m/.publication/pub/test3_1 not stat-ed');
		// A path whose name only CONTAINS an expected one is not that path.
		expect(modeMismatches('755 /m/x\n', { '/m': '755' })).toHaveLength(1);
	});
});
