/**
 * A SEARCH IS LITERAL — measured on the corpus, through the whole search path
 * (DATA-34).
 *
 * `search_pattern_escape_tripwire` proves every `~*` operand is escaped. This
 * gate proves the CONSEQUENCE on real rows: a curator searching `[sic]` gets
 * the one record whose title carries `[sic]`, not the three-letter character
 * class Postgres used to compile that into.
 *
 * FIXTURE: the zzscale museum-scale corpus, whose string distribution exists
 * for exactly this question — `Denarius` / `Denarius [sic]` plus ONE value per
 * regex metacharacter (`Sestertius<char>mark`), so the census below is TOTAL
 * over the metacharacter class the engine declares, derived from the class
 * itself and never hand-listed. Built and torn down here; the corpus's own
 * contract gate (zzscale_corpus_native) owns its shape.
 *
 * The `~` in `Sestertius~mark` is NOT a metacharacter and is deliberately
 * absent from the class — a value carrying it is the corpus's own positive
 * control, planted in zzscale_corpus_native.
 *
 * THE SECOND ALPHABET (2026-09-05). The class above is the one a curator TYPES.
 * It is not the class Postgres COMPILES: every operand is normalized with
 * `f_unaccent`, and that dictionary EXPANDS characters INTO metacharacters
 * (`×`→`*`, `©`→`(C)`, `…`→`...`, `∖`→`\`, `⁅`→`[`, `¿`→`?` — 143 characters
 * in the shipped rules, measured here against the LIVE dictionary). An escape
 * applied before normalization neutralises metacharacters that do not exist
 * yet, which is why the escape now runs in SQL on the far side of f_unaccent —
 * and why the census below is derived from the database's own dictionary and
 * not from any list in the repo.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sanitizeClientSqo } from '../../src/core/concepts/sqo.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { buildStringFragment } from '../../src/core/search/builders/builder_string.ts';
import type { BuilderContext, Fragment } from '../../src/core/search/builders/types.ts';
import { REGEX_META } from '../../src/core/search/builders/types.ts';
import { asSqlTipo } from '../../src/core/search/identifier_gate.ts';
import {
	ZZSCALE_CONTAINS_TERM,
	ZZSCALE_EXACT_TERM,
	ZZSCALE_SECTION,
	ZZSCALE_TERM_COMPONENT,
	zzScaleMetaValue,
} from '../../src/core/test_data/situations/zzscale_constants.ts';
import {
	dropZzScaleCorpus,
	ensureZzScaleCorpus,
} from '../../src/core/test_data/situations/zzscale_corpus.ts';
import { buildSearchSql } from '../helpers/search_sql.ts';

/** The metacharacter class, as characters, derived from the engine's regex. */
const META_CHARS: string[] = (() => {
	const body = REGEX_META.source.replace(/^\[/, '').replace(/\]$/, '');
	const chars: string[] = [];
	for (let i = 0; i < body.length; i++) {
		if (body[i] === '\\') {
			i += 1;
			chars.push(body[i] as string);
			continue;
		}
		chars.push(body[i] as string);
	}
	return chars;
})();

/**
 * ENUMERATED EXEMPTIONS — characters the Dedalo query GRAMMAR consumes before
 * any pattern is built, so no escape could ever make them searchable. Each
 * carries its own reason; the set is SHRINK-ONLY (a character that stops being
 * grammar becomes searchable and leaves this list — one that starts being
 * grammar is a wire change, not an entry here).
 */
const GRAMMAR_CONSUMED = new Map<string, string>([
	[
		'*',
		"Dedalo's OWN wildcard: '*term' is ends-with, 'term*' begins-with, and the " +
			'remaining stars are stripped from q by the default-contains rule (PHP parity).',
	],
	[
		'+',
		"stripped alongside '*' and '=' by the same default-contains rule the PHP " +
			'search::get_search_query inherited — a leading + is a PHP-era operator sigil.',
	],
]);

/** How many records match `q` as a CONTAINS search of the corpus's term. */
async function contains(q: string): Promise<number> {
	const sqo = sanitizeClientSqo(
		structuredClone({
			section_tipo: [ZZSCALE_SECTION],
			full_count: true,
			filter: {
				$and: [
					{
						q,
						path: [{ section_tipo: ZZSCALE_SECTION, component_tipo: ZZSCALE_TERM_COMPONENT }],
					},
				],
			},
		}),
	);
	const { sql: builtSql, params } = await buildSearchSql(sqo, {});
	const rows = (await sql.unsafe(builtSql, params as (string | number | null)[])) as {
		full_count: number | string;
	}[];
	return rows.reduce((sum, row) => sum + Number(row.full_count), 0);
}

