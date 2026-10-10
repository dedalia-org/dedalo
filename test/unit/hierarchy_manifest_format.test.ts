/**
 * THE hierarchy.json READER — pure gate of hierarchy_manifest_format.ts
 * (WC-2026-10-10-hierarchy-json-manifest).
 *
 * The reader is the installer's only door into the vendored thesaurus
 * manifest, and its contract is "strict and loud": a wrong type, a missing
 * required field or a broken cross-field rule refuses the WHOLE file with the
 * typed `install.manifest_invalid` (naming the JSON path), never a silently
 * shorter list. Each refusal case below is a positive control built by
 * breaking ONE field of a known-good manifest, so a case can only pass because
 * that one rule fired. Hermetic: no DB, no filesystem (the generic `test` TLD
 * and zz* names are plain strings here).
 */

import { describe, expect, test } from 'bun:test';
import { isDedaloError } from '../../src/core/errors/dedalo_error.ts';
import {
	HIERARCHY_MANIFEST_FILE,
	hierarchyDataFileNames,
	parseHierarchyManifest,
	parseHierarchyManifestText,
	serializeHierarchyManifest,
	sha256Hex,
	validateHierarchyEntry,
	validateHierarchyTypology,
} from '../../src/core/ontology/hierarchy_manifest_format.ts';

const DIGEST = 'a'.repeat(64);

/** A known-good manifest: one thesaurus with data, one empty one, one declaring deps. */
function goodManifest(): Record<string, unknown> {
	return {
		version: '7.0.0',
		date: '2026-10-10T12:00:00+02:00',
		entity_id: 0,
		entity: 'test',
		entity_label: 'Test',
		host: 'localhost',
		typologies: [
			{
				typology_id: 1,
				name: 'Thematic',
				name_data: [{ id: 1, lang: 'lg-eng', value: 'Thematic' }],
			},
			{ typology_id: 2, name: 'Toponymy', name_data: [] },
		],
		active_hierarchies: [
			{
				tld: 'test',
				name: 'Test',
				name_data: [{ id: 1, lang: 'lg-eng', value: 'Test' }],
				typology_id: 1,
				typology_name: 'Thematic',
				lang: { section_id: 17344, label: 'Spanish' },
				real_section_tipo: 'hierarchy20',
				active_in_thesaurus: true,
				scope_note_data: [{ id: 1, lang: 'lg-eng', value: 'A note' }],
				data_files: [
					{ file: 'test1.copy.gz', sha256: DIGEST },
					{ file: 'test2.copy.gz', sha256: DIGEST },
				],
			},
			{
				tld: 'zzempty',
				name: null,
				name_data: [],
				typology_id: 2,
				typology_name: null,
				lang: { section_id: 5101, label: null },
				real_section_tipo: null,
				active_in_thesaurus: false,
				scope_note_data: [],
				data_files: [],
			},
			{
				tld: 'zzdeps',
				name: 'Deps',
				name_data: [],
				typology_id: 2,
				typology_name: 'Toponymy',
				lang: { section_id: 5101, label: 'English' },
				real_section_tipo: 'hierarchy20',
				active_in_thesaurus: true,
				scope_note_data: [],
				dependencies: [
					{ tld: 'TEST', main: 'hierarchy1', mandatory: true },
					{ tld: 'zzempty', main: 'hierarchy1', mandatory: false },
				],
				data_files: [],
			},
		],
	};
}

type Mutable = Record<string, unknown> & {
	typologies: Record<string, unknown>[];
	active_hierarchies: Record<string, unknown>[];
};

/** The refusal's sentence, or a failure when nothing (or something untyped) was thrown. */
function refusal(mutate: (manifest: Mutable) => void): string {
	const manifest = goodManifest() as Mutable;
	mutate(manifest);
	try {
		parseHierarchyManifest(manifest);
	} catch (error) {
		expect(isDedaloError(error)).toBe(true);
		const typed = error as { code: string; publicMessage?: string };
		expect(typed.code).toBe('install.manifest_invalid');
		return typed.publicMessage ?? '';
	}
	throw new Error('expected install.manifest_invalid, the manifest was accepted');
}

