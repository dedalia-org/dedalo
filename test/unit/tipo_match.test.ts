/**
 * tipo membership (PHP tipo_in_array, shared/core_functions.php:2385) — the
 * matcher a tool's `affected_tipos` (dd1350) is compiled into
 * (src/core/tools/tipo_match.ts, T2-O11-2).
 *
 * Three value forms, any hit wins:
 *   - `<tld>*` WILDCARD: same TLD as the tipo (PHP get_tld_from_tipo on BOTH
 *     sides). The old TS reader stripped only `[0-9].*$`, so the value kept its
 *     `*` and `ontology*` could never equal `ontology` — every wildcard was dead;
 *   - `/pattern/flags` REGEX (PHP preg_match); a malformed one never matches
 *     and is reported ONCE, when the list is compiled — never per tipo tested;
 *   - an EXACT tipo.
 * Pure: no DB, no config.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { compileTipoMatcher } from '../../src/core/tools/tipo_match.ts';

let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
	warn = spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe('tipo_match: PHP tipo_in_array over a compiled list', () => {
	test('`<tld>*` matches every tipo of that TLD — and only that TLD', () => {
		const matcher = compileTipoMatcher(['ontology*'], 'tool_zz');
		expect(matcher.matches('ontology40')).toBe(true);
		expect(matcher.matches('ontology0')).toBe(true);
		// a longer TLD sharing the prefix is ANOTHER namespace
		expect(matcher.matches('ontologytype14')).toBe(false);
		expect(matcher.matches('dd40')).toBe(false);
		// `test*` (the suite's own TLD) the same way
		const testTld = compileTipoMatcher(['test*'], 'tool_zz');
		expect(testTld.matches('test3')).toBe(true);
		expect(testTld.matches('testplace1015')).toBe(false);
	});

	test('a bare `*` names no TLD and matches nothing (no null === null hit)', () => {
		const matcher = compileTipoMatcher(['*'], 'tool_zz');
		expect(matcher.matches('123')).toBe(false);
		expect(matcher.matches('dd1')).toBe(false);
	});

	test('an exact tipo matches itself only', () => {
		const matcher = compileTipoMatcher(['test36'], 'tool_zz');
		expect(matcher.matches('test36')).toBe(true);
		expect(matcher.matches('test360')).toBe(false);
		expect(matcher.matches('test3')).toBe(false);
	});

	test('a `/…/flags` regex matches like preg_match (the shipped tool_ontology patterns)', () => {
		const matcher = compileTipoMatcher(
			['ontology35', '/^(?!localontology0)[a-z]+0$/', '/^ontology[0-9]+$/'],
			'tool_ontology',
		);
		expect(matcher.matches('ontology35')).toBe(true);
		expect(matcher.matches('ontology7')).toBe(true);
		expect(matcher.matches('test0')).toBe(true);
		expect(matcher.matches('localontology0')).toBe(false);
		expect(matcher.matches('test35')).toBe(false);
		// flags are honoured
		expect(compileTipoMatcher(['/^TEST[0-9]+$/i'], 'tool_zz').matches('test36')).toBe(true);
		expect(warn).not.toHaveBeenCalled();
	});

	test('a malformed pattern never matches and is reported ONCE, at compile time', () => {
		const matcher = compileTipoMatcher(['/unclosed[/', 'not/a/regex', '/x/q'], 'tool_zz');
		expect(warn).toHaveBeenCalledTimes(3);
		for (let round = 0; round < 5; round++) {
			expect(matcher.matches('unclosed')).toBe(false);
			expect(matcher.matches('x')).toBe(false);
		}
		// testing tipos logs nothing more: the patterns were compiled once
		expect(warn).toHaveBeenCalledTimes(3);
		// …and the report names the owner and the value
		expect(String(warn.mock.calls[0]?.[0])).toContain('tool_zz');
		expect(String(warn.mock.calls[0]?.[0])).toContain('/unclosed[/');
	});

	test('stateful / non-PHP flags (g, y, d, v) are malformed — a compiled matcher is stateless', () => {
		// PHP preg_match rejects `g`/`y` (unknown modifier); a shared JS RegExp with
		// `g`/`y` carries lastIndex between calls, so one compiled list would answer
		// true, false, true… across requests (B5 review L1).
		for (const flag of ['g', 'y', 'd', 'v']) {
			const matcher = compileTipoMatcher([`/^test[0-9]+$/${flag}`], 'tool_zz');
			for (let round = 0; round < 4; round++) expect(matcher.matches('test3')).toBe(false);
		}
		expect(warn).toHaveBeenCalledTimes(4);
		// the PHP∩JS flags (i, m, s, u) still compile, and answer the same every time
		const shared = compileTipoMatcher(['/^TEST[0-9]+$/imsu'], 'tool_zz');
		for (let round = 0; round < 4; round++) expect(shared.matches('test3')).toBe(true);
		expect(warn).toHaveBeenCalledTimes(4);
	});

	test('non-string entries are skipped (reported), the rest of the list still works', () => {
		const matcher = compileTipoMatcher([['nested'], 42, 'dd5'], 'tool_zz');
		expect(matcher.matches('dd5')).toBe(true);
		expect(matcher.matches('42')).toBe(false);
		expect(warn).toHaveBeenCalledTimes(2);
	});

	test('an empty list is empty (the caller reads it as "no restriction")', () => {
		const matcher = compileTipoMatcher([], 'tool_zz');
		expect(matcher.isEmpty).toBe(true);
		expect(matcher.matches('dd1')).toBe(false);
		expect(compileTipoMatcher(['dd1'], 'tool_zz').isEmpty).toBe(false);
		// a cleared editor field ([''] ) names nothing either — and matches nothing
		const cleared = compileTipoMatcher([''], 'tool_zz');
		expect(cleared.isEmpty).toBe(true);
		expect(cleared.matches('')).toBe(false);
		// …but an UNUSABLE entry still restricts (fail closed: the tool matches nowhere)
		const unusable = compileTipoMatcher([42], 'tool_zz');
		expect(unusable.isEmpty).toBe(false);
		expect(unusable.matches('42')).toBe(false);
	});
});
