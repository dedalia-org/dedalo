/**
 * CSS CORPUS HONESTY tripwire (DEC-12; CSS coherence audit 2026-09, DESIGN.md
 * clause 2.0, findings C13 / C14).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * Every other CSS gate in this repo is a claim ABOUT a corpus: `css_build`
 * compares committed bytes against a fresh compile of `entrypoints()`,
 * `css_token_duplication` asks who may declare a palette in entrypoint space,
 * `contrast_ratio` scores WCAG ratios over the built served sheets,
 * `theme_token_parity` reads two palette files. Not one of them asks whether the
 * corpus it walks IS the set of bytes a browser can fetch. That question had no
 * gate, and the answer was no:
 *
 *   - `page/css/layout/theme_dark.css`, `page/css/layout/functions.css` and
 *     `area_maintenance/widgets/dedalo_api_test_environment/css/…css` were
 *     tracked, served 200 by `serveClientAsset` (no extension allowlist), and
 *     were the compiled output of PARTIALS — files `main.less` / `area_maintenance.less`
 *     `@import`, therefore never in `entrypoints()`, therefore inside no gate's
 *     corpus. `theme_dark.css` was a 190-line 2026-07-11 snapshot of a palette
 *     that is 251 lines today: 13 token names carrying DIFFERENT values from the
 *     ones that ship, 50 tokens missing entirely. A stale palette, one URL away
 *     from the real one, that every gate was structurally unable to see. The
 *     third one does not even compile standalone (`.dd_console is undefined`).
 *     All three were deleted on 2026-09-05. This gate is what stops a fourth.
 *
 *   - `css_source_tripwire` (the gate this one extends) asks the same family of
 *     question over `tools/*​/css/*.css` — 37 of the 46 committed sheets. The nine
 *     it never saw are exactly where the three orphans lived.
 *
 * And in COMPILED space, a second hole with the same shape: the source walker in
 * `css_token_duplication_tripwire` (assertion 5) reads `.less` TEXT to decide who
 * declares a palette at a global root, and it was MEASURED to be defeated by a
 * single `}//x` line before the block (it strips only whole-line `//` comments,
 * then reads `buf.split(/[;}]/).pop()` as the selector — the trailer becomes part
 * of the "selector" and the block stops being a `:root`). A partial planted under
 * `main.less` can therefore re-declare `:root { --color_white: red }` and retune
 * the DEFAULT light axis document-wide with the whole suite green. Nine sibling
 * bypasses of the same walker were measured (`;//` trailer, `html:root`,
 * `:root:not(.x)`, `:where(:root)`, a detached ruleset, `@{sel}` interpolation…).
 * Patching the walker closes one of nine. Assertion 3 below does not read source
 * at all: it reads the COMPILED bytes, where none of those spellings survive.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS ASSERTS
 *
 * (1) SET EQUALITY, BOTH DIRECTIONS. The tracked `.css` under the build's own
 *     search dirs equals the built entrypoint outputs, UNION the third-party set
 *     DERIVED from `scripts/lib/third_party_census.ts` (the repo's one derivation
 *     of "this file is somebody else's code"), UNION a shrink-only, re-proved
 *     exemption list. Both sides are derived: `git ls-files` on one, `entrypoints()`
 *     on the other. No file list is written down here that a rename could empty.
 *
 * (2) SERVED-DOCUMENT CLASSIFICATION. Every entrypoint declares WHICH DOCUMENT
 *     its bytes land in, with a reason. The 37 tool sheets are derived, not
 *     listed: `tool_common.js` composes their URL as
 *     `tool_base_url(model) + '/css/' + model + '.css'`, so the classification is
 *     the loader's own template checked against the tool registry
 *     (`tools/*​/register.json`) in both directions. The six that are not tools
 *     are declared one by one, and each declaration is RE-PROVED against the tree:
 *     a sheet classified as loaded must be named by some tracked JS/HTML, a sheet
 *     classified DEAD must be named by nothing.
 *
 * (3) ONE DECLARATION PER (TOKEN, ROOT SELECTOR), IN COMPILED SPACE. In the bytes
 *     the SPA document actually assembles — `main.css` plus every sheet
 *     classification (2) says is injected into that same document — each
 *     (at-rule context, global-root selector, custom-property name) triple is
 *     declared EXACTLY ONCE. A second declaration of the same name at the same
 *     root is, by the cascade, a silent retune of everything downstream of it:
 *     that is the payload the `}//x` hole lets through, and here it is a
 *     duplicate no matter how the source that produced it was spelled.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES NOT PROVE (the honest list)
 *
 *   - NOT that a committed `.css` is FRESH. Byte-equality against a fresh compile
 *     is `css_build_tripwire`'s job; this gate only proves a committed sheet is
 *     something the build produces at all.
 *   - NOT that a vendored sheet is current, safe or licensed. The third-party set
 *     is borrowed from the census; staleness and advisories are
 *     `vendor_advisory_tripwire` / `dependency_integrity_tripwire`.
 *   - NOT that a sheet classified DEAD is really unreachable. The re-prove is a
 *     lexical reference hunt over tracked JS/HTML — a URL composed at runtime
 *     from data (a `css.url` arriving in a tool context, an ontology-stored path)
 *     is invisible to it. It is kept because the injection CALL is the interface,
 *     and it is labelled a spelling here rather than dressed as an outcome.
 *   - NOT that the tool sheets are the tool sheets the SERVER serves. This reads
 *     the repo, not a running process; `client_serving.test.ts` is the leg that
 *     compares served bytes to disk bytes.
 *   - NOT that a token declared once is declared with a SENSIBLE value.
 *     Assertion 3 counts declarations; `contrast_ratio_tripwire` is the only gate
 *     that judges what a palette evaluates to.
 *   - NOT anything about a custom property declared on a NON-root selector, or on
 *     a root selector inside a standalone document (the PDF.js iframes, the
 *     client-test harness) — those are separate documents and a name colliding
 *     across them is not a cascade event.
 *   - NOT that `main.css` is the only sheet the SPA document carries. It is the
 *     only one the page loads at boot; the rest arrive through `load_style()`,
 *     and assertion 3's union is exactly the set (2) says arrive that way — no
 *     more.
 *
 * COST: `git ls-files` + reads of the tracked `.css` and of the tracked JS/HTML
 * under the shipped trees. No DB, no network, no clock → hermetic tier.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { entrypoints, SEARCH_DIRS } from '../../scripts/build_css.ts';
import { thirdPartyCensus } from '../../scripts/lib/third_party_census.ts';
import { cssReferenceFiles, trackedRepoFiles } from '../helpers/css_reference_corpus.ts';
import { isGrantOnlyTool } from '../helpers/tool_directory_corpus.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');

/**
 * EVERY tracked path, once. No pathspec: the three corpora below are carved out
 * of this ONE listing by filters, so the gate narrows nothing at the git call and
 * chooses no walk root of its own (census_derivation's rule — a new gate takes
 * its roots from a registered shared lister, and the two this file imports,
 * `scripts/build_css.ts` and `scripts/lib/third_party_census.ts`, own theirs).
 * Tracked, not on-disk: the question is about COMMITTED bytes, because a deploy
 * is a checkout (.gitattributes) and untracked build output ships nowhere.
 */
