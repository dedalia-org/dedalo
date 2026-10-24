/**
 * KILL INTEGRITY — the BEHAVIOURAL twin of invariant 7 of
 * `test/unit/media_writer_discipline_tripwire.test.ts` (audit 2026-08 B2).
 *
 * That gate is a SOURCE SCAN: it proves every media declaration that runs an
 * external binary asks whether the process was killed. It cannot prove what the
 * answer then IS, and the answer is the whole defect. This file drives the kill
 * through the spawn seam and asserts the OBSERVABLE behaviour.
 *
 * THE CASE, precisely. `identify` prints its report incrementally, one line per
 * scene. A 3-scene layered TIFF cut after line 1 by a SIGKILL leaves stdout
 * holding a report that parses perfectly — as a SINGLE-SCENE source. That is not
 * a smaller answer, it is a WRONG one: "this file is one image" is exactly the
 * answer that makes every recipe skip scene selection, so the derivative ladder
 * is built from a truncated view of a master. The same shape appears on the two
 * other probes (`srgb  4.1` cut to `srgb  4.` parses to "no meta channel, NO
 * ALPHA" — the confident opposite of the documented `unknown`) and on the writer
 * (`runMagickTo`'s existence + scene post-condition both PASS on the partial file
 * a killed magick leaves behind).
 *
 * WHY `.timedOut` WAS NOT ENOUGH, which is the whole 2026-08-09 correction:
 * `spawn.ts` defines `timedOut = capExpired && signal !== null`, a STRICT SUBSET
 * of the kills. The first test below pins that discriminator on a real process —
 * a self-SIGKILLing child reports `signal !== null`, `timedOut === false`,
 * `ok === false` — so every case here is a kill the old `if (result.timedOut)`
 * branch was blind to: the OOM killer on a gigapixel decode (measured at 14.4 GB
 * RSS in `probe.ts`), a crashed delegate, an operator's `kill -9`.
 *
 * EVERY CASE CARRIES A POLARITY CONTROL WITH BYTE-IDENTICAL STDOUT. The fake
 * binary prints the same truncated report in both halves of a pair and differs
 * ONLY in whether it then kills itself. Without that control this file would
 * pass just as well against an engine that had merely become strict about short
 * reports — and being strict about short reports would be a NEW refusal the
 * oracle never made. The rule under test is "a killed command did not succeed",
 * nothing wider.
 *
 * HOW: `config.media.binaries.magick` is mocked to one tiny sh script that serves
 * both roles (`magick identify …` and `magick <convert argv>`), exactly as the
 * real v7 binary does. No real ImageMagick is needed, so this gate is green on a
 * host with none, and nothing here spawns a long-running process — the kill is
 * immediate and self-inflicted.
 *
 * OWN FILE ON PURPOSE: `mock.module` is process-global in bun and `mock.restore()`
 * does NOT revert it; the real config module is re-installed in `afterAll`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as REAL_CONFIG_MODULE from '../../src/config/config.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const ROOT = scratchDir('kill_integrity');
const BIN = join(ROOT, 'bin');
const WORK = join(ROOT, 'work');
const FAKE_MAGICK = join(BIN, 'magick');
const SOURCE = join(WORK, 'master.tif');

const REAL_CONFIG = REAL_CONFIG_MODULE.config;

/**
 * THE RESTORE MUST COME FROM A SNAPSHOT, NOT THE LIVE NAMESPACE (GATE-01).
 * `REAL_CONFIG_MODULE` is a LIVE module namespace: once `mock.module` has
 * replaced the module, that binding reflects the MOCK, so "restoring" from it
 * reinstalls the stub and hands it to every later file in the tier. This is a
 * spread COPY taken at import time, before any mock runs.
 */
const REAL_CONFIG_EXPORTS = { ...REAL_CONFIG_MODULE, config: REAL_CONFIG };

/**
 * ONE fake binary at a FIXED path, behaviour chosen by environment variables
 * (`runBinary` passes the parent env through to the child). Re-mocking config
 * per case would depend on `mock.module` live-updating an import already bound
 * inside every media module; this way nothing depends on that.
 *
 * It dispatches on `$1 = identify` the way `magick` itself does, and inside the
 * identify role on the `-format` string, so all three probes in
 * `engine/probe.ts` are served by the same script:
 *
 *   `%s|%w|…|%m`               → probeImageSource  (the per-scene report)
 *   `%[channels]`              → probeMetaChannels (the layout + `<total>.<meta>`)
 *   `%[fx:standard_deviation]` → probeContentSpread (one number)
 *
 * Each prints a HEAD, then optionally kills itself, then optionally prints the
 * TAIL. HEAD alone is the truncated report; HEAD+TAIL is the complete one. The
 * kill/no-kill pair with the tail suppressed is what makes the polarity control
 * byte-identical.
 */
