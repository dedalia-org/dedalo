/**
 * TRIPWIRE — the thesaurus TERM PICKER has one publisher, one mode writer and one
 * toolbar writer (2026-08-14, the relation `view: "tree"` picker landing).
 *
 * The picker is a capability assembled from four subsystems — the area read
 * (`src/core/area/read.ts`), the tree client (`ts_object`), the thesaurus list and the
 * relation family (`component_portal`) — and every defect it was built to close was a
 * DUPLICATION, not a missing feature. Before this landing the same pick was published
 * from two modules, the relation mode was wired inline from two tools, the portal's
 * toolbar had two writers whose order decided the result by accident, and the client
 * stamped a relation `type` the server owns. Each copy worked; the copies DISAGREED,
 * which is the failure a source scan can see and a runtime test cannot.
 *
 * The contract is defined ONCE in `engineering/AREA_SPEC.md` §5.7 (wire ledger:
 * `engineering/wire_contract/WC-2026-08-14-thesaurus-picker-caller-declared.md`) and is
 * enforced here:
 *
 *  1. ONE PUBLISHER — the pick channel literal (`link_terms_`) is named in exactly one
 *     module, `thesaurus_picker.js`, which publishes it. The RETIRED singular channel
 *     (`link_term_`, one term per event) appears in no code at all: it was renamed rather
 *     than re-used with an array payload precisely so that an un-migrated subscriber gets
 *     NOTHING (detectable) instead of silently running locator code over an array.
 *  2. THE MODE GRANT HAS ONE WRITER, and nobody MINTS it. `thesaurus_mode` is a SERVER
 *     answer derived from the caller the request declares (`rqo.source.caller`); the
 *     client may propagate that answer but may never assign a mode literal — a
 *     client-declared `'relation'` would open relation mode on any thesaurus with no
 *     caller that ever declared `view:'tree'`, the objection `read.ts` already makes
 *     about `source.model`. Every site that writes a `.thesaurus_mode` is CENSUSED with
 *     its role, so a new one is a decision and not an accident.
 *  3. `window.opener` stays inside the ONE publisher, within the picker path. Scoped on
 *     purpose: real non-picker uses exist (the time-machine window, the IRI opener
 *     nulling), so an unscoped rule would be red for reasons outside this subsystem and
 *     would get deleted. The out-of-scope uses are a SHRINK-ONLY census, so a new one is
 *     classified rather than absorbed.
 *  4. NO TOOL NAME in the shared picker path. The picker is generic — it is wired by
 *     tool_indexation, by tool_cataloging and by the in-page host alike — and the moment
 *     a core module tests for a tool's NAME the generic capability has forked. Comments
 *     are exempt (stripped before scanning): `area_thesaurus.js` and `ts_object.js`
 *     legitimately EXPLAIN which tool injects the linker, and a gate that fired on the
 *     prose explaining the rule is a gate somebody deletes.
 *  5. A VIEW'S TOOLBAR HAS ONE WRITER. `show_interface` is composed once per build from
 *     the `render_views` entry's DECLARED toolbar; the view module must not write it at
 *     render time — that is AFTER the composition, so which of the two won was
 *     last-writer-wins by accident. Mechanically: no view both declares a toolbar and
 *     writes one.
 *  6. THE RELATION TYPE IS NEVER STAMPED CLIENT-SIDE in the picker path. The old tree
 *     branch stamped `dd151`, but the descriptor default is dd151 for NONE of the models
 *     this capability generalises to (children dd48, parent dd47, index dd96, related
 *     dd89, model dd98, dataframe dd490) — and `type` is part of the server's dedup key,
 *     so a wrong stamp writes a row that will never dedup against the correct ones.
 *
 * NAMED EXEMPTION, with its reason — `client/dedalo/core/area_graph/js/area_graph.js` and
 * `render_area_graph.js` fold the same thesaurus fields as the tree client. They are
 * censused under rule 2 as DEAD CLIENT: the server refuses `area_graph` outright (an area
 * model with no behavior resolver is answered `read: area model '<model>' is not
 * supported`, `src/core/area/read.ts`), so that client cannot execute against this engine.
 * It is exempt because it is dead, not because the rule does not apply to it.
 *
 * COMMENTS ARE STRIPPED BEFORE SCANNING, through the shared string-literal-aware scanner
 * `test/helpers/strip_comments.ts` (precedent: `media_writer_discipline_tripwire`) — the
 * modules that implement these rules describe the retired shapes by name in their headers,
 * and a regex form of the stripper would eat the rest of a line after any `//` inside a
 * string literal, which hides ACCIDENTS and not just adversaries.
 *
 * EVERY RULE CARRIES A POSITIVE CONTROL, asserted against the SAME constant the gate runs
 * on — never a hand-narrowed copy. Without them a renamed module or a moved directory
 * makes every "this violation list is empty" assertion pass having scanned nothing.
 *
 * Honest limit: this proves WHERE the picker's decisions are made, not that they are
 * correct. What the server derives is `test/unit/area_picker_mode_native.test.ts`; what
 * the write path refuses is `test/unit/relation_insert_target_native.test.ts`; what the
 * browser renders is `bun run test:client`.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { stripComments } from '../helpers/strip_comments.ts';

const REPO_ROOT = join(import.meta.dir, '../..');

/** Read a repo-relative file with its comments removed (the scanners' input). */
function code(rel: string): string {
	return stripComments(readFileSync(join(REPO_ROOT, rel), 'utf8'));
}