const trackedFiles: string[] = trackedRepoFiles();

/** True when `file` lies inside one of the given repo-relative trees. */
const under = (file: string, trees: readonly string[]): boolean =>
	trees.some((tree) => file.startsWith(`${tree}/`));

// ---------------------------------------------------------------------------
// THE CORPUS. Derived twice over, from the two authorities that already exist.
// ---------------------------------------------------------------------------

/**
 * `SEARCH_DIRS` is the build's OWN answer to "where does browser CSS live"
 * (client/, tools/). Taking it from there rather than typing the two names is
 * what keeps this gate honest the day a third tree is added.
 */
const trackedStylesheets = trackedFiles.filter(
	(file) => file.endsWith('.css') && under(file, SEARCH_DIRS),
);

/**
 * A tracked path that is absent from the working tree is a deletion staged in the
 * editor but not yet committed — the bytes are gone, so nothing serves them, and
 * reading them would throw. They are dropped from the corpus rather than skipped
 * silently: if such a file were still a BUILT output, assertion 1b (built ⊆
 * corpus) reds immediately, which is the case that actually matters.
 */
const corpus = trackedStylesheets.filter((file) => existsSync(join(REPO_ROOT, file)));

/** The built side: an entrypoint is a `.less` no other `.less` imports (build_css.ts). */
const builtEntrypoints = entrypoints();
const builtOutputs = new Set(builtEntrypoints.map((file) => file.replace(/\.less$/, '.css')));

