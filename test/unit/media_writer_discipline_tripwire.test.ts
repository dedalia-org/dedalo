/**
 * MEDIA WRITER DISCIPLINE TRIPWIRE (DEC-12) — 2026-08-04, the layered-TIFF import.
 *
 * A media derivative is produced by exactly ONE shape: an atomic writer builds it
 * under a unique temp sibling, a single runner proves the tool really wrote ONE
 * file, and the temp is renamed into place. Every hand-rolled variant of that
 * shape is what shipped the 2026-08-04 defect, and invariants 1-6 below are its
 * measured causes; invariant 7 (2026-08-09) is the audit-2026-08 B2 class, which
 * is the same law one level down — a tool that was KILLED wrote nothing usable,
 * whatever its exit code says:
 *
 *  1. NO `renameSync(` OUTSIDE `src/core/media/atomic.ts`. `processing.ts` and
 *     `tools/rotation.ts` each open-coded produce-then-rename with no cleanup,
 *     so when ImageMagick wrote `<stem>-0.jpg`/`-1.jpg` instead of `<stem>.jpg`
 *     the rename threw ENOENT, the sequence files stayed on disk forever (six
 *     orphans measured under `image/thumb/440000/`), and the ingest died AFTER
 *     the staged original had already been moved irreversibly. Only the atomic
 *     writer has the `finally` that removes the temp and sweeps the siblings.
 *  2. NO AD-HOC TEMP NAMING (`.tmp.${…}` / `.rot.${…}` / `.crop.${…}`) outside
 *     that writer. `tools/rotation.ts` used `${path}.rot.${process.pid}`, which
 *     is wrong TWICE: it drops the extension, so ImageMagick infers the SOURCE
 *     format and writes e.g. TIFF bytes into a `.jpg` tier; and a bare pid is
 *     not unique per call, so two concurrent rotations of the same file share a
 *     temp. `tempSibling` puts the unique token BEFORE the extension and adds a
 *     uuid for exactly these two reasons.
 *  3. EXACTLY ONE `runBinary(` WRITE SITE in `engine/imagemagick.ts`, inside
 *     `runMagickTo`. `runMagickTo` is the output CONTRACT (exists, non-empty,
 *     and holds exactly one scene) plus the hardened `MAGICK_CONFIGURE_PATH`
 *     policy. Before this change `cropImage` spawned magick directly — so it ran
 *     unhardened AND could report success having written nothing, which is the
 *     failure class no stderr check can see (measured: exit 0, empty stderr).
 *  5. EVERY ImageMagick PROCESS CARRIES THE HARDENED POLICY, reads included.
 *     `identify` is spawned only by `runIdentify` in `engine/binaries.ts`, which
 *     passes the same `magickPolicyEnv()`. ImageMagick chooses its coder from the
 *     file's CONTENT: `identify -ping` on a `.png` holding PostScript selects the
 *     PS coder (measured: reports `PS`, exit 0 unpoliced; refused with "not
 *     allowed by the security policy 'PS'" under the policy), and the staged-upload
 *     thumbnail probes RAW UPLOADED BYTES on the request path. A read spawned
 *     bare is the CVE-2018-16509 class re-opened.
 *  6. EVERY RUNNER CALL SITS INSIDE AN ATOMIC PRODUCER. `buildThumb` /
 *     `convertImage` / `rotateImage` / `cropImage` must be called from inside a
 *     `writeAtomically`/`writeAtomicallySync` callback, never handed the FINAL
 *     path. That is the shape `ingest/staged_thumbnail.ts` had — no temp, no
 *     rename, nothing for invariants 1-2 to see — and it returned a
 *     `thumbnail_url` for a file that never existed, leaving `<stem>-N.jpg`
 *     orphans in a live media dir with nothing to sweep them.
 *  4. NO `[0]` SCENE-SELECTOR CONCATENATION outside `engine/scene.ts`.
 *     Callers declare `selection: 'representative' | 'composite'`; `sceneToken`
 *     is the ONE place that turns that into `SOURCE[0]`. `processing.ts` used to
 *     paste `[0]` onto two source paths inline, which is how the pdf/cover gears
 *     were safe while every image gear was not — the incoherence that hid the
 *     bug for as long as it hid. It binds the PROBE as well: `probeMetaChannels`
 *     asks ImageMagick about ONE image and the convert then masks ONE image, so a
 *     divergence there would decide on one image's channels and apply the answer
 *     to another's.
 *  7. NO RUNNER MAY IGNORE THE SPAWN OUTCOME, AND A KILL IS NEVER AN EXCUSE
 *     (audit 2026-08 B2, gate added 2026-08-09, CORRECTED the same day). A command
 *     killed by a signal or a timeout DID NOT SUCCEED, and `SpawnResult.ok` is the
 *     only truth about it — `exitCode` is not, because bun's `await child.exited`
 *     resolves 128+n (137 for SIGKILL) and reads as an ordinary exit code.
 *     Measured: every ffmpeg runner asked `exitCode !== 0 && !timedOut`, so the
 *     10-minute cap was the EXCUSE that skipped the failure branch and the
 *     partial, moov-less temp was renamed over the master derivative while the job
 *     reported 'done'.
 *
 *     The first fix banned that ONE textual shape. The second widening was worse
 *     than narrow, it was WRONG: it counted the mere MENTION of `.timedOut` or
 *     `.signal` as "consulting", so `if (r.exitCode !== 0 && !r.timedOut) throw`
 *     — the measured blocker verbatim — was reported COMPLIANT by the gate written
 *     to catch it, and its self-test probed a hand-narrowed regex instead of the
 *     constant, which is what hid that. The law has two halves and both are gated
 *     here, on the real constants:
 *
 *       7a. Every declaration in the scanned tree that calls a runner (`runBinary`
 *           / `runIdentify` / `runProducer`) must CONSULT the outcome or DELEGATE
 *           it by returning the `SpawnResult` to a caller that does. Consulting
 *           means the SINGLE TRUTH (`assertSpawnOk(…)`, `result.ok`, a destructured
 *           `ok`) or a branch in which A KILL TRIGGERS THE FAILURE PATH
 *           (`result.signal !== null`, `if (result.timedOut)`). `.exitCode` alone
 *           is exactly the defect and is not consulting.
 *       7b. NO declaration anywhere in the scanned tree may NEGATE the kill fact —
 *           `!r.timedOut`, `!r.signal`, `r.timedOut === false`, `r.signal === null`.
 *           That shape can only ever move a killed child TOWARDS a success path,
 *           which is B2 itself. It has NO exemption list, because there is no
 *           media operation for which "it was killed" is a reason to continue.
 *
 *     Why 7a admits a kill-triggered branch and not only `.ok`: a runner may
 *     deliberately tolerate a NON-ZERO EXIT (`runMagickTo` keeps ImageMagick's
 *     TIFF-tag warnings as a `console.warn` because the file it wrote is sound),
 *     so demanding `.ok` there would ban a correct behaviour the oracle had — an
 *     over-strict whitelist is its own silent narrowing. What may never be
 *     tolerated is the KILL, and 7b is what makes that non-negotiable.
 *
 *     Read-only probes are exempt from 7a BY NAME — the one documented degradation
 *     (`engine/spawn.ts`: a probe may answer 'unknown', but it may never claim an
 *     output exists) — and the remaining file-producing offenders are a
 *     shrink-only ratchet, not an exemption. Nothing is exempt from 7b.
 *
 * TECHNIQUE: a source scan over `src/core/media/**` plus `src/ai/rag/image_source.ts`
 * (the one media writer outside that tree), comments STRIPPED first so the prose
 * explaining an anti-pattern — including this header — is never a false positive.
 * Exemptions are NAMED, each carrying a reason the gate itself asserts is
 * substantive, and each self-tested for staleness: an entry whose file no longer
 * matches must be deleted, or the gate looks stricter than it is.
 *
 * HONEST LIMIT: this proves the SHAPE of every write site, not that a given
 * derivative is correct. Correctness is `media_processing` / `media_atomic` /
 * `media_probe`; this gate is what stops the shape drifting back.
 *
 * Registered in engineering/TRIPWIRES.md + scripts/verify.ts.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '../..');

/** Directories scanned whole (recursively, .ts only, tests excluded). */
const SCAN_DIRS = ['src/core/media'];

