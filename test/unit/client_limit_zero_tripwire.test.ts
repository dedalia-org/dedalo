/**
 * TRIPWIRE — the client never asks for an unbounded limit (P2-31 / CLI-29 / CLI-30).
 *
 * `limit: 0` meant "everything" on the client and "the ceiling" on the server
 * (DEC-07): every "show all", every post-duplicate tree refresh and every
 * completeness read (emails, related records, recursive children) was an
 * undeclared ask the server clamped at DEDALO_SEARCH_CLIENT_MAX_LIMIT in
 * silence — and the tree children door did not even clamp: it read 0 as an
 * UNPAGED read of the whole branch. The fix is one contract: the server
 * publishes its ceiling (`page_globals.dedalo_search_client_max_limit`,
 * WC-2026-09-04-client-limit-bound), the client resolves every bound through
 * `client/dedalo/core/common/js/sqo_limit.js`, and `clampClientLimit` is the
 * ONE clamp both the SQO door and the children door apply.
 *
 * Legs:
 *   1. TOTAL census, derived from the tree: no .js under client/ + tools/**
 *      sends `limit: 0` / `.limit = 0` / `limit = 0` (comments stripped),
 *      except the ENUMERATED exemptions below — each with its reason, shrink-only.
 *   2. Positive control: an offender source is flagged by the same classifier.
 *   3. The client resolves the bound through sqo_limit.js and reads the
 *      page_globals key the server publishes (no client constant is THE bound).
 *   4. clampClientLimit, pure: 0 / negative / 'all' / NaN / > ceiling → the
 *      ceiling; a value within the bound passes; sanitizeClientSqo applies it.
 *      That every DOOR bounds its client page is measured as an OUTCOME, not
 *      read from source spellings: client_page_doors_native (the doors that
 *      reach the relation sink, derived at run time) and
 *      wire_sqo_page_bound_native (the wire schema bounds every action's sqo
 *      window) — they replaced the spelling half of this leg (READ-4).
 *
 * The behavioural half of the children door is ts_api_children_data_native
 * (suite DB); the browser half is test_render_budget in `bun run test:client`.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	CLIENT_MAX_LIMIT,
	clampClientLimit,
	clampClientOffset,
	clampClientPage,
	offsetPastPage,
	sanitizeClientSqo,
} from '../../src/core/concepts/sqo.ts';
import { browserSources } from '../helpers/browser_corpus.ts';
import { stripComments } from '../helpers/strip_comments.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');

const code = (rel: string): string => stripComments(readFileSync(join(REPO_ROOT, rel), 'utf8'));

/**
 * An unbounded ask: a `limit` key or property set to a literal 0. Four
 * spellings — an object-literal KEY `limit: 0` / `"limit": 0` / `'limit': 0`
 * (at line start or after `{` / `,` / `(`, so a ternary's `… self.limit : 0`
 * is not a key), property assignment `.limit = 0` (including the tail of an
 * assignment chain), bracket property `['limit'] = 0` / `["limit"] = 0`, bare
 * `limit = 0`.
 */
