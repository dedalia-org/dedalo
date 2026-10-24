/**
 * MAGICK-POLICY TRIPWIRE (audit MEDIA-01, DEC-12: every stated invariant has a
 * mechanical gate).
 *
 * THE DEFECT THIS EXISTS TO REFUSE. The hardened `policy.xml` bounded WHAT
 * ImageMagick may parse (coders, delegates, `@`-indirection — MEDIA-02) and
 * nothing about HOW MUCH it may allocate, and the engine passed no `-limit`
 * anywhere: a repo-wide grep returned exactly one hit, a comment in `probe.ts`
 * NAMING the gap. A 40000x30000 solid-colour TIFF is a few MB on the wire, passes
 * the magic-byte sniff and the upload cap, and decodes to 14.4 GB RSS on the
 * AUTHENTICATED UPLOAD REQUEST PATH.
 *
 * THE INVARIANT HAS TWO HALVES AND BOTH ARE ASSERTED HERE:
 *
 *  1. THE SHIPPED POLICY declares a `domain="resource"` ceiling for each of the
 *     named resources — including `list-length`, the only one that bounds a
 *     HEADER read (`-ping` skips the pixels and still enumerates every scene:
 *     measured, a 4.6 MB GIF of 200000 1x1 frames cost the upload preview's own
 *     argv 26.3 s / 8.73 GB RSS with the other seven armed). It is the ceiling a process cannot raise above, and
 *     it is the ONLY half that reaches an ImageMagick this engine did not build —
 *     a delegate child, an operator's shell.
 *  2. EVERY ImageMagick SPAWN carries the install's operating limit as `-limit`
 *     argv (`magickResourceLimitArgs()`, from the DEDALO_MAGICK_LIMIT_* catalog
 *     keys). Census TOTAL over every `runBinary(` call site under
 *     `src/core/media/` — derived from the tree, never a hand list — with the
 *     non-ImageMagick binaries ENUMERATED, each carrying its reason.
 *  3. A DEPLOY ARTIFACT installs the same file at the system ImageMagick config
 *     path — UNCONDITIONALLY — so the ceiling is the container's law and not one
 *     caller's property. (An `if [ -d "$d" ]` guard made that install a silent
 *     no-op on any base image whose ImageMagick config path moved, with this gate
 *     and the build both green.)
 *  4. NO DELEGATE. The one process halves 1-2 could not reach was Ghostscript,
 *     forked BY ImageMagick to read a PDF: a delegate inherits neither the policy
 *     block nor the `-limit` argv, and it is not the process the request cap
 *     kills — measured, it reparents to PID 1 and runs on. So the policy DENIES
 *     the `gs` delegate, no ImageMagick recipe in this tree may ask for a PDF
 *     rasterization any more, and the PDF render is an ENGINE-OWNED gs spawn
 *     (`engine/ghostscript.ts`) that refuses an oversized page before it renders.
 *
 *  5. HOW MANY may run at once. Every converter spawn — `runIdentify` included,
 *     with no `-ping` exemption: that exemption was refuted by the scene
 *     measurement above — takes a permit from the process-wide pool, or is
 *     ENUMERATED with a reason. And no identify call site takes a SECOND one:
 *     a permit held while waiting for a permit deadlocks at concurrency 1.
 *
 *  6. A TEST'S OWN SPAWN carries the shipped policy too. A fixture built with a
 *     bare `magick` runs under the HOST's policy.xml (Debian's in the CI image,
 *     which deliberately does not install ours system-wide — ci/Dockerfile), so
 *     one test measured two ImageMagicks. Census over test/ and src/ (the
 *     registered listers): every spawn whose argv resolves ImageMagick (directly or
 *     through a bound name) names MAGICK_CONFIGURE_PATH, `magickPolicyEnv()` or
 *     `magickTestEnv()` (test/helpers/magick_test_env.ts).
 *
 * WHAT THIS GATE CANNOT SEE, stated rather than hidden: this is SHAPE, not effect.
 * That an oversized image is refused rather than converted is
 * `magick_resource_limits_native.test.ts`; that the pool really bounds, that a
 * 200000-scene source is really refused in milliseconds through the real
 * `probeImageSource`, and that the shipped policy really ARMS inside a real
 * ImageMagick (a comment can disarm it invisibly — see the comment leg) are
 * `media_admission_native.test.ts`; that an oversized PDF PAGE is refused
 * with nothing rendered and no surviving child is `pdf_rasterizer_native.test.ts`.
 * Neither this nor those bound the HOST's share of a legitimate large conversion —
 * that is a cgroup, i.e. an ops decision (OPS-12).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { CONFIG_CATALOG } from '../../src/config/catalog/index.ts';
import { magickResourceLimitArgs } from '../../src/core/media/engine/binaries.ts';
import {
	apiHandlerFiles,
	engineSourceFilesRelative,
	MEDIA_DIR,
	mediaSourceFiles,
} from '../helpers/engine_source_corpus.ts';
import { escapeRegExp } from '../helpers/regex_escape.ts';
import { testTreeSourceFiles } from '../helpers/test_tree_corpus.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');

const POLICY_PATH = join(MEDIA_DIR, 'engine', 'imagemagick-policy', 'policy.xml');
const DOCKERFILE = join(REPO_ROOT, 'Dockerfile');

/** The resources the bound is made of. Every leg below is keyed on THIS list. */
const RESOURCES: readonly string[] = [
	'memory',
	'map',
	'area',
	'disk',
	'width',
	'height',
	'time',
	// The SEQUENCE ceiling, and the only one that bounds a HEADER read: `-ping`
	// skips pixels but still enumerates every scene, so a 4.6 MB GIF of 200000 1x1
	// frames cost the upload preview's argv 26.3 s / 8.73 GB RSS with all seven
	// above armed (measured 2026-09-05). A scene struct is not the pixel cache.
	'list-length',
];

/** The catalog key an install raises a resource with (`list-length` → LIST_LENGTH). */
function limitKey(resource: string): string {
	return `DEDALO_MAGICK_LIMIT_${resource.toUpperCase().replace(/-/g, '_')}`;
}

// --- the census -------------------------------------------------------------

interface SpawnSite {
	/** `<path relative to src/core/media>:<enclosing function>` — the census key. */
	readonly key: string;
	/** The whole balanced call expression, `runBinary(` … `)`. */
	readonly call: string;
	/** True when the argv this call spawns is an ImageMagick one. */
	readonly imagemagick: boolean;
}

/**
 * Blank out comments, KEEPING every byte offset. A doc comment that mentions
 * `runBinary(` is prose, not a spawn — and `engine/ffmpeg.ts` has one that says so
 * in words. Without this the census counts a sentence as a converter.
 */