/**
 * Individual files scanned on top of the directories: media writers that live
 * outside `src/core/media/`. `image_source.ts` converts a record image into a
 * scratch raster for the RAG image index — it IS a magick call site, and its
 * degrade-never-throw contract makes an ad-hoc write there especially quiet.
 */
const SCAN_FILES = ['src/ai/rag/image_source.ts'];

/** The single atomic writer — the only legal home of a temp name and a rename. */
const ATOMIC_WRITER = 'src/core/media/atomic.ts';

/** The single ImageMagick argv/runner module (the one `magick` spawn). */
const MAGICK_ENGINE = 'src/core/media/engine/imagemagick.ts';

/** The binary-resolution leaf (the one `identify` spawn, and the policy env). */
const MAGICK_BINARIES = 'src/core/media/engine/binaries.ts';

/**
 * The scene-selector leaf — the ONE home of `sceneToken`, i.e. of the decision
 * "which image of this source do we mean". It is its own module because both the
 * argv recipes and `probe.ts` need it and `imagemagick.ts` already imports
 * `probe.ts`, so either of those as its home would close an import cycle.
 */
const MAGICK_SCENE = 'src/core/media/engine/scene.ts';

// ---------------------------------------------------------------------------
// Scan plumbing
// ---------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (entry === 'node_modules' || entry.startsWith('.')) continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) walk(full, out);
		else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
	}
	return out;
}

/** Every scanned file, as a repo-relative path. */
function scannedFiles(): string[] {
	const files: string[] = [];
	for (const dir of SCAN_DIRS) {
		for (const full of walk(join(ROOT, dir))) files.push(relative(ROOT, full));
	}
	for (const file of SCAN_FILES) files.push(file);
	return files.sort();
}

/** Strip comments — prose about the anti-pattern must not trip the scan. */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function readCode(file: string): string {
	return stripComments(readFileSync(join(ROOT, file), 'utf-8'));
}

/** Repo-relative paths of every scanned file whose CODE matches `pattern`. */
function filesMatching(pattern: RegExp): string[] {
	return scannedFiles().filter((file) => pattern.test(readCode(file)));
}

/**
 * Assert a named exemption/ratchet map is honest: every reason is substantive
 * (>= 20 chars — a bare `''` or `'ok'` is not a reason), and every named file
 * still actually matches (a stale entry silently widens the gate).
 */
function assertMapHonest(
	label: string,
	map: Record<string, string>,
	matching: readonly string[],
): void {
	const thin = Object.entries(map)
		.filter(([, reason]) => reason.trim().length < 20)
		.map(([file]) => file);
	expect(thin, `${label}: these entries carry no substantive reason: ${thin.join(', ')}`).toEqual(
		[],
	);
	const stale = Object.keys(map).filter((file) => !matching.includes(file));
	expect(
		stale,
		`${label}: stale entries — these files no longer match, delete them (an exemption list that outlives its reason makes this gate look stricter than it is): ${stale.join(', ')}`,
	).toEqual([]);
}

// ---------------------------------------------------------------------------
// 1. renameSync — the atomic writer owns the rename
// ---------------------------------------------------------------------------