beforeAll(async () => {
	await ensureZzScaleCorpus();
}, 60000);

afterAll(async () => {
	await dropZzScaleCorpus();
});

describe('a search term is matched literally', () => {
	test('the corpus really holds the pair (a vacuous 1-of-1 cannot pass)', async () => {
		// PRE-CONDITION: `Denarius` matches BOTH values (it is a substring of
		// both), so the `[sic]` leg below is a real discrimination, not a lucky
		// singleton.
		expect(await contains(ZZSCALE_EXACT_TERM)).toBe(2);
	});

	test('`[sic]` finds the ONE record that says [sic], not a character class', async () => {
		// Unescaped, `[sic]` is the class {s,i,c} and matches every value holding
		// any of those letters — which is every metacharacter value
		// (`Sestertius…mark`) and both Denarius values.
		expect(await contains('[sic]')).toBe(1);
		expect(ZZSCALE_CONTAINS_TERM).toContain('[sic]');
	});

	test('CENSUS: EVERY declared metacharacter matches its own value ALONE', async () => {
		// Floor: the class is 14 characters; a class parsed to nothing would make
		// this loop vacuous.
		expect(META_CHARS.length).toBeGreaterThan(10);
		expect(META_CHARS.length - GRAMMAR_CONSUMED.size).toBeGreaterThan(10);
		const wrong: string[] = [];
		for (const char of META_CHARS) {
			if (GRAMMAR_CONSUMED.has(char)) continue;
			const value = zzScaleMetaValue(char);
			const hits = await contains(value);
			if (hits !== 1) wrong.push(`${char} → ${hits}`);
		}
		expect(wrong).toEqual([]);
	}, 60000);

	test('every exemption has a stated reason (shrink-only)', () => {
		for (const [char, reason] of GRAMMAR_CONSUMED) {
			expect(META_CHARS, `${char} is exempt but not even in the class`).toContain(char);
			expect(reason.length, `${char} carries no reason`).toBeGreaterThan(40);
		}
		expect(GRAMMAR_CONSUMED.size).toBeLessThan(3);
	});

	test('a regex SYNTAX ERROR term ANSWERS instead of throwing', async () => {
		// `Denarius(` is an unclosed group: before the escape it reached the
		// curator as an internal failure raised by the database, not as a result.
		expect(await contains('Denarius(')).toBe(0);
		// and the corpus value that really carries '(' is still found
		expect(await contains(zzScaleMetaValue('('))).toBe(1);
	});

	test('the store PRE-FILTER now covers metacharacter terms too (PERF half)', () => {
		// The class that used to fall back to the slow classic scan is exactly
		// the class the escape made literal, so the trigram superset is sound
		// for it — the raw term drives LIKE, the escaped one the exact predicate.
		const ctx: BuilderContext = {
			alias: 'm',
			column: 'string',
			tipo: asSqlTipo(ZZSCALE_TERM_COMPONENT, 'test context'),
			sectionTipo: ZZSCALE_SECTION,
			table: 'matrix_test',
			lang: 'lg-eng',
			translatable: true,
			model: 'component_input_text',
			searchStoreCovered: true,
		};
		const built = buildStringFragment('Sestertius(mark', null, false, ctx) as Fragment;
		expect(built.sentence).toContain('matrix_string_search sv');
		// BOTH operands travel raw and are escaped in SQL, on the far side of
		// f_unaccent: the LIKE superset and the exact predicate must agree for
		// every term, metacharacters and unaccent-expanding characters alike.
		expect(built.tokenValues._Q0_).toBe('Sestertius(mark');
		expect(built.tokenValues._Q1_).toBe('Sestertius(mark');
		expect(built.sentence).toContain("LIKE '%' || f_like_literal(lower(f_unaccent(_Q0_)))");
		expect(built.sentence).toContain('~* f_regex_literal(f_unaccent(_Q1_))');
	});
});

/**
 * The `~*` OPERAND EXPRESSION the string builder actually emits, with its bound
 * token replaced by a SQL expression. Read off a real fragment — a hand-written
 * copy of the predicate would keep passing after the builders stopped emitting
 * it.
 */