/**
 * The third-party side, DERIVED. `thirdPartyCensus` is the module behind
 * `dependency_integrity_tripwire`: a file is third-party when it wears a
 * redistribution signature (minified name, a >1000-char line, a `/*!` banner, a
 * `sourceMappingURL`, a foreign copyright head) and carries no first-party marker
 * (the AGPL tag, or a sibling `.less` it was built from).
 *
 * Deriving it matters more than it looks. The audit's own proposal was to spell
 * the exclusion as "/lib/ and the ckeditor dist" — which already misses
 * `service_ckeditor/plug-ins/reference/theme/link.css`, the one committed
 * third-party stylesheet in the tree, because it is neither.
 */
const census = thirdPartyCensus(corpus);
const thirdParty = new Set(census.hits.map((hit) => hit.file));

/**
 * ORPHANS — tracked, present, served, NOT built by the current build, and NOT
 * third-party. Shrink-only: the list may lose entries, never gain them, and every
 * entry is re-proved each run (it exists, it is still not built, it is still not
 * third-party) so a stale line is red instead of quietly widening the hole.
 *
 * Both of today's entries are the SAME defect class as the three sheets deleted on
 * 2026-09-05 (C14) — the committed standalone output of a file that is a PARTIAL
 * of `main.css` — two directories deeper and behind a `dist/` folder. They are
 * first-party (the census reads them as "built from ../service_ckeditor.less"),
 * so no vendor row can hold them, and nothing in the repo references either path.
 */
const ORPHAN_EXEMPTIONS: ReadonlyArray<{ file: string; reason: string; removal: string }> = [
	{
		file: 'client/dedalo/core/services/service_ckeditor/css/dist/service_ckeditor.css',
		reason:
			'CodeKit-era standalone output of ../service_ckeditor.less, which main.less:36 @imports as a PARTIAL — so the current build never regenerates it and the committed bytes froze on 2026-07-11 while the source moved on 2026-08-01. Nothing in the repo links it; it answers 200 like any other path under client/.',
		removal:
			'Delete both dist/ files and this entry. Their content already ships inside main.css, so nothing is lost.',
	},
	{
		file: 'client/dedalo/core/services/service_ckeditor/css/dist/service_ckeditor-min.css',
		reason:
			'The minified twin of the file above, same origin, same staleness, same absence of any reference. Its `-min` name makes it LOOK third-party to the census, but the sibling .less is right there, so the census correctly reads it as first-party build output.',
		removal: 'Deleted together with its unminified twin.',
	},
];

/*
 * ANTI-VACUITY FLOORS, set AT the corpus measured on 2026-09-06 — never below it.
 * The defect that produced `css_source_tripwire` was a sibling gate flooring at
 * `> 30` over 37 files: a floor under the corpus cannot notice a missing member.
 * These are FLOORS, not ratchets — the corpus may grow, and each one exists so
 * that a refactor which EMPTIES a corpus turns this gate red instead of green.
 * `MAX_ORPHANS` below is the one ratchet here, and it is shrink-only.
 */

/** 48 tracked+present .css under client/+tools/: 45 built + 2 ckeditor orphans + 1 third-party stub. */
const MIN_TRACKED_STYLESHEETS = 48;
/** 45 entrypoints: main + 39 tools + 2 pdfjs + the client-test harness + 2 dead sheets. */
const MIN_ENTRYPOINTS = 45;
/** The one committed third-party stylesheet. If this reaches 0 the derivation broke. */
const MIN_THIRD_PARTY_STYLESHEETS = 1;
/** Registered tools, each with exactly one entry sheet. */
const MIN_REGISTERED_TOOLS = 37;

/** Shrink-only ratchet: today's orphan count. Lower it when one goes; never raise it. */
const MAX_ORPHANS = 2;