function stripComments(code: string): string {
	return code
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/(^|[^:])\/\/[^\n]*/g, (m, lead: string) => lead + ' '.repeat(m.length - lead.length));
}

/** Read a balanced parenthesised expression starting at the '(' index. */
function balancedCall(code: string, openIndex: number): string {
	let depth = 0;
	for (let i = openIndex; i < code.length; i++) {
		const ch = code[i];
		if (ch === '(') depth++;
		else if (ch === ')') {
			depth--;
			if (depth === 0) return code.slice(openIndex, i + 1);
		}
	}
	return code.slice(openIndex);
}

/** The nearest function declaration above `index`, or '<top level>'. */
function enclosingFunction(code: string, index: number): string {
	const head = code.slice(0, index);
	const matches = [...head.matchAll(/(?:^|\n)(?:export )?(?:async )?function (\w+)/g)];
	const last = matches.at(-1);
	return last === undefined ? '<top level>' : (last[1] as string);
}

/**
 * Every `runBinary(` CALL (never its declaration) under a tree, classified.
 *
 * A site is an ImageMagick one when its FILE resolves an ImageMagick binary
 * (`resolveMagick()` / `resolveIdentify()`). File-level is the right grain and not
 * a shortcut: `media_writer_discipline_tripwire` invariant 3 already refuses any
 * file that both resolves an ImageMagick binary and spawns, other than the two
 * runners — so "this file resolves magick" and "this spawn is a magick spawn" are
 * the same statement, and the argv a runner receives is built by its own file's
 * `build*Argv`. It is an OUTCOME test, not a spelling: renaming a runner moves no
 * site out of the class, and a NEW file that starts resolving magick and spawning
 * lands in the class automatically.
 */