/** Every scannable source file under the given repo-relative roots. */
function sourceFiles(roots: readonly string[]): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			if (entry === 'node_modules' || entry.startsWith('.')) continue;
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) walk(full);
			else if (entry.endsWith('.js') || entry.endsWith('.ts')) found.push(full);
		}
	};
	for (const root of roots) walk(join(REPO_ROOT, root));
	return found.map((f) => relative(REPO_ROOT, f).split(sep).join('/'));
}

/** The whole hand-written client + tools + engine surface. */
const SCAN_ROOTS = ['client', 'tools', 'src'] as const;

/** The ONE module that owns the picker: the publisher, the mode grant, the affordance. */
const PICKER_OWNER = 'client/dedalo/core/area_thesaurus/js/thesaurus_picker.js';

/**
 * THE PICKER PATH — every module of the three families that make a term pickable, plus
 * the thesaurus list view that picks a SEARCH RESULT.
 *
 * DISCOVERED per directory, not hand-listed: the defect this whole landing removed was a
 * second copy, and a hand-listed scope is exactly where the next copy hides (a new sibling
 * module in the picker's own directory would be outside a fixed list and outside every
 * rule below). Scoped to these directories and no wider, because rule 3 and rule 6 are
 * about a SURFACE and not about the tree: `component_iri` legitimately nulls an opener and
 * the browser suite legitimately builds typed locator fixtures, so a `client/**` scan would
 * be red for reasons outside this subsystem and would get disabled.
 */
const PICKER_DIRS = [
	'client/dedalo/core/area_thesaurus/js',
	'client/dedalo/core/ts_object/js',
	'client/dedalo/core/component_portal/js',
] as const;

/** Picker surfaces that live outside those directories. */
const PICKER_EXTRA = ['client/dedalo/core/section/js/view_thesaurus_list_section.js'] as const;

/**
 * Files the discovery MUST find. A relocation that empties a directory would otherwise
 * leave every scoped rule passing over a shorter and shorter list.
 */
const PICKER_ANCHORS = [
	PICKER_OWNER,
	'client/dedalo/core/area_thesaurus/js/area_thesaurus.js',
	'client/dedalo/core/ts_object/js/render_ts_id_column.js',
	'client/dedalo/core/section/js/view_thesaurus_list_section.js',
	'client/dedalo/core/component_portal/js/component_portal.js',
	'client/dedalo/core/component_portal/js/view_tree_edit_portal.js',
] as const;

function pickerPath(): string[] {
	return [...sourceFiles(PICKER_DIRS), ...PICKER_EXTRA];
}

// ---------------------------------------------------------------------------
// Rule 1 — one publisher
// ---------------------------------------------------------------------------