describe('css corpus — the set of served stylesheets is derived, not claimed', () => {
	test('the corpus is non-empty and above its floors (anti-vacuity)', () => {
		expect(
			corpus.length,
			'The tracked-stylesheet census collapsed. Either the build changed where CSS lives ' +
				'(SEARCH_DIRS) or git ls-files answered nothing — in both cases every assertion ' +
				'below became vacuous and this floor is the only thing that says so.',
		).toBeGreaterThanOrEqual(MIN_TRACKED_STYLESHEETS);
		expect(
			builtEntrypoints.length,
			'entrypoints() collapsed: the built side of the set equality is empty, so "tracked == built" ' +
				'would be asserting nothing.',
		).toBeGreaterThanOrEqual(MIN_ENTRYPOINTS);
		expect(
			thirdParty.size,
			'The third-party derivation returned nothing. The signatures in third_party_census.ts went ' +
				'blind, or the one committed third-party stylesheet left the tree — either way the ' +
				'"union the vendored set" term of assertion 1 is no longer doing any work.',
		).toBeGreaterThanOrEqual(MIN_THIRD_PARTY_STYLESHEETS);
	});

	test('the third-party census actually looked at every stylesheet in the corpus', () => {
		// The census has its own SCAN_ROOTS. If they ever stop covering the build's
		// SEARCH_DIRS, `thirdParty` silently becomes a subset and unexplained files
		// start passing as "not third-party" for the wrong reason.
		const unscanned = corpus.filter((file) => !census.scanned.includes(file));
		expect(
			unscanned,
			'These stylesheets were never read by the third-party census, so their third-party ' +
				`verdict is an assumption:\n  ${unscanned.join('\n  ')}`,
		).toEqual([]);
	});

	test('every tracked stylesheet is a built output, third-party, or a named orphan', () => {
		const exempt = new Set(ORPHAN_EXEMPTIONS.map((entry) => entry.file));
		const unexplained = corpus.filter(
			(file) => !builtOutputs.has(file) && !thirdParty.has(file) && !exempt.has(file),
		);
		expect(
			unexplained,
			'A committed, browser-served stylesheet that the CSS build does not produce.\n\n' +
				'That is how three stale sheets shipped: the compiled output of a PARTIAL, committed once ' +
				'and then frozen while its source moved on — a palette 13 token values out of date, served ' +
				"at 200, inside no gate's corpus (C14, deleted 2026-09-05).\n\n" +
				'Fix it by deleting the file (its bytes already ship inside the sheet that imports its ' +
				'source), or — if it really is a new top-level stylesheet — make its .less an entrypoint ' +
				'and run `bun run css:build`.\n  ' +
				unexplained.join('\n  '),
		).toEqual([]);
	});

	test('every built output is committed and present', () => {
		const missing = [...builtOutputs].filter((file) => !corpus.includes(file));
		expect(
			missing,
			'The build produces these stylesheets but the tree does not carry them. A deploy is a ' +
				'checkout (.gitattributes), so an untracked or deleted output is a 404 in production ' +
				`while every compile-time gate stays green.\n  ${missing.join('\n  ')}`,
		).toEqual([]);
	});

	test('every built output has a non-empty source', () => {
		// Carried over from css_source_tripwire and widened from tools/ to the whole
		// tree: set equality alone would be satisfied by a zero-byte .less sourcing
		// a zero-byte .css.
		const empty = builtEntrypoints.filter((file) => statSync(join(REPO_ROOT, file)).size === 0);
		expect(empty, `Entrypoint .less files with no content:\n  ${empty.join('\n  ')}`).toEqual([]);
	});

	test('the orphan exemptions are live, re-proved and shrink-only', () => {
		expect(
			ORPHAN_EXEMPTIONS.length,
			`The orphan list grew past its banked size (${MAX_ORPHANS}). It is shrink-only: a new ` +
				'unexplained stylesheet is deleted, not enumerated.',
		).toBeLessThanOrEqual(MAX_ORPHANS);

		const stale = ORPHAN_EXEMPTIONS.filter(
			(entry) =>
				!corpus.includes(entry.file) || builtOutputs.has(entry.file) || thirdParty.has(entry.file),
		);
		expect(
			stale,
			'A stale orphan exemption: the file is gone, or it is now built, or it is now read as ' +
				'third-party. Delete the entry and lower MAX_ORPHANS — a bank left standing after the ' +
				'defect is fixed lets the defect come back unnoticed.\n  ' +
				stale.map((entry) => entry.file).join('\n  '),
		).toEqual([]);

		for (const entry of ORPHAN_EXEMPTIONS) {
			expect(entry.reason.length, `${entry.file} carries no reason`).toBeGreaterThan(60);
			expect(entry.removal.length, `${entry.file} carries no removal condition`).toBeGreaterThan(
				20,
			);
		}
	});
});

// ---------------------------------------------------------------------------
// (2) SERVED-DOCUMENT CLASSIFICATION
// ---------------------------------------------------------------------------

