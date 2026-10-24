/**
 * TRIPWIRE — A TOOL ACTION THAT WRITES BACK OVER A STORED COMPONENT VALUE IS
 * EITHER LOSSLESS OR CONFIRMED (P0-12; CLI-14 + CLI-24, both S2 CONFIRMED).
 *
 * THE DEFECT CLASS. A tool reads a curated value, transforms it, and writes the
 * transform back. When the transform loses part of the value the curator is not asked
 * and is not told — the tool reports success. That is the worst class of defect this
 * system can have: the records are irreplaceable and the loss is silent. Two instances
 * were live until 2026-08-30:
 *
 *   CLI-14  tool_lang in-browser translation: `browser_transformer.js` SKIPS a block
 *           that fails and keeps translating (its own comment: "Skip this block —
 *           accumulated_text stays unchanged"), then posts a byte-identical `end` for a
 *           complete run and for one that lost half its paragraphs. The main thread
 *           painted "Translation completed" and SAVED the short text over the target
 *           language's existing — possibly human — translation, resolving {result:true}.
 *   CLI-24  tool_transcription "Rebuild paragraphs": the round-trip through
 *           `transcribers/lib/paragraphs.js` ran `.replace(/<[^>]*>/g,'')` over the
 *           stored value — deleting the archivist's emphasis, foreign-word marking and
 *           uncertain-reading formatting from the RICH-TEXT component — and re-escaped
 *           every `&`, so an entity outside escape_html's four compounded on every
 *           press (`&#39;` → `&amp;#39;` → `&amp;amp;#39;`). The docblock claimed the
 *           operation "cannot change a single word". There was no confirmation.
 *
 * WHY THEY SURVIVED: NOTHING GATED tools/**\/js BEHAVIOUR AT ALL. `biome.jsonc` excludes
 * `**\/tools\/**\/*\/js`, the client suite does not drive these tools, and the server
 * suite never imported them. This file is the first gate that does.
 *
 * WHAT IT IS. Three behavioural legs and a DERIVED census:
 *
 *   1. the transcription round-trip really is markup-, entity- and idempotence-
 *      preserving, over several real-shaped transcript values (CLI-24);
 *   2. a translation run that loses ONE BLOCK saves nothing, reports no success and
 *      leaves the target component's stored value byte-unchanged (CLI-14);
 *   3. the one other census row that claims a LOSSLESS transform over a stored value —
 *      tool_tc's timecode offset — really only rewrites the marks.
 *
 *   4. THE CENSUS IS TOTAL BY DERIVATION, per (action, door, sites). SERVER doors are
 *      DERIVED, never listed: the `db/matrix_write.ts` DML primitives, the OFF-HOME
 *      psql writers (a declaration with a BINDING-resolved edge to `pg_exec.ts#runPsql`
 *      — named, aliased, namespace member or injected — and a matrix DML statement,
 *      past every chokepoint; held EQUAL to the by-name view on the tree), plus every
 *      declaration that reaches one of those seeds
 *      through IMPORT-RESOLVED references — the writer
 *      closure (test/helpers/matrix_writer_closure.ts; a missing cell prints its witness
 *      path) — taken wherever a `tools/<tool>/server/**` declaration (a `tool.apiActions`
 *      object split per action) references a member OUTSIDE its own tool. CLIENT doors
 *      are the three `component_common` write tokens over every `tools/**\/js/**` file in
 *      git's unfiltered view (a tool's own `lib/` helper included). Every
 *      derived (action, door) cell carries its OWN verdict, reason and site count: a new
 *      action, a new door on a known action, a new or vanished call site — each is red,
 *      in BOTH directions (a fix that keeps the door is caught by the PENDING tethers
 *      below). THE BYPASS RULE: a cell whose door reaches a seed on a path that avoids
 *      EVERY record-write chokepoint (RECORD_WRITE_CHOKEPOINTS in the helper — each
 *      checked to be a member that reaches afterRecordWrite; `bypassPath`) must be
 *      PENDING, lossless over a locked read, or carry a `bypass_reason` (equality pins:
 *      BYPASS_TOOL_CELLS, and RAW_TOOL_CELLS for the doors that ARE a seed). It is
 *      judged by PATH, not by the door: a raw write moved into a wrapper of any name,
 *      any number of declarations deep, is the same bypass. No corpus file — src engine or tool
 *      server — may load a module through a computed-specifier dynamic import beyond a
 *      named, reasoned, shrink-only exemption list. The analyser and the judges are run
 *      on injected inputs (positive controls), and the closure's binding-resolved
 *      primitive edges must EQUAL write_obligations' name-based census.
 *
 * THE VERDICTS (per CELL — there is no row-level verdict a new door could inherit; the
 * `Cell` union makes `tsc` refuse a verdict without its evidence), and what is
 * mechanically checked for each:
 *
 *   lossless        — a read-transform-write cycle whose transform preserves the stored
 *                     content. CHECKED: `proof` is one of the behavioural legs' REAL
 *                     titles (`LEGS`, typed and re-checked), or the cell declares
 *                     `readVerified`, so an unproven claim is visible as such;
 *                     `lockedRead` additionally requires the action's own unit to
 *                     REFERENCE readMatrixKeyForUpdate through a RESOLVED edge (a
 *                     namespace escape proves nothing) — edge PRESENCE, not
 *                     lock-before-write ordering nor same-transaction.
 *   confirmed       — the operator confirms before the write, with the loss NAMED.
 *                     CHECKED: `confirm(` appears in the action's own body.
 *   refuses         — the action refuses to write a degraded result rather than saving
 *                     it. CHECKED: `must_contain` is in the action's CODE (strings and
 *                     comments blanked, so a literal cannot vouch) — or, with `evidence`
 *                     (`file#decl`), in that declaration's code AND the action reaches it
 *                     through RESOLVED edges. The spelling alone is a reading judgment, so
 *                     every server `refuses` cell is also BEHAVIOUR-TETHERED — held EQUAL
 *                     to SERVER_REFUSES_TETHERS, each a WRITEBACK_TETHERS title that
 *                     tool_lossless_writeback_tethers_native.test.ts (DB tier) registers
 *                     and runs through the cell's door on a suite-DB record, with its
 *                     counterfactual — and the client one by LEG 2.
 *   operator-value  — NOT a write-back: the value written did not derive from the value
 *                     it replaces (a locator the curator just picked, an import mapping
 *                     the operator declared, a Time Machine version they chose). The rule
 *                     is about read-transform-write cycles and does not reach these.
 *   new-record      — the write lands on a record CREATED in the same call (a bulk-process
 *                     row, a preset, a portal's new media record). Nothing stored is
 *                     replaced.
 *   no-persist      — the door only sets the instance's in-memory value; persistence is a
 *                     separate, operator-driven save.
 *   not-a-component-write — the derivation's own false positive: the token is a `.save(`
 *                     on something that is not a component.
 *   derived-state   — the write is state the engine RE-DERIVES from something else (the
 *                     relation_search index, observer mirrors, the metadata twin,
 *                     files_info re-scanned under the row lock, ontology / hierarchy
 *                     rows); no curated value is transformed. A READING judgment, not an
 *                     executed check.
 *   PENDING         — a real write-back that is neither lossless, confirmed nor refusing.
 *                     Every cell names the item that `closes` it. CHECKED: a client cell's
 *                     body has NO `confirm(` (adding one FAILS this gate and forces the
 *                     cell to move); a server cell by its (action, door) key — a fix that
 *                     changes the door is red as a stale cell plus a missing one — AND by
 *                     a tether to a FACT of its defect (SERVER_PENDING_TETHERS, total over
 *                     the server PENDING cells), so an in-place fix is red too: the
 *                     translation cells by a behaviour test (the WHOLE translateAndWrite
 *                     path on a scratch suite-DB record, in the DB-tier tethers file).
 *                     (updateCache's raw media write, the TOOLS-5 cell tethered by its
 *                     own resolved references, closed with CLOSURE_PLAN Step 2: it writes
 *                     through the locked media-key transform now.) SHRINK-ONLY, counted
 *                     per cell.
 *
 * WHAT THIS GATE DOES NOT PROVE — stated because an unstated gap reads as coverage:
 *   - it does not prove the two fixed tools are lossless for EVERY input. The
 *     transcription round-trip is proved for the well-formed shapes listed below;
 *     unbalanced markup is REPAIRED, not reproduced, and a fragment with markup but no
 *     words is still dropped — which is why the action's verdict is `confirmed`, not
 *     `lossless`;
 *   - the translation leg drives the REAL `translate_component_browser` through the REAL
 *     worker protocol, but `markdown_utils.js` needs a DOM (`DOMParser`) that Bun has
 *     not, so its three functions are replaced by identity in this run. The leg is about
 *     the save/refusal decision on `end`, not about markdown conversion;
 *   - the verdicts other than `confirmed`, `refuses` and the proved `lossless` ones are
 *     READ, not executed. The derivation is what makes forgetting an action impossible;
 *     the reason is what makes a wrong verdict a reviewable claim;
 *   - the relation link/unlink doors (P0-11, CLI-02/CLI-03) are a different write and are
 *     not this rule's subject;
 *   - the closure's binding is LEXICAL and scope-approximate: a local variable that
 *     shadows a same-file top-level name is taken for it, a column-0 statement is taken
 *     for module scope, and a key/value split is read off the source, not a parse tree;
 *   - a file OUTSIDE the corpus is not followed: a relative import — static, or a
 *     LITERAL dynamic `import('x')` in any form — may leave it only to a named target
 *     class (OUT_OF_CORPUS_TARGETS — test/, the migration runner, JSON, a tool's client JS
 *     the client leg scans, an IMPORT-FREE tools .js leaf); an unresolvable export
 *     reference is red;
 *   - `this.x()` and property-object dispatch — a registry indexed by name, a callback
 *     handed to a non-writer — are unseen: a write reached only that way has no cell;
 *   - a computed-specifier `import(spec)` is not followed: the exempted sites
 *     (UNRESOLVED_DYNAMIC_IMPORT_EXEMPT) truncate the closure there, by stated reason;
 *     a namespace escaping as a value is OVER-approximated (every export reached) —
 *     enough for a CELL, never for `refuses` evidence nor a `lockedRead` claim (both
 *     read RESOLVED edges only). A local HOLDING a value-position import (`const m =
 *     deps ?? (await import(x))`) is bound, so its `m.member` calls count per site; a
 *     namespace handed on whole counts its OCCURRENCES, not the receiver's calls;
 *   - the seeds are the `matrix_write.ts` primitives and the off-home PSQL writers (a
 *     tool-server seed carries a SELF cell — nothing to cross): raw DML on the POOL
 *     outside matrix_write (a `sql\`` UPDATE in an engine — T2.a's allowlist), a
 *     statement built in one declaration and run through psql by another, a
 *     whole-database `psql -f` restore, and a psql child spawned DIRECTLY
 *     (`Bun.spawn(['psql', …])` — ontology/data_io.ts#runCopyExport,
 *     scripts/test_db_setup.ts#psql) instead of through runPsql are not seeds, so a
 *     tool reaching only such a site has no cell;
 *   - the chokepoint list is DECLARED (with reasons) and checked only for membership
 *     and for reaching afterRecordWrite — not for WHAT it guarantees. A chokepoint unit
 *     is cut WHOLE: its own internal writes (the relation_search index, the dataframe
 *     slot strip inside saveComponentData) and any raw branch beside its hook are
 *     write_obligations' subject, not this rule's. The bypass walk is over-approximated
 *     (escape edges included — the strict direction), and a bypass is judged per DOOR:
 *     `bypass_reason` states why the WRITER the path lands on may skip the chokepoint,
 *     a READING judgment like every non-executed verdict;
 *   - a `lossless` cell over a chokepoint read-modify-write is not lock-checked — only a
 *     `lockedRead` claim is, and only as edge presence (the lock may sit in another
 *     branch or transaction than the write);
 *   - the client side covers only the three `component_common` tokens.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { replaceTimecodes } from '../../src/core/media/tools/timecode.ts';
import {
	parse_transcript,
	segments_to_html,
} from '../../tools/tool_transcription/transcribers/lib/paragraphs.js';
import { browserSourcesUnfiltered } from '../helpers/browser_corpus.ts';
import { isIsolatedGateChild, mirrorIsolatedGate } from '../helpers/isolated_gate.ts';
import {
	AFTER_RECORD_WRITE,
	buildWriterClosure,
	declarationDoorCalls,
	deriveRawPrimitives,
	hasPsqlDoorEdge,
	isPsqlMatrixWriter,
	MATRIX_WRITE,
	moduleRuntimeExports,
	RAW_PRIMITIVES,
	RECORD_WRITE_CHOKEPOINTS,
	rawCallsIn,
	SANCTIONED_DERIVED_WRITERS,
	toolServerCells,
	type WriterClosure,
} from '../helpers/matrix_writer_closure.ts';
import { stripComments } from '../helpers/strip_comments.ts';
import { WRITEBACK_TETHER_TITLES, WRITEBACK_TETHERS } from '../helpers/tool_writeback_tethers.ts';
import { WRITE_PATH_CORPUS_FLOOR } from '../helpers/write_path_corpus.ts';

// ISOLATED GATE (test/helpers/isolated_gate.ts): this file registers a Bun.plugin
// over the client tree, which is process-global — in the tier's process it only
// MIRRORS a child run of itself; its body below registers in that child alone.
// (ESM hoists every import, so the static imports gathered above load exactly as
// they did where they used to sit, beside their legs.)
if (!isIsolatedGateChild(import.meta.path)) mirrorIsolatedGate(import.meta.path);
else {
	const ROOT = resolve(import.meta.dir, '../..');

	/**
	 * The behavioural legs' titles — the ONE list both the describe() calls below and a
	 * `lossless` cell's `proof` read. `proof` is typed `LegTitle`, so naming a leg that does
	 * not exist does not compile, and `losslessProblems` re-checks it at run time (with a
	 * control) for a value that reached the census through a cast.
	 */
	const LEGS = {
		transcription: 'LEG 1 — rebuilding paragraphs preserves the archivist’s markup (CLI-24)',
		translation: 'LEG 2 — a translation run that lost a block writes nothing (CLI-14)',
		timecode: 'LEG 3 — tool_tc rewrites the marks and nothing else',
	} as const;
	type LegTitle = (typeof LEGS)[keyof typeof LEGS];

	// ---------------------------------------------------------------------------
	// LEG 1 — the transcription round-trip (CLI-24)
	// ---------------------------------------------------------------------------

	/**
	 * Real-shaped stored transcript values: Dédalo TC marks plus the markup and the
	 * entities an oral-history transcript actually carries. Each one is a value a curator
	 * could be looking at right now; before 2026-08-30 one press of "Rebuild paragraphs"
	 * returned all of them stripped of markup and with the entities doubled.
	 */
	const TRANSCRIPTS: Record<string, string> = {
		'inline emphasis + a non-escape_html entity':
			'<p>[TC_00:00:00.000_TC]Empezamos en <em>A Coru&ntilde;a</em>, en el a&ntilde;o 1936.</p>',
		'the compounding-ampersand shape (&#39; and a literal &amp;)':
			'<p>[TC_00:00:12.500_TC]Dijo: &#39;non sei&#39; &amp; call&oacute;. Era <i>morri&ntilde;a</i>.</p>',
		'a typed line break and an attributed uncertain-reading span':
			'<p>[TC_00:01:00.000_TC]Primera l&iacute;nea<br>segunda l&iacute;nea, con <span class="uncertain" title="dudosa">lectura dudosa</span>.</p>',
		'two paragraphs, five minutes apart, each with its own markup':
			'<p>[TC_00:00:00.000_TC]Uno. <strong>Dos</strong> &#8212; tres.</p><p>[TC_00:05:00.000_TC]Cuatro <em>cinco</em>.</p>',
	};

	/** The three timecode modes the tool can rebuild with (paragraphs.js DEFAULT_OPTIONS). */
	const TC_MODES = ['paragraph_anchors', 'paragraph', 'segment'] as const;

	describe(LEGS.transcription, () => {
		for (const [name, stored] of Object.entries(TRANSCRIPTS)) {
			for (const tc_mode of TC_MODES) {
				test(`${name} — round-trips unchanged [${tc_mode}]`, () => {
					const once = segments_to_html(parse_transcript(stored), { tc_mode });
					expect(once, 'the rebuild changed a value it had nothing to regroup').toBe(stored);
				});

				test(`${name} — is idempotent, so nothing compounds [${tc_mode}]`, () => {
					// The shape that made `&#39;` grow an `&amp;` on EVERY press. Twice must
					// equal once: a transform that is stable under repetition cannot compound.
					const once = segments_to_html(parse_transcript(stored), { tc_mode });
					const twice = segments_to_html(parse_transcript(once), { tc_mode });
					const thrice = segments_to_html(parse_transcript(twice), { tc_mode });
					expect(twice).toBe(once);
					expect(thrice).toBe(once);
					expect(thrice, 'an entity gained an escape on a rebuild').not.toContain('&amp;#');
					expect(thrice, 'an entity gained an escape on a rebuild').not.toContain('&amp;amp;');
				});
			}
		}

		test('the markup is really there — the assertions above are not comparing two strippings', () => {
			// Anti-vacuity: if parse/emit both deleted the markup, equality would still hold
			// for a stored value that had none. These values HAVE it, and it must be in the
			// output, tag by tag.
			for (const [name, stored] of Object.entries(TRANSCRIPTS)) {
				const rebuilt = segments_to_html(parse_transcript(stored), {});
				for (const tag of ['<em>', '<i>', '<strong>', '<span', '<br>']) {
					if (!stored.includes(tag)) continue;
					expect(rebuilt, `${name}: ${tag} is gone from the rebuilt value`).toContain(tag);
				}
				for (const entity of ['&ntilde;', '&#39;', '&amp;', '&oacute;', '&iacute;', '&#8212;']) {
					if (!stored.includes(entity)) continue;
					expect(rebuilt, `${name}: ${entity} did not survive the rebuild`).toContain(entity);
				}
			}
		});

		test('a recogniser segment (plain text, no stored fragment) is still ESCAPED — SEC-031', () => {
			// The fidelity override must not become a hole on the ASR path, where the text is
			// model output and has never been HTML. `html` is absent on those segments, so the
			// escaping branch must still run.
			const html = segments_to_html(
				[{ text: 'dijo <script>alert(1)</script> y calló', start: 0, end: 3 }],
				{},
			);
			expect(html).toContain('&lt;script&gt;');
			expect(html).not.toContain('<script>');
		});

		test('a FORGED fidelity override from a remote transcriber is ignored — SEC-031', () => {
			// THE HOLE THIS EXISTS FOR, found by adversarial review 2026-08-30 and closed
			// the same day. The override was a plain `html` STRING KEY, and
			// `src/core/tools/transcription_asr.ts` passes a REMOTE transcriber's JSON
			// `segments` array through to `save()`. `TranscriptionSegment` declares no
			// `html` field, but TypeScript strips nothing at runtime — so a hostile or
			// compromised transcription service could answer
			//     { text: 'hola', html: '<img src=x onerror=alert(1)>' }
			// and have that tag stored, UNESCAPED, in a heritage record's transcription.
			// Measured before the fix: the tag came out intact while the plain path
			// escaped correctly, so nothing looked wrong.
			//
			// The override is a module-private Symbol now (paragraphs.js), which JSON
			// cannot carry, and the ASR seam narrows every remote segment to the four
			// declared fields. This asserts the FIRST half — a string `html` key from
			// anywhere outside the module buys nothing at all.
			const forged = segments_to_html(
				[{ text: 'hola', start: 0, end: 2, html: '<img src=x onerror=alert(1)>' } as never],
				{},
			);
			expect(forged, 'a forged `html` key was emitted verbatim').not.toContain('<img');
			expect(forged, 'a forged `html` key survived at all').not.toContain('onerror');
			// ...and the segment's real text is still rendered, escaped as usual: the
			// forgery is IGNORED, not treated as a reason to drop the content.
			expect(forged).toContain('hola');
		});

		test('the fidelity override is not a string-keyed field at all (structural)', () => {
			// Belt to the behavioural brace above: if someone re-introduces a string key
			// the assertion above still passes for THIS input while the channel is open
			// again for every other. `parse_transcript` must not put an enumerable `html`
			// property on a segment, because an enumerable property is what JSON carries.
			const parsed = parse_transcript('<p>[TC_00:00:00.000_TC]a <em>b</em></p>');
			expect(parsed.length).toBeGreaterThan(0);
			for (const segment of parsed) {
				expect(
					Object.keys(segment as object),
					'a parsed segment carries an enumerable `html` key — a remote JSON segment can forge it',
				).not.toContain('html');
			}
			// And the round-trip still works, so the Symbol really is carrying it.
			expect(segments_to_html(parsed, {})).toContain('<em>b</em>');
		});
	});

	// ---------------------------------------------------------------------------
	// LEG 2 — a translation that lost a block saves NOTHING (CLI-14)
	// ---------------------------------------------------------------------------

	/**
	 * `tools/tool_lang/js/browser_translation.js` is served from a root where `tools/` and
	 * `core/` are siblings, so its `../../../core/common/js/…` specifiers do not resolve on
	 * disk (the client lives under `client/dedalo/core/`). This plugin supplies the two
	 * imported client modules — and `markdown_utils.js`, which needs a DOM Bun has not — as
	 * stubs, and ONLY for an importer inside `tools/tool_lang/js/`: the guard matters because
	 * a Bun plugin is process-global and the same specifiers are used by real client modules
	 * that other files in this tier import.
	 */
	Bun.plugin({
		name: 'tool-lang-served-root',
		setup(build) {
			const importerIsToolLang = (importer: string): boolean =>
				importer.includes(`${join('tools', 'tool_lang', 'js')}${'/'}`);
			build.onResolve({ filter: /core\/common\/js\/(utils\/index|tr)\.js$/ }, (args) =>
				importerIsToolLang(args.importer)
					? { path: 'client-stub', namespace: 'tool-lang-client-stub' }
					: undefined,
			);
			build.onLoad({ filter: /.*/, namespace: 'tool-lang-client-stub' }, () => ({
				// clone IS structuredClone in the client (core/common/js/utils/util.js:50), which
				// is what makes the pre-run snapshot a real copy rather than a live alias.
				contents:
					'export const clone = (value) => (value === undefined || value === null ? value : structuredClone(value));\n' +
					'export const get_json_langs = async () => [];\n' +
					'export const tr = { get_mark_pattern: () => /(?!)/g };\n',
				loader: 'js',
			}));
			// SUFFIX-matched, not `^\.\/…` (2026-08-31). A plugin `filter` is tested against
			// the specifier as the resolver hands it over, and anchoring on the leading
			// `./` asserted it arrives VERBATIM from the source. On the Linux CI runner it
			// does not, so this hook alone stopped firing and the REAL module loaded:
			//   ReferenceError: DOMParser is not defined
			//     at html_to_markdown (tools/tool_lang/js/markdown_utils.js:67)
			// The gate was green on macOS and red on every GitHub run — one of the two
			// reasons the hermetic tier stayed red after its lint and tripwire debt was
			// paid. The client-stub hook above never had the problem because it was
			// already suffix-matched; this is the same shape, and the importer guard (not
			// the anchor) is what keeps the hook confined to tools/tool_lang/js.
			build.onResolve({ filter: /markdown_utils\.js$/ }, (args) =>
				importerIsToolLang(args.importer)
					? { path: 'markdown-stub', namespace: 'tool-lang-md-stub' }
					: undefined,
			);
			build.onLoad({ filter: /.*/, namespace: 'tool-lang-md-stub' }, () => ({
				contents:
					'export const html_to_markdown = (html) => String(html);\n' +
					'export const markdown_to_html = (markdown) => String(markdown);\n' +
					'export const group_markdown_into_chunks = (markdown) => String(markdown).split(/(?=<p>)/).filter(Boolean);\n',
				loader: 'js',
			}));
		},
	});

	/** A DOM node with only what the tool's status/overlay writes touch. */
	function fakeNode(): Record<string, any> {
		const node: Record<string, any> = {
			className: '',
			textContent: '',
			innerHTML: '',
			innerText: '',
			children: [] as unknown[],
			classList: { add: () => {}, remove: () => {} },
			appendChild: (child: unknown) => {
				node.children.push(child);
			},
			replaceChildren: (...children: unknown[]) => {
				node.children = children;
			},
		};
		return node;
	}

	/** Every line of text the status area ended up carrying, flattened. */
	function statusLines(container: Record<string, any>): string[] {
		const lines: string[] = [];
		for (const child of container.children as Record<string, any>[]) {
			if (typeof child.textContent === 'string' && child.textContent !== '')
				lines.push(child.textContent);
			for (const line of (child.children ?? []) as Record<string, any>[]) {
				if (typeof line.textContent === 'string') lines.push(line.textContent);
			}
		}
		if (typeof container.innerHTML === 'string' && container.innerHTML !== '')
			lines.push(container.innerHTML);
		// innerText is a WRITE channel the client could use on this fake node: reading it
		// back is what catches such a write — textContent would read a different property.
		// biome-ignore lint/performance/useDomNodeTextContent: reads the fake node's innerText slot (see above).
		if (typeof container.innerText === 'string' && container.innerText !== '')
			// biome-ignore lint/performance/useDomNodeTextContent: same slot as above.
			lines.push(container.innerText);
		return lines;
	}

	describe(LEGS.translation, () => {
		/** The stored, human-made Spanish text the run must not overwrite. */
		const STORED = '<p>El texto humano existente, revisado por la archivera.</p>';

		async function runTranslation(messages: { status: string; data: Record<string, unknown> }[]) {
			const globals = globalThis as Record<string, any>;
			const savedDocument = globals.document;
			const savedWorker = globals.Worker;
			let worker: Record<string, any> | null = null;
			globals.document = { createElement: () => fakeNode() };
			globals.Worker = class {
				onmessage: ((event: { data: unknown }) => void) | null = null;
				onerror: ((event: unknown) => void) | null = null;
				posted: unknown[] = [];
				constructor() {
					worker = this as unknown as Record<string, any>;
				}
				postMessage(message: unknown) {
					this.posted.push(message);
				}
				terminate() {}
			};
			try {
				const { translate_component_browser, dispose_browser_worker } = await import(
					'../../tools/tool_lang/js/browser_translation.js'
				);
				// the worker is a MODULE-LEVEL singleton (it caches the ~1.5 GB model), so a
				// second run in this file would reuse the first run's stub and never construct
				// one. dispose_browser_worker is the tool's own way of dropping it.
				dispose_browser_worker();
				const saves: unknown[] = [];
				const target: Record<string, any> = {
					data: { value: [STORED], entries: [{ id: 7, value: STORED }] },
					save: (items: unknown) => {
						saves.push(items);
						return Promise.resolve({ result: true });
					},
					refresh: () => Promise.resolve(true),
				};
				const status = fakeNode();
				const promise = translate_component_browser({
					source_component: { data: { entries: [{ id: 7, value: '<p>One.</p><p>Two.</p>' }] } },
					target_component: target,
					source_lang: 'lg-eng',
					target_lang: 'lg-spa',
					// the .d.ts types this as an HTMLElement; the fake carries exactly the
					// properties the tool writes to and nothing else.
					status_container: status as unknown as HTMLElement,
					// get_label returns null for an unknown key in the real client
					// (tools_common/js/tool_common.js get_tool_label), which is what makes the
					// English literals fire.
					get_label: () => null,
				});
				// the orchestrator awaits get_json_langs before it builds the worker
				await new Promise((done) => setTimeout(done, 20));
				if (worker === null) throw new Error('the tool never created its worker');
				for (const message of messages) {
					(worker as Record<string, any>).onmessage({ data: message });
				}
				let rejected = false;
				let resolved: unknown = null;
				await promise.then(
					(value: unknown) => {
						resolved = value;
					},
					() => {
						rejected = true;
					},
				);
				return { saves, target, status, rejected, resolved };
			} finally {
				globals.document = savedDocument;
				globals.Worker = savedWorker;
			}
		}

		test('one failed block: no save, no success, the stored value byte-unchanged', async () => {
			const { saves, target, status, rejected } = await runTranslation([
				// the partial translation is streamed into the LIVE instance data first —
				// leaving it there would hand the next save of that component a machine-made
				// fragment to persist, which is the same overwrite, deferred
				{ status: 'on_chunk', data: { remaining: 1, accumulated_text: '<p>Uno.</p>' } },
				{ status: 'on_block_error', data: { block: 2, total: 2, message: 'inference timeout' } },
				// `end` is byte-identical to a complete run's: the worker says nothing about
				// the block it skipped. Only the main thread's own count knows.
				{ status: 'end', data: { remaining: 0, accumulated_text: '<p>Uno.</p>' } },
			]);

			expect(saves, 'the tool SAVED a translation that lost a block').toEqual([]);
			expect(target.data.value, 'the stored value did not come back').toEqual([STORED]);
			expect(target.data.entries).toEqual([{ id: 7, value: STORED }]);
			expect(rejected, 'the run resolved — both callers count a resolve as success').toBe(true);

			const lines = statusLines(status).join('\n');
			expect(lines, 'the operator was told it completed').not.toContain('completed');
			expect(lines).toContain('2/2');
			expect(lines, 'the operator is not told the existing text is intact').toContain(
				'Nothing was saved',
			);
		});

		test('the same run WITHOUT a failed block saves — the refusal is not a blanket refusal', async () => {
			// The counterfactual. A gate that only proves "it did not save" would also pass on
			// a tool that never saves anything.
			const { saves, rejected, resolved } = await runTranslation([
				{ status: 'on_chunk', data: { remaining: 1, accumulated_text: '<p>Uno.</p>' } },
				{ status: 'end', data: { remaining: 0, accumulated_text: '<p>Uno.</p><p>Dos.</p>' } },
			]);
			expect(rejected).toBe(false);
			expect(saves.length, 'a complete run must still save').toBe(1);
			expect((resolved as { result?: boolean } | null)?.result).toBe(true);
		});

		test('an empty result is refused too — it would BLANK the target language', async () => {
			const { saves, target, rejected } = await runTranslation([
				{ status: 'end', data: { remaining: 0, accumulated_text: '' } },
			]);
			expect(saves).toEqual([]);
			expect(target.data.value).toEqual([STORED]);
			expect(rejected).toBe(true);
		});
	});

	// ---------------------------------------------------------------------------
	// LEG 3 — the one other transform this census calls LOSSLESS really is
	// ---------------------------------------------------------------------------

	describe(LEGS.timecode, () => {
		test('markup, entities and text survive a timecode offset byte-exactly', () => {
			const stored =
				'<p>[TC_00:00:10.000_TC]Dijo <em>&#39;non sei&#39;</em> &amp; call&oacute;.<br>Sigui&oacute;.</p>' +
				'<p>[TC_00:00:40.000_TC]Y <span class="uncertain">lectura dudosa</span>.</p>';
			const { text } = replaceTimecodes(stored, 5);
			// every non-mark character is identical: strip the marks from both sides.
			const withoutMarks = (value: string) => value.replace(/\[TC_[^\]]*_TC\]/g, '[TC]');
			expect(withoutMarks(text)).toBe(withoutMarks(stored));
			// and the marks really moved, or the assertion above is vacuous
			expect(text).toContain('[TC_00:00:15.000_TC]');
			expect(text).toContain('[TC_00:00:45.000_TC]');
		});
	});

	// ---------------------------------------------------------------------------
	// LEG 4 — THE CENSUS
	// ---------------------------------------------------------------------------

	/**
	 * The CLIENT component-value write doors. A tool action that calls one of these writes a
	 * component's value, which is the only definition of "write-back door" that cannot be
	 * gamed by renaming a handler.
	 *
	 * `.set_value(` is in the list because the P0-12 action itself goes through it:
	 * `component_text_area.prototype.set_value` (client/dedalo/core/component_text_area/js/
	 * component_text_area.js:554) builds an `update` atom and calls `change_value`, i.e. it
	 * saves. On other models it does not — `component_json.prototype.set_value` only stages
	 * the value — which is what the `no-persist` verdict is for.
	 *
	 * The SERVER doors are not listed: they are DERIVED (the writer closure, below).
	 */
	const CLIENT_DOORS = ['.save(', '.change_value(', '.set_value('];

	/**
	 * One (action, door) cell. The verdict lives HERE, never on the row: a new door on a
	 * known action can not inherit the verdict of the doors beside it. Each verdict carries
	 * the evidence its check reads, and the union makes `tsc` refuse a cell without it.
	 */
	type Cell = {
		reason: string;
		sites?: number;
		/**
		 * Why this write may reach the matrix PAST the record-write chokepoint (the door
		 * resolves to a seed on a path that avoids every RECORD_WRITE_CHOKEPOINTS unit —
		 * see the bypass rule). Any verdict may carry it; a bypassing cell needs it unless
		 * it is PENDING or lossless over a locked read.
		 */
		bypass_reason?: string;
	} & (
		| ({ verdict: 'lossless'; lockedRead?: true } & (
				| { proof: LegTitle; readVerified?: true }
				| { readVerified: true; proof?: LegTitle }
		  ))
		| { verdict: 'confirmed' }
		| {
				verdict: 'refuses';
				must_contain: string;
				/** `file#decl` whose body carries the refusal; the action must REACH it. */
				evidence?: string;
		  }
		| { verdict: 'PENDING'; closes: string }
		| {
				verdict:
					| 'operator-value'
					| 'new-record'
					| 'no-persist'
					| 'not-a-component-write'
					| 'derived-state';
		  }
	);

	interface CensusRow {
		doors: Readonly<Record<string, Cell>>;
	}

	/**
	 * The census. The key is `<file> :: <top-level symbol enclosing the door call>` — the
	 * ACTION, not the file: P0-12 is exactly the shape where one action in a file is lossy
	 * and another beside it is not (tool_transcription's regroup_paragraphs vs
	 * save_transcription). Server doors are closure members by bare name (`file#name` when
	 * the bare name is ambiguous); client doors are the tokens above.
	 */
	/**
	 * The closure item of the translation empty-body defect (found 2026-09-30 by deriving
	 * the server doors). CLOSURE_PLAN Step 2 has NO such item yet: its insertion is an
	 * integrator request (the plan is integrator-owned) — until it lands this names the
	 * finding, not an existing plan row.
	 */
	const TRANSLATION_EMPTY_BODY =
		'TOOLS-6 finding 2026-09-30 (proposed CLOSURE_PLAN Step 2 item TRANSLATION-EMPTY-BODY, integrator request): the server translation must refuse an EMPTY provider body (server twin of CLI-14 LEG 2)';

	/**
	 * The BYPASS REASONS (see the bypass rule): why a tool write may reach the matrix past
	 * every record-write chokepoint. Each names the off-chokepoint WRITER the derivation
	 * lands on (the `bypass:` path of a red names it too) and the write_obligations
	 * RAW_CALLER_EXEMPT row that already carries it — one reason per writer, shared by the
	 * cells that reach it, so a cell cannot restate a writer's contract differently.
	 */
	const BYPASS = {
		filesInfo:
			'files_info is written by media/tools/files_info_persist.ts#writeItems (updateMatrixKeysData) past the chokepoint BY DESIGN (a SANCTIONED_DERIVED_WRITERS unit, write_obligations RAW_CALLER_EXEMPT): technical metadata derived from the files on disk — no modified stamp, no Time Machine row, no obligation hook. Its ONE caller is the LOCKED TRANSFORM (transformStoredMediaItems, CLOSURE_PLAN Step 2 / TOOLS-5): the stored items are read under readMatrixKeyForUpdate and the new ones computed FROM THEM in the same transaction, so a concurrent write is never reverted; what goes unrecorded is files_info’s own history, which a disk re-scan re-derives.',
		drawingReset:
			'the DELETE-TIME drawing reset rides the media-key writer past the chokepoint BY DESIGN: when the delete removed the record’s LAST media file, the drawing that belonged to that picture is cleared (lib_data → null, svg_file_data dropped) in the SAME locked transform, and the cleared value is appended to the Time Machine with recordTimeMachine in the same transaction. The operator’s delete is the decision; the prior drawing is the previous TM version, so nothing is silently lost.',
		metadataTwin:
			'the `data`-column METADATA twin is written by section/record/record_metadata.ts#setRecordMetadata (updateMatrixRecord) past the chokepoint BY DESIGN (write_obligations RAW_CALLER_EXEMPT): system bookkeeping MERGED into the column (created_date / created_by_user_id only; label and diffusion_info kept), mirrored from the dd199/dd200 audit value — no component value changes, so no stamp, no history, no index.',
		hierarchy:
			'the HIERARCHY INVARIANT single writer (ontology/hierarchy_state.ts#write, #nameRootTerm), the `<tld>0` provisioning (hierarchy_provision.ts#provisionVirtualSections) and the ontology definition writers (ontology_write.ts#writeOntologyMainKey, #createParentGrouper) write past the chokepoint BY DESIGN (write_obligations RAW_CALLER_EXEMPT): registry, descriptor and definition rows derived from the hierarchy record, with unstamped saves as in PHP — no Time Machine row, no obligation hook.',
		ontology:
			'ontology DEFINITION rows — the main node and parent-grouper records in matrix_ontology (ontology/ontology_write.ts#writeOntologyMainKey, #createParentGrouper) — are written past the chokepoint BY DESIGN (write_obligations RAW_CALLER_EXEMPT): system definitions re-derived from the ontology records by the write driver, which has its own gates; unstamped as in PHP, and no curated value is transformed.',
	} as const;

	const CENSUS: Record<string, CensusRow> = {
		// --- THE TWO P0-12 ACTIONS -------------------------------------------
		'tools/tool_transcription/js/tool_transcription.js :: tool_transcription.prototype.regroup_paragraphs':
			{
				doors: {
					'.set_value(': {
						verdict: 'confirmed',
						reason:
							'CLI-24. The rebuild is now markup- and entity-preserving (LEG 1 above), but not for every shape a stored value can take: unbalanced markup is REPAIRED rather than reproduced, and a fragment with markup but no words is dropped. So the rebuilt value is MEASURED against the current one and the operator confirms, with the words/tags that would be lost named in the dialog.',
					},
				},
			},
		'tools/tool_lang/js/browser_translation.js :: translate_component_browser': {
			doors: {
				'.save(': {
					verdict: 'refuses',
					must_contain: 'refuse_run(',
					reason:
						'CLI-14. The worker skips a failed block and posts an `end` indistinguishable from a complete run, so the main thread counts the on_block_error messages itself and REFUSES: nothing is saved, the streamed partial is put back, the lost blocks are named and the promise rejects (a resolve would be counted as ok by both callers). Proved by LEG 2 above.',
				},
			},
		},

		'tools/tool_lang/js/render_tool_lang.js :: get_content_data_edit': {
			doors: {
				'.save(': {
					verdict: 'confirmed',
					reason:
						'the "copy value" button of tool_lang writes the SOURCE language’s value over the target language’s, verbatim (no transform), and only after a confirm() in the same handler — the operator is asking for the overwrite.',
				},
			},
		},

		// --- LOSSLESS ---------------------------------------------------------
		'tools/tool_tc/server/index.ts :: changeAllTimecodes': {
			doors: {
				saveComponentData: {
					verdict: 'lossless',
					proof: LEGS.timecode,
					reason:
						'the timecode offset rewrites ONLY the [TC_…_TC] marks (replaceTimecodes is a mark-for-mark substitution over the raw string) and clones every element of the slice it does not touch verbatim, so no other character of the transcription can change.',
				},
			},
		},
		'tools/tool_update_cache/server/index.ts :: updateCache': {
			doors: {
				saveComponentData: {
					verdict: 'new-record',
					reason:
						'one call: the dd800 run label on the bulk-process record created in the same transaction (the regenerate re-save moved to resaveUnderRowLock, its own cell). Nothing stored is replaced.',
				},
				transformStoredMediaItems: {
					verdict: 'derived-state',
					bypass_reason: BYPASS.filesInfo,
					reason:
						'the MEDIA branch (CLOSURE_PLAN Step 2, TOOLS-5 closed): the derivative files are rebuilt from this run’s snapshot OUTSIDE any lock, then the files_info index is re-derived from the items read UNDER the row lock (a shrink only the locked value shows is held) and written by the one media-key writer — a curator’s concurrent upload is refreshed, never reverted to the snapshot. files_info is disk-derived state; no curated value is transformed (decision D4: no undo pair).',
				},
				createSectionRecord: {
					verdict: 'new-record',
					reason:
						'mints the dd800 bulk-process record of the run (created in the same transaction as its label, before any record is touched). Nothing stored is replaced.',
				},
			},
		},

		'tools/tool_update_cache/server/index.ts :: resaveUnderRowLock': {
			doors: {
				saveComponentData: {
					verdict: 'lossless',
					lockedRead: true,
					readVerified: true,
					reason:
						'the regenerate re-saves, per language group, the items READ UNDER THE ROW LOCK in the same transaction (readMatrixKeyForUpdate, then readComponentItems on the locked record → groupItemsByLang → set_data per lang), under the run’s bulkProcessId: the undo log records each BEFORE/AFTER pair, and a canonical no-op writes none (WC-2026-09-27-bulk-revert-undo-log). A concurrent edit committed before the lock is what gets re-saved, never the run’s snapshot; a record deleted meanwhile is not recreated; a refused group — an ok:false answer or a thrown caller/permission refusal — rolls the whole component back and the sweep goes on (WC-2026-10-21-update-cache-locked-resave; gates update_cache_locked_resave_native, update_cache_refused_resave_native).',
				},
			},
		},

		// --- OPERATOR-VALUE (not a write-back) --------------------------------
		'tools/tool_cataloging/js/tool_cataloging.js :: tool_cataloging.prototype.init': {
			doors: {
				'.change_value(': {
					verdict: 'operator-value',
					reason:
						'inserts the locator of the thesaurus term the curator just created into the portal (action:insert). The written value comes from that pick, not from the value it joins, and nothing stored is replaced.',
				},
			},
		},
		'tools/tool_identify/js/tool_identify.js :: tool_identify.prototype.accept_proposal': {
			doors: {
				'.change_value(': {
					verdict: 'operator-value',
					reason:
						'writes the identification proposal the curator explicitly accepted, through the changed_data atom the component itself would have built. The value is the proposal, never a transform of what the component already held.',
				},
			},
		},
		'tools/tool_identify/js/tool_identify.js :: tool_identify.prototype.name_type_record': {
			doors: {
				'.change_value(': {
					verdict: 'operator-value',
					reason:
						'writes the operator-supplied name into the FIRST EMPTY entry of the component, appending when there is none — it selects an empty slot precisely so it never overwrites an existing value.',
				},
			},
		},
		'tools/tool_identify/js/tool_identify.js :: tool_identify.prototype.attach_members': {
			doors: {
				'.change_value(': {
					verdict: 'operator-value',
					reason:
						'inserts the locator of the type record the operator is attaching (action:insert, with from_component_tipo). The engine drops a duplicate; no stored value is read, transformed or replaced.',
				},
			},
		},
		'tools/tool_numisdata_order_coins/js/tool_numisdata_order_coins.js :: tool_numisdata_order_coins.prototype.assign_element':
			{
				doors: {
					'.change_value(': {
						verdict: 'operator-value',
						reason:
							'inserts the locator of the element the operator assigned in the ordering UI (action:insert on the caller component). Nothing that is stored is read back and rewritten.',
					},
				},
			},
		'tools/tool_numisdata_order_coins/js/tool_numisdata_order_coins.js :: tool_numisdata_order_coins.prototype.set_original_copy':
			{
				doors: {
					'.change_value(': {
						verdict: 'operator-value',
						sites: 3,
						reason:
							'writes the original/copy classification the operator set on the screen: a fixed discard locator per record and the equivalents list built from the nodes they ticked. The values come from the UI state, not from the stored ones they replace.',
					},
				},
			},
		'tools/tool_import_files/server/index.ts :: setComponentsData': {
			doors: {
				saveComponentData: {
					verdict: 'operator-value',
					sites: 3,
					reason:
						'writes the values the import run itself carries — target_filename, target_date and the operator-declared input-component mapping — into the destination record. The written value comes from the imported file and the mapping, never from the destination value it replaces.',
				},
			},
		},
		'tools/tool_import_files/server/index.ts :: importFiles': {
			doors: {
				processUploadedFile: {
					verdict: 'operator-value',
					bypass_reason: BYPASS.filesInfo,
					reason:
						'ingests the file the operator is importing into the target media component (derivatives built from THAT file; an AV transcode re-scans files_info under the row lock when it ends). The written files_info describes the imported file, never a transform of the stored one.',
				},
				persistUploadedMedia: {
					verdict: 'operator-value',
					bypass_reason: BYPASS.filesInfo,
					reason:
						'records the imported file on the media item: the stored items are RE-READ under the row lock (readMatrixKeyForUpdate) and only that language item’s files_info and name keys are set from the new file; the other items and languages are kept verbatim.',
				},
				createSectionRecord: {
					verdict: 'new-record',
					sites: 3,
					reason:
						'the three record births of an import: the explicit-id host named by the file, the fresh host for an unnamed file, and the fresh record of the section_resource mode — each written only onto the record it has just created.',
				},
				saveComponentData: {
					verdict: 'new-record',
					sites: 2,
					reason:
						'the portal branches: add_new_element creates the media record in the portal target and links it from the host. The write targets the record it just created, so no stored value is overwritten by it.',
				},
			},
		},
		'tools/tool_import_dedalo_csv/server/index.ts :: importFiles': {
			doors: {
				executeCsvImport: {
					verdict: 'operator-value',
					bypass_reason: BYPASS.metadataTwin,
					reason:
						'writes the values of the CSV the operator uploaded and mapped, keyed by the file’s own section_id column. The written values come from the file, never from a transform of the stored value they replace; the run is a dd800 bulk process with its undo log.',
				},
			},
		},
		'tools/tool_import_marc21/server/index.ts :: importFiles': {
			doors: {
				importMappedRecords: {
					verdict: 'operator-value',
					reason:
						'writes the MARC21 records the operator imports, through the field mapping they declared: one set_data per mapped field of each record. The values come from the imported file, never from the value they replace.',
				},
			},
		},
		'tools/tool_import_zotero/server/index.ts :: importFiles': {
			doors: {
				importMappedRecords: {
					verdict: 'operator-value',
					reason:
						'writes the Zotero export the operator imports, through the declared field mapping: one set_data per mapped field of each record. The values come from the imported file, never from the value they replace.',
				},
			},
		},
		'tools/tool_import_rdf/server/rdf_import_execute.ts :: saveItems': {
			doors: {
				saveComponentData: {
					verdict: 'operator-value',
					reason:
						'writes the values of the remote RDF resource the operator imports, mapped through the external ontology. NEVER a replace of a stored value: a literal only into an EMPTY language slice, IRIs and locators as an appendImport merge (stored items kept byte-for-byte, duplicates skipped), a single-choice model only when it holds nothing. Gate: rdf_import_execute_native.',
				},
			},
		},
		'tools/tool_import_rdf/server/rdf_import_execute.ts :: bornRecord': {
			doors: {
				createSectionRecord: {
					verdict: 'new-record',
					reason:
						'the birth of a linked term no visible record carries (found first through findSectionIdByCode on its identifier) or of an intermediate record no linked record leads to through its ddo_map path; the run then writes only onto the record it has just created, with the run’s birth marker.',
				},
			},
		},
		'tools/tool_import_rdf/server/rdf_import_execute.ts :: bulkId': {
			doors: {
				'src/core/tools/import_execute.ts#createBulkProcessRecord': {
					verdict: 'new-record',
					reason:
						'the run’s own dd800 bulk-process record, minted LAZILY by the run’s first write or create (inside that op’s savepoint, before its row is touched; a rolled-back mint is forgotten) — the revert handle every TM row of the run carries. A run that changes nothing mints none.',
				},
			},
		},
		// --- ACQUISITION TOOLS (harvested source → records born in the same call) ---
		'tools/tool_numisdata_acquisition/server/index.ts :: commitOneLot': {
			doors: {
				createSectionRecord: {
					verdict: 'new-record',
					reason:
						'births the NUMISDATA_OBJECT_TIPO lot record — only after findExistingLot (Auction relation + Inventory number) and findExistingLotByUrl (normalised SOURCE_URI_TIPO source URL), principal-scoped search-layer lookups RE-RUN under the per-key advisory locks (fixed order: lot key, then URL key) in the same transaction, both miss. A match returns `skipped` and writes NOTHING to the pre-existing record.',
				},
			},
		},
		'tools/tool_numisdata_acquisition/server/index.ts :: writeField': {
			doors: {
				saveComponentData: {
					verdict: 'new-record',
					reason:
						'a single set_data of a harvested auction value (weight, diameter, lot number, date, obverse/reverse design or the remark fallback; the Auction’s number&title and code; the Entity’s name). Every caller hands it a section_id createSectionRecord returned in the SAME transaction (commitOneLot’s lot, findOrCreateAuction’s Auction, resolveCompanyEntityId’s Entity) — a found record is never written, so no stored value is replaced.',
				},
			},
		},
		'tools/tool_numisdata_acquisition/server/index.ts :: writeIriField': {
			doors: {
				saveComponentData: {
					verdict: 'new-record',
					reason:
						'writes the normalised lot source URL (SOURCE_URI_TIPO, the URL dedup key) onto the lot record commitOneLot created in the same transaction; never onto a found lot.',
				},
			},
		},
		'tools/tool_numisdata_acquisition/server/index.ts :: findOrCreateAuction': {
			doors: {
				createSectionRecord: {
					verdict: 'new-record',
					reason:
						'births the AUCTION_SECTION_TIPO Auction only when findExistingAuction (the (Entity, Code) relation+text SQO, principal-scoped) misses RE-RUN under the advisory lock on (entity, number) inside one transaction; a found Auction is returned and linked, never written.',
				},
			},
		},
		'tools/tool_numisdata_acquisition/server/index.ts :: resolveCompanyEntityId': {
			doors: {
				createSectionRecord: {
					verdict: 'new-record',
					reason:
						'births the ENTITY_SECTION_TIPO Entity only for an explicit “create” selection, and only when findEntityByExactName (principal-scoped `==` search) misses RE-RUN under the advisory lock on the folded name (foldNameForLock, coarser than the search equality); an existing Entity — picked, or matched — is only ever a locator target, never written.',
				},
			},
		},
		'tools/tool_numisdata_acquisition/server/index.ts :: linkCompany': {
			doors: {
				saveComponentData: {
					verdict: 'new-record',
					reason:
						'set_data of the Company locator (AUCTION_COMPANY_TIPO → ENTITY_SECTION_TIPO) on the Auction findOrCreateAuction created in the same transaction — its only caller, on the create branch. A found Auction’s company is never touched.',
				},
			},
		},
		'tools/tool_numisdata_acquisition/server/index.ts :: linkAuction': {
			doors: {
				saveComponentData: {
					verdict: 'new-record',
					reason:
						'set_data of the Auction locator (AUCTION_RELATION_TIPO) on the lot commitOneLot created in this call — reached only past the `skipped` return, so a pre-existing lot is never re-linked. It runs INSIDE the lot’s birth transaction (the same withTransaction that creates it), so no committed state of the new lot exists that it could replace; a failed link rolls the whole lot back.',
				},
			},
		},
		'tools/tool_numisdata_acquisition/server/index.ts :: linkType': {
			doors: {
				saveComponentData: {
					verdict: 'new-record',
					reason:
						'set_data of the Type locator (TYPE_RELATION_TIPO) to an EXISTING TYPE_SECTION_TIPO record matched read-only (findExistingType — a Type is never created), on the lot commitOneLot created in this call, past the `skipped` return. The Type is matched read-only BEFORE the transaction (matchLotType); the link runs INSIDE the lot’s birth transaction, like linkAuction.',
				},
			},
		},
		'tools/tool_numisdata_acquisition/server/index.ts :: importImagePair': {
			doors: {
				saveComponentData: {
					verdict: 'new-record',
					reason:
						'add_new_element on the OBVERSE_PORTAL_TIPO / REVERSE_PORTAL_TIPO obverse/reverse portals of the lot commitOneLot created in this call: births one IMAGE_SECTION_TIPO image record per face and appends its locator. Nothing stored is read or replaced.',
				},
				processUploadedFile: {
					verdict: 'new-record',
					bypass_reason: BYPASS.filesInfo,
					reason:
						'ingests one cropCoinPair face (the harvested lot image, split by crop_50) into IMAGE_COMPONENT_TIPO of the IMAGE_SECTION_TIPO record the portal add_new_element just created; transcodes start only once both faces are in.',
				},
				persistUploadedMedia: {
					verdict: 'new-record',
					bypass_reason: BYPASS.filesInfo,
					reason:
						'records that face’s files_info and name keys on IMAGE_COMPONENT_TIPO of the IMAGE_SECTION_TIPO record born in this call (stored items re-read under the row lock); the record held no media before.',
				},
			},
		},
		'tools/tool_numisdata_acquisition/server/index.ts :: removeCreatedImageRecords': {
			doors: {
				deleteSectionRecord: {
					verdict: 'new-record',
					reason:
						'the all-or-nothing undo of a failed face pair: deletes ONLY the IMAGE_SECTION_TIPO records this same importImagePair call created (ids pushed from its own add_new_element created_section_id, never a lookup or the payload); the delete door also strips their locators from the lot born in this call. A failed delete is logged and reported as images_orphaned. HONEST LIMIT: no holdsForeignValue-style precondition — a locator a curator added to the fresh IMAGE_SECTION_TIPO record in the seconds since its birth would be stripped with it.',
				},
			},
		},
		'tools/tool_bibliography_acquisition/server/index.ts :: commitOnePublication': {
			doors: {
				createSectionRecord: {
					verdict: 'new-record',
					reason:
						'births the PUBLICATION_TIPO publication only when findExistingPublication (the CODE_TIPO Code, principal-scoped `==` SQO) misses — checked once, then RE-CHECKED under the advisory lock on the code in the same transaction. A match returns `skipped` and writes NOTHING to the pre-existing record (“rather than risk clobbering a cataloger’s later edits”).',
				},
			},
		},
		'tools/tool_bibliography_acquisition/server/index.ts :: writeField': {
			doors: {
				saveComponentData: {
					verdict: 'new-record',
					reason:
						'a single set_data of a harvested OAI-PMH value (code, title, pages, abstract per planned lang, publisher, series number, personal-name text, ISSN; the Series name; the Person surname/given name). Every caller hands it a section_id createSectionRecord returned in the SAME transaction (commitOnePublication, findOrCreateSeries, findOrCreatePerson) — a found record is never written.',
				},
			},
		},
		'tools/tool_bibliography_acquisition/server/index.ts :: writeIriField': {
			doors: {
				saveComponentData: {
					verdict: 'new-record',
					reason:
						'set_data of the landing-page URL (URL_TIPO) and of the PDF URL (PDF_URI_TIPO, resolved BEFORE the transaction) — both INSIDE the publication’s birth transaction, onto the PUBLICATION_TIPO record commitOnePublication creates there, past its `skipped` returns. Only the PDF bytes’ media ingest runs after commit.',
				},
			},
		},
		'tools/tool_bibliography_acquisition/server/index.ts :: writeDateField': {
			doors: {
				saveComponentData: {
					verdict: 'new-record',
					reason:
						'set_data of the parsed dc:date `start` (PUBLICATION_DATE_TIPO) onto the PUBLICATION_TIPO record created in the same transaction.',
				},
			},
		},
		'tools/tool_bibliography_acquisition/server/index.ts :: linkFixedTerm': {
			doors: {
				saveComponentData: {
					verdict: 'new-record',
					reason:
						'set_data of a FIXED thesaurus locator (TYPOLOGY_RELATION_TIPO → dd810/8 “journal article”, STANDARD_NUMBER_TYPE_RELATION_TIPO → dd292/2 “ISSN”) onto the PUBLICATION_TIPO record created in the same transaction; the terms themselves are never written.',
				},
			},
		},
		'tools/tool_bibliography_acquisition/server/index.ts :: findOrCreateSeries': {
			doors: {
				createSectionRecord: {
					verdict: 'new-record',
					reason:
						'births the SERIES_SECTION_TIPO Series only when findExistingSeries (principal-scoped `==` narrowing + byte-exact compare over every stored item) misses RE-RUN under the advisory lock on the folded name; a found Series is only a locator target, never written.',
				},
			},
		},
		'tools/tool_bibliography_acquisition/server/index.ts :: findOrCreatePerson': {
			doors: {
				createSectionRecord: {
					verdict: 'new-record',
					reason:
						'births the PEOPLE_SECTION_TIPO Person only when findExistingPerson ((surname, given name) `==` narrowing + byte-exact compare of both over every stored item) misses RE-RUN under the advisory lock on the folded pair; a found Person is only a locator target, never written.',
				},
			},
		},
		'tools/tool_bibliography_acquisition/server/index.ts :: linkSeries': {
			doors: {
				saveComponentData: {
					verdict: 'new-record',
					reason:
						'set_data of the Series locator (SERIES_RELATION_TIPO) on the PUBLICATION_TIPO record commitOnePublication created in this call, past its `skipped` returns; an existing Series is the locator TARGET, never written. The Series is found or created in its own locked transaction BEFORE the birth transaction; the link runs INSIDE the birth transaction, so no committed state of the new publication exists that it could replace.',
				},
			},
		},
		'tools/tool_bibliography_acquisition/server/index.ts :: linkAuthors': {
			doors: {
				saveComponentData: {
					verdict: 'new-record',
					reason:
						'ONE set_data of every resolved Person locator (AUTHORSHIP_RELATION_TIPO) on the PUBLICATION_TIPO record created in this call, past its `skipped` returns; existing People are locator TARGETS, never written. People are resolved before the birth transaction; the link runs INSIDE it, like linkSeries.',
				},
			},
		},
		'tools/tool_bibliography_acquisition/server/index.ts :: importDocumentForPublication': {
			doors: {
				processUploadedFile: {
					verdict: 'new-record',
					bypass_reason: BYPASS.filesInfo,
					reason:
						'ingests the harvested PDF (harvestFetch, application/pdf, ≤50 MB) into DOCUMENT_TIPO of the PUBLICATION_TIPO record commitOnePublication created in this call; the record held no document before.',
				},
				persistUploadedMedia: {
					verdict: 'new-record',
					bypass_reason: BYPASS.filesInfo,
					reason:
						'records the PDF’s files_info and name keys on DOCUMENT_TIPO of the PUBLICATION_TIPO record born in this call (stored items re-read under the row lock).',
				},
			},
		},
		'tools/tool_upload/server/index.ts :: processUploaded': {
			doors: {
				processUploadedFile: {
					verdict: 'operator-value',
					bypass_reason: BYPASS.filesInfo,
					reason:
						'ingests the file the operator uploaded into THIS media component: the derivatives are built from that file, and an AV transcode re-scans files_info under the row lock when it ends. Nothing stored is transformed.',
				},
				persistUploadedMedia: {
					verdict: 'operator-value',
					bypass_reason: BYPASS.filesInfo,
					reason:
						'records the uploaded file on the media item: the stored items are RE-READ under the row lock and only that item’s files_info and name keys are set from the new file; the other items and languages are kept verbatim.',
				},
			},
		},
		'tools/tool_propagate_component_data/js/tool_propagate_component_data.js :: tool_propagate_component_data.prototype.get_component_to_propagate':
			{
				doors: {
					'.save(': {
						verdict: 'operator-value',
						reason:
							'saves the entries the operator composed into the tool’s OWN temporal (tmp-section) component, which is the scratch surface the propagation value is edited on — not a curated record.',
					},
				},
			},
		'tools/tool_propagate_component_data/server/index.ts :: propagateOneRecord': {
			doors: {
				saveComponentData: {
					verdict: 'operator-value',
					reason:
						'writes the value the operator chose (replace / add / delete of THEIR items) into one record their SQO matched — the operation they asked for, not a machine transform of the stored value. Since 2026-09-27 it saves through saveComponentData under the run’s bulk id, behind the record lock, so every overwritten region is kept EXACTLY in the run’s undo log (hidden BEFORE + visible after, WC-2026-09-27-bulk-revert-undo-log) and the whole propagation reverts as one operation.',
				},
			},
		},
		'tools/tool_subtitles/js/render_tool_subtitles.js :: get_custom_buttons': {
			doors: {
				'.save(': {
					verdict: 'operator-value',
					reason:
						'the editor’s Save button writes what the operator typed in the subtitle CKEditor of this very session. The value is their edit, not a machine transform applied behind them.',
				},
			},
		},
		'tools/tool_time_machine/server/tool_time_machine.ts :: toolTimeMachineApplyValue': {
			doors: {
				persistRestoredKeys: {
					verdict: 'operator-value',
					reason:
						'restores the component value of the Time Machine version the operator picked, through the COMPONENT-RESTORE chokepoint entry. Overwriting the current value IS the operation, the replaced value stays in the Time Machine, and the restored value is a stored version — nothing is derived or reshaped. (Its relation_search index and observer cascade are the chokepoint’s own derived writes since CLOSURE_PLAN Step 2; when the component is a COVERED set_dato_external mirror, its history row is a past DERIVATION: it lands, is never propagated, and the entry queues the slot’s recompute from the records that reference it NOW — obligation_ledger_native cases 14 and 14d.)',
				},
			},
		},
		'tools/tool_time_machine/server/tool_time_machine.ts :: restoreSectionRow': {
			doors: {
				persistRecordColumns: {
					verdict: 'operator-value',
					reason:
						'the ROW half of the whole-record restore of an operator-picked Time Machine version (restoreSection), written through persistRecordColumns — also the bulk revert’s undelete of a record the run’s cascade deleted, inside the unit that re-links it. Same shape as apply_value: a stored version replaces the current one and the current one remains in the Time Machine.',
				},
			},
		},
		'tools/tool_time_machine/server/tool_time_machine.ts :: restoreAbsentSectionRow': {
			doors: {
				persistRecordBirth: {
					verdict: 'operator-value',
					reason:
						'the bulk revert’s undelete of a record the run’s cascade deleted (WC-2026-09-27-bulk-revert-undo-log): the operator-picked stored snapshot is materialized at its old address through the chokepoint’s INSERT-ONLY birth entry — nothing is written when anything stands there, so no current value is read, transformed or replaced. Its covered observer slots are recomputed, never restored, and its relation_search re-derived (the chokepoint’s own derived writes).',
				},
			},
		},
		'tools/tool_time_machine/server/dataframe_restore.ts :: applyDataframeRestore': {
			doors: {
				persistRecordKeys: {
					verdict: 'operator-value',
					reason:
						'the dataframe half of the same operator-chosen restore: it writes the picked version’s frames OF THAT MAIN back through persistRecordKeys — other mains’ frames of a shared slot, and a lang-sliced main’s surviving other-language frames, are kept verbatim in place. No transform of any value takes place.',
				},
			},
		},
		'tools/tool_time_machine/server/bulk_revert_undo.ts :: writeRevertedKey': {
			doors: {
				persistRestoredKeys: {
					verdict: 'operator-value',
					reason:
						'writes back, per key of an operator-selected bulk run, the region that run REPLACED — read from the run’s undo log (the exact BEFORE image), or inferred from visible history for a pre-undo-log run and reported inexact. The live value is only cut to put the other languages back beside it, never reshaped; the revert writes its own undo pair, so it is reversible in turn. Through the COMPONENT-RESTORE entry: a reverted COVERED set_dato_external mirror is the run’s image of a past derivation — never propagated, recomputed from the records that reference it after the unit’s COMMIT with the key write’s stamp posture (obligation_ledger_native cases 14b/14c).',
				},
			},
		},
		'tools/tool_time_machine/server/bulk_revert_undo.ts :: writeComposedUnit': {
			doors: {
				persistRestoredKeys: {
					verdict: 'operator-value',
					reason:
						'writes back, for a dataframe main of an operator-selected bulk run, the main region and its OWN frames that run REPLACED — both read from the run’s composed undo log (the exact BEFORE image; amendment 2026-09-27). The other mains’ frames of a shared slot are kept in place, never reshaped; the revert writes its own composed undo pairs, so it is reversible in turn.',
				},
			},
		},
		'tools/tool_time_machine/server/bulk_revert_undo.ts :: rederiveMetadataTwin': {
			doors: {
				setRecordMetadata: {
					verdict: 'derived-state',
					bypass_reason: BYPASS.metadataTwin,
					reason:
						're-derives the `data` column metadata twin (created_date / created_by_user_id) from the dd199/dd200 audit value the revert just restored, and writes only when the twin disagrees: bookkeeping mirrored from a component, never a curated value.',
				},
			},
		},
		'tools/tool_time_machine/server/bulk_revert_records.ts :: writeWipedKey': {
			doors: {
				persistRestoredKeys: {
					verdict: 'operator-value',
					reason:
						'writes back, for a frame target record a SOFT dataframe cascade of an operator-selected bulk run wiped, the pre-wipe value of each key — read from the run’s role-4 snapshot. Only keys still in the state the wipe left (isWipedState: empty, or the default-project filter) are written; any other live value refuses the whole record. No transform of the current value; the restore records composed undo pairs per main (recordWipedHistory), so the revert is reversible in turn. Through the COMPONENT-RESTORE entry: a COVERED set_dato_external mirror is put back beside its frames (its ids pair them) but never propagated — recomputed from the records that reference it after COMMIT (obligation_ledger_native case 17b).',
				},
			},
		},
		'tools/tool_time_machine/server/bulk_revert_records.ts :: restoreWipedRecord': {
			doors: {
				requestCoveredSlotRecompute: {
					verdict: 'derived-state',
					reason:
						'after a SOFT-cascade restore puts a wiped record’s keys back (writeWipedKey — a covered observer slot through the COMPONENT-RESTORE entry, never propagated), queues a recompute of every set_dato_external mirror the section declares (the census the wipe shares): the value written is re-derived from the records that reference it, never the snapshot’s copy and never a transform of the live value. (The entry is a RECORD_WRITE_CHOKEPOINT: its drain writes each mirror through persistObserverMirrorKeys.)',
				},
			},
		},
		'tools/tool_time_machine/server/bulk_revert_records.ts :: deleteIfSafe': {
			doors: {
				deleteSectionRecord: {
					verdict: 'refuses',
					must_contain: 'holdsForeignValue(',
					reason:
						'the revert of an operator-selected run deletes a record THAT RUN CREATED — and refuses (keeps the record) when it holds any value the run did not write (holdsForeignValue) or is referenced from elsewhere, checked as a precondition on the locked snapshot inside deleteSectionRecord. A record someone else has since curated is never deleted by the revert.',
				},
			},
		},
		// --- NEW RECORD -------------------------------------------------------
		'tools/tool_export/js/export_user_presets.js :: create_new_export_preset': {
			doors: {
				'.save(': {
					verdict: 'new-record',
					sites: 3,
					reason:
						'three inserts (section tipo, owner, config blob) into the preset record this same function has just created. There is no prior value on that record for the write to replace.',
				},
			},
		},
		'tools/tool_print/js/print_layout_presets.js :: create_new_layout': {
			doors: {
				'.save(': {
					verdict: 'new-record',
					reason:
						'writes the layout blob into the dd25 record created a few lines above (action:insert on a component of a brand-new section_id). Nothing stored is replaced.',
				},
			},
		},
		'tools/tool_posterframe/server/index.ts :: createIdentifyingImage': {
			doors: {
				saveComponentData: {
					verdict: 'new-record',
					reason:
						'creates and links a NEW media record through the portal (add_new_element). The posterframe never lands on top of an existing image record’s value.',
				},
				persistUploadedMedia: {
					verdict: 'new-record',
					bypass_reason: BYPASS.filesInfo,
					reason:
						'records the posterframe file on the image component of the record created a few lines above (created_section_id of the add_new_element save): the first files_info that record ever holds.',
				},
			},
		},
		'tools/tool_import_dedalo_csv/server/index.ts :: createBulkProcessRecord': {
			doors: {
				createSectionRecord: {
					verdict: 'new-record',
					reason:
						'mints the dd800 bulk-process record of a CSV import run — the run’s own audit row, never a curated record.',
				},
				saveComponentData: {
					verdict: 'new-record',
					reason:
						'writes the run label into the dd800 bulk-process record created in the same function — the run’s own audit row, never a curated record.',
				},
			},
		},
		'tools/tool_propagate_component_data/server/index.ts :: createBulkProcess': {
			doors: {
				createSectionRecord: {
					verdict: 'new-record',
					reason:
						'mints the dd800 bulk-process record of a propagation run — the run’s own audit row, never a curated record.',
				},
				saveComponentData: {
					verdict: 'new-record',
					reason:
						'the same bulk-process audit row for a propagation run: label and metadata onto the dd800 record this function just created.',
				},
			},
		},
		'tools/tool_time_machine/server/bulk_revert.ts :: createRevertBulkProcess': {
			doors: {
				createSectionRecord: {
					verdict: 'new-record',
					reason:
						'mints the dd800 bulk-process record of a revert run — the run’s own audit row, never a curated record.',
				},
				persistRecordKeys: {
					verdict: 'new-record',
					reason:
						'the bulk-process audit row of a revert run, written onto the dd800 record created in the same call.',
				},
			},
		},

		// --- DERIVED STATE (the engine re-derives it; a READING judgment) ------
		'tools/tool_image_rotation/server/index.ts :: applyRotation': {
			doors: {
				reconcileStoredFilesInfo: {
					verdict: 'derived-state',
					bypass_reason: BYPASS.filesInfo,
					reason:
						'after rotating the files on disk, re-scans them and reconciles files_info through the single locked writer (items re-read under FOR UPDATE, never minted): files_info is a filesystem-derived cache, not a curated value.',
				},
			},
		},
		'tools/tool_media_versions/server/media_versions.ts :: buildVersion': {
			doors: {
				buildVersionCore: {
					verdict: 'derived-state',
					bypass_reason: BYPASS.filesInfo,
					reason:
						'builds a quality tier from the master file; an AV build finishes in a background job that re-scans the disk and reconciles files_info under the row lock. The only stored write is files_info, derived from the files.',
				},
			},
		},
		'tools/tool_media_versions/server/media_versions.ts :: writeBack': {
			doors: {
				reconcileStoredFilesInfo: {
					verdict: 'operator-value',
					bypass_reason: BYPASS.drawingReset,
					reason:
						'the media-versions write-back: a fresh disk scan reconciled into files_info through the single locked writer (re-read under FOR UPDATE, never minted). On the DELETE that removed the record’s LAST media file, the same locked transform also clears the drawing that belonged to the deleted image (lib_data → null, svg_file_data dropped) and appends the cleared value to the Time Machine in the same transaction — the operator’s delete is the decision, the prior drawing is the previous TM version. build/rotate/sync never set the flag.',
				},
			},
		},
		'tools/tool_media_versions/server/media_versions.ts :: syncFiles': {
			doors: {
				repairStoredFilesInfo: {
					verdict: 'derived-state',
					bypass_reason: BYPASS.filesInfo,
					reason:
						'the operator’s explicit sync_files repair of THIS record: reconciles files_info against a fresh disk scan under the row lock, minting the item only when the component has none and files exist. Filesystem-derived state.',
				},
			},
		},
		'tools/tool_hierarchy/server/tool_hierarchy.ts :: toolHierarchyGenerateVirtualSection': {
			doors: {
				ensureHierarchy: {
					verdict: 'derived-state',
					bypass_reason: BYPASS.hierarchy,
					reason:
						'the HIERARCHY INVARIANT writer (hierarchy_state.ts) provisions the tld’s ontology and hierarchy rows from the hierarchy record: system state derived from that record, not curated content.',
				},
				rebuildHierarchy: {
					verdict: 'derived-state',
					bypass_reason: BYPASS.hierarchy,
					reason:
						'force_to_create: tears the tld’s ONTOLOGY down and re-provisions it through the same invariant writer; the `<tld>1` TERMS are not touched, so the surviving root is relinked afterwards.',
				},
				deleteSectionRecord: {
					verdict: 'derived-state',
					reason:
						'handed to rebuildHierarchy (force_to_create) as its delete callback, through which deleteOntologyByTld removes the tld’s ontology_main REGISTRY row and every `<tld>0` ontology node record (its dd_ontology nodes go directly, not through this door); ensureHierarchy then re-provisions all three from the hierarchy record. The `<tld>1` TERMS are never touched. HONEST LIMIT: a curator’s edit to a `<tld>0` node record or to the ontology_main row is not carried over — force_to_create is the operator’s explicit “rebuild from the hierarchy record”, so the verdict is derived-state, not lossless.',
				},
			},
		},
		'tools/tool_ontology/server/tool_ontology.ts :: toolOntologySetRecords': {
			doors: {
				// setRecordsInDdOntology (the projection route) is no longer a matrix door:
				// since ONT-2 it writes dd_ontology only, through the guarded primitive.
				syncOntologyActivation: {
					verdict: 'derived-state',
					bypass_reason: BYPASS.ontology,
					sites: 2,
					reason:
						"the ontology35 route (ONT-1/2): projection of the registry activation — a tld that still holds rows and DRIFTED is re-derived from its records (ontology_state.rebuildOntology, mainNode 'existing': the registry is read, never written, and the root names its typology grouper without building it); a converged one only has its `<tld>0` root re-planted; a tld with no rows is left empty, and nothing is retracted. It stays a matrix door STATICALLY only because rebuildOntology's 'ensure' main-node branch (ensureMainSection / createParentGrouper) is reachable from it. Ontology DEFINITIONS derived from the matrix_ontology records, with their own gates — not a curated value.",
				},
			},
		},
		'tools/tool_ontology_parser/server/tool_ontology_parser.ts :: toolOntologyParserRegenerate': {
			doors: {
				rebuildOntologies: {
					verdict: 'derived-state',
					bypass_reason: BYPASS.ontology,
					reason:
						'rebuilds the selected tlds’ ontology state (main nodes, parent groupers) through the ontology write driver: definitions re-derived from the ontology records.',
				},
			},
		},
		'tools/tool_ontology_parser/server/tool_ontology_parser.ts :: toolOntologyParserRepairTlds': {
			doors: {
				normalizeOntologyTld: {
					verdict: 'derived-state',
					reason:
						'repair_tlds (developer-only, operator-explicit): rewrites a node record’s `ontology7` to the tld its SECTION requires (requiredOntologyTld — ONT-TLD derives the tld from the section, which is why the edit form renders it read-only). Scope, from normalizeOntologyTld: only rows that ARE nodes (a `string` object carrying a component besides ontology7) and whose declared tld differs; contentless shells are left alone. The value written is derived from the section tipo, never a transform of the value it replaces.',
					bypass_reason:
						'an OFF-HOME psql writer: one `UPDATE "matrix_ontology" SET "string" = jsonb_set(…)` over the whole section on psql’s own connection — no row lock, no birth/modified stamp, NO Time Machine row (the misfiled value it replaces is kept nowhere) and no obligation hook (observers, relation_search). Accepted because the replaced value is a DEFECT the inspect report names, the rewrite is derived and idempotent, and it cannot ride inside rebuild’s transaction (it would block on the rows the transaction holds); its routing through the chokepoint belongs to T2 (off-home DML confinement).',
				},
			},
		},
		'tools/tool_ontology_parser/server/tool_ontology_parser.ts :: PRODUCTION_IO': {
			doors: {
				updateOntologyInfo: {
					verdict: 'derived-state',
					reason:
						'the export’s IO seam: updateOntologyInfo rebuilds the ontology metadata record (ontology18 of dd0/1) from the current ontology and saves it through saveComponentData — a derived descriptor, not curated content.',
				},
			},
		},

		// --- REFUSES (server) ------------------------------------------------
		'tools/tool_transcription/server/index.ts :: backgroundTranscriberPoll': {
			doors: {
				// The poll's SAVE SEAM (closure Step 3, TOOLS-3) is its ONLY write door:
				// pollTranscriptionCompletion has no default save (the save is REQUIRED of
				// its caller), so the handler hands it a save that re-runs the write door
				// for the principal resolved NOW, then calls saveTranscriptionResult itself.
				saveTranscriptionResult: {
					verdict: 'refuses',
					evidence: 'src/core/tools/transcription_asr.ts#saveTranscriptionResult',
					must_contain: 'hasExistingTranscription(',
					reason:
						'the server twin of save_transcription, through the poll’s re-gated save seam: a finished ASR job writes the transcript only when the target language slice is EMPTY — saveTranscriptionResult refuses ("delete the existing data to re-transcribe") when hasExistingTranscription finds any item there, so a curator’s transcript is never replaced; the seam can add an authorization refusal in front of it but never a write past it. Honest limit: the emptiness check reads outside a lock. Behaviour-tethered by the transcription tether, which drives the poll with that same writer as its save.',
				},
			},
		},

		// --- NO PERSIST -------------------------------------------------------
		'tools/tool_dd_label/js/tool_dd_label.js :: tool_dd_label.prototype.update_data': {
			doors: {
				'.set_value(': {
					verdict: 'no-persist',
					reason:
						'flushes the label matrix into the caller component_json’s in-memory value. component_json.prototype.set_value stages a changed_data item and, as its own docblock states, does NOT auto-save — the operator saves the component themselves. The array it writes is the parsed array itself, mutated in place, so entries and object keys the matrix does not display survive.',
				},
			},
		},

		// --- NOT A COMPONENT WRITE -------------------------------------------
		'tools/tool_assistant/js/assistant_controller.js :: assistant_controller': {
			doors: {
				'.save(': {
					verdict: 'not-a-component-write',
					reason:
						'`this._store.save(...)` is conversation_store, the assistant’s localStorage thread persistence (v2 blob). It touches no component and no record; the derivation cannot tell the two `.save(` apart, so the row says which it is.',
				},
			},
		},

		// --- PENDING (real, unconfirmed write-backs) --------------------------
		'tools/tool_transcription/js/tool_transcription.js :: tool_transcription.prototype.save_transcription':
			{
				doors: {
					'.change_value(': {
						verdict: 'PENDING',
						closes:
							'P0-12 residue (GATE-35, audit 2026-09-06): the re-transcription confirm / existence check on save_transcription',
						reason:
							'an automatic-transcription result is written to item 1 of the component’s current language, "replacing whatever it held" (its own docblock), with no confirmation and no comparison against what is there — so launching a re-transcription over a record whose transcript a curator has already edited replaces that work. The previous text does go to the Time Machine. Left open here because the fix is a UI decision on the transcription tool, outside the change that wrote this gate.',
					},
				},
			},
		'tools/tool_lang/server/index.ts :: tool.apiActions.automatic_translation': {
			doors: {
				runAutomaticTranslation: {
					verdict: 'PENDING',
					closes: TRANSLATION_EMPTY_BODY,
					reason:
						'the SERVER half of CLI-14’s tool: translateAndWrite replaces the target language’s items (possibly a human translation) with the provider’s output, under the row lock, with a TM row. A failed call or "Quota exceeded" is refused (translateItems answers items: [] and nothing is written) — but an HTTP 200 with an EMPTY body is accepted as a translation and written, blanking the target language: the exact shape the browser path refuses (LEG 2). Pinned by the empty-body tether (WRITEBACK_TETHERS.emptyBody).',
				},
			},
		},
		'tools/tool_lang_multi/server/index.ts :: tool.apiActions.automatic_translation': {
			doors: {
				runAutomaticTranslation: {
					verdict: 'PENDING',
					closes: TRANSLATION_EMPTY_BODY,
					reason:
						'the same engine as tool_lang (PHP tool_lang_multi delegates), once per target language: a provider’s EMPTY 200 body is written over that language’s items instead of being refused — see the tool_lang cell and the empty-body tether below.',
				},
			},
		},
	};

	/**
	 * PINNED. Shrink-only: this may go DOWN, never up. Counted per CELL.
	 * 2026-09-30 (TOOLS-6): 1 → 4. Not new backlog: the census was blind to server writes
	 * through any engine but four hand-listed names, and deriving the doors found two
	 * PRE-EXISTING defects — updateCache's raw media write (misfiled as lossless; TOOLS-5,
	 * one cell) and the server translation's accepted empty body (one engine, two tool
	 * cells). Each cell names its defect and closure item in `closes`; any further raise
	 * needs one named pre-existing defect and its closure item. 4 → 3 (CLOSURE_PLAN
	 * Step 2): updateCache writes through the locked media-key transform (TOOLS-5).
	 */
	const PENDING_COUNT = 3;

	/**
	 * PINNED, EQUALITY. Tool cells whose door is ITSELF a RAW `matrix_write.ts` primitive or
	 * an OFF-HOME psql writer — the subset of BYPASS_TOOL_CELLS with no wrapper at all.
	 * Shrink-only. 2026-09-30: 2 → 3, not new backlog — seeding the closure with the
	 * off-home psql writers surfaced the PRE-EXISTING repair_tlds × normalizeOntologyTld;
	 * 3 → 1 (CLOSURE_PLAN Step 2): updateCache × updateMatrixKeyData retired (TOOLS-5 —
	 * the media write moved behind the locked transform), and restoreAbsentSectionRow ×
	 * insertMatrixRecordIfAbsent retired (the undelete is the chokepoint's birth entry,
	 * persistRecordBirth). A raw cell that moves behind a wrapper leaves this pin but NOT
	 * the bypass pin: the bypass rule judges it where it lands (updateCache ×
	 * transformStoredMediaItems is a bypass with its reason).
	 */
	const RAW_TOOL_CELLS = 1;

	/**
	 * PINNED, EQUALITY. Tool cells whose door reaches a seed on a path that avoids EVERY
	 * record-write chokepoint (RECORD_WRITE_CHOKEPOINTS, `bypassPath`) — a raw primitive
	 * reached directly or through any number of off-chokepoint wrappers. Each is PENDING,
	 * lossless over a locked read, or carries its `bypass_reason`. Measured 2026-09-30:
	 * 25 (1 PENDING — updateCache × updateMatrixKeyData; 24 reasoned). 25 → 17 (CLOSURE_PLAN
	 * Step 2): the chokepoints own the relation_search index and the observer cascade, so
	 * the six relation-index rebuild cells, the observer-mirror cell and the TM undelete
	 * insert are gone (each is a chokepoint write now); updateCache's media cell stays a
	 * bypass, as the locked transform with its reason. All 17 are reasoned: the files_info
	 * writers, the ontology/hierarchy writers, the metadata twin and the repair_tlds psql
	 * rewrite. A new bypassing cell is red here AND must state its reason; a vanished one
	 * is red until this is lowered. (The ledger's covered-slot recompute entry,
	 * requestCoveredSlotRecompute, is itself a RECORD_WRITE_CHOKEPOINT — it writes nothing
	 * of its own and its drain lands each mirror through persistObserverMirrorKeys — so the
	 * restores that call it are not bypasses; nor are the component restores, whose
	 * persistRestoredKeys entry queues it for a restored mirror.)
	 * 17 → 21 (2026-10-07, PR #114): the two acquisition tools' media ingest — numisdata
	 * importImagePair and bibliography importDocumentForPublication, each × processUploadedFile
	 * and × persistUploadedMedia — the same files_info writers as tool_upload / tool_import_files,
	 * each reasoned with BYPASS.filesInfo. New doors, not backlog.
	 */
	const BYPASS_TOOL_CELLS = 21;

	/**
	 * The tether of every SERVER PENDING cell: what turns red when the defect is fixed
	 * IN PLACE (door unchanged). `{ behaviour }` = a title in WRITEBACK_TETHERS: a test of
	 * tool_lossless_writeback_tethers_native.test.ts (DB tier) that runs the real path and
	 * asserts the defect still happens — that file holds its REGISTERED titles equal to the
	 * list, so deleting or skipping the tether (instead of restating the cells) is red there;
	 * a function = derived facts of the defect over the action's own RESOLVED references,
	 * returning the ones that no longer hold.
	 */
	const SERVER_PENDING_TETHERS: Record<
		string,
		{ behaviour: string } | ((action: string) => string[])
	> = {
		'tools/tool_lang/server/index.ts :: tool.apiActions.automatic_translation × runAutomaticTranslation':
			{ behaviour: WRITEBACK_TETHERS.emptyBody },
		'tools/tool_lang_multi/server/index.ts :: tool.apiActions.automatic_translation × runAutomaticTranslation':
			{ behaviour: WRITEBACK_TETHERS.emptyBody },
	};

	/**
	 * The BEHAVIOUR tether of every SERVER `refuses` cell — `<action> × <door>` → the title of
	 * a tether in WRITEBACK_TETHERS, executed on the suite database by
	 * tool_lossless_writeback_tethers_native.test.ts (DB tier), which holds its registered
	 * titles EQUAL to that list. A `refuses` verdict's `must_contain` is a SPELLING:
	 * `if (guard(x)) log(); return write()` keeps it and loses the refusal. So the server
	 * `refuses` cells are held EQUAL to these keys: a new one is red until its refusal (and
	 * its counterfactual) really runs.
	 */
	const SERVER_REFUSES_TETHERS: Record<string, string> = {
		'tools/tool_time_machine/server/bulk_revert_records.ts :: deleteIfSafe × deleteSectionRecord':
			WRITEBACK_TETHERS.deleteIfSafe,
		'tools/tool_transcription/server/index.ts :: backgroundTranscriberPoll × saveTranscriptionResult':
			WRITEBACK_TETHERS.transcription,
	};

	/**
	 * NAMED, SHRINK-ONLY (equality per file). Corpus files with a runtime `import(` whose
	 * specifier is COMPUTED, so the closure cannot follow it. Each is a stated limit with
	 * its reason; a new site in any file — or a new site in a listed one — is red.
	 */
	const UNRESOLVED_DYNAMIC_IMPORT_EXEMPT: Record<string, { sites: number; reason: string }> = {
		'src/core/tools/loader.ts': {
			sites: 1,
			reason:
				'the tool REGISTRY loader imports each tools/<name>/server/index.ts by its canonical path; every such module is itself in the corpus and its writes are its own apiActions units — the dispatch from the registry to them is the stated registry-dispatch limit.',
		},
		'src/server.ts': {
			sites: 1,
			reason:
				'boot warm-up (warmCoreModuleGraph): a SIDE-EFFECT import of every src/core module to fill the module cache; the namespace is discarded, so no writer is reached through it.',
		},
		'scripts/ci/mariadb_tier.ts': {
			sites: 1,
			reason:
				'the CI tier loads the suite MariaDB helper (test/helpers/suite_mariadb.ts, outside the matrix corpus) by a joined absolute path; it provisions MariaDB, never a matrix row.',
		},
		'scripts/tool_viewport_check.ts': {
			sites: 7,
			reason:
				'every site runs INSIDE page.evaluate: a browser-side import of a SERVED client URL (/dedalo/…/instances.js, a tool module) in headless Chrome — not a server module, no matrix writer.',
		},
		'scripts/update_probe_ui_proof.ts': {
			sites: 1,
			reason:
				'inside page.evaluate: the browser imports the SERVED update_code_phases.js by URL to prove the served bytes — client code in headless Chrome, no matrix writer.',
		},
	};

	/**
	 * NAMED, by TARGET CLASS (not by importing file, so another lane's new import of an
	 * already-classified target is not a red here). A relative import — static, re-export,
	 * or a LITERAL dynamic `import('x')` in any form — whose target is not a corpus file is
	 * not followed by the closure; it is allowed only when the target EXISTS and falls in
	 * one of these classes, each with the reason nothing the write-back census must see
	 * lies behind it. A missing target (a spelling the resolver does not understand) or any
	 * other out-of-corpus file is red.
	 */
	const OUT_OF_CORPUS_TARGETS: {
		id: string;
		matches: (target: string) => boolean;
		reason: string;
	}[] = [
		{
			id: 'suite',
			matches: (target) => target.startsWith('test/'),
			reason:
				'the suite’s own helpers and parity harness: outside the write-path corpus by definition (write_path_corpus.ts, WHAT IS IN), and every test-data writer there is marker-guarded (assertTestDatabase).',
		},
		{
			id: 'migration-runner',
			matches: (target) => target === 'install/db/migrate.ts',
			reason:
				'the schema-migration runner for TS-owned tables; its only shared-row writes are seed corrections held by migration_shared_row_tripwire — an install-lane write, never a tool write-back.',
		},
		{
			id: 'online-migration-grammar',
			matches: (target) => target === 'install/db/online_migration.ts',
			reason:
				'the PURE grammar of an online migration (its header: no DB import, nothing that writes a row); the install seed compiler reads only isOnlineMigration() to choose whether a migration file runs in one transaction.',
		},
		{
			id: 'json-data',
			matches: (target) => target.endsWith('.json'),
			reason:
				'a JSON data import (schema definitions): data, no code, nothing can write through it.',
		},
		{
			id: 'tool-client-js',
			matches: (target) => CLIENT_FILES.includes(target),
			reason:
				'a tool’s CLIENT JS — a file the client leg itself scans (CLIENT_FILES, tools/**/js/**): its component-value writes are that leg’s cells (CLIENT_DOORS), not the server closure’s.',
		},
		{
			id: 'tools-js-leaf',
			matches: (target) => /^tools\/.+\.js$/.test(target) && isImportFreeLeaf(target),
			reason:
				'a tools/**/*.js module OUTSIDE the client leg (e.g. transcribers/lib/paragraphs.js, which src/core/tools/transcription_asr.ts runs SERVER-side) admitted only as a mechanically checked LEAF: no import, no require(, no Bun./process./fetch( — it can reach no module, no database and no network, so it can write nothing.',
		},
		{
			id: 'host-agent-package',
			matches: (target) =>
				(target === 'publication/host_agent/src/exec.ts' ||
					target === 'publication/host_agent/src/provision/render/engine_fragment.ts' ||
					target === 'publication/host_agent/src/provision/layout.ts' ||
					target === 'publication/host_agent/src/provision/pairing_package.ts' ||
					target === 'publication/host_agent/src/provision/exec_contract.ts' ||
					target === 'publication/host_agent/src/provision/render/nginx_map_include.ts' ||
					target === 'publication/host_agent/src/provision/siblings.ts' ||
					target === 'publication/host_agent/src/provision/init/draft.ts') &&
				agentPackageClosure(target).escapes.length === 0,
			reason:
				"the publication agent package — a SEPARATE deployable (its own package; imports nothing from the engine, holds no matrix credential). Exactly eight files: exec.ts, imported only by the agent live drill for its argv/seam constants; and provision/render/engine_fragment.ts, the engine-fragment renderer (pure: its imports stay inside the agent package — security/pairing, provision/layout, render/types), imported only by the engine drill and its kit for ENGINE_KEYS/agentUrl and the two placeholders, to render the fragment an operator pastes; and provision/layout.ts, the host-layout derivation (its imports stay inside the agent package — node:path, instance/roots), imported only by the agent drill and its scene for pickConfigtestBinary, so the drill picks the configtest binary the provisioner itself would; and provision/pairing_package.ts, the sealed pairing package's ONE codec (node:crypto only), imported only by scripts/publication_host_pair.ts to open a package provision init sealed (and by its gate), so the format is written and read by one implementation; and provision/exec_contract.ts, the provisioner's closed-command and Bun-asset table, imported only by scripts/ci/bun_pin_hashes.ts for BUN_ASSETS, so the developer-side pin updater hashes exactly the assets install.sh and init download; and provision/render/nginx_map_include.ts, the renderer of the provisioned host-map include glob, imported only by the agent drill's scene so nginx includes exactly the glob the provisioner writes; and provision/siblings.ts (the multi-instance rules, judged on derived layouts) and provision/init/draft.ts (the draft format, init's DEFAULTS and draftServesV1), imported by src/core/publication_host/drafts.ts and kit_build.ts so the maintenance panel judges a publication-host draft with the agent's OWN zero-dependency rules (owner decision D1: one rule set). None can reach the matrix, so no tool write-back lies behind them. The 'stays inside' claim is CHECKED, not assumed: each is admitted only while its transitive import closure (agentPackageClosure: static, re-export, dynamic and require, read by Bun's parser) stays under publication/host_agent/src/ and names no bare package but node:/bun builtins and the agent's own package.json dependencies.",
		},
		{
			id: 'client-js-leaf',
			matches: (target) => /^client\/dedalo\/.+\.js$/.test(target) && isImportFreeLeaf(target),
			reason:
				'a client/dedalo/**/*.js module the SERVER also imports so both sides run the SAME bytes (e.g. component_password/js/password_policy.js, which src/core/security/password_policy.ts enforces) — admitted only as a mechanically checked LEAF: no import, no require(, no Bun./process./fetch(, so it can write nothing.',
		},
	];

	/**
	 * The named classes admitting an out-of-corpus target (ids, in list order); empty = red.
	 * The census and the class controls both judge through it, so a class that widened is
	 * red on the controls, not only on a tree that happens to import the widened case.
	 */
	function admittedBy(target: string): string[] {
		return OUT_OF_CORPUS_TARGETS.filter((entry) => entry.matches(target)).map((entry) => entry.id);
	}

	const AGENT_SRC = 'publication/host_agent/src/';
	const AGENT_DEPENDENCIES = new Set(
		Object.keys(
			(
				JSON.parse(readFileSync(join(ROOT, 'publication/host_agent/package.json'), 'utf8')) as {
					dependencies?: Record<string, string>;
				}
			).dependencies ?? {},
		),
	);
	const AGENT_SCANNER = new Bun.Transpiler({ loader: 'ts' });

	/**
	 * One agent file's import edges: `next` (relative targets inside the agent package, to
	 * follow) and `escapes` (a relative target outside it, a bare package that is neither a
	 * node:/bun builtin nor an agent dependency, or a require(/import( whose specifier is not
	 * a literal). Bun's scanImports (never `.scan(`: the census reads that spelling as a Glob walk) erases type-only imports (they execute nothing) but misses
	 * require(, so that is read from the comment-stripped code.
	 */
	function agentImportEdges(rel: string, text: string): { next: string[]; escapes: string[] } {
		const specifiers = AGENT_SCANNER.scanImports(text).map((entry) => entry.path);
		const escapes: string[] = [];
		const code = stripComments(text);
		for (const match of code.matchAll(/(?<![\w$.])(require|import)\s*\(\s*([^)]*)\)/g)) {
			const literal = /^(['"])([^'"`]+)\1$/.exec((match[2] ?? '').trim());
			if (literal) specifiers.push(literal[2] as string);
			else
				escapes.push(`${rel}: ${match[1]}(${(match[2] ?? '').trim()}) — not a literal specifier`);
		}
		const next: string[] = [];
		for (const spec of new Set(specifiers)) {
			if (!spec.startsWith('.')) {
				const pkg = spec.startsWith('@')
					? spec.split('/').slice(0, 2).join('/')
					: spec.split('/')[0];
				if (!/^(?:node:|bun(?::|$))/.test(spec) && !AGENT_DEPENDENCIES.has(pkg as string)) {
					escapes.push(`${rel} → '${spec}': a bare package the agent does not declare`);
				}
				continue;
			}
			let target: string;
			try {
				target = relative(ROOT, Bun.resolveSync(spec, dirname(join(ROOT, rel))));
			} catch {
				escapes.push(`${rel} → '${spec}': does not resolve`);
				continue;
			}
			if (target.startsWith(AGENT_SRC)) next.push(target);
			else escapes.push(`${rel} → ${target}: outside ${AGENT_SRC}`);
		}
		return { next, escapes };
	}

	/** The transitive agent-package closure of `entry` and every edge that leaves it. */
	function agentPackageClosure(entry: string): { files: string[]; escapes: string[] } {
		const seen = new Set<string>();
		const escapes: string[] = [];
		const queue = [entry];
		while (queue.length > 0) {
			const rel = queue.pop() as string;
			if (seen.has(rel)) continue;
			seen.add(rel);
			const edges = agentImportEdges(rel, readFileSync(join(ROOT, rel), 'utf8'));
			escapes.push(...edges.escapes);
			queue.push(...edges.next);
		}
		return { files: [...seen].sort(), escapes };
	}

	/**
	 * Is this (existing) .js file a LEAF — its CODE (comments and strings blanked) names no
	 * `import`, `require(`, `Bun.`, `process.` or `fetch(`? Without any of those a module
	 * can reach nothing that writes.
	 */
	function isImportFreeLeaf(target: string): boolean {
		const code = codeOnly(readFileSync(join(ROOT, target), 'utf8'));
		return !/(?<![\w$.])(?:import\b|require\s*\(|Bun\s*\.|process\s*\.|fetch\s*\()/.test(code);
	}

	/**
	 * A top-level declaration: `function x`, `const x =`, `x.prototype.y =`, `obj.y =`.
	 * Anchored at column 0 — these files put every action at the left margin, and matching
	 * indented lines would name an `if` or a `for` as the enclosing action.
	 */
	const DECLARATION =
		/^(?:export\s+)?(?:async\s+)?(?:function\s+([A-Za-z0-9_$]+)|(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=|([A-Za-z0-9_$]+(?:\.prototype)?\.[A-Za-z0-9_$]+)\s*=)/;

	/**
	 * Every tool's client JS: the shared browser corpus in git's UNFILTERED view, tool js/
	 * trees only, minus the `-min.js` builds. NOT `browserSources()`: its vendored-library
	 * exclusion (`/lib/`, `/vendor/`, `.min.js`) would also drop a tool's OWN helper under a
	 * `lib/` directory, whose `.save(` would then have no cell and no red.
	 */
	const isToolClientFile = (file: string): boolean =>
		file.startsWith('tools/') && file.includes('/js/') && !file.endsWith('-min.js');
	const CLIENT_FILES = browserSourcesUnfiltered().filter(isToolClientFile);

	/**
	 * Walks a client file line by line, tracking the nearest top-level declaration, and
	 * returns every `<file> :: <symbol>` → door → site count. Comment lines are skipped: a
	 * docblock that MENTIONS `.save(` is not a door.
	 */
	function deriveClientCells(): Map<string, Map<string, number>> {
		const actions = new Map<string, Map<string, number>>();
		for (const rel of CLIENT_FILES) {
			const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n');
			let symbol = '(module top level)';
			let inBlockComment = false;
			for (const line of lines) {
				const wasInBlockComment = inBlockComment;
				if (/^\s*\/\*/.test(line)) inBlockComment = true;
				if (/\*\//.test(line)) inBlockComment = false;
				if (wasInBlockComment || inBlockComment || /^\s*(\/\/|\*)/.test(line)) continue;
				const declaration = DECLARATION.exec(line);
				if (declaration !== null) {
					symbol = declaration[1] ?? declaration[2] ?? declaration[3] ?? symbol;
				}
				for (const door of CLIENT_DOORS) {
					const sites = line.split(door).length - 1;
					if (sites === 0) continue;
					const key = `${rel} :: ${symbol}`;
					const doors = actions.get(key) ?? new Map<string, number>();
					doors.set(door, (doors.get(door) ?? 0) + sites);
					actions.set(key, doors);
				}
			}
		}
		return actions;
	}

	/**
	 * The source of ONE client action: from its declaration line to the line before the next
	 * top-level declaration. This is what the per-verdict checks read, so a `confirm(`
	 * elsewhere in the same file cannot vouch for an action that has none — the exact
	 * confusion that let a file hold a confirmed rebuild and an unconfirmed overwrite.
	 */
	function clientActionBody(key: string): string {
		const [rel, symbol] = key.split(' :: ') as [string, string];
		const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n');
		let start = -1;
		let end = lines.length;
		for (let index = 0; index < lines.length; index++) {
			const declaration = DECLARATION.exec(lines[index] as string);
			if (declaration === null) continue;
			const name = declaration[1] ?? declaration[2] ?? declaration[3];
			if (start === -1) {
				if (name === symbol) start = index;
			} else {
				end = index;
				break;
			}
		}
		if (start === -1) return '';
		return lines.slice(start, end).join('\n');
	}

	/**
	 * The CODE of a fragment: comments dropped, string and regex bodies blanked (template
	 * substitutions kept) — what a spelling check must read, so a literal or a comment that
	 * MENTIONS a call cannot stand in for it.
	 */
	function codeOnly(fragment: string): string {
		return stripComments(fragment, {
			blankStrings: true,
			keepTemplateSubstitutions: true,
			blankRegexBodies: true,
		});
	}

	/** `<file> :: <decl>` → the closure's `<file>#<decl>`. */
	const closureKey = (action: string): string => action.replace(' :: ', '#');
	const isServerAction = (action: string): boolean => action.includes('/server/');

	const CLOSURE = buildWriterClosure();
	const SERVER_CELLS = toolServerCells(CLOSURE);
	const CLIENT_CELLS = deriveClientCells();
	const DERIVED = new Map<string, Map<string, number>>([...CLIENT_CELLS, ...SERVER_CELLS]);

	/** The code body of an action: the closure's unit for a server action, the line scan's for a client one. */
	function actionBody(action: string): string {
		return isServerAction(action)
			? (CLOSURE.bodies.get(closureKey(action)) ?? '')
			: clientActionBody(action);
	}

	/** The closure member a server door names (a `file#name` door is its own key). */
	function doorTarget(closure: WriterClosure, door: string): string | undefined {
		if (door.includes('#')) return door;
		return [...closure.members.keys()].find((key) => key.endsWith(`#${door}`));
	}

	/** The chokepoint cut of the bypass rule (RECORD_WRITE_CHOKEPOINTS, checked below). */
	const CHOKEPOINTS: ReadonlySet<string> = new Set(Object.keys(RECORD_WRITE_CHOKEPOINTS));

	/**
	 * Does a server door write the matrix PAST the chokepoint — its resolved target reaches
	 * a seed on a path that avoids every chokepoint unit? The path (door … seed), or null.
	 * Judged through the closure, not by the door's own name or module: a raw write moved
	 * one — or five — declarations deeper into a differently-named wrapper is still found.
	 */
	function bypassOf(
		closure: WriterClosure,
		door: string,
		cut: ReadonlySet<string> = CHOKEPOINTS,
	): string[] | null {
		const target = doorTarget(closure, door);
		return target === undefined ? null : closure.bypassPath(target, cut);
	}

	/**
	 * Is a server door a RAW `matrix_write.ts` primitive? Judged by its RESOLVED target,
	 * never by the bare name: a door is spelled `file#name` as soon as another closure
	 * member shares its bare name, and a bare-name match would then drop the raw cell out
	 * of the rule exactly when a same-named wrapper appears.
	 */
	function isRawDoor(closure: WriterClosure, door: string): boolean {
		const target = doorTarget(closure, door);
		if (target === undefined) return false;
		// an OFF-HOME psql writer bypasses the chokepoint exactly as a primitive does
		if (closure.psqlSeeds.includes(target)) return true;
		if (!target.startsWith(`${MATRIX_WRITE}#`)) return false;
		return closure.primitives.includes(target.slice(MATRIX_WRITE.length + 1));
	}

	/**
	 * The locked-read claim: the action's OWN unit has a RESOLVED edge to
	 * readMatrixKeyForUpdate. Never an escape edge: a matrix_write namespace handed on as
	 * a value reaches every export, the lock included, without anything taking it.
	 */
	function takesLockedRead(closure: WriterClosure, action: string): boolean {
		return closure.preciseEdgesOf(closureKey(action)).has(`${MATRIX_WRITE}#readMatrixKeyForUpdate`);
	}

	type CensusCell = { action: string; door: string; cell: Cell };

	/**
	 * THE BYPASS RULE — pure over (closure, cells, cut): `bypass` is every cell whose door
	 * reaches a seed AVOIDING the chokepoint cut (`bypassOf` — path-based, so a wrapper of
	 * any name and depth cannot hide the write); `raw` the subset whose door IS a seed;
	 * `refused` the bypassing cells that are neither PENDING, `lossless` with a lockedRead
	 * the action really takes, nor carrying a `bypass_reason`.
	 */
	function bypassRuleProblems(
		closure: WriterClosure,
		cells: readonly CensusCell[],
		cut: ReadonlySet<string> = CHOKEPOINTS,
	): { raw: string[]; bypass: string[]; refused: string[] } {
		const bypass = cells.filter(({ door }) => bypassOf(closure, door, cut) !== null);
		const raw = cells.filter(({ door }) => isRawDoor(closure, door));
		const refused = bypass.filter(({ action, cell }) => {
			const lockedLossless =
				cell.verdict === 'lossless' && cell.lockedRead === true && takesLockedRead(closure, action);
			const reasoned = typeof cell.bypass_reason === 'string' && cell.bypass_reason.length > 60;
			return !(cell.verdict === 'PENDING' || lockedLossless || reasoned);
		});
		const label = ({ action, door }: CensusCell) => `${action} × ${door}`;
		return {
			raw: raw.map(label).sort(),
			bypass: bypass.map(label).sort(),
			refused: refused.map(label).sort(),
		};
	}

	/**
	 * THE LOSSLESS HONESTY RULE — pure over (closure, cells, leg titles): a `lossless` cell's
	 * `proof` must be one of the behavioural legs' REAL titles (not merely a string that
	 * appears in this file — the census literal itself would satisfy that), or the cell
	 * declares `readVerified`; a `lockedRead` claim needs the action's lock edge.
	 */
	function losslessProblems(
		closure: WriterClosure,
		cells: readonly CensusCell[],
		legs: readonly string[],
	): string[] {
		const problems: string[] = [];
		for (const { action, door, cell } of cells) {
			if (cell.verdict !== 'lossless') continue;
			if (cell.proof !== undefined) {
				if (!legs.includes(cell.proof)) {
					problems.push(`${action} × ${door}: proof '${cell.proof}' is not a behavioural leg`);
				}
			} else if (cell.readVerified !== true) {
				problems.push(`${action} × ${door}: no proof and not readVerified`);
			}
			if (cell.lockedRead === true && !takesLockedRead(closure, action)) {
				problems.push(`${action} × ${door}: claims a locked read the action never takes`);
			}
		}
		return problems.sort();
	}

	/**
	 * THE REFUSES RULE — pure over (closure, cells, body reader): a `refuses` cell's
	 * `must_contain` must be in CODE (strings and comments blanked, `codeOnly`) — in the
	 * `evidence` declaration, which the action must REACH through RESOLVED references (a
	 * namespace escape says only "could call any export": enough to make a cell, never to
	 * prove one), or else in the action's own body. The tree and the control both judge
	 * through it. A spelling check still: the server cells' BEHAVIOUR is SERVER_REFUSES_TETHERS.
	 */
	function refusesProblems(
		closure: WriterClosure,
		cells: readonly CensusCell[],
		bodyOf: (action: string) => string,
	): string[] {
		const problems: string[] = [];
		for (const { action, door, cell } of cells) {
			if (cell.verdict !== 'refuses') continue;
			const label = `${action} × ${door}`;
			if (cell.evidence === undefined) {
				if (!codeOnly(bodyOf(action)).includes(cell.must_contain)) {
					problems.push(`${label}: ${cell.must_contain} is not in its code`);
				}
				continue;
			}
			const evidence = closure.bodies.get(cell.evidence) ?? '';
			if (evidence.length === 0) {
				problems.push(`${label}: ${cell.evidence}: no such declaration`);
			} else if (!codeOnly(evidence).includes(cell.must_contain)) {
				problems.push(`${label}: ${cell.must_contain} is not in the code of ${cell.evidence}`);
			}
			if (!closure.reachesPrecisely(closureKey(action), cell.evidence)) {
				problems.push(`${label}: ${cell.evidence} is not reached through RESOLVED references`);
			}
		}
		return problems.sort();
	}

	interface CensusProblems {
		missingActions: string[];
		staleActions: string[];
		missingCells: string[];
		staleCells: string[];
		siteMismatch: string[];
	}

	/**
	 * THE JUDGE — pure over (derived cells, census). The tree scan and the controls both run
	 * through it, so a judge that stopped seeing a class of problem is red on the controls.
	 */
	function censusProblems(
		derived: ReadonlyMap<string, ReadonlyMap<string, number>>,
		census: Readonly<Record<string, CensusRow>>,
	): CensusProblems {
		const problems: CensusProblems = {
			missingActions: [],
			staleActions: [],
			missingCells: [],
			staleCells: [],
			siteMismatch: [],
		};
		for (const [action, doors] of derived) {
			const row = census[action];
			if (row === undefined) problems.missingActions.push(action);
			for (const [door, sites] of doors) {
				const cell = row?.doors[door];
				if (cell === undefined) {
					problems.missingCells.push(`${action} × ${door}`);
					continue;
				}
				if ((cell.sites ?? 1) !== sites) {
					problems.siteMismatch.push(
						`${action} × ${door}: ${sites} site(s) in the source, ${cell.sites ?? 1} in the census`,
					);
				}
			}
		}
		for (const [action, row] of Object.entries(census)) {
			const doors = derived.get(action);
			if (doors === undefined) problems.staleActions.push(action);
			for (const door of Object.keys(row.doors)) {
				if (doors?.has(door) !== true) problems.staleCells.push(`${action} × ${door}`);
			}
		}
		for (const list of Object.values(problems)) list.sort();
		return problems;
	}

	const PROBLEMS = censusProblems(DERIVED, CENSUS);

	/** Every (action, door, cell) of the census, flattened. */
	const CELLS: CensusCell[] = Object.entries(CENSUS).flatMap(([action, row]) =>
		Object.entries(row.doors).map(([door, cell]) => ({ action, door, cell })),
	);

	describe('LEG 4 — the tool write-back census is TOTAL by derivation', () => {
		test('anti-vacuity: the corpus, the closure and both derivations are populated', () => {
			// Without these floors a broken lister or analyser would make every assertion
			// below vacuous.
			expect(CLOSURE.files.length).toBeGreaterThan(WRITE_PATH_CORPUS_FLOOR);
			expect(CLIENT_FILES.length).toBeGreaterThan(100);
			expect(CLOSURE.members.size).toBeGreaterThanOrEqual(100);
			const memberNames = new Set([...CLOSURE.members.keys()].map((key) => key.split('#')[1]));
			for (const name of [
				'saveComponentData',
				'persistRecordKeys',
				'persistRecordColumns',
				'deletePortalLocator',
				'createSectionRecord',
				'deleteSectionRecord',
				'persistUploadedMedia',
				'reconcileStoredFilesInfo',
				'runAutomaticTranslation',
				// reached only through the `return deps ?? (await import('../user_stats.ts'))`
				// seam — the namespace-escape rule's tree witness
				'databaseInfoRebuildUserStats',
			]) {
				expect(memberNames.has(name), `${name} is not a writer-closure member`).toBe(true);
			}
			for (const key of [
				// through src/core/test_data/ (NOT excluded: it runs on real databases too)
				'src/core/install/db_restore.ts#installDbFromSeed',
				'src/core/area_maintenance/widgets/unit_test.ts#unitTestCreateTestRecord',
				// through MODULE-SCOPE dynamic bindings made in another unit (top-level await)
				'scripts/migrate_component_alias.ts#touchedIds',
			]) {
				expect(CLOSURE.members.has(key), `${key} is not a writer-closure member`).toBe(true);
			}
			// the OFF-HOME psql writers are derived seeds (the T2.b channel), and one tool
			// action reaches one today
			for (const key of [
				'src/core/ontology/data_io_import.ts#normalizeOntologyTld',
				'src/core/ontology/data_io_import.ts#importFromCopyFile',
				'src/core/install/hierarchy_import.ts#runImportUnit',
				'src/core/install/root_pw.ts#setRootPassword',
			]) {
				expect(CLOSURE.psqlSeeds, `${key} is not a derived psql seed`).toContain(key);
			}
			expect(
				SERVER_CELLS.get(
					'tools/tool_ontology_parser/server/tool_ontology_parser.ts :: toolOntologyParserRepairTlds',
				)?.get('normalizeOntologyTld'),
			).toBe(1);
			// a ternary-branch `await import('x')` is never a dropped load: emitDataframeItem
			// binds frame_as_of through `const asOfModule = c ? null : await import(…)`
			expect(
				CLOSURE.edgesOf('src/core/relations/relation_core.ts#emitDataframeItem').has(
					'src/core/tm_record/frame_as_of.ts#frameTargetsAsOf',
				),
			).toBe(true);
			// Measured 2026-09-30: 35 server actions, 54 server cells, 16 client actions.
			// 54 → 47 server cells with CLOSURE_PLAN Step 2: the relation_search rebuild and
			// observer-propagation doors of the time-machine actions are the chokepoint's
			// own derived writes now, not cells of their own.
			expect(SERVER_CELLS.size).toBeGreaterThanOrEqual(31);
			const serverCellCount = [...SERVER_CELLS.values()].reduce(
				(sum, doors) => sum + doors.size,
				0,
			);
			expect(serverCellCount).toBeGreaterThanOrEqual(42);
			expect(CLIENT_CELLS.size).toBeGreaterThanOrEqual(14);
			// The write the four hand-listed doors could not see (a RAW primitive then; the
			// locked media-key transform since CLOSURE_PLAN Step 2), reached through a
			// dynamic-destructure import, inside a tool action.
			expect(
				SERVER_CELLS.get('tools/tool_update_cache/server/index.ts :: updateCache')?.get(
					'transformStoredMediaItems',
				),
			).toBe(1);
			// and the two P0-12 actions, by their real names
			expect([...CLIENT_CELLS.keys()]).toContain(
				'tools/tool_transcription/js/tool_transcription.js :: tool_transcription.prototype.regroup_paragraphs',
			);
			expect([...CLIENT_CELLS.keys()]).toContain(
				'tools/tool_lang/js/browser_translation.js :: translate_component_browser',
			);
		});

		test('every client door token is a REAL write door, not a typo', () => {
			// A door token that matches nothing shrinks the census to silence. Each one is
			// checked against the module that DEFINES it. (Server doors are derived from
			// matrix_write.ts's exports and cannot be misspelled.)
			expect(CLIENT_DOORS.length).toBe(3);
			const componentCommon = readFileSync(
				join(ROOT, 'client/dedalo/core/component_common/js/component_common.js'),
				'utf8',
			);
			for (const door of CLIENT_DOORS) {
				const name = door.slice(1, -1);
				expect(
					componentCommon.includes(`component_common.prototype.${name} =`),
					`${door} is not a component_common write door any more`,
				).toBe(true);
			}
		});

		test('every derived action has a census row', () => {
			expect(
				PROBLEMS.missingActions,
				`Tool action(s) writing a component value with no census row:\n  ${PROBLEMS.missingActions.join('\n  ')}\nAdd a row with a verdict per door and a written reason. If it reads a stored value, transforms it and writes it back, the verdict is 'lossless', 'confirmed' or 'refuses' — never a silent overwrite.`,
			).toEqual([]);
		});

		test('every derived (action, door) cell has its own verdict', () => {
			const described = PROBLEMS.missingCells.map((cell) => {
				const door = cell.slice(cell.lastIndexOf(' × ') + 3);
				const target = cell.includes('/server/') ? doorTarget(CLOSURE, door) : undefined;
				return target === undefined
					? cell
					: `${cell}\n      witness: ${CLOSURE.witness(target).join(' → ')}`;
			});
			expect(
				described,
				`(action, door) cell(s) with no verdict — a new writer, or a new door on a known action:\n  ${described.join('\n  ')}`,
			).toEqual([]);
		});

		test('no census row or cell names a write that no longer exists (stale)', () => {
			expect(
				PROBLEMS.staleActions,
				'Census row(s) for actions that no longer call a write door (renamed? removed?)',
			).toEqual([]);
			expect(PROBLEMS.staleCells, 'Census cell(s) whose door the action no longer reaches').toEqual(
				[],
			);
		});

		test('every cell’s site count is the source’s', () => {
			expect(
				PROBLEMS.siteMismatch,
				'A door gained or lost a call site: re-read the action and restate the cell',
			).toEqual([]);
		});

		test('every cell carries a real reason, not a placeholder', () => {
			for (const { action, door, cell } of CELLS) {
				expect(
					cell.reason.length,
					`${action} × ${door}: the reason is too short to be a reason`,
				).toBeGreaterThan(60);
			}
		});

		test('every RECORD_WRITE_CHOKEPOINTS unit is real and fires the obligation hook', () => {
			// The cut is what makes a write "sanctioned": a stale key would cut nothing (every
			// cell through the renamed door turns into a bypass — red, loudly), and a key that
			// does not reach afterRecordWrite through RESOLVED references is no chokepoint.
			expect(CHOKEPOINTS.size).toBeGreaterThanOrEqual(7);
			for (const [key, reason] of Object.entries(RECORD_WRITE_CHOKEPOINTS)) {
				expect(CLOSURE.members.has(key), `${key} is not a writer-closure member`).toBe(true);
				expect(
					CLOSURE.reachesPrecisely(key, AFTER_RECORD_WRITE),
					`${key} does not reach ${AFTER_RECORD_WRITE} — it is no chokepoint`,
				).toBe(true);
				expect(reason.length, `${key}: the chokepoint needs its reason`).toBeGreaterThan(40);
			}
		});

		test('the BYPASS rule: a tool cell whose door writes PAST the chokepoint — at any depth — is PENDING, lossless over a locked read, or says why', () => {
			const { raw, bypass, refused } = bypassRuleProblems(CLOSURE, CELLS);
			const described = refused.map((label) => {
				const door = label.slice(label.lastIndexOf(' × ') + 3);
				return `${label}\n      bypass: ${(bypassOf(CLOSURE, door) ?? []).join(' → ')}`;
			});
			expect(
				described,
				"a tool write that reaches the matrix past every RECORD_WRITE_CHOKEPOINTS unit must be PENDING, 'lossless' with lockedRead over readMatrixKeyForUpdate, or carry a bypass_reason",
			).toEqual([]);
			expect(raw.length, `raw-primitive tool cells: ${raw.join(', ')}`).toBe(RAW_TOOL_CELLS);
			expect(bypass.length, `bypassing tool cells:\n  ${bypass.join('\n  ')}`).toBe(
				BYPASS_TOOL_CELLS,
			);
			// every raw cell is a bypass (a seed trivially avoids the cut)
			expect(raw.filter((label) => !bypass.includes(label))).toEqual([]);
			// a bypass_reason on a cell that does NOT bypass is a stale claim
			const stale = CELLS.filter(
				({ door, cell }) => cell.bypass_reason !== undefined && bypassOf(CLOSURE, door) === null,
			).map(({ action, door }) => `${action} × ${door}`);
			expect(stale, 'bypass_reason on a cell whose door goes through the chokepoint').toEqual([]);
		});

		test('every REASONED bypass lands on a SANCTIONED derived writer — the one list both censuses read', () => {
			// SANCTIONED_DERIVED_WRITERS (test/helpers/matrix_writer_closure.ts) is THE list
			// of units that write past every chokepoint by design (derived state: files_info,
			// the metadata twin, the hierarchy / ontology definition rows, the dataframe slot
			// strip). A stale name is red; and a reasoned bypass cell whose write path reaches
			// NONE of them is writing past the chokepoint through a writer nobody sanctioned —
			// its `bypass_reason` then restates a contract no list holds.
			const sanctioned = Object.keys(SANCTIONED_DERIVED_WRITERS);
			expect(sanctioned.length).toBeGreaterThanOrEqual(6);
			for (const [key, reason] of Object.entries(SANCTIONED_DERIVED_WRITERS)) {
				expect(CLOSURE.members.has(key), `${key} is not a writer-closure member (stale?)`).toBe(
					true,
				);
				expect(reason.length, `${key}: a sanctioned writer needs its reason`).toBeGreaterThan(40);
			}
			const reasoned = CELLS.filter(
				({ door, cell }) =>
					cell.verdict !== 'PENDING' &&
					typeof cell.bypass_reason === 'string' &&
					!isRawDoor(CLOSURE, door),
			);
			expect(reasoned.length, 'no reasoned bypass cell — the check is vacuous').toBeGreaterThan(5);
			const unsanctioned = reasoned
				.filter(
					({ door }) => !(bypassOf(CLOSURE, door) ?? []).some((unit) => sanctioned.includes(unit)),
				)
				.map(
					({ action, door }) =>
						`${action} × ${door}: ${(bypassOf(CLOSURE, door) ?? []).join(' → ')}`,
				);
			expect(
				unsanctioned,
				'a reasoned bypass whose write path reaches no SANCTIONED_DERIVED_WRITERS unit',
			).toEqual([]);
		});

		test('no corpus file loads a module through a dynamic import the analyser cannot resolve, beyond the named exemptions', () => {
			// The WHOLE corpus, not only tool servers: a src engine whose writer sits behind
			// an unresolvable import drops out of the closure, and every tool delegating to
			// it silently loses its cell. A literal specifier is always resolved (a
			// value-position `import('x')` is a namespace escape: every export reached), so
			// only a COMPUTED specifier lands here.
			const perFile = new Map<string, string[]>();
			for (const file of CLOSURE.files) {
				const sites = CLOSURE.unresolvedDynamicImports(file);
				if (sites.length > 0) perFile.set(file, sites);
			}
			const problems: string[] = [];
			for (const [file, sites] of perFile) {
				const exempt = UNRESOLVED_DYNAMIC_IMPORT_EXEMPT[file];
				if (exempt === undefined || exempt.sites !== sites.length) {
					problems.push(
						`${file}: ${sites.length} site(s), ${exempt?.sites ?? 0} exempt\n      ${sites.join('\n      ')}`,
					);
				}
			}
			for (const [file, exempt] of Object.entries(UNRESOLVED_DYNAMIC_IMPORT_EXEMPT)) {
				if (!perFile.has(file))
					problems.push(`${file}: exempt for ${exempt.sites}, has none (stale)`);
				expect(exempt.reason.length, `${file}: the exemption needs a reason`).toBeGreaterThan(60);
			}
			expect(
				problems.sort(),
				'an unresolved import is a writer the census cannot see — use a literal specifier (const {x} = await import(…)); a genuinely computed one needs a named exemption with its reason (shrink-only)',
			).toEqual([]);
		});

		test('no corpus reference to a corpus module names an export that does not exist — nothing is dropped silently', () => {
			// A bound name, a `ns.member`, a `(await import('x')).a` or a static import name
			// whose export does not resolve would give NO edge — the shape a default export
			// had before `default` was modelled. Every one is listed, so the list is empty.
			const problems = CLOSURE.files.flatMap((file) => CLOSURE.unresolvedBindings(file));
			expect(
				problems,
				'an unresolved export reference is an edge the closure silently lost',
			).toEqual([]);
		});

		test('no relative import — static or literal dynamic — leaves the corpus except to a named target class', () => {
			const problems: string[] = [];
			let outOfCorpus = 0;
			for (const file of CLOSURE.files) {
				for (const { site, target } of CLOSURE.outOfCorpusImports(file)) {
					outOfCorpus++;
					if (!existsSync(join(ROOT, target))) {
						problems.push(`${site} → ${target}: no such file (a spelling the resolver missed?)`);
					} else if (admittedBy(target).length === 0) {
						problems.push(`${site} → ${target}: outside the corpus and in no named class`);
					}
				}
			}
			for (const entry of OUT_OF_CORPUS_TARGETS) {
				expect(entry.reason.length).toBeGreaterThan(60);
			}
			// anti-vacuity: the report is live (the corpus imports test/ helpers today)
			expect(outOfCorpus).toBeGreaterThan(0);
			expect(problems.sort()).toEqual([]);
		});

		test('AGREEMENT: the name-based raw-call census (write_obligations leg A) equals the binding-resolved primitive edges', () => {
			const excluded = (key: string) => key.startsWith(`${MATRIX_WRITE}#`);
			const byName = new Set<string>();
			for (const file of CLOSURE.files) {
				const source = stripComments(readFileSync(join(ROOT, file), 'utf8'));
				for (const call of rawCallsIn(file, source)) {
					if (!excluded(call.key)) byName.add(`${call.key} ${call.primitive}`);
				}
			}
			const byBinding = new Set<string>();
			for (const key of CLOSURE.bodies.keys()) {
				if (excluded(key)) continue;
				for (const target of CLOSURE.edgesOf(key).keys()) {
					const [file, name] = target.split('#') as [string, string];
					if (file === MATRIX_WRITE && RAW_PRIMITIVES.includes(name))
						byBinding.add(`${key} ${name}`);
				}
			}
			expect(byName.size).toBeGreaterThan(25);
			expect(
				[...byName].filter((entry) => !byBinding.has(entry)).sort(),
				'called by name, not resolved',
			).toEqual([]);
			expect(
				[...byBinding].filter((entry) => !byName.has(entry)).sort(),
				'resolved, not called by name',
			).toEqual([]);
		});

		test('AGREEMENT: the psql seeds by BINDING (a resolved edge to runPsql) equal the psql writers by NAME', () => {
			// Seeds are derived from the binding, so an aliased / namespace / injected runPsql
			// is a seed; this holds the two views equal on the tree, so a spelling the binder
			// misses (or a local function that merely shares the name) is red, not a silent
			// seed more or less.
			const byName = [...CLOSURE.bodies]
				.filter(
					([key, body]) =>
						!key.startsWith(`${MATRIX_WRITE}#`) &&
						!key.includes('#<type:') &&
						isPsqlMatrixWriter(body),
				)
				.map(([key]) => key)
				.sort();
			// 5 since 2026-10-01: hierarchy_import's three psql writers (the reset DELETE,
			// the `\copy`, the counter) became ONE atomic psql unit, runImportUnit.
			expect(CLOSURE.psqlSeeds.length).toBeGreaterThanOrEqual(5);
			expect(CLOSURE.psqlSeeds, 'psql seeds by binding vs psql writers by name').toEqual(byName);
			for (const seed of CLOSURE.psqlSeeds) {
				expect(
					hasPsqlDoorEdge(CLOSURE.preciseEdgesOf(seed)),
					`${seed}: no resolved runPsql edge`,
				).toBe(true);
			}
		});
	});

	describe('LEG 4 — the analyser and the judge, on injected inputs (positive controls)', () => {
		const MATRIX_WRITE_CONTROL = [
			'export async function updateMatrixKeyData(t: string): Promise<void> {',
			'\tawait sql`x`;',
			'}',
			'export async function readMatrixKeyForUpdate(t: string): Promise<void> {}',
		].join('\n');
		const ENGINE = [
			"import { updateMatrixKeyData } from '../core/db/matrix_write.ts';",
			'export async function zzWrite(): Promise<void> {',
			"\tawait updateMatrixKeyData('matrix');",
			'}',
			'export async function zzRead(): Promise<number> {',
			'\treturn 1;',
			'}',
		].join('\n');
		const TOOL = [
			"import { zzWrite as w2 } from '../../../src/zz_ctl/engine.ts';",
			"import * as ns from '../../../src/zz_ctl/engine.ts';",
			'const obj = { zzWrite: () => 1 };',
			'export async function zzAction(): Promise<void> {',
			"\tconst { zzWrite: w } = await import('../../../src/zz_ctl/engine.ts');",
			'\tawait w();',
			'\tawait ns.zzWrite();',
			'\tobj.zzWrite();',
			'\tzzRead();',
			'\tconst note = "zzWrite( w() ns.zzWrite()";',
			'\t// zzWrite( w() ns.zzWrite() in a comment',
			'}',
			'export const tool: ToolServerModule = {',
			"\tname: 'zz_ctl',",
			'\tapiActions: {',
			'\t\trun: {',
			'\t\t\tpermission: null,',
			"\t\t\tgatedInHandler: 'a { brace } in a string',",
			'\t\t\thandler: async () => {',
			'\t\t\t\tawait w2();',
			'\t\t\t},',
			'\t\t},',
			'\t\tlook: { permission: null, handler: async () => 1 },',
			'\t},',
			'};',
		].join('\n');
		const LOCAL = [
			'function zzWrite(): void {}',
			'export function zzLocal(): void {',
			'\tzzWrite();',
			'}',
		].join('\n');
		const CONTROL_FILES: Record<string, string> = {
			[MATRIX_WRITE]: MATRIX_WRITE_CONTROL,
			'src/zz_ctl/engine.ts': ENGINE,
			'tools/zz_ctl/server/index.ts': TOOL,
			'tools/zz_ctl/server/local.ts': LOCAL,
		};
		const control = buildWriterClosure({
			files: Object.keys(CONTROL_FILES),
			read: (rel) => CONTROL_FILES[rel] as string,
		});

		test('the injected closure: exactly the resolved cells, witness down to the primitive, no decoy edge', () => {
			const cells = Object.fromEntries(
				[...toolServerCells(control)].map(([action, doors]) => [action, Object.fromEntries(doors)]),
			);
			expect(cells).toEqual({
				'tools/zz_ctl/server/index.ts :: zzAction': { zzWrite: 2 },
				'tools/zz_ctl/server/index.ts :: tool.apiActions.run': { zzWrite: 1 },
			});
			expect(control.witness('tools/zz_ctl/server/index.ts#zzAction')).toEqual([
				'tools/zz_ctl/server/index.ts#zzAction',
				'src/zz_ctl/engine.ts#zzWrite',
				`${MATRIX_WRITE}#updateMatrixKeyData`,
			]);
			// the decoys (obj.zzWrite() — only `obj` itself, a non-writer, is referenced —
			// an unbound zzRead(), bound names mentioned in a string and in a comment) and the
			// same-name LOCAL zzWrite give no edge into the engine and no extra site
			expect([...control.edgesOf('tools/zz_ctl/server/index.ts#zzAction').keys()].sort()).toEqual([
				'src/zz_ctl/engine.ts#zzWrite',
				'tools/zz_ctl/server/index.ts#obj',
			]);
			expect(control.members.has('tools/zz_ctl/server/local.ts#zzLocal')).toBe(false);
			expect([...control.edgesOf('tools/zz_ctl/server/local.ts#zzLocal').keys()]).toEqual([
				'tools/zz_ctl/server/local.ts#zzWrite',
			]);
			expect(control.members.has('src/zz_ctl/engine.ts#zzRead')).toBe(false);
			expect(
				control.reaches(
					'tools/zz_ctl/server/index.ts#tool.apiActions.run',
					'src/zz_ctl/engine.ts#zzWrite',
				),
			).toBe(true);
			expect(
				control.reaches('tools/zz_ctl/server/index.ts#zzAction', 'src/zz_ctl/engine.ts#zzRead'),
			).toBe(false);
			expect(control.unresolvedDynamicImports('tools/zz_ctl/server/index.ts')).toEqual([]);
		});

		test('an unresolvable dynamic import is REPORTED at its FILE line, not silently skipped', () => {
			const files: Record<string, string> = {
				'tools/zz_ctl/server/index.ts': [
					"import { x } from './x.ts';",
					'',
					'export async function zzAction(spec: string): Promise<void> {',
					'\tconst m = await import(spec);',
					'}',
					'export const tool = {',
					'\tapiActions: {',
					'\t\trun: {',
					'\t\t\thandler: async (spec: string) => {',
					'\t\t\t\tawait import(spec);',
					'\t\t\t},',
					'\t\t},',
					'\t},',
					'};',
				].join('\n'),
			};
			const closure = buildWriterClosure({
				files: Object.keys(files),
				read: (rel) => files[rel] as string,
			});
			// line 4 (a top-level function) and line 10 (inside a split apiActions unit)
			expect(
				closure
					.unresolvedDynamicImports('tools/zz_ctl/server/index.ts')
					.map((site) => site.split(': ')[0]),
			).toEqual(['tools/zz_ctl/server/index.ts:4', 'tools/zz_ctl/server/index.ts:10']);
		});

		test('a namespace that ESCAPES as a value reaches every export — the src-engine DI seam is not a hole', () => {
			// The shape that dropped database_info#databaseInfoRebuildUserStats out of the
			// closure: `deps ?? (await import('x'))`, then a property call on the result. And a
			// static namespace handed on as a value. Both are taken to reach EVERY export of
			// the module, so the tool action delegating to either engine has its cell.
			const files: Record<string, string> = {
				[MATRIX_WRITE]: MATRIX_WRITE_CONTROL,
				'src/zz_ctl/w.ts': [
					'export async function eng(deps?: unknown): Promise<void> {',
					"\tconst m = deps ?? (await import('../core/db/matrix_write.ts'));",
					"\tawait m.updateMatrixKeyData('x');",
					'}',
				].join('\n'),
				'src/zz_ctl/v.ts': [
					"import * as mw from '../core/db/matrix_write.ts';",
					'export async function viaValue(run: (m: unknown) => void): Promise<void> {',
					'\trun(mw);',
					'}',
				].join('\n'),
				'tools/zz_c/server/index.ts': [
					"import { eng } from '../../../src/zz_ctl/w.ts';",
					"import { viaValue } from '../../../src/zz_ctl/v.ts';",
					'export async function act2(): Promise<void> {',
					'\tawait eng();',
					'}',
					'export async function act3(): Promise<void> {',
					'\tawait viaValue(() => {});',
					'}',
				].join('\n'),
			};
			const closure = buildWriterClosure({
				files: Object.keys(files),
				read: (rel) => files[rel] as string,
			});
			expect(closure.unresolvedDynamicImports('src/zz_ctl/w.ts')).toEqual([]);
			expect(
				Object.fromEntries(
					[...toolServerCells(closure)].map(([action, doors]) => [
						action,
						Object.fromEntries(doors),
					]),
				),
			).toEqual({
				'tools/zz_c/server/index.ts :: act2': { eng: 1 },
				'tools/zz_c/server/index.ts :: act3': { viaValue: 1 },
			});
			expect(closure.witness('src/zz_ctl/w.ts#eng')).toEqual([
				'src/zz_ctl/w.ts#eng',
				`${MATRIX_WRITE}#updateMatrixKeyData`,
			]);
		});

		test('an escaping namespace reaches what its module RE-EXPORTS — `export {…} from` and `export { local as alias }`', () => {
			// A barrel exports no declaration of its own: the escape must follow its
			// re-exports (and a local alias of an import) down to the primitive, or a
			// namespace handed on from a barrel is a writer the census cannot see.
			const files: Record<string, string> = {
				[MATRIX_WRITE]: MATRIX_WRITE_CONTROL,
				'src/zz_ctl/barrel.ts':
					"export { updateMatrixKeyData as upd } from '../core/db/matrix_write.ts';",
				'src/zz_ctl/alias.ts': [
					"import { updateMatrixKeyData } from '../core/db/matrix_write.ts';",
					'export { updateMatrixKeyData as upd2 };',
				].join('\n'),
				'tools/zz_c/server/index.ts': [
					"import * as barrel from '../../../src/zz_ctl/barrel.ts';",
					"import * as alias from '../../../src/zz_ctl/alias.ts';",
					'export async function viaBarrel(run: (m: unknown) => void): Promise<void> {',
					'\trun(barrel);',
					'}',
					'export async function viaAlias(run: (m: unknown) => void): Promise<void> {',
					'\trun(alias);',
					'}',
				].join('\n'),
			};
			const closure = buildWriterClosure({
				files: Object.keys(files),
				read: (rel) => files[rel] as string,
			});
			expect(
				Object.fromEntries(
					[...toolServerCells(closure)].map(([action, doors]) => [
						action,
						Object.fromEntries(doors),
					]),
				),
			).toEqual({
				'tools/zz_c/server/index.ts :: viaAlias': { updateMatrixKeyData: 1 },
				'tools/zz_c/server/index.ts :: viaBarrel': { updateMatrixKeyData: 1 },
			});
		});

		test('a STAR-EXPORT CYCLE gives both members their whole export set, whichever escape is resolved first', () => {
			// a.ts and b.ts `export *` each other: b's exports INCLUDE a's upd. Resolving a's
			// escape first walks into b with a already on the stack — b's set, truncated there,
			// must not be memoized as b's whole set, or b's own escape reaches nothing.
			const files: Record<string, string> = {
				[MATRIX_WRITE]: MATRIX_WRITE_CONTROL,
				'src/zz_ctl/a.ts': [
					"export { updateMatrixKeyData as upd } from '../core/db/matrix_write.ts';",
					"export * from './b.ts';",
				].join('\n'),
				'src/zz_ctl/b.ts': "export * from './a.ts';",
				'tools/zz_c/server/index.ts': [
					"import * as a from '../../../src/zz_ctl/a.ts';",
					"import * as b from '../../../src/zz_ctl/b.ts';",
					'export async function viaA(run: (m: unknown) => void): Promise<void> {',
					'\trun(a);',
					'}',
					'export async function viaB(run: (m: unknown) => void): Promise<void> {',
					'\trun(b);',
					'}',
				].join('\n'),
			};
			const closure = buildWriterClosure({
				files: Object.keys(files),
				read: (rel) => files[rel] as string,
			});
			expect(
				Object.fromEntries(
					[...toolServerCells(closure)].map(([action, doors]) => [
						action,
						Object.fromEntries(doors),
					]),
				),
			).toEqual({
				'tools/zz_c/server/index.ts :: viaA': { updateMatrixKeyData: 1 },
				'tools/zz_c/server/index.ts :: viaB': { updateMatrixKeyData: 1 },
			});
		});

		/** Build a closure over injected files and render its tool cells as a plain object. */
		const injected = (files: Record<string, string>) => {
			const closure = buildWriterClosure({
				files: Object.keys(files),
				read: (rel) => files[rel] as string,
			});
			const cells = Object.fromEntries(
				[...toolServerCells(closure)].map(([action, doors]) => [action, Object.fromEntries(doors)]),
			);
			return { closure, cells };
		};
		const MW_FROM_TOOL = '../../../src/core/db/matrix_write.ts';
		const MW_FROM_SRC = '../core/db/matrix_write.ts';

		test('a MODULE-SCOPE dynamic import (top-level await) binds for EVERY unit of the file — destructure and namespace', () => {
			// Both forms bound at column 0 in one unit (`<module>`, and the `mw` declaration's
			// own unit), used from OTHER units: a top-level function and a split apiActions
			// handler. Before, the binding lived only in the unit holding the statement, so
			// these calls had no edge, no cell and no report.
			const { closure, cells } = injected({
				[MATRIX_WRITE]: MATRIX_WRITE_CONTROL,
				'tools/zz_m/server/index.ts': [
					`const { updateMatrixKeyData } = await import('${MW_FROM_TOOL}');`,
					`const mw = await import('${MW_FROM_TOOL}');`,
					'export async function act(): Promise<void> {',
					"\tawait updateMatrixKeyData('t');",
					'}',
					'export async function act2(): Promise<void> {',
					"\tawait mw.updateMatrixKeyData('t');",
					'}',
					'export const tool = {',
					'\tapiActions: {',
					'\t\trun: {',
					'\t\t\thandler: async () => {',
					"\t\t\t\tawait updateMatrixKeyData('t');",
					"\t\t\t\tawait mw.updateMatrixKeyData('t');",
					'\t\t\t},',
					'\t\t},',
					'\t},',
					'};',
				].join('\n'),
				// an INDENTED binding stays local to its function: `other` gets no edge from it
				'tools/zz_n/server/index.ts': [
					'export async function inner(): Promise<void> {',
					`\tconst { updateMatrixKeyData } = await import('${MW_FROM_TOOL}');`,
					"\tawait updateMatrixKeyData('t');",
					'}',
					'export async function other(): Promise<void> {',
					"\tawait updateMatrixKeyData('t');",
					'}',
				].join('\n'),
			});
			expect(cells).toEqual({
				'tools/zz_m/server/index.ts :: act': { updateMatrixKeyData: 1 },
				'tools/zz_m/server/index.ts :: act2': { updateMatrixKeyData: 1 },
				'tools/zz_m/server/index.ts :: tool.apiActions.run': { updateMatrixKeyData: 2 },
				'tools/zz_n/server/index.ts :: inner': { updateMatrixKeyData: 1 },
			});
			expect(closure.unresolvedDynamicImports('tools/zz_m/server/index.ts')).toEqual([]);
			expect(closure.unresolvedBindings('tools/zz_m/server/index.ts')).toEqual([]);
		});

		test('DEFAULT exports and imports resolve — static default clause, `{ default: w }`, `export default ident;`, an anonymous default', () => {
			const writes = [`import { updateMatrixKeyData } from '${MW_FROM_SRC}';`];
			const { closure, cells } = injected({
				[MATRIX_WRITE]: MATRIX_WRITE_CONTROL,
				'src/zz_d/def.ts': [
					...writes,
					'export default async function zzDef(): Promise<void> {',
					"\tawait updateMatrixKeyData('x');",
					'}',
				].join('\n'),
				'src/zz_d/def2.ts': [
					...writes,
					'async function zzDef2(): Promise<void> {',
					"\tawait updateMatrixKeyData('x');",
					'}',
					'export default zzDef2;',
				].join('\n'),
				'src/zz_d/def3.ts': [
					...writes,
					'export default async (): Promise<void> => {',
					"\tawait updateMatrixKeyData('x');",
					'};',
				].join('\n'),
				'src/zz_d/plain.ts': 'export function nothing(): number {\n\treturn 1;\n}',
				'tools/zz_d/server/index.ts': [
					"import w from '../../../src/zz_d/def.ts';",
					"import w2, { type Unused } from '../../../src/zz_d/def2.ts';",
					"import ghostDefault from '../../../src/zz_d/plain.ts';",
					"import { ghost } from '../../../src/zz_d/plain.ts';",
					'export async function viaStatic(): Promise<void> {',
					'\tawait w();',
					'}',
					'export async function viaStaticIdent(): Promise<void> {',
					'\tawait w2();',
					'}',
					'export async function viaDynamic(): Promise<void> {',
					"\tconst { default: d } = await import('../../../src/zz_d/def2.ts');",
					'\tawait d();',
					'}',
					'export async function viaAnon(): Promise<void> {',
					"\tconst { default: a } = await import('../../../src/zz_d/def3.ts');",
					'\tawait a();',
					'}',
				].join('\n'),
			});
			expect(cells).toEqual({
				'tools/zz_d/server/index.ts :: viaAnon': { default: 1 },
				'tools/zz_d/server/index.ts :: viaDynamic': { zzDef2: 1 },
				'tools/zz_d/server/index.ts :: viaStatic': { zzDef: 1 },
				'tools/zz_d/server/index.ts :: viaStaticIdent': { zzDef2: 1 },
			});
			// a default import of a module without one, and a named import of a missing
			// export, are REPORTED — not an absent edge nobody sees
			expect(closure.unresolvedBindings('tools/zz_d/server/index.ts')).toEqual([
				'tools/zz_d/server/index.ts: src/zz_d/plain.ts#default',
				'tools/zz_d/server/index.ts: src/zz_d/plain.ts#ghost',
			]);
		});

		test('a writer in the tool’s OWN non-server TS is a door; a server helper carries its own cell', () => {
			const { closure, cells } = injected({
				[MATRIX_WRITE]: MATRIX_WRITE_CONTROL,
				'tools/zz_t/shared/writer.ts': [
					`import { updateMatrixKeyData } from '../../../src/core/db/matrix_write.ts';`,
					'export async function sharedWrite(): Promise<void> {',
					"\tawait updateMatrixKeyData('x');",
					'}',
				].join('\n'),
				'tools/zz_t/server/helper.ts': [
					"import { sharedWrite } from '../shared/writer.ts';",
					'export async function helper(): Promise<void> {',
					'\tawait sharedWrite();',
					'}',
				].join('\n'),
				'tools/zz_t/server/index.ts': [
					"import { sharedWrite } from '../shared/writer.ts';",
					"import { helper } from './helper.ts';",
					'export async function act(): Promise<void> {',
					'\tawait sharedWrite();',
					'\tawait helper();',
					'}',
				].join('\n'),
			});
			expect(closure.members.has('tools/zz_t/shared/writer.ts#sharedWrite')).toBe(true);
			expect(cells).toEqual({
				'tools/zz_t/server/helper.ts :: helper': { sharedWrite: 1 },
				'tools/zz_t/server/index.ts :: act': { sharedWrite: 1 },
			});
		});

		test('`abstract class`, `var` and `enum` are units of their own: credited to their own name, reachable by importers', () => {
			const { closure, cells } = injected({
				[MATRIX_WRITE]: MATRIX_WRITE_CONTROL,
				'src/zz_a/abs.ts': [
					`import { updateMatrixKeyData } from '${MW_FROM_SRC}';`,
					'export function before(): number {',
					'\treturn 1;',
					'}',
					'export abstract class Abs {',
					'\tasync go(): Promise<void> {',
					"\t\tawait updateMatrixKeyData('x');",
					'\t}',
					'}',
					'export var zzVar = async (): Promise<void> => {',
					"\tawait updateMatrixKeyData('x');",
					'};',
					'export const enum Mode {',
					'\tA = 1,',
					'}',
				].join('\n'),
				'tools/zz_a/server/index.ts': [
					"import { Abs, Mode, zzVar } from '../../../src/zz_a/abs.ts';",
					'export async function act(x: Abs): Promise<void> {',
					'\tawait x.go();',
					'}',
					'export async function act2(): Promise<Mode> {',
					'\tawait zzVar();',
					'\treturn Mode.A;',
					'}',
				].join('\n'),
			});
			expect(closure.members.has('src/zz_a/abs.ts#before')).toBe(false);
			expect(cells).toEqual({
				'tools/zz_a/server/index.ts :: act': { Abs: 1 },
				'tools/zz_a/server/index.ts :: act2': { zzVar: 1 },
			});
			expect(closure.unresolvedBindings('tools/zz_a/server/index.ts')).toEqual([]);
		});

		test('EVIDENCE needs a RESOLVED path: an escape edge makes a cell but proves nothing', () => {
			const { closure } = injected({
				[MATRIX_WRITE]: MATRIX_WRITE_CONTROL,
				'src/zz_p/eng.ts': [
					`import { updateMatrixKeyData } from '${MW_FROM_SRC}';`,
					'export async function refusing(empty: boolean): Promise<void> {',
					"\tif (empty) throw new Error('REFUSED');",
					"\tawait updateMatrixKeyData('x');",
					'}',
				].join('\n'),
				'tools/zz_p/server/index.ts': [
					"import * as eng from '../../../src/zz_p/eng.ts';",
					'export async function escapes(run: (m: unknown) => void): Promise<void> {',
					'\trun(eng);',
					'}',
					'export async function calls(): Promise<void> {',
					'\tawait eng.refusing(true);',
					'}',
				].join('\n'),
			});
			const evidence = 'src/zz_p/eng.ts#refusing';
			expect(closure.reaches('tools/zz_p/server/index.ts#escapes', evidence)).toBe(true);
			expect(closure.reachesPrecisely('tools/zz_p/server/index.ts#escapes', evidence)).toBe(false);
			expect(closure.reachesPrecisely('tools/zz_p/server/index.ts#calls', evidence)).toBe(true);
		});

		test('an awaited import in VALUE position ESCAPES — only a whole `await import(x);` statement is a side-effect load', () => {
			// `return await import(x)`, a reassignment, `deps ?? await import(x)` and a
			// ternary branch (one line, and biome-wrapped) hand the module on as a value. Each
			// was once claimed as a side-effect load: no binding, no escape, no report — a
			// writer called through it had no cell. Now each ESCAPES (every export reached).
			const ENG = `'../../../src/zz_s/engine.ts'`;
			const { closure, cells } = injected({
				[MATRIX_WRITE]: MATRIX_WRITE_CONTROL,
				'src/zz_s/engine.ts': ENGINE,
				'tools/zz_s/server/index.ts': [
					'export async function assignLet(): Promise<void> {',
					'\tlet m;',
					`\tm = await import(${ENG});`,
					'\tawait m.zzWrite();',
					'}',
					'async function loadA() {',
					`\treturn await import(${ENG});`,
					'}',
					'export async function viaReturn(): Promise<void> {',
					'\tconst m = await loadA();',
					'\tawait m.zzWrite();',
					'}',
					'export async function viaDeps(deps?: unknown): Promise<void> {',
					`\tconst m = deps ?? await import(${ENG});`,
					'\tawait m.zzWrite();',
					'}',
					'export async function viaTernary(c: boolean): Promise<void> {',
					`\tconst m = c ? null : await import(${ENG});`,
					'\tawait m?.zzWrite();',
					'}',
					'export async function viaWrapped(c: boolean): Promise<void> {',
					'\tconst m = c',
					'\t\t? null',
					`\t\t: await import(${ENG});`,
					'\tawait m?.zzWrite();',
					'}',
					'export async function viaAssignWrapped(): Promise<void> {',
					'\tconst m =',
					`\t\tawait import(${ENG});`,
					'\tawait m.zzWrite();',
					'}',
					// a STATEMENT-position load discards the namespace: no edge, and not reported
					'export async function sideEffect(): Promise<void> {',
					`\tawait import(${ENG});`,
					'}',
				].join('\n'),
			});
			expect(cells).toEqual({
				'tools/zz_s/server/index.ts :: assignLet': { zzWrite: 1 },
				// the loader carries the cell; its caller reaches it inside its own server
				'tools/zz_s/server/index.ts :: loadA': { zzWrite: 1 },
				'tools/zz_s/server/index.ts :: viaAssignWrapped': { zzWrite: 1 },
				'tools/zz_s/server/index.ts :: viaDeps': { zzWrite: 1 },
				'tools/zz_s/server/index.ts :: viaTernary': { zzWrite: 1 },
				'tools/zz_s/server/index.ts :: viaWrapped': { zzWrite: 1 },
			});
			expect(
				closure.reaches('tools/zz_s/server/index.ts#viaReturn', 'src/zz_s/engine.ts#zzWrite'),
			).toBe(true);
			expect([...closure.edgesOf('tools/zz_s/server/index.ts#sideEffect').keys()]).toEqual([]);
			expect(closure.unresolvedDynamicImports('tools/zz_s/server/index.ts')).toEqual([]);
			expect(closure.unresolvedBindings('tools/zz_s/server/index.ts')).toEqual([]);
		});

		test('an EXPORTED module-scope dynamic binding resolves ACROSS files — destructured name, namespace member, escaping namespace', () => {
			// `export const { a } = await import(x)` (resolveExportOrType follows it), `export
			// const ns = await import(x)` (the unit `ns` escapes to every export of x), and an
			// importer's `import * as exp` escaping as a value (allExports lists both).
			const { closure, cells } = injected({
				[MATRIX_WRITE]: MATRIX_WRITE_CONTROL,
				'src/zz_e/exporter.ts': [
					`export const { updateMatrixKeyData } = await import('${MW_FROM_SRC}');`,
					`export const mw = await import('${MW_FROM_SRC}');`,
				].join('\n'),
				'tools/zz_e/server/index.ts': [
					"import { mw, updateMatrixKeyData } from '../../../src/zz_e/exporter.ts';",
					"import * as exp from '../../../src/zz_e/exporter.ts';",
					'export async function viaName(): Promise<void> {',
					"\tawait updateMatrixKeyData('t');",
					'}',
					'export async function viaNs(): Promise<void> {',
					"\tawait mw.updateMatrixKeyData('t');",
					'}',
					'export async function viaValue(run: (m: unknown) => void): Promise<void> {',
					'\trun(exp);',
					'}',
				].join('\n'),
			});
			expect(cells).toEqual({
				'tools/zz_e/server/index.ts :: viaName': { updateMatrixKeyData: 1 },
				'tools/zz_e/server/index.ts :: viaNs': { mw: 1 },
				'tools/zz_e/server/index.ts :: viaValue': { mw: 1, updateMatrixKeyData: 1 },
			});
			expect(closure.witness('tools/zz_e/server/index.ts#viaNs')).toEqual([
				'tools/zz_e/server/index.ts#viaNs',
				'src/zz_e/exporter.ts#mw',
				`${MATRIX_WRITE}#updateMatrixKeyData`,
			]);
			expect(closure.unresolvedBindings('src/zz_e/exporter.ts')).toEqual([]);
			expect(closure.unresolvedBindings('tools/zz_e/server/index.ts')).toEqual([]);
		});

		test('a TYPE declaration is no reference — an interface method signature named after a writer gives no edge; a runtime statement after it does', () => {
			const { closure, cells } = injected({
				[MATRIX_WRITE]: MATRIX_WRITE_CONTROL,
				'tools/zz_y/server/index.ts': [
					"import { zzWrite } from '../../../src/zz_ctl/engine.ts';",
					'export async function before(): Promise<number> {',
					'\treturn 1;',
					'}',
					'export interface Shape {',
					'\tzzWrite(x: string): void;',
					'\tother: typeof zzWrite;',
					'}',
					'export type Alias =',
					'\t| { zzWrite(): void }',
					'\t| null;',
				].join('\n'),
				'src/zz_ctl/engine.ts': ENGINE,
				// a module-level call AFTER an interface opens no unit: it lands in the type
				// unit, and only the declaration part of that unit is blanked
				'tools/zz_z/server/index.ts': [
					"import { zzWrite } from '../../../src/zz_ctl/engine.ts';",
					'interface Verdict {',
					'\tzzWrite(): void;',
					'}',
					'',
					'await zzWrite();',
				].join('\n'),
			});
			expect(cells).toEqual({
				'tools/zz_z/server/index.ts :: <type:Verdict>': { zzWrite: 1 },
			});
			for (const key of [
				'tools/zz_y/server/index.ts#before',
				'tools/zz_y/server/index.ts#<type:Shape>',
				'tools/zz_y/server/index.ts#<type:Alias>',
			]) {
				expect([...closure.edgesOf(key).keys()], key).toEqual([]);
			}
		});

		test('an OFF-HOME psql writer (a `runPsql(` call with a matrix DML statement) is a SEED; a psql export or read is not', () => {
			const PSQL = "import { runPsql } from '../core/install/pg_exec.ts';";
			const { closure, cells } = injected({
				[MATRIX_WRITE]: MATRIX_WRITE_CONTROL,
				'src/core/install/pg_exec.ts':
					'export async function runPsql(args: string[]): Promise<number> {\n\treturn args.length;\n}',
				'src/zz_q/io.ts': [
					PSQL,
					'export async function fixTld(tipo: string): Promise<void> {',
					'\tconst statement = `UPDATE "matrix_ontology" SET "string" = jsonb_set("string", \'{x}\', \'1\') WHERE section_tipo = \'${tipo}\'`;',
					'\tawait runPsql([statement]);',
					'}',
					'export async function load(table: string): Promise<void> {',
					'\tawait runPsql([`\\\\copy ${table} (a, b) FROM STDIN`]);',
					'}',
					'export async function dump(): Promise<void> {',
					'\tawait runPsql([`\\\\copy (SELECT 1 FROM matrix_ontology) TO STDOUT`]);',
					'}',
					'export async function probe(): Promise<void> {',
					"\tawait runPsql(['SELECT count(*) FROM matrix_ontology']);",
					'}',
					// DML with no psql call is the POOL's business (T2.a), not a psql seed
					'export function describeIt(): string {',
					"\treturn 'UPDATE matrix_ontology is what fixTld does';",
					'}',
				].join('\n'),
				'tools/zz_q/server/index.ts': [
					"import { dump, fixTld, load, probe } from '../../../src/zz_q/io.ts';",
					'export async function repair(): Promise<void> {',
					"\tawait fixTld('x0');",
					'}',
					'export async function reimport(): Promise<void> {',
					"\tawait load('matrix_x');",
					'}',
					'export async function exportIt(): Promise<void> {',
					'\tawait dump();',
					'\tawait probe();',
					'}',
				].join('\n'),
			});
			expect(closure.psqlSeeds).toEqual(['src/zz_q/io.ts#fixTld', 'src/zz_q/io.ts#load']);
			expect(cells).toEqual({
				'tools/zz_q/server/index.ts :: reimport': { load: 1 },
				'tools/zz_q/server/index.ts :: repair': { fixTld: 1 },
			});
			expect(closure.witness('tools/zz_q/server/index.ts#repair')).toEqual([
				'tools/zz_q/server/index.ts#repair',
				'src/zz_q/io.ts#fixTld',
			]);
			expect(isPsqlMatrixWriter('await runPsql([`TRUNCATE TABLE matrix_x`]);')).toBe(true);
			// the MAIN `matrix` table, bare or quoted, and its \\copy import
			expect(
				isPsqlMatrixWriter("await runPsql(conn, ['-c', `UPDATE matrix_test SET a = 1`]);"),
			).toBe(true);
			expect(isPsqlMatrixWriter('await runPsql([`DELETE FROM "matrix" WHERE a = 1`]);')).toBe(true);
			expect(isPsqlMatrixWriter('await runPsql([`\\copy matrix FROM STDIN`]);')).toBe(true);
			expect(isPsqlMatrixWriter('await runPsql([`UPDATE matrixfoo SET a = 1`]);')).toBe(false);
			expect(isPsqlMatrixWriter('await runPsql([`update matrix_x set a = 1`]);')).toBe(false);
			// a table EXPORT (`\copy <table> TO`) writes nothing; the same table FROM is an import
			expect(isPsqlMatrixWriter('await runPsql([`\\copy matrix_x TO STDOUT`]);')).toBe(false);
			expect(isPsqlMatrixWriter('await runPsql([`\\copy matrix_x FROM STDIN`]);')).toBe(true);
			// and the raw-primitive rule judges a psql door as RAW
			const judged = bypassRuleProblems(closure, [
				{
					action: 'tools/zz_q/server/index.ts :: repair',
					door: 'fixTld',
					cell: { verdict: 'derived-state', reason: 'x' },
				},
			]);
			expect(judged.raw).toEqual(['tools/zz_q/server/index.ts :: repair × fixTld']);
			expect(judged.refused).toEqual(['tools/zz_q/server/index.ts :: repair × fixTld']);
		});

		test('a `.js` spelling resolves to the `.ts` beside it; a relative static import naming no corpus file is REPORTED', () => {
			const { closure, cells } = injected({
				[MATRIX_WRITE]: MATRIX_WRITE_CONTROL,
				'src/zz_ctl/engine.ts': ENGINE,
				'tools/zz_j/server/index.ts': [
					"import { zzWrite } from '../../../src/zz_ctl/engine.js';",
					"export { zzRead } from '../../../src/zz_ctl/missing.ts';",
					"import { x } from './gone.ts';",
					'export async function act(): Promise<void> {',
					'\tawait zzWrite();',
					'}',
				].join('\n'),
			});
			expect(cells).toEqual({ 'tools/zz_j/server/index.ts :: act': { zzWrite: 1 } });
			expect(closure.outOfCorpusImports('tools/zz_j/server/index.ts')).toEqual([
				{
					site: "tools/zz_j/server/index.ts:3: './gone.ts'",
					target: 'tools/zz_j/server/gone.ts',
				},
				{
					site: "tools/zz_j/server/index.ts:2: '../../../src/zz_ctl/missing.ts'",
					target: 'src/zz_ctl/missing.ts',
				},
			]);
		});

		test('an import spelled inside a string or template text is no edge and no out-of-corpus site; a substitution still is code', () => {
			const { closure, cells } = injected({
				[MATRIX_WRITE]: MATRIX_WRITE_CONTROL,
				'src/zz_ctl/engine.ts': ENGINE,
				'tools/zz_k/server/index.ts': [
					'export const SCRIPT = `bun -e \'const b = await import("./gone.ts"); const { y } = await import("./gone2.ts");\'`;',
					'export const LINE = \'await import("./gone3.ts");\';',
					'export async function act(): Promise<string> {',
					"\tconst { zzWrite } = await import('../../../src/zz_ctl/engine.ts');",
					'\tawait zzWrite();',
					"\treturn `${(await import('./gone4.ts')).x}`;",
					'}',
				].join('\n'),
			});
			expect(cells).toEqual({ 'tools/zz_k/server/index.ts :: act': { zzWrite: 1 } });
			expect(closure.outOfCorpusImports('tools/zz_k/server/index.ts')).toEqual([
				{
					site: "tools/zz_k/server/index.ts:6: './gone4.ts'",
					target: 'tools/zz_k/server/gone4.ts',
				},
			]);
		});

		test('the primitive list is DERIVED from EVERY runtime export form: new ones are primitives until classified', () => {
			expect(
				deriveRawPrimitives(
					[
						MATRIX_WRITE_CONTROL,
						'export async function zzReplaceKey(t: string) {}',
						'export const zzArrow = async (t: string) => {};',
						'export class ZzWriter {}',
						'export abstract class ZzAbstract {}',
						'export var zzVar = async () => {};',
						'export const enum ZzEnum { A = 1 }',
						'export type ZzType = string;',
						'export interface ZzShape { a: string }',
						'export declare function zzAmbient(): void;',
						'const zzLocal = 1;',
						'export { zzLocal as zzListed, type ZzType as ZzAlias };',
					].join('\n'),
				),
			).toEqual([
				'updateMatrixKeyData',
				'zzReplaceKey',
				'zzArrow',
				'ZzWriter',
				'ZzAbstract',
				'zzVar',
				'ZzEnum',
				'zzListed',
			]);
			// a classified constant stays out; an `export *` is refused, never guessed
			expect(deriveRawPrimitives('export const MATRIX_COPY_COLUMNS = [];')).toEqual([]);
			expect(() => deriveRawPrimitives("export * from './zz.ts';")).toThrow(/cannot be enumerated/);
			// a DESTRUCTURED export names nothing the patterns can read: refused, never dropped
			expect(() => moduleRuntimeExports('export const { a, b } = makeWriters();')).toThrow(
				/DESTRUCTURED/,
			);
			expect(() => moduleRuntimeExports('export let [c] = x;')).toThrow(/DESTRUCTURED/);
			// a DEFAULT export is `default` (not its declaration's name) — and a default
			// primitive has no call name, so the derivation refuses it
			expect(moduleRuntimeExports('export default async function zzDef() {}')).toEqual(['default']);
			expect(moduleRuntimeExports('const a = 1;\nexport default a;')).toEqual(['default']);
			expect(() => deriveRawPrimitives('export default async function zzDef() {}')).toThrow(
				/export default/,
			);
		});

		test('the raw-primitive rule and the lossless rule judge by RESOLVED door and by real legs', () => {
			const files: Record<string, string> = {
				[MATRIX_WRITE]: MATRIX_WRITE_CONTROL,
				'tools/zz_raw/server/index.ts': [
					"import { readMatrixKeyForUpdate, updateMatrixKeyData } from '../../../src/core/db/matrix_write.ts';",
					'export async function locked(): Promise<void> {',
					"\tawait readMatrixKeyForUpdate('t');",
					"\tawait updateMatrixKeyData('t');",
					'}',
					'export async function unlocked(): Promise<void> {',
					"\tawait updateMatrixKeyData('t');",
					'}',
					'export async function bare(): Promise<void> {',
					"\tawait updateMatrixKeyData('t');",
					'}',
				].join('\n'),
				// a same-named wrapper elsewhere: the primitive's door becomes `file#name`
				'tools/zz_twin/server/index.ts': [
					"import { updateMatrixKeyData as raw } from '../../../src/core/db/matrix_write.ts';",
					'export async function updateMatrixKeyData(): Promise<void> {',
					"\tawait raw('t');",
					'}',
				].join('\n'),
			};
			const closure = buildWriterClosure({
				files: Object.keys(files),
				read: (rel) => files[rel] as string,
			});
			const door = `${MATRIX_WRITE}#updateMatrixKeyData`;
			const cells = toolServerCells(closure);
			expect(cells.get('tools/zz_raw/server/index.ts :: locked')?.get(door)).toBe(1);
			const reason = 'r'.repeat(61);
			const injected: CensusCell[] = [
				{
					action: 'tools/zz_raw/server/index.ts :: locked',
					door,
					cell: { verdict: 'lossless', lockedRead: true, readVerified: true, reason },
				},
				{
					action: 'tools/zz_raw/server/index.ts :: unlocked',
					door,
					cell: { verdict: 'lossless', lockedRead: true, readVerified: true, reason },
				},
				{
					action: 'tools/zz_raw/server/index.ts :: bare',
					door,
					cell: { verdict: 'new-record', reason },
				},
				{
					action: 'tools/zz_twin/server/index.ts :: updateMatrixKeyData',
					door,
					cell: { verdict: 'PENDING', closes: 'a named closure item', reason },
				},
			];
			expect(bypassRuleProblems(closure, injected)).toEqual({
				raw: injected.map(({ action }) => `${action} × ${door}`).sort(),
				bypass: injected.map(({ action }) => `${action} × ${door}`).sort(),
				refused: [
					`tools/zz_raw/server/index.ts :: bare × ${door}`,
					`tools/zz_raw/server/index.ts :: unlocked × ${door}`,
				],
			});
			const proofs: CensusCell[] = [
				{
					action: 'a :: real',
					door: 'd',
					cell: { verdict: 'lossless', proof: LEGS.timecode, reason },
				},
				{
					action: 'a :: invented',
					door: 'd',
					cell: { verdict: 'lossless', proof: 'LEG 9 — nothing' as LegTitle, reason },
				},
			];
			expect(losslessProblems(closure, [...injected, ...proofs], Object.values(LEGS))).toEqual([
				"a :: invented × d: proof 'LEG 9 — nothing' is not a behavioural leg",
				`tools/zz_raw/server/index.ts :: unlocked × ${door}: claims a locked read the action never takes`,
			]);
		});

		test('a LITERAL dynamic import naming no corpus file is REPORTED in every form — joined to the out-of-corpus report', () => {
			// Each handled form used to bind only a RESOLVED target and blank the site either
			// way: an out-of-corpus writer behind `const { w } = await import('../x.ts')`
			// had no cell and no report, and skipped the target-class judgment a static
			// import of the same file faces.
			const file = 'tools/zz_o/server/index.ts';
			const { closure, cells } = injected({
				[MATRIX_WRITE]: MATRIX_WRITE_CONTROL,
				[file]: [
					'export async function act(deps?: unknown): Promise<unknown> {',
					"\tconst { w } = await import('./helper_missing.ts');",
					"\tconst ns = await import('../../../src/nowhere.ts');",
					"\tconst [{ a }] = await Promise.all([import('./pa.ts')]);",
					"\timport('./then.ts').then(({ t }) => t());",
					"\tawait (await import('./gone.ts')).w();",
					"\tawait import('../../../install/zz_side.ts');",
					"\tconst m = deps ?? (await import('./held.ts'));",
					"\treturn import('./escaped.ts');",
					'}',
				].join('\n'),
			});
			expect(cells).toEqual({});
			expect(
				closure
					.outOfCorpusImports(file)
					.map(({ site, target }) => `${site.split(': ')[0]} ${target}`)
					.sort(),
			).toEqual([
				`${file}:2 tools/zz_o/server/helper_missing.ts`,
				`${file}:3 src/nowhere.ts`,
				`${file}:4 tools/zz_o/server/pa.ts`,
				`${file}:5 tools/zz_o/server/then.ts`,
				`${file}:6 tools/zz_o/server/gone.ts`,
				`${file}:7 install/zz_side.ts`,
				`${file}:8 tools/zz_o/server/held.ts`,
				`${file}:9 tools/zz_o/server/escaped.ts`,
			]);
			// a literal is never a COMPUTED-specifier site
			expect(closure.unresolvedDynamicImports(file)).toEqual([]);
		});

		test('a LOCKED-READ claim needs a RESOLVED edge — an escaping matrix_write namespace takes no lock', () => {
			const file = 'tools/zz_l/server/index.ts';
			const { closure, cells } = injected({
				[MATRIX_WRITE]: MATRIX_WRITE_CONTROL,
				[file]: [
					`import { updateMatrixKeyData } from '${MW_FROM_TOOL}';`,
					'function helper(m: unknown): void {}',
					// the namespace handed on whole: an ESCAPE reaches readMatrixKeyForUpdate too
					'export async function escaped(): Promise<void> {',
					`\tconst mw = await import('${MW_FROM_TOOL}');`,
					'\thelper(mw);',
					"\tawait updateMatrixKeyData('t');",
					'}',
					// the DI seam, a member call only: bound, and no lock referenced at all
					'export async function seam(deps?: unknown): Promise<void> {',
					`\tconst m = deps ?? (await import('${MW_FROM_TOOL}'));`,
					"\tawait m.updateMatrixKeyData('t');",
					'}',
				].join('\n'),
			});
			const lock = `${MATRIX_WRITE}#readMatrixKeyForUpdate`;
			expect(closure.edgesOf(`${file}#escaped`).has(lock)).toBe(true);
			expect(closure.preciseEdgesOf(`${file}#escaped`).has(lock)).toBe(false);
			expect(closure.preciseEdgesOf(`${file}#seam`).has(lock)).toBe(false);
			const reason = 'r'.repeat(61);
			const claimed: CensusCell[] = Object.entries(cells).flatMap(([action, doors]) =>
				Object.keys(doors).map((door) => ({
					action,
					door,
					cell: { verdict: 'lossless', lockedRead: true, readVerified: true, reason } as Cell,
				})),
			);
			expect(claimed.map(({ action, door }) => `${action} × ${door}`).sort()).toEqual([
				`${file} :: escaped × updateMatrixKeyData`,
				`${file} :: seam × updateMatrixKeyData`,
			]);
			expect(bypassRuleProblems(closure, claimed).refused).toEqual([
				`${file} :: escaped × updateMatrixKeyData`,
				`${file} :: seam × updateMatrixKeyData`,
			]);
			expect(losslessProblems(closure, claimed, Object.values(LEGS))).toEqual([
				`${file} :: escaped × updateMatrixKeyData: claims a locked read the action never takes`,
				`${file} :: seam × updateMatrixKeyData: claims a locked read the action never takes`,
			]);
		});

		test('a local HOLDING a value-position import is bound: its member calls count per SITE, a new call is red', () => {
			// Before, `deps ?? (await import(x))` only ESCAPED: every export got ONE site per
			// occurrence of the import, so 1 and 3 raw calls both derived `sites: 1`.
			const file = 'tools/zz_h/server/index.ts';
			const withCalls = (calls: number) =>
				injected({
					[MATRIX_WRITE]: MATRIX_WRITE_CONTROL,
					[file]: [
						'export async function act(deps?: unknown, c = false): Promise<void> {',
						`\tconst m = deps ?? (await import('${MW_FROM_TOOL}'));`,
						...Array.from({ length: calls }, () => "\tawait m.updateMatrixKeyData('t');"),
						'}',
						'export async function branch(c: boolean): Promise<void> {',
						'\tconst b = c',
						'\t\t? null',
						`\t\t: await import('${MW_FROM_TOOL}');`,
						"\tawait b?.updateMatrixKeyData('t');",
						'}',
					].join('\n'),
				});
			expect(withCalls(1).cells).toEqual({
				[`${file} :: act`]: { updateMatrixKeyData: 1 },
				[`${file} :: branch`]: { updateMatrixKeyData: 1 },
			});
			expect(withCalls(3).cells[`${file} :: act`]).toEqual({ updateMatrixKeyData: 3 });
			const { closure } = withCalls(1);
			// precise, and no over-approximated edge to the module's OTHER exports — the
			// optional-chained `b?.member` of a held import included
			for (const unit of ['act', 'branch']) {
				expect([...closure.edgesOf(`${file}#${unit}`).keys()], unit).toEqual([
					`${MATRIX_WRITE}#updateMatrixKeyData`,
				]);
			}
			expect(closure.reachesPrecisely(`${file}#act`, `${MATRIX_WRITE}#updateMatrixKeyData`)).toBe(
				true,
			);
		});

		test('the REFUSES rule reads CODE — a string naming the refusal vouches for nothing, in the action or in its evidence — and needs a RESOLVED path to the evidence', () => {
			const file = 'tools/zz_rf/server/index.ts';
			const guards = 'src/zz_rf/guards.ts';
			const { closure, cells } = injected({
				[MATRIX_WRITE]: MATRIX_WRITE_CONTROL,
				[guards]: [
					'export function guard(x: unknown): boolean {',
					'\treturn x !== null;',
					'}',
					'export function holdsForeignValue(x: unknown): boolean {',
					'\treturn guard(x);',
					'}',
				].join('\n'),
				[file]: [
					`import { updateMatrixKeyData } from '${MW_FROM_TOOL}';`,
					'function holdsForeignValue(x: unknown): boolean {',
					'\treturn x !== null;',
					'}',
					'function spokenGuard(x: unknown): boolean {',
					"\tconsole.log('holdsForeignValue(x)', x);",
					'\treturn false;',
					'}',
					'function realGuard(x: unknown): boolean {',
					'\treturn holdsForeignValue(x);',
					'}',
					'export async function spoken(x: unknown): Promise<void> {',
					"\tconsole.log('holdsForeignValue(x)', x);",
					"\tawait updateMatrixKeyData('t');",
					'}',
					'export async function real(x: unknown): Promise<void> {',
					'\tif (holdsForeignValue(x)) return;',
					"\tawait updateMatrixKeyData('t');",
					'}',
					'export async function spokenVia(x: unknown): Promise<void> {',
					'\tspokenGuard(x);',
					"\tawait updateMatrixKeyData('t');",
					'}',
					'export async function realVia(x: unknown): Promise<void> {',
					'\tif (realGuard(x)) return;',
					"\tawait updateMatrixKeyData('t');",
					'}',
					'export async function unreached(): Promise<void> {',
					"\tawait updateMatrixKeyData('t');",
					'}',
					// the guards namespace handed on whole: an ESCAPE edge to every export, no call
					'function hand(m: unknown): void {}',
					'export async function escaped(): Promise<void> {',
					"\tconst g = await import('../../../src/zz_rf/guards.ts');",
					'\thand(g);',
					"\tawait updateMatrixKeyData('t');",
					'}',
				].join('\n'),
			});
			const evidenceOf: Record<string, string> = {
				spokenVia: `${file}#spokenGuard`,
				realVia: `${file}#realGuard`,
				unreached: `${file}#realGuard`,
				escaped: `${guards}#holdsForeignValue`,
			};
			const judged: CensusCell[] = Object.entries(cells).flatMap(([action, doors]) =>
				Object.keys(doors).map((door) => {
					const unit = action.slice(action.indexOf(' :: ') + 4);
					const evidence = evidenceOf[unit];
					return {
						action,
						door,
						cell: {
							verdict: 'refuses',
							must_contain: 'holdsForeignValue(',
							...(evidence === undefined ? {} : { evidence }),
							reason: 'r'.repeat(61),
						} as Cell,
					};
				}),
			);
			expect(judged.map(({ action }) => action).sort()).toEqual(
				['escaped', 'real', 'realVia', 'spoken', 'spokenVia', 'unreached'].map(
					(unit) => `${file} :: ${unit}`,
				),
			);
			// the escape IS an edge (enough for a cell), just not a proof
			expect(closure.reaches(`${file}#escaped`, `${guards}#holdsForeignValue`)).toBe(true);
			const bodyOf = (action: string) => closure.bodies.get(closureKey(action)) ?? '';
			// the spelling IS in the raw text of both spoken bodies: only reading CODE refuses them
			expect(bodyOf(`${file} :: spoken`)).toContain('holdsForeignValue(');
			expect(closure.bodies.get(`${file}#spokenGuard`)).toContain('holdsForeignValue(');
			expect(refusesProblems(closure, judged, bodyOf)).toEqual([
				`${file} :: escaped × updateMatrixKeyData: ${guards}#holdsForeignValue is not reached through RESOLVED references`,
				`${file} :: spoken × updateMatrixKeyData: holdsForeignValue( is not in its code`,
				`${file} :: spokenVia × updateMatrixKeyData: holdsForeignValue( is not in the code of ${file}#spokenGuard`,
				`${file} :: unreached × updateMatrixKeyData: ${file}#realGuard is not reached through RESOLVED references`,
			]);
		});

		test('the BYPASS rule is PATH-based: a raw write one or two DIFFERENTLY-NAMED wrappers deep is judged, a write through a chokepoint is not', () => {
			// The TOOLS-6 shape moved one declaration deeper: updateCache calling a src
			// wrapper that only calls updateMatrixKeyData. A door-based raw rule saw a
			// non-raw door and let a `lossless` verdict pass — and BOTH pins then read
			// "shrank, lower it". Judged by path, the wrapper is the same bypass.
			const tool = 'tools/tool_update_cache/server/index.ts';
			const { closure, cells } = injected({
				[MATRIX_WRITE]: MATRIX_WRITE_CONTROL,
				'src/core/media/wrap.ts': [
					"import { updateMatrixKeyData } from '../db/matrix_write.ts';",
					'export async function writeRefreshedMedia(): Promise<void> {',
					"\tawait updateMatrixKeyData('t');",
					'}',
				].join('\n'),
				'src/zz_deep/outer.ts': [
					"import { writeRefreshedMedia } from '../core/media/wrap.ts';",
					'async function middle(): Promise<void> {',
					'\tawait writeRefreshedMedia();',
					'}',
					'export async function outer(): Promise<void> {',
					'\tawait middle();',
					'}',
				].join('\n'),
				// a CHOKEPOINT stand-in (the cut below), a door through it, and a door that
				// goes through it AND around it
				'src/zz_cp/record.ts': [
					"import { updateMatrixKeyData } from '../core/db/matrix_write.ts';",
					'export async function persist(): Promise<void> {',
					"\tawait updateMatrixKeyData('t');",
					'}',
				].join('\n'),
				'src/zz_cp/door.ts': [
					"import { persist } from './record.ts';",
					"import { writeRefreshedMedia } from '../core/media/wrap.ts';",
					'export async function saveVia(): Promise<void> {',
					'\tawait persist();',
					'}',
					'export async function mixed(): Promise<void> {',
					'\tawait persist();',
					'\tawait writeRefreshedMedia();',
					'}',
				].join('\n'),
				[tool]: [
					"import { writeRefreshedMedia } from '../../../src/core/media/wrap.ts';",
					"import { outer } from '../../../src/zz_deep/outer.ts';",
					"import { mixed, saveVia } from '../../../src/zz_cp/door.ts';",
					'export async function updateCache(): Promise<void> {',
					'\tawait writeRefreshedMedia();',
					'}',
					'export async function deep(): Promise<void> {',
					'\tawait outer();',
					'}',
					'export async function viaChokepoint(): Promise<void> {',
					'\tawait saveVia();',
					'}',
					'export async function both(): Promise<void> {',
					'\tawait mixed();',
					'}',
				].join('\n'),
			});
			expect(cells).toEqual({
				[`${tool} :: both`]: { mixed: 1 },
				[`${tool} :: deep`]: { outer: 1 },
				[`${tool} :: updateCache`]: { writeRefreshedMedia: 1 },
				[`${tool} :: viaChokepoint`]: { saveVia: 1 },
			});
			const cut = new Set(['src/zz_cp/record.ts#persist']);
			const reason = 'r'.repeat(61);
			const claimed = (cell: Cell): CensusCell[] =>
				Object.entries(cells).flatMap(([action, doors]) =>
					Object.keys(doors).map((door) => ({ action, door, cell })),
				);
			const lossless = bypassRuleProblems(
				closure,
				claimed({ verdict: 'lossless', readVerified: true, reason }),
				cut,
			);
			const bypassing = [
				`${tool} :: both × mixed`,
				`${tool} :: deep × outer`,
				`${tool} :: updateCache × writeRefreshedMedia`,
			];
			// the door-based rule's view: NO raw door at all …
			expect(lossless.raw).toEqual([]);
			// … the path-based one: every write that avoids the cut, however deep
			expect(lossless.bypass).toEqual(bypassing);
			expect(lossless.refused).toEqual(bypassing);
			expect(bypassOf(closure, 'outer', cut)).toEqual([
				'src/zz_deep/outer.ts#outer',
				'src/zz_deep/outer.ts#middle',
				'src/core/media/wrap.ts#writeRefreshedMedia',
				`${MATRIX_WRITE}#updateMatrixKeyData`,
			]);
			expect(bypassOf(closure, 'saveVia', cut)).toBeNull();
			// with NO cut the chokepoint stand-in is just another wrapper: saveVia bypasses too
			expect(bypassOf(closure, 'saveVia', new Set())).not.toBeNull();
			// PENDING and a stated bypass_reason are the ways out; a lossless readVerified is not
			expect(
				bypassRuleProblems(
					closure,
					claimed({ verdict: 'PENDING', closes: 'a named closure item', reason }),
					cut,
				).refused,
			).toEqual([]);
			expect(
				bypassRuleProblems(
					closure,
					claimed({ verdict: 'derived-state', reason, bypass_reason: reason }),
					cut,
				).refused,
			).toEqual([]);
			expect(
				bypassRuleProblems(
					closure,
					claimed({ verdict: 'derived-state', reason, bypass_reason: 'too short' }),
					cut,
				).refused,
			).toEqual(bypassing);
		});

		test('a psql SEED is found by BINDING — aliased import, namespace member, `deps ?? runPsql` — never by the bare name', () => {
			const pgExec = 'src/core/install/pg_exec.ts';
			const tool = 'tools/zz_p/server/index.ts';
			const { closure, cells } = injected({
				[MATRIX_WRITE]: MATRIX_WRITE_CONTROL,
				[pgExec]:
					'export async function runPsql(args: string[]): Promise<number> {\n\treturn args.length;\n}',
				'src/zz_p/io.ts': [
					"import { runPsql as psql } from '../core/install/pg_exec.ts';",
					"import * as pg from '../core/install/pg_exec.ts';",
					"import { runPsql } from '../core/install/pg_exec.ts';",
					'export async function aliased(): Promise<void> {',
					'\tawait psql([`UPDATE matrix_x SET a = 1`]);',
					'}',
					'export async function namespaced(): Promise<void> {',
					'\tawait pg.runPsql([`DELETE FROM matrix_x WHERE a = 1`]);',
					'}',
					'export async function seam(deps?: (a: string[]) => Promise<number>): Promise<void> {',
					'\tconst run = deps ?? runPsql;',
					'\tawait run([`TRUNCATE matrix_x`]);',
					'}',
				].join('\n'),
				// a LOCAL function that merely shares the name: the NAME view calls it a psql
				// writer, the binding knows it is not pg_exec's
				'src/zz_p/decoy.ts': [
					'function runPsql(args: string[]): string[] {',
					'\treturn args;',
					'}',
					'export function fake(): void {',
					'\trunPsql([`UPDATE matrix_x SET a = 1`]);',
					'}',
				].join('\n'),
				[tool]: [
					"import { aliased, namespaced, seam } from '../../../src/zz_p/io.ts';",
					"import { fake } from '../../../src/zz_p/decoy.ts';",
					"import { runPsql as sh } from '../../../src/core/install/pg_exec.ts';",
					'export async function act(): Promise<void> {',
					'\tawait aliased();',
					'\tawait namespaced();',
					'\tawait seam();',
					'\tfake();',
					'}',
					'export async function local(): Promise<void> {',
					"\tawait sh(['-c', `UPDATE matrix_test SET a = 1`]);",
					"\tawait sh(['-c', `UPDATE matrix_test SET a = 2`]);",
					'}',
				].join('\n'),
			});
			expect(closure.psqlSeeds).toEqual([
				'src/zz_p/io.ts#aliased',
				'src/zz_p/io.ts#namespaced',
				'src/zz_p/io.ts#seam',
				`${tool}#local`,
			]);
			expect(isPsqlMatrixWriter(closure.bodies.get('src/zz_p/decoy.ts#fake') ?? '')).toBe(true);
			expect(isPsqlMatrixWriter(closure.bodies.get('src/zz_p/io.ts#aliased') ?? '')).toBe(false);
			expect(cells).toEqual({
				[`${tool} :: act`]: { aliased: 1, namespaced: 1, seam: 1 },
				// the SELF cell counts the resolved runPsql reference sites, alias included
				[`${tool} :: local`]: { [`${tool}#local`]: 2 },
			});
			const judged = bypassRuleProblems(
				closure,
				Object.entries(cells).flatMap(([action, doors]) =>
					Object.keys(doors).map((door) => ({
						action,
						door,
						cell: { verdict: 'derived-state', reason: 'r'.repeat(61) } as Cell,
					})),
				),
			);
			expect(judged.raw).toEqual([
				`${tool} :: act × aliased`,
				`${tool} :: act × namespaced`,
				`${tool} :: act × seam`,
				`${tool} :: local × ${tool}#local`,
			]);
			expect(judged.refused).toEqual(judged.raw);
		});

		test('a tool-server unit that IS a psql seed carries a SELF cell — an action and a same-tool helper — and the raw rule refuses it unreasoned', () => {
			const file = 'tools/zz_r/server/index.ts';
			const { closure, cells } = injected({
				[MATRIX_WRITE]: MATRIX_WRITE_CONTROL,
				'src/core/install/pg_exec.ts':
					'export async function runPsql(args: string[]): Promise<number> {\n\treturn args.length;\n}',
				[file]: [
					"import { runPsql } from '../../../src/core/install/pg_exec.ts';",
					'export async function act(): Promise<void> {',
					"\tawait runPsql(['-c', `UPDATE matrix_x SET a = 1`]);",
					"\tawait runPsql(['-c', `UPDATE matrix_test SET a = 2`]);",
					'}',
					'async function helper(): Promise<void> {',
					'\tawait runPsql([`DELETE FROM matrix_y`]);',
					'}',
					// reaches the seed IN-HOME: censused once, on the helper's own cell
					'export async function act2(): Promise<void> {',
					'\tawait helper();',
					'}',
				].join('\n'),
			});
			expect(closure.psqlSeeds).toEqual([`${file}#act`, `${file}#helper`]);
			expect(cells).toEqual({
				[`${file} :: act`]: { [`${file}#act`]: 2 },
				[`${file} :: helper`]: { [`${file}#helper`]: 1 },
			});
			const reason = 'r'.repeat(61);
			const judged = bypassRuleProblems(
				closure,
				Object.entries(cells).flatMap(([action, doors]) =>
					Object.keys(doors).map((door) => ({
						action,
						door,
						cell: { verdict: 'derived-state', reason } as Cell,
					})),
				),
			);
			expect(judged.raw).toEqual([
				`${file} :: act × ${file}#act`,
				`${file} :: helper × ${file}#helper`,
			]);
			expect(judged.refused).toEqual(judged.raw);
		});

		test('the declaration splitter keeps the doors’ ORDER and splits a tool’s apiActions per action', () => {
			const source = [
				'export async function two(): Promise<void> {',
				"\tawait insertMatrixRecordWithCounter('t', 's');",
				"\tawait updateMatrixRecord('t', 's', 1, {});",
				'}',
			].join('\n');
			expect(declarationDoorCalls('src/x.ts', source, RAW_PRIMITIVES)[0]?.doors).toEqual(
				RAW_PRIMITIVES.filter((name) =>
					['insertMatrixRecordWithCounter', 'updateMatrixRecord'].includes(name),
				),
			);
			expect(
				declarationDoorCalls('tools/zz_ctl/server/index.ts', TOOL, ['w2']).map(
					(entry) => entry.name,
				),
			).toEqual(['tool.apiActions.run']);
		});

		test('a door CALL is the bare name: `obj.<door>(` and `<prefix><door>(` are not calls', () => {
			// callsName's contract; without this control a lookbehind drop stayed green
			const source = [
				'export async function decoys(): Promise<void> {',
				"\tawait repo.updateMatrixRecord('t', 's', 1, {});",
				"\tawait zzupdateMatrixRecord('t');",
				'}',
				'export async function real(): Promise<void> {',
				"\tawait updateMatrixRecord('t', 's', 1, {});",
				'}',
			].join('\n');
			expect(
				declarationDoorCalls('src/x.ts', source, ['updateMatrixRecord']).map((entry) => [
					entry.name,
					entry.doors,
				]),
			).toEqual([['real', ['updateMatrixRecord']]]);
		});

		test('the judge reports a missing door, an extra site and a vanished cell', () => {
			const derived = new Map([
				[
					'a :: x',
					new Map([
						['saveComponentData', 2],
						['zzNewDoor', 1],
					]),
				],
				['a :: y', new Map([['persistRecordKeys', 1]])],
			]);
			const census: Record<string, CensusRow> = {
				'a :: x': {
					doors: {
						saveComponentData: { verdict: 'new-record', reason: 'r' },
						zzGone: { verdict: 'new-record', reason: 'r' },
					},
				},
				'a :: stale': { doors: { saveComponentData: { verdict: 'new-record', reason: 'r' } } },
			};
			expect(censusProblems(derived, census)).toEqual({
				missingActions: ['a :: y'],
				staleActions: ['a :: stale'],
				missingCells: ['a :: x × zzNewDoor', 'a :: y × persistRecordKeys'],
				staleCells: ['a :: stale × saveComponentData', 'a :: x × zzGone'],
				siteMismatch: ['a :: x × saveComponentData: 2 site(s) in the source, 1 in the census'],
			});
		});
	});

	describe('LEG 4 — the verdicts are true of the source, not just of the table', () => {
		test("every 'confirmed' cell’s action really asks before writing", () => {
			for (const { action, door, cell } of CELLS) {
				if (cell.verdict !== 'confirmed') continue;
				const body = actionBody(action);
				expect(body.length, `${action}: could not locate the action's body`).toBeGreaterThan(0);
				expect(
					body.includes('confirm('),
					`${action} × ${door} is marked 'confirmed' but its own body never calls confirm()`,
				).toBe(true);
			}
		});

		test("every 'refuses' cell really carries its refusal — in the action's CODE, or in evidence it REACHES", () => {
			expect(CELLS.filter(({ cell }) => cell.verdict === 'refuses').length).toBeGreaterThan(0);
			expect(refusesProblems(CLOSURE, CELLS, actionBody)).toEqual([]);
		});

		test("every 'lossless' claim is PROVED here or declared read-verified; a locked-read claim really locks", () => {
			// The honesty rule: a lossless verdict is the strongest claim in the table, so it
			// may not be a bare assertion. Either a behavioural leg in this file proves it —
			// and the cell names that leg by its REAL title (LEGS, the list the describe()
			// calls use) — or the cell says out loud that it was verified by reading.
			expect(losslessProblems(CLOSURE, CELLS, Object.values(LEGS))).toEqual([]);
		});

		test("every 'PENDING' cell is tethered — a client one has NO confirmation, a server one names its closure", () => {
			for (const { action, door, cell } of CELLS) {
				if (cell.verdict !== 'PENDING') continue;
				expect(
					cell.closes.length,
					`${action} × ${door}: name the item that closes it`,
				).toBeGreaterThan(10);
				if (isServerAction(action)) continue; // key + SERVER_PENDING_TETHERS (the next test)
				const body = actionBody(action);
				expect(body.length, `${action}: could not locate the action's body`).toBeGreaterThan(0);
				expect(
					body.includes('confirm('),
					`${action} now confirms before writing — move its cell to 'confirmed' and lower PENDING_COUNT.`,
				).toBe(false);
			}
		});

		test('every SERVER PENDING cell is tethered to a FACT of its defect — an in-place fix that keeps the door is red too', () => {
			// The (action, door) key only catches a fix that CHANGES the door. Each server
			// PENDING cell therefore names the tether that turns red when the defect is fixed
			// in place: a behaviour test (the translation cells), or a derived fact of the
			// action's own resolved references.
			const tethered = new Set(Object.keys(SERVER_PENDING_TETHERS));
			const serverPending = CELLS.filter(
				({ action, cell }) => cell.verdict === 'PENDING' && isServerAction(action),
			).map(({ action, door }) => `${action} × ${door}`);
			expect(
				serverPending.sort(),
				'a server PENDING cell with no tether (or a stale tether)',
			).toEqual([...tethered].sort());
			for (const [label, tether] of Object.entries(SERVER_PENDING_TETHERS)) {
				const action = label.slice(0, label.lastIndexOf(' × '));
				if (typeof tether !== 'function') {
					// a tether of the DB-tier file — which holds its REGISTERED titles equal to the list
					expect(
						WRITEBACK_TETHER_TITLES.includes(tether.behaviour),
						`${label}: behaviour tether '${tether.behaviour}' is not in WRITEBACK_TETHERS`,
					).toBe(true);
					continue;
				}
				for (const problem of tether(action)) expect.unreachable(`${label}: ${problem}`);
			}
		});

		test('the PENDING list is SHRINK-ONLY', () => {
			const pending = CELLS.filter(({ cell }) => cell.verdict === 'PENDING').length;
			expect(
				pending,
				`PENDING grew (${pending} > ${PENDING_COUNT}). A new tool action that writes back over a stored component value must be LOSSLESS or CONFIRMED, not added to the backlog.`,
			).toBeLessThanOrEqual(PENDING_COUNT);
			expect(
				pending,
				`PENDING shrank to ${pending} — lower PENDING_COUNT so the ratchet keeps biting.`,
			).toBe(PENDING_COUNT);
		});
		test('every SERVER `refuses` cell is BEHAVIOUR-tethered — its refusal executed, not only spelled', () => {
			// `refusesProblems` reads a SPELLING; the refusal itself runs in the DB-tier file.
			// The server `refuses` cells are held EQUAL to SERVER_REFUSES_TETHERS' keys, and each
			// tether is a title of WRITEBACK_TETHERS (registered and running there).
			const serverRefuses = CELLS.filter(
				({ action, cell }) => cell.verdict === 'refuses' && isServerAction(action),
			).map(({ action, door }) => `${action} × ${door}`);
			expect(serverRefuses.length).toBeGreaterThan(0);
			expect(
				serverRefuses.sort(),
				'a server `refuses` cell with no behaviour tether (or a stale tether)',
			).toEqual(Object.keys(SERVER_REFUSES_TETHERS).sort());
			for (const [label, title] of Object.entries(SERVER_REFUSES_TETHERS)) {
				expect(
					WRITEBACK_TETHER_TITLES.includes(title),
					`${label}: behaviour tether '${title}' is not in WRITEBACK_TETHERS`,
				).toBe(true);
			}
		});

		test('no behaviour tether tethers NOTHING — every WRITEBACK_TETHERS title is named by a server cell', () => {
			const named = new Set<string>(Object.values(SERVER_REFUSES_TETHERS));
			for (const tether of Object.values(SERVER_PENDING_TETHERS)) {
				if (typeof tether !== 'function') named.add(tether.behaviour);
			}
			expect([...named].sort()).toEqual([...WRITEBACK_TETHER_TITLES].sort());
		});
	});

	// ---------------------------------------------------------------------------
	// THE JUDGES' OWN PREDICATES
	// ---------------------------------------------------------------------------
	// (The server `refuses` and PENDING cells' BEHAVIOUR tethers run on the suite database in
	// tool_lossless_writeback_tethers_native.test.ts — DB tier; this file stays DB-less.)

	describe('LEG 4 — the spelling reader and the out-of-corpus classes', () => {
		test('the spelling checks read CODE: a string or a comment naming the call cannot vouch for it', () => {
			expect(codeOnly("log('holdsForeignValue(x)'); // holdsForeignValue(y)")).not.toContain(
				'holdsForeignValue(',
			);
			expect(codeOnly('if (holdsForeignValue(x)) return;')).toContain('holdsForeignValue(');
		});

		test('the out-of-corpus tools .js classes are checked, not assumed — the client leg, or a LEAF', () => {
			const paragraphs = 'tools/tool_transcription/transcribers/lib/paragraphs.js';
			// the SERVER-run transcription lib is not a client file: only the leaf class admits it
			expect(CLIENT_FILES.includes(paragraphs)).toBe(false);
			expect(isImportFreeLeaf(paragraphs)).toBe(true);
			// a module that imports is no leaf
			expect(isImportFreeLeaf('tools/tool_lang/js/browser_translation.js')).toBe(false);
			// the CLASS judge, not only its predicates: the server-run lib only as a leaf; a
			// client file only as client JS; a tools .js OUTSIDE the client leg that IMPORTS
			// (the whisper worker pulls ../lib/*.js) in no class — so a widened class is red
			expect(admittedBy(paragraphs)).toEqual(['tools-js-leaf']);
			const client = 'tools/tool_lang/js/browser_translation.js';
			expect(CLIENT_FILES.includes(client)).toBe(true);
			expect(admittedBy(client)).toEqual(['tool-client-js']);
			const importer = 'tools/tool_transcription/transcribers/browser_whisper/browser_whisper.js';
			expect(existsSync(join(ROOT, importer))).toBe(true);
			expect(CLIENT_FILES.includes(importer)).toBe(false);
			expect(admittedBy(importer)).toEqual([]);
			expect(OUT_OF_CORPUS_TARGETS.map((entry) => entry.id)).toEqual([
				'suite',
				'migration-runner',
				'online-migration-grammar',
				'json-data',
				'tool-client-js',
				'tools-js-leaf',
				'host-agent-package',
				'client-js-leaf',
			]);
			// the agent class admits exactly the eight modules the drills, the pin updater, the pairing CLI and the panel's draft judgement read from
			expect(admittedBy('publication/host_agent/src/exec.ts')).toEqual(['host-agent-package']);
			expect(admittedBy('publication/host_agent/src/provision/render/engine_fragment.ts')).toEqual([
				'host-agent-package',
			]);
			expect(admittedBy('publication/host_agent/src/provision/layout.ts')).toEqual([
				'host-agent-package',
			]);
			expect(admittedBy('publication/host_agent/src/provision/pairing_package.ts')).toEqual([
				'host-agent-package',
			]);
			expect(admittedBy('publication/host_agent/src/provision/exec_contract.ts')).toEqual([
				'host-agent-package',
			]);
			expect(
				admittedBy('publication/host_agent/src/provision/render/nginx_map_include.ts'),
			).toEqual(['host-agent-package']);
			// the panel's draft judgement (drafts.ts): the multi-instance rules and the draft format
			expect(admittedBy('publication/host_agent/src/provision/siblings.ts')).toEqual([
				'host-agent-package',
			]);
			expect(admittedBy('publication/host_agent/src/provision/init/draft.ts')).toEqual([
				'host-agent-package',
			]);
			// a module NEXT to them is not admitted by proximity (the list is exact)
			expect(admittedBy('publication/host_agent/src/provision/init/draft_schema.ts')).toEqual([]);
			for (const entry of [
				'publication/host_agent/src/provision/exec_contract.ts',
				'publication/host_agent/src/provision/render/nginx_map_include.ts',
			]) {
				expect(agentPackageClosure(entry).escapes, entry).toEqual([]);
			}
			// siblings.ts: one in-package edge (layout.ts); draft.ts: a deep closure (pair, parse/*,
			// selinux, the pairing package) — followed, and still inside the agent package
			const siblingsClosure = agentPackageClosure(
				'publication/host_agent/src/provision/siblings.ts',
			);
			expect(siblingsClosure.escapes).toEqual([]);
			expect(siblingsClosure.files).toContain('publication/host_agent/src/provision/layout.ts');
			const draftClosure = agentPackageClosure(
				'publication/host_agent/src/provision/init/draft.ts',
			);
			expect(draftClosure.escapes).toEqual([]);
			expect(draftClosure.files).toContain('publication/host_agent/src/provision/init/pair.ts');
			expect(draftClosure.files).toContain(
				'publication/host_agent/src/provision/pairing_package.ts',
			);
			// zod-free by closure: the engine's in-process judgement loads no agent dependency
			expect(
				draftClosure.files.some((f) => f.endsWith('/schema.ts') || f.endsWith('draft_schema.ts')),
			).toBe(false);
			// pairing_package.ts has NO in-package edge: node:crypto only (its closure is itself)
			const packageClosure = agentPackageClosure(
				'publication/host_agent/src/provision/pairing_package.ts',
			);
			expect(packageClosure.escapes).toEqual([]);
			expect(packageClosure.files).toEqual([
				'publication/host_agent/src/provision/pairing_package.ts',
			]);
			// …and only while their import closure stays inside the agent package (checked, not claimed)
			for (const entry of [
				'publication/host_agent/src/exec.ts',
				'publication/host_agent/src/provision/render/engine_fragment.ts',
			]) {
				const closure = agentPackageClosure(entry);
				expect(closure.escapes, entry).toEqual([]);
				expect(closure.files.length, entry).toBeGreaterThan(2); // anti-vacuity: edges followed
			}
			// layout.ts has ONE in-package edge (instance/roots): its anti-vacuity is that exact edge
			const layoutClosure = agentPackageClosure('publication/host_agent/src/provision/layout.ts');
			expect(layoutClosure.escapes).toEqual([]);
			expect(layoutClosure.files).toContain('publication/host_agent/src/instance/roots.ts');
			// exec.ts reaches config.ts only through require( — the parser scan alone misses it
			expect(agentPackageClosure('publication/host_agent/src/exec.ts').files).toContain(
				'publication/host_agent/src/config.ts',
			);
			// constructed reds: an engine import, an undeclared package, a computed require
			const fragment = 'publication/host_agent/src/provision/render/engine_fragment.ts';
			expect(
				agentImportEdges(fragment, "import { sql } from '../../../../../src/core/db/postgres.ts';")
					.escapes,
			).toEqual([`${fragment} → src/core/db/postgres.ts: outside ${AGENT_SRC}`]);
			expect(agentImportEdges(fragment, "import pg from 'postgres';").escapes).toHaveLength(1);
			expect(agentImportEdges(fragment, "import { z } from 'zod';").escapes).toEqual([]);
			expect(agentImportEdges(fragment, "import { x } from 'node:fs';").escapes).toEqual([]);
			expect(agentImportEdges(fragment, 'const m = require(name);').escapes).toHaveLength(1);
			expect(agentImportEdges(fragment, "const m = require('../layout');").next).toEqual([
				'publication/host_agent/src/provision/layout.ts',
			]);
			expect(admittedBy('publication/host_agent/src/config.ts')).toEqual([]);
			expect(admittedBy('publication/host_agent/src/provision/render/types.ts')).toEqual([]);
			expect(admittedBy('publication/host_agent/src/security/pairing.ts')).toEqual([]);
		});
	});
}
