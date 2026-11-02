/**
 * DOCS LOCATOR/STORAGE/ENVELOPE SHAPE tripwire (DEC-12: every documented invariant has one).
 *
 * `docs/` is the PRODUCT MANUAL. A wrong SHAPE in it is worse than a wrong sentence: a
 * reader copies the example into an ontology, a client, or an integration, and the engine
 * rejects it (or worse, silently stores the v6 form). Four shapes were restored by hand in
 * the 2026-08 correctness pass; prose rots back the moment nobody is watching, so each one
 * gets a mechanical gate here. Sibling: `docs_current_engine_tripwire.test.ts` (same
 * walker, same code-block handling, same allowlist-with-reasons discipline).
 *
 * ── THE FOUR RULES ───────────────────────────────────────────────────────────
 *
 * 1. STRING RECORD ADDRESSES. WC-2026-08-10-section-id-int-canonical: a matrix record
 *    address is a SAFE INTEGER (negatives included — `-1` is the root record). Flags an
 *    address key bound to a QUOTED INTEGER (`"section_id": "7"`, `'section_id':'2'`).
 *
 * 2. THE DEAD `datos` COLUMN. No matrix table has one; the row is `id`, `section_id`,
 *    `section_tipo` + the 11 typed JSONB columns (`MATRIX_JSONB_COLUMNS`,
 *    `src/core/db/matrix.ts`). Flags `datos` ASSERTED as a column/key — never the prose
 *    that says it is gone (most correct pages must say the word to deny it).
 *
 * 3. THE FLAT-ARRAY RECORD SHAPE `{"relations": [ <locator>, … ]}`. The matrix column is
 *    `relation`, SINGULAR, an object keyed by the owning component tipo. CARVE-OUT:
 *    `relations` IS the correct key on a **dd_ontology NODE** definition, whose entries
 *    are `{"tipo": …}` references — so the rule fires only on an array whose entries carry
 *    LOCATOR keys (`section_id` / `section_tipo` / `from_component_tipo`). Node arrays and
 *    elided `[ … ]` illustrations are correct documentation and must stay green.
 *
 * 4. ENVELOPE v1 `{result, msg, errors}`. Removed 2026-08-16 (`engineering/ERRORS_SPEC.md`,
 *    `docs/core/system/errors.md`); v2 is `{ok, request_id, data, notices[], error}` plus
 *    extension keys, and `result` is a FORBIDDEN top-level key.
 *
 * ── TWO KINDS OF ENTRY, BOTH LIVE, BOTH SHRINK-ONLY ──────────────────────────
 * `{reason}`        — a VERIFIED EXCEPTION: the page documents a different wire, or the
 *                     literal is the point of the sentence. The file is exempt.
 * `{max, reason}`   — FROZEN DEBT: a count that may only FALL (the `generic_tld_tripwire`
 *                     ratchet). Rule 4 is mostly this: the v1 envelope still stands in ~9
 *                     pages the correctness pass did not reach, and a flat gate cannot
 *                     pass. Freezing the count binds the invariant TODAY and makes every
 *                     future page red.
 *
 * Both kinds are LIVE and SET-EQUAL: an entry that no longer matches anything is a
 * FAILURE (a stale exemption silently widens the gate), a count BELOW its `max` is a
 * failure (re-freeze it downward), and the key set is asserted exactly, so nobody can
 * quietly append instead of doing the work.
 *
 * ── HONEST LIMITATIONS (stated, not hidden) ──────────────────────────────────
 *  - Rule 1 bans FIVE address keys — `section_id`, `section_id_key`, `parent_section_id`,
 *    `typology_section_id`, `row_section_id`. `section_top_id` is DELIBERATELY NOT in the
 *    set: the engine itself does not canonicalize it (`src/core/section/indexation_grid.ts`
 *    types it `number | string` and stringifies it on emit at :1440), so banning it would
 *    fire on CORRECT documentation. `from_section_id` is out for the same reason — the
 *    intify transform's own `ADDRESS_KEYS` (`src/core/update/transform/section_id_intify.ts:57`)
 *    does not carry it.
 *  - Rule 1 matches the `key: "123"` form only, never `key = '123'`: `docs/core/sqo.md`
 *    correctly writes `locator_data->>'section_id' = '7'`, where `->>` RETURNS TEXT and the
 *    string comparison is right. A gate that reddened that would be teaching the wrong law.
 *  - Rule 2 is deliberately narrow: `"datos"` as a JSON key, `jsonb datos` / `datos jsonb`
 *    as a column declaration, and `datos->` / `datos::` as a SQL column reference. It does
 *    NOT ban the word, because every page that correctly DENIES the column has to name it.
 *  - Rule 3 proves the entries are locators. A flat array of BARE ids under `relations`
 *    would sail through — no page writes one, and inventing a looser rule would redden the
 *    three correct dd_ontology node examples.
 *  - Rule 4 counts a `"result":` JSON key anywhere in the page, not only at depth 0: the
 *    manual's examples are fragments, so "top-level" is not decidable from the text. That
 *    over-counts a legitimately nested `result` — none exists today, and the frozen counts
 *    make any new one visible.
 *  - Like every docs gate here, it proves the TEXT, not the rendered site.
 *
 * HERMETIC: filesystem reads of tracked docs only. No DB, no network, no clock.
 *
 * Registered in engineering/TRIPWIRES.md + scripts/verify.ts.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Glob } from 'bun';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const DOCS_DIR = join(REPO_ROOT, 'docs');

/** Every text file the docs BUILD ships (mirrors docs_current_engine_tripwire). */
const DOCS_TEXT_GLOB = '**/*.{md,css,js,yaml,yml,svg}';