type ServedRole =
	/** Loaded by `page/index.html` at boot; the document every injected sheet joins. */
	| 'SPA_DOCUMENT'
	/** Injected into the SPA document at runtime by `load_style()`. */
	| 'SPA_INJECTED'
	/** Loaded into a document that does NOT carry main.css. */
	| 'STANDALONE_DOCUMENT'
	/** Nothing loads it. */
	| 'DEAD';

interface Classification {
	entrypoint: string;
	role: ServedRole;
	/** The document the bytes land in — the fact no amount of CSS can reveal. */
	document: string;
	why: string;
}

/**
 * The NON-TOOL entrypoints, declared one by one. The 37 tool sheets are derived
 * below from the registry and the loader's URL template, because a hand-listed
 * roster of them would be the exact "list that rots" the build's own header warns
 * about.
 */
const DECLARED: ReadonlyArray<Classification> = [
	{
		entrypoint: 'client/dedalo/core/page/css/main.less',
		role: 'SPA_DOCUMENT',
		document: 'client/dedalo/core/page/index.html — the one <link> the application boots with',
		why: 'The application stylesheet: ~120 partials compiled into one file, carrying every root palette (classic light/dark). Everything else in the app is injected into THIS document, which is why assertion 3 treats main.css plus the injected set as one cascade.',
	},
	{
		entrypoint: 'client/dedalo/core/component_pdf/css/pdfjs_default_edit.less',
		role: 'STANDALONE_DOCUMENT',
		document:
			"the PDF.js viewer iframe's contentDocument (component_pdf/js/view_default_edit_pdf.js)",
		why: 'An iframe document of its own: it never sees main.css, so it declares the handful of properties it needs locally. That is also why it is not a token owner in css_token_duplication and why its root declarations are outside assertion 3 — a name it repeats is not a cascade collision with the app.',
	},
	{
		entrypoint: 'client/dedalo/core/component_pdf/css/pdfjs_default_read_only.less',
		role: 'STANDALONE_DOCUMENT',
		document:
			"the PDF.js viewer iframe's contentDocument (component_pdf/js/view_default_edit_pdf.js)",
		why: 'The read-only twin of the sheet above, injected into the same kind of iframe document by the same view. Same reasoning, same exclusion from the SPA cascade.',
	},
	{
		entrypoint: 'client/dedalo/test/client/css/unit_test.less',
		role: 'STANDALONE_DOCUMENT',
		document:
			'client/dedalo/test/client/index.html and frame.html — the browser-suite runner pages',
		why: 'The Mocha runner chrome (`bun run test:client`). Its own document, not the application: it declares the --ut_* chrome palette at :root and would collide with nothing in the SPA because it is never loaded there.',
	},
	{
		entrypoint: 'client/dedalo/test/client/fixtures/tool_test_attach/css/tool_test_attach.less',
		role: 'SPA_INJECTED',
		document:
			'client/dedalo/test/client/frame.html — the suite frame that carries main.css, joined by load_style(tool_css_url) when the fixture tool builds',
		why: 'The client-suite scratch tool for open_as attach (test_tool_open_as_attach.js), mapped in only by DEDALO_TOOLS_URLS and never shipped. tool_common.build() rejects when the tool sheet 404s, so the fixture needs a real one; it is SPA_INJECTED exactly like a registered tool sheet, just outside tools/.',
	},
	{
		entrypoint: 'client/dedalo/core/button_common/css/button_common.less',
		role: 'DEAD',
		document: 'none — no tracked JS, HTML or TS names button_common.css',
		why: "An entrypoint by accident: no .less imports it and no loader requests it, so the compiled output is committed, served at 200, and reaches no document. Classified rather than deleted because deleting client source is outside this gate's remit; the re-prove below turns red the day anything starts loading it (reclassify then) and the gate keeps it honest meanwhile.",
	},
	{
		entrypoint: 'client/dedalo/core/widgets/test/test_info/css/test_info.less',
		role: 'DEAD',
		document: 'none — no tracked JS, HTML or TS names test_info.css',
		why: 'Same shape: a widget stylesheet nothing imports and no loader injects. Kept classified so that a future widget wiring it up must say so here instead of silently growing the served cascade.',
	},
];

/**
 * The tool roster, DERIVED. `tool_common.js` builds the URL as
 * `tool_base_url(model) + '/css/' + model + '.css'`, so a tool's entry sheet is at
 * exactly one path and its name is the tool's own. The registry is the set of
 * `tools/<name>/register.json`.
 */