/** The pick channel prefix, as a QUOTED literal (the only way a second module could mint it). */
const CHANNEL_LITERAL = /['"`]link_terms_/;
/** The retired singular channel — one term per event. Must exist in no code. */
const RETIRED_CHANNEL = /link_term_/;

// ---------------------------------------------------------------------------
// Rule 2 — the mode grant
// ---------------------------------------------------------------------------

/** Any assignment whose target property is `thesaurus_mode` (`=`, never `==`/`===`). */
const MODE_WRITE = /\.thesaurus_mode\s*=(?!=)/;
/** The GRANT itself: a write onto a context object, which is what the client reads back. */
const MODE_GRANT_WRITE = /\bcontext(?:\?)?\.thesaurus_mode\s*=(?!=)/;
/** A MINTED mode: a literal assigned to the field, rather than a server answer propagated. */
const MODE_LITERAL_MINT = /thesaurus_mode\s*=(?!=)\s*['"`]/;

/**
 * Every site that writes a `.thesaurus_mode`, with the role that makes it legitimate.
 *
 * TOTAL by construction: an unlisted writer fails, and a listed file that no longer
 * writes fails too — a stale entry silently widens the census for the next one.
 */
const MODE_WRITE_CENSUS: Record<
	string,
	{ role: 'derivation' | 'owner' | 'propagation' | 'echo' | 'dead'; reason: string }
> = {
	'src/core/area/read.ts': {
		role: 'derivation',
		reason:
			"THE derivation, and the only authority. A caller-declared read is stamped with the mode the server derived from that caller (resolved view plus the edit grant); a caller-less browse read is stamped with the area node's own property, which is the install default and can never grant a picker request a mode the caller did not earn.",
	},
	[PICKER_OWNER]: {
		role: 'owner',
		reason:
			'THE grant. Writes context.thesaurus_mode once, from the server answer when the read declared a caller, or from the documented tool exemption when it did not (tool_indexation and tool_cataloging open the thesaurus as their own indexing surface and have no caller ddo to derive from).',
	},
	'client/dedalo/core/ts_object/js/ts_object.js': {
		role: 'propagation',
		reason:
			'Carries the granted mode onto the tree node instance and onto the data item it hands its children. It decides nothing: the value arrives in the render options and leaves unchanged.',
	},
	'client/dedalo/core/area_thesaurus/js/area_thesaurus.js': {
		role: 'echo',
		reason:
			"Echoes the server's own answer back onto the rqo of the follow-up refresh and search reads. It is not a declaration: the engine derives the mode from source.caller and reads this field from no request.",
	},
	'client/dedalo/core/area_graph/js/area_graph.js': {
		role: 'dead',
		reason:
			"DEAD CLIENT — area_graph folds the same thesaurus fields, but the server refuses the model outright (an area model with no behavior resolver is answered 'read: area model ... is not supported' in src/core/area/read.ts), so this file cannot execute against this engine.",
	},
	'client/dedalo/core/area_graph/js/render_area_graph.js': {
		role: 'dead',
		reason:
			'DEAD CLIENT — the area_graph renderer stamps the mode onto its page-global tree object. Same refusal as above: the read never reaches it.',
	},
};

// ---------------------------------------------------------------------------
// Rule 3 — window.opener
// ---------------------------------------------------------------------------

const WINDOW_OPENER = /window\s*\.\s*opener/;

/**
 * Non-picker `window.opener` uses, SHRINK-ONLY.
 *
 * Rule 3 is scoped to the picker path, so this census is what keeps that scoping honest:
 * it records what the unscoped scan finds, so a NEW opener site anywhere in the tree is
 * classified deliberately instead of being absorbed by a rule that never looked.
 */
const NON_PICKER_WINDOW_OPENER = new Set([
	'client/dedalo/core/component_iri/js/render_edit_component_iri.js',
	'tools/tool_time_machine/js/render_tool_time_machine.js',
	// fit_viewer_window: `window.opener` only proves this window is the popup Dédalo
	// opened ('viewer'), so it may resize itself to the media ratio — no pick, no
	// cross-window write (052e8242fd).
	'client/dedalo/core/component_av/js/view_viewer_edit_av.js',
]);

// ---------------------------------------------------------------------------
// Rule 4 — no tool name in the shared path
// ---------------------------------------------------------------------------

const TOOL_NAME = /tool_(?:indexation|cataloging)/;

/**
 * Tool-named literals in the picker path that are NOT a picker fork, each with its
 * reason. Keyed by file; the literal is removed from the code before rule 4 tests
 * it, and a listed literal that is no longer in its file is red (no stale rows).
 */
const TOOL_NAME_EXEMPT: ReadonlyMap<string, { literal: string; reason: string }> = new Map([
	[
		'client/dedalo/core/component_portal/js/drag_and_drop.js',
		{
			literal: "['tool_cataloging_mosaic',",
			reason:
				'a VIEW name, the key of the shrink-only TOOL_ROW_SOURCES drag-source whitelist (can_tool_source asks what view the instance renders, not who opened it) — no picker behaviour reads it',
		},
	],
]);

/** The code rule 4 judges: comments stripped, the file's exempt literal removed. */
function ruleFourCode(rel: string): string {
	const exempt = TOOL_NAME_EXEMPT.get(rel);
	const source = code(rel);
	return exempt ? source.split(exempt.literal).join('') : source;
}

// ---------------------------------------------------------------------------
// Rule 5 — one toolbar writer per view
// ---------------------------------------------------------------------------

const PORTAL_DIR = 'client/dedalo/core/component_portal/js';
const SHOW_INTERFACE_WRITE = /show_interface\s*(?:\.[\w$]+)?\s*=(?!=)/;

type RenderView = {
	view: string | null;
	mode: string | null;
	render: string | null;
	declares: boolean;
};

/**
 * The `render_views` registry, read as DATA from the module that owns it.
 *
 * Brace-walked rather than regex'd: the entries nest (a declared `show_interface` block is
 * itself an object), and a non-greedy `{…}` match would cut every entry at its first inner
 * brace and silently classify the declaring entries as declaring nothing.
 */
function renderViews(): RenderView[] {
	const source = code(`${PORTAL_DIR}/component_portal.js`);
	const anchor = source.indexOf('self.render_views = [');
	if (anchor === -1) throw new Error('component_portal.js: `self.render_views = [` not found');
	const open = source.indexOf('[', anchor);
	let depth = 0;
	let close = -1;
	for (let i = open; i < source.length; i++) {
		const char = source[i];
		if (char === '[' || char === '{') depth++;
		else if (char === ']' || char === '}') {
			depth--;
			if (depth === 0) {
				close = i;
				break;
			}
		}
	}
	if (close === -1) throw new Error('component_portal.js: unterminated render_views array');

	const block = source.slice(open + 1, close);
	const entries: string[] = [];
	let level = 0;
	let current = '';
	for (const char of block) {
		if (char === '{') {
			level++;
			if (level === 1) {
				current = '';
				continue;
			}
		}
		if (char === '}') {
			level--;
			if (level === 0) {
				entries.push(current);
				continue;
			}
		}
		if (level >= 1) current += char;
	}
	return entries.map((entry) => ({
		view: entry.match(/view\s*:\s*'([^']+)'/)?.[1] ?? null,
		mode: entry.match(/mode\s*:\s*'([^']+)'/)?.[1] ?? null,
		render: entry.match(/render\s*:\s*'([^']+)'/)?.[1] ?? null,
		declares: /show_interface\s*:/.test(entry),
	}));
}