/** An exempt page, or a frozen debt count that may only fall. */
type Entry = { reason: string; max?: number };

// ---------------------------------------------------------------------------
// RULE 1 — a matrix record address is an int (WC-2026-08-10-section-id-int-canonical)
// ---------------------------------------------------------------------------

/**
 * The address keys the engine CANONICALIZES. Kept to what is provable: the intify
 * transform's own ADDRESS_KEYS (section_id_intify.ts:57) plus the two the read path
 * mints from ints (`typology_section_id` — canonicalizeStoredSectionId, area/tree.ts:223;
 * `row_section_id` — read.ts:1377 / read_tm.ts:626). See the header for what is out.
 */
const ADDRESS_KEYS = [
	'section_id',
	'section_id_key',
	'parent_section_id',
	'typology_section_id',
	'row_section_id',
] as const;

/**
 * `"section_id": "7"` / `'section_id':'2'` / `section_id: "42"` / `section_id : '42'`.
 * VALUE-SHAPED: only a quoted INTEGER is an address written as a string. This is what
 * keeps the dd_ontology config tokens (`"self"`, `"current"`), the synthetic wire tokens
 * (`search_1`, `tmp_export_2`) and placeholders (`'...'`, `"lg-eng"`) out — none of them
 * addresses a record, and none of them is a numeral.
 */
const STRING_ADDRESS = new RegExp(
	`["']?\\b(?:${ADDRESS_KEYS.join('|')})\\b["']?\\s*:\\s*(?:"-?\\d+"|'-?\\d+')`,
);

/**
 * Verified one by one against the current file. Every one of these is a page documenting a
 * DIFFERENT wire, or a sentence whose POINT is the string form.
 */