function installFakeMagick(): void {
	mkdirSync(BIN, { recursive: true });
	writeFileSync(
		FAKE_MAGICK,
		`#!/bin/sh
# PASS-THROUGH WHEN THIS FILE IS NOT DRIVING.
#
# \`mock.module\` does NOT reliably revert: modules that already bound \`config\`
# keep the mocked object, so every media test file that runs AFTER this one in
# the same process can still resolve magick to THIS script. Measured: with the
# fixture deleted in afterAll, media_regenerate_thumb.test.ts died with
# ENOENT posix_spawn on this path — green alone, red in the suite.
#
# So the fixture stays on disk and defaults to the REAL binary. Only while
# FAKE_MAGICK_ACTIVE is set (beforeAll → afterAll of THIS file) does it behave
# as a fake. A leak is then merely a thin exec wrapper, never wrong behaviour.
if [ -z "$FAKE_MAGICK_ACTIVE" ]; then
  exec "${REAL_CONFIG.media.binaries.magick}" "$@"
fi
if [ "$1" = "identify" ]; then
  shift
  # ORDER MATTERS: probe.ts's PROBE_FORMAT itself contains '%[channels]', so the
  # per-scene report must be recognised FIRST, by a token only it carries.
  case " $* " in
    *"%[orientation]"*)
      printf '0|645|888|645|888|+0|+0|Undefined|sRGB|srgb  3.0|TIFF\\n'
      if [ "$FAKE_IDENTIFY_MODE" = "kill" ]; then kill -9 $$; fi
      if [ "$FAKE_IDENTIFY_FULL" = "1" ]; then
        printf '1|582|825|582|825|+31|+31|Undefined|sRGB|srgba 3.0|TIFF\\n'
        printf '2|400|400|400|400|+10|+10|Undefined|sRGB|srgba 3.0|TIFF\\n'
      fi
      exit 0
      ;;
    *"%[fx:"*)
      printf '0.10'
      if [ "$FAKE_IDENTIFY_MODE" = "kill" ]; then kill -9 $$; fi
      if [ "$FAKE_IDENTIFY_FULL" = "1" ]; then printf '38'; fi
      printf '\\n'
      exit 0
      ;;
    *"%[channels]"*)
      printf 'srgb  4.'
      if [ "$FAKE_IDENTIFY_MODE" = "kill" ]; then kill -9 $$; fi
      if [ "$FAKE_IDENTIFY_FULL" = "1" ]; then printf '1'; fi
      printf '\\n'
      exit 0
      ;;
  esac
  echo "fake magick identify: unrecognised -format, the dispatch above is stale: $*" >&2
  exit 64
fi
# the WRITER role: the output is the last argv token, minus its explicit coder
# prefix ('JPEG:/abs/path.jpg' — see coderToken in engine/imagemagick.ts).
out=""
for a in "$@"; do out="$a"; done
out="\${out#*:}"
printf 'PARTIAL' > "$out"
if [ "$FAKE_MAGICK_MODE" = "kill" ]; then kill -9 $$; fi
exit 0
`,
		{ mode: 0o755 },
	);
	chmodSync(FAKE_MAGICK, 0o755);
}

/** A binary that does nothing but SIGKILL itself — the discriminator fixture. */
const FAKE_SUICIDE = join(BIN, 'suicide');
function installSuicide(): void {
	mkdirSync(BIN, { recursive: true });
	writeFileSync(FAKE_SUICIDE, "#!/bin/sh\nprintf 'SOME OUTPUT'\nkill -9 $$\n", { mode: 0o755 });
	chmodSync(FAKE_SUICIDE, 0o755);
}

/** Install a config whose ImageMagick binaries are the fake above. */
function useFakeBinaries(): void {
	mock.module('../../src/config/config.ts', () => ({
		...REAL_CONFIG_MODULE,
		config: {
			...REAL_CONFIG,
			media: {
				...REAL_CONFIG.media,
				binaries: {
					...REAL_CONFIG.media.binaries,
					magick: FAKE_MAGICK,
					identify: FAKE_MAGICK,
				},
			},
		},
	}));
}