const RENAME = /\brenameSync\s*\(/;

/**
 * Files that call `renameSync` to MOVE a file that already exists, never to
 * publish a derivative they just produced. They have no temp, nothing to sweep
 * and nothing to prove about a tool's output, so the atomic writer would add
 * a copy and a failure mode without adding a guarantee.
 */
const MOVE_ONLY_RENAME: Record<string, string> = {
	'src/core/media/ingest/add_file.ts':
		'moves the STAGED UPLOAD into the media tree (the irreversible step every derivative failure now happens after); the bytes already exist and are not produced here',
	'src/core/media/file_ops.ts':
		'moves a file aside into deleted/ (PHP rename_old_files) — a backup move, no producer, no temp',
	'src/core/media/ingest/upload.ts':
		'THREE legitimate uses, none of them a derivative: it claims the FINAL staged name for a completed upload (atomic wx-open then move of the assembled chunks, WC-2026-08-03), publishes the upload meta.json through its own temp, and moves a rejected upload into quarantine. All three move or publish RECEIVED bytes; no ImageMagick run, nothing to sweep',
	'src/core/media/tools/posterframe.ts':
		'moves an UPLOADED posterframe/subtitle file to its av derived path; the thumb it then builds from it does go through the atomic writer',
	'src/core/media/protection.ts':
		'retireLegacyAuthStore moves the DEAD day-global auth store aside, once, on the upgrade past the per-session media credential (2026-08-24). It is not a derivative and it is not even in the media tree — the file lives in <private>/, deliberately outside every served root, because it held cleartext media credentials. Nothing is produced, there is no temp and there is nothing to sweep; the rename is chosen over an unlink so an operator debugging the upgrade can still see what was there',
};

/**
 * KNOWN-OPEN, shrink-only: the AV (ffmpeg) writers that still hand-roll the
 * produce-then-rename shape. Converting one MUST delete its entry (the staleness
 * self-test enforces it) — the list may only ever get shorter.
 *
 * 2026-08-09: SHRUNK by one. `av_versions.ts` — the writer that leaked the
 * measured `av/404/0/test94_test3_1.mp4.tmp.50160` orphan — now produces BOTH av
 * tiers through `writeAtomically`, so it names no temp and calls no rename at
 * all, and its entry is gone from here and from AD_HOC_TEMP_RATCHET (which is
 * now empty).
 */
const AV_WRITER_RATCHET: Record<string, string> = {
	'src/core/media/engine/ffmpeg.ts':
		'KNOWN-OPEN, and now the ONLY entry: `conformHeader` is an IN-PLACE rewrite with a backup, a shape `writeAtomically` does not model — it must publish the proven temp over `source` *and* preserve the pre-conform bytes as `<stem>_untouched` (PHP conform_header :1346), so the two renames are ordered, not interchangeable. Its scratch already comes from `atomic.ts` (withTempSibling) and every failure path leaves `source` untouched; what remains open is the missing atomic PRIMITIVE for replace-with-backup',
};

describe('media writer discipline: renameSync lives in the atomic writer', () => {
	test('no media producer publishes its own derivative with renameSync', () => {
		const matching = filesMatching(RENAME);
		const violations = matching.filter(
			(file) =>
				file !== ATOMIC_WRITER &&
				MOVE_ONLY_RENAME[file] === undefined &&
				AV_WRITER_RATCHET[file] === undefined,
		);
		expect(
			violations,
			`Hand-rolled produce-then-rename. Use writeAtomically / writeAtomicallySync from src/core/media/atomic.ts — it owns the unique temp, the rename AND the finally that sweeps the <stem>-N sequence files ImageMagick leaves behind: ${violations.join(', ')}`,
		).toEqual([]);
	});

	test('the atomic writer really is the one that renames (positive control)', () => {
		// Without this the invariant above could pass because NOTHING renames —
		// e.g. after a refactor moved the writer and the scan roots went stale.
		expect(filesMatching(RENAME)).toContain(ATOMIC_WRITER);
	});

	test('every renameSync exemption is named, reasoned and still true', () => {
		const matching = filesMatching(RENAME);
		assertMapHonest('MOVE_ONLY_RENAME', MOVE_ONLY_RENAME, matching);
		assertMapHonest('AV_WRITER_RATCHET', AV_WRITER_RATCHET, matching);
	});
});

// ---------------------------------------------------------------------------
// 2. Temp naming — one grammar, one owner
// ---------------------------------------------------------------------------

/**
 * A SCRATCH FILENAME BUILT INLINE: a path derived from another path (`${…}`)
 * whose name carries a scratch marker.
 *
 * WIDENED 2026-08-09. The original pattern was `\.(?:tmp|rot|crop)\.\$\{` — it
 * matched one exact punctuation shape, so a NEW hand-rolled convention entered a
 * scanned module completely invisibly: `${file}.faststart${extname(file)}` (the
 * moov-relocation scratch) sat in no ratchet and tripped nothing. A gate that
 * bans one spelling of an anti-pattern is not a gate for the anti-pattern.
 *
 * It now matches any interpolated path followed by a name whose separator-led
 * token is a scratch marker, so `${x}.tmp.${…}`, `${x}.faststart${…}`,
 * `${stem}_temp${ext}` and `${p}.part` are all one rule.
 *
 * HONEST LIMIT: this binds how a STAGING file is NAMED. It cannot see a scratch
 * whose name carries no marker at all — invariant 1 (renameSync) is what binds a
 * scratch that gets PUBLISHED, and the two together are why `writeAtomically` is
 * the only route from a producer to a final path. An auxiliary path that is never
 * published and never renamed (ffmpeg's `-passlogfile` PREFIX, which the runner
 * that owns it removes in a `finally`) is out of scope for both.
 */
const AD_HOC_TEMP =
	/\$\{[^`{}]*\}[^`\s]*[._-](?:tmp|temp|scratch|part|partial|rot|crop|faststart)\b/i;

/**
 * Scratch naming that is NOT derivative staging. The chunked-upload assembler
 * names its pieces by CHUNK INDEX, which is the one thing `tempSibling`'s uuid
 * cannot express — the parts must be findable and ordered by a resumed upload.
 *
 * Each entry exempts EXACT SPELLINGS, never a whole file: `spellings` is the
 * multiset of AD_HOC_TEMP's global matches in that file's comment-stripped code,
 * and the gate asserts equality both ways. A NEW scratch spelling (or one more
 * occurrence of an exempt one) in an exempt file is red, and so is a spelling
 * that no longer occurs (stale). A whole-file exemption would let a real ad-hoc
 * derivative temp land in `upload.ts` and pass silently.
 */
interface AdHocTempExemption {
	readonly reason: string;
	readonly spellings: readonly string[];
}

const AD_HOC_TEMP_EXEMPT: Record<string, AdHocTempExemption> = {
	'src/core/media/tools/crop_coin_pair.ts': {
		reason:
			'the `${stem}_crop-${index}.${ext}` spelling is the PHP-parity DISPLAY name of each coin face (`fileName`, shown to the cataloguer and stored as the original name), never a path: the STAGED file is named through tempSibling (pid + uuid, extension last) and so is the bilevel mask, because every lot of an acquisition batch stages under one key_dir',
		spellings: ['${names.stem}_crop'],
	},
	'src/core/media/ingest/upload.ts': {
		reason:
			'RECEIVE-side scratch, not a derivative: `${chunkIndex}.part` names the pieces of a resumable upload, which must be addressable by index across requests, and the `.tmp` is the meta.json publish. Nothing here is produced by a media binary, so there is no output contract and no sequence split to sweep',
		spellings: [
			'${Math.random().toString(16).slice(2, 10)}.tmp',
			'${parsed.chunkIndex}.part',
			'${i}.part',
			'${i}.part',
			'${i}.part',
			'${i}.part',
		],
	},
};

/** Every AD_HOC_TEMP match in `code`, sorted (a multiset — repeats count). */
function adHocTempSpellings(code: string): string[] {
	const global = new RegExp(AD_HOC_TEMP.source, `${AD_HOC_TEMP.flags.replace('g', '')}g`);
	return (code.match(global) ?? []).slice().sort();
}

/**
 * The exempt spellings of one file must EQUAL its actual matches. Returns the
 * drift (unexempted extras, stale spellings) so the planted control can probe
 * the very function the real test uses.
 */
function exemptSpellingDrift(
	code: string,
	exemption: AdHocTempExemption,
): { extra: string[]; stale: string[] } {
	const remaining = [...exemption.spellings];
	const extra: string[] = [];
	for (const found of adHocTempSpellings(code)) {
		const at = remaining.indexOf(found);
		if (at === -1) extra.push(found);
		else remaining.splice(at, 1);
	}
	return { extra, stale: remaining };
}

/**
 * Empty since 2026-08-09, and it stays that way: `av_versions.ts` was the last
 * entry and now takes both its temps from `tempSibling` via `writeAtomically`.
 * Kept (rather than deleted) as the declared home for any future known-open
 * offender, so one is never quietly folded into AD_HOC_TEMP_EXEMPT instead.
 */
const AD_HOC_TEMP_RATCHET: Record<string, string> = {};

describe('media writer discipline: temp names come from tempSibling', () => {
	test('no media writer invents its own temp filename', () => {
		const matching = filesMatching(AD_HOC_TEMP);
		const violations = matching.filter(
			(file) =>
				file !== ATOMIC_WRITER &&
				AD_HOC_TEMP_EXEMPT[file] === undefined &&
				AD_HOC_TEMP_RATCHET[file] === undefined,
		);
		expect(
			violations,
			`Ad-hoc temp name. Use writeAtomically / writeAtomicallySync (src/core/media/atomic.ts): the unique token must sit BEFORE the extension (magick and ffmpeg both infer the OUTPUT FORMAT from the extension) and must include a uuid (a bare pid is not unique per call — the job manager runs three lanes in ONE process, so two builds of the same tier would share it and each sweep the other's scratch): ${violations.join(', ')}`,
		).toEqual([]);
	});

	test('the atomic writer really is the one that names temps (positive control)', () => {
		expect(filesMatching(AD_HOC_TEMP)).toContain(ATOMIC_WRITER);
	});

	test('the pattern catches every hand-rolled convention this gate has met', () => {
		// The widening's own control: each of these is a real shape that shipped, and
		// only the first was caught before 2026-08-09. If a future simplification of
		// AD_HOC_TEMP stops matching one of them the gate has silently narrowed back.
		for (const shape of [
			'const t = `${path}.rot.${process.pid}`;', // tools/rotation.ts, 2026-08-04
			'const t = `${target}.tmp.${process.pid}${extname(target)}`;', // av_versions.ts
			'const t = `${file}.faststart${extname(file)}`;', // engine/ffmpeg.ts, wave 1
			'const t = `${dir}/${stem}_temp${ext}`;', // conformHeader
			'const t = `${dir}/${i}.part`;', // ingest/upload.ts
		]) {
			expect(AD_HOC_TEMP.test(shape), `AD_HOC_TEMP no longer catches: ${shape}`).toBe(true);
		}
		// …and does not fire on ordinary interpolated prose or a real media path.
		for (const innocent of [
			'throw new Error(`${what} reported success but produced no output`);',
			'console.error(`[media] av ${a.sectionTipo}/${a.sectionId}/${a.componentTipo}: x`);',
			'const p = `${dir}/${stem}${ext}`;',
		]) {
			expect(AD_HOC_TEMP.test(innocent), `AD_HOC_TEMP false positive on: ${innocent}`).toBe(false);
		}
	});

	test('every ad-hoc-temp exemption and ratchet entry is named, reasoned and still true', () => {
		const matching = filesMatching(AD_HOC_TEMP);
		assertMapHonest(
			'AD_HOC_TEMP_EXEMPT',
			Object.fromEntries(Object.entries(AD_HOC_TEMP_EXEMPT).map(([f, e]) => [f, e.reason])),
			matching,
		);
		assertMapHonest('AD_HOC_TEMP_RATCHET', AD_HOC_TEMP_RATCHET, matching);
	});

	test('an exempt file admits EXACTLY its listed spellings — no more, no fewer', () => {
		for (const [file, exemption] of Object.entries(AD_HOC_TEMP_EXEMPT)) {
			expect(
				exemption.spellings.length,
				`${file}: an exemption must list its spellings`,
			).toBeGreaterThan(0);
			const { extra, stale } = exemptSpellingDrift(readCode(file), exemption);
			expect(
				extra,
				`${file}: ad-hoc temp spelling(s) NOT covered by its exemption — a new scratch name in an exempt file is still an offender (use writeAtomically / tempSibling, or exempt the exact spelling with a reason): ${extra.join(' | ')}`,
			).toEqual([]);
			expect(
				stale,
				`${file}: stale exempt spelling(s) — no longer present, delete them: ${stale.join(' | ')}`,
			).toEqual([]);
		}
	});

	test('planted offender: an extra spelling in an exempt file is caught (positive control)', () => {
		const file = 'src/core/media/ingest/upload.ts';
		const exemption = AD_HOC_TEMP_EXEMPT[file];
		expect(exemption).toBeDefined();
		const real = readCode(file);
		// Sanity: the real file is clean, so the planted line is the only cause.
		expect(exemptSpellingDrift(real, exemption as AdHocTempExemption)).toEqual({
			extra: [],
			stale: [],
		});
		const planted = `${real}\nconst scratch = \`\${derivative}.tmp\${extname(derivative)}\`;\n`;
		expect(exemptSpellingDrift(planted, exemption as AdHocTempExemption)).toEqual({
			extra: ['${derivative}.tmp'],
			stale: [],
		});
		// …and one MORE occurrence of an already-exempt spelling is caught too.
		const repeated = `${real}\nconst more = join(dir, \`\${i}.part\`);\n`;
		expect(exemptSpellingDrift(repeated, exemption as AdHocTempExemption).extra).toEqual([
			'${i}.part',
		]);
		// …and a vanished spelling reads stale.
		const shrunk = {
			...(exemption as AdHocTempExemption),
			spellings: [...(exemption as AdHocTempExemption).spellings, '${gone}.part'],
		};
		expect(exemptSpellingDrift(real, shrunk).stale).toEqual(['${gone}.part']);
	});
});

// ---------------------------------------------------------------------------
// 3. One magick spawn, inside the output contract
// ---------------------------------------------------------------------------

const RUN_BINARY = /\brunBinary\s*\(/g;

/**
 * Extract a function body by brace matching from its signature. Comments are
 * stripped before this runs, and the bodies concerned hold only balanced
 * template-literal braces, so a naive counter is exact here — and if it ever is
 * not, it throws rather than silently returning a body that proves nothing.
 */
function functionBody(source: string, signature: string, file: string): string {
	const start = source.indexOf(signature);
	if (start === -1) throw new Error(`${file}: '${signature}' not found`);
	const open = source.indexOf('{', start + signature.length);
	if (open === -1) throw new Error(`${file}: no body for '${signature}'`);
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		if (source[i] === '{') depth++;
		else if (source[i] === '}') {
			depth--;
			if (depth === 0) return source.slice(open, i + 1);
		}
	}
	throw new Error(`${file}: unbalanced body for '${signature}'`);
}

describe('media writer discipline: one ImageMagick spawn, inside runMagickTo', () => {
	test('engine/imagemagick.ts spawns magick exactly once, and only from runMagickTo', () => {
		const code = readCode(MAGICK_ENGINE);
		const calls = [...code.matchAll(RUN_BINARY)];
		expect(
			calls.length,
			'engine/imagemagick.ts must hold exactly ONE runBinary( call. Every magick run has to go through runMagickTo, which is the only place that applies the hardened MAGICK_CONFIGURE_PATH policy AND proves the run produced exactly one non-empty file (a bypass reports success having written nothing: measured exit 0, empty stderr)',
		).toBe(1);
		const body = functionBody(code, 'async function runMagickTo(', MAGICK_ENGINE);
		expect(
			body,
			'the one runBinary( call is outside runMagickTo — move it inside, or its output is unverified and its policy unhardened',
		).toMatch(/\brunBinary\s*\(/);
	});

	test('engine/binaries.ts spawns identify exactly once, and only from runIdentify', () => {
		// The READ side of the same rule. It lives here rather than in imagemagick.ts
		// because probe.ts needs it and importing back would close a static-import
		// cycle (see the module header there).
		const code = readCode(MAGICK_BINARIES);
		expect(
			[...code.matchAll(RUN_BINARY)].length,
			'engine/binaries.ts must hold exactly ONE runBinary( call — every identify read goes through runIdentify, which is what applies the hardened policy to a file whose coder ImageMagick picks from its CONTENT',
		).toBe(1);
		const body = functionBody(code, 'export async function runIdentify(', MAGICK_BINARIES);
		expect(body).toMatch(/\brunBinary\s*\(/);
	});

	test('both ImageMagick spawn sites carry the hardened policy env', () => {
		// The policy is MEDIA-02's whole mechanism: without MAGICK_CONFIGURE_PATH the
		// process loads the SYSTEM policy.xml (permissive on every box measured), and
		// the PS/EPS Ghostscript-delegate class is reachable from an upload again.
		const magickRun = functionBody(
			readCode(MAGICK_ENGINE),
			'async function runMagickTo(',
			MAGICK_ENGINE,
		);
		expect(
			magickRun,
			'runMagickTo spawns magick without magickPolicyEnv() — the hardened policy.xml is not loaded',
		).toMatch(/magickPolicyEnv\s*\(/);
		const identifyRun = functionBody(
			readCode(MAGICK_BINARIES),
			'export async function runIdentify(',
			MAGICK_BINARIES,
		);
		expect(
			identifyRun,
			'runIdentify spawns identify without magickPolicyEnv() — a read is a full ImageMagick coder dispatch and must be policed too',
		).toMatch(/magickPolicyEnv\s*\(/);
	});

	test("no other media module spawns ImageMagick behind the engine's back", () => {
		// `resolveMagick()` / `resolveIdentify()` are the binary PATH resolvers; a
		// caller holding one and spawning is the same bypass as an extra runBinary
		// inside the engine — and that is exactly how file_date.ts read EXIF off a
		// freshly uploaded file with no policy until 2026-08-04.
		const violations = scannedFiles().filter((file) => {
			if (file === MAGICK_ENGINE || file === MAGICK_BINARIES) return false;
			const code = readCode(file);
			return (
				/\bresolveMagick\s*\(|\bresolveIdentify\s*\(/.test(code) && /\brunBinary\s*\(/.test(code)
			);
		});
		expect(
			violations,
			`These modules build an ImageMagick argv AND spawn it themselves, bypassing runMagickTo's output contract and runIdentify's policy env — call the engine's runner instead: ${violations.join(', ')}`,
		).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 4. The scene selector is built in exactly one place
// ---------------------------------------------------------------------------

/**
 * A scene selector pasted onto a path: `${source}[0]` in a template literal, or
 * `+ '[0]'`. Deliberately anchored on the CONCATENATION, so ordinary array
 * indexing (`items[0]`, `fields[0]`) is not a false positive.
 */
const SCENE_SELECTOR_CONCAT = /\$\{[^{}]*\}\[0\]|\+\s*['"`]\[0\]['"`]/;

describe('media writer discipline: the scene selector has one home', () => {
	test('no caller pastes a [0] scene selector onto a source path', () => {
		const violations = filesMatching(SCENE_SELECTOR_CONCAT).filter((file) => file !== MAGICK_SCENE);
		expect(
			violations,
			`Inline [0] scene selector. Callers declare selection: 'representative' | 'composite' and sceneToken() (engine/scene.ts) builds the token — one place decides what "the source's own image" means, so a new gear cannot be written without deciding it. This binds the PROBE too: probeMetaChannels asks about one image and the convert then masks one image, and if those disagreed the engine would read one image's channels and apply the answer to another's. Violations: ${violations.join(', ')}`,
		).toEqual([]);
	});

	test('sceneToken is where the selector is actually built (positive control)', () => {
		expect(filesMatching(SCENE_SELECTOR_CONCAT)).toContain(MAGICK_SCENE);
	});
});

// ---------------------------------------------------------------------------
// 6. Every runner call sits inside an atomic producer
// ---------------------------------------------------------------------------

/**
 * The four public ImageMagick runners. `\s*\(` after the exact name keeps
 * `buildThumbAtomically(` — the atomic gear that WRAPS buildThumb — out of the
 * match: what is banned is calling the raw runner with a final path.
 */
const RUNNER_CALL = /\b(?:buildThumb|convertImage|rotateImage|cropImage)\s*\(/g;

/** The same pattern without /g — `.test()` on a global regex is stateful. */
const RUNNER_CALL_ANY = /\b(?:buildThumb|convertImage|rotateImage|cropImage)\s*\(/;

/** Call sites that legitimately write their own target, with the reason. */
const DIRECT_RUNNER_CALL: Record<string, string> = {
	'src/ai/rag/image_source.ts':
		'converts a record image into a SCRATCH raster in os.tmpdir() for the RAG image index: that path IS the final output, nothing else can observe it, and the contract is degrade-never-throw (a failed index entry must not fail a save)',
};

/**
 * Index of the closing paren matching the '(' at `open`. Quoted spans are
 * skipped whole so a paren inside a string or a template literal cannot
 * unbalance the count; an unbalanced call throws rather than reporting a span
 * that would silently swallow the runner calls after it.
 */
function matchingParen(code: string, open: number, file: string): number {
	let depth = 0;
	let quote: string | null = null;
	for (let i = open; i < code.length; i++) {
		const ch = code[i];
		if (quote !== null) {
			if (ch === '\\') i++;
			else if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === '`') quote = ch;
		else if (ch === '(') depth++;
		else if (ch === ')') {
			depth--;
			if (depth === 0) return i;
		}
	}
	throw new Error(`${file}: unbalanced writeAtomically( call at ${String(open)}`);
}

/** [start, end] of every `writeAtomically(…)` / `writeAtomicallySync(…)` call. */
function atomicProducerSpans(code: string, file: string): [number, number][] {
	const spans: [number, number][] = [];
	for (const match of code.matchAll(/\bwriteAtomically(?:Sync)?\s*\(/g)) {
		const open = match.index + match[0].length - 1;
		spans.push([open, matchingParen(code, open, file)]);
	}
	return spans;
}

describe('media writer discipline: a runner is only ever called inside an atomic producer', () => {
	test('no media module hands an ImageMagick runner a final path', () => {
		const violations: string[] = [];
		for (const file of scannedFiles()) {
			if (file === MAGICK_ENGINE || DIRECT_RUNNER_CALL[file] !== undefined) continue;
			const code = readCode(file);
			const spans = atomicProducerSpans(code, file);
			for (const call of code.matchAll(RUNNER_CALL)) {
				const at = call.index;
				if (!spans.some(([start, end]) => at > start && at < end)) {
					violations.push(`${file}: ${call[0]}`);
				}
			}
		}
		expect(
			violations,
			`These runner calls write their target directly. Wrap them in writeAtomically / writeAtomicallySync (src/core/media/atomic.ts): a reader (and the web server) must never see a half-written derivative, and when a run splits into <stem>-N.jpg the sweep in the writer's finally is the only thing that collects it — invariants 1 and 2 cannot see this shape at all, because it has neither a temp nor a rename: ${violations.join(', ')}`,
		).toEqual([]);
	});

	test('the runners really are called from inside producers (positive control)', () => {
		// Without this the invariant passes when NOTHING calls a runner — e.g. after a
		// rename that the scan roots did not follow.
		const inside = scannedFiles().filter((file) => {
			if (file === MAGICK_ENGINE) return false;
			const code = readCode(file);
			const spans = atomicProducerSpans(code, file);
			return [...code.matchAll(RUNNER_CALL)].some((call) =>
				spans.some(([start, end]) => call.index > start && call.index < end),
			);
		});
		expect(inside).toContain('src/core/media/processing.ts');
		expect(inside).toContain('src/core/media/tools/rotation.ts');
	});

	test('every direct-runner exemption is named, reasoned and still true', () => {
		assertMapHonest('DIRECT_RUNNER_CALL', DIRECT_RUNNER_CALL, filesMatching(RUNNER_CALL_ANY));
	});
});

// ---------------------------------------------------------------------------
// 7. No runner may ignore the spawn outcome, and a kill is never an excuse
//    (audit 2026-08 B2 — 7a: consult or delegate; 7b: never negate the kill)
// ---------------------------------------------------------------------------

/**
 * The runner functions: every route from this tree to an external process.
 * ONE list, used both to FIND the call sites and to judge whether a declaration
 * that delegates its outcome delegates to something this gate actually scans —
 * the two must never drift, or delegation becomes a way out of the invariant.
 */
const SPAWN_RUNNER_NAMES = ['runBinary', 'runIdentify', 'runProducer'] as const;

const SPAWN_RUNNER = new RegExp(String.raw`\b(?:${SPAWN_RUNNER_NAMES.join('|')})\s*\(`, 'g');

/**
 * CONSULTING the outcome (invariant 7a). These accepted shapes, and no more:
 *
 *   `assertSpawnOk(…)`            the canonical gate
 *   `result.ok`                   the single truth, however it is branched on
 *   `const { ok, … } = await …`   the same truth, destructured
 *   `result.signal !== null`      a KILL TRIGGERS the failure path
 *
 * `.exitCode` is deliberately NOT here: it is the defect — bun resolves a
 * signalled child as 128+n, so a SIGKILLed encode reads as "exit 137".
 *
 * `if (result.timedOut)` IS NOT HERE EITHER, and that is the whole of finding (b).
 * `timedOut` is a STRICT SUBSET of `signal` (`engine/spawn.ts`: `timedOut =
 * capExpired && signal !== null`), so a runner that branches on it alone handles
 * OUR kill and swallows every other one — the OOM killer, an operator's
 * `kill -9`, a crashed delegate. Four live declarations looked compliant under a
 * `timedOut`-accepting rule while leaving a truncated file on disk for the
 * existence check to bless. The accepted kill test is the TOTAL one.
 *
 * NOTE THE ASYMMETRY, it is the whole correction of 2026-08-09: the kill facts
 * count ONLY in the polarity that makes a kill FAIL. A bare mention of
 * `.timedOut` used to count, which made `if (r.exitCode !== 0 && !r.timedOut)
 * throw` — the measured B2 blocker — read as compliant. `!r.timedOut` and
 * `r.signal === null` are now caught by KILL_EXCUSED instead, which has no
 * exemptions at all.
 */
const CONSULTS_OUTCOME =
	/assertSpawnOk\s*\(|\.ok\b|\{[^{}]*\bok\b[^{}]*\}\s*=\s*await\b|\.signal\s*!==?\s*null/;

/**
 * EXCUSING a kill (invariant 7b): the kill fact NEGATED. `!r.timedOut`,
 * `!r.signal`, `r.timedOut === false`, `r.signal === null` — every one of them can
 * only ever carry a killed child TOWARDS a success path, which is B2 verbatim.
 *
 * The negation form refuses a trailing `.` (`(?!\s*\.)`) so an AbortController's
 * `!controller.signal.aborted` — a different `signal` entirely, and one
 * `src/core/media/jobs.ts` really uses — is not a false positive.
 */
const KILL_EXCUSED =
	/!\s*[A-Za-z_$][\w$.]*\.(?:timedOut|signal)\b(?!\s*\.)|\.(?:timedOut|signal)\s*===?\s*(?:false|null)/;

/**
 * DELEGATING the outcome: a wrapper that hands the whole `SpawnResult` back is
 * not ignoring it — its callers are bound by this same invariant, because the
 * wrappers (`runIdentify`, `runProducer`) are themselves in SPAWN_RUNNER.
 */
const DELEGATES_OUTCOME = /Promise<SpawnResult>|:\s*SpawnResult\b/;

/** Where `runBinary` is DEFINED — its own name in its own signature is not a call. */
const SPAWN_DEFINITION = 'src/core/media/engine/spawn.ts';

/** Start offsets of every TOP-LEVEL declaration (column 0), in source order. */
const TOP_LEVEL_DECL =
	/^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|class|let|var)\s+([A-Za-z_$][\w$]*)/gm;

/**
 * Attribute every runner call to the top-level declaration it sits in, and judge
 * that declaration. Segmenting on column-0 declarations (rather than parsing
 * function bodies) is exact for this tree and cannot be fooled by a brace inside
 * a return-type annotation — `probeStreams(): Promise<{streams: …}>` is precisely
 * where a naive brace matcher takes the WRONG opening brace and reports a body
 * that proves nothing.
 *
 * Returns `file::declaration` keys, one per offending declaration.
 */
function spawnOutcomeVerdicts(): {
	consulting: string[];
	delegating: string[];
	ignoring: string[];
} {
	const consulting: string[] = [];
	const delegating: string[] = [];
	const ignoring: string[] = [];
	for (const file of scannedFiles()) {
		if (file === SPAWN_DEFINITION) continue;
		const code = readCode(file);
		const decls = [...code.matchAll(TOP_LEVEL_DECL)].map((match) => ({
			name: match[1] as string,
			at: match.index,
		}));
		const seen = new Set<string>();
		for (const call of code.matchAll(SPAWN_RUNNER)) {
			let host = { name: '<file scope>', at: 0 };
			let end = code.length;
			for (const [index, decl] of decls.entries()) {
				if (decl.at < call.index) {
					host = decl;
					end = decls[index + 1]?.at ?? code.length;
				}
			}
			const key = `${file}::${host.name}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const segment = code.slice(host.at, end);
			if (CONSULTS_OUTCOME.test(segment)) consulting.push(key);
			else if (DELEGATES_OUTCOME.test(segment)) delegating.push(key);
			else ignoring.push(key);
		}
	}
	return { consulting, delegating, ignoring };
}

/**
 * READ-ONLY probes. `engine/spawn.ts` states the one legal degradation: a probe
 * may answer "unknown", but it may never claim an output exists. None of these
 * writes a file, and each names what its "unknown" costs.
 */
const READ_ONLY_PROBE: Record<string, string> = {
	'src/core/media/engine/ffmpeg.ts::probeFormat':
		'ffprobe -show_format, read-only: a killed probe yields unparseable JSON and the function answers null. Its consumers ask for a DATE or a duration and treat null as "unknown", which is the documented probe degradation',
	'src/core/media/engine/ffmpeg.ts::probeStreams':
		'ffprobe -show_streams, read-only and null on a failed probe — but null here is NOT "no streams" (a stream-less file still answers {"streams":[]}), so av_versions.probeAvSource REFUSES to guess from it rather than silently skipping the audio tier of an interview',
	'src/core/media/engine/pdf.ts::getPageCount':
		'pdfinfo page count, read-only: the Pages: line simply does not match and the function answers null, which callers already handle as "page count unknown"',
	'src/core/media/file_date.ts::pdfDate':
		'pdfinfo -rawdates CreationDate, read-only: PHP itself keyed on the output text here (get_media_file_date), and a missing date degrades to the file mtime. No file is produced',
	'src/core/media/file_date.ts::imageDate':
		'identify EXIF date read, read-only: an unreadable date degrades to the file mtime, the same answer PHP gives for an image with no EXIF at all. No file is produced',
};

/**
 * KNOWN-OPEN, shrink-only: runners that PRODUCE A FILE and still swallow a kill.
 * These are pre-existing B2-class defects this gate makes visible for the first
 * time; both are outside the workstream that added the gate and are handed off.
 * Fixing one MUST delete its entry.
 */
const SPAWN_OK_RATCHET: Record<string, string> = {
	'src/core/media/engine/svg.ts::rasterizeSvg':
		'KNOWN-OPEN (B2 class): branches on exitCode only, so a killed rsvg-convert (exitCode null, existsSync true) passes the existence check with a truncated PNG, which the thumb recipe then reduces into a served derivative. Needs assertSpawnOk before the existence check',
};

describe('media writer discipline: no runner ignores the spawn outcome', () => {
	test('every runner call site consults, delegates, or is a named read-only probe', () => {
		const { ignoring } = spawnOutcomeVerdicts();
		const violations = ignoring.filter(
			(key) => READ_ONLY_PROBE[key] === undefined && SPAWN_OK_RATCHET[key] === undefined,
		);
		expect(
			violations,
			`These declarations run an external media binary and never ask whether it SUCCEEDED. A command killed by a signal or a timeout did not succeed, and exitCode cannot tell you (bun resolves a signalled child as 128+n): call assertSpawnOk(result, context) from engine/spawn.ts, or return the SpawnResult to a caller that does. If it is a read-only probe, add it to READ_ONLY_PROBE with the reason its "unknown" answer is safe: ${violations.join(', ')}`,
		).toEqual([]);
	});

	test('the analysis really finds the compliant call sites too (positive control)', () => {
		// Without this the invariant above passes when the segmentation broke and no
		// call site was attributed to anything at all.
		const { consulting } = spawnOutcomeVerdicts();
		expect(consulting).toContain('src/core/media/engine/ffmpeg.ts::transcodeTwoPass');
		expect(consulting).toContain('src/core/media/engine/ffmpeg.ts::extractAudio');
		expect(consulting).toContain('src/core/media/engine/imagemagick.ts::runMagickTo');
		expect(consulting.length).toBeGreaterThan(5);
	});

	test('delegation is only honest when the delegate is itself a scanned runner', () => {
		// DELEGATES_OUTCOME is sound ONLY under the claim in its own docblock: "its
		// callers are bound by this same invariant, because the wrappers are
		// themselves in SPAWN_RUNNER". Nothing enforced that claim, and it was FALSE
		// for `runMagickTo` — it returns Promise<SpawnResult>, so it read as
		// delegating, but it is not a scanned runner, so its callers were never
		// judged and the delegation went nowhere. That is a hole shaped exactly like
		// the one this invariant exists to close: a declaration that never asks
		// whether the command succeeded, reported compliant.
		const { delegating } = spawnOutcomeVerdicts();
		const names: readonly string[] = SPAWN_RUNNER_NAMES;
		const deadEnds = delegating.filter((key) => !names.includes(key.split('::')[1] as string));
		expect(
			deadEnds,
			`These declarations hand a SpawnResult back instead of judging it, but nothing downstream is scanned, so the outcome is judged by nobody. Either consult it here (assertSpawnOk / !result.ok / result.signal !== null), or add the declaration to SPAWN_RUNNER_NAMES so its own call sites come under this invariant: ${deadEnds.join(', ')}`,
		).toEqual([]);
	});

	test('no declaration may excuse a kill (invariant 7b, no exemptions)', () => {
		// 7a can be satisfied by ANY accepted shape appearing somewhere in the
		// declaration, so on its own it cannot see a second branch that hands the
		// killed child back to the success path. This one can, and it is deliberately
		// a whole-tree scan rather than a per-declaration one: a helper that takes a
		// SpawnResult and answers "close enough" is the same defect one call deeper.
		const violations = scannedFiles().filter(
			(file) => file !== SPAWN_DEFINITION && KILL_EXCUSED.test(readCode(file)),
		);
		expect(
			violations,
			`A killed media command is being treated as survivable: this code negates the kill fact (!x.timedOut / !x.signal / x.signal === null), which can only move a SIGKILLed child towards a success path. That is audit 2026-08 B2 verbatim — the 10-minute cap became the excuse that skipped the failure branch and a partial, moov-less temp was renamed over the master derivative while the job reported 'done'. Branch on the kill so it FAILS (assertSpawnOk, !result.ok, result.signal !== null), never so it passes. There is no exemption list here, because there is no media operation for which "it was killed" is a reason to continue: ${violations.join(', ')}`,
		).toEqual([]);
	});

	test('CONSULTS_OUTCOME itself accepts only the truth-carrying shapes', () => {
		// PROBED ON THE REAL CONSTANTS. The 2026-08-09 hole was not the regex alone:
		// this test used to assert against a hand-narrowed copy, so the constant could
		// (and did) accept the very shape the assertion said was rejected. A self-test
		// that does not exercise the thing the gate runs on is not a self-test.
		for (const consulting of [
			'assertSpawnOk(result, `ffmpeg ${tier}`);',
			'const r = await runBinary(argv);\nif (!r.ok) throw new Error();',
			'if (result.ok) return result;',
			'const { ok, stdout } = await runIdentify(argv);\nif (!ok) return null;',
			'if (result.signal !== null) throw new Error("killed");',
		]) {
			expect(CONSULTS_OUTCOME.test(consulting), `CONSULTS_OUTCOME must accept: ${consulting}`).toBe(
				true,
			);
		}
		// Finding (b) as a unit: handling the TIMEOUT is not handling the KILL.
		// `timedOut` is `capExpired && signal !== null`, so this branch is blind to
		// every kill we did not order, and the four declarations that wore it were
		// reported compliant while leaving a truncated file for a caller to bless.
		const timeoutOnly = 'const r = await runIdentify(argv);\nif (r.timedOut) return null;';
		expect(
			CONSULTS_OUTCOME.test(timeoutOnly),
			'CONSULTS_OUTCOME accepts a timeout-only branch again — that is finding (b)',
		).toBe(false);
		// The exact defect, as a unit: this is what every ffmpeg runner looked like.
		const swallowing = 'const r = await runBinary(argv);\nif (r.exitCode !== 0) throw new Error();';
		expect(CONSULTS_OUTCOME.test(swallowing)).toBe(false);
		expect(DELEGATES_OUTCOME.test(swallowing)).toBe(false);
		// …and the B2 shape VERBATIM — the measured blocker — which ANDs the timeout
		// away. It must fail BOTH halves: it does not consult, and it excuses a kill.
		const b2 = 'if (r.exitCode !== 0 && !r.timedOut) throw new Error();';
		expect(CONSULTS_OUTCOME.test(b2), 'CONSULTS_OUTCOME accepts the B2 shape again').toBe(false);
		expect(KILL_EXCUSED.test(b2), 'KILL_EXCUSED no longer catches the B2 shape').toBe(true);
		// The same defect wearing `signal` instead of `timedOut`, and the `=== null`
		// spelling of both. All three are the identical excuse.
		for (const excuse of [
			'if (r.exitCode !== 0 && !r.signal) throw new Error();',
			'if (r.signal === null && r.exitCode !== 0) throw new Error();',
			'if (r.timedOut === false) publish(temp);',
		]) {
			expect(KILL_EXCUSED.test(excuse), `KILL_EXCUSED must catch: ${excuse}`).toBe(true);
		}
		// …and it does not fire on an AbortController signal (media/jobs.ts) or on
		// the kill used in the polarity that FAILS.
		for (const innocent of [
			'if (!controller.signal.aborted) this.finish(record, "done");',
			'if (result.signal !== null) throw new Error("killed");',
			'if (result.timedOut) return null;',
		]) {
			expect(KILL_EXCUSED.test(innocent), `KILL_EXCUSED false positive on: ${innocent}`).toBe(
				false,
			);
		}
	});

	test('every read-only-probe exemption and ratchet entry is named, reasoned and still true', () => {
		const { ignoring } = spawnOutcomeVerdicts();
		assertMapHonest('READ_ONLY_PROBE', READ_ONLY_PROBE, ignoring);
		assertMapHonest('SPAWN_OK_RATCHET', SPAWN_OK_RATCHET, ignoring);
	});
});

// ---------------------------------------------------------------------------
// Scan self-test — a gate over an empty file set passes vacuously
// ---------------------------------------------------------------------------

describe('media writer discipline: the scan itself', () => {
	test('the scan sees the media tree and both named single-owner files', () => {
		const files = scannedFiles();
		expect(files.length).toBeGreaterThan(20);
		expect(files).toContain(ATOMIC_WRITER);
		expect(files).toContain(MAGICK_ENGINE);
		expect(files).toContain(MAGICK_BINARIES);
		for (const file of SCAN_FILES) expect(files).toContain(file);
	});

	test('comment stripping removes prose but keeps code', () => {
		const stripped = stripComments(
			['// renameSync(x, y)', '/* .rot.${pid} */', 'const a = renameSync(t, p);'].join('\n'),
		);
		expect(stripped).not.toMatch(/\.rot\.\$\{/);
		expect(stripped.match(RENAME)).not.toBeNull();
		// One line of code, two lines of prose: the prose must be gone, not the code.
		expect(stripped.split('\n').filter((line) => RENAME.test(line)).length).toBe(1);
	});
});