function spawnSites(files: readonly { path: string; code: string }[]): SpawnSite[] {
	const sites: SpawnSite[] = [];
	for (const { path, code: raw } of files) {
		const code = stripComments(raw);
		for (const match of code.matchAll(/\brunBinary\s*\(/g)) {
			const openIndex = (match.index as number) + match[0].length - 1;
			// The DECLARATION of runBinary itself is not a call site.
			const before = code.slice(Math.max(0, (match.index as number) - 30), match.index);
			if (/function\s+$/.test(before)) continue;
			const call = balancedCall(code, openIndex);
			const fn = enclosingFunction(code, match.index as number);
			sites.push({
				key: `${path}:${fn}`,
				call,
				imagemagick: /\bresolveIdentify\s*\(|\bresolveMagick\s*\(/.test(code),
			});
		}
	}
	return sites;
}

/**
 * The spawn sites that are NOT ImageMagick, each with the reason it needs no
 * `-limit`. SHRINK-ONLY: a new entry means a new unbounded converter and must be
 * argued in review, not appended. Keys are `<file>:<function>`.
 */
const NON_IMAGEMAGICK_SPAWNS: Record<string, string> = {
	'file_date.ts:pdfDate':
		'pdfinfo — a metadata read of the PDF trailer; poppler decodes no page, and the argv carries no image',
	'tools/fragment.ts:runFfmpeg':
		'ffmpeg — bounded by the spawn layer instead: a producer runs under the idle-timeout policy, and the AV lane of media/jobs.ts caps how many run at once',
	'engine/svg.ts:rasterizeSvg':
		'rsvg-convert — librsvg, a dedicated SVG renderer with no coder dispatch; its raster size is the DEDALO_SVG_THUMB_DPI the engine chooses, not one the file declares',
	'engine/pdf.ts:extractText': 'pdftotext — text extraction, no rasterization and no pixel cache',
	'engine/pdf.ts:getPageCount': 'pdfinfo — a metadata read, no rasterization and no pixel cache',
	'engine/pdf.ts:readPdfPageSize':
		'pdfinfo -f N -l N — the PAGE BOX read the PDF rasterizer refuses on; poppler parses a header and rasterizes nothing, which is why the measurement can be trusted to be cheap',
	'engine/ghostscript.ts:rasterizePdfPage':
		'gs — Ghostscript, spawned BY THE ENGINE (never as an ImageMagick delegate). Its bound is not `-limit`, which is ImageMagick argv: it is the pre-render refusal of a page above DEDALO_MAGICK_LIMIT_WIDTH/_HEIGHT plus the spawn cap, and the process that cap kills is the one doing the work',
	'engine/ffmpeg.ts:runProducer':
		'ffmpeg — the AV producer runner; see tools/fragment.ts for why the idle-timeout policy and the AV job lane are its bound',
	'engine/ffmpeg.ts:probeFormat': 'ffprobe — a container/stream header read, it decodes no frame',
	'engine/ffmpeg.ts:probeStreams': 'ffprobe — a container/stream header read, it decodes no frame',
	'engine/ffmpeg.ts:probeAudioCodec':
		'ffmpeg -encoders — the encoder-capability probe of the binary itself; it opens no file at all',
};

// --- half 1: the shipped policy ---------------------------------------------

describe('magick policy: the shipped policy declares a resource ceiling', () => {
	const policy = readFileSync(POLICY_PATH, 'utf8');

	test('the policy is a real, populated file (a scan over nothing asserts nothing)', () => {
		expect(policy.length).toBeGreaterThan(1000);
		expect([...policy.matchAll(/<policy\s/g)].length).toBeGreaterThan(20);
	});

	test.each([...RESOURCES])(
		'policy declares domain="resource" name="%s" with a value',
		(name: string) => {
			const declared = new RegExp(
				`<policy\\s+domain="resource"\\s+name="${name}"\\s+value="[^"]+"`,
			).test(policy);
			expect(
				declared,
				`the shipped policy.xml declares no domain="resource" ceiling for '${name}' — the coder denials bound WHAT ImageMagick parses, this block is the only thing that bounds how much it allocates`,
			).toBe(true);
		},
	);

	test('no comment inside <policymap> spans more than one line, or holds a backtick', () => {
		// TWO MEASURED WAYS this file silently disarms itself, both found by writing
		// one and reading the ceiling back out of the binary:
		//  - a MULTI-LINE XML comment inside <policymap> makes ImageMagick's parser
		//    drop every policy AFTER it (`magick -list policy` showed zero resource
		//    rows and a raised `-limit width` was honoured);
		//  - a single BACKTICK inside a one-line comment there does the same thing
		//    (2026-09-05: the `list-length` row read back as `unlimited`, and moving
		//    the same row above the comment armed it).
		// The file parses as valid XML in both cases, so nothing else would notice.
		// The EFFECT twin — asking the binary what it loaded, which catches the next
		// unknown spelling too — is media_admission_native.
		const inner = policy.slice(policy.indexOf('<policymap>'));
		const comments = [...inner.matchAll(/<!--[\s\S]*?-->/g)].map((m) => m[0]);
		expect(
			comments.filter((c) => c.includes('\n')),
			'a multi-line comment inside <policymap> makes ImageMagick discard every policy that follows it — keep them on one line',
		).toEqual([]);
		expect(
			comments.filter((c) => c.includes('`')),
			'a backtick inside a <policymap> comment makes ImageMagick discard every policy that follows it (measured) — write the name without one',
		).toEqual([]);
		// Floor: the element does hold comments, so the scan is not over nothing.
		expect(comments.length).toBeGreaterThan(2);
	});

	test('POSITIVE CONTROL: both disarming comment shapes are caught by that reader', () => {
		for (const offender of ['<!-- one\nline -->', '<!-- a `backtick` -->']) {
			expect(offender.includes('\n') || offender.includes('`')).toBe(true);
		}
		expect('<!-- plain prose -->'.includes('\n') || '<!-- plain prose -->'.includes('`')).toBe(
			false,
		);
	});

	test('POSITIVE CONTROL: the same reader catches a policy missing one resource', () => {
		const offender = policy.replace(/<policy\s+domain="resource"\s+name="width"[^/]*\/>/, '');
		expect(offender).not.toBe(policy);
		expect(/<policy\s+domain="resource"\s+name="width"\s+value="[^"]+"/.test(offender)).toBe(false);
	});
});

// --- half 2: every ImageMagick spawn carries the operating limit -------------

describe('magick policy: every ImageMagick spawn carries the -limit argv', () => {
	const files = mediaSourceFiles().map((path) => ({
		path: relative(MEDIA_DIR, path),
		code: readFileSync(path, 'utf8'),
	}));
	const sites = spawnSites(files);

	test('the census is populated (TOTAL over src/core/media, derived from the tree)', () => {
		expect(files.length).toBeGreaterThan(20);
		expect(sites.length).toBeGreaterThan(8);
	});

	test('at least two spawn sites are ImageMagick ones', () => {
		// The engine has exactly two (runIdentify, runMagickTo) and
		// media_writer_discipline_tripwire pins that count. A classifier that found
		// none would make the next assertion vacuously green.
		const im = sites.filter((s) => s.imagemagick);
		expect(im.length).toBeGreaterThanOrEqual(2);
	});

	test('every ImageMagick spawn site splices magickResourceLimitArgs()', () => {
		const unbounded = sites
			.filter((s) => s.imagemagick && !/magickResourceLimitArgs\s*\(/.test(s.call))
			.map((s) => s.key);
		expect(
			unbounded,
			`these ImageMagick spawns run with no resource bound — a crafted image decodes to whatever it declares, on the upload request path: ${unbounded.join(', ')}`,
		).toEqual([]);
	});

	test('every NON-ImageMagick spawn site is enumerated with a reason (census TOTAL)', () => {
		const unclassified = sites
			.filter((s) => !s.imagemagick && NON_IMAGEMAGICK_SPAWNS[s.key] === undefined)
			.map((s) => s.key);
		expect(
			unclassified,
			`new converter spawn sites with neither a resource bound nor a stated reason: ${unclassified.join(', ')}`,
		).toEqual([]);
		for (const [key, reason] of Object.entries(NON_IMAGEMAGICK_SPAWNS)) {
			expect(reason.length, `exemption ${key} carries no reason`).toBeGreaterThan(30);
		}
	});

	test('an ImageMagick site may never be excused by the exemption list', () => {
		const excused = sites
			.filter((s) => s.imagemagick && NON_IMAGEMAGICK_SPAWNS[s.key] !== undefined)
			.map((s) => s.key);
		expect(excused).toEqual([]);
	});

	test('POSITIVE CONTROL: a planted unbounded ImageMagick spawn is flagged', () => {
		const planted = spawnSites([
			{
				path: 'engine/planted.ts',
				code: 'export async function runPlanted(args: string[]) {\n\treturn runBinary([...resolveMagick(), ...args], { env: magickPolicyEnv() });\n}\n',
			},
		]);
		expect(planted.length).toBe(1);
		expect((planted[0] as SpawnSite).imagemagick).toBe(true);
		expect(/magickResourceLimitArgs\s*\(/.test((planted[0] as SpawnSite).call)).toBe(false);
		expect(NON_IMAGEMAGICK_SPAWNS['engine/planted.ts:runPlanted']).toBeUndefined();
	});
});

// --- the TESTS' own ImageMagick spawns -----------------------------------------

/**
 * Blank out string literals ('…' and "…", single line), KEEPING byte offsets. The
 * planted controls in this very file are code held in strings; a spawn inside a
 * string is a fixture of a census, not a spawn. Template literals are kept: their
 * `${…}` holes are code.
 */
function stripStrings(code: string): string {
	return code.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, (m) => ' '.repeat(m.length));
}

/** A balanced expression from the bracket at `openIndex` — (), [] and {} all nest. */
function balancedExpression(code: string, openIndex: number): string {
	let depth = 0;
	for (let i = openIndex; i < code.length; i++) {
		const ch = code[i] as string;
		if ('([{'.includes(ch)) depth++;
		else if (')]}'.includes(ch)) {
			depth--;
			if (depth === 0) return code.slice(openIndex, i + 1);
		}
	}
	return code.slice(openIndex);
}

/** Where an ImageMagick argv comes from: the resolvers, or an engine recipe builder. */
const MAGICK_ARGV_SOURCE = /\bresolveMagick\s*\(|\bresolveIdentify\s*\(|\bbuild\w*Argv\s*\(/;
/** What makes a spawn POLICED: the policy key itself, or a door that sets it. */
const POLICED_ENV = /\bMAGICK_CONFIGURE_PATH\b|\bmagickPolicyEnv\s*\(|\bmagickTestEnv\s*\(/;
/** Every way a test starts a child process. */
const TEST_SPAWN =
	/\b(?:runBinary|Bun\.spawnSync|Bun\.spawn|spawnSync|execFileSync|execFile|spawn)\s*\(/g;

/**
 * Names a file binds (`const|let NAME … = <rhs>`) whose right-hand side mentions
 * `source` — or a name already bound that way (three passes: an alias of an
 * alias). This is what lets `const MAGICK = resolveMagick()` …
 * `Bun.spawn([MAGICK, …])` and `const argv = cond ? [resolveMagick(), …] : …` …
 * `runBinary(argv, …)` be classified by what they spawn, not by how it is spelled.
 */
function boundNames(code: string, source: RegExp): string[] {
	const names = new Set<string>();
	const mentions = (text: string): boolean =>
		source.test(text) || [...names].some((n) => new RegExp(`\\b${n}\\b`).test(text));
	for (let pass = 0; pass < 3; pass++) {
		for (const m of code.matchAll(/\b(?:const|let|var)\s+(\w+)\b[^=;\n]*=(?!=)\s*/g)) {
			const start = (m.index as number) + m[0].length;
			let depth = 0;
			let end = start;
			for (; end < code.length; end++) {
				const ch = code[end] as string;
				if ('([{'.includes(ch)) depth++;
				else if (')]}'.includes(ch)) {
					if (depth === 0) break;
					depth--;
				} else if (depth === 0 && ch === ';') break;
			}
			if (mentions(code.slice(start, end))) names.add(m[1] as string);
		}
	}
	return [...names];
}

interface TestSpawnSite {
	/** `<repo-relative file>:<line>`. */
	readonly key: string;
	readonly call: string;
	readonly imagemagick: boolean;
	readonly policed: boolean;
}

/**
 * Every child-process start in a test-side file, classified: does it spawn
 * ImageMagick, and does it carry the shipped policy? The engine half of this
 * rule is media_writer_discipline_tripwire (runMagickTo / runIdentify pass
 * magickPolicyEnv); this is the half the engine census cannot see.
 */
function testSpawnSites(files: readonly { path: string; code: string }[]): TestSpawnSite[] {
	const sites: TestSpawnSite[] = [];
	for (const { path, code: raw } of files) {
		const code = stripStrings(stripComments(raw));
		const magickNames = boundNames(code, MAGICK_ARGV_SOURCE);
		const policyNames = boundNames(code, POLICED_ENV);
		const named = (names: string[], text: string): boolean =>
			names.some((n) => new RegExp(`\\b${n}\\b`).test(text));
		for (const match of code.matchAll(TEST_SPAWN)) {
			const at = match.index as number;
			if (/function\s+$/.test(code.slice(Math.max(0, at - 30), at))) continue;
			const call = balancedExpression(code, at + match[0].length - 1);
			sites.push({
				key: `${path}:${code.slice(0, at).split('\n').length}`,
				call,
				imagemagick: MAGICK_ARGV_SOURCE.test(call) || named(magickNames, call),
				policed: POLICED_ENV.test(call) || named(policyNames, call),
			});
		}
	}
	return sites;
}

/**
 * The trees scanned: every source under test/ (the registered test-tree lister)
 * and every engine source under src/ (the registered engine lister — it holds
 * src/core/test_data/, where situation builders live) EXCEPT src/core/media/:
 * the engine's runners are policed by the census above and by
 * media_writer_discipline_tripwire, and there the `build*Argv` builders also
 * name ffmpeg/gs/pdf argv, so this file-blind classifier would misread them.
 * scripts/ resolves no ImageMagick binary today and has no registered lister; a
 * script that starts to would be outside this census — stated, not hidden.
 */
function testSideFiles(): { path: string; code: string }[] {
	const engine = engineSourceFilesRelative().filter((path) => !path.startsWith('src/core/media/'));
	return [...testTreeSourceFiles(), ...engine].map((path) => ({
		path,
		code: readFileSync(join(REPO_ROOT, path), 'utf8'),
	}));
}

describe("magick policy: a TEST's own ImageMagick spawn carries the shipped policy", () => {
	// A fixture built with a bare `magick` runs under the HOST's policy.xml (Debian's
	// in the CI image, Homebrew's on a Mac): one test, two ImageMagicks, and a red that
	// is a fact about a package. The CI image does not install the shipped policy
	// system-wide BY DESIGN (ci/Dockerfile) — the engine's spawns carry it — so a test
	// spawn carries it too (test/helpers/magick_test_env.ts). A deliberate unpoliced
	// CONTROL still names the key (pointing it elsewhere), and so still passes.
	const sites = testSpawnSites(testSideFiles());
	const magick = sites.filter((s) => s.imagemagick);

	test('the census is populated (derived from test/ and src/)', () => {
		expect(sites.length).toBeGreaterThan(50);
		// Measured 2026-10-02: 38 ImageMagick spawns across 16 files.
		expect(magick.length).toBeGreaterThanOrEqual(30);
	});

	test('every ImageMagick spawn under test/ carries MAGICK_CONFIGURE_PATH', () => {
		const bare = magick.filter((s) => !s.policed).map((s) => s.key);
		expect(
			bare,
			`these test spawns run ImageMagick under the HOST's policy, not the shipped one — pass env: magickTestEnv() (test/helpers/magick_test_env.ts): ${bare.join(', ')}`,
		).toEqual([]);
	});

	test('POSITIVE CONTROL: bare spawns are flagged, directly and through an alias', () => {
		const planted = testSpawnSites([
			{
				path: 'test/unit/planted.test.ts',
				code: [
					'const MAGICK = resolveMagick();',
					'const argv = ok ? [MAGICK, x] : [ffmpeg, y];',
					"await runBinary([resolveMagick(), '-size', '1x1', 'xc:red', out], { nice: false });",
					'await Bun.spawn([MAGICK, out]).exited;',
					'await runBinary(argv, { nice: false });',
					'await runBinary(argv, { nice: false, env: magickTestEnv() });',
					"await runBinary([ffmpeg, '-i', x], { nice: false });",
				].join('\n'),
			},
		]);
		expect(planted.map((s) => [s.imagemagick, s.policed])).toEqual([
			[true, false],
			[true, false],
			[true, false],
			[true, true],
			[false, false],
		]);
	});
});

// --- the argv the bound is actually made of ---------------------------------

describe('magick policy: the operating limit is configuration, not a constant', () => {
	test('magickResourceLimitArgs() emits every named resource as a -limit triple', () => {
		const argv = magickResourceLimitArgs();
		expect(argv.length).toBe(RESOURCES.length * 3);
		for (const name of RESOURCES) {
			const at = argv.indexOf(name);
			expect(at, `magickResourceLimitArgs() emits no '${name}' limit`).toBeGreaterThan(0);
			expect(argv[at - 1]).toBe('-limit');
			expect(
				(argv[at + 1] as string).length,
				`the '${name}' limit has an empty value`,
			).toBeGreaterThan(0);
		}
	});

	test.each([...RESOURCES])(
		'the %s limit is a catalog key an install can raise',
		(name: string) => {
			const key = limitKey(name);
			const entry = CONFIG_CATALOG[key];
			expect(
				entry,
				`${key} is not in the config catalog — a hard-coded ceiling silently refuses a legitimate large-format heritage master`,
			).toBeDefined();
			expect((entry as { scope: string }).scope).toBe('operator');
		},
	);
});

// --- half 3: the deploy artifact --------------------------------------------

describe('magick policy: a deploy artifact installs it system-wide', () => {
	const dockerfile = readFileSync(DOCKERFILE, 'utf8');

	test('the Dockerfile is a real, populated file', () => {
		expect(dockerfile.length).toBeGreaterThan(2000);
	});

	test('the Dockerfile copies the SHIPPED policy to an ImageMagick config path', () => {
		expect(
			dockerfile.includes('src/core/media/engine/imagemagick-policy/policy.xml'),
			'no deploy artifact references the shipped policy — MAGICK_CONFIGURE_PATH binds only the spawns this engine builds, never a maintenance `convert`',
		).toBe(true);
		expect(/\/etc\/ImageMagick-\d/.test(dockerfile)).toBe(true);
	});

	test('the policy install is UNCONDITIONAL — the config dir is created, not tested for', () => {
		// The install used to sit inside `if [ -d "$d" ]`, so on a base image whose
		// ImageMagick config path moved the whole system-wide half silently did
		// nothing: the build was green, this gate (which reads TEXT) was green, and
		// the container ran under the distribution's permissive policy. A gate that
		// only checks the copy exists cannot see that; this one checks it is reachable.
		const install = dockerfile.slice(
			dockerfile.indexOf('for d in /etc/ImageMagick-6'),
			dockerfile.indexOf('for d in /etc/ImageMagick-6') + 400,
		);
		expect(install.length).toBeGreaterThan(50);
		expect(
			/if\s*\[\s*-d\s*"\$d"\s*\]/.test(install),
			'the policy copy is guarded by a directory test — on a base image whose ImageMagick config path moved this becomes a silent no-op; create the directory instead (`install -d "$d"`)',
		).toBe(false);
		expect(install).toMatch(/install\s+-d\s+"\$d"/);
	});

	test('the deploy artifact installs Ghostscript itself', () => {
		// --no-install-recommends drops imagemagick's recommended ghostscript, and the
		// engine now spawns gs DIRECTLY (it is no longer reached as a delegate), so an
		// image without it builds no PDF cover at all.
		expect(
			/\bghostscript\b/.test(dockerfile),
			'the image installs no ghostscript — the PDF rasterizer (engine/ghostscript.ts, DEDALO_GS_PATH) has no binary to run',
		).toBe(true);
	});
});

// --- half 4: no delegate — the engine owns the PDF render --------------------

/**
 * The delegate patterns the policy must deny. `gs` is the ImageMagick delegate
 * that reads PDF; the `ps:*` trio is the same interpreter reached under the
 * PostScript delegate names.
 */
const DENIED_DELEGATES: readonly string[] = ['gs', 'ps:alpha', 'ps:cmyk', 'ps:color'];

/** The ONE module allowed to resolve and spawn Ghostscript. */
const GHOSTSCRIPT_MODULE = 'engine/ghostscript.ts';

describe('magick policy: ImageMagick may not fork Ghostscript', () => {
	const policy = readFileSync(POLICY_PATH, 'utf8');

	test.each([...DENIED_DELEGATES])('policy denies the %s delegate', (pattern: string) => {
		const denied = new RegExp(
			`<policy\\s+domain="delegate"\\s+rights="none"\\s+pattern="${escapeRegExp(pattern)}"`,
		).test(policy);
		expect(
			denied,
			`the shipped policy.xml still allows the '${pattern}' delegate — a delegate child inherits neither the domain="resource" ceiling nor the -limit argv, and the request cap kills the ImageMagick process, not it (measured: the gs child reparented to PID 1 and kept growing a temp file)`,
		).toBe(true);
	});

	test('POSITIVE CONTROL: the same reader catches a policy that allows gs again', () => {
		const offender = policy.replace(
			/<policy\s+domain="delegate"\s+rights="none"\s+pattern="gs"\s*\/>/,
			'',
		);
		expect(offender).not.toBe(policy);
		expect(
			/<policy\s+domain="delegate"\s+rights="none"\s+pattern="gs"/.test(offender),
			'the control did not actually remove the gs denial',
		).toBe(false);
	});

	test('no ImageMagick recipe in this tree asks for a PDF rasterization', () => {
		// The `-density N -antialias -define pdf:use-cropbox=true` prefix is exactly
		// the request that made ImageMagick fork gs. It is gone from buildConvertArgv,
		// and it may not come back anywhere under src/core/media: the raster the
		// recipes see is the PNG engine/ghostscript.ts produced.
		const files = mediaSourceFiles().map((path) => ({
			path: relative(MEDIA_DIR, path),
			code: stripComments(readFileSync(path, 'utf8')),
		}));
		expect(files.length, 'the census scanned nothing').toBeGreaterThan(20);
		const offenders = files
			.filter(({ code }) => /pdf:use-cropbox|pdfDensity/.test(code))
			.map(({ path }) => path);
		expect(
			offenders,
			`these modules ask ImageMagick to rasterize a PDF, which it can only do by forking Ghostscript as an unbounded delegate — render the page with engine/ghostscript.ts and hand ImageMagick the raster: ${offenders.join(', ')}`,
		).toEqual([]);
	});

	test('POSITIVE CONTROL: the pdf-recipe scan catches the shape that shipped', () => {
		const planted = stripComments(
			"const argv = [resolveMagick(), '-density', String(options.pdfDensity), '-define', 'pdf:use-cropbox=true'];\n",
		);
		expect(/pdf:use-cropbox|pdfDensity/.test(planted)).toBe(true);
	});

	test('exactly one module resolves Ghostscript, and it is the rasterizer', () => {
		const resolvers = mediaSourceFiles()
			.map((path) => ({
				path: relative(MEDIA_DIR, path),
				code: stripComments(readFileSync(path, 'utf8')),
			}))
			.filter(({ code }) => /binaries\.ghostscript\b/.test(code))
			.map(({ path }) => path);
		expect(
			resolvers,
			'Ghostscript must be reached from exactly one module — the one that reads the page box first and refuses an oversized page before rendering',
		).toEqual([GHOSTSCRIPT_MODULE]);
	});

	test('the rasterizer refuses on the configured ceiling and runs under a cap', () => {
		const code = stripComments(readFileSync(join(MEDIA_DIR, 'engine', 'ghostscript.ts'), 'utf8'));
		expect(code.length).toBeGreaterThan(500);
		// The refusal is read off the SAME configured ceiling ImageMagick gets, and
		// the render carries a total cap — without either, an engine-owned gs is just
		// the delegate with a different parent.
		expect(
			/limits\.width|magickLimits/.test(code),
			'the PDF rasterizer does not compare the page against DEDALO_MAGICK_LIMIT_WIDTH/_HEIGHT',
		).toBe(true);
		expect(
			/timeoutMs\s*:/.test(code),
			'the PDF rasterizer spawns Ghostscript with no cap — the whole point of owning the spawn is that the process the cap kills is the one doing the work',
		).toBe(true);
		expect(
			/assertSpawnOk\s*\(/.test(code),
			'the PDF rasterizer does not consult the spawn outcome (B2: a killed gs leaves a truncated PNG that existsSync blesses)',
		).toBe(true);
	});
});

// --- half 5: K conversions, not one — admission + where the spill lands -------

/**
 * The spawn sites that take NO converter permit, each with the reason. SHRINK-ONLY:
 * a new entry is a new unbounded-in-NUMBER converter and must be argued in review.
 * Keys are `<file>:<function>`, the same census keys as NON_IMAGEMAGICK_SPAWNS.
 */
const NO_PERMIT_SPAWNS: Record<string, string> = {
	'file_date.ts:pdfDate': 'pdfinfo — a metadata read of the PDF trailer; decodes nothing',
	'engine/pdf.ts:extractText': 'pdftotext — text extraction, no rasterization',
	'engine/pdf.ts:getPageCount': 'pdfinfo — a metadata read, no rasterization',
	'engine/pdf.ts:readPdfPageSize':
		'pdfinfo -f N -l N — the page-box header read the rasterizer refuses on; it must stay cheap and ungated or the refusal itself would queue behind the renders it exists to prevent',
	'engine/ffmpeg.ts:probeFormat': 'ffprobe — a container/stream header read, it decodes no frame',
	'engine/ffmpeg.ts:probeStreams': 'ffprobe — a container/stream header read, it decodes no frame',
	'engine/ffmpeg.ts:probeAudioCodec':
		'ffmpeg -encoders — the encoder-capability probe of the binary itself; it opens no file at all',
};

/** The doors that MUST hold a permit — named so the exemption list can never grow to cover them. */
const PERMITTED_DOORS: readonly string[] = [
	'engine/imagemagick.ts:runMagickTo',
	// The identify RUNNER. It used to be exempt, on the ground that `-ping` costs
	// ~12 ms and a header read must not queue behind a transcode. REFUTED by
	// measurement (see RESOURCES above): `-ping` is O(scene count), the exempted
	// door was reachable from the authenticated upload, and four concurrent probes
	// were four concurrent identify processes. The latency worry is answered by
	// COST — `-limit list-length` makes a header read cheap for every input — not
	// by an exemption, so the permit is unconditional here.
	'engine/binaries.ts:runIdentify',
	'engine/ghostscript.ts:rasterizePdfPage',
	'engine/svg.ts:rasterizeSvg',
];

/**
 * The doors that MUST hold an AV permit. ffmpeg is the heaviest converter this
 * engine spawns and the two AV API actions await it INLINE on the request, in no
 * job lane — see AV_DOORS' own leg.
 */
const AV_DOORS: readonly string[] = [
	// The producer runner: posterframe, faststart, conform, audio extraction and
	// the two-pass transcode all funnel through it. `create_posterframe` reaches
	// it from an API handler with no job in sight.
	'engine/ffmpeg.ts:runProducer',
	// The fragment cutter. `download_fragment` is a level-1 READ action awaited
	// inline whose client waits an hour by contract, and with `watermark:true` it
	// runs a second full re-encode.
	'tools/fragment.ts:runFfmpeg',
];

/**
 * Byte ranges of every permit call in a file (comments already blanked). `which`
 * selects the pool: a door must hold the permit of ITS OWN pool, so asserting
 * "some permit" would let an ffmpeg be admitted by the image pool (which would
 * make every thumbnail queue behind a transcode) and pass.
 */
function slotRanges(
	code: string,
	which: 'any' | 'converter' | 'av' = 'any',
): { start: number; end: number }[] {
	const pattern =
		which === 'converter'
			? /\bwithConverterSlot\s*\(/g
			: which === 'av'
				? /\bwithAvSlot\s*\(/g
				: /\b(?:withConverterSlot|withAvSlot)\s*\(/g;
	const ranges: { start: number; end: number }[] = [];
	for (const match of code.matchAll(pattern)) {
		const openIndex = (match.index as number) + match[0].length - 1;
		const call = balancedCall(code, openIndex);
		ranges.push({ start: openIndex, end: openIndex + call.length });
	}
	return ranges;
}

describe('magick policy: how MANY conversions may run at once', () => {
	const files = mediaSourceFiles().map((path) => ({
		path: relative(MEDIA_DIR, path),
		code: stripComments(readFileSync(path, 'utf8')),
	}));

	/** Every runBinary( call site, with WHICH pool's permit (if any) it sits inside. */
	function admissionSites(): { key: string; permitted: boolean; pool: string | null }[] {
		const out: { key: string; permitted: boolean; pool: string | null }[] = [];
		for (const { path, code } of files) {
			const converter = slotRanges(code, 'converter');
			const av = slotRanges(code, 'av');
			for (const match of code.matchAll(/\brunBinary\s*\(/g)) {
				const at = match.index as number;
				const before = code.slice(Math.max(0, at - 30), at);
				if (/function\s+$/.test(before)) continue;
				const inside = (r: { start: number; end: number }): boolean => at > r.start && at < r.end;
				const pool = converter.some(inside) ? 'converter' : av.some(inside) ? 'av' : null;
				out.push({
					key: `${path}:${enclosingFunction(code, at)}`,
					permitted: pool !== null,
					pool,
				});
			}
		}
		return out;
	}

	test('the census is populated (TOTAL over src/core/media, derived from the tree)', () => {
		expect(files.length).toBeGreaterThan(20);
		expect(admissionSites().length).toBeGreaterThan(8);
		expect(admissionSites().filter((s) => s.pool === 'converter').length).toBeGreaterThanOrEqual(3);
		expect(admissionSites().filter((s) => s.pool === 'av').length).toBeGreaterThanOrEqual(2);
	});

	test('every converter spawn either takes a permit or is enumerated with a reason', () => {
		const unclassified = admissionSites()
			.filter((s) => !s.permitted && NO_PERMIT_SPAWNS[s.key] === undefined)
			.map((s) => s.key);
		expect(
			unclassified,
			`these spawns run with no admission control — the per-process resource bound multiplied by K concurrent uploads is not a bound (measured: 2 uploads = 16 GiB of real disk): ${unclassified.join(', ')}`,
		).toEqual([]);
		for (const [key, reason] of Object.entries(NO_PERMIT_SPAWNS)) {
			expect(reason.length, `exemption ${key} carries no reason`).toBeGreaterThan(30);
		}
	});

	test.each([...PERMITTED_DOORS])('%s holds a converter permit around its spawn', (key: string) => {
		const site = admissionSites().find((s) => s.key === key);
		expect(site, `${key} is not a spawn site any more — the census key moved`).toBeDefined();
		expect(
			(site as { pool: string | null }).pool,
			`${key} spawns a pixel converter outside withConverterSlot() — one bounded conversion times K is unbounded`,
		).toBe('converter');
		expect(
			NO_PERMIT_SPAWNS[key],
			`${key} is BOTH a required door and an exemption — the exemption list may never excuse a converter`,
		).toBeUndefined();
	});

	test.each([...AV_DOORS])('%s holds an AV permit around its spawn', (key: string) => {
		// The refuted exemption, now a requirement. Its stated reason — "the AV
		// producer already has its own admission: media/jobs.ts caps how many
		// transcodes run at once" — was false for the two audiovisual API actions:
		// `create_posterframe` and `download_fragment` are awaited INLINE in
		// api/handlers/dd_component_av_api.ts, submit no job and appear in no lane,
		// so K authenticated readers were K unbounded ffmpeg processes. An exemption
		// whose reason is untrue is a laundered ratchet, so the door is named here
		// instead, and named for the AV POOL specifically: admitting an ffmpeg from
		// the image pool would bound it, but by making every upload thumbnail queue
		// behind a transcode.
		const site = admissionSites().find((s) => s.key === key);
		expect(site, `${key} is not a spawn site any more — the census key moved`).toBeDefined();
		expect(
			(site as { pool: string | null }).pool,
			`${key} spawns ffmpeg outside withAvSlot() — it is awaited inline on an authenticated request, so K requests are K transcodes`,
		).toBe('av');
		expect(
			NO_PERMIT_SPAWNS[key],
			`${key} is BOTH a required door and an exemption — the exemption list may never excuse a converter`,
		).toBeUndefined();
	});

	test('NO AV door takes a SECOND permit (a nested permit is a deadlock)', () => {
		// The twin of the identify leg below, for the pool this change adds: a
		// withAvSlot nested inside any permit holds one while waiting for one, which
		// at concurrency 1 never returns.
		const nested: string[] = [];
		for (const { path, code } of files) {
			const all = slotRanges(code, 'any');
			for (const match of code.matchAll(/\bwithAvSlot\s*\(/g)) {
				const at = match.index as number;
				if (all.some((r) => at > r.start && at < r.end))
					nested.push(`${path}:${enclosingFunction(code, at)}`);
			}
		}
		expect(
			nested,
			`these take an AV permit while already holding one: ${nested.join(', ')}`,
		).toEqual([]);
		// Floor: the scan met the real permit sites.
		const total = files.flatMap(({ code }) => [...code.matchAll(/\bwithAvSlot\s*\(/g)]);
		expect(total.length, 'the scan found no AV permit at all').toBeGreaterThanOrEqual(2);
	});

	test('the AV handler lets an admission refusal REACH the client', () => {
		// The permit can refuse (`rate.limited`, 429, retryable), and this handler
		// wraps its inline converter call in a catch that turns everything into
		// `media.action_failed`. Folded, the reader is told their clip could not be
		// cut when it was never attempted, and the client cannot retry on the one
		// answer that is worth retrying.
		const code = stripComments(
			readFileSync(
				join(REPO_ROOT, 'src', 'core', 'api', 'handlers', 'dd_component_av_api.ts'),
				'utf8',
			),
		);
		expect(code.length).toBeGreaterThan(1000);
		expect(
			/error\.code === 'rate\.limited'\) throw error/.test(code),
			'downloadFragmentAction folds an AV admission refusal into media.action_failed — a 429 the client could retry becomes an opaque failure',
		).toBe(true);
	});

	test('no API handler spawns a converter itself — every one goes through an admitted door', () => {
		// The reviewer's leg, and the reason the census above is worth anything: the
		// permit is taken at the spawn door under src/core/media, so a handler is
		// bounded exactly as long as it does not spawn a binary of its own. Census
		// TOTAL over src/core/api/handlers, derived from the tree.
		const handlers = apiHandlerFiles().map((path) => ({
			name: basename(path),
			code: stripComments(readFileSync(path, 'utf8')),
		}));
		expect(handlers.length, 'the handler scan found nothing').toBeGreaterThan(10);
		const spawners = handlers
			.filter(({ code }) =>
				/\b(?:runBinary|spawnSync|execFileSync|execSync)\s*\(|Bun\.spawn/.test(code),
			)
			.map(({ name }) => name);
		expect(
			spawners,
			`these API handlers spawn a process directly, outside the media doors where the permit is taken: ${spawners.join(', ')}`,
		).toEqual([]);
		// POSITIVE CONTROL: the reader really sees such a spawn.
		expect(
			/\b(?:runBinary|spawnSync|execFileSync|execSync)\s*\(|Bun\.spawn/.test(
				stripComments(
					'async function act() {\n\treturn runBinary([ffmpeg(), "-i", src], {});\n}\n',
				),
			),
		).toBe(true);
	});

	test('NO identify call site takes a SECOND permit (a nested permit is a deadlock)', () => {
		// The permit moved INTO `runIdentify` (engine/binaries.ts) when the `-ping`
		// exemption was refuted, and that makes the old shape actively dangerous: a
		// caller that still wraps its own `withConverterSlot` around a `runIdentify`
		// holds a permit while waiting for one, which at DEDALO_MEDIA_CONVERT_CONCURRENCY=1
		// never returns. Census TOTAL over every `runIdentify(` call under
		// src/core/media, derived from the tree.
		const calls: { key: string; nested: boolean }[] = [];
		for (const path of mediaSourceFiles()) {
			const code = stripComments(readFileSync(path, 'utf8'));
			const ranges = slotRanges(code);
			for (const match of code.matchAll(/\brunIdentify\s*\(/g)) {
				const at = match.index as number;
				const before = code.slice(Math.max(0, at - 30), at);
				// The DECLARATION of runIdentify itself is not a call site.
				if (/function\s+$/.test(before)) continue;
				calls.push({
					key: `${relative(MEDIA_DIR, path)}:${enclosingFunction(code, at)}`,
					nested: ranges.some((r) => at > r.start && at < r.end),
				});
			}
		}
		// Floor: probe.ts calls identify three times and file_date.ts twice — a scan
		// that found nothing would make the assertion below vacuously green.
		expect(calls.length, 'the scan found no identify call sites at all').toBeGreaterThanOrEqual(5);
		expect(
			calls.filter((c) => c.key.startsWith('engine/probe.ts:')).length,
			'engine/probe.ts no longer calls identify — the census key moved',
		).toBe(3);
		const nested = calls.filter((c) => c.nested).map((c) => c.key);
		expect(
			nested,
			`these call sites wrap runIdentify in a SECOND converter permit — a permit held while waiting for a permit deadlocks at concurrency 1: ${nested.join(', ')}`,
		).toEqual([]);
	});

	test('the identify runner runs under the CONFIGURED time budget, not the default one', () => {
		// The twin of the same leg for runMagickTo. A permit is only a bound if it is
		// released, and this door now holds one on the upload request path: the default
		// spawn budget (10 minutes) outlives the `-limit time` the same argv declares.
		const code = stripComments(readFileSync(join(MEDIA_DIR, 'engine', 'binaries.ts'), 'utf8'));
		expect(
			/timeoutMs:\s*config\.media\.magickLimits\.time\s*\*\s*1000/.test(code),
			'runIdentify spawns with no cap of its own — a wedged identify holds a converter permit for ten minutes',
		).toBe(true);
	});

	test('POSITIVE CONTROL: the nesting reader SEES a doubly-permitted identify', () => {
		const planted = stripComments(
			"export async function runNested(p: string) {\n\treturn withConverterSlot('x', () => runIdentify(['-ping', p], dirname(p)));\n}\n",
		);
		const at = (planted.match(/\brunIdentify\s*\(/) as RegExpMatchArray).index as number;
		expect(slotRanges(planted).some((r) => at > r.start && at < r.end)).toBe(true);
	});

	test('POSITIVE CONTROL: a planted permit-free converter spawn is flagged', () => {
		const planted = stripComments(
			'export async function runPlanted(argv: string[]) {\n\treturn runBinary([resolveMagick(), ...argv], { env: magickPolicyEnv(dir) });\n}\n',
		);
		const ranges = slotRanges(planted);
		const at = (planted.match(/\brunBinary\s*\(/) as RegExpMatchArray).index as number;
		expect(ranges.some((r) => at > r.start && at < r.end)).toBe(false);
		expect(NO_PERMIT_SPAWNS['engine/planted.ts:runPlanted']).toBeUndefined();
	});

	test('POSITIVE CONTROL: the same reader SEES a permit when one is taken', () => {
		const wrapped = stripComments(
			"export async function runWrapped(argv: string[]) {\n\treturn withConverterSlot('magick', () => runBinary(argv, {}));\n}\n",
		);
		const at = (wrapped.match(/\brunBinary\s*\(/) as RegExpMatchArray).index as number;
		expect(slotRanges(wrapped).some((r) => at > r.start && at < r.end)).toBe(true);
	});

	test.each([
		'DEDALO_MEDIA_CONVERT_CONCURRENCY',
		'DEDALO_MEDIA_CONVERT_QUEUE_SECONDS',
		'DEDALO_MEDIA_AV_CONCURRENCY',
		'DEDALO_MEDIA_AV_QUEUE_SECONDS',
	])('%s is an operator catalog key', (key: string) => {
		const entry = CONFIG_CATALOG[key];
		expect(
			entry,
			`${key} is not in the config catalog — an install whose disk or cores differ cannot tune how many conversions it admits`,
		).toBeDefined();
		expect((entry as { scope: string }).scope).toBe('operator');
	});
});

// --- where the pixel cache spills -------------------------------------------

describe('magick policy: the pixel-cache spill has a chosen filesystem', () => {
	test('magickPolicyEnv names a scratch directory and every caller passes one', () => {
		// `-limit disk` BUDGETS the spill, it does not prevent it: measured 2026-09-05,
		// one 2.4 MB 20000x20000 TIFF wrote 16 GiB apparent / 8.2 GiB real of magick-*
		// files. Left unset, ImageMagick writes them to the OS temp dir — on both
		// shipped compose stacks the volume the DATABASE lives on.
		const binaries = stripComments(readFileSync(join(MEDIA_DIR, 'engine', 'binaries.ts'), 'utf8'));
		expect(binaries).toMatch(/export function magickPolicyEnv\(\s*scratchDir: string\s*\)/);
		expect(
			/MAGICK_TMPDIR\s*:/.test(binaries),
			'magickPolicyEnv sets no MAGICK_TMPDIR — the spill follows the OS temp dir, which is the database volume on both shipped stacks',
		).toBe(true);
		const callers = mediaSourceFiles().flatMap((path) => {
			const code = stripComments(readFileSync(path, 'utf8'));
			return [...code.matchAll(/\bmagickPolicyEnv\s*\(\s*\)/g)].map(() =>
				relative(MEDIA_DIR, path),
			);
		});
		expect(
			callers,
			`these call sites take the policy env with NO scratch directory: ${callers.join(', ')}`,
		).toEqual([]);
		// Floor: the scan did meet real call sites.
		const withArg = mediaSourceFiles().filter((path) =>
			/\bmagickPolicyEnv\s*\(\s*[^)\s]/.test(stripComments(readFileSync(path, 'utf8'))),
		);
		expect(withArg.length).toBeGreaterThanOrEqual(2);
	});

	test('the ImageMagick runner spills next to the file it is writing', () => {
		const code = stripComments(readFileSync(join(MEDIA_DIR, 'engine', 'imagemagick.ts'), 'utf8'));
		expect(
			/magickPolicyEnv\(dirname\(expectedOutput\)\)/.test(code),
			'runMagickTo does not point the pixel cache at the directory it is writing into (inside the media root) — the twin of the TMPDIR the PDF rasterizer hands Ghostscript',
		).toBe(true);
	});

	test('the ImageMagick runner runs under the CONFIGURED time budget, not the default one', () => {
		// A permit is only a bound if it is eventually released: the default spawn
		// budget is 10 minutes, longer than the `-limit time` the same argv declares,
		// so one thrashing conversion could hold a lane past the point the engine had
		// already decided was too long. Same key, same twin as engine/ghostscript.ts.
		const code = stripComments(readFileSync(join(MEDIA_DIR, 'engine', 'imagemagick.ts'), 'utf8'));
		expect(
			/timeoutMs:\s*config\.media\.magickLimits\.time\s*\*\s*1000/.test(code),
			'runMagickTo spawns with no cap of its own — DEDALO_MAGICK_LIMIT_TIME must bound the PROCESS, not only the argv',
		).toBe(true);
	});

	test('POSITIVE CONTROL: the argument-less shape that shipped is caught', () => {
		const planted = stripComments('const r = await runBinary(argv, { env: magickPolicyEnv() });');
		expect(/\bmagickPolicyEnv\s*\(\s*\)/.test(planted)).toBe(true);
	});
});