/** Choose whether the identify role kills itself, and whether it prints its tail. */
function identifyMode(mode: 'ok' | 'kill', full: boolean): void {
	process.env.FAKE_IDENTIFY_MODE = mode;
	process.env.FAKE_IDENTIFY_FULL = full ? '1' : '0';
}

beforeAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
	mkdirSync(WORK, { recursive: true });
	// Arms the fixture. Without it the script execs the real binary — see the
	// pass-through header in installFakeMagick.
	process.env.FAKE_MAGICK_ACTIVE = '1';
	installFakeMagick();
	installSuicide();
	writeFileSync(SOURCE, 'not really a tiff, the binary is fake');
	useFakeBinaries();
});
afterEach(() => {
	delete process.env.FAKE_IDENTIFY_MODE;
	delete process.env.FAKE_IDENTIFY_FULL;
	delete process.env.FAKE_MAGICK_MODE;
});
afterAll(() => {
	// Put the REAL config module back. This is BEST EFFORT and measured to be
	// insufficient on its own — a module that already bound `config` keeps the
	// mocked object — which is why disarming the fixture below is what actually
	// protects the files that run after this one.
	mock.module('../../src/config/config.ts', () => REAL_CONFIG_EXPORTS);
	// Disarm: from here the script is a pass-through to the real binary.
	delete process.env.FAKE_MAGICK_ACTIVE;
	// The fixture is deliberately NOT removed. A later file may still resolve
	// magick to this path, and deleting it turns the leak into ENOENT.
	rmSync(WORK, { recursive: true, force: true });
});

// ── 0. the discriminator: a kill we did not order is NOT `timedOut` ──────────

describe('kill integrity: the fact the whole invariant turns on', () => {
	test('a self-SIGKILLed child is signalled, NOT timed out, and never ok', async () => {
		const { runBinary } = await import('../../src/core/media/engine/spawn.ts');
		const result = await runBinary([FAKE_SUICIDE], { nice: false });

		// This is the shape every case below drives. If `timedOut` were true here,
		// the old `if (result.timedOut)` branch would have caught these kills and
		// none of the rest of this file would be measuring anything.
		expect(result.signal).not.toBeNull();
		expect(result.timedOut).toBe(false);
		expect(result.timeoutKind).toBeNull();
		expect(result.ok).toBe(false);
		// …and the output it managed to print before dying is still in hand, which
		// is precisely why a partial report is dangerous rather than empty.
		expect(result.stdout).toBe('SOME OUTPUT');
	});
});

// ── 1. probeImageSource: a truncated report is a WRONG answer, not a small one ─

describe('kill integrity: probeImageSource', () => {
	test('a SIGKILLed identify leaving a PARTIAL report throws instead of answering', async () => {
		const { probeImageSource } = await import('../../src/core/media/engine/probe.ts');
		identifyMode('kill', false);

		// The fake has printed scene 0 of a 3-scene layered source and died. Parsed,
		// that report says "one image" — the answer that makes every recipe skip
		// scene selection and build the ladder from a truncated view of the master.
		await expect(probeImageSource(SOURCE)).rejects.toThrow(/was killed/i);
	});

	test('POLARITY: the SAME truncated report from a clean exit is still answered', async () => {
		const { probeImageSource } = await import('../../src/core/media/engine/probe.ts');
		identifyMode('ok', false);

		// Byte-identical stdout to the case above. It must NOT throw: this engine did
		// not become strict about short reports (a single-scene source really does
		// print one line) — it became strict about KILLS.
		const probe = await probeImageSource(SOURCE);
		expect(probe.sceneCount).toBe(1);
		expect(probe.canvasWidth).toBe(645);
	});

	test('the complete report of the same source really is a 3-scene sequence', async () => {
		const { probeImageSource } = await import('../../src/core/media/engine/probe.ts');
		identifyMode('ok', true);

		// The anti-vacuity half of the pair: it proves the truncation above actually
		// LOST two scenes, so "1" was a wrong answer about this source and not a
		// faithful one about a different fixture.
		const probe = await probeImageSource(SOURCE);
		expect(probe.sceneCount).toBe(3);
	});
});

// ── 2. probeMetaChannels: the degraded answer must be the DOCUMENTED one ─────