const UNBOUNDED_LIMIT =
	/(?:(?:^|[{,(])\s*["']?limit["']?\s*:\s*0\b|\.limit\s*=\s*0\b|\[\s*["']limit["']\s*\]\s*=\s*0\b|\blimit\s*=\s*0\b)/;

/** Line numbers (1-based) where `source` sends an unbounded limit. */
const offendingLines = (source: string): number[] => {
	const lines: number[] = [];
	source.split('\n').forEach((line, i) => {
		if (UNBOUNDED_LIMIT.test(line)) lines.push(i + 1);
	});
	return lines;
};

/**
 * SHRINK-ONLY. Each entry is a file that legitimately holds the token, with the
 * reason it is not an unbounded ask. A new entry needs a reason of the same kind.
 */
const EXEMPT: ReadonlyArray<{ file: string; count: number; reason: string }> = [
	{
		file: 'tools/tool_print/js/tool_print.js',
		count: 2,
		reason:
			"ddo_map `limit: 0` is the DDO pagination field (docs/core/dd_object.md): all locators of ONE record's stored relation, bounded by the record — not a search limit",
	},
	{
		file: 'client/dedalo/core/paginator/js/paginator.js',
		count: 1,
		reason:
			'`limit = 0` is local arithmetic in _update_pagination_props (a NaN guard on a copied number); nothing is sent',
	},
];

describe('client_limit_zero_tripwire', () => {
	test('TOTAL census: no client source sends an unbounded limit (ENUMERATED exemptions, shrink-only)', () => {
		const files = browserSources();
		// the floor: a broken glob must not pass by scanning nothing
		expect(files.length, 'the client census found almost no files').toBeGreaterThan(300);

		const offenders: string[] = [];
		const seenExempt = new Map<string, number>();
		for (const file of files) {
			const lines = offendingLines(code(file));
			if (lines.length === 0) continue;
			const exempt = EXEMPT.find((e) => e.file === file);
			if (exempt) {
				seenExempt.set(file, lines.length);
				if (lines.length > exempt.count) {
					offenders.push(
						`${file}: ${lines.length} unbounded limits at lines ${lines.join(',')} — the exemption covers ${exempt.count}`,
					);
				}
				continue;
			}
			offenders.push(`${file}: lines ${lines.join(',')}`);
		}
		expect(
			offenders,
			'a client call site sends limit 0 — the server reads it as the ceiling (or, at the children door, as ' +
				'the whole branch); resolve the bound through common/js/sqo_limit.js (max_page_limit / ' +
				'bound_sqo_limit / request_complete) instead',
		).toEqual([]);

		// every exemption is live and exact: a stale row would be a widened door
		expect(EXEMPT.length, 'this list is shrink-only').toBeLessThanOrEqual(2);
		for (const exempt of EXEMPT) {
			expect(
				seenExempt.get(exempt.file),
				`stale exemption: ${exempt.file} (${exempt.reason})`,
			).toBe(exempt.count);
		}
	});

	test('positive control: the classifier flags an offender in each spelling', () => {
		const offender = [
			'const rqo = { sqo: { section_tipo: ["test3"], limit: 0, offset: 0 } }',
			'self.rqo.sqo.limit = self.request_config_object.sqo.limit = 0',
			'// a comment saying limit: 0 must NOT count',
			'let limit = 0',
			'\t\t\t\tlimit\t\t\t: 0,',
			'const prev = (self.offset > self.limit) ? self.offset - self.limit : 0',
			"self.rqo.sqo['limit'] = self.request_config_object.sqo['limit'] = 0",
			'Object.assign(self.rqo.sqo, {"limit": 0}); self.refresh()',
			"const p = { 'limit': 0 }",
		].join('\n');
		expect(offendingLines(stripComments(offender))).toEqual([1, 2, 4, 5, 7, 8, 9]);
		// …and a bounded ask is clean
		expect(
			offendingLines(
				stripComments(
					'rqo.sqo.limit = max_page_limit()\nconst p = { limit: bound_sqo_limit(limit), offset: 0 }',
				),
			),
		).toEqual([]);
	});

	test('the client resolves its bound from the SERVER-published page_globals key, through one module', () => {
		const sqoLimit = code('client/dedalo/core/common/js/sqo_limit.js');
		expect(sqoLimit).toMatch(/page_globals\.dedalo_search_client_max_limit/);
		expect(sqoLimit).toMatch(/export const max_page_limit/);
		expect(sqoLimit).toMatch(/export const bound_sqo_limit/);
		expect(sqoLimit).toMatch(/export const request_complete/);
		// the server publishes exactly that key from the configured ceiling
		const environment = code('src/core/resolve/environment.ts');
		expect(environment).toMatch(
			/dedalo_search_client_max_limit:\s*config\.features\.searchClientMaxLimit/,
		);
		// no other client module reads the key: ONE resolver, so the bound cannot drift
		const readers = browserSources().filter(
			(f) =>
				!f.endsWith('/sqo_limit.js') &&
				!f.includes('/test/client/js/') &&
				/dedalo_search_client_max_limit/.test(code(f)),
		);
		expect(readers, 'a second reader of the ceiling is a second bound').toEqual([]);
		// the senders route through it: every former limit:0 site imports the module
		for (const file of [
			'client/dedalo/core/component_portal/js/component_portal.js',
			// render_open_list_with_direct_relations.js left this list 2026-10-30: it no
			// longer pages anything (open relationships sends a `referenced_by` source,
			// which refuses limit/offset, and the server answers the whole set) — the
			// limit:0 scan above still covers it like every client file
			'client/dedalo/core/ts_object/js/render_ts_line.js',
			'client/dedalo/core/ts_object/js/render_ts_id_column.js',
			'client/dedalo/core/ts_object/js/ts_object.js',
			'client/dedalo/core/component_email/js/component_email.js',
			'client/dedalo/core/relation_list/js/relation_list.js',
			'tools/tool_qr/js/tool_qr.js',
		]) {
			expect(code(file), `${file} does not resolve its bound through sqo_limit.js`).toMatch(
				/from\s+'[./]+(?:core\/)?common\/js\/sqo_limit\.js'/,
			);
		}
	});

	test('clampClientLimit: 0 / negative / all / NaN / above → the ceiling; within → itself', () => {
		expect(CLIENT_MAX_LIMIT).toBeGreaterThan(0);
		expect(clampClientLimit(0, 'x')).toBe(CLIENT_MAX_LIMIT);
		expect(clampClientLimit(-1, 'x')).toBe(CLIENT_MAX_LIMIT);
		expect(clampClientLimit('all', 'x')).toBe(CLIENT_MAX_LIMIT);
		expect(clampClientLimit('abc', 'x')).toBe(CLIENT_MAX_LIMIT);
		expect(clampClientLimit(Number.NaN, 'x')).toBe(CLIENT_MAX_LIMIT);
		expect(clampClientLimit(CLIENT_MAX_LIMIT + 1, 'x')).toBe(CLIENT_MAX_LIMIT);
		expect(clampClientLimit(undefined, 'x')).toBe(CLIENT_MAX_LIMIT);
		expect(clampClientLimit(null, 'x')).toBe(CLIENT_MAX_LIMIT);
		expect(clampClientLimit(CLIENT_MAX_LIMIT, 'x')).toBe(CLIENT_MAX_LIMIT);
		expect(clampClientLimit(7, 'x')).toBe(7);
		expect(clampClientLimit('12', 'x')).toBe(12);
		expect(clampClientLimit(3.9, 'x')).toBe(3);
	});

	test('sanitizeClientSqo applies the ONE clamp (limit and offset)', () => {
		expect(sanitizeClientSqo({ section_tipo: 'test3', limit: 0 }).limit).toBe(CLIENT_MAX_LIMIT);
		expect(sanitizeClientSqo({ section_tipo: 'test3', limit: 'all' }).limit).toBe(CLIENT_MAX_LIMIT);
		expect(sanitizeClientSqo({ section_tipo: 'test3', limit: 5 }).limit).toBe(5);
		expect(sanitizeClientSqo({ section_tipo: 'test3', offset: -5 }).offset).toBe(0);
		expect(sanitizeClientSqo({ section_tipo: 'test3', offset: 1e21 }).offset).toBe(
			Number.MAX_SAFE_INTEGER,
		);
		// A non-numeric offset is page 1 — never NaN, never dropped silently into
		// an assembler default.
		expect(sanitizeClientSqo({ section_tipo: 'test3', offset: 'x' }).offset).toBe(0);
	});

	test('clampClientOffset: absent / NaN / non-numeric → 0; negative → 0; past MAX_SAFE → MAX_SAFE; within → itself', () => {
		expect(clampClientOffset(undefined, 'x')).toBe(0);
		expect(clampClientOffset(null, 'x')).toBe(0);
		expect(clampClientOffset('x', 'x')).toBe(0);
		expect(clampClientOffset(Number.NaN, 'x')).toBe(0);
		expect(clampClientOffset(-5, 'x')).toBe(0);
		expect(clampClientOffset(1e21, 'x')).toBe(Number.MAX_SAFE_INTEGER);
		expect(clampClientOffset(Number.POSITIVE_INFINITY, 'x')).toBe(Number.MAX_SAFE_INTEGER);
		expect(clampClientOffset(Number.MAX_SAFE_INTEGER, 'x')).toBe(Number.MAX_SAFE_INTEGER);
		expect(clampClientOffset('12', 'x')).toBe(12);
		expect(clampClientOffset(7.9, 'x')).toBe(7);
	});

	test('clampClientPage: an absent limit takes the DOOR default (clamped), and is "defaulted"', () => {
		// The suite runs at the installation ceiling (1000 by default) — above the
		// get_indexation_grid door default of 500, so the default is observable.
		expect(CLIENT_MAX_LIMIT).toBeGreaterThan(500);
		expect(clampClientPage(undefined, 0, 's', 500)).toEqual({
			limit: 500,
			offset: 0,
			bounded: 'defaulted',
		});
		// Without a door default: the ceiling.
		expect(clampClientPage(undefined, 0, 's')).toEqual({
			limit: CLIENT_MAX_LIMIT,
			offset: 0,
			bounded: 'defaulted',
		});
		// A door default above the ceiling is itself clamped (one clamp).
		expect(clampClientPage(null, 0, 's', CLIENT_MAX_LIMIT + 1).limit).toBe(CLIENT_MAX_LIMIT);
		// Sent and served as sent; sent and changed.
		expect(clampClientPage(5, 2, 's', 500).bounded).toBe('requested');
		expect(clampClientPage(5, 'x', 's', 500)).toEqual({ limit: 5, offset: 0, bounded: 'clamped' });
		// The clamp's own boundary is served as sent: still 'defaulted' with no limit.
		expect(clampClientPage(undefined, 1e21, 's', 500)).toEqual({
			limit: 500,
			offset: Number.MAX_SAFE_INTEGER,
			bounded: 'clamped',
		});
		expect(clampClientPage(undefined, Number.MAX_SAFE_INTEGER, 's', 500).bounded).toBe('defaulted');
	});

	test('offsetPastPage: the first row past the page, or null when it lies past MAX_SAFE_INTEGER', () => {
		expect(offsetPastPage({ limit: 3, offset: 6, bounded: 'defaulted' })).toBe(9);
		expect(
			offsetPastPage({ limit: 3, offset: Number.MAX_SAFE_INTEGER - 3, bounded: 'defaulted' }),
		).toBe(Number.MAX_SAFE_INTEGER);
		expect(
			offsetPastPage({ limit: 3, offset: Number.MAX_SAFE_INTEGER - 2, bounded: 'defaulted' }),
		).toBeNull();
		expect(
			offsetPastPage({ limit: 1000, offset: Number.MAX_SAFE_INTEGER, bounded: 'defaulted' }),
		).toBeNull();
	});
});