const registeredTools = trackedFiles
	.filter((file) => /^tools\/[^/]+\/register\.json$/.test(file))
	.map((file) => file.split('/')[1] as string)
	// A GRANT-ONLY tool (tool_directory_corpus.isGrantOnlyTool) is a registry row to
	// GRANT, never loaded by tool_common.js — it has no sheet to serve, and the
	// grant-only law (tools_register_validate) proves it ships none.
	.filter((tool) => !isGrantOnlyTool(tool));
const toolEntrypoint = (tool: string) => `tools/${tool}/css/${tool}.less`;

/** Tracked text the client could name a stylesheet from. `.css` itself is excluded:
 *  a sheet mentioning its own name proves nothing about who loads it. The trees
 *  are named in test/helpers/css_reference_corpus.ts, not here: a root set
 *  written into one gate is a root set no other gate can be held to. */
const referenceCorpus = cssReferenceFiles(trackedFiles).filter((file) =>
	existsSync(join(REPO_ROOT, file)),
);

const referenceText = referenceCorpus.map((file) => ({
	file,
	text: readFileSync(join(REPO_ROOT, file), 'utf8'),
}));

/** Tracked files naming this stylesheet's output basename. */
function referencesTo(entrypoint: string): string[] {
	const output = basename(entrypoint).replace(/\.less$/, '.css');
	return referenceText.filter((candidate) => candidate.text.includes(output)).map((c) => c.file);
}