describe('hierarchy.json reader — a good manifest', () => {
	test('round-trips: parse(serialize(parse(x))) equals parse(x)', () => {
		const parsed = parseHierarchyManifest(goodManifest());
		expect(parseHierarchyManifestText(serializeHierarchyManifest(parsed))).toEqual(parsed);
		expect(parsed.active_hierarchies.map((entry) => entry.tld)).toEqual([
			'test',
			'zzempty',
			'zzdeps',
		]);
	});

	test('dependencies: ABSENT stays absent, declared ones are normalized by the shared normalizer', () => {
		const parsed = parseHierarchyManifest(goodManifest());
		expect('dependencies' in (parsed.active_hierarchies[0] as object)).toBe(false);
		expect(parsed.active_hierarchies[2]?.dependencies).toEqual([
			{ tld: 'test', main: 'hierarchy1', mandatory: true },
			{ tld: 'zzempty', main: 'hierarchy1', mandatory: false },
		]);
	});

	test('a declared EMPTY list stays declared (needs nothing ≠ not declared)', () => {
		const manifest = goodManifest() as Mutable;
		(manifest.active_hierarchies[0] as Record<string, unknown>).dependencies = [];
		const parsed = parseHierarchyManifest(manifest);
		// floor: the parse read the entries (an empty manifest would make `[]` trivially absent-ish)
		expect(parsed.active_hierarchies.length).toBeGreaterThan(0);
		expect('dependencies' in (parsed.active_hierarchies[0] as object)).toBe(true);
		expect(parsed.active_hierarchies[0]?.dependencies).toEqual([]);
	});

	test('extra keys on multilingual items survive (the stored item id)', () => {
		const parsed = parseHierarchyManifest(goodManifest());
		expect(parsed.active_hierarchies[0]?.name_data[0]).toEqual({
			id: 1,
			lang: 'lg-eng',
			value: 'Test',
		});
	});

	test('serialized bytes: 4-space JSON + trailing newline (the ontology.json convention)', () => {
		const text = serializeHierarchyManifest(parseHierarchyManifest(goodManifest()));
		expect(text.endsWith('}\n')).toBe(true);
		expect(text).toContain('\n    "version": "7.0.0"');
	});
});