function emittedOperand(valueExpression: string): string {
	const ctx: BuilderContext = {
		alias: 'm',
		column: 'string',
		tipo: asSqlTipo(ZZSCALE_TERM_COMPONENT, 'test context'),
		sectionTipo: ZZSCALE_SECTION,
		table: 'matrix_test',
		lang: 'lg-eng',
		translatable: true,
		model: 'component_input_text',
	};
	const built = buildStringFragment('probe', null, false, ctx) as Fragment;
	const match = built.sentence.match(/~\* (\S+\(_Q1_\)\))/);
	expect(match, `no ~* operand found in ${built.sentence}`).not.toBeNull();
	return ((match as RegExpMatchArray)[1] as string).replaceAll('_Q1_', valueExpression);
}

/** The declared class, as a SQL bracket expression — one spelling, derived. */
const META_CLASS_SQL = `[${META_CHARS.map((char) => (char === '\\' ? '\\\\' : char === ']' ? '\\]' : char)).join('')}]`;

/**
 * Every declared metacharacter's unaccent PRE-IMAGE, read from the LIVE
 * dictionary (`⁅`→`[`, `×`→`*`, `∖`→`\\`, …) — the character a curator can
 * actually type to reach one, including the two the grammar consumes.
 */
async function unaccentPreimages(): Promise<Map<string, string>> {
	const rows = (await sql.unsafe(
		`SELECT f_unaccent(chr(i)) AS meta, min(i) AS code
		 FROM generate_series(1, 65535) AS g(i)
		 WHERE (i < 55296 OR i > 57343)
		   AND f_unaccent(chr(i)) ~ '^${META_CLASS_SQL}$'
		   AND chr(i) !~ '${META_CLASS_SQL}'
		 GROUP BY 1`,
		[],
	)) as { meta: string; code: number | string }[];
	return new Map(rows.map((row) => [row.meta, String.fromCodePoint(Number(row.code))]));
}