describe('css corpus — every entrypoint declares the document it is served into', () => {
	test('the classification corpus is non-empty (anti-vacuity)', () => {
		expect(registeredTools.length).toBeGreaterThanOrEqual(MIN_REGISTERED_TOOLS);
		expect(DECLARED.length).toBeGreaterThanOrEqual(6);
		expect(
			referenceText.length,
			'The reference corpus is empty, so every "nothing loads this" re-prove below would pass ' +
				'for free — which is the shape of a gate that enforces nothing.',
		).toBeGreaterThan(1000);
	});

	test('every tool has exactly one entry sheet, and every tool sheet has a tool', () => {
		// Both directions, so neither a tool without CSS nor CSS without a tool can hide.
		const expected = registeredTools.map(toolEntrypoint).sort();
		const actual = builtEntrypoints.filter((file) => file.startsWith('tools/')).sort();
		expect(
			actual,
			'The tool stylesheets no longer match the tool registry one-to-one. The loader composes ' +
				"`tool_base_url(model) + '/css/' + model + '.css'`, so a tool whose sheet is not at that " +
				'exact path loads NOTHING (silently — load_style does not report a 404), and a sheet at ' +
				'that path with no registered tool is served to no one.',
		).toEqual(expected);
	});

	test('every entrypoint is classified exactly once, and no classification is stale', () => {
		const declaredPaths = DECLARED.map((entry) => entry.entrypoint);
		expect(new Set(declaredPaths).size, 'a duplicated classification row').toBe(
			declaredPaths.length,
		);

		const classified = new Set([...declaredPaths, ...registeredTools.map(toolEntrypoint)]);

		const unclassified = builtEntrypoints.filter((file) => !classified.has(file));
		expect(
			unclassified,
			'A new top-level stylesheet with no declared document. Say where its bytes land — that is ' +
				'the fact nothing in the CSS itself can reveal, and the fact assertion 3 needs to know ' +
				'which sheets share one cascade.\n  ' +
				unclassified.join('\n  '),
		).toEqual([]);

		const live = new Set(builtEntrypoints);
		const stale = declaredPaths.filter((file) => !live.has(file));
		expect(
			stale,
			'A classification row naming a file that is no longer an entrypoint. Delete the row — a ' +
				'roster that outlives its files is how a corpus quietly empties while its gate stays ' +
				`green.\n  ${stale.join('\n  ')}`,
		).toEqual([]);
	});

	test('every declaration carries a document and a reason', () => {
		for (const entry of DECLARED) {
			expect(entry.document.length, `${entry.entrypoint}: empty document`).toBeGreaterThan(10);
			expect(entry.why.length, `${entry.entrypoint}: empty reason`).toBeGreaterThan(60);
		}
	});

	/**
	 * The reference leg. Labelled a SPELLING, not an outcome: it greps for the
	 * output basename in tracked JS/HTML. It is kept because the injection call IS
	 * the interface — `load_style(url)` is the only way a sheet reaches the SPA
	 * document — and because it is the only mechanical thing that can contradict a
	 * "nothing loads this" claim. Its blind spot is stated in the header.
	 */
	test('a DEAD classification is re-proved: nothing in the tree names the sheet', () => {
		const contradicted = DECLARED.filter(
			(entry) => entry.role === 'DEAD' && referencesTo(entry.entrypoint).length > 0,
		);
		expect(
			contradicted,
			'A stylesheet classified DEAD is named by tracked code. Either it is loaded now — ' +
				'reclassify it, and note that assertion 3 then has to take its root declarations into ' +
				'the SPA cascade — or the reference is itself dead.\n  ' +
				contradicted
					.map((entry) => `${entry.entrypoint} <= ${referencesTo(entry.entrypoint).join(', ')}`)
					.join('\n  '),
		).toEqual([]);
	});

	test('a loaded classification is re-proved: some tracked file names the sheet', () => {
		const unreferenced = DECLARED.filter(
			(entry) => entry.role !== 'DEAD' && referencesTo(entry.entrypoint).length === 0,
		);
		expect(
			unreferenced,
			'A stylesheet declared to be loaded into a document is named by nothing in the tree. Either ' +
				'the loader that requested it was deleted (then this sheet is now DEAD and should say so) ' +
				'or the document claim was never true.\n  ' +
				unreferenced.map((entry) => `${entry.entrypoint} — ${entry.document}`).join('\n  '),
		).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// (3) COMPILED SPACE — one declaration per (context, root selector, token)
// ---------------------------------------------------------------------------

interface RootDeclaration {
	name: string;
	selector: string;
	/** The enclosing at-rules, if any — `@media (…)` makes a redeclaration conditional. */
	context: string;
	sheet: string;
}

/**
 * A global-root selector: `:root` or `html`, qualified only by attribute
 * selectors, classes or `:not(…)` — never a descendant. Such a rule matches the
 * document root whenever its attributes hold, so a custom property declared there
 * is in force for the WHOLE document. Derived from the shape of the selector, not
 * from a list of the axes that exist today — `[data-accent="pine"]` was already
 * shipping before any gate knew the accent axis existed.
 */
const GLOBAL_ROOT = /^(?::root|html)(?:\[[^\]]*\]|:not\([^)]*\)|\.[A-Za-z0-9_-]+)*$/;

/**
 * Walk COMPILED css and return every custom-property declaration with the selector
 * and at-rule context it sits in.
 *
 * Quote-aware and comment-aware on purpose: `main.css` carries data-URI icons with
 * `;` inside quoted strings, and a walker that split on punctuation would desync
 * and start attributing declarations to the wrong selector — the same class of
 * mistake as the source walker this assertion exists to backstop. The caller
 * asserts the brace depth returns to zero, which is the cheap proof that the walk
 * stayed in sync from the first byte to the last.
 */
function walkCompiled(css: string): {
	declarations: Omit<RootDeclaration, 'sheet'>[];
	depth: number;
} {
	const declarations: Omit<RootDeclaration, 'sheet'>[] = [];
	const stack: string[] = [];
	let buffer = '';

	for (let i = 0; i < css.length; i++) {
		const char = css[i] as string;

		if (char === '/' && css[i + 1] === '*') {
			const end = css.indexOf('*/', i + 2);
			i = end === -1 ? css.length : end + 1;
			buffer += ' ';
			continue;
		}
		if (char === '"' || char === "'") {
			let j = i + 1;
			while (j < css.length) {
				if (css[j] === '\\') {
					j += 2;
					continue;
				}
				if (css[j] === char) break;
				j++;
			}
			buffer += css.slice(i, j + 1);
			i = j;
			continue;
		}
		if (char === '{') {
			stack.push(buffer.trim().replace(/\s+/g, ' '));
			buffer = '';
			continue;
		}
		if (char === '}') {
			stack.pop();
			buffer = '';
			continue;
		}
		if (char === ';') {
			const match = /^(--[A-Za-z0-9_-]+)\s*:/.exec(buffer.trim());
			if (match && stack.length > 0) {
				declarations.push({
					name: match[1] as string,
					selector: stack[stack.length - 1] as string,
					context: stack
						.slice(0, -1)
						.filter((prelude) => prelude.startsWith('@'))
						.join(' >> '),
				});
			}
			buffer = '';
			continue;
		}
		buffer += char;
	}
	return { declarations, depth: stack.length };
}

const isGlobalRoot = (selector: string): boolean =>
	selector.split(',').every((part) => GLOBAL_ROOT.test(part.trim()));

/** The sheets that share ONE cascade: the boot document plus everything injected into it. */
const spaDocumentSheets = [
	...DECLARED.filter((entry) => entry.role === 'SPA_DOCUMENT' || entry.role === 'SPA_INJECTED').map(
		(entry) => entry.entrypoint,
	),
	...registeredTools.map(toolEntrypoint),
].map((entrypoint) => entrypoint.replace(/\.less$/, '.css'));

const spaRootDeclarations: RootDeclaration[] = [];
let mainSheetDepth = -1;
for (const sheet of spaDocumentSheets) {
	const walked = walkCompiled(readFileSync(join(REPO_ROOT, sheet), 'utf8'));
	if (sheet.endsWith('page/css/main.css')) mainSheetDepth = walked.depth;
	for (const declaration of walked.declarations) {
		if (!isGlobalRoot(declaration.selector)) continue;
		spaRootDeclarations.push({ ...declaration, sheet });
	}
}

const declarationKey = (declaration: RootDeclaration): string =>
	`${declaration.context}||${declaration.selector}||${declaration.name}`;

/**
 * FLOORS for assertion 3, measured over main.css + 37 tool sheets:
 * 691 root declarations, 2 distinct root selectors, 385 distinct token names.
 * Set AT the measurement. If a refactor moves the palette somewhere this walker
 * cannot see, these are what says so instead of "0 duplicates, green".
 */
const MIN_ROOT_DECLARATIONS = 680;
const MIN_ROOT_SELECTORS = 2;
const MIN_ROOT_TOKEN_NAMES = 380;
/** main.css + the 39 tool sheets injected into the same document. */
const MIN_SPA_SHEETS = 40;

describe('css corpus — each palette token is declared once per root, in compiled space', () => {
	test('the compiled walk stayed in sync and saw the whole palette (anti-vacuity)', () => {
		expect(
			mainSheetDepth,
			'The walk over main.css did not return to brace depth 0, so its selector attribution ' +
				'desynced somewhere and every count below is fiction.',
		).toBe(0);
		expect(
			spaDocumentSheets.length,
			'The SPA cascade collapsed to nothing — the classification above stopped naming the sheets ' +
				'that share the boot document.',
		).toBeGreaterThanOrEqual(MIN_SPA_SHEETS);
		expect(spaRootDeclarations.length).toBeGreaterThanOrEqual(MIN_ROOT_DECLARATIONS);
		expect(
			new Set(spaRootDeclarations.map((declaration) => declaration.selector)).size,
			'Root palettes vanished from the compiled bytes: the theme axis is ' +
				'derived from the selectors this walk finds, so a drop here means whole palettes stopped ' +
				'being judged.',
		).toBeGreaterThanOrEqual(MIN_ROOT_SELECTORS);
		expect(
			new Set(spaRootDeclarations.map((declaration) => declaration.name)).size,
		).toBeGreaterThanOrEqual(MIN_ROOT_TOKEN_NAMES);
	});

	test('no (at-rule context, root selector, token) triple is declared twice', () => {
		const seen = new Map<string, RootDeclaration[]>();
		for (const declaration of spaRootDeclarations) {
			const key = declarationKey(declaration);
			const bucket = seen.get(key);
			if (bucket) bucket.push(declaration);
			else seen.set(key, [declaration]);
		}
		const duplicates = [...seen.values()].filter((bucket) => bucket.length > 1);
		expect(
			duplicates.map(
				(bucket) =>
					`${declarationKey(bucket[0] as RootDeclaration)} — ${bucket.length}× in ${[
						...new Set(bucket.map((declaration) => declaration.sheet)),
					].join(', ')}`,
			),
			'A palette token is declared more than once at the same global root in the bytes the SPA ' +
				'document assembles. By the cascade the LAST one wins, so this silently retunes every ' +
				'rule downstream of it — measured: a second `:root { --color_white: red }` planted after ' +
				'a `}//x` trailer in any partial of main.less repaints the default axis document-wide, ' +
				'and the source-space walker in css_token_duplication_tripwire does not see it.\n\n' +
				'If the second declaration is deliberate, it does not belong at a global root: scope it ' +
				'to the element that needs it, or make it a distinct token name.',
		).toEqual([]);
	});
});