// ---------------------------------------------------------------------------
// Rule 6 — no client-side relation type stamp
// ---------------------------------------------------------------------------

/** The DD_TIPOS relation-type constants — the shape the retired tree stamp used. */
const RELATION_TYPE_CONSTANT = /DEDALO_RELATION_TYPE_/;
/** The same thing hard-coded: a relation-type tipo assigned to a locator `type`. */
const RELATION_TYPE_LITERAL = /\btype\s*[:=]\s*['"](?:dd151|dd48|dd47|dd96|dd89|dd98|dd490)['"]/;
/** Any assignment onto a locator's `type` (the census below is its complete list). */
const TYPE_ASSIGN = /\.type\s*=(?!=)/;

describe('thesaurus picker tripwire', () => {
	// -----------------------------------------------------------------
	// Scan integrity — every "the offender list is empty" assertion below
	// is worthless if the scan found nothing to look at.
	// -----------------------------------------------------------------

	test('the scan roots and the picker path are real (no assertion may pass over nothing)', () => {
		const files = sourceFiles(SCAN_ROOTS);
		expect(
			files.length,
			'The tree-wide scan found no source files — the roots moved and every rule below would pass vacuously',
		).toBeGreaterThan(500);

		const discovered = pickerPath();
		expect(
			discovered.length,
			'The picker-path discovery found (almost) nothing — the picker directories moved and rules 3, 4 and 6 would pass over an empty list',
		).toBeGreaterThanOrEqual(20);

		const missingAnchor = PICKER_ANCHORS.filter((rel) => !discovered.includes(rel));
		expect(
			missingAnchor,
			'A picker module the scope is anchored on was not discovered — it moved out of the scanned directories, taking itself out of rules 3, 4 and 6. Repoint PICKER_DIRS/PICKER_EXTRA in the change that moves it:',
		).toEqual([]);

		const missingFile = discovered.filter((rel) => !existsSync(join(REPO_ROOT, rel)));
		expect(missingFile, 'A discovered picker-path file does not exist on disk:').toEqual([]);

		const unscanned = discovered.filter((rel) => !files.includes(rel));
		expect(
			unscanned,
			'A picker-path file is outside the tree-wide scan roots — rules 1 and 2 would never see it:',
		).toEqual([]);
	});

	// -----------------------------------------------------------------
	// Rule 1 — one publisher
	// -----------------------------------------------------------------

	test('rule 1: the pick channel is named by exactly ONE module, and that module publishes it', () => {
		const owners = sourceFiles(SCAN_ROOTS).filter((rel) => CHANNEL_LITERAL.test(code(rel)));
		expect(
			owners,
			'The pick channel literal must appear in exactly one module. A second module minting it is a second publisher: the two payload shapes drift, and a subscriber cannot tell which one it is being handed:',
		).toEqual([PICKER_OWNER]);

		const owner = code(PICKER_OWNER);
		expect(
			/export const PICKER_LINK_CHANNEL_PREFIX\s*=/.test(owner),
			`${PICKER_OWNER} must EXPORT the channel prefix — a consumer that cannot import it will re-type the literal, which is exactly what rule 1 forbids`,
		).toBe(true);
		expect(
			/event_manager\.publish\(\s*PICKER_LINK_CHANNEL_PREFIX/.test(owner),
			`${PICKER_OWNER} must publish ON that prefix. Without this the rule above is satisfied by a module that merely declares the constant while the real publish happens elsewhere`,
		).toBe(true);
	});

	test('rule 1: the RETIRED singular channel exists in no code', () => {
		const offenders = sourceFiles(SCAN_ROOTS).filter((rel) => RETIRED_CHANNEL.test(code(rel)));
		expect(
			offenders,
			'`link_term_<id>` (one term per event, an object payload) is retired. It was RENAMED rather than re-used with an array payload so that an un-migrated subscriber receives nothing — a detectable failure — instead of silently running `locator.type = …` over an array. Naming it again re-opens exactly that:',
		).toEqual([]);

		// Positive controls, against the constants the gate runs on.
		expect(RETIRED_CHANNEL.test("event_manager.publish('link_term_' + self.id, term)")).toBe(true);
		expect(
			RETIRED_CHANNEL.test("event_manager.publish('link_terms_' + self.id, terms)"),
			'the retired-channel pattern must NOT fire on the current plural channel, or rule 1 above could never be satisfied',
		).toBe(false);
		expect(CHANNEL_LITERAL.test("const PREFIX = 'link_terms_'")).toBe(true);
	});

	// -----------------------------------------------------------------
	// Rule 2 — the mode grant
	// -----------------------------------------------------------------

	test('rule 2: every site writing a thesaurus_mode is censused, and every census entry still writes one', () => {
		const writers = sourceFiles(SCAN_ROOTS).filter((rel) => MODE_WRITE.test(code(rel)));

		const uncensused = writers.filter((rel) => MODE_WRITE_CENSUS[rel] === undefined);
		expect(
			uncensused,
			"A module writes a thesaurus_mode and is not censused. The mode is the picker's authority: it decides whether a tree offers link affordances at all. Add an entry naming the ROLE (owner / propagation / echo / dead) and why it is not a second grant — or route the write through thesaurus_picker.js:",
		).toEqual([]);

		const stale = Object.keys(MODE_WRITE_CENSUS).filter((rel) => !writers.includes(rel));
		expect(
			stale,
			'A censused mode writer no longer writes one. A stale entry is not harmless: it pre-authorizes the next write to land in that file unseen. Remove it in the change that removed the write:',
		).toEqual([]);

		for (const [rel, entry] of Object.entries(MODE_WRITE_CENSUS)) {
			expect(
				entry.reason.trim().split(/\s+/).length,
				`${rel}: the census reason must say why this write is not a second grant, in words a reader can check`,
			).toBeGreaterThanOrEqual(12);
		}
	});

	test('rule 2: the GRANT (a write onto a context) has exactly one writer', () => {
		const granters = sourceFiles(SCAN_ROOTS).filter((rel) => MODE_GRANT_WRITE.test(code(rel)));
		expect(
			granters,
			'`context.thesaurus_mode` is what every consumer reads back — the tree, the id column, the list row. Two writers means the last one to run decides whether the picker exists, which is how the toolbar defect (rule 5) already happened once:',
		).toEqual([PICKER_OWNER]);

		const owners = Object.entries(MODE_WRITE_CENSUS).filter(([, entry]) => entry.role === 'owner');
		expect(owners.map(([rel]) => rel)).toEqual([PICKER_OWNER]);
	});

	test('rule 2: nobody MINTS a mode literal client-side — the mode is always a server answer', () => {
		const offenders = sourceFiles(SCAN_ROOTS)
			.filter((rel) => rel.startsWith('client/') || rel.startsWith('tools/'))
			.filter((rel) => MODE_LITERAL_MINT.test(code(rel)));
		expect(
			offenders,
			"A client-declared thesaurus_mode is a client conclusion used as authority: it opens relation mode on any thesaurus with no caller that ever declared view:'tree'. The server derives the mode from the caller the request declares (rqo.source.caller) — propagate its answer, never assign one:",
		).toEqual([]);

		// Positive controls, against the constants the gate runs on.
		expect(MODE_LITERAL_MINT.test("self.context.thesaurus_mode = 'relation'")).toBe(true);
		expect(MODE_LITERAL_MINT.test('area.context.thesaurus_mode = "relation"')).toBe(true);
		expect(
			MODE_LITERAL_MINT.test("if (self.thesaurus_mode==='relation') {"),
			'the mint pattern must not fire on a COMPARISON — reading the granted mode is the whole point of granting it',
		).toBe(false);
		expect(MODE_WRITE.test('data_item.thesaurus_mode = self.thesaurus_mode')).toBe(true);
		expect(MODE_GRANT_WRITE.test('area_instance.context.thesaurus_mode = mode')).toBe(true);
		expect(
			MODE_GRANT_WRITE.test('self.rqo.source.thesaurus_mode = self.context.thesaurus_mode'),
			'the grant pattern must not fire on an rqo echo — that is a request field, not the context every consumer reads',
		).toBe(false);
	});

	// -----------------------------------------------------------------
	// Rule 3 — window.opener
	// -----------------------------------------------------------------

	test('rule 3: window.opener stays inside the ONE publisher (picker path)', () => {
		const offenders = pickerPath().filter((rel) => WINDOW_OPENER.test(code(rel)));
		expect(
			offenders,
			"Resolving the window a pick must be published INTO belongs to the one publisher (it reads the LINKER component's own `.caller`, not the area's). A second module doing it is a second publisher wearing another name — and the popup surface is a declared fallback, not a place to grow logic:",
		).toEqual([PICKER_OWNER]);

		expect(WINDOW_OPENER.test('const base = !linker.caller ? window.opener : window')).toBe(true);
	});

	test('rule 3: the non-picker window.opener census is shrink-only (the scoping stays honest)', () => {
		const found = new Set(
			sourceFiles(SCAN_ROOTS)
				.filter((rel) => !pickerPath().includes(rel))
				.filter((rel) => WINDOW_OPENER.test(code(rel))),
		);
		const unclassified = [...found].filter((rel) => !NON_PICKER_WINDOW_OPENER.has(rel)).sort();
		expect(
			unclassified,
			'A new window.opener site outside the picker path. Rule 3 is deliberately scoped, so this census is what stops the scoping from quietly becoming a blind spot: classify it here with its reason, or route it through the one publisher if it is a pick:',
		).toEqual([]);
	});

	// -----------------------------------------------------------------
	// Rule 4 — no tool name in the shared path
	// -----------------------------------------------------------------

	test('rule 4: no tool NAME in the shared picker path (comments exempt)', () => {
		const offenders = pickerPath().filter((rel) => TOOL_NAME.test(ruleFourCode(rel)));
		const staleExempt = [...TOOL_NAME_EXEMPT].filter(
			([rel, { literal }]) => !pickerPath().includes(rel) || !code(rel).includes(literal),
		);
		expect(
			staleExempt.map(([rel]) => rel),
			'TOOL_NAME_EXEMPT rows whose literal is gone',
		).toEqual([]);
		expect(
			offenders,
			"A core picker module testing for a tool by NAME is the fork this landing removed: the thesaurus list gated its link button on `initiator.indexOf('tool_indexation_')`, so a picker opened by a portal — whose initiator is the caller component id — could not pick a search result at all. Ask what the instance IS (a picker attached, a linker present), never who it belongs to:",
		).toEqual([]);

		// The comments exemption is REAL and is what makes the rule pass: at least one
		// picker module explains the tool injection in prose. Asserted so that a future
		// stripper regression (prose counted as code) is a red gate here and not a
		// mystery elsewhere.
		const explainsInProse = pickerPath().filter(
			(rel) =>
				TOOL_NAME.test(readFileSync(join(REPO_ROOT, rel), 'utf8')) && !TOOL_NAME.test(code(rel)),
		);
		expect(
			explainsInProse.length,
			'No picker module names a tool even in prose — either the comment stripper is no longer stripping (rule 4 is then vacuous) or the documentation of which tool injects the linker was lost',
		).toBeGreaterThan(0);
	});

	// -----------------------------------------------------------------
	// Rule 5 — one toolbar writer per view
	// -----------------------------------------------------------------

	test('rule 5: no view both DECLARES a toolbar and WRITES one', () => {
		const views = renderViews();
		expect(
			views.length,
			'render_views parsed to (almost) nothing — the registry moved and this rule now checks nothing',
		).toBeGreaterThanOrEqual(8);

		const missingModule = views
			.filter((entry) => entry.render !== null)
			.filter((entry) => !existsSync(join(REPO_ROOT, PORTAL_DIR, `${entry.render}.js`)))
			.map((entry) => `${entry.view}/${entry.mode} -> ${entry.render}`);
		expect(
			missingModule,
			'A render_views entry names a module that does not exist in the portal directory. The write side of this rule cannot be checked for it, so it would pass by absence:',
		).toEqual([]);

		const twoWriters = views
			.filter((entry) => entry.declares && entry.render !== null)
			.filter((entry) => SHOW_INTERFACE_WRITE.test(code(`${PORTAL_DIR}/${entry.render}.js`)))
			.map((entry) => `${entry.view}/${entry.mode} (${entry.render}.js)`);
		expect(
			twoWriters,
			'This view declares its toolbar as data AND writes show_interface at render time. The write runs after build() composed the declaration, so the result is whichever ran last — the accident the tree view was fixed for. Keep the declaration and delete the write:',
		).toEqual([]);

		// Non-vacuity: the declare detector must actually fire on this tree.
		expect(
			views.some((entry) => entry.declares),
			'No render_views entry declares a toolbar — the declaration channel this rule guards has disappeared',
		).toBe(true);
		// …and the write detector, against the constant the gate runs on.
		expect(SHOW_INTERFACE_WRITE.test('self.show_interface.button_tree = true')).toBe(true);
		expect(SHOW_INTERFACE_WRITE.test('self.show_interface = show_interface')).toBe(true);
		expect(
			SHOW_INTERFACE_WRITE.test('if (self.show_interface.button_tree === true) {'),
			'the write detector must not fire on a READ — every view reads its toolbar',
		).toBe(false);
	});

	test('rule 5: the tree view declares the picker toolbar, and declares no input path', () => {
		const tree = renderViews().find((entry) => entry.view === 'tree' && entry.mode === 'edit');
		expect(
			tree,
			"No {view:'tree', mode:'edit'} entry in render_views — the tree picker has no render route",
		).toBeDefined();
		expect(
			tree?.declares,
			'The tree view must DECLARE its toolbar on the registry entry (button_tree on, the add/link/list/fullscreen buttons off). Writing it inside the view module is the two-writer defect',
		).toBe(true);

		const portal = code(`${PORTAL_DIR}/component_portal.js`);
		expect(
			/VIEW_TOOLBAR_FORBIDDEN_KEYS\s*=\s*Object\.freeze\(\[/.test(portal),
			'compose_show_interface must keep the mechanical refusal of the keys a view may not declare. A picker view ADDS an input path and removes none — with the list gone, a view could switch off the autocomplete input the ontology declared, and the rule would live only in a comment',
		).toBe(true);
		for (const key of ['show_autocomplete', 'read_only', 'permissions']) {
			expect(
				portal.includes(`'${key}'`),
				`VIEW_TOOLBAR_FORBIDDEN_KEYS must still refuse '${key}'`,
			).toBe(true);
		}
	});

	// -----------------------------------------------------------------
	// Rule 6 — no client-side relation type stamp
	// -----------------------------------------------------------------

	test('rule 6: the picker path stamps no relation type', () => {
		const constants = pickerPath().filter((rel) => RELATION_TYPE_CONSTANT.test(code(rel)));
		expect(
			constants,
			'The tree branch used to stamp DEDALO_RELATION_TYPE_LINK (dd151). The server fills `type` only when it is ABSENT, and the descriptor default is dd151 for none of the models this capability generalises to — children dd48, parent dd47, index dd96, related dd89, model dd98, dataframe dd490. A client stamp therefore writes wrong-typed rows that never dedup against the correctly typed ones (the dedup key is [section_id, section_tipo, type, tag_id]):',
		).toEqual([]);

		const literals = pickerPath().filter((rel) => RELATION_TYPE_LITERAL.test(code(rel)));
		expect(
			literals,
			'A relation-type tipo hard-coded onto a locator `type` in the picker path. Same defect as above with the constant spelled out:',
		).toEqual([]);

		// Positive controls, against the constants the gate runs on.
		expect(RELATION_TYPE_CONSTANT.test("type: DD_TIPOS.DEDALO_RELATION_TYPE_LINK ?? 'dd151'")).toBe(
			true,
		);
		expect(RELATION_TYPE_LITERAL.test("locator.type = 'dd151'")).toBe(true);
		expect(RELATION_TYPE_LITERAL.test('{ type : "dd490" }')).toBe(true);
	});

	test('rule 6: the ONE type assignment left in the picker path is the dataframe marker', () => {
		const assigners = pickerPath().filter((rel) => TYPE_ASSIGN.test(code(rel)));
		expect(
			assigners,
			'Only the dataframe branch may stamp a locator type client-side, and only through the shared DATAFRAME_TYPE constant: the frame marker is a CONSTANT the server forces anyway (normalizeDataframeEntry overwrites it), so the client value is a shape, not an authority. Any other assignment is the retired stamp coming back:',
		).toEqual(['client/dedalo/core/component_portal/js/component_portal.js']);

		const portal = code(`${PORTAL_DIR}/component_portal.js`);
		expect(
			/\.type\s*=\s*DATAFRAME_TYPE/.test(portal),
			'The one permitted stamp must be the imported DATAFRAME_TYPE constant, not a re-typed tipo',
		).toBe(true);
		expect(
			/import\s*\{[^}]*\bDATAFRAME_TYPE\b[^}]*\}\s*from/.test(portal),
			'DATAFRAME_TYPE must be IMPORTED from the dataframe module — a locally declared copy is a second definition of the marker',
		).toBe(true);
		expect(TYPE_ASSIGN.test('value.type = DATAFRAME_TYPE')).toBe(true);
		expect(
			TYPE_ASSIGN.test("if (locator.type === 'dd490') {"),
			'the assignment detector must not fire on a comparison',
		).toBe(false);
	});
});