describe('the alphabet Postgres compiles, not the one the curator types', () => {
	test('CENSUS is TOTAL over the LIVE unaccent dictionary: every expanding character stays literal', async () => {
		// The class is derived from the DATABASE's own dictionary (every BMP
		// codepoint whose f_unaccent output carries a metacharacter the character
		// itself does not) — never a list in the repo, which could not track the
		// rules file an install ships.
		//
		// Three questions per character, in ONE query, on the builder's OWN
		// emitted operand:
		//   - SELF-MATCH: the value carrying the character finds itself (the
		//     FALSE-NEGATIVE half — a curator could not find `Anverso 12 × 8 cm`
		//     by pasting `12 × 8`);
		//   - the two DECOYS — the expansion with its metacharacters stripped, and
		//     with them filled — do NOT match (the OVER-MATCH half: `Museo © 1998`
		//     matched `Museo C 1998`);
		//   - and the query RUNS AT ALL: an unescaped `×` compiles to
		//     `quantifier operand invalid` and an unescaped `∖` to `invalid escape
		//     \\ sequence`, i.e. an internal failure reaching the curator.
		const rows = (await sql.unsafe(
			`WITH cls AS (
				SELECT chr(i) AS ch
				FROM generate_series(1, 65535) AS g(i)
				WHERE (i < 55296 OR i > 57343)
				  AND f_unaccent(chr(i)) ~ '${META_CLASS_SQL}'
				  AND chr(i) !~ '${META_CLASS_SQL}'
			), probe AS (
				SELECT ch,
					'Sestertius' || ch || 'mark' AS val,
					'Sestertius' || regexp_replace(f_unaccent(ch), '${META_CLASS_SQL}', '', 'g') || 'mark' AS decoy_strip,
					'Sestertius' || regexp_replace(f_unaccent(ch), '${META_CLASS_SQL}', 'abc', 'g') || 'mark' AS decoy_fill
				FROM cls
			)
			SELECT ch,
				f_unaccent(val) ~* ${emittedOperand('val')} AS self_match,
				f_unaccent(decoy_strip) ~* ${emittedOperand('val')} AS over_strip,
				f_unaccent(decoy_fill) ~* ${emittedOperand('val')} AS over_fill
			FROM probe`,
			[],
		)) as { ch: string; self_match: boolean; over_strip: boolean; over_fill: boolean }[];
		// Floor: 143 characters in the shipped rules today. A dictionary that
		// expanded nothing (or a class parsed to nothing) would make the loop
		// vacuous while staying green.
		expect(rows.length).toBeGreaterThan(30);
		const wrong = rows
			.filter((row) => row.self_match !== true || row.over_strip === true || row.over_fill === true)
			.map(
				(row) => `${row.ch} (self ${row.self_match}, decoys ${row.over_strip}/${row.over_fill})`,
			);
		expect(wrong).toEqual([]);
	}, 60000);

	test('PRE-IMAGE CENSUS, through the whole search path: every declared metacharacter is reachable by its expansion', async () => {
		// The corpus holds one value per DECLARED metacharacter. Each of those
		// characters has at least one unaccent PRE-IMAGE (`⁅`→`[`, `×`→`*`,
		// `∖`→`\`, …), so a curator can type the pre-image and must find the
		// record that literally carries the metacharacter — the false-negative
		// half, measured end to end. It also covers the two GRAMMAR_CONSUMED
		// characters, which no directly-typed term can reach.
		const preimage = await unaccentPreimages();
		// Floor: all 14 declared characters have a pre-image in the shipped rules.
		expect(preimage.size).toBe(META_CHARS.length);
		expect(META_CHARS.length).toBeGreaterThan(10);
		const wrong: string[] = [];
		for (const char of META_CHARS) {
			const typed = preimage.get(char) as string;
			const hits = await contains(zzScaleMetaValue(typed));
			if (hits !== 1) wrong.push(`${typed} (→ ${char}) → ${hits}`);
		}
		expect(wrong).toEqual([]);
	}, 60000);

	test('ANCHORED CENSUS: begins-with and ends-with are literal too', async () => {
		// The wildcard-anchored arms build a DIFFERENT operand
		// (`'^' || f_regex_literal(f_unaccent(_Q1_))`), so an escape regression
		// confined to that branch — a TypeScript-side escape re-added there, on
		// top of the SQL one — is invisible to every contains census above: it
		// would double-escape (`\(` → a literal backslash) and silently return
		// NOTHING for any anchored term carrying a metacharacter.
		//
		// TOTAL over the declared class, each character asked BOTH ways: typed
		// directly (skipping the grammar-consumed ones, which no typed term can
		// reach) and typed as its unaccent PRE-IMAGE, which is the only route to
		// those two and the only route that also exercises the expansion.
		expect(META_CHARS.length - GRAMMAR_CONSUMED.size).toBeGreaterThan(10);
		const preimage = await unaccentPreimages();
		expect(preimage.size).toBe(META_CHARS.length);
		// PRE-CONDITION: the unanchored halves of these terms are NOT singletons
		// on their own — `Sestertius` is the prefix of every metacharacter value —
		// so a 1-hit answer below is the anchor and the escape agreeing, not luck.
		expect(await contains('Sestertius')).toBeGreaterThanOrEqual(META_CHARS.length);
		const wrong: string[] = [];
		for (const char of META_CHARS) {
			const forms = GRAMMAR_CONSUMED.has(char) ? [] : [char];
			forms.push(preimage.get(char) as string);
			for (const typed of forms) {
				const value = zzScaleMetaValue(typed);
				// begins-with: the value minus its last two characters, then '*'
				const begins = await contains(`${value.slice(0, -2)}*`);
				// ends-with: '*' then the value minus its first two characters
				const ends = await contains(`*${value.slice(2)}`);
				if (begins !== 1) wrong.push(`begins ${typed} (→ ${char}) → ${begins}`);
				if (ends !== 1) wrong.push(`ends ${typed} (→ ${char}) → ${ends}`);
			}
		}
		expect(wrong).toEqual([]);
	}, 120000);

	test('an EXPANDING term over-matches nothing and raises nothing, through the whole search path', async () => {
		// `…` expands to `...` — three any-characters — which used to match
		// `Denarius [sic]` on a term that is not a substring of it.
		expect(await contains('Denarius\u2026')).toBe(0);
		// `×` expands to a bare `*`: `quantifier operand invalid`, an internal
		// failure where a curator asked a question.
		expect(await contains('Denarius\u00d7')).toBe(0);
		// `∖` expands to a lone backslash: `invalid escape \\ sequence`.
		expect(await contains('Denarius\u2216')).toBe(0);
		// and the pair is still there to be over-matched
		expect(await contains(ZZSCALE_EXACT_TERM)).toBe(2);
	});
});