describe('hierarchy.json reader — refuses loudly, naming the path', () => {
	test('a non-int lang.section_id (the seed stores it as a STRING) is invalid', () => {
		const message = refusal((m) => {
			(m.active_hierarchies[0]?.lang as Record<string, unknown>).section_id = '17344';
		});
		expect(message).toContain('active_hierarchies.0.lang.section_id');
		expect(
			refusal((m) => {
				(m.active_hierarchies[0]?.lang as Record<string, unknown>).section_id = 1.5;
			}),
		).toContain('lang.section_id');
	});

	test('missing required fields refuse (never a default)', () => {
		for (const field of [
			'tld',
			'name_data',
			'typology_id',
			'lang',
			'real_section_tipo',
			'active_in_thesaurus',
			'scope_note_data',
			'data_files',
		]) {
			const message = refusal((m) => {
				Reflect.deleteProperty(m.active_hierarchies[1] as object, field);
			});
			expect(message).toContain(`active_hierarchies.1.${field}`);
		}
		expect(
			refusal((m) => {
				Reflect.deleteProperty(m, 'typologies');
			}),
		).toContain('typologies');
		expect(
			refusal((m) => {
				Reflect.deleteProperty(m, 'version');
			}),
		).toContain('version');
	});

	test('wrong types refuse', () => {
		expect(
			refusal((m) => {
				(m.active_hierarchies[0] as Record<string, unknown>).active_in_thesaurus = 'yes';
			}),
		).toContain('active_in_thesaurus');
		expect(
			refusal((m) => {
				(m.active_hierarchies[0] as Record<string, unknown>).tld = 'TEST';
			}),
		).toContain('active_hierarchies.0.tld');
		expect(
			refusal((m) => {
				(m.active_hierarchies[0] as Record<string, unknown>).real_section_tipo = 'hierarchy 20';
			}),
		).toContain('real_section_tipo');
		expect(
			refusal((m) => {
				(m.active_hierarchies[0]?.scope_note_data as unknown[]).push({
					lang: 'spanish',
					value: 'x',
				});
			}),
		).toContain('scope_note_data');
	});

	test('a duplicate tld or typology id refuses', () => {
		expect(
			refusal((m) => {
				(m.active_hierarchies[1] as Record<string, unknown>).tld = 'test';
			}),
		).toContain('active_hierarchies.1: duplicate');
		expect(
			refusal((m) => {
				(m.typologies[1] as Record<string, unknown>).typology_id = 1;
			}),
		).toContain('typologies.1: duplicate');
	});

	test('an entry naming an unlisted typology refuses', () => {
		expect(
			refusal((m) => {
				(m.active_hierarchies[0] as Record<string, unknown>).typology_id = 9;
			}),
		).toContain('typology 9 is not listed');
	});

	test('a data file that is not the entry’s own <tld>1|2.copy.gz refuses', () => {
		expect(
			refusal((m) => {
				(m.active_hierarchies[0]?.data_files as Record<string, unknown>[])[0] = {
					file: 'zzempty1.copy.gz',
					sha256: DIGEST,
				};
			}),
		).toContain('active_hierarchies.0.data_files.0.file');
		expect(
			refusal((m) => {
				(m.active_hierarchies[0]?.data_files as Record<string, unknown>[])[1] = {
					file: 'test1.copy.gz',
					sha256: DIGEST,
				};
			}),
		).toContain('listed twice');
		expect(
			refusal((m) => {
				(m.active_hierarchies[0]?.data_files as Record<string, unknown>[])[0] = {
					file: '../test1.copy.gz',
					sha256: DIGEST,
				};
			}),
		).toContain('data_files.0.file');
	});

	test('a digest that is not lowercase hex sha256 refuses', () => {
		expect(
			refusal((m) => {
				(m.active_hierarchies[0]?.data_files as Record<string, unknown>[])[0] = {
					file: 'test1.copy.gz',
					sha256: 'A'.repeat(64),
				};
			}),
		).toContain('data_files.0.sha256');
	});

	test('a dependency the shared normalizer would DROP refuses (strict, never skipped)', () => {
		expect(
			refusal((m) => {
				(m.active_hierarchies[2] as Record<string, unknown>).dependencies = [
					{ tld: 'test', main: 'hierarchy1', mandatory: 'yes' },
				];
			}),
		).toContain('active_hierarchies.2.dependencies');
		expect(
			refusal((m) => {
				(m.active_hierarchies[2] as Record<string, unknown>).dependencies = [
					{ tld: 'test', main: 'hierarchy1', mandatory: true },
					{ tld: 'test', main: 'hierarchy1', mandatory: false },
				];
			}),
		).toContain('more than once');
		expect(
			refusal((m) => {
				(m.active_hierarchies[2] as Record<string, unknown>).dependencies = 'test';
			}),
		).toContain('dependencies');
	});

	test('the text door refuses non-JSON with the same typed code', () => {
		let code = '';
		try {
			parseHierarchyManifestText('{ not json');
		} catch (error) {
			code = (error as { code: string }).code;
		}
		expect(code).toBe('install.manifest_invalid');
	});
});