const STRING_ADDRESS_ALLOWLIST: Record<string, Entry> = {
	// A different wire, not the app wire: the published MariaDB shape genuinely mints
	// String(sectionId) — src/diffusion/resolve/rewriters.ts:389-390,410-411 — and the v1
	// publication API is an isolated, read-only, retro-compatible subsystem.
	'docs/diffusion/publication_api/publication_api.md': {
		reason: 'legacy v1 publication API — the published MariaDB shape mints String(sectionId)',
	},
	// The MARKER BYTE-FORM is pinned as a string ON PURPOSE, so the canonical int can never
	// reach the marker bytes by accident: PersonMarkerLocator.section_id is `string`
	// (src/core/components/component_text_area/tags_persons.ts:68-75).
	'docs/core/importing_data.md': {
		reason:
			'in-text mark literals — the person/reference marker byte-form pins a string section_id',
	},
	'docs/core/components/component_text_area.md': {
		reason: 'in-text mark literal — PersonMarkerLocator.section_id is a string by contract',
	},
	// The text-tag law's worked example quotes the legend text AS STORED: an svg tag's
	// in-text payload is the tag byte-form (component_text_area/tag_grammar.ts), not a
	// wire locator — the law parses it and the mirror stores the int form. ONE line.
	'docs/core/system/observers.md': {
		reason: 'in-text svg tag literal of the text-tag law example — the stored tag byte-form',
		max: 1,
	},
	// The canonical locator page is NOT exempt: it carries exactly ONE legitimate string
	// address, the dd_relations published sample, because diffusion stringifies on the way
	// out (resolver.ts relation_list build; rewriters.ts index edge). Frozen at 1 so the page
	// that TEACHES the int law cannot quietly grow a second one.
	'docs/core/locator.md': {
		reason: 'one dd_relations sample — diffusion mints String(sectionId) at the publish boundary',
		max: 1,
	},
	// External REMOTE ids: strings verbatim, protected by the WC's VALUE INVARIANT (a true
	// remote id is never convertible — "001338683" is zero-padded).
	'docs/core/components/component_external.md': {
		reason:
			'external remote id "001338683" — non-convertible, kept verbatim by the value invariant',
	},
	'docs/core/system/external_services.md': {
		reason:
			'external remote id "001338683" — non-convertible, kept verbatim by the value invariant',
	},
	// The sentence CONTRASTS the old form with the new one; deleting the old form deletes
	// the paragraph's meaning.
	'docs/install/upgrading.md': {
		reason: 'deliberately shows the OLD string form to contrast with the int form it introduces',
	},
	// Diffusion template handles, not app-wire locators: parser_misc.ts:309,381 injects
	// section_id as a String() template field.
	'docs/diffusion/parsers.md': {
		reason: 'diffusion template handle — parser_misc injects section_id as a String() field',
	},
	// Frontmatter is quoted YAML scalars by contract: writers/markdown.ts:91 emits
	// String(sectionId).
	'docs/diffusion/diffusion_markdown.md': {
		reason: 'markdown frontmatter — writers/markdown.ts emits String(sectionId) as a YAML scalar',
	},
	// NAMED EXEMPTION: the error report is a diagnostic capture of whatever the browser had,
	// so its schema takes a string — src/core/error_report/schema.ts:85 is z.string().max(64).
	'docs/development/tools/reference/tool_error_report.md': {
		reason: 'named exemption — error_report/schema.ts types section_id as z.string().max(64)',
	},
};

// ---------------------------------------------------------------------------
// RULE 2 — there is no `datos` column
// ---------------------------------------------------------------------------

/**
 * `datos` ASSERTED as a column or key — never the word itself. Three forms:
 *   `"datos"`            a JSON key in an example record
 *   `jsonb datos` / `datos jsonb`   a column declaration (mermaid erDiagram, DDL)
 *   `datos->` / `datos->>` / `datos::`   a SQL reference to the column
 */
const DATOS_AS_COLUMN = /"datos"|\bjsonb\s+datos\b|\bdatos\s+jsonb\b|\bdatos\s*(?:->>?|::)/;

const DATOS_ALLOWLIST: Record<string, Entry> = {
	// FROZEN DEBT, not a justified exception. The page keeps a single-payload mental model
	// and labels it "the legacy / matrix_hierarchy shape", with the v7 typed-column split
	// stated in an adjacent admonition — so it misleads no careful reader, but the erDiagram
	// and the example record still SAY `datos`. Rewriting the diagram is the fix; until
	// then the count may only fall.
	'docs/core/architecture_overview.md': {
		max: 3,
		reason: 'frozen debt: the conceptual erDiagram + example record still name the v6 column',
	},
};

// ---------------------------------------------------------------------------
// RULE 3 — `relation` (singular, keyed by tipo), never a flat `relations` array
// ---------------------------------------------------------------------------