describe('kill integrity: probeMetaChannels', () => {
	test('a SIGKILLed identify degrades to the documented unknown, not to a parsed lie', async () => {
		const { probeMetaChannels } = await import('../../src/core/media/engine/probe.ts');
		identifyMode('kill', false);

		// stdout holds `srgb  4.` — the layout token survived, the meta digit did not.
		// Parsed, that is `{metaChannels: 0, hasAlpha: FALSE}`. The documented unknown
		// is `{metaChannels: 0, hasAlpha: TRUE}`, and the alpha half is the one that
		// decides whether the flatten runs, so the difference is a real recipe change.
		expect(await probeMetaChannels(SOURCE)).toEqual({ metaChannels: 0, hasAlpha: true });
	});

	test('POLARITY: the SAME truncated line from a clean exit is parsed as it always was', async () => {
		const { probeMetaChannels } = await import('../../src/core/media/engine/probe.ts');
		identifyMode('ok', false);

		// Byte-identical stdout, no kill: the pre-existing parse stands, alpha false.
		// This is what pins the change to the kill and not to the report's shape.
		expect(await probeMetaChannels(SOURCE)).toEqual({ metaChannels: 0, hasAlpha: false });
	});

	test('the complete line of the same source reports one meta channel', async () => {
		const { probeMetaChannels } = await import('../../src/core/media/engine/probe.ts');
		identifyMode('ok', true);

		expect(await probeMetaChannels(SOURCE)).toEqual({ metaChannels: 1, hasAlpha: false });
	});
});

// ── 3. probeContentSpread: the safety net may not be handed a number it never measured ─

describe('kill integrity: probeContentSpread', () => {
	test('a SIGKILLed identify yields null, never a parseable prefix', async () => {
		const { probeContentSpread } = await import('../../src/core/media/engine/probe.ts');
		identifyMode('kill', false);

		// stdout holds `0.10`, a perfectly finite number — and the caller's whole job
		// is to CONDEMN a blank derivative on the strength of this value. `null` is
		// the honest answer: no evidence.
		expect(await probeContentSpread(SOURCE)).toBeNull();
	});

	test('POLARITY: the SAME prefix from a clean exit is still a measurement', async () => {
		const { probeContentSpread } = await import('../../src/core/media/engine/probe.ts');
		identifyMode('ok', false);

		expect(await probeContentSpread(SOURCE)).toBe(0.1);
	});

	test('the complete number of the same read is a different value', async () => {
		const { probeContentSpread } = await import('../../src/core/media/engine/probe.ts');
		identifyMode('ok', true);

		// 0.1038 vs 0.10 — the truncation really did change the measurement.
		expect(await probeContentSpread(SOURCE)).toBe(0.1038);
	});
});

// ── 4. runMagickTo: existence + one scene are BOTH true of the partial file ──

describe('kill integrity: the ImageMagick writer', () => {
	test('a SIGKILLed magick fails even though its output exists, is non-empty and pings as one image', async () => {
		const { convertImage } = await import('../../src/core/media/engine/imagemagick.ts');
		const target = join(WORK, 'killed.jpg');
		rmSync(target, { force: true });
		process.env.FAKE_MAGICK_MODE = 'kill';
		identifyMode('ok', false); // the post-condition probe would say "one image"

		await expect(
			convertImage(SOURCE, target, {
				quality: 'default',
				selection: 'representative',
				background: '#ffffff',
			}),
		).rejects.toThrow(/killed/i);

		// THE POINT: the truncated file is still sitting there. Both of the writer's
		// pre-2026-08-09 post-conditions pass on it — it exists, it is non-empty, and
		// the probe reports a single scene — so nothing but the kill check stands
		// between it and being renamed over a good derivative.
		expect(existsSync(target)).toBe(true);
		expect(readFileSync(target, 'utf8')).toBe('PARTIAL');
	});

	test('POLARITY: the SAME output from a clean exit is accepted', async () => {
		const { convertImage } = await import('../../src/core/media/engine/imagemagick.ts');
		const target = join(WORK, 'clean.jpg');
		rmSync(target, { force: true });
		process.env.FAKE_MAGICK_MODE = 'ok';
		identifyMode('ok', false);

		// Byte-identical output file, byte-identical probe report. It resolves — the
		// writer did not become strict about small files, only about killed ones.
		await convertImage(SOURCE, target, {
			quality: 'default',
			selection: 'representative',
			background: '#ffffff',
		});
		expect(readFileSync(target, 'utf8')).toBe('PARTIAL');
	});
});
