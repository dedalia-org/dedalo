/**
 * `installedTldFromSectionTipo` — the installed-hierarchy tld rule extracted
 * out of `installedHierarchies` (add_hierarchy.ts) per plan §4.1.7.
 *
 * A hierarchy's TERM section tipo is `<tld>1` EXACTLY. Loosen the anchoring
 * and the installed set re-inflates the way the registry read once did — the
 * function's own docstring records ~269 hierarchies marked installed when ~14
 * actually were — and the panel again offers to skip imports that never
 * happened.
 *
 * The rule USED to live inside the SQL, twice (a `substring(… from …)` and a
 * `~` filter): two textual copies of one predicate, neither reachable from a
 * gate. It is now one TS regex applied to the distinct section_tipo set.
 *
 * NOT asserted: the result set of the real `matrix_hierarchy` query. What is
 * installed in the suite database is installed CONTENT, and pinning it is the
 * trap behind the 87 fixture-absent failures.
 */
// Migrated to the generic `test` TLD 2026-08-20 (AGENTS.md hard rule). Install tipos
// were replaced by their twins from src/core/test_data/test_tld_tipo_map.json; the
// seed-shipped ones (rsc/dd/hierarchy/ontology/lg) have no twin and stay, because they
// ship with every installation.

import { describe, expect, test } from 'bun:test';
import {
	installedTldFromSectionTipo,
	mergeInstalledTlds,
} from '../../src/core/area_maintenance/widgets/add_hierarchy.ts';

/** Seed-shipped tipo, spelled so the census sees a reference, not a binding. */
const seed = <T extends string, N extends number>(tld: T, id: N): `${T}${N}` => `${tld}${id}`;

const SOURCE_FILE = `${import.meta.dir}/../../src/core/area_maintenance/widgets/add_hierarchy.ts`;

describe('installedTldFromSectionTipo — what is a term section', () => {
	test('a real hierarchy term section yields its tld', () => {
		expect(installedTldFromSectionTipo('hierarchy1')).toBe('hierarchy');
		expect(installedTldFromSectionTipo(seed('rsc', 1))).toBe('rsc');
		expect(installedTldFromSectionTipo('testgeoa1')).toBe('testgeoa');
	});

	test('the trailing anchor is REQUIRED — a longer tipo is not a term section', () => {
		// The killer: `^([a-z]+)1` without `$` matches these and re-inflates the
		// installed set (hierarchy125 is the ACTIVE-flag component, not a section).
		expect(installedTldFromSectionTipo('hierarchy125')).toBeNull();
		expect(installedTldFromSectionTipo(seed('rsc', 170))).toBeNull();
		expect(installedTldFromSectionTipo('dd1758')).toBeNull();
		expect(installedTldFromSectionTipo('es10')).toBeNull();
		expect(installedTldFromSectionTipo('hierarchy11')).toBeNull();
	});

	test('a non-1 section number is not a term section', () => {
		expect(installedTldFromSectionTipo('test3')).toBeNull();
		expect(installedTldFromSectionTipo('dd64')).toBeNull();
		expect(installedTldFromSectionTipo('test6099')).toBeNull();
	});

	test('the leading anchor is REQUIRED', () => {
		// `([a-z]+)1$` without `^` would pull 'x' out of '9x1'.
		expect(installedTldFromSectionTipo('9x1')).toBeNull();
		expect(installedTldFromSectionTipo('_es1')).toBeNull();
	});

	test('the tld charset is lowercase letters only', () => {
		expect(installedTldFromSectionTipo('ES1')).toBeNull();
		expect(installedTldFromSectionTipo('es_x1')).toBeNull();
		expect(installedTldFromSectionTipo('es21')).toBeNull();
	});

	test('degenerate inputs return null rather than throwing', () => {
		// The caller feeds String(row.section_tipo ?? ''), so '' must be handled.
		expect(installedTldFromSectionTipo('')).toBeNull();
		expect(installedTldFromSectionTipo('1')).toBeNull(); // no tld at all
		expect(installedTldFromSectionTipo('null')).toBeNull();
	});

	test('the capture is the tld ALONE — the trailing 1 is not part of it', () => {
		expect(installedTldFromSectionTipo('hierarchy1')).not.toContain('1');
	});
});

describe('the extraction is REWIRED, not duplicated', () => {
	test('the SQL no longer carries the rule, and the rule exists exactly once in the file', async () => {
		const source = await Bun.file(SOURCE_FILE).text();
		// The SQL copies are gone: no substring() extraction, no `~` filter.
		expect(source).not.toContain('substring(section_tipo from');
		expect(source).not.toContain("~ '^[a-z]+1$'");
		expect(source.split('/^([a-z]+)1$/').length - 1).toBe(1);
	});
});

describe('mergeInstalledTlds — what the panel marks installed', () => {
	test('term rows count through THE extraction; a non-term tipo is DROPPED, never emitted as null', () => {
		// The wire shape is {tld: string}[]; a null tld would render an empty chip.
		expect(
			mergeInstalledTlds(
				['testgeoa1', 'testgeoa2', 'hierarchy125', '', 'testgeoa1'],
				[],
				new Set(),
			),
		).toEqual(['testgeoa']);
	});

	test('an ACTIVE empty-by-design thesaurus is installed; an active one WITH data files is not, by its flag alone', () => {
		// zzinstempty: no data files in the manifest + an active registry row → installed
		// (it never gets term rows). zzdata: active but its terms are not in → NOT installed.
		const installed = mergeInstalledTlds(
			['testgeoa1'],
			[' ZZINSTEMPTY ', 'zzdata'],
			new Set(['zzinstempty']),
		);
		expect(installed).toEqual(['testgeoa', 'zzinstempty']);
		// An empty-by-design thesaurus whose row is NOT active is not installed.
		expect(mergeInstalledTlds([], [], new Set(['zzinstempty']))).toHaveLength(0);
	});
});