/** Opens a `relations` array. The BODY decides whether it is a node or a record shape. */
const RELATIONS_ARRAY = /["']?\brelations\b["']?\s*:\s*\[/g;

/** A locator key inside the array body ⇒ this is a RECORD shape, which is the v6 error. */
const LOCATOR_KEY = /\b(?:section_id|section_tipo|from_component_tipo|tag_id)\b/;

/** dd_ontology node entries reference definitions by tipo — the legitimate `relations`. */
const RELATIONS_ALLOWLIST: Record<string, Entry> = {};

/**
 * Slice from an opening `[` to its matching `]` (or the end). Cheap bracket balance: enough
 * for JSON examples, and it never runs past the array it opened.
 */
function arrayBody(text: string, openBracket: number): string {
	let depth = 0;
	for (let i = openBracket; i < text.length; i++) {
		const ch = text[i];
		if (ch === '[') depth++;
		else if (ch === ']') {
			depth--;
			if (depth === 0) return text.slice(openBracket, i + 1);
		}
	}
	return text.slice(openBracket, openBracket + 2000);
}

// ---------------------------------------------------------------------------
// RULE 4 — envelope v2 only; `result` is a forbidden key
// ---------------------------------------------------------------------------

/** The v1 envelope's discriminator, as a JSON key. */
const RESULT_KEY = /"result"\s*:/;

const RESULT_ALLOWLIST: Record<string, Entry> = {
	// A VERIFIED EXCEPTION: the v1 publication API is a supported, retro-compatible,
	// isolated read-only subsystem with its OWN wire. It never spoke envelope v2.
	'docs/diffusion/publication_api/publication_api.md': {
		reason: 'legacy v1 publication API — its own wire, never envelope v2 (quarantined page)',
	},
	// VERIFIED EXCEPTIONS — NOT the API envelope at all:
	// `/health` is a LIVENESS PROBE served before the envelope layer and genuinely emits
	// `result: 'ok'|'error'` (src/server.ts:741-772). Documenting it any other way would be
	// documenting a response the engine does not send.
	'docs/install/production.md': {
		reason: '/health is a liveness probe, not an API envelope — src/server.ts emits result',
	},
	// `ts_search` is a NESTED PAYLOAD sub-object of the thesaurus area read, and its shape
	// really is {result, msg, total, found} (src/core/ts_object/search.ts:60-65,189-193).
	// The depth-blind rule (see the header) cannot tell it from a top-level key.
	'docs/core/areas/area_thesaurus.md': {
		reason: 'nested ts_search payload — searchThesaurus really returns {result, msg, total, found}',
	},
	// FROZEN DEBT below: pages the 2026-08 correctness pass did not reach. Each still
	// prints a v1 envelope for a CURRENT engine endpoint and must be rewritten to
	// {ok, request_id, data, notices, error}. Counts may only FALL.
	'docs/core/request_config_examples.md': {
		max: 1,
		reason: 'frozen debt: the create-record example still prints the v1 {result,msg,errors}',
	},
	'docs/core/sqo.md': {
		max: 1,
		reason: 'frozen debt: the mixed-section search example wraps in v1 result',
	},
	'docs/core/sections/section_list.md': {
		max: 1,
		reason: 'frozen debt: the list payload example wraps context/data in a v1 result',
	},
	'docs/core/components/component_info.md': {
		max: 3,
		reason: 'frozen debt: the widget response + two failure examples are v1 envelopes',
	},
	'docs/core/components/component_info_cookbook.md': {
		max: 3,
		reason: 'frozen debt: the widget response + two failure examples are v1 envelopes',
	},
	'docs/core/ai/assistant/install.md': {
		max: 2,
		reason: 'frozen debt: the agent_models health-check + its failure line are v1 envelopes',
	},
	'docs/core/ai/assistant/cookbook.md': {
		max: 2,
		reason:
			'frozen debt: one v1 envelope, plus a NESTED per-op `result` the depth-blind rule counts',
	},
	'docs/core/rqo.md': {
		max: 1,
		reason: 'frozen debt: the create example prints {"result":"128"} — v1 AND a string address',
	},
	'docs/development/tools/reference/tool_posterframe.md': {
		max: 1,
		reason: 'frozen debt: the posterframe success response is a v1 envelope',
	},
	'docs/development/tools/reference/tool_hierarchy.md': {
		max: 2,
		reason: 'frozen debt: the repair success + failure responses are v1 envelopes',
	},
	'docs/development/tools/reference/tool_update_cache.md': {
		max: 1,
		reason: 'frozen debt: the cache-rebuild response is a v1 envelope',
	},
	'docs/development/tools/reference/tool_import_files.md': {
		max: 1,
		reason: 'frozen debt: the import response is a v1 envelope',
	},
	'docs/development/tools/reference/tool_propagate_component_data.md': {
		max: 1,
		reason: 'frozen debt: the propagate response is a v1 envelope',
	},
	'docs/development/tools/reference/tool_import_dedalo_csv.md': {
		max: 1,
		reason: 'frozen debt: the CSV import response is a v1 envelope',
	},
};

// ---------------------------------------------------------------------------
// Walker
// ---------------------------------------------------------------------------

function docsTextFiles(): string[] {
	const glob = new Glob(DOCS_TEXT_GLOB);
	return [...glob.scanSync({ cwd: DOCS_DIR })].sort();
}

/** Docs-relative path → file text. */
function read(file: string): string {
	return readFileSync(join(DOCS_DIR, file), 'utf8');
}

/** Per-line hits, reported as `docs/path:line: text`. */
function lineHits(file: string, pattern: RegExp): string[] {
	const out: string[] = [];
	read(file)
		.split('\n')
		.forEach((line, i) => {
			if (pattern.test(line)) out.push(`docs/${file}:${i + 1}: ${line.trim().slice(0, 140)}`);
		});
	return out;
}

/** RULE 3 hits: a `relations` array whose ENTRIES are locators. */
function relationsRecordShapeHits(file: string): string[] {
	const text = read(file);
	const out: string[] = [];
	for (const match of text.matchAll(RELATIONS_ARRAY)) {
		const open = text.indexOf('[', match.index ?? 0);
		if (open === -1) continue;
		const body = arrayBody(text, open);
		if (!LOCATOR_KEY.test(body)) continue; // dd_ontology node definition, or an elided [ … ]
		const line = text.slice(0, open).split('\n').length;
		out.push(`docs/${file}:${line}: ${body.replace(/\s+/g, ' ').slice(0, 140)}`);
	}
	return out;
}

/**
 * Run one rule over the whole tree against its allowlist. Returns the three failure
 * classes the ratchet needs, so each is reported with its own remedy.
 */
function runRule(
	allowlist: Record<string, Entry>,
	hitsFor: (file: string) => string[],
): { regressions: string[]; overBudget: string[]; stale: string[] } {
	const regressions: string[] = [];
	const overBudget: string[] = [];
	const seen = new Map<string, number>();

	for (const file of docsTextFiles()) {
		const key = `docs/${file}`;
		const hits = hitsFor(file);
		if (hits.length === 0) continue;
		seen.set(key, hits.length);

		const entry = allowlist[key];
		if (entry === undefined) {
			regressions.push(...hits);
			continue;
		}
		if (entry.max !== undefined && hits.length > entry.max) {
			overBudget.push(
				`${key}: ${hits.length} occurrences, frozen at ${entry.max}\n  ${hits.join('\n  ')}`,
			);
		}
	}

	const stale: string[] = [];
	for (const [key, entry] of Object.entries(allowlist)) {
		const count = seen.get(key);
		if (count === undefined) {
			stale.push(
				`${key}: entry no longer matches anything — DELETE it (reason was: ${entry.reason})`,
			);
			continue;
		}
		if (entry.max !== undefined && count < entry.max) {
			stale.push(
				`${key}: now ${count} occurrences, frozen at ${entry.max} — LOWER the max to ${count}`,
			);
		}
	}
	return { regressions, overBudget, stale };
}

/** Assert the three classes of one rule, each with its own remedy sentence. */
function assertRule(
	name: string,
	law: string,
	allowlist: Record<string, Entry>,
	hitsFor: (file: string) => string[],
): void {
	const { regressions, overBudget, stale } = runRule(allowlist, hitsFor);
	expect(
		regressions,
		`${name}: NEW VIOLATION in the product manual.\n${law}\nFix the example. If the page genuinely documents a different wire, add it to the allowlist WITH A WRITTEN REASON — never to get green.\n${regressions.join('\n')}`,
	).toEqual([]);
	expect(
		overBudget,
		`${name}: FROZEN DEBT GREW — a page added occurrences of a shape that may only shrink.\n${law}\n${overBudget.join('\n')}`,
	).toEqual([]);
	expect(
		stale,
		`${name}: STALE ALLOWLIST ENTRY — a too-wide entry silently loosens the gate. Someone improved the docs; ratchet the list down in the same change.\n${stale.join('\n')}`,
	).toEqual([]);
}

const LAW_ADDRESS =
	'LAW (engineering/wire_contract/WC-2026-08-10-section-id-int-canonical.md): a matrix record address is a SAFE INTEGER, negatives included. Write `"section_id": 7`, not `"section_id": "7"`.';
const LAW_DATOS =
	'LAW: no matrix table has a `datos` column. The row is `id`, `section_id`, `section_tipo` + the 11 typed JSONB columns (MATRIX_JSONB_COLUMNS, src/core/db/matrix.ts). `datos` is v6 vocabulary.';
const LAW_RELATIONS =
	'LAW: a record\'s locators live in the `relation` column — SINGULAR — as an object KEYED BY the owning component tipo, never a flat `{"relations": [locator, …]}` array. (`relations` IS correct on a dd_ontology NODE, whose entries are `{"tipo": …}` — that form is not flagged.)';
const LAW_ENVELOPE =
	'LAW (engineering/ERRORS_SPEC.md, docs/core/system/errors.md): envelope v1 `{result, msg, errors}` was removed 2026-08-16. `result` is a FORBIDDEN top-level key; v2 is `{ok, request_id, data, notices[], error}` plus extension keys.';

describe('docs locator/storage/envelope shape tripwire', () => {
	test('rule 1 — no record address written as a string', () => {
		assertRule('string record address', LAW_ADDRESS, STRING_ADDRESS_ALLOWLIST, (file) =>
			lineHits(file, STRING_ADDRESS),
		);
	});

	test('rule 2 — no `datos` column asserted as a column or key', () => {
		assertRule('dead `datos` column', LAW_DATOS, DATOS_ALLOWLIST, (file) =>
			lineHits(file, DATOS_AS_COLUMN),
		);
	});

	test('rule 3 — no flat `relations` array of locators (dd_ontology node arrays are correct)', () => {
		assertRule('flat `relations` record shape', LAW_RELATIONS, RELATIONS_ALLOWLIST, (file) =>
			relationsRecordShapeHits(file),
		);
	});

	test('rule 4 — no envelope v1 `result` key', () => {
		assertRule('envelope v1 `result`', LAW_ENVELOPE, RESULT_ALLOWLIST, (file) =>
			lineHits(file, RESULT_KEY),
		);
	});

	test('every allowlist entry is a real file carrying a written reason', () => {
		// Guards the guards. An allowlist you can append to, or one whose entries have no
		// stated justification, is not an allowlist.
		for (const [name, allowlist] of [
			['STRING_ADDRESS_ALLOWLIST', STRING_ADDRESS_ALLOWLIST],
			['DATOS_ALLOWLIST', DATOS_ALLOWLIST],
			['RELATIONS_ALLOWLIST', RELATIONS_ALLOWLIST],
			['RESULT_ALLOWLIST', RESULT_ALLOWLIST],
		] as const) {
			for (const [file, entry] of Object.entries(allowlist)) {
				expect(
					existsSync(join(REPO_ROOT, file)),
					`${name}: allowlisted page is missing: ${file}`,
				).toBe(true);
				expect(
					entry.reason.length,
					`${name}: every entry carries a written reason — ${file}`,
				).toBeGreaterThan(10);
			}
		}
	});

	test('the allowlists are exactly these reason-stamped sets (no quiet additions)', () => {
		expect(Object.keys(STRING_ADDRESS_ALLOWLIST).sort()).toEqual([
			'docs/core/components/component_external.md',
			'docs/core/components/component_text_area.md',
			'docs/core/importing_data.md',
			'docs/core/locator.md',
			'docs/core/system/external_services.md',
			'docs/core/system/observers.md',
			'docs/development/tools/reference/tool_error_report.md',
			'docs/diffusion/diffusion_markdown.md',
			'docs/diffusion/parsers.md',
			'docs/diffusion/publication_api/publication_api.md',
			'docs/install/upgrading.md',
		]);
		expect(Object.keys(DATOS_ALLOWLIST).sort()).toEqual(['docs/core/architecture_overview.md']);
		// Rule 3 has NO exceptions: the carve-out is in the MEASURE (node arrays reference
		// definitions by tipo and are never flagged), not in a list of pardoned pages.
		expect(Object.keys(RELATIONS_ALLOWLIST)).toEqual([]);
		expect(Object.keys(RESULT_ALLOWLIST).sort()).toEqual([
			'docs/core/ai/assistant/cookbook.md',
			'docs/core/ai/assistant/install.md',
			'docs/core/areas/area_thesaurus.md',
			'docs/core/components/component_info.md',
			'docs/core/components/component_info_cookbook.md',
			'docs/core/request_config_examples.md',
			'docs/core/rqo.md',
			'docs/core/sections/section_list.md',
			'docs/core/sqo.md',
			'docs/development/tools/reference/tool_hierarchy.md',
			'docs/development/tools/reference/tool_import_dedalo_csv.md',
			'docs/development/tools/reference/tool_import_files.md',
			'docs/development/tools/reference/tool_posterframe.md',
			'docs/development/tools/reference/tool_propagate_component_data.md',
			'docs/development/tools/reference/tool_update_cache.md',
			'docs/diffusion/publication_api/publication_api.md',
			'docs/install/production.md',
		]);
	});

	test('anti-vacuity — the walker saw the manual', () => {
		const files = docsTextFiles();
		expect(
			files.length,
			'docs/ walker matched no files — the glob or the root moved',
		).toBeGreaterThan(150);
		expect(files).toContain('core/locator.md');
	});
});

describe('docs shape tripwire — the measure is what it claims', () => {
	// The patterns are proved in BOTH directions on synthetic text, so a future edit that
	// neuters one of them cannot pass unnoticed.

	test('rule 1 fires on a quoted integer address and NOT on tokens or int form', () => {
		expect(STRING_ADDRESS.test('{"section_id": "7", "section_tipo": "test1"}')).toBe(true);
		expect(STRING_ADDRESS.test("{'section_id':'2'}")).toBe(true);
		expect(STRING_ADDRESS.test('section_id: "42"')).toBe(true);
		expect(STRING_ADDRESS.test('{"parent_section_id": "-1"}')).toBe(true);
		// Correct documentation — must stay green.
		expect(STRING_ADDRESS.test('{"section_id": 7}')).toBe(false);
		expect(STRING_ADDRESS.test('{"section_id": "self"}')).toBe(false);
		expect(STRING_ADDRESS.test('{"section_id": "current"}')).toBe(false);
		expect(STRING_ADDRESS.test('{"section_id": "search_1"}')).toBe(false);
		expect(STRING_ADDRESS.test('{"section_id": "tmp_export_2"}')).toBe(false);
		// SQL: `->>` returns text, so the string comparison is RIGHT.
		expect(STRING_ADDRESS.test("locator_data->>'section_id' = '7'")).toBe(false);
		// Out of the key set on purpose (see the header).
		expect(STRING_ADDRESS.test('{"section_top_id": "368"}')).toBe(false);
		expect(STRING_ADDRESS.test('{"from_section_id": "1"}')).toBe(false);
	});

	test('rule 2 fires on an asserted column and NOT on prose that denies it', () => {
		expect(DATOS_AS_COLUMN.test('        jsonb datos')).toBe(true);
		expect(DATOS_AS_COLUMN.test('    "datos" : {')).toBe(true);
		expect(DATOS_AS_COLUMN.test("SELECT datos->>'test5' FROM matrix")).toBe(true);
		// Correct documentation — every page that denies the column must name it.
		expect(DATOS_AS_COLUMN.test('There is no `datos` column, and no record-level array')).toBe(
			false,
		);
		expect(DATOS_AS_COLUMN.test('never a single legacy `datos` column')).toBe(false);
		expect(DATOS_AS_COLUMN.test('"lg-spa" : "Datos JSON"')).toBe(false);
	});

	test('rule 3 separates the record shape from the dd_ontology node shape', () => {
		const record = 'x = {"relations": [{"type":"dd151","section_id":2,"section_tipo":"test1"}]}';
		const node = '{ "relations": [ { "tipo": "test5" }, { "tipo": "test71" } ] }';
		const elided = 'is wrong: `{"relations": [ … ]}` on both counts';
		const probe = (text: string) => {
			const out: string[] = [];
			for (const m of text.matchAll(RELATIONS_ARRAY)) {
				const open = text.indexOf('[', m.index ?? 0);
				if (LOCATOR_KEY.test(arrayBody(text, open))) out.push(text.slice(open, open + 20));
			}
			return out;
		};
		expect(probe(record).length, 'a locator-entry array IS the v6 record shape').toBe(1);
		expect(probe(node), 'a {tipo} array is a dd_ontology node definition — correct').toEqual([]);
		expect(probe(elided), 'an elided illustration names no locator — correct').toEqual([]);
	});

	test('rule 4 fires on the v1 discriminator and NOT on envelope v2', () => {
		expect(RESULT_KEY.test('{ "result": true, "msg": "OK", "errors": [] }')).toBe(true);
		expect(RESULT_KEY.test('{"ok": true, "request_id": "abc", "data": {}, "notices": []}')).toBe(
			false,
		);
		// Prose about "the result" is not a key.
		expect(RESULT_KEY.test('the result is a mix of data from different sections')).toBe(false);
	});
});