describe('the digest helper and the file names', () => {
	test('sha256Hex is the lowercase hex SHA-256 of the bytes', () => {
		// The FIPS 180-2 "abc" vector.
		expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
		);
		expect(sha256Hex(new TextEncoder().encode('abc').buffer as ArrayBuffer)).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
		);
	});

	test('the data-file names of a tld are its <tld>1 and <tld>2 dumps; the manifest name is fixed', () => {
		expect(hierarchyDataFileNames('test')).toEqual(['test1.copy.gz', 'test2.copy.gz']);
		expect(HIERARCHY_MANIFEST_FILE).toBe('hierarchy.json');
	});
});

describe('per-record validation — the census skips ONE bad row, never the whole export', () => {
	const entryOf = (index: number) =>
		structuredClone((goodManifest().active_hierarchies as Record<string, unknown>[])[index]);
	const TYPOLOGIES = new Set([1, 2]);

	test('a good entry is admitted, normalized exactly as the whole-file reader does', () => {
		const raw = entryOf(2);
		const checked = validateHierarchyEntry(raw, TYPOLOGIES);
		expect('entry' in checked).toBe(true);
		const whole = parseHierarchyManifest(goodManifest()).active_hierarchies[2];
		expect(whole).toBeDefined();
		expect('entry' in checked ? checked.entry : null).toEqual(whole as never);
	});

	test('each stored-data defect is that ONE record’s problem, naming the field', () => {
		const cases: [string, (entry: Record<string, unknown>) => void, string][] = [
			[
				'real section with a capital',
				(e) => (e.real_section_tipo = 'Hierarchy20'),
				'entry.real_section_tipo',
			],
			[
				'real section with a space',
				(e) => (e.real_section_tipo = ' hierarchy20'),
				'entry.real_section_tipo',
			],
			[
				'name item lang uppercase',
				(e) => (e.name_data = [{ lang: 'lg-ES', value: 'x' }]),
				'entry.name_data.0.lang',
			],
			[
				'scope note item without lang',
				(e) => (e.scope_note_data = [{ value: 'x' }]),
				'entry.scope_note_data.0.lang',
			],
			['typology not listed', (e) => (e.typology_id = 9), 'entry.typology_id'],
			[
				'data file of another tld',
				(e) => (e.data_files = [{ file: 'es1.copy.gz', sha256: DIGEST }]),
				'entry.data_files.0.file',
			],
			[
				'dependency the normalizer drops',
				(e) => (e.dependencies = [{ tld: 'x', main: 'nope' }]),
				'entry.dependencies',
			],
		];
		expect(cases.length).toBeGreaterThan(0);
		for (const [label, mutate, path] of cases) {
			const raw = entryOf(0) as Record<string, unknown>;
			mutate(raw);
			const checked = validateHierarchyEntry(raw, TYPOLOGIES);
			expect('problem' in checked, label).toBe(true);
			expect('problem' in checked ? checked.problem : '', label).toStartWith(`${path}: `);
		}
	});

	test('a malformed typology record is its own problem', () => {
		expect(validateHierarchyTypology({ typology_id: 3, name: 'Languages', name_data: [] })).toEqual(
			{ typology: { typology_id: 3, name: 'Languages', name_data: [] } },
		);
		const bad = validateHierarchyTypology({
			typology_id: 3,
			name: 'Languages',
			name_data: [{ lang: 'eng', value: 'Languages' }],
		});
		expect('problem' in bad ? bad.problem : '').toStartWith('typology.name_data.0.lang: ');
	});

	test('a non-format error is never swallowed into a problem line', () => {
		// An entry whose dependencies getter throws a plain Error: the validator must
		// rethrow it (only install.manifest_invalid becomes a problem line).
		const raw = entryOf(0) as Record<string, unknown>;
		Object.defineProperty(raw, 'dependencies', {
			enumerable: true,
			get() {
				throw new Error('boom');
			},
		});
		expect(() => validateHierarchyEntry(raw, TYPOLOGIES)).toThrow('boom');
	});
});
